// One purchase, four ways to pay for it.
//
// Every one of these existed as a different shape or not at all: `checkout` and `embedded`
// were a `uiMode` on one function, the off-session charge lived only inside `tryAutoReload`
// (threshold-triggered, uncallable), and the emailed invoice did not exist. So a consumer
// with a browser wrote its own purchase and a caller without one had a single answer — a
// link — and only one of the two implementations carried the app's settlement.
//
// `saved_card` is the only path that is headless END TO END: no URL, no human, no browser.
// `invoice` is the one that works with NO card, which is exactly what `saved_card` cannot
// bootstrap.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests, purchaseCredits } from "../dist/billing.js";
import { stripeList } from "./helpers.mjs";

const config = { currency: "eur", baseUrl: "https://app.test", internalDomains: [] };

/** Records everything asked of Stripe; that IS the behaviour under test. */
function fakeStripe({
  cards = [],
  email = "team@acme.test",
  payStatus = "paid",
  payThrows = null,
  /** What Stripe ate off the customer's balance to settle the invoice, in minor
   *  units — negative, exactly as `starting_balance` reports it. */
  startingBalance = 0,
} = {}) {
  const calls = { items: [], invoices: [], paid: [], finalized: [], sent: [], credits: [], sessions: [] };
  return {
    calls,
    customers: {
      async retrieve() {
        return { deleted: false, email, balance: 0, currency: "eur", metadata: {} };
      },
      async createBalanceTransaction(_c, params, opts) {
        calls.credits.push({ ...params, key: opts?.idempotencyKey });
        return { id: "cbt_1" };
      },
    },
    paymentMethods: { list: async () => ({ data: cards }) },
    invoiceItems: { create: async (p) => (calls.items.push(p), { id: "ii_1" }) },
    invoices: {
      create: async (p) => (calls.invoices.push(p), { id: "in_1", ...p }),
      pay: async (id, o) => {
        calls.paid.push({ id, ...o });
        if (payThrows) throw new Error(payThrows);
        return {
          id,
          status: payStatus,
          starting_balance: startingBalance,
          metadata: calls.invoices.at(-1)?.metadata,
        };
      },
      finalizeInvoice: async (id) => (calls.finalized.push(id), { id, status: "open" }),
      sendInvoice: async (id) => (
        calls.sent.push(id),
        {
          id,
          status: "open",
          hosted_invoice_url: "https://invoice.stripe.com/i/x",
          due_date: Math.floor(Date.UTC(2026, 7, 20) / 1000),
        }
      ),
    },
    checkout: {
      sessions: {
        create: async (p) => (
          calls.sessions.push(p),
          { id: "cs_1", url: "https://checkout.stripe.com/c/x", client_secret: "cs_1_secret_y" }
        ),
      },
    },
    paymentMethodConfigurations: { list: () => stripeList([]) },
  };
}

const noTax = { taxRates: [] };

test("saved_card charges the card on file and credits, with no URL anywhere", async () => {
  const s = fakeStripe({ cards: [{ id: "pm_1" }] });
  __setStripeForTests(s);

  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "saved_card", tax: noTax });

  assert.equal(out.status, "charged");
  assert.equal(out.credits, 2000, "1 unit of currency = 100 credits");
  assert.equal(s.calls.invoices[0].collection_method, "charge_automatically");
  assert.deepEqual(s.calls.paid[0], { id: "in_1", off_session: true });
  // Credited synchronously, because the charge already happened — and on the SAME key the
  // webhook will use, so the event that follows cannot credit it twice.
  assert.equal(s.calls.credits[0].amount, -2000);
  assert.equal(s.calls.credits[0].key, "credit:invoice:in_1");
});

test("a saved-card purchase repays the credits the invoice ATE", async () => {
  // Stripe applies the customer's credit balance to any invoice it finalizes,
  // and this library's wallet IS that balance. Measured headless against a real
  // account: a customer holding 100 credits bought 2 000, paid the full $20,
  // and ended on 2 000 — their 100 silently gone. The webhook path already
  // corrected for this (`creditsOwedFor`); the synchronous off-session credit,
  // which runs FIRST and owns the idempotency key, did not.
  const s = fakeStripe({ cards: [{ id: "pm_1" }], startingBalance: -100 });
  __setStripeForTests(s);

  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "saved_card", tax: noTax });

  assert.equal(out.status, "charged");
  assert.equal(out.credits, 2000, "what was SOLD is what the caller is told");
  assert.equal(s.calls.credits[0].amount, -2100, "what is GRANTED is the sale plus what was eaten");
});

test("…and refuses with the other method named when there is no card", async () => {
  __setStripeForTests(fakeStripe({ cards: [] }));
  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "saved_card", tax: noTax });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "no_card");
  assert.match(out.message, /method "invoice"/);
  assert.match(out.message, /payment_method_update/);
});

test("a decline is an answer, not a crash", async () => {
  // The caller can switch method or send the customer to fix the card; a throw here would
  // reach an agent as a 500 and tell it nothing.
  __setStripeForTests(fakeStripe({ cards: [{ id: "pm_1" }], payThrows: "Your card was declined." }));
  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "saved_card", tax: noTax });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "charge_failed");
  assert.match(out.message, /declined/);
});

test("invoice gets finalized and SENT, and carries the credits for the webhook", async () => {
  const s = fakeStripe({ cards: [] }); // no card at all — the case saved_card cannot serve
  __setStripeForTests(s);

  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "invoice", tax: noTax });

  assert.equal(out.status, "invoiced");
  assert.equal(out.emailed, true);
  assert.equal(out.hostedInvoiceUrl, "https://invoice.stripe.com/i/x");
  assert.equal(s.calls.invoices[0].collection_method, "send_invoice");
  assert.equal(s.calls.invoices[0].days_until_due, 7);
  // Finalize THEN send: a draft has no number, no hosted page and nothing to pay.
  assert.deepEqual(s.calls.finalized, ["in_1"]);
  assert.deepEqual(s.calls.sent, ["in_1"]);
  // Nothing is credited yet — the customer has not paid.
  assert.deepEqual(s.calls.credits, []);
  // And this is what lets the webhook credit it when they do.
  assert.equal(s.calls.invoices[0].metadata.credits, "2000");
});

test("Stripe cannot email a customer with no address, and says so rather than sending nothing", async () => {
  __setStripeForTests(fakeStripe({ email: null }));
  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "invoice", tax: noTax });
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "no_email");
});

test("checkout returns a URL, embedded a secret — and both return the session id", async () => {
  const s = fakeStripe();
  __setStripeForTests(s);

  const hosted = await purchaseCredits("cus_1", "org_1", 20, config, { method: "checkout", tax: noTax });
  assert.equal(hosted.url, "https://checkout.stripe.com/c/x");
  assert.equal(hosted.sessionId, "cs_1");

  const embedded = await purchaseCredits("cus_1", "org_1", 20, config, { method: "embedded", tax: noTax });
  assert.equal(embedded.clientSecret, "cs_1_secret_y");
  // The id used to be recoverable only by splitting the client secret on "_secret_" —
  // a consumer really did that, in production, with a comment apologising for it.
  assert.equal(embedded.sessionId, "cs_1");
});

test("an account that cannot EMAIL still hands back a payable invoice", async () => {
  // Stripe answers "This invoice cannot be sent right now" on an account not yet activated
  // for invoice emails. The invoice is finalized and payable regardless, so throwing there
  // would lose its hosted URL to a failure that is Stripe's and not the customer's — a real
  // bill would exist and the caller would know only that something went wrong. Found by
  // running this against a live test account.
  const s = fakeStripe();
  s.invoices.sendInvoice = async () => {
    throw new Error("This invoice cannot be sent right now.");
  };
  s.invoices.finalizeInvoice = async (id) => ({
    id,
    status: "open",
    hosted_invoice_url: "https://invoice.stripe.com/i/finalized",
  });
  __setStripeForTests(s);

  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "invoice", tax: noTax });
  assert.equal(out.status, "invoiced");
  assert.equal(out.emailed, false, "and it says so, rather than claiming an email was sent");
  assert.equal(out.hostedInvoiceUrl, "https://invoice.stripe.com/i/finalized");
});
