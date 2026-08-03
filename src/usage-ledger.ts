import { getStripe, usageSince } from "./billing.js";

// Counting usage, separately from moving money.
//
// These were one thing until now: `deductCredits` wrote a Stripe balance
// transaction, and `usageSince` read those transactions back as the usage
// ledger. That works exactly as long as every metered call costs money.
//
// It stops working the moment a plan INCLUDES usage. An included call has to be
// counted (or a cap can't be enforced) but must not be charged (the customer
// already paid for it in the subscription) — and a balance transaction cannot do
// one without the other. Crediting the allowance instead is worse: a Stripe
// credit balance auto-applies to the next invoice, so a plan's own included
// credits discount its own renewal (measured: 1000 credits turned a €21.04 seat
// invoice into €11.04 due).
//
// So: money stays in `deductCredits`, counting moves here. The rule at the call
// site is `record` always, `deductCredits` only when the wallet is what funded it.

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
 * `record` is a no-op — `deductCredits` already wrote the row — and `total` is
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
 * overshoot slightly. Irrelevant against a pool of a million credits; it is why
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
 * calls it. Aggregates `sum` over the reported `value`, which is the credit cost.
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

// ── A SQL store, for the one thing Stripe cannot count ──────────────────────
//
// Reach for this when a plan INCLUDES usage and you also want per-member figures.
// That pair is the gap the two Stripe ledgers leave, and no metadata store closes
// it: Stripe customer metadata holds 50 keys, WorkOS organization metadata holds
// 10, neither has an atomic increment (so counting races on read-modify-write),
// and neither is somewhere you want a write on the hot path of every metered call.
// Metadata is built for a handful of stable attributes; usage is an append-only
// event stream. Hence a row.
//
// The library depends on no database driver. The client is DUCK-TYPED — anything
// with `query(sql, params)` returning `{ rows }` satisfies it, which `pg`'s Pool
// and Client, Neon's serverless driver and most others already do.

/** The one method this needs from a driver. */
export interface SqlClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * The table, and the three indexes the two queries below actually use.
 *
 * Shipped rather than described because the UNIQUE index is PARTIAL, and that is
 * not a detail a consumer should have to rediscover: `idempotency_key` is
 * nullable, only non-null keys are unique, and Postgres refuses to infer a
 * partial index for `ON CONFLICT` unless the predicate is repeated at the insert.
 * Getting it wrong fails every insert with 42P10.
 *
 * Idempotent, so it is safe to run from a migration on every deploy.
 */
export const USAGE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id              bigserial PRIMARY KEY,
  org_id          text NOT NULL,
  customer_id     text,
  action          text NOT NULL,
  cost            integer NOT NULL,
  -- Which allowance paid: pool | pack | wallet. Kept because "included vs
  -- charged" is unanswerable afterwards otherwise.
  funded          text NOT NULL,
  caller_kind     text,
  caller_id       text,
  -- Makes a retried call a no-op rather than a double count.
  idempotency_key text,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_org_at_idx
  ON usage_events (org_id, at DESC);
CREATE INDEX IF NOT EXISTS usage_events_org_caller_at_idx
  ON usage_events (org_id, caller_kind, caller_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_idx
  ON usage_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

/** Create the table + indexes if they are missing. Call it from your migration;
 *  it is idempotent. Consumers who own their schema can read `USAGE_EVENTS_DDL`
 *  instead and paste it into their own migration tool. */
export async function ensureUsageLedgerTable(client: SqlClient): Promise<void> {
  await client.query(USAGE_EVENTS_DDL);
}

/**
 * Usage counted in Postgres: exact, attributable per caller, and summable over
 * any window a plan declares (hour / day / week / month / cycle).
 *
 * `record` is on the hot path of every metered execution: one INSERT, no read,
 * no transaction. `total` is one aggregate over an index-covered range.
 */
export function postgresUsageLedger(client: SqlClient): UsageLedger {
  return {
    async record(e) {
      // ON CONFLICT on the idempotency key, so a retried execution is counted
      // once. Without a key (the common case) every row is a distinct event. The
      // repeated WHERE is what makes the partial index inferable — see the DDL.
      await client.query(
        `INSERT INTO usage_events
           (org_id, customer_id, action, cost, funded, caller_kind, caller_id, idempotency_key, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          e.orgId,
          e.customerId ?? null,
          e.action,
          e.cost,
          e.funded,
          e.caller?.kind ?? null,
          e.caller?.id ?? null,
          e.idempotencyKey ?? null,
          e.at ?? Date.now(),
        ],
      );
    },

    async total(q) {
      // [start, end): the half-open window this library defines everywhere, so an
      // event on a boundary is counted by exactly one window and never by both.
      const params: unknown[] = [q.orgId, q.start];
      let sql = `SELECT COALESCE(SUM(cost), 0)::int AS total
                   FROM usage_events
                  WHERE org_id = $1
                    AND at >= to_timestamp($2 / 1000.0)`;
      if (q.end != null) {
        params.push(q.end);
        sql += ` AND at < to_timestamp($${params.length} / 1000.0)`;
      }
      // A caller filter with no id means "all callers of this kind", which is how
      // a shared API seat is measured: one window for every key in the org.
      if (q.filter?.callerKind) {
        params.push(q.filter.callerKind);
        sql += ` AND caller_kind = $${params.length}`;
      }
      if (q.filter?.callerId) {
        params.push(q.filter.callerId);
        sql += ` AND caller_id = $${params.length}`;
      }
      const r = await client.query<{ total: number }>(sql, params);
      return r.rows[0]?.total ?? 0;
    },
  };
}
