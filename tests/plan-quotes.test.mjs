// Custom pricing: the gate, and what a customer is told exists.
//
// The ASK and its store are `plan-request.test.mjs` now — asking to move to a plan you
// cannot buy self-serve turned out to be the same act as asking to move to one you can, so
// it queues in the same place with the same verb. What is left here is the half that is
// genuinely different: who may PRICE it, and who is even told the tool exists.
//
// `enforceOperator` fails CLOSED, where every other gate in this library allows when it
// cannot tell. Everywhere else the thing prevented is smaller than the thing broken; here it
// stands between a customer and their own discount.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { enforceOperator, runWithAuth, runWithPrincipal } from "../dist/auth.js";
import { __setStripeForTests, sellCredits } from "../dist/billing.js";
import { requestPlanChange } from "../dist/plan-request.js";
import { fakeAdapter } from "./helpers.mjs";

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

// ── The money half: what Stripe is actually SENT ─────────────────────────────

/** Enough of Stripe for one sale, recording the params rather than answering questions.
 *  `cards` seeds the wallet: empty is the INVOICE path, one card is the charge path. */
function saleStripe(sent, cards = []) {
  return {
    customers: { retrieve: async () => ({ id: "cus_1", email: "ap@customer.test" }) },
    // The card decides the whole shape of the charge, so it is the first thing read.
    paymentMethods: { list: async () => ({ data: cards }) },
    invoiceItems: {
      create: async (params) => {
        sent.item = params;
        return { id: "ii_1" };
      },
    },
    invoices: {
      create: async (params) => {
        sent.invoice = params;
        return { id: "in_1" };
      },
      finalizeInvoice: async () => ({ id: "in_1", hosted_invoice_url: "https://pay.test/in_1" }),
      sendInvoice: async () => ({ id: "in_1", hosted_invoice_url: "https://pay.test/in_1", due_date: 1 }),
      pay: async (id) => ((sent.paid = id), { id, hosted_invoice_url: "https://pay.test/in_1" }),
    },
  };
}

test("a negotiated invoice carries the deployment's tax, resolved rather than skipped", async () => {
  const sent = {};
  __setStripeForTests(saleStripe(sent));

  // Nothing about tax is passed in. Until this, nothing resolved it either: the largest sale
  // the library makes went out at 0% while every seat invoice and every top-up on the same
  // account carried the account's rate — the auto-reload defect, on an Enterprise deal.
  const res = await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "stripe" } }, {
    credits: 600_000,
    amountMinor: 400_000,
    purchaseOrder: "PO-4471",
  });

  assert.equal(res.status, "invoiced");
  assert.equal(sent.item.currency, "eur", "the currency comes from the config, not a default");
  assert.deepEqual(sent.invoice.automatic_tax, { enabled: true });
  // What the payment grants, which is the whole reason the two numbers differ.
  assert.deepEqual(sent.invoice.metadata, { org_id: "org_1", credits: "600000" });
  assert.deepEqual(sent.invoice.custom_fields, [{ name: "PO", value: "PO-4471" }]);
});

test("manual rates ride the ITEM, and exclude `automatic_tax` — Stripe rejects both", async () => {
  const sent = {};
  __setStripeForTests(saleStripe(sent));

  await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "none" } }, {
    credits: 1000,
    amountMinor: 900,
    tax: { taxRates: ["txr_it_22"] },
  });

  assert.deepEqual(sent.item.tax_rates, ["txr_it_22"]);
  assert.equal(sent.invoice.automatic_tax, undefined);
});

test("an untaxed deployment stays untaxed, explicitly", async () => {
  const sent = {};
  __setStripeForTests(saleStripe(sent));
  await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "none" } }, {
    credits: 1000,
    amountMinor: 900,
  });
  assert.equal(sent.item.tax_rates, undefined);
  assert.equal(sent.invoice.automatic_tax, undefined);
});

test("the Enterprise ask is a PLAN request, with the form's own fields on it", async () => {
  // No second verb, no second store. A quote-only plan is one a customer cannot buy
  // self-serve, and asking to move to it is the same act as asking to move to any other —
  // which is why it queues where every other upgrade ask already queued.
  const a = fakeAdapter({ members: ["u_admin"] });
  const res = await requestPlanChange(a, "org_1", {
    memberId: "u_admin",
    plans: {
      pro: { sells: { kind: "flat", price: { monthly: 1800 } }, cap: { kind: "pool", credits: 1000 }, sale: "self_serve" },
      enterprise: { sells: { kind: "flat", price: { monthly: 0 } }, cap: { kind: "wallet" }, sale: "quote" },
    },
    currentPlan: "pro",
    plan: "enterprise",
    // A BAG, not fields: the library acts on none of it, and the next consumer will want a
    // region or a start date rather than a headcount.
    metadata: { totalEstimatedSeats: 12 },
    contact: { firstName: "Giulia", lastName: "Rossi", email: "giulia@acme.it" },
  });

  assert.equal(res.ok, true);
  const [filed] = await (await import("../dist/plan-request.js")).listPlanRequests(a, "org_1");
  assert.deepEqual(filed.metadata, { totalEstimatedSeats: 12 });
  assert.equal(filed.contact.email, "giulia@acme.it");
  assert.equal(filed.status, "pending", "nothing is priced yet");
});

// ── What a customer is TOLD exists ───────────────────────────────────────────
//
// The gate is `enforceOperator`, at call time, and it does not care what was advertised.
// This is the other half: a tool list that offers "price somebody else's workspace" to a
// customer describes a capability they will never have, and an agent reading that list
// will spend a call finding out.


function registeredNames(opts = {}) {
  const names = new Set();
  const server = { tool: (name) => void names.add(name) };
  registerBillingTools(server, {
    adapter: { async validateApiKey() { return { orgId: "org_1" }; }, async getOrgMetadata() { return {}; }, async setOrgMetadata() {} },
    config: { baseUrl: "https://x.test" },
    // A catalogue, because `request_plan_change` lives with the subscription tools and
    // those register only where there are plans to move between.
    plans: {
      pro: { sells: { kind: "flat", price: { monthly: 1800 } }, cap: { kind: "pool", credits: 1000 }, sale: "self_serve" },
      enterprise: { sells: { kind: "flat", price: { monthly: 0 } }, cap: { kind: "wallet" }, sale: "quote" },
    },
    ...opts,
  });
  return names;
}

import { registerBillingTools, OPERATOR_TOOL_NAMES } from "../dist/tools/register.js";
import { createToolListHandler } from "../dist/routes/rest.js";

test("the customer's tool set leaves the operator half out", () => {
  const all = registeredNames();
  const customer = registeredNames({ operatorTools: false });

  for (const name of OPERATOR_TOOL_NAMES) {
    assert.ok(all.has(name), `${name} should exist in the full set`);
    assert.equal(customer.has(name), false, `${name} must not be advertised to a customer`);
  }
  // And nothing else moved: hiding two tools is not an excuse to drop a third.
  assert.equal(customer.size, all.size - OPERATOR_TOOL_NAMES.length);
  // The ask is `request_plan_change` — the same verb as any other upgrade, which is the
  // whole point of the collapse — and accepting a price is the customer's too.
  assert.ok(customer.has("request_plan_change"), "the ASK is the customer's own");
  assert.ok(customer.has("accept_plan_quote"), "and so is taking the price");
});

test("the REST list hides them from a caller who is not an operator", async () => {
  const dispatcher = { getToolNames: () => ["get_credit_balance", ...OPERATOR_TOOL_NAMES] };
  const list = createToolListHandler({
    dispatcher,
    toolCosts: {},
    operatorTools: OPERATOR_TOOL_NAMES,
  });

  process.env.BILLING_OPERATOR_TOKEN = "optok_list";
  const asCustomer = await (await list(new Request("https://x.test/api/v0"))).json();
  assert.deepEqual(
    asCustomer.tools.map((t) => t.name),
    ["get_credit_balance"],
  );

  const asOperator = await (
    await list(new Request("https://x.test/api/v0", { headers: { "x-operator-token": "optok_list" } }))
  ).json();
  assert.deepEqual(asOperator.tools.map((t) => t.name).sort(), [
    "get_credit_balance",
    "quote_plan_change",
    "sell_credits",
  ]);
  delete process.env.BILLING_OPERATOR_TOKEN;
});


// ── Card on file, or a bill: the shape "accept" takes ────────────────────────

test("a card on file is CHARGED, off-session, and the invoice is not emailed", async () => {
  // What a person expects from pressing accept: somebody who has already given us a card
  // does not want a bill in their inbox. Off-session because nobody is at a browser — this
  // is an admin accepting a price agreed days ago.
  const sent = {};
  __setStripeForTests(saleStripe(sent, [{ id: "pm_1" }]));
  const res = await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "none" } }, {
    credits: 600_000,
    amountMinor: 400_000,
  });

  assert.equal(res.status, "charged");
  assert.equal(sent.paid, "in_1", "paid off-session rather than sent");
  assert.equal(sent.invoice.collection_method, "charge_automatically");
  assert.equal(sent.invoice.default_payment_method, "pm_1");
  // The negotiated pair survives: €4 000 charged, 600 000 credits granted on payment.
  assert.equal(sent.item.amount, 400_000);
  assert.equal(sent.invoice.metadata.credits, "600000");
});

test("no card falls back to an emailed invoice rather than refusing", async () => {
  const sent = {};
  __setStripeForTests(saleStripe(sent, []));
  const res = await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "none" } }, {
    credits: 1_000,
    amountMinor: 900,
  });

  assert.equal(res.status, "invoiced");
  assert.equal(sent.invoice.collection_method, "send_invoice");
  assert.equal(sent.invoice.days_until_due, 30, "net 30, because procurement does not pay on receipt");
});

test("`saved_card` refuses instead of falling back, for a caller that needs to know", async () => {
  __setStripeForTests(saleStripe({}, []));
  const res = await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "none" } }, {
    credits: 1_000,
    amountMinor: 900,
    method: "saved_card",
  });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "no_card");
});

test("a declined card leaves the finalized invoice behind, payable", async () => {
  // The worst outcome would be losing a real bill to a decline. It is finalized, it has a
  // hosted page, and the credits still land through `invoice.paid` whenever it settles.
  const sent = {};
  const stripe = saleStripe(sent, [{ id: "pm_1" }]);
  stripe.invoices.pay = async () => {
    throw new Error("card_declined");
  };
  __setStripeForTests(stripe);
  const res = await sellCredits("cus_1", "org_1", { currency: "eur", tax: { mode: "none" } }, {
    credits: 1_000,
    amountMinor: 900,
  });

  assert.equal(res.status, "invoiced");
  assert.equal(res.invoiceId, "in_1");
  assert.equal(res.emailed, false, "it was never sent — it was meant to be charged");
});


test("an oversized metadata bag is dropped, and the ask survives without it", async () => {
  // The whole queue shares one 600-character value. A bag big enough to evict somebody's
  // pending request must not: losing the form's extras is recoverable, losing the question
  // is not.
  const a = fakeAdapter({ members: ["u_admin"] });
  const plans = {
    pro: { sells: { kind: "flat", price: { monthly: 1800 } }, cap: { kind: "pool", credits: 1000 }, sale: "self_serve" },
    enterprise: { sells: { kind: "flat", price: { monthly: 0 } }, cap: { kind: "wallet" }, sale: "quote" },
  };
  const res = await requestPlanChange(a, "org_1", {
    memberId: "u_admin",
    plans,
    currentPlan: "pro",
    plan: "enterprise",
    metadata: { essay: "x".repeat(400) },
  });

  assert.equal(res.ok, true, "the ask is filed regardless");
  const [filed] = await (await import("../dist/plan-request.js")).listPlanRequests(a, "org_1");
  assert.equal(filed.metadata, undefined);
});
