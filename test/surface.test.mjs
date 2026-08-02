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

const PLANS = {
  hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 1000 }, sale: "free" },
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000 } },
    },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
};

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

function names({ plans } = {}) {
  const d = createDispatcher((server) => {
    registerBillingTools(server, { adapter, config, plans, installLogging: false });
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

test("an unknown tool is refused by name", async () => {
  const d = createDispatcher((server) => {
    registerBillingTools(server, { adapter, config, installLogging: false });
  });
  await assert.rejects(() => d.dispatchTool("no_such_tool", {}), /Unknown tool/);
});
