// `setupBilling()` — provision + verify one Stripe environment in one call.
//
// What it is FOR is the handful of things that cannot provision themselves on a
// request: the webhook signing secret (Stripe returns it once, at creation, and no
// request can write it into your env store) and tax registrations (only a human
// knows where the business collects). Everything else is lazy already, so the value
// here is a deploy log that says what happened instead of a customer's first
// request discovering it.
//
// These pin the ORCHESTRATION — what runs, what is skipped, and that a failing step
// never stops the others — because that is the part with judgement in it.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { setupBilling, formatSetupReport } from "../dist/setup.js";
import { invalidateMeters } from "../dist/usage-ledger.js";
import { invalidatePlanPrices } from "../dist/plans.js";

const CONFIG = { baseUrl: "https://t.local", currency: "eur", tax: { origin: "IT" } };

const PLANS = {
  pro: {
    sells: { kind: "flat", price: { monthly: 5000, yearly: 50000 } },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 1000, onExhausted: "wallet" },
    replenish: { purchase: true },
    sale: "self_serve",
  },
};

const page = (data) => ({
  data,
  [Symbol.asyncIterator]: async function* () {
    yield* data;
  },
});

/** An account with nothing provisioned yet. Each stub records what it was asked. */
function fakeStripe(overrides = {}) {
  const calls = { meters: [], webhooks: [], prices: [], products: [] };
  const base = {
    calls,
    accounts: { async retrieve() { return { id: "acct_1", country: "IT" }; } },
    billing: {
      meters: {
        list: () => page([]),
        async create(params) {
          calls.meters.push(params);
          return { id: "mtr_1", event_name: params.event_name };
        },
      },
    },
    prices: {
      list: () => page([]),
      async create(params) {
        calls.prices.push(params);
        return { id: `price_${calls.prices.length}`, ...params };
      },
      async update() {},
    },
    products: {
      list: () => page([]),
      async create(params) {
        calls.products.push(params);
        return { id: "prod_1", ...params };
      },
      async update() {},
    },
    webhookEndpoints: {
      async list() { return { data: [] }; },
      async create(params) {
        calls.webhooks.push(params);
        return { id: "we_1", url: params.url, secret: "whsec_fresh", enabled_events: params.enabled_events };
      },
    },
    taxRates: { async list() { return { data: [] }; } },
    customers: { list: () => page([]) },
    subscriptions: { list: () => page([]) },
    invoices: { list: () => page([]) },
  };
  return { ...base, ...overrides };
}

const run = async (opts, stripe = fakeStripe()) => {
  invalidateMeters();
  invalidatePlanPrices();
  __setStripeForTests(stripe);
  return { result: await setupBilling({ config: CONFIG, ...opts }), stripe };
};

const step = (r, name) => r.steps.find((s) => s.step === name);

test("it provisions the meter and reports the environment it touched", async () => {
  const { result, stripe } = await run({});
  assert.equal(step(result, "meter").level, "ok");
  assert.equal(stripe.calls.meters.length, 1);
  assert.equal(stripe.calls.meters[0].default_aggregation.formula, "sum");
  assert.equal(result.livemode, false, "sk_test_ is test mode");
});

test("the webhook secret is surfaced, once, because Stripe never shows it again", async () => {
  const { result } = await run({ webhookUrl: "https://t.local/api/stripe/webhook" });
  assert.equal(step(result, "webhook").level, "ok");
  assert.equal(result.webhookSecret, "whsec_fresh");
  // And the report must make it impossible to miss — it is unrecoverable.
  const text = formatSetupReport(result);
  assert.match(text, /STRIPE_WEBHOOK_SECRET=whsec_fresh/);
  assert.match(text, /ONCE/);
});

test("no webhookUrl is a SKIP, not a pass, and says what to use instead", async () => {
  const { result } = await run({});
  const s = step(result, "webhook");
  assert.equal(s.skipped, true);
  assert.match(s.detail, /stripe listen|reconcilePayments/);
  // A skipped step must not read as a tick in the report.
  assert.match(formatSetupReport(result), /– Webhook endpoint/);
  assert.equal(result.webhookSecret, undefined);
});

test("plans are reconciled when passed, and named in the report", async () => {
  const { result, stripe } = await run({ plans: PLANS });
  assert.equal(step(result, "plans").level, "ok");
  assert.match(step(result, "plans").detail, /pro_monthly/);
  assert.equal(stripe.calls.prices.length, 2, "monthly + yearly");
  assert.equal(stripe.calls.prices[0].currency, "eur", "the currency comes from config");
});

test("Stripe Tax is skipped for a billing-tools account, rather than configured", async () => {
  // Running it would create registrations the account doesn't need and is billed
  // against, so the mode decides — and it comes from the same `config.tax` the
  // charges read.
  const { result } = await run({ plans: PLANS });
  const s = step(result, "tax");
  assert.equal(s.skipped, true);
  assert.match(s.detail, /billing-tools/);
});

test('mode "stripe" with no registrations passed is a WARNING, not silence', async () => {
  // With no active registration Stripe Tax computes ZERO tax and reports nothing,
  // so a setup run that skipped it quietly would be the wrong kind of quiet.
  const stripe = fakeStripe({
    tax: {
      settings: { async retrieve() { return { status: "active" }; } },
      registrations: { async list() { return { data: [] }; } },
    },
  });
  invalidateMeters();
  invalidatePlanPrices();
  __setStripeForTests(stripe);
  const result = await setupBilling({
    config: { ...CONFIG, tax: { mode: "stripe" } },
  });
  const s = step(result, "tax");
  assert.equal(s.level, "warn");
  assert.match(s.fix, /ZERO tax/);
});

test("one failing step doesn't stop the others, and the run is not healthy", async () => {
  const stripe = fakeStripe();
  stripe.billing.meters.create = async () => {
    throw new Error("permission denied");
  };
  const { result } = await run({ webhookUrl: "https://t.local/api/stripe/webhook" }, stripe);
  assert.equal(step(result, "meter").level, "error");
  assert.match(step(result, "meter").detail, /permission denied/);
  // The webhook still got registered — a report of four outcomes beats the first
  // exception.
  assert.equal(step(result, "webhook").level, "ok");
  assert.equal(result.webhookSecret, "whsec_fresh");
  assert.equal(result.healthy, false);
});

test("the doctor runs last, so it sees what was just provisioned", async () => {
  const { result } = await run({ plans: PLANS, webhookUrl: "https://t.local/api/stripe/webhook" });
  // Same renderer as `billing-tools doctor`, so the two can't drift.
  assert.ok(result.doctor.checks.length > 0);
  assert.ok(result.doctor.checks.some((c) => c.title === "Stripe account"));
  assert.ok(result.doctor.checks.some((c) => c.title === "Plans config" || c.title === "Usage ledger"));
});
