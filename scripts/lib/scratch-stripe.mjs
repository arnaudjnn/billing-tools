// Throwaway Stripe fixtures, and the one property the whole harness rests on.
//
// ── WHY `ensurePlans` IS NEVER CALLED ────────────────────────────────────────
//
// `ensurePlans(plans)` reconciles the catalogue you hand it against the account and
// ARCHIVES every managed price the catalogue does not name. Run from a harness holding a
// partial catalogue, it archives the real product's prices — which has happened, and is
// why both existing e2e scripts carry a warning in their header.
//
// Rather than "remember not to call it", this makes it unreachable. Every price-consuming
// path in the library goes through `resolvePlanPrices`, and that checks the test memo
// FIRST (src/plans.ts:545 — `if (memo?.key === "__test__") return memo.prices`). So after
// `installScratchPrices()` below, `changePlan`, `previewPlanChange`, `cancelPlan` and
// `createCheckoutSession` resolve from the scratch map and can never reach Stripe's price
// list, let alone the archive sweep.
//
// Two corollaries the harness has to respect:
//
//   • NEVER dispatch `list_plans`. It is the one tool that calls `ensurePlans` directly
//     (src/tools/register.ts), and `archive` defaults on. The roles matrix excludes it by
//     name and asserts the exclusion.
//   • Do NOT tag scratch prices `managedBy: "billing-tools"`. `archiveOrphans` only touches
//     prices carrying that marker, so omitting it keeps these invisible to any real
//     `ensurePlans` running against the same test account while the harness does.

import { lookupKeyFor } from "../../dist/plans.js";
import { __setPlanPricesForTests } from "../../dist/plans.js";
import { defer, ignoreMissing } from "./harness.mjs";

/** Every object this run creates is prefixed with it, so a leaked one is identifiable and
 *  a plan key can never collide with a real catalogue's. */
export const RUN = `live${Math.floor(Date.now() / 1000)}`;

/**
 * The catalogue: seats, two tiers, and every capability derived from the shape itself.
 *
 * Deliberately NOT passing a `capabilities` override — `toolCapabilities` reads the
 * catalogue to decide which tools register, and the harness should exercise that
 * derivation rather than assert around it. `sells: seats` + `replenish.request` +
 * `cap: per_seat` is what turns on seats, top-ups and the lifecycle together.
 *
 * `free` exists so `cancel_plan` has somewhere to cancel TO, and so `planRank` puts
 * starter above it and pro above starter — which is what makes `timing: "auto"` produce a
 * real upgrade and a real scheduled downgrade rather than two no-ops.
 */
export const LIVE_PLANS = {
  [`${RUN}_free`]: {
    sells: { kind: "nothing" },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 100 },
    sale: "free",
    display: { name: "Scratch Free", order: 1 },
  },
  [`${RUN}_starter`]: {
    sells: {
      kind: "seats",
      // Every `min` here is load-bearing, and neither reason is obvious.
      //
      //  • `defaultBasket` starts each seat type at its `min`, defaulting to 0 — so a seats
      //    plan declaring none makes any `changePlan` without explicit seats throw
      //    "No seats selected", blaming the caller for a gap in the catalogue.
      //  • `planRank` prices that same DEFAULT basket, so `pro` only outranks `starter`
      //    if its extra seat type has a `min`. With `premium` at 0 both plans ranked 1800,
      //    `isDowngrade` was false, and `timing: "auto"` applied a downgrade immediately.
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000, min: 1 } },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat", window: "month", covers: "users", onExhausted: "wallet" },
    replenish: { purchase: { packs: [1000] }, autoReload: { threshold: 200, reloadTo: 1000 }, request: {} },
    limits: { members: 10, rate: [{ every: "day", credits: 5000, scope: "org" }] },
    sale: "self_serve",
    display: { name: "Scratch Starter", order: 2 },
  },
  [`${RUN}_pro`]: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000, min: 1 },
        premium: { price: { monthly: 9000, yearly: 90000 }, includedCredits: 5000, min: 1 },
      },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat", window: "month", covers: "users", onExhausted: "wallet" },
    replenish: { purchase: { packs: [1000, 5000] }, autoReload: { threshold: 500, reloadTo: 5000 }, request: {} },
    limits: { members: 50, rate: [{ every: "day", credits: 20000, scope: "org" }] },
    sale: "self_serve",
    display: { name: "Scratch Pro", order: 3, featured: true },
  },
};

export const FREE_PLAN = `${RUN}_free`;
export const STARTER_PLAN = `${RUN}_starter`;
export const PRO_PLAN = `${RUN}_pro`;

/**
 * One product per paid plan, one price per (plan, interval, seatType), then install them
 * as the resolver's memo. Returns the `Map<lookupKey, priceId>` for assertions.
 */
export async function createScratchCatalogue(stripe, { currency = "eur" } = {}) {
  const prices = new Map();
  const productIds = [];

  for (const [planKey, spec] of Object.entries(LIVE_PLANS)) {
    if (spec.sells.kind !== "seats") continue;
    const product = await stripe.products.create({
      name: `${spec.display.name} (${RUN})`,
      metadata: { bt_scratch: RUN, plan: planKey },
    });
    productIds.push(product.id);

    for (const [seatType, seat] of Object.entries(spec.sells.seatTypes)) {
      for (const interval of ["monthly", "yearly"]) {
        const price = await stripe.prices.create({
          product: product.id,
          currency,
          unit_amount: seat.price[interval],
          recurring: { interval: interval === "monthly" ? "month" : "year" },
          // Required by Stripe Tax, and harmless otherwise. `ensurePlans` sets the same.
          tax_behavior: "exclusive",
          lookup_key: `${lookupKeyFor(planKey, interval, seatType)}_${RUN}`,
          // NO managedBy — see the header. `plan`/`seatType` are still read by
          // planForPriceId / seatTypeForPriceId.
          metadata: { bt_scratch: RUN, plan: planKey, interval, seatType },
        });
        prices.set(lookupKeyFor(planKey, interval, seatType), price.id);
      }
    }
  }

  __setPlanPricesForTests(prices);

  defer(`scratch prices + products (${productIds.length})`, async () => {
    for (const priceId of prices.values()) {
      await stripe.prices.update(priceId, { active: false }).catch(ignoreMissing);
    }
    for (const id of productIds) {
      await stripe.products.update(id, { active: false }).catch(ignoreMissing);
    }
  });

  return { plans: LIVE_PLANS, prices, productIds };
}

/**
 * A customer on a test clock, so the lifecycle section can move time.
 *
 * Not `ensureStripeCustomer`: that sets neither an address nor a clock, and both are
 * load-bearing here — no address means no place of supply, so no tax to assert.
 */
export async function createClockCustomer(stripe, { orgId, country = "IT", name = "E2E Live" }) {
  const now = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: now,
    name: `${RUN} lifecycle`,
  });
  defer(`test clock ${clock.id}`, () => stripe.testHelpers.testClocks.del(clock.id));

  const customer = await stripe.customers.create({
    name: `${name} (${RUN})`,
    email: `${RUN}@example.test`,
    address: { line1: "1 Via Test", city: "Milano", postal_code: "20100", country },
    test_clock: clock.id,
    metadata: { bt_scratch: RUN, org_id: orgId },
  });
  // Deleting the clock removes its customers, but explicit is cheaper to reason about
  // when a run dies between the two.
  defer(`customer ${customer.id}`, () => stripe.customers.del(customer.id).catch(ignoreMissing));

  return { clockId: clock.id, customerId: customer.id };
}

/**
 * A card, set as the invoice default so off-session charges (auto-reload, a prorated
 * upgrade) can actually settle.
 *
 * `card: "fail"` attaches a card that ACCEPTS attachment and then declines every charge —
 * the only way to reach the `pending_update` path, which is the entire reason `changePlan`
 * sends `pending_if_incomplete`. A card that failed to attach would test nothing.
 */
const CARD_TOKENS = { ok: "tok_visa", fail: "tok_chargeCustomerFail" };

export async function attachTestCard(stripe, customerId, { card = "ok" } = {}) {
  const pm = await stripe.paymentMethods.create({ type: "card", card: { token: CARD_TOKENS[card] } });
  await stripe.paymentMethods.attach(pm.id, { customer: customerId });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm.id;
}

/** A second customer, off-clock, for the invoice ownership check — proving `view_invoice`
 *  refuses an invoice belonging to someone else needs two real customers. */
export async function createOtherCustomer(stripe) {
  const c = await stripe.customers.create({
    name: `Other (${RUN})`,
    email: `${RUN}-other@example.test`,
    address: { line1: "2 Via Test", city: "Roma", postal_code: "00100", country: "IT" },
    metadata: { bt_scratch: RUN },
  });
  defer(`other customer ${c.id}`, () => stripe.customers.del(c.id).catch(ignoreMissing));
  return c.id;
}
