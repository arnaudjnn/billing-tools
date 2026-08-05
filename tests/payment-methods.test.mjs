// What a payment form offers, when the app names nothing.
//
// Link cannot be removed by `wallets.link: "never"` (that is only the wallet) nor
// by `payment_method_types: ["card"]` (the inline signup is drawn from the
// ACCOUNT's Link setting). A payment-method configuration is the only lever, and
// it was left to each consumer to discover — so every app shipped the Link signup
// by accident. These pin the library's own default.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import {
  defaultPaymentMethodConfig,
  invalidatePaymentMethodConfigs,
} from "../dist/payment-method-config.js";

/** An account with card + SEPA + Link on, and Apple/Google Pay off. */
function fakeStripe({ failList = false, existing = [] } = {}) {
  const created = [];
  return {
    created,
    paymentMethodConfigurations: {
      list() {
        if (failList) throw new Error("permission denied");
        const page = [
          ...existing,
          {
            id: "pmc_account_default",
            name: "Default",
            active: true,
            is_default: true,
            card: { display_preference: { value: "on" } },
            sepa_debit: { display_preference: { value: "on" } },
            link: { display_preference: { value: "on" } },
            apple_pay: { display_preference: { value: "off" } },
            google_pay: { display_preference: { value: "off" } },
          },
        ];
        return { [Symbol.asyncIterator]: async function* () { yield* page; } };
      },
      async create(params) {
        created.push(params);
        return { id: `pmc_${created.length}` };
      },
    },
  };
}

const on = (params) =>
  Object.entries(params)
    .filter(([, v]) => v && typeof v === "object" && v.display_preference?.preference === "on")
    .map(([k]) => k)
    .sort();

const off = (params) =>
  Object.entries(params)
    .filter(([, v]) => v && typeof v === "object" && v.display_preference?.preference === "off")
    .map(([k]) => k)
    .sort();

test("a card-saving form offers card + both wallets, and nothing else", async () => {
  invalidatePaymentMethodConfigs();
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  const id = await defaultPaymentMethodConfig("setup");
  assert.equal(id, "pmc_1");
  // Klarna is not a reusable payment method, so a form that SAVES one must not
  // offer it however the account is configured. SEPA is dropped for the same
  // reason this list is explicit rather than inherited.
  assert.deepEqual(on(stripe.created[0]), ["apple_pay", "card", "google_pay"]);
  assert.equal(stripe.created[0].name, "billing-tools: card and wallets");
});

test("paying offers the same three, NOT whatever the Dashboard has on", async () => {
  invalidatePaymentMethodConfigs();
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  await defaultPaymentMethodConfig("payment");
  // SEPA is on in this fake account and still does not appear. Inheriting the
  // account's list put a row of tabs (Klarna, Amazon Pay, Satispay) in front of
  // every customer of an app that had always shown one field — a method reaches
  // a customer because someone chose to sell that way, not because a Dashboard
  // toggle was left on. Selling via SEPA means passing a configuration.
  assert.deepEqual(on(stripe.created[0]), ["apple_pay", "card", "google_pay"]);
  assert.deepEqual(off(stripe.created[0]), []);
});

test("both kinds share one configuration, so it is provisioned once", async () => {
  invalidatePaymentMethodConfigs();
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  const a = await defaultPaymentMethodConfig("setup");
  const b = await defaultPaymentMethodConfig("payment");
  assert.equal(a, b);
  assert.equal(stripe.created.length, 1);
});

test("config.paymentMethods.link opts back into Stripe's behaviour", async () => {
  invalidatePaymentMethodConfigs();
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  const id = await defaultPaymentMethodConfig("payment", { paymentMethods: { link: true } });
  assert.equal(id, undefined, "no configuration should be imposed");
  assert.equal(stripe.created.length, 0, "and none provisioned");
});

test("a key that cannot read configurations degrades, it does not throw", async () => {
  invalidatePaymentMethodConfigs();
  __setStripeForTests(fakeStripe({ failList: true }));

  // A restricted key missing this permission must not take down checkout: the
  // form renders with the account default instead.
  assert.equal(await defaultPaymentMethodConfig("payment"), undefined);
});

test("an existing configuration is reused, not duplicated", async () => {
  invalidatePaymentMethodConfigs();
  const stripe = fakeStripe({
    existing: [{ id: "pmc_saved", name: "billing-tools: card and wallets", active: true }],
  });
  __setStripeForTests(stripe);

  assert.equal(await defaultPaymentMethodConfig("setup"), "pmc_saved");
  assert.equal(stripe.created.length, 0);
});
