// A credit sale is paid in CASH, in full — never out of the wallet it is topping up.
//
// Measured by testmode in Stripe TEST (customer cus_VN8Yri7hW6oKwr):
//   • an Enterprise quote, 10 000 credits for €70, on a wallet of 2 999: Stripe applied the
//     balance at finalization (`starting_balance -2999`), the card was charged €40.01, and
//     the grant then repaid the 2 999 — the customer kept every credit and paid €29.99 less;
//   • an auto-reload of 1 902 on a wallet of 12 998: charged €0, and granted TWICE — 1 902 by
//     the reload under its own key and 14 900 by `invoice.paid` under the invoice's.
// The e2e suite asserted the wallet delta and stayed green; this file asserts the CASH.
//
// The fake Stripe below does what the real one does where it matters:
//   • `finalizeInvoice` applies the customer's credit balance to the invoice (there is no
//     per-invoice opt-out), writing an `applied_to_invoice` transaction;
//   • a reused idempotency key returns the first result — and with DIFFERENT parameters it
//     is refused, which is how two paths "sharing a key" can still fail each other.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import Stripe from "stripe";

import { __setStripeForTests, purchaseCredits, sellCredits, tryAutoReload, getCreditBalance } from "../dist/billing.js";
import { createStripeWebhookHandler } from "../dist/routes/webhook.js";
import { createStripeEventHandler } from "../dist/sync.js";

afterEach(() => __setStripeForTests(undefined));

const SECRET = "whsec_cash";
const real = new Stripe("sk_test_fake");

function stripeAccount({ wallet = 0, autoReload = null, email = "billing@acme.test" } = {}) {
  const customer = {
    id: "cus_1",
    deleted: false,
    email,
    currency: "eur",
    balance: -wallet,
    metadata: autoReload
      ? {
          auto_reload_enabled: "true",
          auto_reload_threshold: String(autoReload.threshold),
          auto_reload_to: String(autoReload.reloadTo),
        }
      : {},
  };
  const txns = [];
  const keyed = new Map();
  const issued = new Map();
  const pendingItems = [];
  let seq = 0;

  function idempotent(key, params, make) {
    if (!key) return make();
    const hit = keyed.get(key);
    if (hit) {
      if (JSON.stringify(hit.params) !== JSON.stringify(params)) {
        throw new Error(`Keys for idempotent requests can only be used with the same parameters (${key})`);
      }
      return hit.result;
    }
    const result = make();
    keyed.set(key, { params, result });
    return result;
  }
  function balanceTxn(amount, extra) {
    customer.balance += amount;
    const t = { id: `cbtxn_${++seq}`, amount, ending_balance: customer.balance, currency: "eur", ...extra };
    txns.unshift(t);
    return t;
  }

  return {
    webhooks: real.webhooks,
    customer,
    txns,
    issued,
    customers: {
      async retrieve() {
        return { ...customer, metadata: { ...customer.metadata } };
      },
      async createBalanceTransaction(_id, params, opts) {
        return idempotent(opts?.idempotencyKey, params, () =>
          balanceTxn(params.amount, { type: "adjustment", description: params.description, metadata: params.metadata ?? {} }),
        );
      },
      listBalanceTransactions() {
        const all = [...txns];
        return { data: all, async *[Symbol.asyncIterator]() { yield* all; } };
      },
    },
    paymentMethods: { async list() { return { data: [{ id: "pm_card" }] }; } },
    invoiceItems: {
      async create(params, opts) {
        return idempotent(opts?.idempotencyKey, params, () => {
          const item = { id: `ii_${++seq}`, ...params };
          pendingItems.push(item);
          return item;
        });
      },
    },
    invoices: {
      async create(params, opts) {
        return idempotent(opts?.idempotencyKey, params, () => {
          const lines = pendingItems.splice(0);
          const total = lines.reduce((s, l) => s + l.amount, 0);
          const inv = {
            id: `in_${++seq}`,
            object: "invoice",
            customer: "cus_1",
            status: "draft",
            total,
            amount_due: total,
            amount_paid: 0,
            starting_balance: 0,
            collection_method: params.collection_method,
            metadata: params.metadata ?? {},
            billing_reason: "manual",
            hosted_invoice_url: "https://invoice.stripe.com/i/x",
          };
          issued.set(inv.id, inv);
          return { ...inv };
        });
      },
      async finalizeInvoice(id) {
        const inv = issued.get(id);
        if (inv.status !== "draft") throw new Error("This invoice is already finalized");
        // What Stripe does and cannot be told not to: the credit balance pays first.
        const credit = Math.max(0, -customer.balance);
        const applied = Math.min(credit, inv.total);
        inv.starting_balance = customer.balance;
        if (applied > 0) balanceTxn(applied, { type: "applied_to_invoice", invoice: id });
        inv.amount_due = inv.total - applied;
        inv.status = inv.amount_due === 0 ? "paid" : "open";
        return { ...inv };
      },
      async pay(id) {
        let inv = issued.get(id);
        if (inv.status === "draft") inv = await this.finalizeInvoice(id).then(() => issued.get(id));
        inv.amount_paid = inv.amount_due;
        inv.status = "paid";
        return { ...inv };
      },
      async sendInvoice(id) {
        return { ...issued.get(id) };
      },
    },
    /** The customer pays an emailed invoice from its hosted page. */
    payByCard(id) {
      const inv = issued.get(id);
      inv.amount_paid = inv.amount_due;
      inv.status = "paid";
      return { ...inv };
    },
    walletCredits() {
      return -customer.balance;
    },
  };
}

/** Deliver `invoice.paid` for `inv` through the webhook route AND the poller, as Stripe
 *  and a reconciliation sweep would. Both must be no-ops after a synchronous grant. */
async function deliverPaid(inv) {
  const evt = { id: `evt_${inv.id}`, object: "event", type: "invoice.paid", data: { object: inv } };
  const payload = JSON.stringify(evt);
  const header = real.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const res = await createStripeWebhookHandler({ currency: "eur" })(
    new Request("https://t.local/hook", { method: "POST", headers: { "stripe-signature": header }, body: payload }),
  );
  assert.equal(res.status, 200, "the event is accepted, not refused for a mismatched key");
  await createStripeEventHandler({ adapter: {}, plans: {}, currency: "eur" })(evt);
}

function assertPaidInCash(stripe, invoiceId) {
  const inv = stripe.issued.get(invoiceId);
  assert.equal(inv.status, "paid");
  assert.equal(inv.amount_paid, inv.total, "the card paid the WHOLE invoice");
  assert.equal(inv.starting_balance, 0, "no credit balance was applied");
  assert.equal(stripe.txns.filter((t) => t.type === "applied_to_invoice").length, 0, "nothing applied_to_invoice");
}

const config = { currency: "eur", baseUrl: "https://app.test", internalDomains: [], tax: undefined };
const noTax = { taxRates: [] };

test("the Enterprise quote: €70 charged for 10 000 credits on a wallet of 2 999", async () => {
  const stripe = stripeAccount({ wallet: 2_999 });
  __setStripeForTests(stripe);

  const out = await sellCredits("cus_1", "org_1", config, { credits: 10_000, amountMinor: 7_000, tax: noTax });
  assert.equal(out.status, "charged");
  assertPaidInCash(stripe, out.invoiceId);

  // Granted by the event (sellCredits leaves it to `invoice.paid`), once, for what was sold.
  await deliverPaid(stripe.issued.get(out.invoiceId));
  await deliverPaid(stripe.issued.get(out.invoiceId));
  assert.equal(stripe.walletCredits(), 2_999 + 10_000);
});

test("auto-reload on a wallet of 12 998: charged 1 902, granted 1 902 once", async () => {
  const stripe = stripeAccount({ wallet: 12_998, autoReload: { threshold: 13_000, reloadTo: 14_900 } });
  __setStripeForTests(stripe);

  await tryAutoReload("cus_1", "eur", noTax);
  const [inv] = [...stripe.issued.values()];
  assert.equal(inv.total, 1_902);
  assertPaidInCash(stripe, inv.id);
  assert.equal(stripe.walletCredits(), 14_900, "topped up TO reload_to, not past it");

  // REGRESSION: the event granted 14 900 more under a second key.
  await deliverPaid(stripe.issued.get(inv.id));
  assert.equal(stripe.walletCredits(), 14_900);
});

test("saved_card purchase on a non-empty wallet", async () => {
  const stripe = stripeAccount({ wallet: 100 });
  __setStripeForTests(stripe);

  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "saved_card", tax: noTax });
  assert.equal(out.status, "charged");
  assertPaidInCash(stripe, out.invoiceId);
  assert.equal(stripe.walletCredits(), 2_100);

  // The event lands after the synchronous grant: same request, so a no-op — not a 500.
  await deliverPaid(stripe.issued.get(out.invoiceId));
  assert.equal(stripe.walletCredits(), 2_100);
});

test("an emailed invoice is issued for its full amount and credited when the customer pays it", async () => {
  const stripe = stripeAccount({ wallet: 500 });
  __setStripeForTests(stripe);

  const out = await purchaseCredits("cus_1", "org_1", 20, config, { method: "invoice", tax: noTax });
  assert.equal(out.status, "invoiced");
  const issued = stripe.issued.get(out.invoiceId);
  assert.equal(issued.amount_due, 2_000, "the bill asks for the whole price");
  assert.equal(stripe.walletCredits(), 500, "the wallet is untouched while it is open");

  const paid = stripe.payByCard(out.invoiceId);
  await deliverPaid(paid);
  assertPaidInCash(stripe, out.invoiceId);
  assert.equal(stripe.walletCredits(), 2_500);
});

test("the set-aside is invisible afterwards: same balance, and no usage recorded", async () => {
  const stripe = stripeAccount({ wallet: 2_999 });
  __setStripeForTests(stripe);
  await sellCredits("cus_1", "org_1", config, { credits: 10_000, amountMinor: 7_000, method: "invoice", tax: noTax });
  assert.equal(await getCreditBalance("cus_1", "eur"), 2_999);
  const { usageSince } = await import("../dist/billing.js");
  assert.equal(await usageSince("cus_1", 0), 0, "the set-aside is an adjustment, not usage");
});

test("a finalize that fails still restores the wallet", async () => {
  const stripe = stripeAccount({ wallet: 2_999 });
  stripe.invoices.finalizeInvoice = async () => {
    throw new Error("Stripe 500");
  };
  __setStripeForTests(stripe);
  await assert.rejects(
    sellCredits("cus_1", "org_1", config, { credits: 10_000, amountMinor: 7_000, tax: noTax }),
    /Stripe 500/,
  );
  assert.equal(stripe.walletCredits(), 2_999);
});
