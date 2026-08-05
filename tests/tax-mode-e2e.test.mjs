// Every tax mode, from config to what reaches Stripe — and the four prerequisites
// `mode: "stripe"` has, each of which was verified against a live test account before
// being written down here.
//
// The measured behaviour, on a FR test account with a head office set:
//
//   no active registration        →  tax 0.00, automatic_tax.status "complete"   ← SILENT
//   FR registration, FR consumer  →  tax 20.00 (20% FR VAT)                      ← works
//   FR registration, IT consumer  →  tax 0.00   (not registered there)
//   FR registration, IT business  →  tax 0.00   (reverse charge)
//   FR registration, US consumer  →  tax 0.00   (out of scope)
//
//   price with no `tax_behavior`  →  HARD ERROR, not a zero
//   no tax code anywhere          →  HARD ERROR, not a zero
//
// So Stripe Tax fails loudly for the two setup mistakes a request can see, and SILENTLY
// for the one it cannot — a missing registration. That asymmetry is the whole reason
// `checkBillingSetup` errors on registrations rather than warning.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { checkBillingSetup } from "../dist/doctor.js";
import { createCheckoutSession } from "../dist/checkout.js";
import { __setPlanPricesForTests, lookupKeyFor } from "../dist/plans.js";
import { resolveConfig } from "../dist/types.js";
import { taxFor, __setVatValidatorForTests, invalidateTaxRates } from "../dist/tax.js";
import { sellerRegime } from "../dist/tax-regime.js";
import { stripeList } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 } } } },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    sale: "self_serve",
  },
};
__setPlanPricesForTests(new Map([[lookupKeyFor("pro", "monthly", "standard"), "price_std"]]));

const base = { baseUrl: "https://t.local", currency: "eur", internalDomains: [] };

function fakeStripe({ prices = [], taxSettings, taxRegistrations = [], accountTaxIds = [] } = {}) {
  const sessions = [];
  return {
    sessions,
    checkout: { sessions: { async create(p) { sessions.push(p); return { id: "cs_1", client_secret: "cs", url: null }; } } },
    customers: { async retrieve() { return { id: "cus_1", address: { country: "FR" }, tax_ids: { data: [] } }; }, list: () => stripeList([]) },
    accounts: { retrieve: async () => ({ id: "acct_1", country: "FR", settings: { invoices: { default_account_tax_ids: [] } } }) },
    taxIds: { list: async () => ({ data: accountTaxIds }) },
    taxRates: { list: () => stripeList([]), async create(p) { return { id: "txr_1", ...p }; } },
    tax: {
      settings: { retrieve: async () => taxSettings ?? { status: "active", head_office: { address: { country: "FR" } }, defaults: { tax_code: "txcd_10000000" } } },
      registrations: { list: async () => ({ data: taxRegistrations }) },
    },
    prices: { list: async () => ({ data: prices }) },
    invoices: { list: () => stripeList([]) },
    subscriptions: { list: () => stripeList([]) },
    paymentMethods: { list: async () => ({ data: [] }) },
    webhookEndpoints: { list: async () => ({ data: [] }) },
  };
}

const find = (r, fragment) => r.checks.find((c) => c.title.includes(fragment));
const managed = (behavior) => ({ id: "price_1", lookup_key: "pro_monthly_standard", tax_behavior: behavior, metadata: { managedBy: "billing-tools" } });

// ── 1. local + EU: computed in process, and it reaches the line ──────────────
test("`local` + an EU establishment taxes the line itself", async () => {
  invalidateTaxRates();
  __setVatValidatorForTests(async () => true);
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await createCheckoutSession({
    plans: PLANS, plan: "pro", interval: "monthly", seats: { standard: 1 },
    returnUrl: "https://t.local/done", customerId: "cus_1", currency: "eur",
    config: { ...base, tax: sellerRegime({ country: "FR", vatRegistered: true }) },
  });

  const p = stripe.sessions[0];
  // Our own TaxRate, not Stripe's calculation.
  assert.deepEqual(p.automatic_tax, { enabled: false });
  assert.ok(p.line_items[0].tax_rates?.length, "the line carries a TaxRate this library minted");
});

// ── 2. local + non-EU: refused before any charge ─────────────────────────────
test("`local` + a non-EU establishment is refused at boot, not at the charge", () => {
  for (const origin of ["US", "AU", "JP", "BR"]) {
    assert.throws(
      () => resolveConfig({ ...base, tax: { origin } }),
      (e) => {
        assert.match(e.message, /cannot be used with mode "local"/);
        assert.match(e.message, /mode: "stripe"/, "a refusal must name the way out");
        return true;
      },
      `${origin} should not be usable with the local engine`,
    );
  }
});

// ── 3. stripe: hands off, and ignores the local-only fields ─────────────────
test("`mode: \"stripe\"` hands the whole calculation to Stripe", async () => {
  __setStripeForTests(fakeStripe());
  assert.deepEqual(await taxFor("cus_1", { mode: "stripe", origin: "US" }), { automaticTax: true });

  // `notes`, `registrations` and `oss` are LOCAL-engine inputs. Under Stripe Tax they are
  // ignored — Stripe writes its own invoice wording and reads its own registrations — so
  // a deployment that switches modes and keeps them gets no mentions from us.
  assert.deepEqual(
    await taxFor("cus_1", {
      mode: "stripe",
      origin: "US",
      registrations: [{ country: "FR" }],
      oss: true,
      notes: { exempt: "ignored", reverseCharge: "ignored" },
    }),
    { automaticTax: true },
  );
});

// ── 4. The four prerequisites, as the doctor reports them ───────────────────
test("stripe mode with NO registration is an ERROR, because the failure is silent", async () => {
  // Measured live: tax 0.00 with automatic_tax.status "complete". Nothing in the request
  // or the response says anything is wrong, which is why this cannot be a warning.
  __setStripeForTests(fakeStripe({ taxRegistrations: [], prices: [managed("exclusive")] }));
  const r = await checkBillingSetup({ config: { ...base, tax: { mode: "stripe", origin: "FR" } } });

  const regs = find(r, "Tax registrations");
  assert.equal(regs?.level, "error");
  assert.match(regs.detail, /ZERO tax/);
  assert.equal(r.healthy, false);
});

test("a price with no tax_behavior is an error too — Stripe refuses to compute", async () => {
  // Measured live: "The price … does not have a tax behavior set, which is required for
  // automatic tax computation." A hard 400, not a zero.
  __setStripeForTests(fakeStripe({ taxRegistrations: [{ country: "FR", status: "active" }], prices: [managed("unspecified")] }));
  const r = await checkBillingSetup({ config: { ...base, tax: { mode: "stripe", origin: "FR" } } });

  const beh = find(r, "Price tax_behavior");
  assert.equal(beh?.level, "error");
  assert.match(beh.detail, /unspecified/);
});

test("an incomplete head office is an error: Stripe Tax computes nothing until it is active", async () => {
  __setStripeForTests(
    fakeStripe({
      taxRegistrations: [{ country: "FR", status: "active" }],
      prices: [managed("exclusive")],
      taxSettings: { status: "pending", status_details: { pending: { missing_fields: ["head_office"] } } },
    }),
  );
  const r = await checkBillingSetup({ config: { ...base, tax: { mode: "stripe", origin: "FR" } } });
  const s = find(r, "Stripe Tax settings");
  assert.equal(s?.level, "error");
  assert.match(s.detail, /head_office/);
});

test("fully configured, every stripe-mode check passes", async () => {
  __setStripeForTests(
    fakeStripe({
      taxRegistrations: [{ country: "FR", status: "active" }],
      prices: [managed("exclusive")],
      accountTaxIds: [{ id: "txi_1", type: "eu_vat", value: "FR12345678901" }],
    }),
  );
  const r = await checkBillingSetup({ config: { ...base, tax: { mode: "stripe", origin: "FR" } } });
  for (const title of ["Stripe Tax settings", "Tax registrations", "Price tax_behavior"]) {
    assert.equal(find(r, title)?.level, "ok", `${title} should pass`);
  }
});

// ── 5. none: nothing is charged, and nothing is checked ─────────────────────
test("`mode: \"none\"` charges nothing and is not audited for tax", async () => {
  __setStripeForTests(fakeStripe());
  assert.deepEqual(await taxFor("cus_1", { mode: "none" }), {});

  const r = await checkBillingSetup({ config: { ...base, tax: { mode: "none" } } });
  assert.equal(find(r, "Tax registrations"), undefined);
  assert.equal(find(r, "Supplier VAT number"), undefined, "no supply to identify");
});
