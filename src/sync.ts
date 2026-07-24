import type Stripe from "stripe";
import { pollStripeEvents, pollWorkOSEvents } from "./events.js";
import { creditTokens, getStripe } from "./billing.js";
import { includedTokens, planForPriceId, type PlansConfig } from "./plans.js";
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
];
const WORKOS_EVENTS = [
  "organization.updated",
  "organization.deleted",
  "user.updated",
  "user.deleted",
];

export interface BillingSync {
  runOnce(): Promise<{ stripe: number; workos: number }>;
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
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = priceId ? await planForPriceId(priceId) : null;
      if (!plan) return; // unknown price → no grant
      const seats = await opts.adapter.memberCount(orgId);
      const tokens = includedTokens(opts.plans, plan, seats);
      if (tokens > 0) {
        await creditTokens(
          invoice.customer,
          tokens,
          `Included tokens: ${plan} (${seats} seat${seats === 1 ? "" : "s"})`,
          currency,
        );
      }
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

  return {
    async runOnce() {
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
    },
  };
}
