// A seat pack quoted "per month" on a plan billed ANNUALLY.
//
// The window a cap is measured over is the subscription period by default, so an
// annual subscriber's "1 000 per seat per month" was one window of 1 000 for the
// whole year — twelve months' worth on day one, then nothing. `cap.window:
// "month"` is the only way to say what the pricing page says.

import assert from "node:assert/strict";
import { test } from "vitest";

import { cycleWindowFor, normalizePlan } from "../dist/plan-model.js";
import { checkPlansConfig } from "../dist/doctor.js";

/** An annual subscription that started 5 months ago. */
const PERIOD = { start: "2026-03-01T00:00:00.000Z", end: "2027-03-01T00:00:00.000Z" };
const NOW = Date.parse("2026-08-02T12:00:00.000Z");

const plan = (cap) =>
  normalizePlan("pro", {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000 } } },
    cap,
    sale: "self_serve",
  });

test("by default the window IS the subscription period", () => {
  const w = cycleWindowFor(plan({ kind: "per_seat" }), PERIOD, NOW);
  assert.equal(new Date(w.start).toISOString(), PERIOD.start);
  assert.equal(new Date(w.end).toISOString(), PERIOD.end);
  // A year long: the pack is a year's worth, which is why the copy could not say
  // "per month" before this option existed.
  assert.ok(w.end - w.start > 300 * 864e5);
});

test('window: "month" pins it to the calendar month, annual subscription or not', () => {
  const w = cycleWindowFor(plan({ kind: "per_seat", window: "month" }), PERIOD, NOW);
  assert.equal(new Date(w.start).toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(new Date(w.end).toISOString(), "2026-09-01T00:00:00.000Z");
  // The KEY changes with it, which is the part that matters beyond the read: a
  // grant written under the period key would land in a window the meter never
  // looks at (the defect AGENTS.md records under "Cycles — one definition").
  assert.equal(w.key, "2026-08");
});

test("a pool can be monthly too, and rollover contradicts it", () => {
  const w = cycleWindowFor(plan({ kind: "pool", credits: 1000, window: "month" }), PERIOD, NOW);
  assert.equal(w.key, "2026-08");

  const errs = checkPlansConfig({
    p: {
      sells: { kind: "flat", price: { monthly: 100, yearly: 1000 } },
      cap: { kind: "pool", credits: 1000, rollover: true, window: "month" },
      sale: "self_serve",
    },
  }).checks.filter((c) => c.level === "error");
  assert.ok(errs.some((c) => /two different windows/.test(c.title)));
});

test("overflowing to a wallet nobody can fill is flagged", () => {
  const warn = (plans) =>
    checkPlansConfig(plans).checks.filter((c) => /wallet it cannot fill/.test(c.title));

  // No window at all: the wallet is the only gate, so it must be fillable.
  assert.equal(
    warn({ e: { sells: { kind: "seats", seatTypes: { s: { price: { monthly: 2104, yearly: 21600 } } } }, cap: { kind: "wallet" }, sale: "quote" } }).length,
    1,
  );
  // Same plan, with a way to buy credits: silent.
  assert.equal(
    warn({
      e: {
        sells: { kind: "seats", seatTypes: { s: { price: { monthly: 2104, yearly: 21600 } } } },
        cap: { kind: "wallet" },
        replenish: { purchase: {} },
        sale: "quote",
      },
    }).length,
    0,
  );
});
