import type { LedgerCoverage } from "./plan-model.js";
import type { UsageEvent, UsageLedger, UsageQuery } from "./usage-ledger.js";

// Counting usage as COUNTERS rather than as events — the scale-correct store, and
// the one that works without SQL.
//
// ── Why counters, when `postgresUsageLedger` already works ──────────────────
//
// Because of what the seam is actually asked. Every read in this library is the
// same shape — `sum(cost) where org, [start, end), callerKind?, callerId?` — and
// every window is FIXED and UTC-aligned (`rateWindowFor`, `cycleWindowFor`). An
// append-only event log answers that by aggregating a range on the hot path of
// every metered call, over a table that grows by one row per call forever. At the
// volumes a plan actually declares (an Enterprise window of 200 000 credits a
// week) that is millions of rows a month whose only purpose is to be summed back
// into a handful of integers, plus the retention and partitioning work that
// follows.
//
// Counters answer it with a point read. One row per (org, scope, hour), so a
// caller making a thousand calls in an hour writes ONE row instead of a thousand,
// and the row count is bounded by time rather than by traffic.
//
// ── Why HOURLY buckets rather than one counter per declared window ──────────
//
// A counter keyed by the plan's own windows would be smaller still, but `record`
// would have to know which windows exist — and a window it failed to bump is
// usage counted by nothing, which reads as 0% and refuses no one. That failure
// looks like generosity, which is the exact class of defect this file is written
// to avoid. Bucketing by a fixed grain instead means `record` needs no plan
// knowledge at all: it bumps the bucket the event falls in, and `total` sums the
// buckets its window covers. Any window is answerable, including one added to the
// config later.
//
// An hour is the grain because `every: "hour"` is the tightest window the plan
// model can express, so it is the finest anything can ask for. A month is then at
// most 744 keys in ONE batched read.
//
// ── What this gives up ──────────────────────────────────────────────────────
//
// The audit trail. A counter cannot say WHICH actions made up a total, or when
// inside the hour. `postgresUsageLedger` keeps that and stays the right choice for
// a consumer who wants per-action history; the two satisfy the same seam, so a
// deployment can even write to both.

/** Milliseconds in the bucket grain. The tightest window a plan can declare. */
export const BUCKET_MS = 3_600_000;

/** The bucket an instant falls in: hours since the epoch, UTC-aligned. */
export const bucketOf = (atMs: number): number => Math.floor(atMs / BUCKET_MS);

/**
 * WHOSE counter. Derived identically on the write and read paths, which is the
 * whole contract — a `total` that computed a different scope string from the same
 * caller would read a counter nobody writes, and report 0 forever.
 *
 * `org` is every call in the workspace. A caller kind with no id is every caller
 * of that kind (how a shared API seat is measured); with an id it is one member.
 */
export function scopeOf(filter?: { callerKind?: string; callerId?: string }): string {
  if (filter?.callerId) return `u:${filter.callerId}`;
  if (filter?.callerKind) return `k:${filter.callerKind}`;
  return "org";
}

/** Every scope a single event counts toward. An event is counted once per scope,
 *  so an org-wide read and a per-member read both see it. */
export function scopesFor(event: UsageEvent): string[] {
  const scopes = ["org"];
  if (event.caller?.kind) scopes.push(`k:${event.caller.kind}`);
  if (event.caller?.id) scopes.push(`u:${event.caller.id}`);
  return scopes;
}

/** `org|scope|bucket` — derivable from either side, so no index is needed to find
 *  a counter and a KV store works as well as a table. */
export const counterKey = (orgId: string, scope: string, bucket: number): string =>
  `${orgId}|${scope}|${bucket}`;

/**
 * The store. Two operations, both of which every candidate backend already has.
 *
 * `add` must be ATOMIC per key — an increment, not a read-then-write. That is the
 * whole reason this can live in Redis or Postgres but not in Stripe or WorkOS
 * metadata: neither has an increment, so two concurrent metered calls would both
 * read `n`, both write `n+1`, and one call would vanish.
 */
export interface UsageCounterStore {
  /** Add `amount` to every key. `expiresAtMs` is a hint for stores with TTL; a
   *  table can ignore it and sweep on `bucket` instead. */
  add(keys: string[], amount: number, expiresAtMs: number | null): Promise<void>;
  /** Sum the given keys. Missing keys count as 0. ONE round trip. */
  sum(keys: string[]): Promise<number>;
}

export interface CounterLedgerOptions {
  /** How long a bucket is kept, for stores that expire. Default 400 days, which
   *  covers an annual window plus slack. */
  retentionMs?: number;
  /** Cap on keys per read, so a pathological window cannot issue an unbounded
   *  fetch. Default 8 784 (a leap year of hours). A window wider than this reads
   *  the most RECENT slice, which under-reports — the direction that refuses
   *  early rather than granting what nobody paid for. */
  maxKeysPerRead?: number;
}

/**
 * A `UsageLedger` backed by counters. Counts EVERYTHING — included and
 * wallet-funded, org-wide and per member — which is what `covers` declares.
 */
export function counterUsageLedger(
  store: UsageCounterStore,
  opts: CounterLedgerOptions = {},
): UsageLedger {
  const retentionMs = opts.retentionMs ?? 400 * 86_400_000;
  const maxKeys = Math.max(1, opts.maxKeysPerRead ?? 8_784);

  return {
    covers: { orgIncluded: true, callerIncluded: true } satisfies LedgerCoverage,

    async record(event: UsageEvent) {
      if (!event.cost) return; // a free call moves no counter
      const at = event.at ?? Date.now();
      const bucket = bucketOf(at);
      const keys = scopesFor(event).map((s) => counterKey(event.orgId, s, bucket));
      // One call for every scope: a store can pipeline them, and a table can do it
      // in a single multi-row upsert.
      await store.add(keys, event.cost, at + retentionMs);
    },

    async total(query: UsageQuery) {
      // [start, end): the half-open window this library defines everywhere. The
      // END bucket is inclusive when the window ends mid-bucket, because an event
      // in that hour may fall inside the window — a counter cannot say where in
      // the hour it happened, so it is counted. The overshoot is bounded by one
      // bucket and only ever at the CURRENT edge, where the alternative is to
      // ignore the usage that just happened.
      const from = bucketOf(query.start);
      const to = bucketOf((query.end ?? Date.now()) - 1);
      if (to < from) return 0;

      const scope = scopeOf(query.filter);
      const keys: string[] = [];
      // Newest-first when clamped, so a window wider than the cap keeps the slice
      // that decides whether the NEXT call is allowed.
      const first = Math.max(from, to - maxKeys + 1);
      for (let b = first; b <= to; b++) keys.push(counterKey(query.orgId, scope, b));
      return store.sum(keys);
    },
  };
}

// ── Backends ────────────────────────────────────────────────────────────────

/** The table + the one index its read uses. Idempotent, so it is safe to run from
 *  a migration on every deploy. Bounded by (orgs × scopes × hours kept), not by
 *  traffic — the reason to prefer it over `usage_events` at volume. */
export const USAGE_COUNTERS = `
CREATE TABLE IF NOT EXISTS usage_counters (
  key   text PRIMARY KEY,
  used  bigint NOT NULL,
  -- Kept for bulk expiry; the read never filters on it.
  stale timestamptz
);
CREATE INDEX IF NOT EXISTS usage_counters_stale_idx ON usage_counters (stale);
`;

/** The one method this needs from a driver — the same duck type
 *  `postgresUsageLedger` uses, so `pg`'s Pool and Neon's driver both satisfy it. */
export interface SqlCounterClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** @deprecated Renamed to `USAGE_COUNTERS`, alongside `USAGE_EVENTS`. */
export const USAGE_COUNTERS_DDL = USAGE_COUNTERS;

export async function ensureUsageCountersTable(client: SqlCounterClient): Promise<void> {
  await client.query(USAGE_COUNTERS);
}

/**
 * Counters in Postgres: one upsert per scope on write, one `SUM` over a primary-key
 * lookup on read.
 *
 * `used = usage_counters.used + excluded.used` is the atomic increment — the row
 * lock is held for the statement, so concurrent calls serialise instead of losing
 * one another's writes.
 */
export function sqlUsageCounters(client: SqlCounterClient): UsageCounterStore {
  return {
    async add(keys, amount, expiresAtMs) {
      if (!keys.length) return;
      // One statement for every scope: unnest the keys rather than issuing N
      // round trips on the hot path.
      await client.query(
        `INSERT INTO usage_counters (key, used, stale)
         SELECT k, $2::bigint, $3::timestamptz FROM unnest($1::text[]) AS k
         ON CONFLICT (key) DO UPDATE
           SET used = usage_counters.used + excluded.used,
               stale = GREATEST(usage_counters.stale, excluded.stale)`,
        [keys, amount, expiresAtMs == null ? null : new Date(expiresAtMs).toISOString()],
      );
    },
    async sum(keys) {
      if (!keys.length) return 0;
      const r = await client.query<{ total: string | number | null }>(
        `SELECT COALESCE(SUM(used), 0) AS total
           FROM usage_counters WHERE key = ANY($1::text[])`,
        [keys],
      );
      // bigint comes back as a string from `pg`; Number is exact to 2^53, far
      // beyond any credit total.
      return Number(r.rows[0]?.total ?? 0) || 0;
    },
  };
}

/** Delete expired buckets. Call it from a cron; nothing depends on it running —
 *  a stale bucket is simply never read once its window has passed. */
export async function pruneUsageCounters(
  client: SqlCounterClient,
  now: number = Date.now(),
): Promise<void> {
  await client.query(`DELETE FROM usage_counters WHERE stale IS NOT NULL AND stale < $1`, [
    new Date(now).toISOString(),
  ]);
}

/**
 * The minimum a Redis-compatible client has to expose. Satisfied by `redis`,
 * `ioredis`, `@upstash/redis` and Vercel KV — which is the point: a deployment
 * with a KV and no SQL can still meter per member.
 */
export interface RedisCounterClient {
  incrby(key: string, amount: number): Promise<unknown>;
  pexpireat?(key: string, atMs: number): Promise<unknown>;
  mget(keys: string[]): Promise<Array<string | number | null>>;
}

/**
 * Counters in Redis: `INCRBY` per scope, one `MGET` per read.
 *
 * The expiry is set on every write rather than only on create. `PEXPIREAT` is
 * idempotent and one round trip, whereas checking first is two and races — and a
 * bucket that lost its expiry is a leak that only shows up as memory months later.
 */
export function redisUsageCounters(client: RedisCounterClient): UsageCounterStore {
  return {
    async add(keys, amount, expiresAtMs) {
      await Promise.all(
        keys.map(async (key) => {
          await client.incrby(key, amount);
          if (expiresAtMs != null && client.pexpireat) await client.pexpireat(key, expiresAtMs);
        }),
      );
    },
    async sum(keys) {
      if (!keys.length) return 0;
      const values = await client.mget(keys);
      return values.reduce<number>((acc, v) => acc + (v == null ? 0 : Number(v) || 0), 0);
    },
  };
}

/** In-memory counters, for tests and single-process development. Not for a
 *  deployment with more than one instance: each would count its own share, and the
 *  gate would allow the sum of every instance's window. */
export function memoryUsageCounters(): UsageCounterStore & { readonly map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    async add(keys, amount) {
      for (const key of keys) map.set(key, (map.get(key) ?? 0) + amount);
    },
    async sum(keys) {
      let total = 0;
      for (const key of keys) total += map.get(key) ?? 0;
      return total;
    },
  };
}
