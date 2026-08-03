// Which seat a member holds, and the plan's own word for it.
//
// A usage screen badges the seat the way a workspace switcher badges the plan.
// Before this the only seat a summary reported lived on `pack`, so it existed
// ONLY on a plan that caps per seat: a pooled or free plan seated everybody in a
// `standard` seat it does not declare, and there was no way for the app to name
// the seat a free plan gives you.

import assert from "node:assert/strict";
import { test } from "vitest";

import { normalizePlan, planModel } from "../dist/plan-model.js";
import { resolveSeat } from "../dist/usage.js";

const PLANS = {
  // Sells seats: the SOLD types are the seat types.
  pro: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: {
          price: { monthly: 2104, yearly: 21600 },
          display: { label: "Standard seat", badge: "Standard" },
        },
        premium: {
          price: { monthly: 10523, yearly: 108000 },
          // No badge: the full label is the fallback, never nothing.
          display: { label: "Premium" },
        },
      },
    },
    sale: "self_serve",
  },
  // Sells nothing, and still seats a person.
  hobby: {
    sells: { kind: "nothing" },
    cap: { kind: "pool", credits: 1000 },
    seat: { key: "solo", display: { label: "Solo seat", badge: "Solo" } },
    sale: "free",
  },
};

const model = (key) => planModel(PLANS, key);

test("a sold seat type reports its badge, falling back to the label", () => {
  assert.deepEqual(resolveSeat(model("pro"), "standard"), {
    type: "standard",
    label: "Standard",
  });
  assert.deepEqual(resolveSeat(model("pro"), "premium"), {
    type: "premium",
    label: "Premium",
  });
});

test("a plan that sells nothing can still name the seat you hold", () => {
  assert.equal(model("hobby").seat.key, "solo");
  assert.deepEqual(resolveSeat(model("hobby"), "solo"), { type: "solo", label: "Solo" });
});

test("a seat the plan never declared reports the key and no words", () => {
  // The API seat is the case in the wild: it is drawn by keys and agents, and a
  // plan that funds API usage from the wallet declares no seat type for it. The
  // key is still true, so it is still reported — the app decides what to show.
  assert.deepEqual(resolveSeat(model("pro"), "api"), { type: "api", label: null });
  assert.deepEqual(resolveSeat(null, "standard"), { type: "standard", label: null });
});

test("a plan that SELLS seats ignores `seat` — the sold types are the truth", () => {
  const m = normalizePlan("pro", {
    ...PLANS.pro,
    seat: { key: "solo", display: { label: "Solo" } },
  });
  assert.equal(m.seat, null);
  assert.deepEqual(resolveSeat(m, "solo"), { type: "solo", label: null });
});

test("labels resolve per locale, like every other string the config authors", () => {
  const m = normalizePlan("hobby", {
    ...PLANS.hobby,
    seat: { key: "solo", display: { label: { en: "Solo seat", it: "Posto Solo" }, badge: { en: "Solo", it: "Singolo" } } },
  });
  assert.equal(resolveSeat(m, "solo", { locale: "it" }).label, "Singolo");
  assert.equal(resolveSeat(m, "solo", { locale: "fr-CA" }).label, "Solo"); // default locale
});
