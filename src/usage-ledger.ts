import { getStripe, usageSince } from "./billing.js";
import { ledgerGaps, normalizePlans, type LedgerCoverage, type PlanCatalog } from "./plan-model.js";

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
  /**
   * Which windows this ledger can count (see `LedgerCoverage`).
   *
   * Optional, and omitting it means "not stated" rather than "counts nothing":
   * the config checks skip a ledger that doesn't declare, exactly as they skip a
   * caller who passes no ledger at all. Every implementation shipped here declares
   * it, which is what lets one static check catch a plan whose included window the
   * wired ledger cannot see — the failure that otherwise reads 0% forever.
   */
  readonly covers?: LedgerCoverage;
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
    // Per-caller, because a debit carries the caller on its metadata — but only
    // where money moved, so nothing INCLUDED is visible on either axis.
    covers: { orgIncluded: false, callerIncluded: false },
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
 * The meter provisions itself on first use, like plan prices. `ensureMeters` is
 * the same call made eagerly, for a deploy step that wants it to exist before a
 * request does.
 */
export function stripeMeterUsageLedger(
  opts: { eventName?: string } = {},
): UsageLedger {
  const eventName = opts.eventName ?? USAGE_METER_EVENT;
  return {
    // One dimension, aggregated server-side: it sees every call whatever funded
    // it, and cannot be filtered by caller.
    covers: { orgIncluded: true, callerIncluded: false },
    async record(e) {
      // Resolve (and create) the meter BEFORE reporting to it. A meter event names
      // its meter by `event_name`, so without this the very first call on a fresh
      // account reports into nothing — and this is the write side, the one whose
      // loss can't be recovered later by a read. Memoised, so it costs one list on
      // the first metered call of the process and nothing after.
      if (!(await meterIdFor(eventName))) return;
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

// ── Resolving the meter, and creating it if it isn't there ───────────────────
//
// Provisioned on first use rather than asked of the deployment, which is the rule
// the rest of this library already follows (`ensurePlans` for prices,
// `ensurePaymentMethodConfig` for payment forms): the ONE thing a developer sets
// is the Stripe key.
//
// It used to be the exception, and the cost of that was invisible. A config with
// an included window whose deployment never called `ensureMeters` had no meter, so
// every window read 0 — nothing was ever refused, which looks like generosity
// rather than a fault, and the pool it was supposed to enforce might as well not
// have been declared.
//
// Memoised per process and per event name, with in-flight calls shared, so a burst
// of cold metered calls resolves once. Meter ids are stable, so once found the
// answer is the answer.
const meterIds = new Map<string, string>();
const meterInflight = new Map<string, Promise<string | null>>();
// One line per process, not per call: a metered endpoint under load would
// otherwise turn a config problem into thousands of identical lines.
const warned = new Set<string>();
// A FAILED resolve is remembered only briefly. Not remembering it at all would put
// a list plus a create attempt on the hot path of every metered call for as long as
// the failure lasts; remembering it forever would mean a permission granted at
// 09:05 doesn't take effect until the process restarts. So: back off, then retry.
const RESOLVE_RETRY_MS = 5 * 60 * 1000;
const failedAt = new Map<string, number>();

async function findMeter(eventName: string): Promise<string | null> {
  for await (const m of getStripe().billing.meters.list({ status: "active", limit: 100 })) {
    if (m.event_name === eventName) return m.id;
  }
  return null;
}

/**
 * The meter id for `eventName`, creating the meter when it doesn't exist.
 *
 * NEVER THROWS — the same rule `defaultPaymentMethodConfig` follows, and for the
 * same reason: this is reached from `ledger.record` on the hot path of every
 * metered call, so a key without permission to create a meter must not take the
 * product down. It degrades to `null` (windows read 0) and says so once, loudly,
 * because that state is otherwise indistinguishable from no usage.
 */
function meterIdFor(eventName: string, opts: { create?: boolean } = {}): Promise<string | null> {
  const hit = meterIds.get(eventName);
  if (hit) return Promise.resolve(hit);
  const failed = failedAt.get(eventName);
  if (failed !== undefined && Date.now() - failed < RESOLVE_RETRY_MS) return Promise.resolve(null);
  const pending = meterInflight.get(eventName);
  if (pending) return pending;

  const resolve = (async () => {
    try {
      const found =
        (await findMeter(eventName)) ??
        (opts.create === false ? null : await createMeter(eventName));
      // Only a real id is remembered. Caching the miss would poison the memo for
      // the life of the process — including for `ensureMeters`, which probes with
      // `create: false` and creates the meter itself immediately afterwards.
      if (found) meterIds.set(eventName, found);
      return found;
    } catch (e) {
      failedAt.set(eventName, Date.now());
      if (!warned.has(eventName)) {
        warned.add(eventName);
        console.error(
          `[billing] could not resolve or create the Stripe billing meter "${eventName}": ` +
            `${(e as Error).message}. Included usage cannot be counted until it exists, so every ` +
            "org-wide window reads 0 and no cap or org-scoped rate limit will ever apply. " +
            "Create it once with ensureMeters(), or grant the key write access to billing meters.",
        );
      }
      return null;
    }
  })().finally(() => meterInflight.delete(eventName));

  meterInflight.set(eventName, resolve);
  return resolve;
}

async function createMeter(eventName: string, displayName?: string): Promise<string> {
  const meter = await getStripe().billing.meters.create({
    display_name: displayName ?? "billing-tools usage",
    event_name: eventName,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  });
  return meter.id;
}

/**
 * Ensure the usage meter exists, eagerly. Idempotent, like `ensurePlans`.
 *
 * No longer a prerequisite — the ledger provisions the meter on first use — but
 * still worth calling from a deploy step or a setup script when you'd rather the
 * meter existed before a customer's request pays for creating it, or want the
 * failure to surface in a deploy log instead of a warning. Unlike the lazy path
 * this one THROWS, because a setup script wants to know.
 *
 * Aggregates `sum` over the reported `value`, which is the credit cost.
 */
export async function ensureMeters(
  opts: { eventName?: string; displayName?: string } = {},
): Promise<{ meterId: string; created: boolean }> {
  const eventName = opts.eventName ?? USAGE_METER_EVENT;
  const existing = await meterIdFor(eventName, { create: false });
  if (existing) return { meterId: existing, created: false };
  const meterId = await createMeter(eventName, opts.displayName);
  meterIds.set(eventName, meterId);
  return { meterId, created: true };
}

/** Forget resolved meter ids — for a test, or after archiving one. Also clears the
 *  once-per-process complaint above, so a key that gains permission (or a test that
 *  wants to see it again) gets a fresh line rather than silence. */
export function invalidateMeters(): void {
  meterIds.clear();
  warned.clear();
  failedAt.clear();
}

// ── The composite: route each read to the store that can answer it ───────────
//
// Neither Stripe ledger above is the right answer on its own, and which one is
// wrong depends on the QUERY rather than on the config:
//
//   an ORG-wide window   (pool, `scope: "org"` limits, spend limit)
//     → the meter. It sees every call, included ones too, and a summary is ONE
//       request for any window width. This is the leg that removes a database:
//       a 200 000-credit weekly window costs the same read as a 400-credit one.
//
//   a PER-CALLER window  (a seat pack, `scope: "caller"` limits)
//     → balance transactions, which carry the caller on their metadata. Exact and
//       per-member, but they only exist where money moved, so INCLUDED per-member
//       usage is invisible to them.
//
// That last line is the honest limit of running with no store, and it is why this
// is not simply "the new default for everything": a plan that both includes usage
// AND meters it per member still needs `meter.db` (or the counter leg, when it
// lands). `createBilling` warns for exactly that combination rather than for any
// cap, which is the difference between "you need a database" and "you don't".
//
// Pass `perCaller` to swap the second leg for a store — `stripeUsageLedger({
// perCaller: postgresUsageLedger(db) })` is strictly better than the SQL ledger
// alone, because the org-wide reads stop scanning rows at all.

export function stripeUsageLedger(
  opts: {
    eventName?: string;
    /**
     * Where a per-CALLER window is read from. Default: the balance ledger (exact,
     * per-member, wallet-funded only). A store belongs here for a plan whose
     * per-member window is INCLUDED.
     */
    perCaller?: UsageLedger;
    /**
     * Where an ORG-wide window is read from. Default: the Stripe meter, which is
     * the right answer today.
     *
     * A seam rather than a constant because this is the leg most likely to change:
     * Stripe's Meter Usage Analytics API can answer the same question grouped by a
     * dimension, and when it leaves preview it belongs here — at which point the
     * per-caller leg can point at it too and the store disappears entirely.
     */
    orgWide?: UsageLedger;
  } = {},
): UsageLedger {
  const meter = opts.orgWide ?? stripeMeterUsageLedger({ eventName: opts.eventName });
  const perCaller = opts.perCaller ?? stripeBalanceUsageLedger();
  // Each axis inherits the leg that answers it, so `stripeUsageLedger({ perCaller:
  // postgresUsageLedger(db) })` reports full coverage and the bare composite reports
  // the org axis only — which is exactly what each can do. A leg that declares
  // nothing (a consumer's own) makes the composite silent too rather than making it
  // guess: an invented `false` would fail a config that is perfectly wired.
  const covers =
    meter.covers && perCaller.covers
      ? {
          orgIncluded: meter.covers.orgIncluded,
          callerIncluded: perCaller.covers.callerIncluded,
        }
      : undefined;
  return {
    ...(covers ? { covers } : {}),
    async record(e) {
      // The meter always, so org-wide windows see every call whatever funded it.
      // The per-caller leg too, in the same round — for the balance ledger that is
      // a no-op (the debit IS the record) and for a store it is the write. Never
      // a second money movement: `deductCredits` owns that, and it has already
      // run for a wallet-funded call.
      await Promise.all([meter.record(e), perCaller.record(e)]);
    },
    total(q) {
      const perCallerQuery = Boolean(q.filter?.callerKind || q.filter?.callerId);
      return perCallerQuery ? perCaller.total(q) : meter.total(q);
    },
  };
}

/**
 * The default ledger, defined ONCE.
 *
 * `createMeter` and `createBilling` used to answer this differently — the balance
 * ledger and the composite — and the difference was invisible to the consumer who
 * picked the wrong entry point: wiring `createMeter` directly got a ledger that
 * cannot see included usage, so a pooled cap read 0% forever and no call was ever
 * refused. Two defaults for one decision is how that happens, so there is one.
 *
 * Built once per process: it holds only memoised lookups, and rebuilding it per
 * metered call would throw those away.
 */
let defaultLedger: UsageLedger | null = null;
export function defaultUsageLedger(): UsageLedger {
  return (defaultLedger ??= stripeUsageLedger());
}

/**
 * Warn at boot about the plans whose included windows this ledger cannot count.
 *
 * Worth a line in a deploy log because the failure is silent and looks like
 * generosity: the window reads 0, so nothing is ever refused. A ledger that
 * declares no `covers` (a consumer's own) says nothing here — see `UsageLedger`.
 *
 * Called from `createMeter`, i.e. once per composition rather than per metered
 * call, so it needs no de-duplication: a second line means a second meter was
 * built, which is itself worth seeing.
 */
export function warnLedgerGaps(plans: PlanCatalog, ledger: UsageLedger): void {
  if (!ledger.covers) return;
  const { org, caller } = ledgerGaps(normalizePlans(plans), ledger.covers);
  const say = (msg: string) => console.warn(`[billing] ${msg}`);
  if (org.length) {
    say(
      `plans ${org.map((m) => m.key).join(", ")} include usage org-wide (a pool, or a ` +
        "`scope: \"org\"` rate limit) and the wired ledger can only see calls the wallet paid " +
        "for. Included usage counts as 0, so the window never applies and nothing is refused. " +
        "Use the default `stripeUsageLedger()` — it counts these on a Stripe meter, at any " +
        "volume, with no store.",
    );
  }
  if (caller.length) {
    say(
      `plans ${caller.map((m) => m.key).join(", ")} meter an INCLUDED window per member (a seat ` +
        "pack, or a `scope: \"caller\"` rate limit), which no Stripe primitive can count: a " +
        "balance transaction carries the caller but only exists where money moved, and a meter " +
        "summary cannot be filtered by caller. That usage counts as 0. Pass `meter.db` (a " +
        "Postgres client) or a `ledger` of your own — or pool the allowance instead " +
        '(`cap: { kind: "pool", perSeat: N }`), which needs no store.',
    );
  }
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
export const USAGE_EVENTS = `
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
 *  it is idempotent. Consumers who own their schema can read `USAGE_EVENTS`
 *  instead and paste it into their own migration tool. */
/** @deprecated Renamed to `USAGE_EVENTS` — the constant IS the table's shape, so
 *  the name says which table rather than which kind of string. Kept as an alias
 *  because a rename that breaks a consumer's migration script is not worth the
 *  tidiness. */
export const USAGE_EVENTS_DDL = USAGE_EVENTS;

export async function ensureUsageLedgerTable(client: SqlClient): Promise<void> {
  await client.query(USAGE_EVENTS);
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
    // Every event is a row carrying both the caller and what funded it, so this is
    // the one implementation that can answer either question.
    covers: { orgIncluded: true, callerIncluded: true },
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
