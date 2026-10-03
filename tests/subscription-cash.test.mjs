// A SUBSCRIPTION invoice is paid in cash too — never out of the wallet.
//
// `credit-sale-cash.test.mjs` closed this for the invoices the library raises. A subscription
// raises its own: a renewal (or a `create_prorations` change, or a scheduled downgrade) is
// created as a DRAFT and auto-finalized by Stripe about an hour later — and finalization is
// where Stripe applies the customer's credit balance, which is the wallet. So credits a
// customer bought for usage paid for their seats.
//
//   • `invoice.created` → `finalizeSubscriptionDraft` finalizes the draft first, with the
//     wallet set aside, through the webhook AND the poller (the backstop for a missed
//     delivery); whichever runs second is a no-op.
//   • an `invoice_now` plan change creates and finalizes its proration invoice inside
//     `subscriptions.update`, so the wallet is set aside around that call.
//   • a paid subscription invoice that DID take from the wallet is reported, never silent.
//
// The fake Stripe applies the balance at finalization, as Stripe does and cannot be told
// not to.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import Stripe from "stripe";

import { __setStripeForTests, finalizeSubscriptionDraft, repayWalletShortfall, withWalletSetAside } from "../dist/billing.js";
import { __setPlanPricesForTests } from "../dist/plans.js";
import { createStripeWebhookHandler } from "../dist/routes/webhook.js";
import { changePlan } from "../dist/subscription.js";
import { SYNC_EVENT_TYPES, createStripeEventHandler } from "../dist/sync.js";
import { BILLING_WEBHOOK_EVENTS } from "../dist/webhook-setup.js";

const SECRET = "whsec_sub";
const real = new Stripe("sk_test_fake");
const PERIOD_END = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000);

let savedSecret;
beforeEach(() => {
  savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  __setStripeForTests(undefined);
  if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
});

function account({ wallet = 0 } = {}) {
  const customer = { id: "cus_1", deleted: false, currency: "eur", balance: -wallet, metadata: {} };
  const txns = [];
  const keyed = new Map();
  const issued = new Map();
  let seq = 0;
  const idempotent = (key, params, make) => {
    if (!key) return make();
    const hit = keyed.get(key);
    if (hit) {
      if (JSON.stringify(hit.params) !== JSON.stringify(params)) throw new Error(`idempotency mismatch ${key}`);
      return hit.result;
    }
    const result = make();
    keyed.set(key, { params, result });
    return result;
  };
  const balanceTxn = (amount, extra) => {
    customer.balance += amount;
    const t = { id: `cbtxn_${++seq}`, amount, ending_balance: customer.balance, currency: "eur", ...extra };
    txns.unshift(t);
    return t;
  };
  /** Stripe's finalization: the credit balance pays first. */
  const finalize = (inv) => {
    if (inv.status !== "draft") throw new Error("This invoice is already finalized");
    const applied = Math.min(Math.max(0, -customer.balance), inv.total);
    inv.starting_balance = customer.balance;
    if (applied > 0) balanceTxn(applied, { type: "applied_to_invoice", invoice: inv.id });
    inv.amount_due = inv.total - applied;
    inv.ending_balance = customer.balance;
    inv.status = inv.amount_due === 0 ? "paid" : "open";
    return inv;
  };
  const draft = (over = {}) => {
    const inv = {
      id: `in_${++seq}`,
      object: "invoice",
      customer: "cus_1",
      currency: "eur",
      status: "draft",
      total: 2_104,
      amount_due: 2_104,
      amount_paid: 0,
      starting_balance: 0,
      billing_reason: "subscription_cycle",
      metadata: {},
      hosted_invoice_url: `https://invoice.stripe.com/i/in_${seq}`,
      ...over,
    };
    issued.set(inv.id, inv);
    return { ...inv };
  };
  let api;
  const self = () => api;
  api = {
    webhooks: real.webhooks,
    customer,
    txns,
    issued,
    draft,
    /** Stripe's own auto-finalize, an hour after creation, for a draft nobody touched. */
    autoFinalize: (id) => finalize(issued.get(id)),
    /** Stripe's auto-advance collecting an open invoice from the card. */
    collect(id) {
      const inv = issued.get(id);
      inv.amount_paid = inv.amount_due;
      inv.status = "paid";
      return { ...inv };
    },
    wallet: () => -customer.balance || 0,
    customers: {
      async retrieve() {
        return { ...customer };
      },
      async createBalanceTransaction(_id, params, opts) {
        return idempotent(opts?.idempotencyKey, params, () =>
          balanceTxn(params.amount, { type: "adjustment", metadata: params.metadata ?? {} }),
        );
      },
    },
    // Read by the poller's renewal-grant branch after the repayment; no plan here grants.
    subscriptions: {
      async retrieve(id) {
        return { id, metadata: {}, items: { data: [] } };
      },
    },
    cards: ["pm_card"],
    declines: false,
    pendingItems: [],
    paymentMethods: {
      async list() {
        return { data: self().cards.map((id) => ({ id })) };
      },
    },
    invoiceItems: {
      async create(params, opts) {
        return idempotent(opts?.idempotencyKey, params, () => {
          const item = { id: `ii_${++seq}`, ...params };
          self().pendingItems.push(item);
          return item;
        });
      },
    },
    invoices: {
      async retrieve(id) {
        return { ...issued.get(id) };
      },
      async finalizeInvoice(id) {
        return { ...finalize(issued.get(id)) };
      },
      async create(params, opts) {
        return idempotent(opts?.idempotencyKey, params, () => {
          const lines = self().pendingItems.splice(0);
          const total = lines.reduce((a, l) => a + l.amount, 0);
          return draft({ total, amount_due: total, billing_reason: "manual", metadata: params.metadata ?? {} });
        });
      },
      async pay(id) {
        const inv = issued.get(id);
        if (self().requiresAction) {
          // What Stripe throws for an off-session charge the bank wants the cardholder for.
          throw Object.assign(new Error("This payment requires authentication."), { code: "authentication_required" });
        }
        if (self().declines) throw new Error("Your card was declined.");
        inv.amount_paid = inv.amount_due;
        inv.status = "paid";
        return { ...inv };
      },
    },
  };
  return self();
}

function signed(evt) {
  const payload = JSON.stringify(evt);
  const header = real.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return new Request("https://t.local/hook", { method: "POST", headers: { "stripe-signature": header }, body: payload });
}
const created = (inv) => ({ id: `evt_c_${inv.id}`, object: "event", type: "invoice.created", data: { object: inv } });

function assertCash(stripe, id) {
  const inv = stripe.issued.get(id);
  assert.equal(inv.amount_paid, inv.total, "the card paid the whole renewal");
  assert.equal(inv.starting_balance, 0, "no credit balance applied");
  assert.equal(stripe.txns.filter((t) => t.type === "applied_to_invoice").length, 0);
}

// ── the renewal ──────────────────────────────────────────────────────────────

test("a renewal draft is finalized OUTSIDE the wallet by the webhook, then collected in full", async () => {
  const stripe = account({ wallet: 5_000 });
  __setStripeForTests(stripe);
  const inv = stripe.draft();

  const res = await createStripeWebhookHandler({ currency: "eur" })(signed(created(inv)));
  assert.equal(res.status, 200);
  assert.equal(stripe.issued.get(inv.id).status, "open", "finalized by us, before Stripe's hour");
  assert.equal(stripe.issued.get(inv.id).amount_due, 2_104);

  stripe.collect(inv.id);
  assertCash(stripe, inv.id);
  assert.equal(stripe.wallet(), 5_000, "the wallet is untouched");
});

test("the CONTROL: left to Stripe's own finalization, the wallet pays the renewal", async () => {
  // What every renewal did before this. Kept so the fake is shown to bite: without it a
  // passing test above would prove nothing about the balance.
  const stripe = account({ wallet: 5_000 });
  __setStripeForTests(stripe);
  const inv = stripe.draft();
  stripe.autoFinalize(inv.id);
  stripe.collect(inv.id);
  assert.equal(stripe.issued.get(inv.id).amount_paid, 0, "charged nothing in cash");
  assert.equal(stripe.wallet(), 5_000 - 2_104);
});

test("the poller is the backstop: the same event through createStripeEventHandler", async () => {
  const stripe = account({ wallet: 5_000 });
  __setStripeForTests(stripe);
  const inv = stripe.draft();
  await createStripeEventHandler({ adapter: {}, plans: {}, currency: "eur" })(created(inv));
  stripe.collect(inv.id);
  assertCash(stripe, inv.id);
});

test("webhook then poller (or a re-delivery): the second is a no-op", async () => {
  const stripe = account({ wallet: 5_000 });
  __setStripeForTests(stripe);
  const inv = stripe.draft();
  await createStripeWebhookHandler({ currency: "eur" })(signed(created(inv)));
  const txnsAfterFirst = stripe.txns.length;
  await createStripeEventHandler({ adapter: {}, plans: {}, currency: "eur" })(created(inv));
  await createStripeWebhookHandler({ currency: "eur" })(signed(created(inv)));
  assert.equal(stripe.txns.length, txnsAfterFirst, "no second set-aside, no second restore");
  assert.equal(stripe.wallet(), 5_000);
});

test("losing the race to Stripe's own finalization is not an error, and the wallet comes back", async () => {
  const stripe = account({ wallet: 5_000 });
  __setStripeForTests(stripe);
  const inv = stripe.draft();
  // Stripe finalizes between our retrieve (draft) and our finalize.
  const realFinalize = stripe.invoices.finalizeInvoice;
  stripe.invoices.finalizeInvoice = async (id) => {
    stripe.issued.get(id).status = "open";
    return realFinalize(id);
  };
  assert.equal(await finalizeSubscriptionDraft(inv), false);
  assert.equal(stripe.wallet(), 5_000, "the set-aside was restored");
});

test("every subscription reason is covered; a non-subscription draft is left alone", async () => {
  for (const reason of ["subscription_cycle", "subscription_update", "subscription_create", "subscription_threshold"]) {
    const stripe = account({ wallet: 100 });
    __setStripeForTests(stripe);
    const inv = stripe.draft({ billing_reason: reason });
    assert.equal(await finalizeSubscriptionDraft(inv), true, reason);
  }
  const stripe = account({ wallet: 100 });
  __setStripeForTests(stripe);
  const manual = stripe.draft({ billing_reason: "manual" });
  assert.equal(await finalizeSubscriptionDraft(manual), false);
  assert.equal(stripe.issued.get(manual.id).status, "draft", "a manual draft is its creator's to finalize");
});

test("an invoice that is no longer a draft is a no-op", async () => {
  const stripe = account({ wallet: 100 });
  __setStripeForTests(stripe);
  const inv = stripe.draft();
  stripe.issued.get(inv.id).status = "open";
  assert.equal(await finalizeSubscriptionDraft(inv), false);
  assert.equal(stripe.txns.length, 0);
});

test("invoice.created is delivered by the webhook AND polled by default", () => {
  assert.ok(BILLING_WEBHOOK_EVENTS.includes("invoice.created"));
  assert.ok(SYNC_EVENT_TYPES.includes("invoice.created"), "the poller's default set, not reconcilePayments only");
});

// ── detection ────────────────────────────────────────────────────────────────

/** A subscription's FIRST invoice exactly as Checkout leaves it: finalized and paid inside
 *  the session, with the welcome credits applied. Measured: 4 208 total, 4 108 charged. */
function checkoutFirstInvoice(stripe, { total = 4_208, took = 100 } = {}) {
  stripe.customer.balance += took; // what Stripe applied
  const inv = stripe.draft({
    billing_reason: "subscription_create",
    total,
    status: "paid",
    starting_balance: -took,
    amount_due: total - took,
    amount_paid: total - took,
    number: "SCRT-0001",
    parent: { subscription_details: { subscription: "sub_1", metadata: { org_id: "org_1" } } },
  });
  stripe.issued.get(inv.id).status = "paid";
  return stripe.issued.get(inv.id);
}
const paidEvt = (inv, n = 1) => ({ id: `evt_paid_${inv.id}_${n}`, object: "event", type: "invoice.paid", data: { object: { ...inv } } });

test("Checkout's first invoice: the wallet's share is collected by card and the credits come back", async () => {
  // REGRESSION (testmode, Stripe TEST in_1UMXyu…): a Hobby→Pro upgrade's first invoice
  // was paid 100 credits from the wallet. Checkout finalizes it itself — no draft, no
  // `invoice.created` window — so it is repaid after the fact instead.
  const stripe = account({ wallet: 100 });
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  assert.equal(stripe.wallet(), 0, "precondition: Stripe applied the wallet");

  const res = await createStripeWebhookHandler({ currency: "eur" })(signed(paidEvt(first)));
  assert.equal(res.status, 200);

  const repay = [...stripe.issued.values()].find((i) => i.metadata?.repays === first.id);
  assert.ok(repay, "a repayment invoice was raised");
  assert.equal(repay.total, 100);
  assert.equal(repay.status, "paid");
  assert.equal(repay.amount_paid, 100, "by the card");
  assert.equal(repay.starting_balance, 0, "and not, in turn, from the wallet");
  assert.equal(stripe.wallet(), 100, "the credits are back");
  assert.equal(first.amount_paid + repay.amount_paid, first.total, "cash collected = the subscription's price");
});

test("the webhook and the poller (and re-deliveries) raise ONE repayment", async () => {
  const stripe = account({ wallet: 100 });
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  const reported = [];
  const handle = createStripeEventHandler({
    adapter: {},
    plans: {},
    currency: "eur",
    hooks: { onPaidFromWallet: (info) => reported.push(info) },
  });
  await createStripeWebhookHandler({ currency: "eur" })(signed(paidEvt(first, 1)));
  await handle(paidEvt(first, 2));
  await createStripeWebhookHandler({ currency: "eur" })(signed(paidEvt(first, 3)));
  const repays = [...stripe.issued.values()].filter((i) => i.metadata?.repays === first.id);
  assert.equal(repays.length, 1);
  assert.equal(stripe.wallet(), 100, "granted once");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].credits, 100);
  assert.equal(reported[0].orgId, "org_1");
  assert.equal(reported[0].repayment.status, "charged");
});

test("a renewal Stripe finalized against a LARGER wallet repays what it took, not what was held", async () => {
  // REGRESSION, measured live: `starting_balance` is the balance BEFORE application. On a
  // 5 000-credit wallet an €18.00 renewal reads -5000 while only 1 800 was applied, and
  // reading that as the shortfall charged the card €50.00 and grew the wallet to 8 200.
  const stripe = account({ wallet: 5_000 });
  __setStripeForTests(stripe);
  const inv = stripe.draft({ total: 1_800, amount_due: 1_800, parent: { subscription_details: { metadata: { org_id: "org_1" } } } });
  stripe.autoFinalize(inv.id); // the escape: both legs missed the draft
  const paid = stripe.collect(inv.id);
  assert.equal(paid.starting_balance, -5_000);

  const r = await repayWalletShortfall(paid, "org_1");
  assert.equal(r.status, "charged");
  assert.equal(r.credits, 1_800);
  assert.equal(stripe.issued.get(r.invoiceId).total, 1_800);
  assert.equal(stripe.wallet(), 5_000, "whole again — not 8 200");
});

test("a declined repayment stays open, and is credited when it is paid", async () => {
  const stripe = account({ wallet: 100 });
  stripe.declines = true;
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  const r = await repayWalletShortfall(first, "org_1");
  assert.equal(r.status, "open");
  assert.equal(stripe.wallet(), 0, "nothing granted for money not collected");

  // The customer pays it from its hosted page; Stripe sends invoice.paid.
  const paid = stripe.collect(r.invoiceId);
  await createStripeWebhookHandler({ currency: "eur" })(signed(paidEvt(paid)));
  assert.equal(stripe.wallet(), 100);
});

test("an SCA challenge on the repayment leaves it open AND tells the admins where to pay", async () => {
  // Off-session, nobody is at a browser to authenticate, so European cards routinely ask
  // for the cardholder here. That must never be a silent failure.
  const stripe = account({ wallet: 100 });
  stripe.requiresAction = true;
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  const sent = [];
  const res = await createStripeWebhookHandler({ currency: "eur", notify: (n) => sent.push(n) })(signed(paidEvt(first)));
  assert.equal(res.status, 200, "an SCA challenge is not a webhook failure");

  const repay = [...stripe.issued.values()].find((i) => i.metadata?.repays === first.id);
  assert.equal(repay.status, "open", "left payable, not voided");
  assert.equal(stripe.wallet(), 0, "nothing granted for money not collected");
  assert.equal(sent.length, 1);
  const n = sent[0];
  assert.equal(n.type, "payment.action_required");
  assert.equal(n.id, `payment-action:${repay.id}`, "stable, so a re-delivery dedupes");
  assert.deepEqual(n.audience, { kind: "admins" });
  assert.equal(n.orgId, "org_1");
  assert.equal(n.data.hostedInvoiceUrl, repay.hosted_invoice_url);
  assert.equal(n.data.amountDue, 100);
  assert.equal(n.data.forInvoiceId, first.id);

  // The customer authenticates on the hosted page; Stripe sends invoice.paid; credited.
  const paid = stripe.collect(repay.id);
  await createStripeWebhookHandler({ currency: "eur" })(signed(paidEvt(paid)));
  assert.equal(stripe.wallet(), 100);
});

test("the poller path announces it too, and the hook sees the decline code", async () => {
  const stripe = account({ wallet: 100 });
  stripe.requiresAction = true;
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  const sent = [];
  const reported = [];
  await createStripeEventHandler({
    adapter: {},
    plans: {},
    currency: "eur",
    notify: (n) => sent.push(n),
    hooks: { onPaidFromWallet: (i) => reported.push(i) },
  })(paidEvt(first));
  assert.equal(sent[0]?.type, "payment.action_required");
  assert.equal(reported[0].repayment.status, "open");
  assert.equal(reported[0].repayment.declineCode, "authentication_required");
});

test("with no notifier, an open repayment is logged as an error with its link — never silent", async () => {
  const stripe = account({ wallet: 100 });
  stripe.requiresAction = true;
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await createStripeWebhookHandler({ currency: "eur" })(signed(paidEvt(first)));
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => /needs the customer/.test(l) && /invoice\.stripe\.com/.test(l)), logged.join("\n"));
});

test("no card on file: nothing is raised, and it is reported", async () => {
  const stripe = account({ wallet: 100 });
  stripe.cards = [];
  __setStripeForTests(stripe);
  const first = checkoutFirstInvoice(stripe);
  const r = await repayWalletShortfall(first, "org_1");
  assert.deepEqual(r, { status: "no_card", credits: 100 });
});

test("an invoice that took nothing from the wallet raises nothing", async () => {
  const stripe = account({ wallet: 0 });
  __setStripeForTests(stripe);
  const inv = checkoutFirstInvoice(stripe, { took: 0 });
  assert.deepEqual(await repayWalletShortfall(inv), { status: "nothing_taken" });
  assert.equal([...stripe.issued.values()].length, 1);
});

// ── an invoice_now plan change ───────────────────────────────────────────────

test("an invoice_now upgrade is charged in full: the wallet is set aside around the update", async () => {
  const stripe = account({ wallet: 3_000 });
  __setPlanPricesForTests(new Map([["starter_monthly", "price_starter"], ["pro_monthly", "price_pro"]]));
  let prorationId = null;
  stripe.subscriptions = {
    async *list() {
      yield {
        id: "sub_1",
        status: "active",
        currency: "eur",
        metadata: { plan: "starter" },
        schedule: null,
        cancel_at_period_end: false,
        default_tax_rates: [],
        items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_starter" }, tax_rates: [], current_period_end: PERIOD_END }] },
      };
    },
    // `always_invoice` creates AND finalizes the proration invoice inside the update.
    async update(id, params) {
      if (params.proration_behavior === "always_invoice") {
        const inv = stripe.draft({ total: 7_200, billing_reason: "subscription_update" });
        prorationId = inv.id;
        await stripe.invoices.finalizeInvoice(inv.id);
        stripe.collect(inv.id);
      }
      return {
        id,
        status: "active",
        metadata: params.metadata ?? {},
        items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_pro" }, current_period_end: PERIOD_END }] },
      };
    },
  };
  stripe.subscriptionSchedules = {};
  stripe.prices = { async *list() {} };
  __setStripeForTests(stripe);

  const r = await changePlan({ async getBillingCustomerId() { return "cus_1"; } }, "org_1", {
    plans: {
      starter: { sells: { kind: "flat", price: { monthly: 1800 } }, cap: { kind: "pool", credits: 1000 }, sale: "self_serve" },
      pro: { sells: { kind: "flat", price: { monthly: 9000 } }, cap: { kind: "pool", credits: 5000 }, sale: "self_serve" },
    },
    to: { plan: "pro", interval: "monthly" },
    currency: "eur",
    record: false,
    proration: "invoice_now",
  });
  assert.equal(r.kind, "updated");
  assertCash(stripe, prorationId);
  assert.equal(stripe.wallet(), 3_000);
});

test("withWalletSetAside: the wallet reads empty inside, and is restored even when fn throws", async () => {
  const stripe = account({ wallet: 800 });
  __setStripeForTests(stripe);
  let inside = null;
  await assert.rejects(
    withWalletSetAside("cus_1", "eur", "op_1", async () => {
      inside = stripe.wallet();
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(inside, 0);
  assert.equal(stripe.wallet(), 800);
});
