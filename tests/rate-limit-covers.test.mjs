// What a rate limit GOVERNS — the product's pace, or the plan's giveaway.
//
// They were one thing, and absolute: no wallet fallthrough, because "a limit a top-up could
// lift is not a limit". That is right for "600 an hour" against an agent, where what is being
// protected is the infrastructure. It is wrong for "500 a week each" on a plan whose pricing
// card says pay-as-you-go: a workspace that has ALREADY BOUGHT credits sat refused for three
// days, which is not what pay-as-you-go means, and no amount of paying could change it.
//
// Claude's own weekly limit is the second shape — included usage stops, purchased usage
// credits carry on — and it is the shape scartoffie's card describes. So a limit now says
// which it is. `all` is the default, so nothing changes for a limit that does not declare.

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { fundingFor, resolveAllowance } from "../dist/allowance.js";
import { planModel } from "../dist/plan-model.js";
import { fakeAdapter } from "./helpers.mjs";

const seatTypes = { standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 } };
const base = {
  sells: { kind: "seats", seatTypes },
  cap: { kind: "per_seat", window: "month", covers: "users", onExhausted: "wallet" },
  replenish: { purchase: {} },
  sale: "self_serve",
};

const PLANS = {
  // The pace of the PRODUCT: nothing lifts it.
  hard: { ...base, limits: { rate: [{ every: "week", credits: 500, scope: "caller", covers: "all" }] } },
  // The pace of the ALLOWANCE: paid usage continues past it.
  paced: { ...base, limits: { rate: [{ every: "week", credits: 500, scope: "caller", covers: "included" }] } },
  // No declaration at all — must behave exactly like `hard`.
  legacy: { ...base, limits: { rate: [{ every: "week", credits: 500, scope: "caller" }] } },
};

const config = { freeCredits: 0, currency: "eur", baseUrl: "https://x.test", internalDomains: [] };
const CALLER = { kind: "user", id: "u1", seatType: "standard" };

/** A ledger that reports `used` for the weekly window, and remembers what it was ASKED for. */
function ledger(used, seen = []) {
  return {
    seen,
    async record() {},
    async total(q) {
      seen.push(q);
      const span = (q.end ?? Date.now()) - q.start;
      return span <= 8 * 86_400_000 ? used : 0;
    },
  };
}

function stripeWith(walletCredits) {
  __setStripeForTests({
    customers: {
      async retrieve() {
        // A negative Stripe balance IS credit.
        return { id: "cus_1", balance: -walletCredits, currency: "eur", metadata: {} };
      },
      async *listBalanceTransactions() {},
    },
  });
}

const decide = async (planKey, { used, wallet }) => {
  stripeWith(wallet);
  const adapter = fakeAdapter({ members: ["u1"], subscription: { plan: planKey, status: "active" } });
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: planKey,
    ledger: ledger(used),
    caller: CALLER,
  });
  return { state, decision: fundingFor(state, planModel(PLANS, planKey), 1, CALLER) };
};

beforeEach(() => stripeWith(0));

// ── the product's pace ───────────────────────────────────────────────────────

test("covers: all refuses even with a full wallet — money cannot buy pace", async () => {
  const { decision } = await decide("hard", { used: 600, wallet: 100_000 });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "rate_limit_reached");
});

test("and a limit that declares nothing behaves the same, so nothing changed under anyone", async () => {
  const { decision } = await decide("legacy", { used: 600, wallet: 100_000 });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "rate_limit_reached");
});

// ── the allowance's pace ─────────────────────────────────────────────────────

test("covers: included stops the allowance but lets a paid call through", async () => {
  // The case that prompted this: pack has room, week is spent, wallet has credit. Under the
  // old rule the customer waited three days with credits already bought.
  const { state, decision } = await decide("paced", { used: 600, wallet: 100_000 });

  assert.equal(state.limits.find((l) => l.every === "week").remaining, 0, "the window IS spent");
  assert.equal(decision.ok, true);
  assert.equal(decision.source, "wallet", "and the customer pays for it, as the card says");
});

test("with nothing to pay with, it still refuses — as a RATE limit, not an empty wallet", async () => {
  // The reason has to stay honest: "buy credits" is the right advice here, but the window is
  // why they stopped, and a caller told only "insufficient balance" would not know the week
  // is also spent.
  const { decision } = await decide("paced", { used: 600, wallet: 0 });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "rate_limit_reached");
});

test("inside the window it funds from the INCLUDED allowance, not the wallet", async () => {
  const { decision } = await decide("paced", { used: 10, wallet: 100_000 });
  assert.equal(decision.ok, true);
  assert.equal(decision.source, "pack", "paying while you still have allowance would be theft");
});

// ── what the window counts ───────────────────────────────────────────────────

test("an included window counts only included usage, so paying does not fill it", async () => {
  // Otherwise the customer buys their way past the window and the purchase itself consumes
  // the window that stopped governing them — they would be refused again immediately.
  const seen = [];
  stripeWith(100_000);
  const adapter = fakeAdapter({ members: ["u1"], subscription: { plan: "paced", status: "active" } });
  await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: "paced",
    ledger: ledger(600, seen),
    caller: CALLER,
  });

  const weekly = seen.find((q) => (q.end ?? Date.now()) - q.start <= 8 * 86_400_000);
  assert.deepEqual(weekly.sources, { included: true, wallet: false });
});

test("a covers: all window still counts both, because it governs both", async () => {
  const seen = [];
  stripeWith(100_000);
  const adapter = fakeAdapter({ members: ["u1"], subscription: { plan: "hard", status: "active" } });
  await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: "hard",
    ledger: ledger(600, seen),
    caller: CALLER,
  });

  const weekly = seen.find((q) => (q.end ?? Date.now()) - q.start <= 8 * 86_400_000);
  assert.equal(weekly.sources.wallet, true);
});

// ── it is still a window a person can be given an exception on ───────────────

test("an admin exception works on an included window too", async () => {
  // The two answers are different and both stay available: pay past it (the customer's
  // money) or be granted more of it (the owner's decision).
  const { grantExtraAllowance } = await import("../dist/topup.js");
  const { topUpTargetOf } = await import("../dist/allowance.js");
  stripeWith(0);
  const adapter = fakeAdapter({ members: ["u1"], subscription: { plan: "paced", status: "active" } });
  const before = await resolveAllowance(adapter, config, {
    orgId: "org_1", plans: PLANS, plan: "paced", ledger: ledger(600), caller: CALLER,
  });
  const target = topUpTargetOf(before);
  assert.equal(target.every, "week");

  await grantExtraAllowance(adapter, {
    orgId: "org_1", plans: PLANS, plan: "paced", memberId: "u1",
    percent: 25, windowKey: target.windowKey, basis: target.basis,
  });

  const after = await resolveAllowance(adapter, config, {
    orgId: "org_1", plans: PLANS, plan: "paced", ledger: ledger(600), caller: CALLER,
  });
  assert.equal(after.limits.find((l) => l.every === "week").size, 625);
  assert.equal(fundingFor(after, planModel(PLANS, "paced"), 1, CALLER).source, "pack");
});
