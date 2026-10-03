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
//        reports it through `onPaidFromWallet` (detection, so an escape is never silent)
//
// Each on its own clock and customer (`midCycle`), parked near the period end. The wallet is
// seeded AFTER the subscription starts, so the first invoice is not what is measured.

import { createStripeEventHandler } from "../../dist/sync.js";
import { pollStripeEvents } from "../../dist/events.js";
import { getCreditBalance, grantCredits } from "../../dist/billing.js";
import { eur, note, ok, retry } from "../lib/harness.mjs";
import { RUN, STARTER_PLAN } from "../lib/scratch-stripe.mjs";
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
    const took = -(inv.starting_balance ?? 0);
    ok("16b (control): Stripe alone pays the renewal from the wallet", took > 0, `${took} credits, ${eur(inv.amount_paid)} charged of ${eur(inv.total)}`);

    const reported = [];
    const handle = createStripeEventHandler({
      adapter,
      plans,
      currency: "eur",
      hooks: { onPaidFromWallet: (info) => reported.push(info) },
    });
    await handle({ id: `evt_${RUN}_control`, type: "invoice.paid", data: { object: inv } });
    ok("16b: and the sync REPORTS it", reported.length === 1 && reported[0].credits === took, JSON.stringify(reported));
    note(`control renewal ${inv.id}: ${eur(inv.amount_paid)} cash, ${took} credits`);
  }
}
