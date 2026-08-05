// Selling where you are not registered.
//
// `registrations` says where you collect; NON_RESIDENT_RULES says what each country
// demands of a seller with no establishment there. Neither alone can tell you the
// declaration is INCOMPLETE — which is the warning nobody was getting, and the reason
// the rules live in the library instead of in each app's comments.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { checkBillingSetup } from "../dist/doctor.js";
import {
  NON_RESIDENT_RULES,
  describeThreshold,
  nonResidentRule,
  zeroThresholdCountries,
} from "../dist/tax-obligations.js";
import { sellerRegime } from "../dist/tax-regime.js";

const paged = (items) => () => ({
  async *[Symbol.asyncIterator]() {
    for (const i of items) yield i;
  },
  data: items,
});

const customer = (country) => ({
  id: `cus_${country}`,
  currency: "eur",
  address: country ? { country } : null,
  metadata: {},
});

function fakeStripe(customers) {
  return {
    tax: {
      settings: { retrieve: async () => ({ status: "active", head_office: { address: { country: "FR" } } }) },
      registrations: { list: async () => ({ data: [] }) },
    },
    accounts: { retrieve: async () => ({ id: "acct_1", country: "FR" }) },
    customers: { list: paged(customers) },
    invoices: { list: paged([]) },
    subscriptions: { list: paged([]) },
    paymentMethods: { list: async () => ({ data: [] }) },
    prices: { list: async () => ({ data: [] }) },
    taxRates: { list: async () => ({ data: [] }) },
    webhookEndpoints: { list: async () => ({ data: [] }) },
  };
}

const find = (r, fragment) => r.checks.find((c) => c.title.includes(fragment));

const FRANCHISE = sellerRegime({ country: "FR", vatRegistered: false });
const config = (tax) => ({ currency: "eur", baseUrl: "https://t.local", internalDomains: [], tax });

test("a UK customer with no UK registration is an ERROR, not a warning", async () => {
  // Zero threshold: the obligation starts at the first consumer sale, so this needs no
  // knowledge of turnover. A certainty, not a risk — hence error.
  __setStripeForTests(fakeStripe([customer("GB"), customer("GB"), customer("FR")]));
  const r = await checkBillingSetup({ config: config(FRANCHISE) });

  const gb = find(r, "Unregistered exposure: GB");
  assert.equal(gb?.level, "error");
  assert.match(gb.detail, /2 customer\(s\) are in GB/);
  assert.match(gb.detail, /from the first consumer sale/);
  // The fix has to be actionable: how to comply, the alternative, and a citation.
  assert.match(gb.fix, /registrations/);
  assert.match(gb.fix, /reverse-charged/);
  assert.match(gb.fix, /gov\.uk/);
  assert.equal(r.healthy, false);
});

test("declaring the registration silences it", async () => {
  __setStripeForTests(fakeStripe([customer("GB")]));
  const r = await checkBillingSetup({
    config: config(sellerRegime({ country: "FR", vatRegistered: false, alsoCollectIn: [{ country: "GB" }] })),
  });
  assert.equal(find(r, "Unregistered exposure: GB"), undefined);
  assert.equal(r.healthy, true);
});

test("a country WITH a threshold can only warn — the library cannot see your books", async () => {
  __setStripeForTests(fakeStripe([customer("NO"), customer("AU")]));
  const r = await checkBillingSetup({ config: config(FRANCHISE) });

  for (const cc of ["NO", "AU"]) {
    const hit = find(r, `Unregistered exposure: ${cc}`);
    assert.equal(hit?.level, "warn", `${cc} must warn, not error`);
    assert.match(hit.detail, /above [\d,]+ (NOK|AUD) a year/);
  }
  // Warnings must not fail a deploy: whether the threshold is crossed is unknown here.
  assert.equal(r.healthy, true);
});

test("no claim is made about countries nobody has read", async () => {
  // An absent country means "unknown", never "no obligation". Reassuring someone about
  // Japan because we never wrote a Japan entry is the failure this avoids.
  assert.equal(nonResidentRule("JP"), undefined);
  __setStripeForTests(fakeStripe([customer("JP"), customer("BR")]));
  const r = await checkBillingSetup({ config: config(FRANCHISE) });
  assert.equal(r.checks.filter((c) => c.title.startsWith("Unregistered exposure")).length, 0);
});

test("your own country is never flagged, and EU states are left to the engine", async () => {
  // Domestic is the franchise's business, and the EU rules (place of supply, the €10 000
  // cross-border threshold, OSS, reverse charge) are modelled in the engine — a second
  // statement here could only disagree with it.
  __setStripeForTests(fakeStripe([customer("FR"), customer("IT"), customer("DE")]));
  const r = await checkBillingSetup({ config: config(FRANCHISE) });
  assert.equal(r.checks.filter((c) => c.title.startsWith("Unregistered exposure")).length, 0);
});

test("every rule carries a source and a review date", async () => {
  // A rule with no source is a rumour, and these move: the file is only maintainable if
  // each entry says where it came from and when it was last read.
  for (const rule of NON_RESIDENT_RULES) {
    assert.match(rule.country, /^[A-Z]{2}$/, `${rule.country} is not an ISO code`);
    assert.match(rule.source, /^https:\/\//, `${rule.country} has no citable source`);
    assert.match(rule.reviewed, /^\d{4}-\d{2}-\d{2}$/, `${rule.country} has no review date`);
    assert.equal(typeof rule.b2bReverseCharge, "boolean");
    assert.ok(describeThreshold(rule).length > 10);
  }
  // The UK is the one this file exists for; a regression that dropped it would be quiet.
  assert.ok(zeroThresholdCountries().includes("GB"));
});

// ── The supplier's own VAT number ────────────────────────────────────────────
//
// Art. 226(3) requires an invoice to carry the SUPPLIER's VAT identification number,
// and for a reverse-charged EU B2B supply it is mandatory beside the customer's. Stripe
// prints the account's name and address but no tax id of its own, and the number lives
// in the app's entity declaration — so every invoice was missing it, and list_invoices /
// view_invoice returned that incomplete document faithfully.
test("an account with no tax id of its own is reported", async () => {
  const stripe = fakeStripe([customer("FR")]);
  stripe.taxIds = { list: async () => ({ data: [] }) };
  __setStripeForTests(stripe);

  const r = await checkBillingSetup({ config: config(FRANCHISE) });
  const hit = find(r, "Supplier VAT number");
  assert.equal(hit?.level, "warn");
  assert.match(hit.detail, /no tax id of its own/);
  assert.match(hit.fix, /226\(3\)/);
});

test("an id that exists but is not the invoice default prints on nothing", async () => {
  const stripe = fakeStripe([customer("FR")]);
  stripe.taxIds = { list: async () => ({ data: [{ id: "txi_1", type: "eu_vat", value: "FR12345678901" }] }) };
  // No `default_account_tax_ids` on the account.
  __setStripeForTests(stripe);

  const r = await checkBillingSetup({ config: config(FRANCHISE) });
  const hit = find(r, "Supplier VAT number");
  assert.equal(hit?.level, "warn");
  assert.match(hit.detail, /none is the invoice default/);
});

test("set as the default, it is reported as printed", async () => {
  const stripe = fakeStripe([customer("FR")]);
  stripe.taxIds = { list: async () => ({ data: [{ id: "txi_1", type: "eu_vat", value: "FR12345678901" }] }) };
  stripe.accounts = {
    retrieve: async () => ({
      id: "acct_1",
      country: "FR",
      settings: { invoices: { default_account_tax_ids: ["txi_1"] } },
    }),
  };
  __setStripeForTests(stripe);

  const r = await checkBillingSetup({ config: config(FRANCHISE) });
  const hit = find(r, "Supplier VAT number");
  assert.equal(hit?.level, "ok");
  assert.match(hit.detail, /eu_vat FR12345678901/);
});

test("`mode: none` has no supply to identify, so it is not asked for one", async () => {
  const stripe = fakeStripe([customer("FR")]);
  stripe.taxIds = { list: async () => ({ data: [] }) };
  __setStripeForTests(stripe);
  const r = await checkBillingSetup({ config: config({ mode: "none" }) });
  assert.equal(find(r, "Supplier VAT number"), undefined);
});
