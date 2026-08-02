// What a credit purchase costs, quoted before anyone is charged.
//
// The point is not the arithmetic, it is the SOURCE: a dialog showing "Estimated
// tax €4.40" beside a Checkout Session that charges something else is the drift
// this library keeps designing out. The quote reads the same Stripe TaxRate
// objects the charge will carry.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  __setStripeForTests,
  quoteCreditPurchase,
  invalidateCreditQuotes,
} from "../dist/billing.js";

function fakeStripe(rates) {
  const reads = [];
  return {
    reads,
    taxRates: {
      async retrieve(id) {
        reads.push(id);
        return rates[id];
      },
    },
  };
}

test("no rates: the amount is the total, in credits and minor units", async () => {
  invalidateCreditQuotes();
  __setStripeForTests(fakeStripe({}));
  const q = await quoteCreditPurchase(20);
  // 1 unit of currency = 100 credits, the same conversion buy_credits states.
  assert.deepEqual(
    { credits: q.credits, subtotal: q.subtotal, tax: q.tax, total: q.total, taxPercent: q.taxPercent },
    { credits: 2000, subtotal: 2000, tax: 0, total: 2000, taxPercent: 0 },
  );
});

test("an exclusive rate is added on top", async () => {
  invalidateCreditQuotes();
  __setStripeForTests(fakeStripe({ txr_it: { percentage: 22, inclusive: false } }));
  const q = await quoteCreditPurchase(20, ["txr_it"]);
  assert.equal(q.subtotal, 2000);
  assert.equal(q.tax, 440);
  assert.equal(q.total, 2440);
  assert.equal(q.taxPercent, 22);
});

test("an INCLUSIVE rate leaves the total alone", async () => {
  invalidateCreditQuotes();
  __setStripeForTests(fakeStripe({ txr_inc: { percentage: 20, inclusive: true } }));
  const q = await quoteCreditPurchase(20, ["txr_inc"]);
  // Inclusive means the tax is already inside the amount asked for. Adding it on
  // top would overstate the charge — and Stripe would not charge it.
  assert.equal(q.total, 2000);
  assert.equal(q.tax, 0);
});

test("several rates round ONCE on the summed percentage", async () => {
  invalidateCreditQuotes();
  __setStripeForTests(
    fakeStripe({ a: { percentage: 7.5, inclusive: false }, b: { percentage: 2.5, inclusive: false } }),
  );
  const q = await quoteCreditPurchase(9.99, ["a", "b"]);
  // 999 × 10% = 99.9 → 100. Rounding each rate first (75 + 25 = 100 here, but 37 +
  // 62 = 99 at other amounts) drifts a cent from what Stripe totals.
  assert.equal(q.subtotal, 999);
  assert.equal(q.taxPercent, 10);
  assert.equal(q.tax, 100);
  assert.equal(q.total, 1099);
});

test("a rate is read once per process, and a failed read is not cached", async () => {
  invalidateCreditQuotes();
  const stripe = fakeStripe({ txr_it: { percentage: 22, inclusive: false } });
  __setStripeForTests(stripe);
  await quoteCreditPurchase(5, ["txr_it"]);
  await quoteCreditPurchase(20, ["txr_it"]);
  assert.equal(stripe.reads.length, 1, "the dialog re-quotes on every preset click");

  invalidateCreditQuotes();
  let calls = 0;
  __setStripeForTests({
    taxRates: {
      async retrieve() {
        calls++;
        if (calls === 1) throw new Error("transient");
        return { percentage: 22, inclusive: false };
      },
    },
  });
  await assert.rejects(() => quoteCreditPurchase(20, ["txr_it"]));
  // The second attempt must reach Stripe, not a cached rejection.
  const q = await quoteCreditPurchase(20, ["txr_it"]);
  assert.equal(q.tax, 440);
});
