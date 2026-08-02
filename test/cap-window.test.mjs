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

// ── covers: who the included window belongs to ───────────────────────────────
//
// "API usage is pay-as-you-go, 0 credits included" is a different statement from
// `onExhausted`. A machine caller ALREADY overflowed to the wallet once a window
// was spent; it still spent the window first, so an agent drew a person's monthly
// allowance and could burn it in a minute.

import { capCovers, fundingFor } from "../dist/index.js";

const model = (cap) =>
  normalizePlan("pro", {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000 },
        api: { price: { monthly: 0, yearly: 0 }, includedCredits: 0, shared: true },
      },
    },
    cap,
    replenish: { purchase: {} },
    sale: "self_serve",
  });

const state = (over) => ({
  plan: "pro",
  cycle: { start: 0, end: 1, key: "k" },
  limits: [],
  pool: null,
  pack: { seatType: "standard", size: 1000, used: 0, extra: 0, remaining: 1000 },
  wallet: 0,
  ...over,
});

test("covers defaults to all, so a machine caller draws the window (unchanged)", () => {
  const m = model({ kind: "per_seat" });
  assert.equal(capCovers(m, { kind: "api" }), true);
  assert.deepEqual(fundingFor(state(), m, 10, { kind: "api", seatType: "standard" }), {
    ok: true,
    source: "pack",
  });
});

test('covers: "users" puts a machine caller on the wallet from its FIRST call', () => {
  const m = model({ kind: "per_seat", covers: "users" });
  assert.equal(capCovers(m, { kind: "user", seatType: "standard" }), true);
  assert.equal(capCovers(m, { kind: "api" }), false);
  // A shared seat is a machine caller too — the seat exists to be drawn by agents.
  assert.equal(capCovers(m, { kind: "user", seatType: "api" }), false);

  // The person still gets their pack.
  assert.deepEqual(fundingFor(state(), m, 10, { kind: "user", seatType: "standard" }), {
    ok: true,
    source: "pack",
  });
  // The agent is refused with an empty wallet — 0 included, top up.
  assert.deepEqual(fundingFor(state(), m, 10, { kind: "api", seatType: "standard" }), {
    ok: false,
    source: null,
    reason: "insufficient_balance",
  });
  // ...and funded by it when there is money, rather than by the pack.
  assert.deepEqual(fundingFor(state({ wallet: 500 }), m, 10, { kind: "api" }), {
    ok: true,
    source: "wallet",
  });
});

test('a window the caller is not covered by is SKIPPED, not "exhausted"', () => {
  // `onExhausted: "block"` must not refuse a machine caller over an allowance that
  // was never included for it: the reason has to be the wallet, not the pack.
  const m = model({ kind: "per_seat", covers: "users", onExhausted: "block" });
  const f = fundingFor(state(), m, 10, { kind: "api" });
  assert.equal(f.reason, "insufficient_balance");
  assert.notEqual(f.reason, "seat_allowance_reached");
});

test('covers: "users" with no way to buy credits is flagged', () => {
  const found = checkPlansConfig({
    p: {
      sells: { kind: "seats", seatTypes: { s: { price: { monthly: 2104, yearly: 21600 } } } },
      cap: { kind: "per_seat", covers: "users" },
      sale: "self_serve",
    },
  }).checks.filter((c) => /wallet it cannot fill/.test(c.title));
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /every API key and agent/);
});
