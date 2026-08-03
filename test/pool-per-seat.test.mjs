// `cap.perSeat` — a pool sized by seats.
//
// The rung that was missing between a flat pool and `per_seat`. "1 000 credits per
// seat per month" is what a pricing page says; `per_seat` additionally ENFORCES it
// member by member, which is the only cap shape that needs a per-member counter to
// gate. Pooled, the same promise is ONE org-wide window — countable by a single
// Stripe meter summary at any volume, with no store anywhere.
//
// Seats are the PURCHASED quantity, not the active member count: a workspace that
// bought ten seats and filled six paid for ten.

import assert from "node:assert/strict";
import { test } from "vitest";

import { poolIsPerSeat, poolSizeOf, planModel } from "../dist/plans.js";
import { resolveAllowance, fundingFor } from "../dist/allowance.js";
import { fakeAdapter, testConfig } from "./helpers.mjs";

const PLANS = {
  team: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 0 } },
    },
    grant: { kind: "none" },
    cap: { kind: "pool", perSeat: 1000, onExhausted: "wallet" },
    sale: "self_serve",
  },
  flat: {
    sells: { kind: "flat", price: { monthly: 9900, yearly: 99000 } },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 5000 },
    sale: "self_serve",
  },
};

const model = (key) => planModel(PLANS, key);
const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const SUB = (seats) => ({
  plan: "team",
  status: "active",
  periodStart: "2026-08-14T09:00:00.000Z",
  periodEnd: "2026-09-14T09:00:00.000Z",
  seats,
});

// A ledger that reports a fixed total, so these assert the SIZE arithmetic rather
// than any store's behaviour.
const ledgerWith = (used) => ({ async record() {}, async total() { return used; } });

test("the pool is perSeat x seats", () => {
  assert.equal(poolIsPerSeat(model("team")), true);
  assert.equal(poolSizeOf(model("team"), 1), 1000);
  assert.equal(poolSizeOf(model("team"), 7), 7000);
  assert.equal(poolSizeOf(model("team"), 100), 100_000);
});

test("a flat pool ignores seats, and is not perSeat", () => {
  assert.equal(poolIsPerSeat(model("flat")), false);
  assert.equal(poolSizeOf(model("flat"), 50), 5000);
});

test("a missing seat count under-reports rather than over-granting", () => {
  // A caller that forgets to resolve seats gets the per-seat UNIT — which is also
  // what a pricing surface wants to display. Failing small is the safe direction:
  // an over-sized pool would hand out allowance nobody paid for.
  assert.equal(poolSizeOf(model("team")), 1000);
  assert.equal(poolSizeOf(model("team"), 0), 1000);
});

test("resolveAllowance sizes the pool from the PURCHASED quantity", async () => {
  const adapter = fakeAdapter({ subscription: SUB(7), members: ["u1", "u2"] });
  const state = await resolveAllowance(adapter, testConfig, {
    orgId: "org_1",
    plans: PLANS,
    plan: "team",
    customerId: "cus_test",
    skipWallet: true,
    skipSpendLimit: true,
    ledger: ledgerWith(0),
    now: NOW,
  });
  // 7 purchased, NOT the 2 active members: they paid for seven.
  assert.equal(state.pool.size, 7000);
  assert.equal(state.pool.remaining, 7000);
});

test("with no purchased quantity it falls back to active members", async () => {
  const adapter = fakeAdapter({
    subscription: SUB(null),
    members: ["u1", "u2", "u3"],
  });
  const state = await resolveAllowance(adapter, testConfig, {
    orgId: "org_1",
    plans: PLANS,
    plan: "team",
    customerId: "cus_test",
    skipWallet: true,
    skipSpendLimit: true,
    ledger: ledgerWith(0),
    now: NOW,
  });
  assert.equal(state.pool.size, 3000);
});

test("the pool is org-wide, so any caller draws the same window", async () => {
  // The point of pooling: one window, so the read needs no caller filter and can
  // be answered by a single meter summary.
  const adapter = fakeAdapter({ subscription: SUB(5) });
  const read = (caller) =>
    resolveAllowance(adapter, testConfig, {
      orgId: "org_1",
      plans: PLANS,
      plan: "team",
      caller,
      customerId: "cus_test",
      skipWallet: true,
      skipSpendLimit: true,
      ledger: ledgerWith(1200),
      now: NOW,
    });

  for (const caller of [
    { kind: "user", id: "u1", seatType: "standard" },
    { kind: "user", id: "u2", seatType: "standard" },
    { kind: "api", id: "key_1", seatType: "api" },
  ]) {
    const state = await read(caller);
    assert.equal(state.pool.size, 5000);
    assert.equal(state.pool.used, 1200);
    // No per-seat pack: there is nothing per-member to count.
    assert.equal(state.pack, null);
  }
});

test("an exhausted pooled window overflows to the wallet when told to", async () => {
  const adapter = fakeAdapter({ subscription: SUB(2) });
  const state = await resolveAllowance(adapter, testConfig, {
    orgId: "org_1",
    plans: PLANS,
    plan: "team",
    caller: { kind: "user", id: "u1", seatType: "standard" },
    customerId: "cus_test",
    skipWallet: true,
    skipSpendLimit: true,
    ledger: ledgerWith(2000), // the whole 2 x 1000
    now: NOW,
  });
  assert.equal(state.pool.remaining, 0);

  const decision = fundingFor({ ...state, wallet: 500 }, model("team"), 10, {
    kind: "user",
    seatType: "standard",
  });
  assert.deepEqual(decision, { ok: true, source: "wallet" });
});

test("no seat read at all for a plan that does not size by seat", async () => {
  // The extra member-count call must not land on every other plan shape's hot path.
  const adapter = fakeAdapter({ subscription: { ...SUB(3), plan: "flat" } });
  let counted = 0;
  adapter.memberCount = async () => {
    counted++;
    return 3;
  };
  await resolveAllowance(adapter, testConfig, {
    orgId: "org_1",
    plans: PLANS,
    plan: "flat",
    customerId: "cus_test",
    skipWallet: true,
    skipSpendLimit: true,
    ledger: ledgerWith(0),
    now: NOW,
  });
  assert.equal(counted, 0);
});
