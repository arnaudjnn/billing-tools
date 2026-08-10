// Selling at a price nobody published.
//
// Two things here are unlike everything else in this library, and both are what the tests
// are about. The first: `credits` and money are the same number everywhere else on purpose
// (`CREDITS_PER_UNIT`), and a negotiated deal is exactly the case where they must not be.
// The second: `enforceOperator` FAILS CLOSED, where every other gate here allows when it
// cannot tell — because this one stands between a customer and their own discount.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { answerCreditQuote, listCreditQuotes, requestCreditQuote } from "../dist/credit-quotes.js";
import { enforceOperator, runWithAuth, runWithPrincipal } from "../dist/auth.js";
import { fakeAdapter, WORKOS_MAX_VALUE } from "./helpers.mjs";

const ask = (over = {}) => ({
  memberId: "u_admin",
  term: "annual",
  paymentMethod: "invoice",
  credits: 600_000,
  budgetMinor: 400_000,
  ...over,
});

test("a quote records what was asked, in the terms it was asked in", async () => {
  const a = fakeAdapter({ members: ["u_admin"] });
  const res = await requestCreditQuote(a, "org_1", ask({ credits: undefined, volume: { amount: 20_000, unit: "searches", per: "month" } }));

  assert.equal(res.ok, true);
  // Nobody made them convert searches into credits. Asking a buyer to price the product on
  // our behalf is how a quote form goes unfilled.
  assert.deepEqual(res.quote.volume, { amount: 20_000, unit: "searches", per: "month" });
  assert.equal(res.quote.status, "pending");
});

test("a quote with neither a quantity nor a volume is refused", async () => {
  const a = fakeAdapter({ members: ["u_admin"] });
  const res = await requestCreditQuote(a, "org_1", ask({ credits: undefined }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "nothing_asked", "a question nobody can answer");
});

test("one open quote per WORKSPACE, not per member", async () => {
  // Two admins asking separately would put an operator in the position of answering the same
  // customer twice, with two prices.
  const a = fakeAdapter({ members: ["u_admin", "u_other"] });
  await requestCreditQuote(a, "org_1", ask());
  const second = await requestCreditQuote(a, "org_1", ask({ memberId: "u_other" }));

  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_pending");
  assert.equal(second.pending.memberId, "u_admin", "and it says whose");
});

test("answering frees the workspace to ask again", async () => {
  const a = fakeAdapter({ members: ["u_admin"] });
  const first = await requestCreditQuote(a, "org_1", ask());
  await answerCreditQuote(a, "org_1", { quoteId: first.quote.id, outcome: "denied" });

  const again = await requestCreditQuote(a, "org_1", ask({ credits: 100_000 }));
  assert.equal(again.ok, true);
  const all = await listCreditQuotes(a, "org_1");
  assert.equal(all.length, 2);
  assert.equal(all.filter((q) => q.status === "pending").length, 1);
});

test("the answer carries the two numbers that are allowed to differ", async () => {
  const a = fakeAdapter({ members: ["u_admin"] });
  const { quote } = await requestCreditQuote(a, "org_1", ask());
  const res = await answerCreditQuote(a, "org_1", {
    quoteId: quote.id,
    outcome: "approved",
    answer: {
      credits: 600_000,
      amountMinor: 400_000,
      currency: "eur",
      invoiceId: "in_1",
      validUntil: "2026-12-31",
    },
  });

  assert.equal(res.ok, true);
  // €4 000 for 600 000 credits. At list price those credits are €6 000 — expressing that at
  // all is the capability this whole module exists for.
  assert.equal(res.quote.answer.credits, 600_000);
  assert.equal(res.quote.answer.amountMinor, 400_000);
  assert.ok(res.quote.answer.at, "stamped when it was answered");
});

test("answering a quote that is not open is not found, rather than answered twice", async () => {
  const a = fakeAdapter({ members: ["u_admin"] });
  const { quote } = await requestCreditQuote(a, "org_1", ask());
  await answerCreditQuote(a, "org_1", { quoteId: quote.id, outcome: "approved", answer: { credits: 1, amountMinor: 1, currency: "eur" } });
  const twice = await answerCreditQuote(a, "org_1", { quoteId: quote.id, outcome: "denied" });
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, "not_found");
});

test("the queue stays inside one metadata value, and never sheds a pending ask", async () => {
  const a = fakeAdapter({ members: ["u_admin"] });
  for (let i = 0; i < 8; i++) {
    const { quote } = await requestCreditQuote(
      a,
      "org_1",
      ask({ note: "x".repeat(200), purchaseOrder: `PO-2026-${i}` }),
    );
    if (i < 7) await answerCreditQuote(a, "org_1", { quoteId: quote.id, outcome: "denied" });
  }

  const raw = a.store.btCreditQuotes;
  assert.ok(raw.length <= WORKOS_MAX_VALUE, `the record is ${raw.length} chars`);
  const kept = JSON.parse(raw);
  // Somebody is waiting on a price. Losing the question means they wait for ever, so the
  // history is what gets shed.
  assert.equal(kept.filter((q) => q.status === "pending").length, 1);
});

// ── The gate that fails closed ───────────────────────────────────────────────

const OPERATOR = "ops@ours.test";

test("an org API key cannot approve — and that is the opposite of every other gate", async () => {
  // `enforceAdmin` lets an org key through, because that credential has no user behind it
  // and locking out every management tool would be worse. Here the same reasoning inverts:
  // "unknown allows" would mean any workspace key could approve the discount its own admin
  // just asked for.
  process.env.BILLING_OPERATOR_EMAILS = OPERATOR;
  delete process.env.BILLING_OPERATOR_TOKEN;

  const out = runWithAuth("Bearer sk_live_customer", () => enforceOperator("resolving a credit quote"));
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Forbidden \(403\)/);
});

test("an operator signed in as themselves may", () => {
  process.env.BILLING_OPERATOR_EMAILS = `someone@else.test, ${OPERATOR}`;
  const out = runWithPrincipal({ principal: { userId: "u_ops", email: "OPS@Ours.test" } }, () =>
    enforceOperator("resolving a credit quote"),
  );
  // Case and spacing are not a security boundary.
  assert.equal(out.authorized, true);
});

test("a member of the customer's workspace is not an operator, however admin they are", () => {
  process.env.BILLING_OPERATOR_EMAILS = OPERATOR;
  const out = runWithPrincipal(
    { principal: { userId: "u_admin", email: "boss@customer.test", isAdmin: true } },
    () => enforceOperator("resolving a credit quote"),
  );
  assert.equal(out.isError, true, "approving your own price is not a permission that exists");
});

test("a machine presents a token, which is the headless half", () => {
  process.env.BILLING_OPERATOR_EMAILS = "";
  process.env.BILLING_OPERATOR_TOKEN = "optok_123";

  const ok = runWithAuth("Bearer sk_live_x", () => enforceOperator("resolving a credit quote"), {
    operatorToken: "optok_123",
  });
  assert.equal(ok.authorized, true);

  const wrong = runWithAuth("Bearer sk_live_x", () => enforceOperator("resolving a credit quote"), {
    operatorToken: "optok_nope",
  });
  assert.equal(wrong.isError, true);
});

test("a deployment with no operators configured has nobody who can approve, and says so", () => {
  delete process.env.BILLING_OPERATOR_EMAILS;
  delete process.env.BILLING_OPERATOR_TOKEN;
  const out = runWithPrincipal({ principal: { userId: "u_ops", email: OPERATOR } }, () =>
    enforceOperator("resolving a credit quote"),
  );
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /configured no operators/);
});
