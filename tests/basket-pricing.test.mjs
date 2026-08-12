// Pricing a basket — the DISPLAY half of `validateBasket`.
//
// A consumer's checkout hand-summed `seats[k] × price[interval]` beside the very
// component that called `validateBasket`, and its plan page re-derived "tightest of
// `maxSeats` and `limits.members`" with its own `tighter()` because the two ceilings
// are enforced separately. Both figures now come from the catalogue in one call, and
// `derivePlanViews` prices its headline through the same function, so a stepper's
// subtotal and a pricing card's cannot disagree.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  basketBounds,
  defaultBasket,
  planModel,
  priceBasket,
} from "../dist/entries/plans.js";
import { derivePlanViews } from "../dist/pricing.js";

const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      minSeats: 2,
      maxSeats: 100,
      seatTypes: {
        standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000, min: 1 },
        premium: { price: { monthly: 10523, yearly: 108000 }, includedCredits: 5000, min: 0, max: 3 },
      },
    },
    cap: { kind: "per_seat" },
    limits: { members: 50 },
    sale: "self_serve",
  },
  starter: {
    sells: { kind: "flat", price: { monthly: 3000, yearly: 30000 } },
    cap: { kind: "pool", credits: 4000 },
    sale: "self_serve",
  },
  hobby: { sells: { kind: "nothing" }, sale: "free" },
};

test("a seats basket prices as Σ qty × the interval's price, one line per type in play", () => {
  const model = planModel(PLANS, "pro");
  const priced = priceBasket(model, { standard: 3, premium: 1 }, "monthly");
  assert.deepEqual(priced.lines, [
    { seatType: "standard", quantity: 3, unit: 2104, amount: 6312 },
    { seatType: "premium", quantity: 1, unit: 10523, amount: 10523 },
  ]);
  assert.equal(priced.subtotal, 16835);
  // Yearly reads the other column of the same basket.
  assert.equal(priceBasket(model, { standard: 3, premium: 1 }, "yearly").subtotal, 172800);
  // A type at zero contributes no line rather than a zero row.
  assert.deepEqual(priceBasket(model, { standard: 2, premium: 0 }, "monthly").lines.length, 1);
});

test("a flat plan is one line with no seat type; `nothing` and null price to zero", () => {
  const flat = priceBasket(planModel(PLANS, "starter"), undefined, "monthly");
  assert.deepEqual(flat, {
    subtotal: 3000,
    lines: [{ seatType: null, quantity: 1, unit: 3000, amount: 3000 }],
  });
  assert.deepEqual(priceBasket(planModel(PLANS, "hobby"), undefined, "monthly"), {
    subtotal: 0,
    lines: [],
  });
  assert.deepEqual(priceBasket(null, { standard: 5 }, "monthly"), { subtotal: 0, lines: [] });
});

test("taxPercent yields an estimate that rounds ONCE on the summed subtotal", () => {
  const model = planModel(PLANS, "pro");
  const priced = priceBasket(model, { standard: 3 }, "monthly", { taxPercent: 22 });
  assert.equal(priced.subtotal, 6312);
  assert.equal(priced.tax, Math.round((6312 * 22) / 100));
  assert.equal(priced.total, priced.subtotal + priced.tax);
  // No taxPercent → no tax fields at all, so a renderer cannot mistake 0 for "0% applies".
  assert.ok(!("tax" in priceBasket(model, { standard: 3 }, "monthly")));
});

test("…and the sum is what rounds, on a basket where the two answers DIFFER", () => {
  // The case above does not discriminate: 6312 × 22% and 3 × round(2104 × 22%)
  // both give 1389. This one does — three lines of 333 at 21%: rounding each
  // gives 3 × 70 = 210, rounding the sum gives round(999 × 0.21) = 210 as well…
  // so pick figures where they part: 5 × 199 at 21% is round(1044.75) = 1045
  // summed, versus 5 × round(41.79) = 5 × 42 = 210 → 210 vs 209 per line.
  const model = planModel(
    { p: { sells: { kind: "seats", seatTypes: { s: { price: { monthly: 199 } } } }, sale: "self_serve" } },
    "p",
  );
  const priced = priceBasket(model, { s: 5 }, "monthly", { taxPercent: 21 });
  assert.equal(priced.subtotal, 995);
  assert.equal(priced.tax, 209, "round(995 × 0.21) = 208.95 → 209");
  const perLine = 5 * Math.round((199 * 21) / 100);
  assert.equal(perLine, 210, "the fixture really does discriminate");
  assert.notEqual(priced.tax, perLine);
});

test("taxPercent: 0 states a rate of zero; omitting it states nothing", () => {
  // Distinct on purpose — an out-of-scope sale IS 0%, and a page that has not
  // asked yet must not print one. `0` is falsy, so `?? undefined` shortcuts
  // here would collapse the two.
  const model = planModel(PLANS, "pro");
  const zero = priceBasket(model, { standard: 1 }, "monthly", { taxPercent: 0 });
  assert.equal(zero.tax, 0);
  assert.equal(zero.total, zero.subtotal);
  const silent = priceBasket(model, { standard: 1 }, "monthly");
  assert.ok(!("tax" in silent) && !("total" in silent));
  assert.ok(!("tax" in priceBasket(model, { standard: 1 }, "monthly", {})));
});

test("basketBounds collapses maxSeats and limits.members to the TIGHTEST ceiling", () => {
  // pro: maxSeats 100, members 50 → 50 binds. The consumer's own `tighter()` re-derived this.
  assert.deepEqual(basketBounds(planModel(PLANS, "pro")), {
    minSeats: 2,
    maxSeats: 50,
    seatTypes: {
      standard: { min: 1, max: null },
      premium: { min: 0, max: 3 },
    },
  });
  // Each side absent: only the other binds; both absent: unbounded.
  const only = (extra) =>
    basketBounds(
      planModel(
        {
          p: {
            sells: { kind: "seats", seatTypes: { s: { price: { monthly: 100 } } }, ...extra.sells },
            sale: "self_serve",
            ...extra.plan,
          },
        },
        "p",
      ),
    ).maxSeats;
  assert.equal(only({ sells: { maxSeats: 10 }, plan: {} }), 10);
  assert.equal(only({ sells: {}, plan: { limits: { members: 7 } } }), 7);
  assert.equal(only({ sells: {}, plan: {} }), null);
  // Not a seats plan → degenerate bounds, nothing to step.
  assert.deepEqual(basketBounds(planModel(PLANS, "starter")), {
    minSeats: 0,
    maxSeats: null,
    seatTypes: {},
  });
  assert.deepEqual(basketBounds(null).seatTypes, {});
});

test("derivePlanViews prices its headline through priceBasket of the default basket", () => {
  const views = derivePlanViews(PLANS, { currency: "eur" });
  const pro = views.find((v) => v.key === "pro");
  const model = planModel(PLANS, "pro");
  const expected = priceBasket(model, defaultBasket(model), "monthly").subtotal;
  assert.equal(pro.price.totals?.monthly?.minor, expected);
});
