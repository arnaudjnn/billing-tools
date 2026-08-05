// The parity guarantee: whatever the app's own UI can do, an API / CLI / MCP
// caller can do too. REST and MCP get that structurally — `createDispatcher`
// captures every registered tool — so what this asserts is that the tools which
// SHOULD exist are actually registered, and that the list advertised in
// BILLING_TOOL_NAMES matches what registration really produces.
//
// The gap this was written for: plan changes, payment methods, the billing
// profile and the tax id were reachable only from the frontend.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { createDispatcher } from "../dist/dispatch.js";
import { BILLING_TOOL_NAMES, registerBillingTools } from "../dist/tools/register.js";

// A catalogue that declares every axis, so BILLING_TOOL_NAMES has something that
// can produce all of it. Note `replenish` on both plans: without it the top-up and
// auto-reload tools are (correctly) not registered, which is the point of the two
// app-shaped catalogues below.
const PLANS = {
  hobby: {
    sells: { kind: "nothing" },
    cap: { kind: "pool", credits: 1000 },
    replenish: { purchase: {}, autoReload: { threshold: 100, reloadTo: 1000 } },
    sale: "free",
  },
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000 } },
    },
    cap: { kind: "per_seat" },
    replenish: { purchase: {}, autoReload: { threshold: 500, reloadTo: 5000 }, request: {} },
    sale: "self_serve",
  },
};

// The two real consumers, reduced to the axes that decide the tool surface. These
// are what the derivation is FOR: gtm-tools sells a flat plan with an org-wide
// pool and no request flow, so seven of the tools it used to register could only
// ever answer "not applicable here".
const GTM_TOOLS = {
  hobby: {
    sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 1000, onExhausted: "wallet" },
    replenish: { purchase: { packs: [500] }, autoReload: { threshold: 200, reloadTo: 2000 } },
    limits: { members: 1 },
    sale: "self_serve",
  },
};

const SCARTOFFIE = {
  hobby: {
    sells: { kind: "nothing" },
    cap: { kind: "pool", credits: 1000, window: "month", covers: "users", onExhausted: "wallet" },
    replenish: { purchase: {} },
    limits: { members: 1, rate: [{ every: "week", credits: 400 }] },
    sale: "free",
  },
  pro: {
    sells: {
      kind: "seats",
      minSeats: 2,
      seatTypes: { standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000 } },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat", window: "month", covers: "users", onExhausted: "wallet" },
    replenish: { request: {}, purchase: {}, autoReload: { threshold: 500, reloadTo: 5000 } },
    limits: { members: 100 },
    sale: "self_serve",
  },
};

const SEAT_TOOLS = ["list_seats", "assign_seat_type"];
const TOP_UP_TOOLS = [
  "list_top_up_requests",
  "request_top_up",
  "approve_top_up",
  "grant_top_up",
  "deny_top_up",
];

const adapter = {
  async validateApiKey() {
    return { orgId: "org_1" };
  },
  async getOrgDomains() {
    return [];
  },
  async getBillingCustomerId() {
    return "cus_1";
  },
  async setBillingCustomerId() {},
  async ensureOrgForUser() {
    return { orgId: "org_1" };
  },
  async mintApiKey() {
    return { id: "k", value: "sk" };
  },
  async listApiKeys() {
    return [];
  },
  async revokeApiKey() {
    return null;
  },
  async getOrgMetadata() {
    return {};
  },
  async setOrgMetadata() {},
};

const config = { baseUrl: "https://example.test", currency: "eur" };

function names({ plans, ...rest } = {}) {
  const d = createDispatcher((server) => {
    registerBillingTools(server, { adapter, config, plans, installLogging: false, ...rest });
  });
  return new Set(d.getToolNames());
}

test("every capability the billing UI has is also a tool", () => {
  const tools = names({ plans: PLANS });
  for (const expected of [
    // The gap, closed.
    "change_plan",
    "preview_plan_change",
    "cancel_plan",
    "get_plan",
    "get_billing_profile",
    "set_billing_profile",
    "set_tax_id",
    "list_payment_methods",
    "set_default_payment_method",
    "remove_payment_method",
    // Still there.
    "get_credit_balance",
    "buy_credits",
    "set_auto_reload",
    "list_invoices",
    "get_billing_portal",
    "get_usage",
    "get_usage_limits",
    "list_seats",
    "assign_seat_type",
    "request_top_up",
    "approve_top_up",
    "list_plans",
  ]) {
    assert.ok(tools.has(expected), `missing tool: ${expected}`);
  }
});

test("BILLING_TOOL_NAMES matches what registration produces", () => {
  // The list is published, and a stale one sends an agent looking for a tool
  // that isn't there — or hides one that is.
  const tools = names({ plans: PLANS });
  for (const advertised of BILLING_TOOL_NAMES) {
    assert.ok(tools.has(advertised), `advertised but not registered: ${advertised}`);
  }

  // The other direction, which was missing — and `list_plans` had been registered
  // but unadvertised the whole time because of it. "Hides one that is" was the
  // half this test did not check.
  const unadvertised = [...tools].filter((n) => !BILLING_TOOL_NAMES.includes(n));
  assert.deepEqual(unadvertised, [], "registered but not advertised");
  assert.equal(tools.size, BILLING_TOOL_NAMES.length, "the list IS the full surface");
});

test("lifecycle tools need plans; the rest do not", () => {
  const withoutPlans = names();
  assert.equal(withoutPlans.has("change_plan"), false, "nothing to change between with no catalogue");
  assert.equal(withoutPlans.has("list_plans"), false);
  // Billing-account tools only need a Stripe customer.
  assert.ok(withoutPlans.has("get_billing_profile"));
  assert.ok(withoutPlans.has("list_payment_methods"));
});

test("plan changes can be left to the app", () => {
  const d = createDispatcher((server) => {
    registerBillingTools(server, {
      adapter,
      config,
      plans: PLANS,
      subscriptionTools: false,
      installLogging: false,
    });
  });
  const tools = new Set(d.getToolNames());
  assert.equal(tools.has("change_plan"), false);
  assert.ok(tools.has("list_plans"), "the catalogue is still readable");
});

// ── The surface is DERIVED from the catalogue ────────────────────────────────
//
// Every tool below was registered unconditionally before, so an app got tools its
// own plans could never satisfy: `list_seats` answering `seat_types: []`,
// `assign_seat_type` refusing with "(none configured)", and an approval flow for
// an allowance the plan does not grant. An agent cannot tell a tool that always
// fails from one it is holding wrong — so a dead tool is a false statement about
// the product, not just wasted context.

test("gtm-tools' shape drops the seat and top-up groups", () => {
  const tools = names({ plans: GTM_TOOLS });
  for (const gone of [...SEAT_TOOLS, ...TOP_UP_TOOLS]) {
    assert.equal(tools.has(gone), false, `${gone} needs a plan that declares it`);
  }
  // What it DOES sell is all still there.
  for (const kept of [
    "buy_credits",
    "preview_credit_purchase",
    "set_auto_reload",
    "get_usage",
    "get_usage_limits",
    "list_plans",
    "get_plan",
    "change_plan",
    "list_invoices",
    "get_billing_portal",
  ]) {
    assert.ok(tools.has(kept), `missing tool: ${kept}`);
  }
});

test("scartoffie's shape keeps them, because a plan declares them", () => {
  const tools = names({ plans: SCARTOFFIE });
  for (const kept of [...SEAT_TOOLS, ...TOP_UP_TOOLS]) {
    assert.ok(tools.has(kept), `missing tool: ${kept}`);
  }
  // It declares every axis, so it gets the whole surface — the figure AGENTS.md
  // quotes beside gtm-tools' 24.
  assert.equal(tools.size, BILLING_TOOL_NAMES.length);
});

test("the two shapes differ by exactly the seven tools", () => {
  const gtm = names({ plans: GTM_TOOLS });
  const scart = names({ plans: SCARTOFFIE });
  const extra = [...scart].filter((n) => !gtm.has(n)).sort();
  assert.deepEqual(extra, [...SEAT_TOOLS, ...TOP_UP_TOOLS].sort());
  // 33 − 7. Both numbers are quoted in AGENTS.md, so both are asserted here.
  assert.equal(gtm.size, 26);
  assert.equal(scart.size, 33);
});

test("no catalogue means no declaration to read, so every group registers", () => {
  // `undefined` is "the caller did not say", never "nothing applies" — inventing a
  // `false` here would silently delete tools from a working deployment.
  const tools = names();
  for (const kept of ["buy_credits", "set_auto_reload", ...SEAT_TOOLS, ...TOP_UP_TOOLS]) {
    assert.ok(tools.has(kept), `missing tool: ${kept}`);
  }
});

test("the spend ceiling is reachable on every catalogue, and with none", () => {
  // It FUNDS nothing and only refuses, so it needs no `replenish` and no plan: a
  // free workspace caps its own consumption exactly like a subscribed one. This was
  // UI-only until the audit — a capability that existed as a library function and a
  // billing screen and nothing else, which is the gap the parity rule exists for.
  for (const plans of [undefined, GTM_TOOLS, SCARTOFFIE, {
    free: { sells: { kind: "nothing" }, cap: { kind: "wallet" }, sale: "free" },
  }]) {
    const tools = names({ plans });
    assert.ok(tools.has("get_spend_controls"), "the ceiling must always be readable");
    assert.ok(tools.has("set_spend_controls"), "and always settable");
  }
});

test("a plan with no replenish sells no top-ups", () => {
  const tools = names({
    plans: { solo: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 100 }, sale: "free" } },
  });
  for (const gone of ["buy_credits", "preview_credit_purchase", "set_auto_reload"]) {
    assert.equal(tools.has(gone), false, `${gone} has no way to be paid for`);
  }
  assert.ok(tools.has("get_credit_balance"), "the balance is still readable");
});

test("an explicit capability wins over the derivation", () => {
  // The escape hatch: a group the app wants registered for a plan it has not
  // shipped yet, or withheld because its own UI owns the flow.
  const forced = names({ plans: GTM_TOOLS, capabilities: { request: true } });
  for (const kept of TOP_UP_TOOLS) assert.ok(forced.has(kept), `missing tool: ${kept}`);

  const withheld = names({ plans: SCARTOFFIE, capabilities: { seats: false } });
  for (const gone of SEAT_TOOLS) assert.equal(withheld.has(gone), false);
});

test("a quote-only catalogue can still be read, but not changed", () => {
  const tools = names({
    plans: {
      enterprise: {
        sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1800, yearly: 21600 } } } },
        cap: { kind: "wallet" },
        limits: { rate: [{ every: "week", credits: 200000 }] },
        sale: "quote",
      },
    },
  });
  assert.equal(tools.has("change_plan"), false, "no plan a customer can move to alone");
  assert.equal(tools.has("cancel_plan"), false);
  assert.ok(tools.has("list_plans"), "what is on offer is still answerable");
  assert.ok(tools.has("get_plan"), "and so is what this workspace is on");
  // `cap: wallet` includes nothing, but the weekly rate limit is still a window —
  // and it is the one refusal a caller can wait out, so it has to be reportable.
  assert.ok(tools.has("get_usage_limits"));
});

test("every advertised tool is reachable from some catalogue", () => {
  // The other direction from the test above: BILLING_TOOL_NAMES is what the library
  // says it CAN register, so a name in it that no config can produce is a promise
  // with no implementation behind it.
  const reachable = new Set([
    ...names({ plans: PLANS }),
    ...names({ plans: SCARTOFFIE }),
    ...names(),
  ]);
  for (const advertised of BILLING_TOOL_NAMES) {
    assert.ok(reachable.has(advertised), `advertised but unreachable: ${advertised}`);
  }
});

test("an unknown tool is refused by name", async () => {
  const d = createDispatcher((server) => {
    registerBillingTools(server, { adapter, config, installLogging: false });
  });
  await assert.rejects(() => d.dispatchTool("no_such_tool", {}), /Unknown tool/);
});
