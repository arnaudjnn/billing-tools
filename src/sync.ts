import type Stripe from "stripe";
import { pollStripeEvents, pollWorkOSEvents } from "./events.js";
import { creditTokens, getStripe } from "./billing.js";
import {
  includedTokens,
  includedTokensByType,
  planForPriceId,
  type PlansConfig,
} from "./plans.js";
import type { Mirror, MirrorQuery } from "./mirror.js";
import type { WorkOSOrgAdapter } from "./adapters/workos-org.js";

const CURSOR_TABLE = "billing_sync_cursors";

// Turn-key billing sync — you hand it the adapter, the plans, a cursor store,
// and your two mirror tables; the lib owns the whole loop. No sync logic in the
// app. Run runOnce() on an interval (loop) or from cron.
//
//   - Stripe subscription events → org plan/status (adapter.setSubscription)
//     and per-cycle token grants on invoice.paid (creditTokens, per seat).
//   - WorkOS org/user events → the Postgres mirror rows (name/columns via the
//     mirror's `columns` map, full metadata, and row deletion).

/** Optional custom cursor persistence. By default the sync manages its own tiny
 *  cursor table via the `query` executor — the app declares nothing. */
export interface CursorStore {
  get(source: string): Promise<string | null>;
  set(source: string, cursor: string | null): Promise<void>;
}

export interface BillingSyncOptions {
  adapter: WorkOSOrgAdapter;
  plans: PlansConfig;
  /** DB executor (same one you pass to createMirror). The sync creates + uses
   *  its own `billing_sync_cursors` table through it — no app schema needed. */
  query: MirrorQuery;
  currency?: string;
  /** Override cursor persistence (advanced). Defaults to the query-backed table. */
  cursor?: CursorStore;
  /** Mirror of the WorkOS Organization (e.g. a workspaces table). */
  orgMirror?: Mirror;
  /** Mirror of the WorkOS User (e.g. a users table). */
  userMirror?: Mirror;
  hooks?: {
    /** Extra app-specific cleanup when a WorkOS user is deleted (the user
     *  mirror row is already removed). */
    onUserDeleted?(workosUserId: string): Promise<void>;
    /** A subscription invoice failed to collect (dunning). The org's status is
     *  already set to `past_due`; use this to notify the user / gate access.
     *  Stripe Smart Retries + the card-updater keep retrying automatically. */
    onPaymentFailed?(orgId: string): Promise<void>;
  };
}

// A CursorStore backed by a self-managed table via the app's query executor.
function queryCursorStore(query: MirrorQuery): CursorStore {
  let ensured = false;
  const ensure = async () => {
    if (ensured) return;
    await query(
      `CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (source text PRIMARY KEY, cursor text, updated_at timestamptz NOT NULL DEFAULT now())`,
      [],
    );
    ensured = true;
  };
  return {
    async get(source) {
      await ensure();
      const r = await query(`SELECT cursor FROM ${CURSOR_TABLE} WHERE source = $1`, [source]);
      return (r.rows[0]?.cursor as string | undefined) ?? null;
    },
    async set(source, cursor) {
      if (cursor === null) return;
      await ensure();
      await query(
        `INSERT INTO ${CURSOR_TABLE} (source, cursor) VALUES ($1, $2)
         ON CONFLICT (source) DO UPDATE SET cursor = $2, updated_at = now()`,
        [source, cursor],
      );
    },
  };
}

const STRIPE_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  // Token top-ups, which the webhook route ALSO handles. Deliberate overlap:
  // it makes the webhook an optimisation (instant credit) rather than a
  // dependency, so a developer can run the whole product locally with no
  // endpoint, no tunnel and no signing secret. Double-processing is safe —
  // both paths credit under the same `credit:checkout:<session>` idempotency
  // key, so whichever arrives second is a no-op.
  "checkout.session.completed",
];
const WORKOS_EVENTS = [
  "organization.updated",
  "organization.deleted",
  "user.updated",
  "user.deleted",
];

export interface BillingSync {
  /** Poll + reconcile once. Use this from a serverless cron route. */
  runOnce(): Promise<{ stripe: number; workos: number }>;
  /** Start an in-process interval scheduler (for a long-lived server — e.g.
   *  Next's instrumentation register()). Runs immediately, then every
   *  intervalMs (default 60s), never overlapping. Returns a stop() fn.
   *  For multi-instance deployments run it on one replica (or use runOnce via
   *  a single external cron) to avoid duplicate polling. */
  start(opts?: { intervalMs?: number; onError?: (e: unknown) => void }): () => void;
}

export function createBillingSync(opts: BillingSyncOptions): BillingSync {
  const currency = opts.currency ?? "usd";
  const cursor = opts.cursor ?? queryCursorStore(opts.query);

  async function handleStripe(event: Stripe.Event): Promise<void> {
    if (event.type.startsWith("customer.subscription.")) {
      const sub = event.data.object as Stripe.Subscription & { current_period_end?: number };
      const orgId = sub.metadata?.org_id;
      if (!orgId) return;
      if (event.type === "customer.subscription.deleted") {
        await opts.adapter.setSubscription(orgId, {
          plan: null,
          status: "canceled",
          subscriptionId: null,
          periodEnd: null,
        });
        return;
      }
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = priceId ? await planForPriceId(priceId) : null;
      await opts.adapter.setSubscription(orgId, {
        plan: plan ?? undefined,
        status: sub.status,
        subscriptionId: sub.id,
        periodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
      });
      return;
    }

    // Same credit the webhook route performs, reached by polling instead. Only
    // one-time top-ups (`mode: "payment"`); a subscription checkout grants its
    // tokens through invoice.paid below.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment") return;
      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id;
      const tokens = parseInt(session.metadata?.tokens || "0", 10);
      if (!customerId || tokens <= 0) return;
      await creditTokens(
        customerId,
        tokens,
        `Purchase: ${tokens} tokens via Checkout`,
        currency,
        `credit:checkout:${session.id}`,
      );
      return;
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice & {
        subscription?: string | null;
        billing_reason?: string | null;
        customer?: string | null;
      };
      if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") return;
      if (!invoice.subscription || !invoice.customer) return;
      const sub = await getStripe().subscriptions.retrieve(invoice.subscription);
      const orgId = sub.metadata?.org_id;
      if (!orgId) return;
      // All line items of a subscription share one plan (only the seat type
      // varies), so the first item resolves the plan.
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = priceId ? await planForPriceId(priceId) : null;
      if (!plan) return; // unknown price → no grant
      const planDef = opts.plans[plan];

      // Seat-typed plan → grant from the PURCHASED seats (one line item per
      // seat type, quantity = seats of that type read off the price metadata),
      // so tokens track what's actually paid for. Flat plan → per active member.
      let tokens: number;
      let seatSummary: string;
      if (planDef?.seatTypes) {
        const counts: Record<string, number> = {};
        for (const item of sub.items.data) {
          const seatType = item.price?.metadata?.seatType;
          if (!seatType) continue;
          counts[seatType] = (counts[seatType] ?? 0) + (item.quantity ?? 0);
        }
        tokens = includedTokensByType(opts.plans, plan, counts);
        const totalSeats = Object.values(counts).reduce((a, b) => a + b, 0);
        seatSummary = `${totalSeats} seat${totalSeats === 1 ? "" : "s"}`;
      } else {
        const seats = await opts.adapter.memberCount(orgId);
        tokens = includedTokens(opts.plans, plan, seats);
        seatSummary = `${seats} seat${seats === 1 ? "" : "s"}`;
      }

      if (tokens > 0) {
        // Idempotency key on the invoice id: an overlapping/replayed poll grants
        // the per-cycle tokens exactly once.
        await creditTokens(
          invoice.customer,
          tokens,
          `Included tokens: ${plan} (${seatSummary})`,
          currency,
          `credit:invoice:${invoice.id}`,
        );
      }
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string | null };
      if (!invoice.subscription) return; // one-off top-ups don't affect subscription state
      const sub = (await getStripe().subscriptions.retrieve(invoice.subscription)) as Stripe.Subscription & {
        current_period_end?: number;
      };
      const orgId = sub.metadata?.org_id;
      if (!orgId) return;
      await opts.adapter.setSubscription(orgId, {
        status: "past_due",
        subscriptionId: sub.id,
        periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      });
      await opts.hooks?.onPaymentFailed?.(orgId);
    }
  }

  async function handleWorkOS(event: { event: string; data: unknown }): Promise<void> {
    const data = event.data as { id?: string };
    if (!data?.id) return;
    switch (event.event) {
      case "organization.updated":
        await opts.orgMirror?.syncResource(data.id, data as Record<string, unknown>);
        break;
      case "organization.deleted":
        await opts.orgMirror?.remove(data.id);
        break;
      case "user.updated":
        await opts.userMirror?.syncResource(data.id, data as Record<string, unknown>);
        break;
      case "user.deleted":
        await opts.userMirror?.remove(data.id);
        await opts.hooks?.onUserDeleted?.(data.id);
        break;
    }
  }

  async function runOnce() {
    const s = await pollStripeEvents({
      after: await cursor.get("stripe"),
      types: STRIPE_TYPES,
      onEvent: handleStripe,
    });
    await cursor.set("stripe", s.cursor);
    const w = await pollWorkOSEvents({
      after: await cursor.get("workos"),
      events: WORKOS_EVENTS,
      onEvent: handleWorkOS,
    });
    await cursor.set("workos", w.cursor);
    return { stripe: s.count, workos: w.count };
  }

  function start(opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}) {
    const intervalMs = opts.intervalMs ?? 60_000;
    let running = false;
    let stopped = false;
    const tick = async () => {
      if (running || stopped) return; // never overlap
      running = true;
      try {
        await runOnce();
      } catch (e) {
        if (opts.onError) opts.onError(e);
        else console.error(`[billing-sync] ${(e as Error).message}`);
      } finally {
        running = false;
      }
    };
    const handle = setInterval(tick, intervalMs);
    // Don't keep the process alive just for the timer.
    (handle as { unref?: () => void }).unref?.();
    void tick(); // run once immediately
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }

  return { runOnce, start };
}

/** Web-standard (Request → Response) handler that runs one sync cycle — for a
 *  serverless cron trigger. Framework-agnostic: mount in a Next route
 *  (`export const GET = createSyncRoute(sync, { secret })`), Hono, Bun, etc.
 *  If `secret` is set, requests must send it as `Authorization: Bearer <secret>`
 *  (or an `x-cron-secret` header). */
export function createSyncRoute(
  sync: BillingSync,
  opts: { secret?: string } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (opts.secret) {
      const auth =
        request.headers.get("authorization") ?? request.headers.get("x-cron-secret") ?? "";
      if (auth !== opts.secret && auth !== `Bearer ${opts.secret}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }
    try {
      const result = await sync.runOnce();
      return Response.json({ ok: true, ...result });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  };
}
