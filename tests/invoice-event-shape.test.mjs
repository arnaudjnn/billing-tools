// Where an invoice says which subscription it belongs to — which MOVED.
//
// `invoice.subscription` is gone in the API version this SDK pins (2026-02-25): it is now
// `invoice.parent.subscription_details.subscription`, the same kind of relocation as
// `current_period_end` moving off `Subscription` onto `SubscriptionItem`. Both invoice branches
// of the event handler opened with `if (!invoice.subscription) return`, so against a real
// account they returned immediately, every time:
//
//   • `invoice.paid` never granted renewal credits — a plan with a `grant` gave a paying
//     subscriber nothing, monthly, silently.
//   • `invoice.payment_failed` never recorded `past_due` and never fired `onPaymentFailed`.
//
// Found by replaying a real event (`scripts/live/11-refusals-and-dunning.mjs`), because a fake
// built from the same wrong assumption agreed with it. These tests use BOTH payload shapes, so
// the handler cannot regress to reading only one.

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { __setPlanPricesForTests } from "../dist/plans.js";
import { createStripeEventHandler } from "../dist/sync.js";

const PLANS = {
  team: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 } } },
    // `purchased_seats` so a renewal SHOULD credit — the branch whose silence was the defect.
    grant: { kind: "purchased_seats" },
    cap: { kind: "wallet" },
    sale: "self_serve",
  },
};

function fakeStripe() {
  const granted = [];
  return {
    granted,
    subscriptions: {
      async retrieve(id) {
        return {
          id,
          status: "past_due",
          metadata: { org_id: "org_1", plan: "team" },
          current_period_end: 1_800_000_000,
          // `metadata.seatType` on the ITEM's price is how seats are counted for the grant —
          // without it `purchased_seats` sums to zero and credits nothing, which would have
          // made this test agree with the bug for a second, unrelated reason.
          items: {
            data: [
              {
                price: { id: "price_team_standard_monthly", metadata: { seatType: "standard", plan: "team" } },
                quantity: 3,
              },
            ],
          },
        };
      },
    },
    customers: {
      async createBalanceTransaction(customerId, params, opts) {
        granted.push({ customerId, amount: params.amount, key: opts?.idempotencyKey });
        return { id: "cbtxn_1" };
      },
      async retrieve() {
        return { id: "cus_1", balance: 0, currency: "eur" };
      },
    },
    prices: {
      async *list() {},
      // `planForPriceId` retrieves the price and reads `metadata.plan` — without this the
      // grant branch resolves no plan and returns, which is the very silence being tested.
      async retrieve(id) {
        return { id, metadata: { plan: "team", seatType: "standard", interval: "monthly" } };
      },
    },
  };
}

/** The CURRENT shape: the subscription (and its metadata) hang off `parent`. */
const modern = (type, extra = {}) => ({
  type,
  data: {
    object: {
      id: "in_1",
      customer: "cus_1",
      billing_reason: "subscription_cycle",
      parent: {
        subscription_details: {
          subscription: "sub_1",
          metadata: { org_id: "org_1", plan: "team" },
        },
      },
      ...extra,
    },
  },
});

/** The OLD shape, still handled so the fix works either side of the version change. */
const legacy = (type, extra = {}) => ({
  type,
  data: {
    object: {
      id: "in_1",
      customer: "cus_1",
      billing_reason: "subscription_cycle",
      subscription: "sub_1",
      ...extra,
    },
  },
});

let recorded;
const adapter = {
  async getBillingCustomerId() {
    return "cus_1";
  },
  async setSubscription(orgId, patch) {
    recorded.push({ orgId, patch });
  },
  async getSubscription() {
    return null;
  },
  async getOrgMetadata() {
    return {};
  },
  async setOrgMetadata() {},
};

beforeEach(() => {
  recorded = [];
  __setPlanPricesForTests(new Map([["team_monthly_standard", "price_team_standard_monthly"]]));
});

test("payment_failed records past_due from the CURRENT payload shape", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const failed = [];
  const handle = createStripeEventHandler({
    adapter,
    plans: PLANS,
    currency: "eur",
    hooks: { onPaymentFailed: async (orgId) => failed.push(orgId) },
  });

  await handle(modern("invoice.payment_failed"));

  assert.equal(recorded.length, 1, "silence here is an app that cannot tell its customer is behind");
  assert.equal(recorded[0].patch.status, "past_due");
  assert.deepEqual(failed, ["org_1"]);
});

test("and from the legacy shape, so the handler spans the version change", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const failed = [];
  const handle = createStripeEventHandler({
    adapter,
    plans: PLANS,
    currency: "eur",
    hooks: { onPaymentFailed: async (orgId) => failed.push(orgId) },
  });

  await handle(legacy("invoice.payment_failed"));

  assert.equal(recorded[0]?.patch.status, "past_due");
  assert.deepEqual(failed, ["org_1"]);
});

test("invoice.paid grants the renewal's credits from the CURRENT shape", async () => {
  // 3 seats × 1000 included credits, so `purchased_seats` grants 3000. Reading the old field
  // meant this branch returned before granting anything, every month.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const handle = createStripeEventHandler({ adapter, plans: PLANS, currency: "eur" });

  await handle(modern("invoice.paid"));

  assert.equal(stripe.granted.length, 1, "a paying subscriber received nothing");
  assert.equal(stripe.granted[0].amount, -3000, "negative = credit");
});

test("a top-up invoice with no subscription is still ignored", async () => {
  // The early return has to survive the fix: a one-off purchase must not be mistaken for a
  // renewal, or it would be credited twice (checkout.session.completed already handles it).
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const handle = createStripeEventHandler({ adapter, plans: PLANS, currency: "eur" });

  await handle({
    type: "invoice.payment_failed",
    data: { object: { id: "in_topup", customer: "cus_1", parent: null } },
  });

  assert.deepEqual(recorded, []);
});

test("the org id can come from the invoice's own parent metadata", async () => {
  // `parent.subscription_details.metadata` carries the subscription's metadata, so `org_id` is
  // resolvable even when the retrieved subscription has lost it.
  const stripe = fakeStripe();
  stripe.subscriptions.retrieve = async (id) => ({
    id,
    status: "past_due",
    metadata: {}, // no org_id here
    current_period_end: 1_800_000_000,
    items: { data: [{ price: { id: "price_team_standard_monthly" }, quantity: 1 }] },
  });
  __setStripeForTests(stripe);
  const handle = createStripeEventHandler({ adapter, plans: PLANS, currency: "eur" });

  await handle(modern("invoice.payment_failed"));

  assert.equal(recorded[0]?.orgId, "org_1");
});

test("an expanded subscription object on parent is read by id", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const handle = createStripeEventHandler({ adapter, plans: PLANS, currency: "eur" });

  await handle({
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_1",
        customer: "cus_1",
        parent: { subscription_details: { subscription: { id: "sub_1" }, metadata: { org_id: "org_1" } } },
      },
    },
  });

  assert.equal(recorded[0]?.patch.subscriptionId, "sub_1");
});
