import { getStripe, usageSince } from "./billing.js";

// Counting usage, separately from moving money.
//
// These were one thing until now: `deductTokens` wrote a Stripe balance
// transaction, and `usageSince` read those transactions back as the usage
// ledger. That works exactly as long as every metered call costs money.
//
// It stops working the moment a plan INCLUDES usage. An included call has to be
// counted (or a cap can't be enforced) but must not be charged (the customer
// already paid for it in the subscription) — and a balance transaction cannot do
// one without the other. Crediting the allowance instead is worse: a Stripe
// credit balance auto-applies to the next invoice, so a plan's own included
// tokens discount its own renewal (measured: 1000 tokens turned a €21.04 seat
// invoice into €11.04 due).
//
// So: money stays in `deductTokens`, counting moves here. The rule at the call
// site is `record` always, `deductTokens` only when the wallet is what funded it.

/** Which allowance paid for a call. */
export type FundingSource =
  /** The org-wide included window. */
  | "pool"
  /** The caller's seat pack. */
  | "pack"
  /** Prepaid balance — the only one that moves money. */
  | "wallet";

export interface UsageEvent {
  orgId: string;
  customerId: string;
  action: string;
  cost: number;
  funded: FundingSource;
  caller?: { kind: string; id?: string };
  /** Epoch ms. Defaults to now. */
  at?: number;
  /** Makes a retry a no-op where the backing store supports it. */
  idempotencyKey?: string;
}

export interface UsageQuery {
  orgId: string;
  customerId: string;
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. Omit for "up to now". */
  end?: number;
  filter?: { callerKind?: string; callerId?: string };
}

export interface UsageLedger {
  record(event: UsageEvent): Promise<void>;
  /** Summed cost in [start, end). */
  total(query: UsageQuery): Promise<number>;
}

/**
 * The ledger this library has always had: the debits themselves.
 *
 * `record` is a no-op — `deductTokens` already wrote the row — and `total` is
 * `usageSince`. Correct and free for any plan where every call is wallet-funded,
 * which is every plan that existed before included windows, so it stays the
 * default. It cannot see pool- or pack-funded usage, because that usage moves no
 * money and therefore writes no transaction: a plan with an included window
 * needs the meter ledger below.
 */
export function stripeBalanceUsageLedger(): UsageLedger {
  return {
    async record() {
      /* the balance transaction IS the record */
    },
    // `start` is epoch ms throughout this seam; Stripe's `created` is seconds.
    total: (q) => usageSince(q.customerId, Math.floor(q.start / 1000), q.filter),
  };
}

/** Default name of the Stripe Billing Meter events are reported to. */
export const USAGE_METER_EVENT = "billing_tools_usage";

/**
 * Stripe Billing Meters: purpose-built usage counting, aggregated server-side.
 *
 * Chosen over reading balance transactions for two reasons beyond the money/usage
 * split. It is idempotent by construction (`identifier`), and a summary is ONE
 * call for any window — `usageSince` walks pages newest-first until it passes the
 * start, so an annual window would page through a year of transactions on the hot
 * path of every metered execution.
 *
 * The trade: summaries lag aggregation by a few seconds, so a hard cap can
 * overshoot slightly. Irrelevant against a pool of a million tokens; it is why
 * seat packs, which are small, can keep using the exact balance path.
 *
 * `ensureMeters` provisions the meter, in the same spirit as `ensurePlans`.
 */
export function stripeMeterUsageLedger(
  opts: { eventName?: string } = {},
): UsageLedger {
  const eventName = opts.eventName ?? USAGE_METER_EVENT;
  return {
    async record(e) {
      await getStripe().billing.meterEvents.create({
        event_name: eventName,
        payload: {
          // Stripe requires the customer on the payload; everything else is ours.
          stripe_customer_id: e.customerId,
          value: String(e.cost),
          action: e.action,
          funded: e.funded,
          ...(e.caller?.kind ? { caller_kind: e.caller.kind } : {}),
          ...(e.caller?.id ? { caller_id: e.caller.id } : {}),
        },
        ...(e.idempotencyKey ? { identifier: e.idempotencyKey } : {}),
        ...(e.at ? { timestamp: Math.floor(e.at / 1000) } : {}),
      });
    },
    async total(q) {
      const meter = await meterIdFor(eventName);
      if (!meter) return 0;
      // Seconds, and Stripe requires the window to sit on minute boundaries.
      const floorMinute = (ms: number) => Math.floor(ms / 60_000) * 60;
      const summaries = await getStripe().billing.meters.listEventSummaries(meter, {
        customer: q.customerId,
        start_time: floorMinute(q.start),
        end_time: floorMinute(q.end ?? Date.now()),
        limit: 100,
      });
      // A meter aggregates one dimension, so a per-caller filter can't be pushed
      // down. Callers that need it use the balance ledger (seat packs), which is
      // exact anyway — see the note above.
      return summaries.data.reduce((sum, s) => sum + s.aggregated_value, 0);
    },
  };
}

// Meter ids are stable per event name; resolving one is a list call, so memoise
// it per process the way plan prices are.
const meterIds = new Map<string, string | null>();

async function meterIdFor(eventName: string): Promise<string | null> {
  const hit = meterIds.get(eventName);
  if (hit !== undefined) return hit;
  for await (const m of getStripe().billing.meters.list({ status: "active", limit: 100 })) {
    if (m.event_name === eventName) {
      meterIds.set(eventName, m.id);
      return m.id;
    }
  }
  meterIds.set(eventName, null);
  return null;
}

/**
 * Create the usage meter if it doesn't exist. Idempotent, like `ensurePlans`.
 *
 * Only needed by a config with an included window; a wallet-only product never
 * calls it. Aggregates `sum` over the reported `value`, which is the token cost.
 */
export async function ensureMeters(
  opts: { eventName?: string; displayName?: string } = {},
): Promise<{ meterId: string; created: boolean }> {
  const eventName = opts.eventName ?? USAGE_METER_EVENT;
  const existing = await meterIdFor(eventName);
  if (existing) return { meterId: existing, created: false };
  const meter = await getStripe().billing.meters.create({
    display_name: opts.displayName ?? "billing-tools usage",
    event_name: eventName,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  });
  meterIds.set(eventName, meter.id);
  return { meterId: meter.id, created: true };
}

/** Forget resolved meter ids — for a test, or after archiving one. */
export function invalidateMeters(): void {
  meterIds.clear();
}
