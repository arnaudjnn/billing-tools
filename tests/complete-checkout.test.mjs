// AFTER the payment — the five steps, and what each one costs when it is skipped.
//
// Opening a Checkout Session was always the library's; finishing one was every consumer's, so
// the first app to do it wrote this three times (signup, plan change, credit top-up) and each
// copy did a different subset. These pin the composite, and the two steps nobody thinks of:
// stamping `org_id` on a subscription bought before the workspace existed, and putting the
// billing address back after Checkout replaced it with the payer's.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { completeCheckout } from "../dist/complete-checkout.js";
// A local adapter, not the shared `fakeAdapter`: this is a test about WRITES, and that one
// answers `getBillingCustomerId` with a constant and swallows the setter — so it cannot express
// "the org has no customer yet", which is the case that matters most here.
function storingAdapter(initial = {}) {
  const state = { customerId: null, subscription: null, profile: null, ...initial };
  return {
    state,
    async validateApiKey() {
      return { orgId: "org_1" };
    },
    async getOrgDomains() {
      return [];
    },
    async getBillingCustomerId() {
      return state.customerId;
    },
    async setBillingCustomerId(_orgId, id) {
      state.customerId = id;
    },
    async getSubscription() {
      return state.subscription;
    },
    async setSubscription(_orgId, sub) {
      state.subscription = sub;
    },
    async getOrgMetadata() {
      return {};
    },
    async setOrgMetadata() {},
  };
}

const PERIOD = { current_period_start: 1_760_000_000, current_period_end: 1_762_678_400 };

/** A Stripe whose session/subscription state a test can state outright. */
function stripeWith({
  status = "complete",
  subStatus = "active",
  metadata = {},
  subMetadata = {},
  customer = "cus_1",
  priceMeta = { plan: "pro" },
  /** The subscription's items, as Stripe returns them — what was BOUGHT. */
  items = [{ price: { id: "price_1" }, ...PERIOD }],
} = {}) {
  const updates = [];
  __setStripeForTests({
    updates,
    checkout: {
      sessions: {
        async retrieve() {
          return {
            status,
            mode: "subscription",
            metadata,
            customer,
            subscription: { id: "sub_1", status: subStatus },
          };
        },
      },
    },
    subscriptions: {
      async retrieve() {
        return {
          id: "sub_1",
          status: subStatus,
          metadata: subMetadata,
          items: { data: items },
        };
      },
      async update(id, params) {
        updates.push({ id, params });
        return { id };
      },
    },
    prices: {
      async retrieve() {
        return { id: "price_1", metadata: priceMeta };
      },
    },
    customers: {
      async retrieve() {
        return { id: "cus_1", metadata: {}, balance: 0, currency: "eur" };
      },
      async update() {
        return { id: "cus_1" };
      },
    },
  });
  return updates;
}

beforeEach(() => stripeWith());

test("an unpaid session records NOTHING", async () => {
  // The first step, and the one a return URL makes easy to skip: a tab coming back is not a
  // payment. Everything below it writes to the org, so a false `paid` grants a plan nobody
  // bought.
  stripeWith({ status: "open", subStatus: "incomplete" });
  const adapter = storingAdapter();
  const res = await completeCheckout(adapter, "cs_1", { orgId: "org_1" });

  assert.equal(res.paid, false);
  assert.equal(res.plan, null);
  assert.equal(adapter.state.subscription, null, "no plan was mirrored");
});

test("the customer is attached when the org has none", async () => {
  const adapter = storingAdapter();
  const res = await completeCheckout(adapter, "cs_1", { orgId: "org_1" });
  assert.equal(res.paid, true);
  assert.equal(adapter.state.customerId, "cus_1");
});

test("and an existing pointer is NEVER overwritten — it is warned about", async () => {
  // Repointing a workspace at another customer would hand it somebody else's invoices and
  // credit balance. Silence here would make that look like success.
  const adapter = storingAdapter({ customerId: "cus_other" });
  const res = await completeCheckout(adapter, "cs_1", { orgId: "org_1" });

  assert.equal(adapter.state.customerId, "cus_other");
  assert.match(res.warnings.join(" "), /already points at cus_other/);
});

test("`org_id` is stamped on a subscription that was bought before the workspace existed", async () => {
  // The signup path CANNOT set it at create time — there is no workspace yet. Without it every
  // sync handler reads `subscription.metadata.org_id` as undefined and silently does nothing:
  // no plan mirrored on renewal, no `past_due`, no per-cycle credit grant. Silent for the life
  // of the subscription.
  const updates = stripeWith({ subMetadata: {} });
  await completeCheckout(storingAdapter(), "cs_1", { orgId: "org_1" });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].params.metadata.org_id, "org_1");
});

test("and not re-stamped when it is already right", async () => {
  const updates = stripeWith({ subMetadata: { org_id: "org_1" } });
  await completeCheckout(storingAdapter(), "cs_1", { orgId: "org_1" });
  assert.equal(updates.length, 0, "idempotent: a reloaded return URL writes nothing");
});

test("the plan is mirrored now, not when the webhook lands", async () => {
  // The customer is looking at the page that says what they just bought. Waiting for the event
  // means the meter resolves the OLD plan until it arrives — and `planModel(plans, null)` is
  // null, so a workspace that just paid for a pool metered as though it had none.
  const adapter = storingAdapter();
  const res = await completeCheckout(adapter, "cs_1", { orgId: "org_1" });

  assert.equal(res.plan, "pro");
  const sub = adapter.state.subscription;
  assert.equal(sub.plan, "pro");
  assert.equal(sub.status, "active");
  assert.equal(sub.subscriptionId, "sub_1");
  assert.equal(
    sub.periodEnd,
    new Date(PERIOD.current_period_end * 1000).toISOString(),
    "the period comes off the ITEM, where this API version keeps it",
  );
});

test("…and so is WHAT WAS BOUGHT, by seat type", async () => {
  // The only moment the signup flow knows the subscription AND the org:
  // `customer.subscription.created` fires before an org exists to stamp
  // `org_id` on, so the sync handler drops it and no later subscription event
  // ever fires for a subscription nobody touches. Without this, `seatCounts`
  // stayed null for the life of the workspace and everything measured against
  // it read UNKNOWN — `seatAssignable` fails open there, so the dearest seat
  // was free. Measured in a browser: 3 Standard bought, Premium accepted.
  const adapter = storingAdapter();
  stripeWith({
    items: [
      { price: { id: "price_std", metadata: { seatType: "standard" } }, quantity: 3, ...PERIOD },
      { price: { id: "price_prem", metadata: { seatType: "premium" } }, quantity: 1, ...PERIOD },
    ],
  });
  await completeCheckout(adapter, "cs_1", { orgId: "org_1", plan: "pro" });

  assert.deepEqual(adapter.state.subscription.seatCounts, { standard: 3, premium: 1 });
});

test("an explicit plan wins over the price lookup", async () => {
  // For a catalogue whose price metadata cannot answer — a price minted before this library
  // managed them.
  stripeWith({ priceMeta: {} });
  const adapter = storingAdapter();
  const res = await completeCheckout(adapter, "cs_1", { orgId: "org_1", plan: "scale" });
  assert.equal(res.plan, "scale");
  assert.equal(adapter.state.subscription.plan, "scale");
});

// ── the billing address Checkout overwrites ──────────────────────────────────

test("the workspace's billing address is restored when the payer's was not meant to replace it", async () => {
  // Checkout writes the payer's name and address onto the CUSTOMER because Stripe Tax computes
  // zero tax without a location on it — and those are the very fields that ARE the workspace's
  // billing address and company name. Paying with a personal address silently replaced the
  // team's, and it cannot be prevented during the payment: undoing it afterwards is the honest
  // version of "no".
  const prev = { line1: "Via Roma 1", city: "Savona", postal_code: "17100", country: "IT" };
  stripeWith({
    metadata: {
      prev_billing_address: JSON.stringify(prev),
      prev_billing_name: "Scartoffie Srl",
    },
  });
  const updates = [];
  const adapter = storingAdapter();
  stripeWith({
    metadata: {
      prev_billing_address: JSON.stringify(prev),
      prev_billing_name: "Scartoffie Srl",
    },
  });
  const stripe = (await import("../dist/billing.js")).getStripe();
  stripe.customers.update = async (id, params) => {
    updates.push(params);
    return { id };
  };

  await completeCheckout(adapter, "cs_1", { orgId: "org_1", keepBillingAddress: false });

  assert.equal(updates.length, 1, "the profile was written back");
  assert.equal(updates[0].name, "Scartoffie Srl");
  assert.deepEqual(updates[0].address, prev);
});

test("and left alone by default, which is what most purchases mean", async () => {
  stripeWith({
    metadata: { prev_billing_address: JSON.stringify({ country: "IT" }), prev_billing_name: "X" },
  });
  const updates = [];
  const stripe = (await import("../dist/billing.js")).getStripe();
  stripe.customers.update = async (id, params) => {
    updates.push(params);
    return { id };
  };

  await completeCheckout(storingAdapter(), "cs_1", { orgId: "org_1" });
  assert.equal(updates.length, 0);
});

// ── the signup shape ─────────────────────────────────────────────────────────

test("with no orgId it verifies and hands back the metadata, writing nothing", async () => {
  // Signup: the workspace does not exist until this returns, so the caller creates it from
  // what the session carried and calls again with the org. Every step is idempotent for
  // exactly that reason.
  stripeWith({ metadata: { workspace_name: "Acme", user_id: "usr_1" } });
  const adapter = storingAdapter();
  const res = await completeCheckout(adapter, "cs_1");

  assert.equal(res.paid, true);
  assert.equal(res.metadata.workspace_name, "Acme");
  assert.equal(res.metadata.user_id, "usr_1");
  assert.equal(adapter.state.subscription, null, "nothing was recorded against an org");
});

test("a failed step is a WARNING, never a refusal — the payment already succeeded", async () => {
  // The money moved. Refusing here would leave a customer charged and unprovisioned, which is
  // the one outcome worse than an unfinished mirror.
  const adapter = storingAdapter();
  adapter.setSubscription = async () => {
    throw new Error("metadata store unavailable");
  };
  const res = await completeCheckout(adapter, "cs_1", { orgId: "org_1" });

  assert.equal(res.paid, true, "still paid");
  assert.match(res.warnings.join(" "), /plan not mirrored: metadata store unavailable/);
});
