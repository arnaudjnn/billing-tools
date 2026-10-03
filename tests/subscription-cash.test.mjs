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

import { __setStripeForTests, finalizeSubscriptionDraft, withWalletSetAside } from "../dist/billing.js";
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
      ...over,
    };
    issued.set(inv.id, inv);
    return { ...inv };
  };
  return {
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
    invoices: {
      async retrieve(id) {
        return { ...issued.get(id) };
      },
      async finalizeInvoice(id) {
        return { ...finalize(issued.get(id)) };
      },
    },
  };
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

test("a paid renewal that took from the wallet is reported", async () => {
  const stripe = account({ wallet: 0 });
  __setStripeForTests(stripe);
  const reported = [];
  const handle = createStripeEventHandler({
    adapter: {},
    plans: {},
    currency: "eur",
    hooks: { onPaidFromWallet: (info) => reported.push(info) },
  });
  const paid = {
    id: "in_escaped",
    object: "invoice",
    customer: "cus_1",
    status: "paid",
    billing_reason: "subscription_cycle",
    starting_balance: -1_500,
    metadata: {},
    parent: { subscription_details: { subscription: null, metadata: { org_id: "org_1" } } },
  };
  await handle({ id: "evt_p", type: "invoice.paid", data: { object: paid } });
  assert.deepEqual(reported, [{ orgId: "org_1", invoiceId: "in_escaped", credits: 1_500 }]);

  await handle({ id: "evt_p2", type: "invoice.paid", data: { object: { ...paid, id: "in_clean", starting_balance: 0 } } });
  assert.equal(reported.length, 1, "a clean renewal reports nothing");
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
