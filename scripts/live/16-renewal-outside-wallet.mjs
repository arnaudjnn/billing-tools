// A subscription RENEWAL is paid by the card — not by the wallet — measured on a test clock.
//
// Stripe creates a renewal as a draft and finalizes it about an hour later; finalization is
// where the customer's credit balance (the wallet) is applied, with no per-invoice opt-out.
// `finalizeSubscriptionDraft` finalizes the draft first, with the wallet set aside, on
// `invoice.created` — delivered by the webhook, and by the poller as the backstop. A test run
// has no public webhook, so this drives the POLLER: the real `pollStripeEvents` walking the
// real event log into the real `createStripeEventHandler`.
//
//   16a  wallet 5 000, renewal draft → finalized by us, then collected: card pays in full
//   16b  CONTROL — the same renewal left to Stripe: the wallet pays it, and the sync
//        collects the shortfall by card and returns the credits (`repayWalletShortfall`),
//        reporting it through `onPaidFromWallet`
//   16c  a FIRST invoice finalized at creation — the shape Checkout produces, where no
//        `invoice.created` window exists — on a wallet of 100: repaid the same way
//
// Each on its own clock and customer (`midCycle`), parked near the period end. The wallet is
// seeded AFTER the subscription starts, so the first invoice is not what is measured.

import { createStripeEventHandler } from "../../dist/sync.js";
import { pollStripeEvents } from "../../dist/events.js";
import { getCreditBalance, grantCredits } from "../../dist/billing.js";
import { defer, eur, ignoreMissing, note, ok, retry } from "../lib/harness.mjs";
import { RUN, STARTER_PLAN, attachTestCard, createClockCustomer } from "../lib/scratch-stripe.mjs";
import { midCycle } from "../lib/scenario.mjs";

const WALLET = 5_000;

export async function run(ctx) {
  const { stripe, adapter, plans } = ctx;
  const scenario = (label) =>
    midCycle(ctx, { plan: STARTER_PLAN, priceKey: `${STARTER_PLAN}_standard_monthly`, at: 0.9, label });

  const renewalOf = async (customerId) => {
    const list = await stripe.invoices.list({ customer: customerId, limit: 10 });
    return list.data.find((i) => i.billing_reason === "subscription_cycle") ?? null;
  };
  const applied = async (customerId, invoiceId) => {
    const out = [];
    for await (const t of stripe.customers.listBalanceTransactions(customerId, { limit: 100 })) {
      if (t.type === "applied_to_invoice" && t.invoice === invoiceId) out.push(t.id);
    }
    return out;
  };

  // ── 16a — finalized by the poller, outside the wallet ──────────────────────
  {
    const s = await scenario(`${RUN} renewal`);
    await grantCredits(s.customerId, WALLET, "Seed wallet", "eur", `${RUN}:renewal-seed`);
    const cursor = (await stripe.events.list({ limit: 1 })).data[0]?.id ?? null;

    // One minute past the boundary: the renewal exists as a DRAFT, inside Stripe's hour.
    await s.toBoundary(60);
    const draft = await retry(async () => {
      const r = await renewalOf(s.customerId);
      if (!r) throw new Error("no renewal yet");
      return r;
    });
    ok("16a: the renewal starts as a draft", draft.status === "draft", draft.status);

    // The poller, for real — scoped to this customer, because the handler finalizes ANY
    // subscription draft and the event log is the whole account's.
    const handle = createStripeEventHandler({ adapter, plans, currency: "eur" });
    const finalized = await retry(
      async () => {
        await pollStripeEvents({
          after: cursor,
          types: ["invoice.created"],
          onEvent: async (e) => {
            if (e.data.object.customer === s.customerId) await handle(e);
          },
        });
        const now = await stripe.invoices.retrieve(draft.id);
        if (now.status === "draft") throw new Error("still a draft — event not listed yet");
        return now;
      },
      { tries: 20, delayMs: 2000 },
    );
    ok("16a: finalized by the poller, before Stripe", finalized.status !== "draft", finalized.status);
    ok("16a: with nothing taken from the wallet", finalized.starting_balance === 0, `starting_balance ${finalized.starting_balance}`);
    ok("16a: the wallet is intact while it is open", (await getCreditBalance(s.customerId, "eur")) === WALLET);

    // Past Stripe's hour: auto-advance collects it from the card.
    await s.toBoundary(3 * 3600);
    const paid = await retry(async () => {
      const inv = await stripe.invoices.retrieve(draft.id);
      if (inv.status !== "paid") throw new Error(`renewal is ${inv.status}`);
      return inv;
    });
    ok("16a: the renewal is paid", paid.status === "paid");
    ok("16a: by the CARD, in full", paid.amount_paid === paid.total && paid.total > 0, `${eur(paid.amount_paid)} of ${eur(paid.total)}`);
    ok("16a: no applied_to_invoice", (await applied(s.customerId, draft.id)).length === 0);
    ok("16a: the wallet still holds every credit", (await getCreditBalance(s.customerId, "eur")) === WALLET, String(await getCreditBalance(s.customerId, "eur")));
  }

  // ── 16b — CONTROL: left to Stripe, and detected ─────────────────────────────
  {
    const s = await scenario(`${RUN} renewal-control`);
    await grantCredits(s.customerId, WALLET, "Seed wallet", "eur", `${RUN}:renewal-control-seed`);
    await s.toBoundary(3 * 3600);
    const inv = await retry(async () => {
      const r = await renewalOf(s.customerId);
      if (!r || r.status === "draft") throw new Error("renewal not finalized yet");
      return r;
    });
    // What the invoice TOOK: `starting_balance` is the wallet before application, so the
    // amount applied is the move to `ending_balance`, not the whole starting figure.
    const took = (inv.ending_balance ?? 0) - (inv.starting_balance ?? 0);
    ok("16b (control): Stripe alone pays the renewal from the wallet", took > 0, `${took} credits, ${eur(inv.amount_paid)} charged of ${eur(inv.total)}`);

    const reported = [];
    const handle = createStripeEventHandler({
      adapter,
      plans,
      currency: "eur",
      hooks: { onPaidFromWallet: (info) => reported.push(info) },
    });
    await handle({ id: `evt_${RUN}_control`, type: "invoice.paid", data: { object: inv } });
    ok("16b: the sync REPORTS it", reported.length === 1 && reported[0].credits === took, JSON.stringify(reported.map((r) => ({ ...r, repayment: r.repayment?.status }))));
    await repaid("16b", s.customerId, inv, reported[0]?.repayment, WALLET);
    note(`control renewal ${inv.id}: ${eur(inv.amount_paid)} cash, ${took} credits — then repaid`);
  }

  // ── 16c — a first invoice finalized at creation (Checkout's shape) ──────────
  {
    // Not `midCycle`: that creates the subscription BEFORE the wallet holds anything. Here the
    // wallet is funded first — the welcome credits a Hobby workspace holds when it upgrades.
    const { customerId } = await createClockCustomer(stripe, { orgId: ctx.orgId, name: `${RUN} first-invoice` });
    await attachTestCard(stripe, customerId);
    await grantCredits(customerId, 100, "Welcome credits", "eur", `${RUN}:first-seed`);
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: ctx.prices.get(`${STARTER_PLAN}_standard_monthly`), quantity: 1 }],
      metadata: { org_id: ctx.orgId, plan: STARTER_PLAN },
    });
    defer(`subscription ${sub.id}`, () => stripe.subscriptions.cancel(sub.id).catch(ignoreMissing));
    const first = await stripe.invoices.retrieve(sub.latest_invoice);
    ok(
      "16c: Stripe applied the wallet to the first invoice (the measured defect)",
      first.status === "paid" && first.starting_balance === -100,
      `${eur(first.amount_paid)} of ${eur(first.total)}, starting_balance ${first.starting_balance}`,
    );
    const reported = [];
    const handle = createStripeEventHandler({
      adapter,
      plans,
      currency: "eur",
      hooks: { onPaidFromWallet: (info) => reported.push(info) },
    });
    await handle({ id: `evt_${RUN}_first`, type: "invoice.paid", data: { object: first } });
    await handle({ id: `evt_${RUN}_first_again`, type: "invoice.paid", data: { object: first } });
    await repaid("16c", customerId, first, reported[0]?.repayment, 100);
  }

  /** The shortfall was collected by card, once, and the wallet is whole again. */
  async function repaid(label, customerId, original, repayment, walletBefore) {
    ok(`${label}: the shortfall was charged`, repayment?.status === "charged", JSON.stringify(repayment));
    const repays = (await stripe.invoices.list({ customer: customerId, limit: 20 })).data.filter(
      (i) => i.metadata?.repays === original.id,
    );
    ok(`${label}: ONE repayment invoice`, repays.length === 1, String(repays.length));
    const r = repays[0];
    if (!r) return;
    ok(`${label}: repaid by the CARD`, r.status === "paid" && r.amount_paid === r.total, `${eur(r.amount_paid)} of ${eur(r.total)}`);
    ok(`${label}: and not, in turn, by the wallet`, r.starting_balance === 0, `starting_balance ${r.starting_balance}`);
    ok(
      `${label}: cash collected = the subscription's price`,
      original.amount_paid + r.amount_paid === original.total,
      `${eur(original.amount_paid)} + ${eur(r.amount_paid)} = ${eur(original.total)}`,
    );
    const now = await getCreditBalance(customerId, "eur");
    ok(`${label}: the wallet is whole again`, now === walletBefore, `${now} vs ${walletBefore}`);
  }
}
