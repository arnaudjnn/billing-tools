// The library's own strings, overridden once.
//
// `describeDenial` is the one part of this package a REFUSED caller actually reads — and it
// was the one part a deployment could not translate: it hardcoded its own English and
// skipped the message table, while three keys in that table said nearly the same thing and
// were read by nobody, and the two refusals customers meet most (`rate_limit_reached`,
// `spend_limit_reached`) had no key at all. So the same customer got Italian in the browser
// and English from a tool call.

import assert from "node:assert/strict";
import { test } from "vitest";

import { describeDenial } from "../dist/allowance.js";
import { DEFAULT_MESSAGES, resolveMessages } from "../dist/i18n.js";

const state = {
  plan: "pro",
  cycle: { start: 0, end: null, key: "2026-08" },
  limits: [
    {
      every: "week",
      scope: "caller",
      label: null,
      size: 500,
      used: 500,
      remaining: 0,
      window: { start: 0, end: Date.UTC(2026, 7, 10) },
      kind: "rate",
    },
  ],
  pool: { size: 1000, used: 1000, remaining: 0 },
  pack: null,
  wallet: 0,
};

test("the two refusals with no key at all now have one", () => {
  // They are the ones a customer meets most, and neither could be translated.
  assert.equal(typeof DEFAULT_MESSAGES.rateLimitReached, "string");
  assert.equal(typeof DEFAULT_MESSAGES.spendLimitReached, "string");
});

test("English by default, and the sentence still says what it said", () => {
  const out = describeDenial("rate_limit_reached", state);
  assert.match(out, /Usage limit reached for this week \(500\)/);
  assert.match(out, /Resets 2026-08-10/);
});

test("a deployment's own words reach a refusal, not just its screens", () => {
  const it = {
    rateLimitReached: "Hai raggiunto il limite di questa {name} ({size}).{resets}",
    poolExhausted: "Allowance del piano esaurita ({size} crediti).",
    insufficientBalance: "Credito insufficiente (saldo {balance}).",
  };
  assert.match(describeDenial("rate_limit_reached", state, undefined, it), /^Hai raggiunto/);
  assert.match(describeDenial("pool_exhausted", state, undefined, it), /^Allowance del piano/);
  assert.match(describeDenial("insufficient_balance", state, undefined, it), /saldo 0/);
  // A key left out falls back to English rather than to nothing.
  assert.equal(
    describeDenial("seat_allowance_reached", state, undefined, it),
    resolveMessages(it).seatAllowanceReached,
  );
});
