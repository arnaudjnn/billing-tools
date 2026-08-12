// Who calculates tax, when the caller says nothing.
//
// It used to be Stripe Tax, inferred from the absence of `taxRates`. That default
// is the expensive one to get wrong: Stripe Tax with no active registration
// returns ZERO tax rather than an error, so the total silently drops to the
// pre-tax amount and the seller owes the difference — and the account it happens
// on is exactly the one that never opted into Stripe Tax and so never registered.
//
// The library ships its own calculation (`taxRatesFor` — eu-vat-rates-data + VIES,
// as an explicit Stripe TaxRate), so the default is now "nobody unless asked":
// an untaxed session, which is right for an account that charges no tax and loud
// enough to notice for one that does.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { createCheckoutSession } from "../dist/checkout.js";
import { __setPlanPricesForTests, lookupKeyFor } from "../dist/plans.js";
import { invalidateTaxOrigin, invalidateTaxRates, taxFor, taxModeOf } from "../dist/tax.js";
import { stripeList } from "./helpers.mjs";

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
      list() {
        return stripeList([]);
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

test("this library calculates by DEFAULT — see tax-default.test.mjs", () => {
  // Configuring nothing used to mean `"none"`, i.e. charging no tax anywhere. It
  // now means this library's own calculation, with the origin falling back to the
  // Stripe account's country. The full argument and the origin resolution live in
  // test/tax-default.test.mjs; this only pins the precedence.
  assert.equal(taxModeOf(undefined), "local");
  assert.equal(taxModeOf({}), "local");
  assert.equal(taxModeOf({ origin: "IT" }), "local");
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
  // 22% IVA, minted by the library from its own rate table.
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
  // No `decision`: the consumer's resolver answered, so the library decided nothing
  // and must not invent a decision beside an answer it did not produce.
  assert.ok(!("decision" in resolved));
});

// ── `decision`: the TaxDecision the rate was minted from, under `local` only ─
//
// A consumer re-derived the customer-country cascade (address → EU-VAT prefix →
// origin) beside taxFor to learn whether a quote reverse-charges — the cascade
// taxFor already ran and discarded.

test("local returns the decision, and its country follows address → VAT prefix → origin", async () => {
  const { __setVatValidatorForTests } = await import(new URL("../dist/tax.js", import.meta.url).href);
  __setVatValidatorForTests(async () => true);
  const customer = { address: null, taxId: null };
  const stripe = {
    ...fakeStripe(),
    customers: {
      async retrieve() {
        return {
          id: "cus_1",
          address: customer.address,
          tax_ids: { data: customer.taxId ? [{ type: "eu_vat", value: customer.taxId }] : [] },
        };
      },
    },
  };
  const local = async () => {
    invalidateTaxRates();
    __setStripeForTests(stripe);
    return taxFor("cus_1", { origin: "IT" });
  };

  // 1. An address wins.
  customer.address = { country: "DE" };
  customer.taxId = null;
  let { decision } = await local();
  assert.equal(decision.country, "DE");
  assert.equal(decision.reverseCharge, false);
  assert.equal(decision.percent, 19);

  // 2. No address: an EU VAT number carries its country, and a valid one reverse-charges.
  customer.address = null;
  customer.taxId = "DE811907980";
  ({ decision } = await local());
  assert.equal(decision.country, "DE");
  assert.equal(decision.reverseCharge, true);
  assert.equal(decision.percent, 0);

  // 3. Nothing at all: domestic — charged, never guessed at zero.
  customer.taxId = null;
  const resolved = await local();
  assert.equal(resolved.decision.country, "IT");
  assert.equal(resolved.decision.percent, 22);
  assert.ok(resolved.taxRates?.length, "the domestic rate is still minted");
  __setVatValidatorForTests();
});

test("stripe and none return no decision — those modes decide nothing here", async () => {
  // ABSENCE is the contract, not just the shape: `decision` present under a
  // mode this library did not decide would be a second answer beside Stripe's
  // (or beside nobody's), which is what every caller would then read.
  invalidateTaxRates();
  __setStripeForTests(fakeStripe({ customerCountry: "IT" }));
  const viaStripe = await taxFor("cus_1", { mode: "stripe" });
  assert.deepEqual(viaStripe, { automaticTax: true });
  assert.ok(!("decision" in viaStripe), "Stripe decided, so this library did not");
  const none = await taxFor("cus_1", { mode: "none" });
  assert.deepEqual(none, {});
  assert.ok(!("decision" in none), "nobody decided");
});

test("local with no resolvable origin returns nothing at all — not a zero decision", async () => {
  // The one remaining untaxed case under this mode. A `decision` here would
  // read as "0%, decided", when the truth is that no rate could be worked out.
  invalidateTaxRates();
  invalidateTaxOrigin();
  __setStripeForTests({
    ...fakeStripe({ customerCountry: "IT" }),
    accounts: { retrieve: async () => ({ id: "acct_1" }) },
  });
  const real = console.warn;
  console.warn = () => {};
  try {
    const out = await taxFor("cus_1", { mode: "local" });
    assert.deepEqual(out, {});
    assert.ok(!("decision" in out));
  } finally {
    console.warn = real;
  }
});

test('no origin ANYWHERE cannot guess, and says so once', async () => {
  invalidateTaxRates();
  invalidateTaxOrigin();
  // The account has no country either, so there is genuinely nothing to resolve
  // from — the only remaining case where a charge goes out untaxed under this mode.
  __setStripeForTests({
    ...fakeStripe({ customerCountry: "IT" }),
    accounts: { retrieve: async () => ({ id: "acct_1" }) },
  });
  const warnings = [];
  const real = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    // Domestic vs cross-border is decided by where the SELLER is established, so
    // without it there is no rate to work out — and inventing one would be a
    // compliance guess.
    assert.deepEqual(await taxFor("cus_1", { mode: "local" }), {});
    await taxFor("cus_1", { mode: "local" });
  } finally {
    console.warn = real;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /origin/);
});
