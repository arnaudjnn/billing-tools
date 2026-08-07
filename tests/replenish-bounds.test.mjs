// What one purchase and one grant may be — the plan's rule, not a literal in three files.
//
// The consuming app clamped the grant percentage at 500 in a server action, again at 500 in
// a number input, and the tool accepted 1000. Three answers to one question, and the one an
// agent hit was the loosest — `percent: 2500` is a typo that hands out 25× a seat, for free
// and without an invoice. Same shape for a purchase: the tool schema said 5..200 000 while
// every consumer's buy form re-declared it.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { planModel, purchaseBounds, requestBounds } from "../dist/entries/plans.js";
import { runWithResolvedOrg } from "../dist/auth.js";
import { createDispatcher } from "../dist/dispatch.js";
import { registerBillingTools } from "../dist/tools/register.js";
import { resolveConfig } from "../dist/types.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 1 } } },
    cap: { kind: "per_seat" },
    replenish: { purchase: {}, request: {} },
    sale: "self_serve",
  },
  // A plan that states its own, tighter, rules.
  team: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 5000 }, includedCredits: 2000, min: 1 } } },
    cap: { kind: "per_seat" },
    replenish: {
      purchase: { min: 20, max: 500 },
      request: { percent: 10, maxPercent: 50, presets: [10, 20], step: 10 },
    },
    sale: "self_serve",
  },
};

test("a plan that says nothing gets the library's defaults", () => {
  assert.deepEqual(purchaseBounds(planModel(PLANS, "pro")), { min: 5, max: 200_000 });
  assert.deepEqual(requestBounds(planModel(PLANS, "pro")), {
    percent: 25,
    maxPercent: 500,
    presets: [25, 50, 100],
    step: 25,
  });
});

test("a plan that states its own is believed", () => {
  assert.deepEqual(purchaseBounds(planModel(PLANS, "team")), { min: 20, max: 500 });
  assert.deepEqual(requestBounds(planModel(PLANS, "team")), {
    percent: 10,
    maxPercent: 50,
    presets: [10, 20],
    step: 10,
  });
});

test("no plan at all still answers, because a buy form has to render something", () => {
  assert.deepEqual(purchaseBounds(null), { min: 5, max: 200_000 });
  assert.equal(requestBounds(null).percent, 25);
});

// ── and the tools enforce the ORG's plan, not the widest in the catalogue ────

const onTeam = () => ({
  ...fakeAdapter({
    members: ["u1"],
    subscription: { plan: "team", status: "active", seatCounts: { standard: 2 } },
  }),
  async isAdmin() {
    return true;
  },
});

const call = (adapter, tool, args) =>
  runWithResolvedOrg("Bearer sk_test", "org_1", () =>
    createDispatcher((server) => {
      registerBillingTools(server, {
        adapter,
        config: resolveConfig({ baseUrl: "https://example.test", currency: "eur" }),
        plans: PLANS,
        installLogging: false,
        resolvePlan: async () => "team",
      });
    }).dispatchTool(tool, args),
  );

test("a grant above the plan's ceiling is refused, though the schema allowed it", async () => {
  // 500 passes the schema — `pro` allows it — and the org is on `team`, which does not.
  await assert.rejects(
    () => call(onTeam(), "grant_top_up", { member_id: "u1", percent: 500 }),
    /at most \+50%/,
  );
});

test("and one within it is not", async () => {
  const res = await call(onTeam(), "grant_top_up", { member_id: "u1", percent: 25 });
  assert.equal(res.status, "granted");
});

test("a purchase outside the plan's range is refused with the plan's numbers", async () => {
  await assert.rejects(
    () => call(onTeam(), "buy_credits", { amount: 10 }),
    /between 20 and 500/,
  );
});
