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
import { DEFAULT_MESSAGES, describeReason, resolveMessages } from "../dist/i18n.js";

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

// ── describeReason: the tool results' structured refusals, same bundle ───────

test("every reason code resolves to a sentence, in English by default", () => {
  for (const reason of [
    "not_capped", "not_blocked", "already_pending", "limit_reached", "invalid_amount",
    "duplicate", "not_found", "last_admin", "not_a_member", "unsupported",
    "already_on_it", "no_upgrade", "queue_full", "unknown_plan", "at_max",
    "not_purchased", "no_card", "no_email", "charge_failed",
    "multiple_subscriptions", "invalid_basket", "needs_return_url", "no_customer",
    "not_purchasable",
  ]) {
    const out = describeReason(reason);
    assert.notEqual(out, reason, `"${reason}" did not resolve`);
    assert.ok(out.length > 10, `"${reason}" resolved to something too short: "${out}"`);
  }
});

test("a bundle's own words win, and a partial bundle keeps English for the rest", () => {
  const it = { reasonNotCapped: "Questo piano non ha un pacchetto per membro da aumentare" };
  assert.match(describeReason("not_capped", it), /^Questo piano/);
  assert.equal(describeReason("last_admin", it), DEFAULT_MESSAGES.reasonLastAdmin);
});

test("limit_reached means two things, and `of: members` picks the seat sentence", () => {
  assert.equal(describeReason("limit_reached"), DEFAULT_MESSAGES.reasonLimitReached);
  assert.equal(
    describeReason("limit_reached", undefined, { of: "members" }),
    DEFAULT_MESSAGES.reasonMemberLimitReached,
  );
  assert.notEqual(DEFAULT_MESSAGES.reasonLimitReached, DEFAULT_MESSAGES.reasonMemberLimitReached);
});

test("an unknown code echoes itself — visible, never blank", () => {
  assert.equal(describeReason("some_future_code"), "some_future_code");
});
