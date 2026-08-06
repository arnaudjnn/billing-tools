// Topping up the window that is actually refusing you — and only until it resets.
//
// A member can sit inside their monthly seat pack and still be blocked, because a tighter
// window says no first: 1 000 credits a month, 500 a week. `fundingFor` checks rate windows
// FIRST and absolutely, so raising the pack there buys nothing — measured before this
// existed: 5 000 extra granted on the pack, and the weekly window still answered
// `rate_limit_reached` with `remaining: 0`.
//
// So a top-up has to name the window. Two consequences carry the whole design:
//
//   • the SMALLEST blocked window wins, because it is the one that will refuse the next call
//   • the grant is filed under that window's own KEY, so it lasts exactly as long as the
//     window and not a moment longer — come the reset the key no longer matches, the read
//     returns 0, and the member is back on the plan's pace with nothing to clean up
//
// Only caller-scoped windows can be raised. An org-wide limit protects the product from the
// whole workspace; lifting it for one person is not an exception, it is a different plan.

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { fundingFor, resolveAllowance, topUpTargetOf } from "../dist/allowance.js";
import { planModel } from "../dist/plan-model.js";
import { grantExtraAllowance, requestExtraAllowance } from "../dist/topup.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 } } },
    cap: { kind: "per_seat", covers: "users", onExhausted: "wallet" },
    limits: {
      rate: [
        { every: "week", credits: 500, scope: "caller" },
        // A wider caller window and an ORG one, so "the tightest, and only a caller's" is
        // actually being chosen rather than falling out of there being one candidate.
        { every: "month", credits: 4000, scope: "caller" },
        { every: "day", credits: 20000, scope: "org" },
      ],
    },
    replenish: { request: {}, purchase: {} },
    sale: "self_serve",
  },
};

const config = { freeCredits: 0, currency: "eur", baseUrl: "https://x.test", internalDomains: [] };
const CALLER = { kind: "user", id: "u1", seatType: "standard" };
const SUB = { plan: "pro", status: "active" };

/** `used` per window `every`, so a scenario can say "over the week, inside the month". */
function ledgerFor(byEvery, packUsed = 0) {
  return {
    async record() {},
    async total(q) {
      // The pack read has no window filter of its own; it is the one over the cycle.
      const span = (q.end ?? Date.now()) - q.start;
      const DAY = 86_400_000;
      if (span <= 1.5 * DAY) return byEvery.day ?? 0;
      if (span <= 8 * DAY) return byEvery.week ?? 0;
      return q.filter?.callerId ? (byEvery.month ?? packUsed) : (byEvery.month ?? 0);
    },
  };
}

beforeEach(() => {
  __setStripeForTests({
    customers: {
      async retrieve() {
        return { id: "cus_1", balance: 0, currency: "eur", metadata: {} };
      },
      async *listBalanceTransactions() {},
    },
  });
});

const state = (adapter, ledger) =>
  resolveAllowance(adapter, config, { orgId: "org_1", plans: PLANS, plan: "pro", ledger, caller: CALLER });

// ── which window ─────────────────────────────────────────────────────────────

test("the tightest BLOCKED caller window is the one a top-up targets", async () => {
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  // Over the week (600/500), inside the month (600/4000).
  const s = await state(adapter, ledgerFor({ week: 600, month: 600 }));
  const target = topUpTargetOf(s);

  assert.equal(target.kind, "rate");
  assert.equal(target.every, "week", "not the month, which is not refusing anyone");
  assert.equal(target.basis, 500, "the percentage is of THIS window");
});

test("an ORG window is never offered, however blocked it is", async () => {
  // 20 000/day org-wide is the product's pace. Raising it for one member would raise it for
  // the workspace, which is a plan change, not an exception.
  const plans = { pro: { ...PLANS.pro, limits: { rate: [{ every: "day", credits: 10, scope: "org" }] } } };
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  const s = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans,
    plan: "pro",
    ledger: ledgerFor({ day: 999 }),
    caller: CALLER,
  });

  assert.equal(s.limits.find((l) => l.scope === "org")?.remaining, 0, "it IS blocked");
  assert.equal(topUpTargetOf(s), null, "and still not something a person can top up");
});

test("with nothing blocked there is nothing to target", async () => {
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  assert.equal(topUpTargetOf(await state(adapter, ledgerFor({ week: 1 }))), null);
});

// ── what a grant on that window does ─────────────────────────────────────────

test("a grant on the week actually unblocks the caller", async () => {
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  const before = await state(adapter, ledgerFor({ week: 600, month: 600 }));
  assert.equal(fundingFor(before, planModel(PLANS, "pro"), 1, CALLER).reason, "rate_limit_reached");

  const target = topUpTargetOf(before);
  const res = await grantExtraAllowance(adapter, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pro",
    memberId: "u1",
    percent: 25,
    windowKey: target.windowKey,
    basis: target.basis,
  });
  assert.equal(res.ok, true);
  assert.equal(res.granted, 125, "25% of the WEEK (500), not of the 1 000 pack");

  const after = await state(adapter, ledgerFor({ week: 600, month: 600 }));
  const week = after.limits.find((l) => l.every === "week");
  assert.equal(week.size, 625, "500 + 125");
  assert.equal(week.extra, 125);
  assert.equal(week.remaining, 25);
  assert.equal(fundingFor(after, planModel(PLANS, "pro"), 1, CALLER).ok, true, "and the call goes through");
});

test("it does NOT leak into the seat pack", async () => {
  // The two are different windows. A week's exception that quietly widened the month would
  // hand out four times what was granted.
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  const target = topUpTargetOf(await state(adapter, ledgerFor({ week: 600, month: 600 })));
  await grantExtraAllowance(adapter, {
    orgId: "org_1", plans: PLANS, plan: "pro", memberId: "u1",
    percent: 25, windowKey: target.windowKey, basis: target.basis,
  });

  const s = await state(adapter, ledgerFor({ week: 600, month: 600 }));
  assert.equal(s.pack.extra, 0, "the pack is untouched");
  assert.equal(s.pack.size, 1000);
});

// ── and it expires with the window ───────────────────────────────────────────

test("when the week rolls, the extra is gone", async () => {
  // THE requirement. The grant is filed under the window's key, so next week reads a
  // different key and finds nothing — the member is back to the plan's pace, and no job had
  // to expire anything.
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  const thisWeek = topUpTargetOf(await state(adapter, ledgerFor({ week: 600, month: 600 })));
  await grantExtraAllowance(adapter, {
    orgId: "org_1", plans: PLANS, plan: "pro", memberId: "u1",
    percent: 25, windowKey: thisWeek.windowKey, basis: thisWeek.basis,
  });

  const raised = await state(adapter, ledgerFor({ week: 600, month: 600 }));
  assert.equal(raised.limits.find((l) => l.every === "week").size, 625);

  // A fortnight on: a new window, a new key.
  const later = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pro",
    ledger: ledgerFor({ week: 0, month: 600 }),
    caller: CALLER,
    now: Date.now() + 14 * 86_400_000,
  });
  const week = later.limits.find((l) => l.every === "week");
  assert.notEqual(week.window.key, thisWeek.windowKey, "a different window");
  assert.equal(week.size, 500, "back to the plan's pace");
  assert.equal(week.extra, 0);
});

// ── the ask takes the same route ─────────────────────────────────────────────

test("a request is filed against the blocked window, so approving it lands there", async () => {
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  const target = topUpTargetOf(await state(adapter, ledgerFor({ week: 600, month: 600 })));
  const asked = await requestExtraAllowance(adapter, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pro",
    memberId: "u1",
    windowKey: target.windowKey,
    basis: target.basis,
  });

  assert.equal(asked.ok, true);
  assert.equal(asked.amount, 125, "25% of the week");
  assert.equal(asked.cycle, target.windowKey, "filed against the week, not the billing cycle");

  const { approveTopUp } = await import("../dist/topup.js");
  await approveTopUp(adapter, "org_1", asked.id);

  const after = await state(adapter, ledgerFor({ week: 600, month: 600 }));
  assert.equal(after.limits.find((l) => l.every === "week").size, 625, "approving unblocked them");
});

test("one open ask per WINDOW, so the button cannot queue duplicates", async () => {
  const adapter = fakeAdapter({ members: ["u1"], subscription: SUB });
  const target = topUpTargetOf(await state(adapter, ledgerFor({ week: 600, month: 600 })));
  const args = {
    orgId: "org_1", plans: PLANS, plan: "pro", memberId: "u1",
    windowKey: target.windowKey, basis: target.basis,
  };
  await requestExtraAllowance(adapter, args);
  const second = await requestExtraAllowance(adapter, args);

  assert.equal(second.reason, "already_pending");
});
