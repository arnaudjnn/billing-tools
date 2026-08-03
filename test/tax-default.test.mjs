// Who calculates tax, when the caller says nothing.
//
// It used to be Stripe Tax, inferred from the absence of `taxRates`. That default
// is the expensive one to get wrong: Stripe Tax with no active registration
// returns ZERO tax rather than an error, so the total silently drops to the
// pre-tax amount and the seller owes the difference — and the account it happens
// on is exactly the one that never opted into Stripe Tax and so never registered.
//
// The library ships its own calculation (`taxRatesFor` — sales-tax + VIES, applied
// as an explicit Stripe TaxRate), so the default is now "nobody unless asked":
// an untaxed session, which is right for an account that charges no tax and loud
// enough to notice for one that does.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { createCheckoutSession } from "../dist/checkout.js";
import { __setPlanPricesForTests, lookupKeyFor } from "../dist/plans.js";
import { invalidateTaxRates, taxFor, taxModeOf } from "../dist/tax.js";

const PLANS = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 } } } },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    sale: "self_serve",
  },
};

// The reconcile WRITES to Stripe and archives what the passed config omits, so the
// resolved ids are stubbed rather than provisioned — see `__setPlanPricesForTests`.
__setPlanPricesForTests(new Map([[lookupKeyFor("pro", "monthly", "standard"), "price_std"]]));

function fakeStripe({ customerCountry } = {}) {
  const sessions = [];
  const taxRatesCreated = [];
  return {
    sessions,
    taxRatesCreated,
    checkout: {
      sessions: {
        async create(params) {
          sessions.push(params);
          return { id: "cs_1", client_secret: "cs_secret" };
        },
      },
    },
    customers: {
      async create() {
        return { id: "cus_1" };
      },
      async retrieve() {
        return {
          id: "cus_1",
          address: customerCountry ? { country: customerCountry } : null,
          tax_ids: { data: [] },
        };
      },
    },
    taxRates: {
      async list() {
        return { data: [] };
      },
      async create(params) {
        taxRatesCreated.push(params);
        return { id: `txr_${taxRatesCreated.length}`, ...params };
      },
    },
    // A restricted key that can't read configurations must not take checkout down,
    // so this path already tolerates the throw; it keeps the fake small.
    paymentMethodConfigurations: {
      list() {
        throw new Error("permission denied");
      },
    },
  };
}

const open = async (extra = {}, stripeOpts = {}) => {
  invalidateTaxRates();
  const stripe = fakeStripe(stripeOpts);
  __setStripeForTests(stripe);
  await createCheckoutSession({
    plans: PLANS,
    plan: "pro",
    interval: "monthly",
    seats: { standard: 1 },
    returnUrl: "https://t.local/done",
    customerId: "cus_1",
    currency: "eur",
    ...extra,
  });
  return { params: stripe.sessions[0], stripe };
};

test("no tax asked for, and no config → Stripe Tax stays OFF, nothing is taxed", async () => {
  const { params } = await open();
  assert.deepEqual(params.automatic_tax, { enabled: false });
  assert.equal(params.line_items[0].tax_rates, undefined);
});

test("Stripe Tax is opt-in, and explicit", async () => {
  const { params } = await open({ automaticTax: true });
  assert.deepEqual(params.automatic_tax, { enabled: true });
});

test("manual rates ride the line items, and never alongside automatic_tax", async () => {
  // Stripe rejects a session carrying both, and it would tax the line twice.
  const { params } = await open({ taxRates: ["txr_it_22"] });
  assert.deepEqual(params.automatic_tax, { enabled: false });
  assert.deepEqual(params.line_items[0].tax_rates, ["txr_it_22"]);
});

test("automatic_tax: false is still not inferred from passing rates", async () => {
  // The old default read the ABSENCE of `taxRates` as consent to Stripe Tax, so
  // this pins the direction of the inference being gone: passing both is the
  // caller's error to make, not something the absence of one decides.
  const { params } = await open({ taxRates: ["txr_it_22"], automaticTax: false });
  assert.deepEqual(params.automatic_tax, { enabled: false });
});

// ── One declaration: `config.tax` ───────────────────────────────────────────
//
// The friction being removed: every charge site took its own tax arguments, so
// what an account charged depended on which sites the app had wired — and the two
// charges with no form behind them (auto-reload, buy_credits) were wired nowhere.

test("`origin` alone means: this library calculates", () => {
  assert.equal(taxModeOf(undefined), "none");
  assert.equal(taxModeOf({}), "none");
  assert.equal(taxModeOf({ origin: "IT" }), "billing-tools");
  assert.equal(taxModeOf({ automatic: true }), "stripe");
  // An explicit mode always wins over what the other fields imply.
  assert.equal(taxModeOf({ origin: "IT", mode: "none" }), "none");
  assert.equal(taxModeOf({ origin: "IT", mode: "stripe" }), "stripe");
});

test("a config with `origin` taxes a seat checkout with no argument passed", async () => {
  // The whole point: the app declares where it is established, once, and the
  // charge carries the rate.
  const { params, stripe } = await open(
    { config: { baseUrl: "https://t.local", tax: { origin: "IT" } } },
    { customerCountry: "IT" },
  );
  assert.deepEqual(params.automatic_tax, { enabled: false }, "not Stripe Tax");
  assert.equal(params.line_items[0].tax_rates.length, 1);
  // 22% IVA, minted by the library from sales-tax's table.
  assert.equal(stripe.taxRatesCreated[0].percentage, 22);
  assert.equal(stripe.taxRatesCreated[0].country, "IT");
  assert.equal(stripe.taxRatesCreated[0].inclusive, false);
});

test("cross-border B2C is the buyer's rate, not the seller's", async () => {
  const { stripe } = await open(
    { config: { baseUrl: "https://t.local", tax: { origin: "IT" } } },
    { customerCountry: "DE" },
  );
  assert.equal(stripe.taxRatesCreated[0].country, "DE");
  assert.equal(stripe.taxRatesCreated[0].percentage, 19);
});

test("a customer with no address on file is charged the DOMESTIC rate, not nothing", async () => {
  // Same direction `resolveTax` takes for an unverifiable VAT number: over-charging
  // is recoverable, under-charging means owing it yourself.
  const { stripe } = await open({
    config: { baseUrl: "https://t.local", tax: { origin: "IT" } },
  });
  assert.equal(stripe.taxRatesCreated[0].country, "IT");
});

test("an explicit argument at the call site still wins over the config", async () => {
  const { params, stripe } = await open(
    { taxRates: ["txr_own"], config: { baseUrl: "https://t.local", tax: { origin: "IT" } } },
    { customerCountry: "IT" },
  );
  assert.deepEqual(params.line_items[0].tax_rates, ["txr_own"]);
  assert.equal(stripe.taxRatesCreated.length, 0, "nothing was resolved or minted");
});

test("`mode: stripe` in config reaches the charge as automatic_tax", async () => {
  const { params } = await open({
    config: { baseUrl: "https://t.local", tax: { mode: "stripe" } },
  });
  assert.deepEqual(params.automatic_tax, { enabled: true });
});

test("the `rates` hook is authoritative, and short-circuits the calculation", async () => {
  invalidateTaxRates();
  __setStripeForTests(fakeStripe({ customerCountry: "IT" }));
  const resolved = await taxFor("cus_1", {
    origin: "IT",
    rates: () => ["txr_from_our_records"],
  });
  assert.deepEqual(resolved, { taxRates: ["txr_from_our_records"] });
});

test('`mode: "billing-tools"` with no origin cannot guess, and says so once', async () => {
  invalidateTaxRates();
  __setStripeForTests(fakeStripe({ customerCountry: "IT" }));
  const warnings = [];
  const real = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    // Domestic vs cross-border is decided by where the SELLER is established, so
    // without it there is no rate to work out — and inventing one would be a
    // compliance guess.
    assert.deepEqual(await taxFor("cus_1", { mode: "billing-tools" }), {});
    await taxFor("cus_1", { mode: "billing-tools" });
  } finally {
    console.warn = real;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /origin/);
});
