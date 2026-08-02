// The plan-change money question, pinned.
//
// Measured against Stripe with a test clock (scripts/e2e-proration.mjs), a €18
// Pro → €90 Premium upgrade on day 15 of 30:
//
//   deferred (default)   nothing today, next invoice €127.16
//                        = −€9.29 unused Pro + €46.45 Premium remainder + €90 next month
//   immediate            €37.16 today (46.45 − 9.29), then €90
//   downgrade at end     nothing today, next invoice €18.00, no credit
//   downgrade now        credit for the unused remainder against the next invoice
//
// The customer pays the same either way; only the timing differs. What must not
// regress is which number goes in which field — quoting the whole upcoming
// invoice as "due now" once told a customer €197.64 for a change that charged
// €87.84.

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

// The seams are imported from their own modules, not from the package entry:
// replacing the Stripe client or the price memo is a testing affordance, not
// part of the public API.
import { __setStripeForTests } from "../dist/billing.js";
import { __setPlanPricesForTests } from "../dist/plans.js";
import { previewPlanChange } from "../dist/subscription.js";

const PLANS = {
  hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", tokens: 1000 }, sale: "free" },
  pro: {
    sells: { kind: "flat", price: { monthly: 1800, yearly: 18000 } },
    cap: { kind: "pool", tokens: 1000 },
    sale: "self_serve",
  },
  premium: {
    sells: { kind: "flat", price: { monthly: 9000, yearly: 90000 } },
    cap: { kind: "pool", tokens: 5000 },
    sale: "self_serve",
  },
};

const PERIOD_END = Math.floor(Date.parse("2026-09-17T00:00:00.000Z") / 1000);

/** The two previews Stripe returns, with the real measured totals. */
function fakeStripe({
  recurringTotal = 9000,
  proratedTotal = 12716,
  currentPlan = "pro",
  currentPrice = "price_pro",
} = {}) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      async *list() {
        yield {
          id: "sub_1",
          status: "active",
          metadata: { plan: currentPlan },
          schedule: null,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: "si_1",
                quantity: 1,
                price: { id: currentPrice },
                tax_rates: [],
                current_period_end: PERIOD_END,
              },
            ],
          },
        };
      },
    },
    prices: {
      async *list() {
        // resolvePlanPrices reconciles through ensurePlans; the catalogue is
        // stubbed below instead, so nothing here needs to return prices.
      },
    },
    invoices: {
      async createPreview(params) {
        calls.push(params.subscription_details?.proration_behavior);
        const prorating = params.subscription_details?.proration_behavior === "create_prorations";
        return {
          currency: "eur",
          total: prorating ? proratedTotal : recurringTotal,
          amount_due: prorating ? proratedTotal : recurringTotal,
          lines: {
            data: prorating
              ? [
                  { description: "Unused time on Pro", amount: -929, proration: true },
                  { description: "Remaining time on Premium", amount: 4645, proration: true },
                  { description: "1 × Premium", amount: 9000, proration: false },
                ]
              : [{ description: "1 × Premium", amount: 9000, proration: false }],
          },
        };
      },
    },
  };
}

const adapter = {
  async getBillingCustomerId() {
    return "cus_1";
  },
  async validateApiKey() {
    return { orgId: "org_1" };
  },
};

// `resolvePlanPrices` provisions through ensurePlans, which WRITES to Stripe, so
// the price map is stubbed: these tests are about the arithmetic downstream of
// it, and an offline suite must not reconcile a catalogue.
beforeEach(() => {
  __setPlanPricesForTests(
    new Map([
      ["pro_monthly", "price_pro"],
      ["premium_monthly", "price_premium"],
    ]),
  );
});

async function preview(opts, stripe) {
  __setStripeForTests(stripe);
  return previewPlanChange(adapter, "org_1", { plans: PLANS, ...opts });
}

test("an upgrade defers the difference: nothing today, credit on the next invoice", async () => {
  const stripe = fakeStripe();
  const p = await preview({ to: { plan: "premium", interval: "monthly" }, currency: "eur" }, stripe);

  assert.equal(p.kind, "immediate");
  assert.equal(p.dueNow, 0, "the default charges nothing today");
  // The measured €127.16: the credit is already netted into it.
  assert.equal(p.nextInvoiceTotal, 12716);
  assert.equal(p.recurringTotal, 9000, "the steady-state price, not the transition");
  assert.equal(p.credit, 929, "the unused remainder of the old plan, credited back");
  assert.ok(p.nextInvoiceAt, "the date the bigger invoice lands — this is what stops it surprising");
});

test("billing the upgrade now charges only the difference, not the next period too", async () => {
  // The bug this pins: reading Stripe's preview `amount_due` as "due now"
  // quoted €127.16 (or €197.64 in the original report) for a change that
  // charges the difference alone.
  const stripe = fakeStripe();
  const p = await preview(
    { to: { plan: "premium", interval: "monthly" }, currency: "eur", proration: "invoice_now" },
    stripe,
  );

  assert.equal(p.dueNow, 12716 - 9000, "= €37.16, the measured immediate charge");
  assert.equal(p.nextInvoiceTotal, 9000, "the next invoice is back to the plain plan price");
  assert.notEqual(p.dueNow, 12716, "must never quote the whole upcoming invoice as due now");
});

test("a downgrade charges nothing and credits nothing", async () => {
  // Fair, and the industry norm: the customer keeps the tier they paid for
  // until the period they paid for ends, so there is nothing to refund.
  const stripe = fakeStripe({
    currentPlan: "premium",
    currentPrice: "price_premium",
    recurringTotal: 1800,
    proratedTotal: 1800,
  });
  const p = await preview({ to: { plan: "pro", interval: "monthly" }, currency: "eur" }, stripe);

  assert.equal(p.kind, "scheduled");
  assert.equal(p.dueNow, 0);
  assert.equal(p.credit, 0, "no credit, because no paid-for service is lost");
  assert.equal(p.recurringTotal, 1800, "the new, lower price from the next period");
  assert.equal(p.nextInvoiceAt, p.effectiveAt, "it takes effect when the next invoice is raised");
});

test("both previews are requested, and only one of them prorates", async () => {
  // The two-preview difference IS the arithmetic. If one call is ever dropped,
  // the proration silently becomes the whole invoice again.
  const stripe = fakeStripe();
  await preview({ to: { plan: "premium", interval: "monthly" }, currency: "eur" }, stripe);
  assert.deepEqual([...stripe.calls].sort(), ["create_prorations", "none"]);
});
