// `checkBillingSetup` — the account half of the doctor.
//
// It went untested for a while because it touches eight Stripe endpoints, three of
// them auto-paginating iterators, and every ad-hoc fake I reached for was missing
// one and died mid-run. The fake below is complete, which is the whole reason this
// file exists: the branch it was written for shipped WRONG and nothing caught it.
//
// That branch is the US-exposure warning. It first read `config.tax.origin` — where
// WE are established — when the thing that matters is where the CUSTOMER is. Tax is
// owed at the place of supply, so a French seller with US customers has exposure and
// a US seller with only EU customers has none. As written it stayed silent for
// exactly the deployment that needed it.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { checkBillingSetup } from "../dist/doctor.js";

/** An auto-paginating list, as the SDK presents one. */
const paged = (items) => () => ({
  async *[Symbol.asyncIterator]() {
    for (const i of items) yield i;
  },
  data: items,
});

/**
 * Every endpoint `checkBillingSetup` touches. Complete on purpose — a fake missing
 * one throws mid-run, and the failure looks like a bug in the code under test.
 */
function fakeStripe({
  country = "FR",
  customers = [],
  prices = [],
  taxRates = [],
  // Only reached under `mode: "stripe"`, which is why it was the one endpoint the
  // first version of this fake missed.
  taxSettings = { status: "active", head_office: { address: { country } } },
  taxRegistrations = [{ country, status: "active" }],
} = {}) {
  return {
    tax: {
      settings: { retrieve: async () => taxSettings },
      registrations: { list: async () => ({ data: taxRegistrations }) },
    },
    accounts: { retrieve: async () => ({ id: "acct_1", country }) },
    customers: { list: paged(customers) },
    invoices: { list: paged([]) },
    subscriptions: { list: paged([]) },
    paymentMethods: { list: async () => ({ data: [] }) },
    prices: { list: async () => ({ data: prices }) },
    taxRates: { list: async () => ({ data: taxRates }) },
    webhookEndpoints: { list: async () => ({ data: [] }) },
  };
}

const customer = (addressCountry) => ({
  id: `cus_${addressCountry ?? "none"}`,
  currency: "eur",
  address: addressCountry ? { country: addressCountry } : null,
  metadata: {},
});

const find = (r, fragment) => r.checks.find((c) => c.title.includes(fragment));
const config = (tax) => ({ currency: "eur", baseUrl: "https://t.local", internalDomains: [], tax });

test("a US CUSTOMER raises the warning, whatever country we are in", async () => {
  // The bug, pinned: a French seller with a US customer must be warned.
  __setStripeForTests(fakeStripe({ country: "FR", customers: [customer("US"), customer("FR")] }));
  const r = await checkBillingSetup({ config: config({ origin: "FR" }) });

  const c = find(r, "US customers");
  assert.ok(c, "expected the US-exposure warning");
  assert.equal(c.level, "warn");
  assert.match(c.detail, /1 customer/);
  // The fix has to name the alternative and the reason the local rate is wrong.
  assert.match(c.fix, /mode: "stripe"/);
  assert.match(c.fix, /Chicago|jurisdiction/);
});

test("no US customers, no warning — even for a US-established seller", async () => {
  // The inverse of the bug. Where WE are is irrelevant: with only EU customers there
  // is no US place of supply, so warning would be noise, and noise in a doctor is
  // how real findings get skipped.
  __setStripeForTests(fakeStripe({ country: "US", customers: [customer("FR"), customer("IT")] }));
  const r = await checkBillingSetup({ config: config({ origin: "US" }) });
  assert.equal(find(r, "US customers"), undefined);
});

test("declaring registrations without a US entry silences it — nothing is owed there", async () => {
  // A declared list is a statement: not registered in the US, so post-Wayfair those
  // charges are 0% and complete, and there is nothing left to warn about.
  __setStripeForTests(fakeStripe({ country: "FR", customers: [customer("US")] }));
  const r = await checkBillingSetup({
    config: config({ origin: "FR", registrations: [{ country: "FR" }] }),
  });
  assert.equal(find(r, "US customers"), undefined);
});

test("but a declared US registration still warns — we have no US rate to apply", async () => {
  // The opposite statement, and the case that must NOT go quiet: tax is genuinely due
  // and this library cannot compute it, so the charge will throw. Silencing that is
  // what the removed flag did.
  __setStripeForTests(fakeStripe({ country: "FR", customers: [customer("US")] }));
  const r = await checkBillingSetup({
    config: config({ origin: "FR", registrations: [{ country: "US", state: "CA" }] }),
  });
  const c = find(r, "US customers");
  assert.ok(c, "a declared US registration with no US rate must be reported");
  assert.equal(c.level, "warn");
  assert.match(c.detail, /registration is declared/);
});

test("it is a WARNING, not an error — nexus is not knowable from here", async () => {
  // Whether those customers are taxable depends on per-state economic-nexus
  // thresholds (~$100k or 200 transactions) that no local dataset knows. The doctor
  // can say the exposure exists; it cannot say an obligation does, so it must not
  // fail the run.
  __setStripeForTests(fakeStripe({ country: "FR", customers: [customer("US")] }));
  const r = await checkBillingSetup({ config: config({ origin: "FR" }) });
  assert.equal(find(r, "US customers").level, "warn");
  assert.equal(r.healthy, true, "a warning must not make the account unhealthy");
});

test('mode "stripe" does not raise it at all', async () => {
  // Stripe Tax resolves US local jurisdictions, so there is nothing to warn about.
  __setStripeForTests(fakeStripe({ country: "FR", customers: [customer("US")] }));
  const r = await checkBillingSetup({ config: config({ origin: "FR", mode: "stripe" }) });
  assert.equal(find(r, "US customers"), undefined);
});

test("a customer with no address is not counted as US", async () => {
  // `address: null` is the common case for a customer created before any checkout.
  // Counting it either way would be a guess; not counting it is the quiet one.
  __setStripeForTests(fakeStripe({ country: "FR", customers: [customer(null), customer(null)] }));
  const r = await checkBillingSetup({ config: config({ origin: "FR" }) });
  assert.equal(find(r, "US customers"), undefined);
});

test("the account's environment and country are reported", async () => {
  // The cheapest check in the file and the one that catches a live key in staging.
  __setStripeForTests(fakeStripe({ country: "IT" }));
  const r = await checkBillingSetup({ config: config({ origin: "IT" }) });
  const c = find(r, "Stripe account");
  assert.ok(c, "expected the account check");
  assert.match(c.detail, /IT/);
  assert.match(c.detail, /test/i, "a sk_test key must read as test mode");
});

// ── Declared origin vs the account's country ─────────────────────────────────
//
// `originFor` prefers `config.tax.origin` and never consults the account when one is
// set, so the two disagree in silence — and origin decides domestic vs cross-border,
// which is every rate the local engine computes. Measured on a real consumer: its
// TAX_ORIGIN said FR while its own setup script registered IT.
test("a declared origin that contradicts the Stripe account is reported", async () => {
  __setStripeForTests(fakeStripe({ country: "IT" }));
  const r = await checkBillingSetup({ config: config({ origin: "FR" }) });

  const origin = find(r, "Tax origin");
  assert.equal(origin?.level, "warn");
  assert.match(origin.detail, /origin is FR but this Stripe account is registered in IT/);
  // A warning, not an error: a doctor that hard-fails a legitimate setup gets skipped.
  assert.equal(r.healthy, true);
});

test("a matching origin says so, and silence where there is nothing to contradict", async () => {
  __setStripeForTests(fakeStripe({ country: "IT" }));
  assert.equal(find(await checkBillingSetup({ config: config({ origin: "IT" }) }), "Tax origin")?.level, "ok");

  // Undeclared is the documented fallback — `originFor` reads the account country, so
  // there is nothing to contradict and nothing to report.
  __setStripeForTests(fakeStripe({ country: "IT" }));
  assert.equal(find(await checkBillingSetup({ config: config(undefined) }), "Tax origin"), undefined);

  // `mode: "stripe"` hands the calculation to Stripe, so our origin is no longer the
  // input and comparing it would be noise.
  __setStripeForTests(fakeStripe({ country: "IT" }));
  assert.equal(
    find(await checkBillingSetup({ config: config({ mode: "stripe", origin: "FR" }) }), "Tax origin"),
    undefined,
  );
});

test("an undeclared origin on a non-European account is an ERROR, not a warning", async () => {
  // The one case neither the type system nor `resolveConfig` can see: omitting the
  // field is legal, and resolveConfig is synchronous so it cannot read the account.
  // Every charge would go out untaxed with a console warning as its only signal —
  // which is the whole argument for the doctor existing rather than being replaced by
  // "just read Stripe".
  __setStripeForTests(fakeStripe({ country: "US" }));
  const r = await checkBillingSetup({ config: config(undefined) });
  const origin = find(r, "Tax origin");
  assert.equal(origin?.level, "error");
  assert.match(origin.detail, /not one of the 45/);
  assert.equal(r.healthy, false, "untaxed charges must fail the run");

  // A European account needs no declaration — the fallback is the documented design.
  __setStripeForTests(fakeStripe({ country: "IT" }));
  assert.equal(find(await checkBillingSetup({ config: config(undefined) }), "Tax origin"), undefined);

  // And `mode: "none"` is how "untaxed, deliberately" is said, so it is not flagged.
  __setStripeForTests(fakeStripe({ country: "US" }));
  assert.equal(
    find(await checkBillingSetup({ config: config({ mode: "none" }) }), "Tax origin"),
    undefined,
  );
});
