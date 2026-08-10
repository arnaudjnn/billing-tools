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

// `replenish.purchase` is what registers `buy_credits` — the tool surface is
// derived from the catalogue (see toolCapabilities), so a plan with no way to be
// topped up gets no top-up tool.
const PLANS = {
  hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 1000 }, sale: "free" },
  pro: {
    sells: { kind: "flat", price: { monthly: 1800, yearly: 18000 } },
    cap: { kind: "pool", credits: 5000 },
    replenish: { purchase: {} },
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

test("topUp is accepted and reaches buy_credits", async () => {
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
    billing.dispatcher.dispatchTool("buy_credits", { amount: 50 }),
  );

  assert.equal(askedFor, "org_1", "the resolver is asked for this org");
  assert.deepEqual(calls[0]?.line_items?.[0]?.tax_rates, ["txr_iva22"]);
});

// ── The billing script's options, derived from the composition ────────────────
//
// The app's script used to restate the catalogue, the config and the ledger's
// coverage. Two of those are merely duplication; the third is the shape of the worst
// bug this library has had — a wallet-only ledger counting pooled usage as 0, so
// every subscriber got unlimited requests while every check passed. A script that
// declares its own coverage can be right while the app is wrong.
test("billing.cli carries what the doctor needs, read off the composition", async () => {
  const billing = createBilling({ adapter, config, plans: PLANS });

  assert.equal(billing.cli.plans, PLANS, "the catalogue must be the app's own object");
  assert.equal(billing.cli.config.currency, "eur");
  // The DEFAULT ledger's coverage, not a `true` asserting one exists: the boolean
  // cannot distinguish a ledger that sees org-wide included usage from one that
  // does not, which is the only distinction that mattered.
  assert.equal(typeof billing.cli.usageLedger, "object");
  assert.equal(billing.cli.usageLedger.orgIncluded, true);

  // A catalogue with the lifecycle tools on: `change_plan` opens a hosted Checkout
  // Session itself, so a self-serve plan is genuinely buyable.
  assert.equal(billing.cli.hasCheckout, true);
  // WorkOS is audited by default — it is the substrate every adapter here assumes.
  // `oauthProxy` is NOT claimed, because this composition mounts no proxy and
  // REFRESH_TOKEN_SECRET is only required when one is mounted.
  assert.equal(billing.cli.workos, true);

  // The webhook URL is absent on purpose: it is a deployment fact, and a production
  // URL sitting in this object is one a laptop run would register.
  assert.equal("webhookUrl" in billing.cli, false);
});

test("billing.cli tracks the composition rather than describing a default", async () => {
  // No catalogue → nothing to buy, so `hasCheckout` must not claim otherwise.
  const bare = createBilling({ adapter, config });
  assert.equal(bare.cli.hasCheckout, false);
  assert.equal(bare.cli.plans, undefined);

  // Lifecycle tools turned off: the app owns plan changes in its own UI, so this
  // composition mounts no checkout of its own.
  const uiOwned = createBilling({ adapter, config, plans: PLANS, subscriptionTools: false });
  assert.equal(uiOwned.cli.hasCheckout, false);

  // An explicit ledger is reported as ITS coverage, not the default's — the whole
  // point of deriving this rather than restating it.
  const { stripeUsageLedger } = await import("../dist/usage-ledger.js");
  const { stripeScopeUsageLedger } = await import("../dist/usage-scopes.js");
  const scoped = createBilling({
    adapter,
    config,
    plans: PLANS,
    meter: { ledger: stripeUsageLedger({ perCaller: stripeScopeUsageLedger() }) },
  });
  assert.equal(scoped.cli.usageLedger.callerIncluded, true);
  assert.equal(
    createBilling({ adapter, config, plans: PLANS }).cli.usageLedger.callerIncluded,
    false,
    "the default cannot count a per-member included window, and must not claim to",
  );
});

test("MPP is priced from the rate card the composition already publishes", async () => {
  // `amount` used to be required, so a consumer with a per-tool rate card wrote a function
  // reading its own cost map off the path — its own rate card, re-derived, in a second
  // place. `toolCosts` is the map `get_credit_balance` and the REST tool list already
  // serve; omitting `amount` charges what the tool being called costs.
  const billing = createBilling({
    adapter,
    config,
    plans: PLANS,
    toolCosts: { cheap_read: 0, expensive_search: 80 },
    machinePayment: { currency: "usd" },
  });

  const priceOf = async (path) =>
    (await billing.machinePayment.buildChallenges(new Request(`https://api.test${path}`)))[0].amount;

  assert.equal(await priceOf("/api/v0/expensive_search"), 80);
  // A free tool and an unknown one both fall back to 1: a challenge for 0 is a challenge
  // that means nothing, and refusing to quote is worse than quoting small.
  assert.equal(await priceOf("/api/v0/cheap_read"), 1);
  assert.equal(await priceOf("/api/v0/who_knows"), 1);

  // A flat fee stays available for a consumer that wants one price per request.
  const flat = createBilling({ adapter, config, plans: PLANS, machinePayment: { amount: 5 } });
  assert.equal(
    (await flat.machinePayment.buildChallenges(new Request("https://api.test/api/v0/x")))[0].amount,
    5,
  );
});
