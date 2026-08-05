// Charges the library raises with no form behind them: a `buy_credits` Checkout
// and the auto-reload invoice. Both were untaxed while every seat invoice on the
// same account charged 22% IVA — a compliance defect, not a rounding one.
//
// The rule these pin: if the deployment says how to work out the rate, every
// charge the library initiates carries it.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests, createCreditCheckoutSession, autoReloadFor } from "../dist/billing.js";

function fakeStripe() {
  const calls = [];
  return {
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    checkout: {
      sessions: {
        async create(params) {
          calls.push({ name: "session", params });
          return { id: "cs_1", url: "https://checkout.test/cs_1" };
        },
      },
    },
    customers: {
      async retrieve() {
        return {
          deleted: false,
          balance: -50,
          currency: "eur",
          metadata: {
            auto_reload_enabled: "true",
            auto_reload_threshold: "100",
            auto_reload_to: "1000",
          },
        };
      },
      async createBalanceTransaction(_c, params, opts) {
        calls.push({ name: "credit", params, key: opts?.idempotencyKey });
        return { id: "txn_1" };
      },
    },
    paymentMethods: {
      async list() {
        return { data: [{ id: "pm_1" }] };
      },
    },
    invoiceItems: {
      async create(params, opts) {
        calls.push({ name: "invoiceItem", params, key: opts?.idempotencyKey });
        return { id: "ii_1" };
      },
    },
    invoices: {
      async create(params, opts) {
        calls.push({ name: "invoice", params, key: opts?.idempotencyKey });
        return { id: "in_1", status: "draft" };
      },
      async pay(id) {
        calls.push({ name: "pay", params: { id } });
        return { id, status: "paid" };
      },
    },
  };
}

const config = {
  freeCredits: 100,
  currency: "eur",
  baseUrl: "https://app.test",
  internalDomains: [],
  defaultLocale: "it",
};

test("a top-up checkout carries the tax rates it is given", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await createCreditCheckoutSession("cus_1", "org_1", 50, config, { taxRates: ["txr_iva22"] });

  const { params } = stripe.of("session")[0];
  assert.deepEqual(params.line_items[0].tax_rates, ["txr_iva22"]);
  assert.equal(params.invoice_creation.enabled, true, "a top-up must produce an invoice");
});

test("manual rates and automatic tax are never sent together", async () => {
  // Stripe rejects the request outright when both are present.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await createCreditCheckoutSession("cus_1", "org_1", 50, config, {
    taxRates: ["txr_iva22"],
    automaticTax: true,
  });

  assert.equal(stripe.of("session")[0].params.automatic_tax, undefined);
});

test("the return URLs are overridable", async () => {
  // They were hardcoded to /billing/success|cancel, which is a 404 in an app
  // that routes in another language.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await createCreditCheckoutSession("cus_1", "org_1", 50, config, {
    successUrl: "https://app.test/spazio/fatturazione?ok=1",
    cancelUrl: "https://app.test/spazio/fatturazione",
  });

  const { params } = stripe.of("session")[0];
  assert.match(params.success_url, /spazio\/fatturazione/);
  assert.match(params.cancel_url, /spazio\/fatturazione/);
});

test("auto-reload applies the deployment's tax settings", async () => {
  // `config.tax.rates` exists because the meter fires this with no address form
  // in sight — the rate has to come from what is already known about the customer.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  let askedFor = null;

  await autoReloadFor("cus_1", {
    currency: "eur",
    tax: {
      rates: (customerId) => {
        askedFor = customerId;
        return ["txr_iva22"];
      },
    },
  });

  assert.equal(askedFor, "cus_1", "the resolver is asked about this customer");
  assert.deepEqual(stripe.of("invoiceItem")[0].params.tax_rates, ["txr_iva22"]);
});

test("the auto-reload invoice INCLUDES the pending item", async () => {
  // Measured against Stripe: without this, a customer who has a subscription
  // gets an invoice that is paid, numbered and totals zero, while the credits
  // are swept onto their next subscription invoice a month later.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await autoReloadFor("cus_1", { currency: "eur" });

  assert.equal(
    stripe.of("invoice")[0].params.pending_invoice_items_behavior,
    "include",
    "the item this invoice was raised for must actually be on it",
  );
});

test("auto-reload never falls back to a bare charge", async () => {
  // A PaymentIntent produces a receipt with no invoice number and no tax line,
  // which is not a valid sales document for a business customer.
  const stripe = fakeStripe();
  stripe.paymentIntents = {
    async create() {
      throw new Error("auto-reload must not use a bare PaymentIntent");
    },
  };
  __setStripeForTests(stripe);

  await autoReloadFor("cus_1", { currency: "eur" });

  assert.equal(stripe.of("invoice").length, 1);
  assert.equal(stripe.of("pay").length, 1);
});

test("an embedded top-up asks before keeping the card, unless told always", async () => {
  // The checkbox is not merely cosmetic: present, Checkout honours an UNTICKED box
  // over the session's own `setup_future_usage`, so the purchase can leave nothing
  // behind — and auto-reload has nothing to charge. `always` drops the checkbox and
  // lets `setup_future_usage` (and the mandate text it renders) stand.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await createCreditCheckoutSession("cus_1", "org_1", 50, config, { uiMode: "embedded" });
  const asked = stripe.of("session")[0].params;
  assert.equal(asked.saved_payment_method_options.payment_method_save, "enabled");
  assert.equal(asked.payment_intent_data.setup_future_usage, "off_session");

  const stripe2 = fakeStripe();
  __setStripeForTests(stripe2);
  await createCreditCheckoutSession("cus_1", "org_1", 50, config, {
    uiMode: "embedded",
    savePaymentMethod: "always",
  });
  const always = stripe2.of("session")[0].params;
  assert.equal(always.saved_payment_method_options.payment_method_save, undefined);
  assert.equal(always.payment_intent_data.setup_future_usage, "off_session");
  // Existing cards must still be offered — that is a different option entirely.
  assert.deepEqual(always.saved_payment_method_options.allow_redisplay_filters, [
    "always",
    "limited",
    "unspecified",
  ]);
});
