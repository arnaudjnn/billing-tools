// The rungs, as arithmetic: which seat is better, and which one is the best there is.
//
// This is the module a consumer's UI reaches for, so what it asserts is mostly about the
// answers being STATED rather than inferable. Every one of these questions was already
// decided inside the library — and asked again, differently, in a consumer's screen,
// because no entry point exported the answer.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  defaultSeatOf,
  isTopSeat,
  nextSeatUp,
  planModel,
  seatLadder,
  seatRank,
  seatTypeExists,
} from "../dist/entries/plans.js";

const PLANS = {
  hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 500 }, sale: "free" },
  pro: {
    sells: {
      kind: "seats",
      seatTypes: {
        // Deliberately NOT in price order, and with the shared API seat in the middle:
        // a consumer sorting by config order would get all three of these wrong.
        premium: { price: { monthly: 10523 }, includedCredits: 5000, min: 1 },
        api: { price: { monthly: 0 }, includedCredits: 0, shared: true },
        standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 2 },
      },
    },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
};

const pro = planModel(PLANS, "pro");

test("the ladder is price order, and the shared seat is not on it", () => {
  // `shared` is what an API caller draws, not a rung a person climbs. Including it made
  // "the next seat up" point at something nobody can be assigned.
  assert.deepEqual(
    seatLadder(pro).map((s) => s.key),
    ["standard", "premium"],
  );
});

test("an unassigned member draws the cheapest non-shared seat", () => {
  assert.equal(defaultSeatOf(pro), "standard");
  // A seatless plan has no rung at all — not a zero, an absence.
  assert.equal(defaultSeatOf(planModel(PLANS, "hobby")), null);
});

test("absent ranks as the default seat, not as nothing", () => {
  // The bug this prevents: treating absent as 0 offered a Standard member the Standard
  // seat they were already effectively on ("Assegna Posto Standard").
  assert.equal(seatRank(pro, null), seatRank(pro, "standard"));
  assert.equal(nextSeatUp(pro, null), "premium");
});

test("the top of the ladder is a question you can ask directly", () => {
  assert.equal(isTopSeat(pro, "premium"), true);
  assert.equal(isTopSeat(pro, "standard"), false);
  // Unassigned is on the entry rung, so there is something above them.
  assert.equal(isTopSeat(pro, null), false);
  // And a plan with no rungs has no top: nothing to offer, nothing to be at the end of.
  assert.equal(isTopSeat(planModel(PLANS, "hobby"), null), false);
});

test("seat existence is asked of THIS plan, not of the catalogue", () => {
  // The check `assign_seat_type` was missing: it validated against the union of seat keys
  // across every plan, so a key another plan sells passed for a workspace whose plan does
  // not sell it, and the write landed on a seat the meter cannot price.
  assert.equal(seatTypeExists(pro, "premium"), true);
  assert.equal(seatTypeExists(pro, "enterprise"), false);
  // The shared seat exists even though it is not a rung — an API caller really holds one.
  assert.equal(seatTypeExists(pro, "api"), true);
});
