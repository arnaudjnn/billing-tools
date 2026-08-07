// Where a portal link LANDS.
//
// This link is the library's answer to the one thing that genuinely cannot be done
// headlessly: entering a card. A caller with no browser cannot confirm a SetupIntent — it
// can only produce a URL. Which makes WHERE the URL opens the whole quality of the answer:
// the portal root is a menu the customer then has to navigate, and `payment_method_update`
// is the form they were sent for.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests, createBillingPortalSession } from "../dist/billing.js";

/** Captures what was asked of Stripe, since that IS the behaviour here. */
function stripe(calls) {
  return {
    billingPortal: {
      sessions: {
        async create(params) {
          calls.push(params);
          return { url: "https://billing.stripe.com/session/x" };
        },
      },
    },
  };
}

test("no flow is the portal home, and sends no flow_data at all", async () => {
  const calls = [];
  __setStripeForTests(stripe(calls));
  await createBillingPortalSession("cus_1", "https://app.test/back");
  assert.equal("flow_data" in calls[0], false, "an empty flow_data is not the same as none");
  assert.deepEqual(calls[0], { customer: "cus_1", return_url: "https://app.test/back" });
});

test("payment_method_update opens on the card form, and needs no subscription", async () => {
  const calls = [];
  __setStripeForTests(stripe(calls));
  await createBillingPortalSession("cus_1", "https://app.test/back", {
    flow: "payment_method_update",
  });
  assert.deepEqual(calls[0].flow_data, { type: "payment_method_update" });
});

test("the subscription flows carry the subscription Stripe requires", async () => {
  const calls = [];
  __setStripeForTests(stripe(calls));
  await createBillingPortalSession("cus_1", "https://app.test/back", {
    flow: "subscription_cancel",
    subscriptionId: "sub_1",
  });
  assert.deepEqual(calls[0].flow_data, {
    type: "subscription_cancel",
    subscription_cancel: { subscription: "sub_1" },
  });
});
