// Who draws the form, and what comes back.
//
// Elements mode returns a CLIENT SECRET, which only a browser running Stripe.js can
// do anything with. That was the only mode, so a caller with no browser — an agent
// on `change_plan`, arriving at exactly the first-purchase case that needs a
// checkout — was handed a value it could not use. The consumer's answer was a
// hand-rolled `checkout.sessions.create` next to this one, which is how a second
// checkout path appears that inherits neither the deployment's tax nor its
// payment-method configuration and quietly bills 0%.
//
// So hosted mode exists, and what these assert is that it is the SAME session with a
// different front door: same tax, same methods, same metadata.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { createCheckoutSession } from "../dist/checkout.js";
import { __setPlanPricesForTests, lookupKeyFor } from "../dist/plans.js";
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

function fakeStripe() {
  const sessions = [];
  return {
    sessions,
    checkout: {
      sessions: {
        async create(params) {
          sessions.push(params);
          // Stripe returns a url for a hosted session and a client secret for an
          // elements one; the fake mirrors that so a mode reading the wrong field
          // shows up as null rather than passing on the other mode's value.
          return params.ui_mode
            ? { id: "cs_1", client_secret: "cs_secret", url: null }
            : { id: "cs_1", client_secret: null, url: "https://checkout.stripe.com/c/pay/cs_1" };
        },
      },
    },
    customers: {
      async retrieve() {
        return { id: "cus_1", address: { country: "IT" }, tax_ids: { data: [] } };
      },
    },
    taxRates: {
      list() {
        return stripeList([]);
      },
      async create(params) {
        return { id: "txr_1", ...params };
      },
    },
    paymentMethodConfigurations: {
      list() {
        throw new Error("permission denied");
      },
    },
  };
}

const open = async (extra = {}) => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const result = await createCheckoutSession({
    plans: PLANS,
    plan: "pro",
    interval: "monthly",
    seats: { standard: 1 },
    returnUrl: "https://t.local/done",
    customerId: "cus_1",
    currency: "eur",
    taxRates: ["txr_it_22"],
    metadata: { org_id: "org_1" },
    ...extra,
  });
  return { params: stripe.sessions[0], result };
};

test("elements stays the default, and keeps returning a client secret", async () => {
  const { params, result } = await open();
  assert.equal(params.ui_mode, "custom");
  assert.equal(params.return_url, "https://t.local/done");
  assert.equal(params.success_url, undefined, "an elements session has no hosted page");
  assert.equal(result.clientSecret, "cs_secret");
  assert.equal(result.url, null);
});

test("hosted returns a URL a caller with no browser can open", async () => {
  const { params, result } = await open({ uiMode: "hosted" });
  assert.equal(params.ui_mode, undefined, "hosted is Stripe's own page, not a ui_mode");
  assert.equal(params.success_url, "https://t.local/done");
  // `cancel_url` falls back to the same place: a customer who backs out has to land
  // somewhere, and a session without it is Stripe's error, not a default worth
  // making the caller state.
  assert.equal(params.cancel_url, "https://t.local/done");
  assert.equal(result.url, "https://checkout.stripe.com/c/pay/cs_1");
});

test("hosted is the same session — same tax, same methods, same metadata", async () => {
  // The whole point. A second, hand-rolled hosted session is how a deployment ends
  // up charging 22% on every form and 0% on the one an agent uses.
  const elements = await open();
  const hosted = await open({ uiMode: "hosted" });

  for (const key of [
    "line_items",
    "automatic_tax",
    "tax_id_collection",
    "payment_method_types",
    "metadata",
    "subscription_data",
    "customer_update",
    "billing_address_collection",
  ]) {
    assert.deepEqual(hosted.params[key], elements.params[key], `${key} differs between modes`);
  }
  assert.deepEqual(hosted.params.line_items[0].tax_rates, ["txr_it_22"]);
});

test("`config` is a real input, not one only the tests could pass", async () => {
  // The body always read `opts.config`; the public TYPE did not carry it, so no
  // TypeScript caller could hand it over and every seat session resolved tax as if
  // no declaration existed — right by luck where the Stripe account's country is the
  // establishment, silently wrong for `mode: "none"` and for registrations.
  const { params } = await open({
    taxRates: undefined,
    config: { baseUrl: "https://t.local", currency: "eur", tax: { mode: "none" } },
  });
  assert.deepEqual(params.automatic_tax, { enabled: false });
  assert.equal(params.line_items[0].tax_rates, undefined, "`mode: none` still taxed the line");
});

test("a reused session is never handed to the other mode", async () => {
  // `reuse` keys on everything that shapes the session. Without the mode in that
  // key, a caller asking for a URL would be handed the elements session opened a
  // moment earlier and read `url: null` as Stripe's fault.
  await open({ reuse: true });
  const { result } = await open({ uiMode: "hosted", reuse: true });
  assert.equal(result.url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(result.clientSecret, null);
});
