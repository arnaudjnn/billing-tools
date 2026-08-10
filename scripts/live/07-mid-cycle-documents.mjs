// What the CUSTOMER sees on the invoice, for every mid-cycle money event.
//
// 05 asserts the totals are right. This asserts they are EXPLAINED — that the document a
// customer receives shows why it says what it says. Those are different claims, and the
// second is the one a customer disputes: an €109.80 charge with no visible credit for the
// half-month they had already paid for reads as being billed twice.
//
// Three events, three documents:
//
//   mid-cycle upgrade  → an invoice TODAY carrying a negative line (unused time on the old
//                        tier) and a positive line (the new tier's remainder)
//   mid-cycle downgrade→ NO document today; the change appears on the renewal
//   a top-up           → an invoice, not a receipt. A receipt is not a valid sales document
//                        in most of the EU, and this is the one purchase with no
//                        subscription behind it to carry the tax.

import { advanceClock, eur, note, ok, section } from "../lib/harness.mjs";
import { PRO_PLAN, STARTER_PLAN, attachTestCard, createClockCustomer } from "../lib/scratch-stripe.mjs";
import { getAutoReloadSettings, setAutoReloadSettings, tryAutoReload } from "../../dist/billing.js";
import { createCreditCheckoutSession, quoteCreditPurchase } from "../../dist/billing.js";
import { taxRatesFor } from "../../dist/tax.js";

const REGIME = { originCountry: "IT", registrations: [{ country: "IT" }], country: "IT" };

const newest = async (stripe, customerId) =>
  (await stripe.invoices.list({ customer: customerId, limit: 1, expand: ["data.lines"] })).data[0];

/** Proration lines, split by sign — the credit and the charge. */
const prorations = (invoice) => {
  const lines = invoice?.lines?.data ?? [];
  return {
    credits: lines.filter((l) => l.amount < 0),
    charges: lines.filter((l) => l.amount > 0),
    all: lines,
  };
};

export async function run(ctx) {
  const { stripe, api, orgId, prices, config, adapter } = ctx;

  // Its OWN customer and clock, for two reasons that both bit:
  //
  //  • 05 leaves a live (cancel-at-period-end) subscription, and `changePlan` REFUSES to
  //    guess between two — correctly, since picking one would move the wrong plan.
  //  • 05 has already advanced the shared clock past a period boundary, and a test clock
  //    cannot be wound backwards to the midpoint this section needs.
  //
  // The org's billing pointer is repointed for the duration and restored at the end.
  const previousCustomerId = await adapter.getBillingCustomerId(orgId);
  const { clockId, customerId } = await createClockCustomer(stripe, { orgId, name: "E2E Documents" });
  await attachTestCard(stripe, customerId);
  await adapter.setBillingCustomerId(orgId, customerId);

  // A subscription of its own, mid-cycle. Item-level tax rates, as a completed Checkout
  // leaves them.
  const { rateIds } = await taxRatesFor({ ...REGIME, notes: config.tax.notes });
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: prices.get(`${STARTER_PLAN}_standard_monthly`), quantity: 1, tax_rates: rateIds }],
    metadata: { org_id: orgId, plan: STARTER_PLAN },
    proration_behavior: "none",
  });
  const periodEnd = sub.items.data[0].current_period_end;
  const halfway = sub.items.data[0].current_period_start + Math.floor((periodEnd - sub.items.data[0].current_period_start) / 2);

  // ── halfway through the paid period ───────────────────────────────────────
  section("07a — half the month they paid for is already gone");
  await advanceClock(stripe, clockId, halfway);
  note(`clock at the midpoint; the period ends ${new Date(periodEnd * 1000).toISOString().slice(0, 10)}`);

  // ── upgrade ───────────────────────────────────────────────────────────────
  section("07b — an upgrade invoice SHOWS the credit for what they already paid");
  const policy = { timing: "now", proration: "invoice_now" };
  const seats = { standard: 1, premium: 1 };
  const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats }, policy);
  await api.subscription.change(orgId, { plan: PRO_PLAN, seats }, policy);

  const upgrade = await newest(stripe, customerId);
  const { credits, charges, all } = prorations(upgrade);
  note(`invoice ${upgrade.id}: ${all.length} line(s), total ${eur(upgrade.total)}`);
  for (const l of all) note(`  ${eur(l.amount).padStart(10)}  ${l.description}`);

  // THE claim of this section: the customer can see why.
  ok("a credit line for the unused half of the old tier", credits.length > 0, credits.map((l) => eur(l.amount)).join(", ") || "NONE — reads as double billing");
  ok("and a charge line for the new tier", charges.length > 0, charges.map((l) => eur(l.amount)).join(", "));
  ok(
    "the lines add up to what is charged, before tax",
    all.reduce((sum, l) => sum + l.amount, 0) === upgrade.total - (upgrade.total_taxes ?? []).reduce((s, t) => s + (t.amount ?? 0), 0),
    `${eur(all.reduce((s, l) => s + l.amount, 0))} of ${eur(upgrade.total)}`,
  );
  ok("and the quote said the same number", upgrade.amount_due === quote.dueNow, `${eur(quote.dueNow)} vs ${eur(upgrade.amount_due)}`);
  // Every line, not just the total: an untaxed credit line beside a taxed charge would
  // over-collect, since the refunded half would be refunded net and re-charged gross.
  const untaxed = all.filter((l) => (l.taxes ?? l.tax_amounts ?? []).length === 0);
  ok("every line carries tax, including the credit", untaxed.length === 0, untaxed.map((l) => l.description).join(", ") || "all taxed");

  // ── downgrade ─────────────────────────────────────────────────────────────
  section("07c — a downgrade produces NO document today, deliberately");
  const countBefore = (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.length;
  const down = await api.subscription.preview(orgId, { plan: STARTER_PLAN });
  await api.subscription.change(orgId, { plan: STARTER_PLAN });
  const countAfter = (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.length;

  ok("nothing is invoiced today", countAfter === countBefore, `${countBefore} → ${countAfter}`);
  ok("and nothing is credited", down.credit === 0, eur(down.credit));
  // Not a gap: they keep the tier they paid for until the period they paid for runs out, so
  // there is nothing to refund and nothing to tell them beyond the effective date.
  ok("the customer is told WHEN instead", Boolean(down.effectiveAt), down.effectiveAt);

  section("07d — and the renewal is where the new tier appears");
  await advanceClock(stripe, clockId, periodEnd + 3600);
  const renewal = (await stripe.invoices.list({ customer: customerId, limit: 10, expand: ["data.lines"] })).data.find(
    (i) => i.billing_reason === "subscription_cycle",
  );
  ok("a renewal invoice was issued", Boolean(renewal), renewal?.id);
  if (renewal) {
    const lines = renewal.lines?.data ?? [];
    for (const l of lines) note(`  ${eur(l.amount).padStart(10)}  ${l.description}`);
    ok(
      "priced at the tier they downgraded TO",
      lines.some((l) => l.pricing?.price_details?.price === prices.get(`${STARTER_PLAN}_standard_monthly`)),
      lines.map((l) => eur(l.amount)).join(", "),
    );
    ok("and it is taxed", (renewal.total_taxes?.length ?? 0) > 0, `${renewal.total_taxes?.length} tax line(s)`);
  }

  // ── top-ups ───────────────────────────────────────────────────────────────
  section("07e — a top-up is a sales document, not a receipt");
  // The quote first, from the same TaxRate objects the charge will carry — so what a caller
  // is shown before paying is what they are charged.
  const purchaseRates = await taxRatesFor({ ...REGIME, notes: config.tax.notes });
  // Both APIs take the amount in MAJOR units and 1 credit is 1 MINOR unit, so €10 buys
  // 1 000 credits. Getting that backwards is a factor of 100 in either direction.
  const priced = await quoteCreditPurchase(10, purchaseRates.rateIds);
  note(`€10 top-up: ${priced.credits} credits, net ${eur(priced.subtotal)}, tax ${eur(priced.tax)}, total ${eur(priced.total)}`);
  ok("€10 buys 1 000 credits", priced.credits === 1_000, `${priced.credits}`);
  ok("and the quote adds 22% IVA", priced.total === 1_220 && priced.taxPercent === 22, `${eur(priced.total)} at ${priced.taxPercent}%`);

  // `{ url, clientSecret, sessionId }`, not a string. It used to be one string whose meaning
  // depended on the mode, which forced every embedded caller to recover the session id by
  // splitting the client secret on `_secret_` — a consumer did exactly that, in production.
  // This section was written after that changed and asserted the old shape anyway, so 07e had
  // never passed; the first full run since is what said so.
  const session = await createCreditCheckoutSession(customerId, orgId, 10, config, {
    taxRates: purchaseRates.rateIds,
    successUrl: "https://e2e.test/ok",
    cancelUrl: "https://e2e.test/no",
  });
  ok(
    "the top-up returns a URL a caller with no browser can hand over",
    session.url?.startsWith("https://checkout.stripe.com/"),
    session.url?.slice(0, 44),
  );
  ok("and the session id, without anyone parsing a client secret for it", Boolean(session.sessionId), session.sessionId?.slice(0, 12));

  const full = (await stripe.checkout.sessions.list({ customer: customerId, limit: 1 })).data[0];
  // A hosted session cannot be COMPLETED headlessly, so the assertions are on what it WILL
  // produce — which is exactly the part that was wrong before this was audited.
  ok("it will issue an INVOICE, not just a receipt", full.invoice_creation?.enabled === true);
  ok("it requires the billing address", full.billing_address_collection === "required", full.billing_address_collection);
  ok("it offers the VAT-number field that reverse-charges the sale", full.tax_id_collection?.enabled === true);
  // `customer_update` is NOT assertable here, and it is worth recording why rather than
  // quietly dropping it: Stripe accepts the parameter and never echoes it back — undefined
  // on create, on retrieve and on list. So the only place it can be pinned is offline,
  // against the params SENT (`tests/credit-quote.test.mjs`). Without it the typed address
  // stays on the session and never reaches the Customer, where the NEXT charge looks.
  note("customer_update is write-only in Stripe's API — pinned offline, not here");
  ok("charging the same total the quote showed", full.amount_total === 1_220, eur(full.amount_total));

  // ── auto-reload ───────────────────────────────────────────────────────────
  section("07f — auto-reload is the one purchase nobody confirms, so it must invoice");
  await setAutoReloadSettings(customerId, 500, 2_000, true);
  const settings = await getAutoReloadSettings(customerId);
  ok("auto-reload is armed", settings?.enabled === true, `threshold ${settings?.threshold}`);

  const beforeReload = (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.length;
  // A thunk, not a value: it resolves only past every early return, which is what keeps a
  // VIES lookup off the metered hot path.
  await tryAutoReload(customerId, "eur", async () => ({ taxRates: purchaseRates.rateIds }));
  const reload = await newest(stripe, customerId);
  const raised = (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.length > beforeReload;

  ok("it raised an INVOICE", raised && reload?.object === "invoice", reload?.id);
  if (raised) {
    ok("with a tax line, from config.tax and not from a per-call argument", (reload.total_taxes?.length ?? 0) > 0, `${reload.total_taxes?.length}`);
    ok("and a PDF, which a receipt has no equivalent of", Boolean(reload.invoice_pdf), reload.invoice_pdf ? "yes" : "none");
    note(`auto-reload invoice ${reload.id}: ${eur(reload.total)}`);
  }
  await setAutoReloadSettings(customerId, 0, 0, false);

  // Hand the org back its original customer, so nothing after this reads a customer that is
  // about to be torn down.
  if (previousCustomerId) await adapter.setBillingCustomerId(orgId, previousCustomerId);
}
