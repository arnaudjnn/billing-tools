// `createBilling` is the documented one-call mount, and it silently dropped
// three options it accepted nowhere else: `topUp` (so top-ups invoiced untaxed),
// `subscriptionTools` (so an app could not turn plan changes off), and
// `resolvePlan` (so the billing cycle fell back to the calendar even when the
// app knew better).
//
// Nothing failed — the options simply had no effect, which is the failure mode
// worth a test: an option that is accepted and ignored is worse than one that
// does not exist.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { createBilling } from "../dist/create-billing.js";

const PLANS = {
  hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", tokens: 1000 }, sale: "free" },
  pro: {
    sells: { kind: "flat", price: { monthly: 1800, yearly: 18000 } },
    cap: { kind: "pool", tokens: 5000 },
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

const config = { baseUrl: "https://app.test", currency: "eur" };

test("the one-call mount registers the lifecycle tools", () => {
  const billing = createBilling({ adapter, config, plans: PLANS });
  const names = billing.dispatcher.getToolNames();
  for (const t of ["change_plan", "preview_plan_change", "cancel_plan", "get_plan"]) {
    assert.ok(names.includes(t), `createBilling should register ${t}`);
  }
});

test("subscriptionTools: false is honoured", () => {
  const billing = createBilling({ adapter, config, plans: PLANS, subscriptionTools: false });
  const names = billing.dispatcher.getToolNames();
  assert.equal(names.includes("change_plan"), false);
  assert.ok(names.includes("list_plans"), "the catalogue stays readable");
});

test("it exposes the handlers an app mounts", () => {
  const billing = createBilling({ adapter, config, plans: PLANS });
  for (const key of ["restList", "restDispatch", "webhook"]) {
    assert.equal(typeof billing[key], "function", `${key} should be a request handler`);
  }
  // `mcp` is mcp-handler's surface (an object of per-method handlers), not a
  // bare function — a route file spreads it rather than calling it.
  assert.ok(billing.mcp && typeof billing.mcp === "object");
});

test("topUp is accepted and reaches buy_tokens", async () => {
  // The regression: it was accepted here and never forwarded, so an app that
  // configured its VAT correctly still sold untaxed top-ups.
  let askedFor = null;
  const billing = createBilling({
    adapter,
    config,
    plans: PLANS,
    topUp: {
      taxRates: (orgId) => {
        askedFor = orgId;
        return ["txr_iva22"];
      },
    },
  });

  const { __setStripeForTests } = await import("../dist/billing.js");
  const calls = [];
  __setStripeForTests({
    checkout: {
      sessions: {
        async create(params) {
          calls.push(params);
          return { id: "cs_1", url: "https://checkout.test/cs_1" };
        },
      },
    },
  });

  const { runWithAuth } = await import("../dist/auth.js");
  await runWithAuth("Bearer sk_good", () =>
    billing.dispatcher.dispatchTool("buy_tokens", { amount: 50 }),
  );

  assert.equal(askedFor, "org_1", "the resolver is asked for this org");
  assert.deepEqual(calls[0]?.line_items?.[0]?.tax_rates, ["txr_iva22"]);
});
