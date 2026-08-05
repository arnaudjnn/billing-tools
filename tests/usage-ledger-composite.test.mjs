// `stripeUsageLedger()` — route each read to the store that can answer it.
//
// Which Stripe ledger is wrong depends on the QUERY, not on the config:
//
//   org-wide window   → the meter (sees included usage; one request at any width)
//   per-caller window → balance transactions (carry the caller; wallet-funded only)
//
// So the composite dispatches on the presence of a caller filter. That is what
// lets a config whose windows are all org-scoped run with no database: a pool or a
// `scope: "org"` limit is counted in Stripe at any volume.

import assert from "node:assert/strict";
import { test } from "vitest";

import { stripeUsageLedger } from "../dist/usage-ledger.js";

/** A recording stand-in, so these assert the ROUTING rather than Stripe. */
function spyLedger(total) {
  const calls = { record: [], total: [] };
  return {
    calls,
    async record(e) {
      calls.record.push(e);
    },
    async total(q) {
      calls.total.push(q);
      return total;
    },
  };
}

/** The real composite with both legs injected, so the routing under test is the
 *  library's and no Stripe key is needed. */
const composite = ({ meter, perCaller }) => stripeUsageLedger({ orgWide: meter, perCaller });

const EVENT = {
  orgId: "org_1",
  customerId: "cus_1",
  action: "search",
  cost: 5,
  funded: "pool",
  caller: { kind: "user", id: "u1" },
};
const WINDOW = { orgId: "org_1", customerId: "cus_1", start: 1_000_000, end: 2_000_000 };

test("an org-wide read goes to the meter, not the balance ledger", async () => {
  const meter = spyLedger(700);
  const perCaller = spyLedger(1);
  const ledger = composite({ meter, perCaller });

  assert.equal(await ledger.total(WINDOW), 700);
  assert.equal(meter.calls.total.length, 1);
  assert.equal(perCaller.calls.total.length, 0);
});

test("a per-caller read goes to the per-caller leg", async () => {
  const meter = spyLedger(700);
  const perCaller = spyLedger(42);
  const ledger = composite({ meter, perCaller });

  // Either half of a caller filter is enough to make it a per-caller question.
  assert.equal(await ledger.total({ ...WINDOW, filter: { callerKind: "api" } }), 42);
  assert.equal(
    await ledger.total({ ...WINDOW, filter: { callerKind: "user", callerId: "u1" } }),
    42,
  );
  assert.equal(await ledger.total({ ...WINDOW, filter: { callerId: "u1" } }), 42);
  assert.equal(perCaller.calls.total.length, 3);
  assert.equal(meter.calls.total.length, 0);
});

test("an empty filter object is still an org-wide question", async () => {
  // `filter: {}` reaches here from a limit with no caller narrowing, and must not
  // be mistaken for a per-caller read — that would silently answer an org window
  // from a store that only sees wallet-funded calls.
  const meter = spyLedger(700);
  const perCaller = spyLedger(42);
  const ledger = composite({ meter, perCaller });

  assert.equal(await ledger.total({ ...WINDOW, filter: {} }), 700);
  assert.equal(meter.calls.total.length, 1);
});

test("record reaches both legs", async () => {
  // The meter so org-wide windows see the call; the per-caller leg because when it
  // is a store, that IS the write. For the balance ledger it is a no-op.
  const meter = spyLedger(0);
  const perCaller = spyLedger(0);
  const ledger = composite({ meter, perCaller });

  await ledger.record(EVENT);
  assert.deepEqual(meter.calls.record, [EVENT]);
  assert.deepEqual(perCaller.calls.record, [EVENT]);
});

test("the per-caller leg is swappable, and defaults to the balance ledger", async () => {
  // The default has to be a real ledger rather than undefined, or a per-caller
  // window would throw instead of reading 0.
  const plain = stripeUsageLedger();
  assert.equal(typeof plain.total, "function");
  assert.equal(typeof plain.record, "function");

  const store = spyLedger(99);
  const withStore = stripeUsageLedger({ perCaller: store });
  assert.equal(await withStore.total({ ...WINDOW, filter: { callerId: "u1" } }), 99);
  assert.deepEqual(store.calls.total[0].filter, { callerId: "u1" });
});
