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
import { test } from "vitest";

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
      async finalizeInvoice(id) {
        calls.push({ name: "finalize", params: { id } });
        return { id, status: "open" };
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

test("tax is resolved ONLY when a reload actually happens", async () => {
  // The shape of the bug, and it is a rate-limit cascade rather than a wrong number.
  // This is fired and forgotten on EVERY wallet-funded metered call, and it used to
  // resolve tax before deciding whether to charge — so under `mode: "local"` each
  // metered call made a live VIES request plus a Stripe customer retrieve for a
  // reload that, almost always, was not going to happen. VIES is a shared European
  // Commission service, and being rate-limited there does not surface as an error:
  // an unverifiable VAT number means CHARGE, so every B2B customer silently stops
  // reverse-charging. Hence the thunk.
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");

  // Above the threshold — the common case on a metered call. Nothing may be resolved.
  let resolved = 0;
  const tax = async () => {
    resolved++;
    return { taxRates: ["txr_iva22"] };
  };
  __setStripeForTests(fakeStripe({ balance: 5000 }));
  await tryAutoReload("cus_1", "eur", tax);
  assert.equal(resolved, 0, "a customer nowhere near their threshold must not touch VIES");

  // No card on file — also an early return, also must not resolve.
  __setStripeForTests(fakeStripe({ balance: 50, cards: [] }));
  await tryAutoReload("cus_1", "eur", tax);
  assert.equal(resolved, 0, "no card means no charge, so no tax to work out");

  // Actually charging: resolved exactly once, and the rate reaches the invoice.
  const stripe = fakeStripe({ balance: 50 });
  __setStripeForTests(stripe);
  await tryAutoReload("cus_1", "eur", tax);
  assert.equal(resolved, 1);
  assert.deepEqual(stripe.of("invoiceItem")[0].params.tax_rates, ["txr_iva22"]);
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
  // The GRANT, not the wallet set-aside/restore around finalization (also balance txns).
  const grants = stripe.of("credit").filter((c) => c.key?.startsWith("credit:"));
  assert.ok(grants.length > 0 && grants.every((c) => c.key), "the credit must carry one too");
  assert.deepEqual([...new Set(grants.map((c) => c.key))], ["credit:invoice:in_1"]);
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

test("the reload is finalized with the wallet set aside, then restored — never paid from it", async () => {
  // REGRESSION (measured in Stripe TEST): a reload fires while the wallet still holds
  // credits, and Stripe applies that balance at finalization, so a 1 902-credit reload on
  // a wallet of 12 998 charged the card nothing — and was then granted twice.
  const stripe = fakeStripe({ balance: 50 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(stripe);

  await tryAutoReload("cus_1", "eur");

  const order = stripe.calls.map((c) => c.name === "credit" ? `credit:${c.params.amount}` : c.name);
  assert.deepEqual(order.slice(order.indexOf("invoice")), [
    "invoice",
    "credit:50", // set aside: wallet to zero
    "finalize",
    "credit:-50", // restored
    "pay",
    "credit:-950", // the reload itself, once
  ]);
  const [aside, restore] = stripe.of("credit").filter((c) => c.params.metadata?.kind === "adjustment");
  assert.equal(aside.key, "wallet-aside:in_1");
  assert.equal(restore.key, "wallet-restore:in_1");
});

test("an empty wallet is not set aside at all", async () => {
  const stripe = fakeStripe({ balance: 0 });
  const { tryAutoReload, __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests(stripe);
  await tryAutoReload("cus_1", "eur");
  assert.equal(stripe.of("credit").filter((c) => c.params.metadata?.kind === "adjustment").length, 0);
  assert.equal(stripe.of("finalize").length, 1);
});
