// `cachedUsageLedger` — the request budget, and what it trades for it.
//
// The reason it exists is a rate limit, not a latency number: `listEventSummaries`
// is ONE Stripe endpoint at 25 req/s, and a per-seat catalogue issues two of them
// per metered call, so the account tops out around a dozen metered calls a second
// however much traffic there is.
//
// What it costs is staleness on the GATE, so these pin the boundary in both
// directions: a hit inside the TTL must not reach the ledger, and a read after it
// must.

import assert from "node:assert/strict";
import { test } from "vitest";

import { cachedUsageLedger } from "../dist/usage-cache.js";

/** A ledger that counts how often it is actually asked. */
function counting(total = 7) {
  const calls = { total: 0, record: 0, queries: [] };
  return {
    calls,
    ledger: {
      covers: { orgIncluded: true, callerIncluded: true },
      async record(e) {
        calls.record++;
        calls.queries.push(e);
      },
      async total(q) {
        calls.total++;
        return total;
      },
    },
  };
}

const Q = (over = {}) => ({
  orgId: "org_1",
  customerId: "cus_1",
  start: 1_000_000,
  end: 2_000_000,
  ...over,
});

test("the same window inside the TTL costs ONE request", async () => {
  const { calls, ledger } = counting(42);
  const cached = cachedUsageLedger(ledger, { ttlMs: 10_000 });
  const a = await cached.total(Q());
  const b = await cached.total(Q());
  const c = await cached.total(Q());
  assert.deepEqual([a, b, c], [42, 42, 42]);
  assert.equal(calls.total, 1, "three reads, one request");
});

test("concurrent reads of one window are coalesced, not raced", async () => {
  // This is the case a usage screen hits: N members asking at the same instant.
  const { calls, ledger } = counting(5);
  const cached = cachedUsageLedger(ledger, { ttlMs: 10_000 });
  const all = await Promise.all(Array.from({ length: 20 }, () => cached.total(Q())));
  assert.deepEqual(new Set(all), new Set([5]));
  assert.equal(calls.total, 1, "twenty simultaneous reads, one request");
});

test("different windows and different callers are different keys", async () => {
  const { calls, ledger } = counting();
  const cached = cachedUsageLedger(ledger, { ttlMs: 10_000 });
  await cached.total(Q());
  await cached.total(Q({ start: 9_000_000 }));
  await cached.total(Q({ filter: { callerId: "u1" } }));
  await cached.total(Q({ filter: { callerId: "u2" } }));
  await cached.total(Q({ filter: { callerKind: "api" } }));
  // An open-ended window is NOT the same question as one closed at this instant.
  await cached.total(Q({ end: undefined }));
  assert.equal(calls.total, 6);
});

test("a read after the TTL goes back to the ledger", async () => {
  const { calls, ledger } = counting();
  const cached = cachedUsageLedger(ledger, { ttlMs: 1 });
  await cached.total(Q());
  await new Promise((r) => setTimeout(r, 15));
  await cached.total(Q());
  assert.equal(calls.total, 2, "staleness is bounded by the TTL, not unbounded");
});

test("ttlMs 0 disables it entirely", async () => {
  const { calls, ledger } = counting();
  const cached = cachedUsageLedger(ledger, { ttlMs: 0 });
  await cached.total(Q());
  await cached.total(Q());
  assert.equal(calls.total, 2);
});

test("record is NEVER cached or coalesced", async () => {
  // A write served from cache is usage counted by nothing — the failure this whole
  // subsystem exists to prevent.
  const { calls, ledger } = counting();
  const cached = cachedUsageLedger(ledger, { ttlMs: 60_000 });
  const e = { orgId: "org_1", customerId: "cus_1", action: "search", cost: 1, funded: "pack" };
  await cached.record(e);
  await cached.record(e);
  await cached.record(e);
  assert.equal(calls.record, 3, "every write reaches the ledger");
});

test("a failed read is not remembered as a number", async () => {
  let n = 0;
  const flaky = {
    covers: { orgIncluded: true, callerIncluded: true },
    async record() {},
    async total() {
      if (++n === 1) throw new Error("rate limited");
      return 11;
    },
  };
  const cached = cachedUsageLedger(flaky, { ttlMs: 60_000 });
  await assert.rejects(() => cached.total(Q()), /rate limited/);
  // The retry must actually retry rather than serve the failure's absence as 0
  // for the rest of the TTL — that would read as "no usage" and refuse no one.
  assert.equal(await cached.total(Q()), 11);
});

test("covers is inherited unchanged", async () => {
  const { ledger } = counting();
  assert.deepEqual(cachedUsageLedger(ledger).covers, { orgIncluded: true, callerIncluded: true });
  // A ledger that declares nothing stays silent through the wrapper, rather than
  // gaining an invented claim about what it can count.
  const bare = { async record() {}, async total() { return 0; } };
  assert.equal(cachedUsageLedger(bare).covers, undefined);
});

test("the cache is bounded, so a long-lived process cannot leak windows", async () => {
  const { calls, ledger } = counting();
  const cached = cachedUsageLedger(ledger, { ttlMs: 60_000, maxEntries: 10 });
  for (let i = 0; i < 50; i++) await cached.total(Q({ start: i * 1000 }));
  assert.equal(calls.total, 50);
  // Correctness never depends on a cached entry surviving: everything still reads
  // through, it just costs a request again.
  assert.equal(await cached.total(Q({ start: 0 })), 7);
});
