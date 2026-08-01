// Auto-reload is the one purchase a customer never confirms, and it had the two
// defects that combination makes worst:
//
//   - it billed as a bare PaymentIntent, so there was no invoice and no tax line
//     — a receipt, not a fattura, for the only charge with no checkout behind it;
//   - it had no idempotency key while being fired and forgotten from the meter on
//     EVERY metered call, so concurrent calls each saw the same low balance and
//     each charged.
//
// Stripe is faked at the client seam: these assert the requests the library
// makes. That a real invoice then pays is the test-clock script's job.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "node:test";

/** Records every Stripe call and the idempotency key it carried. */
function fakeStripe({ balance = 0, cards = ["pm_1"] } = {}) {
  const calls = [];
  const seen = new Map(); // idempotency key → first response, as Stripe behaves
  const once = (key, make) => {
    if (key && seen.has(key)) return seen.get(key);
    const v = make();
    if (key) seen.set(key, v);
    return v;
  };
  return {
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    customers: {
      async retrieve() {
        return {
          deleted: false,
          balance: -balance,
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
        return once(opts?.idempotencyKey, () => ({ id: "txn_1" }));
      },
    },
    paymentMethods: {
      async list() {
        return { data: cards.map((id) => ({ id })) };
      },
    },
    paymentIntents: {
      async create(params, opts) {
        calls.push({ name: "paymentIntent", params, key: opts?.idempotencyKey });
        return { id: "pi_1", status: "succeeded" };
      },
    },
    invoiceItems: {
      async create(params, opts) {
        calls.push({ name: "invoiceItem", params, key: opts?.idempotencyKey });
        return once(opts?.idempotencyKey, () => ({ id: "ii_1" }));
      },
    },
    invoices: {
      async create(params, opts) {
        calls.push({ name: "invoice", params, key: opts?.idempotencyKey });
        return once(opts?.idempotencyKey, () => ({ id: "in_1", status: "draft" }));
      },
      async pay(id) {
        calls.push({ name: "pay", params: { id } });
        return { id, status: "paid" };
      },
    },
  };
}

test("auto-reload bills an invoice, not a bare charge", async () => {
  const stripe = fakeStripe({ balance: 50 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(stripe);

  await tryAutoReload("cus_1", "eur");

  assert.equal(stripe.of("paymentIntent").length, 0, "must not use a bare PaymentIntent");
  assert.equal(stripe.of("invoiceItem").length, 1);
  assert.equal(stripe.of("invoice").length, 1);
  assert.equal(stripe.of("pay").length, 1);
  // reload_to 1000 − balance 50
  assert.equal(stripe.of("invoiceItem")[0].params.amount, 950);
});

test("the invoice carries the tax rates it was given", async () => {
  const stripe = fakeStripe({ balance: 50 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(stripe);

  await tryAutoReload("cus_1", "eur", { taxRates: ["txr_iva22"] });

  assert.deepEqual(stripe.of("invoiceItem")[0].params.tax_rates, ["txr_iva22"]);
});

test("manual rates and automatic tax are never sent together", async () => {
  // Stripe rejects the request outright if both are present.
  const stripe = fakeStripe({ balance: 50 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(stripe);

  await tryAutoReload("cus_1", "eur", { taxRates: ["txr_iva22"], automaticTax: true });

  assert.equal(stripe.of("invoice")[0].params.automatic_tax, undefined);
});

test("concurrent triggers charge once", async () => {
  // The real shape of the bug: the meter fires this on every metered call.
  const stripe = fakeStripe({ balance: 50 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(stripe);

  await Promise.all([
    tryAutoReload("cus_1", "eur"),
    tryAutoReload("cus_1", "eur"),
    tryAutoReload("cus_1", "eur"),
  ]);

  const keys = new Set(stripe.of("invoice").map((c) => c.key));
  assert.equal(keys.size, 1, "all racers must share one idempotency key");
  assert.ok(stripe.of("invoice")[0].key, "the invoice must carry an idempotency key");
  assert.ok(stripe.of("credit")[0].key, "the credit must carry one too");
  const creditKeys = new Set(stripe.of("credit").map((c) => c.key));
  assert.equal(creditKeys.size, 1);
});

test("nothing happens above the threshold, or with no card", async () => {
  const rich = fakeStripe({ balance: 5000 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(rich);
  await tryAutoReload("cus_1", "eur");
  assert.equal(rich.of("invoice").length, 0);

  const cardless = fakeStripe({ balance: 50, cards: [] });
  __setStripeForTests(cardless);
  await tryAutoReload("cus_1", "eur");
  assert.equal(cardless.of("invoice").length, 0);
});
