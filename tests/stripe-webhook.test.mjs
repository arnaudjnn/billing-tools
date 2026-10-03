// The Stripe webhook route: the one place a customer's money becomes credits as it lands.
//
// What it must guarantee, each asserted against the request a real Stripe sends — signed
// with the real SDK's own test-header helper, so a signature this file accepts is one
// `constructEvent` really verified:
//   • a purchase is credited ONCE, however often Stripe re-delivers it (it retries for
//     three days, and the poller's catch-up sweep replays the same event);
//   • nothing is credited for a request Stripe did not sign;
//   • nothing is credited before the money exists. A delayed method (SEPA Debit, a bank
//     transfer) completes the Checkout session `unpaid` and pays days later.
//
// The fake Stripe honours idempotency keys the way the API does — a replay of a key returns
// the first result and writes nothing — so "credited once" is the BALANCE, not a count of
// calls the test chose to make.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import Stripe from "stripe";

import { __setStripeForTests } from "../dist/billing.js";
import { createStripeWebhookHandler } from "../dist/routes/webhook.js";
import { createStripeEventHandler, PAYMENT_EVENT_TYPES } from "../dist/sync.js";
import { BILLING_WEBHOOK_EVENTS } from "../dist/webhook-setup.js";

const SECRET = "whsec_test_secret";
const real = new Stripe("sk_test_fake");

/** A Stripe whose customer balance is a ledger keyed the way the API keys it. */
function ledgerStripe() {
  const byKey = new Map();
  const txns = [];
  return {
    txns,
    webhooks: real.webhooks,
    customers: {
      async createBalanceTransaction(customer, params, options) {
        const key = options?.idempotencyKey;
        if (key && byKey.has(key)) return byKey.get(key);
        const txn = { id: `cbtxn_${txns.length + 1}`, customer, ...params, key };
        txns.push(txn);
        if (key) byKey.set(key, txn);
        return txn;
      },
    },
    balanceOf(customer) {
      return -txns.filter((t) => t.customer === customer).reduce((s, t) => s + t.amount, 0);
    },
  };
}

function event(type, object, id = `evt_${Math.random().toString(36).slice(2)}`) {
  return { id, object: "event", type, data: { object } };
}

function topUpSession(overrides = {}) {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    customer: "cus_1",
    metadata: { org_id: "org_1", credits: "500" },
    ...overrides,
  };
}

/** A request exactly as Stripe sends it: raw JSON body, `stripe-signature` header. */
function signed(evt, { secret = SECRET, body } = {}) {
  const payload = body ?? JSON.stringify(evt);
  const header = real.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("https://app.test/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

let stripe;
let savedSecret;
beforeEach(() => {
  savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  stripe = ledgerStripe();
  __setStripeForTests(stripe);
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
  __setStripeForTests(undefined);
});

// ── credited exactly once ────────────────────────────────────────────────────

test("a completed top-up checkout credits the customer, keyed on the session", async () => {
  const handler = createStripeWebhookHandler({ currency: "eur" });
  const res = await handler(signed(event("checkout.session.completed", topUpSession())));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  assert.equal(stripe.balanceOf("cus_1"), 500);
  assert.equal(stripe.txns[0].currency, "eur");
  assert.equal(stripe.txns[0].key, "credit:checkout:cs_test_1");
});

test("a replayed delivery credits nothing more", async () => {
  const handler = createStripeWebhookHandler({ currency: "eur" });
  const evt = event("checkout.session.completed", topUpSession(), "evt_same");
  for (let i = 0; i < 3; i++) {
    const res = await handler(signed(evt));
    assert.equal(res.status, 200, "a replay is acknowledged, or Stripe keeps retrying it");
  }
  assert.equal(stripe.balanceOf("cus_1"), 500);
  assert.equal(stripe.txns.length, 1);
});

test("the webhook and the poller credit the same session under the same key", async () => {
  // The two delivery paths share a key so `reconcilePayments` can replay what the webhook
  // already credited. Were the keys to drift, every reconciled purchase would pay twice.
  const handler = createStripeWebhookHandler({ currency: "eur" });
  const evt = event("checkout.session.completed", topUpSession());
  await handler(signed(evt));
  await createStripeEventHandler({ adapter: {}, plans: {}, currency: "eur" })(evt);
  assert.equal(stripe.balanceOf("cus_1"), 500);
});

test("an expanded customer object is credited like a bare id", async () => {
  const handler = createStripeWebhookHandler();
  await handler(signed(event("checkout.session.completed", topUpSession({ customer: { id: "cus_9" } }))));
  assert.equal(stripe.balanceOf("cus_9"), 500);
  assert.equal(stripe.txns[0].currency, "usd", "the documented default currency");
});

test("a session carrying no credits, or no customer, credits nothing", async () => {
  const handler = createStripeWebhookHandler();
  await handler(signed(event("checkout.session.completed", topUpSession({ metadata: {} }))));
  await handler(signed(event("checkout.session.completed", topUpSession({ metadata: { credits: "-5" } }))));
  await handler(signed(event("checkout.session.completed", topUpSession({ customer: null }))));
  assert.equal(stripe.txns.length, 0);
});

// ── not before the money exists ──────────────────────────────────────────────

test("a delayed-payment session is NOT credited when it completes unpaid", async () => {
  // REGRESSION: `checkout.session.completed` was credited on arrival. For SEPA Debit that is
  // the moment the mandate is signed, days before the debit settles — or fails.
  const handler = createStripeWebhookHandler();
  const res = await handler(
    signed(event("checkout.session.completed", topUpSession({ payment_status: "unpaid" }))),
  );
  assert.equal(res.status, 200);
  assert.equal(stripe.txns.length, 0);
});

test("...and IS credited when the async payment succeeds, once", async () => {
  const handler = createStripeWebhookHandler();
  await handler(signed(event("checkout.session.completed", topUpSession({ payment_status: "unpaid" }))));
  const paid = event("checkout.session.async_payment_succeeded", topUpSession());
  await handler(signed(paid));
  await handler(signed(paid));
  assert.equal(stripe.balanceOf("cus_1"), 500);
  assert.equal(stripe.txns[0].key, "credit:checkout:cs_test_1");
});

test("a failed async payment credits nothing", async () => {
  const other = [];
  const handler = createStripeWebhookHandler({ onOtherEvent: (e) => other.push(e.type) });
  await handler(signed(event("checkout.session.completed", topUpSession({ payment_status: "unpaid" }))));
  await handler(
    signed(event("checkout.session.async_payment_failed", topUpSession({ payment_status: "unpaid" }))),
  );
  assert.equal(stripe.txns.length, 0);
  assert.deepEqual(other, ["checkout.session.async_payment_failed"], "handed to the app");
});

test("the poller applies the same rule to the same events", async () => {
  const handle = createStripeEventHandler({ adapter: {}, plans: {}, currency: "eur" });
  await handle(event("checkout.session.completed", topUpSession({ payment_status: "unpaid" })));
  assert.equal(stripe.txns.length, 0);
  await handle(event("checkout.session.async_payment_succeeded", topUpSession()));
  await handle(event("checkout.session.async_payment_succeeded", topUpSession()));
  assert.equal(stripe.balanceOf("cus_1"), 500);
});

test("the async success event is registered on the webhook and polled by the sweep", () => {
  // Handling an event Stripe is never asked to send is handling nothing.
  for (const list of [BILLING_WEBHOOK_EVENTS, PAYMENT_EVENT_TYPES]) {
    assert.ok(list.includes("checkout.session.async_payment_succeeded"));
    assert.ok(list.includes("checkout.session.completed"));
  }
});

// ── what it does not credit ──────────────────────────────────────────────────

test("a SUBSCRIPTION checkout is not credited here, and reaches the app", async () => {
  const other = [];
  const handler = createStripeWebhookHandler({ onOtherEvent: (e) => other.push(e.type) });
  await handler(signed(event("checkout.session.completed", topUpSession({ mode: "subscription" }))));
  assert.equal(stripe.txns.length, 0);
  assert.deepEqual(other, ["checkout.session.completed"]);
});

test("a library-issued credit invoice is credited once when paid, and also reaches the app", async () => {
  const other = [];
  const handler = createStripeWebhookHandler({ onOtherEvent: (e) => other.push(e.type) });
  const inv = { id: "in_1", object: "invoice", customer: "cus_1", metadata: { credits: "300" }, starting_balance: 0 };
  await handler(signed(event("invoice.paid", inv)));
  await handler(signed(event("invoice.paid", inv)));
  assert.equal(stripe.balanceOf("cus_1"), 300);
  assert.equal(stripe.txns[0].key, "credit:invoice:in_1");
  assert.equal(other.length, 2);
});

// ── refused before anything is read ──────────────────────────────────────────

test("a bad signature is refused with 400 and credits nothing", async () => {
  const handler = createStripeWebhookHandler();
  const res = await handler(signed(event("checkout.session.completed", topUpSession()), { secret: "whsec_other" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /signature verification failed/i);
  assert.equal(stripe.txns.length, 0);
});

test("a body altered after signing is refused", async () => {
  const handler = createStripeWebhookHandler();
  const original = event("checkout.session.completed", topUpSession());
  const header = real.webhooks.generateTestHeaderString({ payload: JSON.stringify(original), secret: SECRET });
  const forged = JSON.stringify(event("checkout.session.completed", topUpSession({ metadata: { credits: "999999" } }), original.id));
  const res = await handler(
    new Request("https://app.test/hook", { method: "POST", headers: { "stripe-signature": header }, body: forged }),
  );
  assert.equal(res.status, 400);
  assert.equal(stripe.txns.length, 0);
});

test("a missing signature header is a 400", async () => {
  const handler = createStripeWebhookHandler();
  const res = await handler(
    new Request("https://app.test/hook", { method: "POST", body: JSON.stringify(event("checkout.session.completed", topUpSession())) }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Missing signature" });
  assert.equal(stripe.txns.length, 0);
});

test("no signing secret configured is a 503, not a signature error", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const handler = createStripeWebhookHandler();
  const res = await handler(signed(event("checkout.session.completed", topUpSession())));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /STRIPE_WEBHOOK_SECRET unset/);
  assert.equal(stripe.txns.length, 0);
});
