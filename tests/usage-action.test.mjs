// The rung, and WHO may act on it.
//
// `nextUsageAsk` answers "a bigger seat / credits / an exception / a plan change". That is
// half an answer: every act on a rung is an owner action — `change_plan`, `assign_seat_type`
// (a seat is a price), `grant_top_up` — so a member's only route is a request. Each consumer
// worked that out again in the component that draws the button, which meant an agent hitting
// the same wall over the API got the rung and no idea that buying was not its call.
//
// `roles.purchase` is the one part that is genuinely a deployment's choice, because a
// product whose members hold their own cards is a real arrangement. It moves the CREDITS
// rung and nothing else — and `buy_credits` reads the same value, which is what makes this
// answer true rather than advisory.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { planModel, usageAction } from "../dist/entries/plans.js";
import { runWithPrincipal } from "../dist/auth.js";
import { createDispatcher } from "../dist/dispatch.js";
import { registerBillingTools } from "../dist/tools/register.js";
import { resolveConfig } from "../dist/types.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  hobby: {
    sells: { kind: "nothing" },
    cap: { kind: "pool", credits: 1000 },
    replenish: { purchase: {} },
    sale: "free",
    display: { order: 1 },
  },
  pro: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 2104 }, includedCredits: 1000 },
        premium: { price: { monthly: 10523 }, includedCredits: 5000 },
      },
    },
    cap: { kind: "per_seat", onExhausted: "wallet" },
    replenish: { purchase: {}, request: {} },
    sale: "self_serve",
    display: { order: 2 },
  },
};

const pro = planModel(PLANS, "pro");
const hobby = planModel(PLANS, "hobby");
const packWall = { blocked: { kind: "pack" }, plans: PLANS, currentPlan: "pro" };

test("nothing blocked, nothing to offer", () => {
  // A control permanently on screen asks a question nobody at 40% can answer.
  assert.equal(usageAction(pro, { blocked: null, plans: PLANS, currentPlan: "pro" }), null);
});

test("a member climbs by ASKING; an admin climbs by acting", () => {
  const member = { ...packWall, seatType: "standard", actor: { isAdmin: false } };
  const admin = { ...packWall, seatType: "standard", actor: { isAdmin: true } };

  assert.deepEqual(usageAction(pro, member), {
    rung: "seat",
    to: "premium",
    actor: "self",
    action: "request_seat_change",
  });
  assert.deepEqual(usageAction(pro, admin), {
    rung: "seat",
    to: "premium",
    actor: "admin",
    action: "assign_seat_type",
  });
});

test("on the best seat, the answer is money — and who may spend it is the policy", () => {
  const onTop = { ...packWall, seatType: "premium" };

  // Default: spending the workspace's money is an owner action, so a member asks.
  assert.deepEqual(usageAction(pro, { ...onTop, actor: { isAdmin: false } }), {
    rung: "credits",
    actor: "self",
    action: "request_top_up",
  });
  assert.deepEqual(usageAction(pro, { ...onTop, actor: { isAdmin: true } }), {
    rung: "credits",
    actor: "admin",
    action: "buy_credits",
  });

  // A deployment where members hold their own cards moves this ONE rung.
  assert.deepEqual(usageAction(pro, { ...onTop, actor: { isAdmin: false }, purchase: "member" }), {
    rung: "credits",
    actor: "admin",
    action: "buy_credits",
  });
});

test("no principal is owner-level, the same reading enforceAdmin applies", () => {
  // An org API key has no user behind it: it IS the org.
  assert.equal(usageAction(pro, { ...packWall, seatType: "premium" }).action, "buy_credits");
});

test("where money cannot help, the ask is an exception and only an admin grants it", () => {
  // A `covers: "all"` window is the product's own pace; no purchase touches it.
  const paced = {
    blocked: { kind: "rate", covers: "all" },
    plans: PLANS,
    currentPlan: "pro",
    seatType: "premium",
  };
  assert.deepEqual(usageAction(pro, { ...paced, actor: { isAdmin: false } }), {
    rung: "usage",
    actor: "self",
    action: "request_top_up",
  });
  assert.deepEqual(usageAction(pro, { ...paced, actor: { isAdmin: true } }), {
    rung: "usage",
    actor: "admin",
    action: "grant_top_up",
  });
});

test("a pooled plan with nothing to buy sends the workspace up a tier", () => {
  const pooled = {
    blocked: { kind: "rate", covers: "all" },
    plans: PLANS,
    currentPlan: "hobby",
  };
  assert.deepEqual(usageAction(hobby, { ...pooled, actor: { isAdmin: false } }), {
    rung: "plan",
    to: "pro",
    actor: "self",
    action: "request_plan_change",
  });
  assert.deepEqual(usageAction(hobby, { ...pooled, actor: { isAdmin: true } }), {
    rung: "plan",
    to: "pro",
    actor: "admin",
    action: "change_plan",
  });
});

// ── and the tool enforces what the answer claims ─────────────────────────────

// `fakeAdapter` has no `isAdmin`, and an adapter that cannot answer ALLOWS — deliberately,
// so a deployment whose adapter reports no roles is not locked out of its own workspace.
// Which means a fake without one proves nothing about a gate: it has to be added.
const adminAdapter = (admins) => ({
  ...fakeAdapter({
    members: ["u_owner", "u_member"],
    subscription: { plan: "pro", status: "active", seatCounts: { standard: 2 } },
  }),
  async isAdmin(_orgId, userId) {
    return admins.includes(userId);
  },
});

function tools(adapter, roles) {
  return createDispatcher((server) => {
    registerBillingTools(server, {
      adapter,
      config: resolveConfig({ baseUrl: "https://example.test", currency: "eur", roles }),
      plans: PLANS,
      installLogging: false,
    });
  });
}

const asMember = (adapter, roles, userId = "u_member") =>
  runWithPrincipal({ authHeader: "Bearer sk_test", orgId: "org_1", principal: { userId } }, () =>
    tools(adapter, roles).dispatchTool("buy_credits", { amount: 10 }),
  );

test("buy_credits refuses a member, because the card is the workspace's", async () => {
  const adapter = adminAdapter(["u_owner"]);
  await assert.rejects(() => asMember(adapter), /Forbidden \(403\).*buy_credits/s);
});

test("…and lets one through where the deployment says members may purchase", async () => {
  const adapter = adminAdapter(["u_owner"]);
  // It gets past the gate; what it hits next is the fake Stripe key, which is the proof it
  // was not refused for being a member.
  await assert.rejects(
    () => asMember(adapter, { purchase: "member" }),
    (e) => !/Forbidden/.test(String(e)),
  );
});
