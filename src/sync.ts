import type Stripe from "stripe";
import { pollStripeEvents, pollWorkOSEvents } from "./events.js";
import { creditsOwedFor, grantCredits, getStripe } from "./billing.js";
import {
  grantFor,
  planForPriceId,
  planModel,
  type PlanCatalog,
} from "./plans.js";
import type { Mirror, MirrorQuery } from "./mirror.js";
import type { WorkOSOrgAdapter } from "./adapters/workos-org.js";

const CURSOR_TABLE = "billing_sync_cursors";

// Turn-key billing sync — you hand it the adapter, the plans, a cursor store,
// and your two mirror tables; the lib owns the whole loop. No sync logic in the
// app. Run runOnce() on an interval (loop) or from cron.
//
//   - Stripe subscription events → org plan/status (adapter.setSubscription)
//     and per-cycle credit grants on invoice.paid (grantCredits, per seat).
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
  plans: PlanCatalog;
  /** DB executor (same one you pass to createMirror). The sync creates + uses
   *  its own `billing_sync_cursors` table through it — no app schema needed. */
  query: MirrorQuery;
  currency?: string;
  /** Override cursor persistence (advanced). Defaults to the query-backed table. */
  cursor?: CursorStore;
  /**
   * Also poll PAYMENT events, as a catch-up sweep behind the webhook.
   *
   * Off by default: payments are the webhook's job (Stripe's recommendation, and
   * a late credit is a customer who paid and didn't get what they bought), and a
   * poller shadowing it every minute is duplicated infrastructure rather than a
   * safety net — Stripe already retries failed deliveries for three days.
   *
   * Turn it on for a LOW-FREQUENCY reconciliation run (a nightly cron) if you
   * want recovery from an endpoint that was disabled or misconfigured. Safe at
   * any frequency: the handlers are idempotent.
   */
  reconcilePayments?: boolean;
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

// The split that decides what is delivered how.
//
// MONEY GOES ON THE WEBHOOK. Anything that grants credits or reacts to a failed
// charge is delivered by Stripe, because that is what Stripe recommends and
// because a payment that lands late is a customer who paid and didn't get what
// they bought. `ensureWebhookEndpoint` registers exactly this list.
export const PAYMENT_EVENT_TYPES = [
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
];

// STATE MIRRORING GOES ON THE POLLER. Plan and status are a projection of
// Stripe's state, not money moving: a cancellation reflected a minute late is a
// stale row, not a lost payment. Polling suits it — no endpoint, no signing
// secret, and it self-heals, because each event re-asserts current state rather
// than applying a delta.
export const SYNC_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
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

/**
 * The Stripe event handlers, independent of how the event arrived.
 *
 * Extracted so the WEBHOOK and the POLLER run the exact same code. That is the
 * property that matters: two delivery mechanisms are fine, two implementations
 * are how the rarely-exercised one silently rots. Wire it into a webhook via
 * `createStripeWebhookHandler({ onOtherEvent })`, and/or let `createBillingSync`
 * poll it.
 *
 * Every handler is idempotent — credits carry an idempotency key and state
 * writes assign current state rather than applying deltas — so an event
 * processed twice (webhook plus a reconciliation sweep) is a no-op.
 */
/**
 * The subscription's current period, read off its ITEMS.
 *
 * `current_period_start/_end` moved off `Subscription` onto `SubscriptionItem` in
 * the API version this SDK pins, so the old `sub.current_period_end` was
 * `undefined` on every path and every `periodEnd` written was null. A
 * subscription can hold items on different periods, so the window is the widest
 * one — which is also the renewal date a customer is shown.
 */
/**
 * Purchased seats BY SEAT TYPE. Sizes a `cap.perSeat` pool — the same breakdown the
 * `purchased_seats` grant counts, and the only thing that can size a pool for a
 * plan with more than one tier (`perSeat: "included"` multiplies each tier by its
 * own allowance).
 *
 * Null when nothing is quantified, so the reader falls back to the active member
 * count rather than to a pool of one seat.
 */
function purchasedSeatsOf(sub: Stripe.Subscription): Record<string, number> | null {
  const counts: Record<string, number> = {};
  for (const item of sub.items?.data ?? []) {
    const seatType = item.price?.metadata?.seatType;
    const qty = item.quantity ?? 0;
    if (!qty) continue;
    // An item with no seat type still counts toward the total — a `flat` plan has
    // no seat types at all, and a pool sized per seat must not read zero there.
    const key = seatType || "default";
    counts[key] = (counts[key] ?? 0) + qty;
  }
  return Object.keys(counts).length ? counts : null;
}

function subscriptionPeriod(sub: Stripe.Subscription): {
  periodStart: string | null;
  periodEnd: string | null;
} {
  type Periodic = { current_period_start?: number; current_period_end?: number };
  const items = (sub.items?.data ?? []) as unknown as Periodic[];
  const starts = items.map((i) => i.current_period_start).filter((v): v is number => !!v);
  const ends = items.map((i) => i.current_period_end).filter((v): v is number => !!v);
  const iso = (secs: number | undefined) =>
    secs ? new Date(secs * 1000).toISOString() : null;
  return {
    periodStart: iso(starts.length ? Math.min(...starts) : undefined),
    periodEnd: iso(ends.length ? Math.max(...ends) : undefined),
  };
}

/**
 * The subscription an invoice belongs to — from BOTH places Stripe has kept it.
 *
 * `invoice.subscription` is **gone** in the API version this SDK pins (2026-02-25): it moved
 * to `invoice.parent.subscription_details.subscription`, exactly as `current_period_end` moved
 * off `Subscription` onto `SubscriptionItem`. Reading the old field yielded `undefined`, and
 * both invoice branches below open with `if (!invoice.subscription) return` — so on a live
 * account they returned immediately, every time:
 *
 *   • `invoice.paid` never granted renewal credits. Any plan with a `grant` gave a paying
 *     subscriber nothing, every month, silently. (Both shipped consumers use `grant: none`,
 *     so no live deployment lost credits — but the branch existed for the ones that don't.)
 *   • `invoice.payment_failed` never recorded `past_due` and never fired `onPaymentFailed`,
 *     so an app could not tell that Stripe was dunning its customer.
 *
 * Measured against a real event, not inferred. Both spellings are read so the handler works
 * either side of the version change, and `parent` also carries the subscription's METADATA —
 * which is where `org_id` lives, so the org resolves without a retrieve when it is present.
 */
function subscriptionRefOf(invoice: Stripe.Invoice & { subscription?: string | null }): {
  subscriptionId: string | null;
  orgId: string | null;
} {
  const parent = (invoice as { parent?: { subscription_details?: { subscription?: string | Stripe.Subscription | null; metadata?: Record<string, string> | null } | null } }).parent;
  const details = parent?.subscription_details ?? null;
  const fromParent = details?.subscription;
  const subscriptionId =
    (typeof fromParent === "string" ? fromParent : (fromParent?.id ?? null)) ??
    (typeof invoice.subscription === "string" ? invoice.subscription : null);
  return { subscriptionId, orgId: details?.metadata?.org_id ?? null };
}

export function createStripeEventHandler(opts: {
  adapter: WorkOSOrgAdapter;
  plans: PlanCatalog;
  currency?: string;
  hooks?: BillingSyncOptions["hooks"];
}): (event: Stripe.Event) => Promise<void> {
  const currency = opts.currency ?? "usd";
  return async function handleStripe(event: Stripe.Event): Promise<void> {
    if (event.type.startsWith("customer.subscription.")) {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.org_id;
      if (!orgId) return;
      if (event.type === "customer.subscription.deleted") {
        await opts.adapter.setSubscription(orgId, {
          plan: null,
          status: "canceled",
          subscriptionId: null,
          periodStart: null,
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
        ...subscriptionPeriod(sub),
        // Recorded on every subscription event so a `cap.perSeat` pool resizes
        // when seats are added or removed. Broken down by seat type, the same way
        // the `purchased_seats` grant counts them.
        seatCounts: purchasedSeatsOf(sub),
      });
      return;
    }

    // Same credit the webhook route performs, reached by polling instead. Only
    // one-time top-ups (`mode: "payment"`); a subscription checkout grants its
    // credits through invoice.paid below.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment") return;
      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id;
      const credits = parseInt(session.metadata?.credits || "0", 10);
      if (!customerId || credits <= 0) return;
      await grantCredits(
        customerId,
        credits,
        `Purchase: ${credits} credits via Checkout`,
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
      // A library-issued credit invoice (`purchaseCredits` with method "invoice", or an
      // auto-reload) carries its credits in metadata and has `billing_reason: "manual"`.
      // It is not a subscription grant, so it is settled here and returns — before the
      // reason filter below, which is what dropped it entirely: the customer paid the
      // invoice Stripe emailed them and nothing credited the wallet.
      // Sold PLUS eaten: Stripe settles an invoice out of the customer's credit balance,
      // and that balance is this library's wallet. See `creditsOwedFor`.
      const purchased = creditsOwedFor(invoice);
      if (purchased > 0 && invoice.customer) {
        await grantCredits(
          invoice.customer,
          purchased,
          `Purchase: ${purchased} credits by invoice`,
          opts.currency ?? "usd",
          // Shared with the off-session path, so a charge credited synchronously is not
          // credited a second time when its event lands.
          `credit:invoice:${invoice.id}`,
        );
        return;
      }
      if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") return;
      const ref = subscriptionRefOf(invoice);
      if (!ref.subscriptionId || !invoice.customer) return;
      const sub = await getStripe().subscriptions.retrieve(ref.subscriptionId);
      const orgId = sub.metadata?.org_id ?? ref.orgId;
      if (!orgId) return;
      // All line items of a subscription share one plan (only the seat type
      // varies), so the first item resolves the plan.
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = priceId ? await planForPriceId(priceId) : null;
      if (!plan) return; // unknown price → no grant
      const model = planModel(opts.plans, plan);

      // What to CREDIT, per the plan's `grant` — which is `none` for anything
      // whose included usage is an entitlement rather than money.
      //
      // That distinction is the point. A Stripe credit balance auto-applies to
      // the customer's next invoice and cannot be opted out of, so crediting a
      // plan's own included credits discounts its own renewal: 1000 credits on a
      // €21.04 seat produced an invoice with `starting_balance: -1000` and
      // `amount_due: 1104`. Included allowance is a counted window (see
      // allowance.ts); this credits only what the plan genuinely sells as credit.
      const counts: Record<string, number> = {};
      for (const item of sub.items.data) {
        const seatType = item.price?.metadata?.seatType;
        if (!seatType) continue;
        counts[seatType] = (counts[seatType] ?? 0) + (item.quantity ?? 0);
      }
      const purchasedSeats = Object.values(counts).reduce((a, b) => a + b, 0);
      const memberCount = model?.grant.kind === "per_member"
        ? await opts.adapter.memberCount(orgId)
        : purchasedSeats;
      const credits = grantFor(model, { seatCounts: counts, memberCount });
      const seats = purchasedSeats || memberCount;
      const seatSummary = `${seats} seat${seats === 1 ? "" : "s"}`;

      if (credits > 0) {
        // Idempotency key on the invoice id: an overlapping/replayed poll grants
        // the per-cycle credits exactly once.
        await grantCredits(
          invoice.customer,
          credits,
          `Included credits: ${plan} (${seatSummary})`,
          currency,
          `credit:invoice:${invoice.id}`,
        );
      }
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string | null };
      const ref = subscriptionRefOf(invoice);
      if (!ref.subscriptionId) return; // one-off top-ups don't affect subscription state
      const sub = (await getStripe().subscriptions.retrieve(ref.subscriptionId)) as Stripe.Subscription & {
        current_period_end?: number;
      };
      const orgId = sub.metadata?.org_id ?? ref.orgId;
      if (!orgId) return;
      await opts.adapter.setSubscription(orgId, {
        status: "past_due",
        subscriptionId: sub.id,
        periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      });
      await opts.hooks?.onPaymentFailed?.(orgId);
    }
  };
}

export function createBillingSync(opts: BillingSyncOptions): BillingSync {
  const currency = opts.currency ?? "usd";
  const cursor = opts.cursor ?? queryCursorStore(opts.query);
  const handleStripe = createStripeEventHandler({
    adapter: opts.adapter,
    plans: opts.plans,
    currency,
    hooks: opts.hooks,
  });

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

  // State mirroring only. Payment events are delivered by the webhook — see the
  // PAYMENT_EVENT_TYPES / SYNC_EVENT_TYPES split above. `reconcilePayments` adds
  // them back for an occasional catch-up sweep (a nightly cron, say): the
  // handlers are idempotent, so replaying a payment event the webhook already
  // processed changes nothing, and anything the webhook never delivered is
  // recovered. It is deliberately NOT the default — a 60-second loop shadowing
  // the webhook is duplicated infrastructure, not a safety net.
  const stripeTypes = opts.reconcilePayments
    ? [...SYNC_EVENT_TYPES, ...PAYMENT_EVENT_TYPES]
    : SYNC_EVENT_TYPES;

  async function runOnce() {
    const s = await pollStripeEvents({
      after: await cursor.get("stripe"),
      types: stripeTypes,
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
