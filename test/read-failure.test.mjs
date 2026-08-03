// What happens when a window cannot be READ.
//
// This is the failure that matters most at scale and the one that was least
// chosen. Measured before this policy existed: with every Stripe read
// rate-limited, a member who had spent their entire pack was reported at
// `used: 0` and allowed through — and an ORG-wide window in the same situation
// threw instead, 500-ing the request. Same cause, opposite outcomes, neither
// picked by anybody.
//
// A 429 is not an exotic condition here: Stripe allows 25 req/s per endpoint and
// every window read goes through one endpoint, so this is what a traffic spike
// looks like. The caps stop applying exactly when the account is busiest.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { stripeUsageLedger } from "../dist/usage-ledger.js";
import { onUsageFault, resetUsageFaults } from "../dist/usage-faults.js";

const Q = (over = {}) => ({
  orgId: "org_1",
  customerId: "cus_1",
  start: 1_000_000,
  end: 2_000_000,
  filter: { callerKind: "user", callerId: "u1" },
  ...over,
});

/** A leg that answers, then starts failing. */
function flaky(value) {
  const state = { fail: false, calls: 0 };
  return {
    state,
    leg: {
      covers: { orgIncluded: true, callerIncluded: true },
      async record() {},
      async total() {
        state.calls++;
        if (state.fail) {
          const e = new Error("Too many requests");
          e.statusCode = 429;
          throw e;
        }
        return value;
      },
    },
  };
}

const build = (leg, onReadFailure) =>
  stripeUsageLedger({ orgWide: leg, perCaller: leg, ...(onReadFailure ? { onReadFailure } : {}) });

beforeEach(() => resetUsageFaults());

test("by default a failed read serves the LAST KNOWN value, not 0", async () => {
  const { state, leg } = flaky(750);
  const ledger = build(leg);
  assert.equal(await ledger.total(Q()), 750);

  state.fail = true;
  // 0 here would mean "you have used nothing" — the member's whole pack handed
  // back, silently, because Stripe was busy.
  assert.equal(await ledger.total(Q()), 750, "the stale figure is bounded and sane");
});

test("with nothing known yet it falls back to 0 — the old behaviour, made explicit", async () => {
  const { state, leg } = flaky(1);
  state.fail = true;
  const ledger = build(leg);
  assert.equal(await ledger.total(Q()), 0);
});

test("last-known is per WINDOW, so one member's figure never answers another's", async () => {
  const { state, leg } = flaky(500);
  const ledger = build(leg);
  await ledger.total(Q({ filter: { callerKind: "user", callerId: "u1" } }));
  state.fail = true;
  // u2 has no remembered value; serving u1's would be worse than serving 0.
  assert.equal(await ledger.total(Q({ filter: { callerKind: "user", callerId: "u2" } })), 0);
});

test('"throw" refuses rather than guessing', async () => {
  const { state, leg } = flaky(10);
  const ledger = build(leg, "throw");
  state.fail = true;
  await assert.rejects(() => ledger.total(Q()), /Too many requests/);
});

test('"zero" is the old per-caller behaviour, opted into', async () => {
  const { state, leg } = flaky(900);
  const ledger = build(leg, "zero");
  await ledger.total(Q());
  state.fail = true;
  assert.equal(await ledger.total(Q()), 0);
});

test("an ORG-wide read degrades the same way a per-caller one does", async () => {
  // These disagreed before: the caller leg swallowed and the org leg threw.
  const { state, leg } = flaky(4_000);
  const ledger = build(leg);
  const orgQuery = Q({ filter: undefined });
  assert.equal(await ledger.total(orgQuery), 4_000);
  state.fail = true;
  assert.equal(await ledger.total(orgQuery), 4_000);
});

// ── Observability ──────────────────────────────────────────────────────────

test("every degraded read is reported on the fault channel", async () => {
  const seen = [];
  onUsageFault((f) => seen.push(f));
  const { state, leg } = flaky(300);
  const ledger = build(leg);
  await ledger.total(Q());
  state.fail = true;
  await ledger.total(Q());

  assert.equal(seen.length, 1);
  assert.equal(seen[0].operation, "read");
  assert.equal(seen[0].outcome, "used-last-known");
  assert.equal(seen[0].served, 300);
  assert.equal(seen[0].scope, "u:u1");
  assert.equal(seen[0].orgId, "org_1");
});

test("counting 0 is reported distinctly — it is the dangerous outcome", async () => {
  const seen = [];
  onUsageFault((f) => seen.push(f));
  const { state, leg } = flaky(1);
  state.fail = true;
  await build(leg).total(Q());
  assert.equal(seen[0].outcome, "counted-zero", "the caps are not applying, and that must be alertable");
});

test("a refusal is reported too, so it is not mistaken for a customer hitting a cap", async () => {
  const seen = [];
  onUsageFault((f) => seen.push(f));
  const { state, leg } = flaky(1);
  state.fail = true;
  await assert.rejects(() => build(leg, "throw").total(Q()));
  assert.equal(seen[0].outcome, "refused");
});

test("a handler that throws cannot take down the metered call it describes", async () => {
  onUsageFault(() => {
    throw new Error("the alerting pipeline is down");
  });
  const { state, leg } = flaky(5);
  state.fail = true;
  assert.equal(await build(leg).total(Q()), 0, "the call still gets an answer");
});

test("a successful read reports nothing", async () => {
  const seen = [];
  onUsageFault((f) => seen.push(f));
  const { leg } = flaky(42);
  assert.equal(await build(leg).total(Q()), 42);
  assert.deepEqual(seen, []);
});
