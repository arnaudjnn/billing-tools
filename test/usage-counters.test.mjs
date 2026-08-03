// Counters instead of events.
//
// Every read in this library is `sum(cost) where org, [start, end), caller?` over a
// FIXED, UTC-aligned window, so an append-only log is over-storage: it aggregates a
// range on the hot path of every metered call, over a table that grows by one row
// per call forever. Counters answer the same question with a point read, and one
// row per (org, scope, hour) is bounded by TIME rather than by traffic.
//
// The buckets are hourly because `every: "hour"` is the tightest window the plan
// model can express, so it is the finest anything can ask for.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BUCKET_MS,
  bucketOf,
  counterKey,
  counterUsageLedger,
  memoryUsageCounters,
  scopeOf,
  scopesFor,
  sqlUsageCounters,
  USAGE_COUNTERS,
} from "../dist/usage-counters.js";

const HOUR = 3_600_000;
const T = Date.parse("2026-08-20T12:30:00.000Z");
const event = (over = {}) => ({
  orgId: "ws_1",
  customerId: "cus_1",
  action: "search",
  cost: 5,
  funded: "pack",
  caller: { kind: "user", id: "u_1" },
  at: T,
  ...over,
});

test("the write and read paths derive the SAME scope", () => {
  // The whole contract. A `total` computing a different scope string from the same
  // caller would read a counter nobody writes and report 0 forever — the failure
  // that looks like generosity.
  assert.deepEqual(scopesFor(event()), ["org", "k:user", "u:u_1"]);
  assert.equal(scopeOf(undefined), "org");
  assert.equal(scopeOf({}), "org");
  assert.equal(scopeOf({ callerKind: "user" }), "k:user");
  assert.equal(scopeOf({ callerKind: "user", callerId: "u_1" }), "u:u_1");
  // An id with no kind still resolves to the member: the id is the narrower fact.
  assert.equal(scopeOf({ callerId: "u_1" }), "u:u_1");
});

test("one call is counted once per scope, so both reads see it", async () => {
  const store = memoryUsageCounters();
  const ledger = counterUsageLedger(store);
  await ledger.record(event());

  const window = { orgId: "ws_1", customerId: "cus_1", start: T - HOUR, end: T + HOUR };
  assert.equal(await ledger.total(window), 5, "org-wide");
  assert.equal(await ledger.total({ ...window, filter: { callerKind: "user" } }), 5, "by kind");
  assert.equal(
    await ledger.total({ ...window, filter: { callerKind: "user", callerId: "u_1" } }),
    5,
    "by member",
  );
  // Another member's window is untouched.
  assert.equal(
    await ledger.total({ ...window, filter: { callerKind: "user", callerId: "u_2" } }),
    0,
  );
});

test("a thousand calls in an hour are ONE row per scope", async () => {
  // The point of counters: the store stops growing with traffic. An event log would
  // hold 1 000 rows here and sum them on every subsequent gate check.
  const store = memoryUsageCounters();
  const ledger = counterUsageLedger(store);
  for (let i = 0; i < 1_000; i++) await ledger.record(event({ cost: 1 }));

  assert.equal(store.map.size, 3, "org + kind + member");
  assert.equal(
    await ledger.total({ orgId: "ws_1", customerId: "cus_1", start: T - HOUR, end: T + HOUR }),
    1_000,
  );
});

test("buckets are UTC-aligned hours", () => {
  assert.equal(BUCKET_MS, HOUR);
  assert.equal(bucketOf(Date.parse("2026-08-20T12:00:00.000Z")), 496_452);
  // Anything within the hour lands in the same bucket…
  assert.equal(bucketOf(Date.parse("2026-08-20T12:59:59.999Z")), 496_452);
  // …and the next second starts the next one.
  assert.equal(bucketOf(Date.parse("2026-08-20T13:00:00.000Z")), 496_453);
});

test("a window sums every bucket it covers, half-open at the start", async () => {
  const store = memoryUsageCounters();
  const ledger = counterUsageLedger(store);
  // One call an hour for four hours, from 09:00.
  const base = Date.parse("2026-08-20T09:00:00.000Z");
  for (let h = 0; h < 4; h++) await ledger.record(event({ cost: 10, at: base + h * HOUR }));

  const total = (start, end) =>
    ledger.total({ orgId: "ws_1", customerId: "cus_1", start, end });
  assert.equal(await total(base, base + 4 * HOUR), 40, "all four");
  assert.equal(await total(base + 2 * HOUR, base + 4 * HOUR), 20, "the last two");
  // `start` is inclusive, so the 09:00 bucket belongs to a window starting at 09:00
  // and NOT to one starting at 10:00 — an event on a boundary is counted once.
  assert.equal(await total(base + HOUR, base + 2 * HOUR), 10);
  assert.equal(await total(base - 5 * HOUR, base), 0, "nothing before it");
});

test("an open-ended window counts up to now", async () => {
  const store = memoryUsageCounters();
  const ledger = counterUsageLedger(store);
  await ledger.record(event({ cost: 7, at: Date.now() - HOUR }));
  assert.equal(
    await ledger.total({ orgId: "ws_1", customerId: "cus_1", start: Date.now() - 3 * HOUR }),
    7,
  );
});

test("a free call moves no counter", async () => {
  const store = memoryUsageCounters();
  await counterUsageLedger(store).record(event({ cost: 0 }));
  assert.equal(store.map.size, 0);
});

test("orgs cannot read each other's counters", async () => {
  const store = memoryUsageCounters();
  const ledger = counterUsageLedger(store);
  await ledger.record(event({ orgId: "ws_1", cost: 3 }));
  await ledger.record(event({ orgId: "ws_2", cost: 9 }));

  const read = (orgId) =>
    ledger.total({ orgId, customerId: "cus_1", start: T - HOUR, end: T + HOUR });
  assert.equal(await read("ws_1"), 3);
  assert.equal(await read("ws_2"), 9);
});

test("it declares that it counts EVERYTHING", () => {
  // What lets `warnLedgerGaps` / `checkPlansConfig` stay silent: unlike either
  // Stripe leg, a counter sees included usage AND attributes it per member.
  assert.deepEqual(counterUsageLedger(memoryUsageCounters()).covers, {
    orgIncluded: true,
    callerIncluded: true,
  });
});

test("a window wider than the read cap keeps the most RECENT slice", async () => {
  // Clamping has to under-report rather than over-report: refusing early is
  // recoverable, granting allowance nobody paid for is not. The recent slice is
  // also the one that decides whether the NEXT call is allowed.
  const store = memoryUsageCounters();
  const ledger = counterUsageLedger(store, { maxKeysPerRead: 2 });
  const base = Date.parse("2026-08-20T09:00:00.000Z");
  for (let h = 0; h < 4; h++) await ledger.record(event({ cost: 10, at: base + h * HOUR }));

  const used = await ledger.total({
    orgId: "ws_1",
    customerId: "cus_1",
    start: base,
    end: base + 4 * HOUR,
  });
  assert.equal(used, 20, "the last two buckets, not the first two");
});

// ── The SQL backend ─────────────────────────────────────────────────────────

function fakeClient(rows = [{ total: 0 }]) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("add is one atomic upsert for every scope", async () => {
  // On the hot path of every metered call, so N scopes must not be N round trips —
  // and `used = used + excluded.used` is the increment that makes concurrent calls
  // serialise instead of losing one another's writes.
  const client = fakeClient();
  await sqlUsageCounters(client).add(["a", "b", "c"], 5, Date.parse("2027-01-01T00:00:00Z"));

  assert.equal(client.calls.length, 1);
  const { sql, params } = client.calls[0];
  assert.match(sql, /INSERT INTO usage_counters/);
  assert.match(sql, /used = usage_counters\.used \+ excluded\.used/);
  assert.match(sql, /unnest\(\$1::text\[\]\)/);
  assert.deepEqual(params[0], ["a", "b", "c"]);
  assert.equal(params[1], 5);
});

test("sum is one primary-key lookup, and bigint comes back exact", async () => {
  // `pg` returns bigint as a string; a naive read would concatenate.
  const client = fakeClient([{ total: "1234" }]);
  assert.equal(await sqlUsageCounters(client).sum(["a", "b"]), 1234);
  assert.match(client.calls[0].sql, /WHERE key = ANY\(\$1::text\[\]\)/);
});

test("empty inputs touch the database at all", async () => {
  const client = fakeClient();
  const store = sqlUsageCounters(client);
  await store.add([], 5, null);
  assert.equal(await store.sum([]), 0);
  assert.equal(client.calls.length, 0, "no statement for nothing to do");
});

test("the DDL is idempotent and keyed for a point read", async () => {
  assert.match(USAGE_COUNTERS, /CREATE TABLE IF NOT EXISTS usage_counters/);
  assert.match(USAGE_COUNTERS, /key\s+text PRIMARY KEY/);
  // Bulk expiry only; the read never filters on it.
  assert.match(USAGE_COUNTERS, /CREATE INDEX IF NOT EXISTS usage_counters_stale_idx/);
});

test("the key is derivable from either side", () => {
  // No index needed to FIND a counter, which is what lets a KV store back this.
  assert.equal(counterKey("ws_1", "u:u_1", 496_452), "ws_1|u:u_1|496452");
});

test("the old DDL names still resolve", async () => {
  // `USAGE_COUNTERS_DDL` / `USAGE_EVENTS_DDL` were renamed — the constant IS the
  // table's shape, so the name says which table rather than which kind of string.
  // Both aliases stay: a rename that breaks a consumer's migration script is not
  // worth the tidiness.
  const m = await import("../dist/index.js");
  assert.equal(m.USAGE_COUNTERS_DDL, m.USAGE_COUNTERS);
  assert.equal(m.USAGE_EVENTS_DDL, m.USAGE_EVENTS);
});
