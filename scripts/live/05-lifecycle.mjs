// The subscription lifecycle, through the LIBRARY, on a test clock.
//
// `scripts/e2e-lifecycle.mjs` already proves the Stripe mechanics with the raw SDK. What
// has never been exercised is `previewPlanChange`/`changePlan`/`cancelPlan` themselves —
// the code a consumer actually calls, including the arithmetic that is supposed to make the
// quoted number the charged number.
//
// That is the assertion the section exists for: `preview.dueNow === invoice.amount_due`.
// A quote that disagrees with the charge cannot be caught offline, because both sides come
// from the same fake.
//
// The second claim is tax CARRIED. Every invoice raised here — the prorated upgrade, the
// renewal, the post-release upgrade — must be taxed without anyone passing `taxRates`,
// because a consumer changing a plan is not thinking about VAT. The third of those found a
// real defect (see 05f).

import { taxRatesFor } from "../../dist/tax.js";
import { advanceClock, eur, note, ok, section } from "../lib/harness.mjs";
import { FREE_PLAN, PRO_PLAN, STARTER_PLAN } from "../lib/scratch-stripe.mjs";

const invoiceCount = async (stripe, customerId) =>
  (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.length;

const newestInvoice = async (stripe, customerId) =>
  (await stripe.invoices.list({ customer: customerId, limit: 1 })).data[0];

const taxLines = (invoice) => invoice?.total_taxes?.length ?? 0;

/** The rates on a subscription, from BOTH places Stripe keeps them. */
const ratesOn = (sub) => ({
  items: [...new Set(sub.items.data.flatMap((i) => (i.tax_rates ?? []).map((r) => r.id)))],
  default: (sub.default_tax_rates ?? []).map((r) => (typeof r === "string" ? r : r.id)),
});

export async function run(ctx) {
  const { stripe, api, orgId, customerId, clockId, prices, callers } = ctx;

  // ── first purchase ────────────────────────────────────────────────────────
  section("05a — the first purchase has no subscription to prorate, so it is a checkout");
  const first = await api.subscription.change(
    orgId,
    { plan: STARTER_PLAN },
    { returnUrl: "https://e2e.test/done", uiMode: "hosted" },
  );
  ok("changePlan opens a checkout", first.kind === "checkout", first.kind);
  ok(
    "and hands back a URL a caller with no browser can open",
    typeof first.checkoutUrl === "string" && first.checkoutUrl.startsWith("https://checkout.stripe.com/"),
    first.checkoutUrl?.slice(0, 48),
  );

  // A hosted session cannot be COMPLETED without a browser — Stripe exposes no API for it.
  // So the subscription the rest of the section works on is created directly, reproducing
  // what a completed session leaves behind. Two details are load-bearing:
  //
  //  • `metadata.plan` — `changePlan` reads it as the CURRENT plan key. Without it
  //    `isDowngrade` is false and 05c would apply immediately rather than scheduling,
  //    failing for the wrong reason.
  //  • `tax_rates` PER ITEM, which is where Checkout writes them (checkout.ts:405). This is
  //    what `diffItems` carries onto added lines, so it is what makes the upgrade taxed.
  note("a hosted session cannot be completed headlessly; subscribing directly instead");
  const { rateIds } = await taxRatesFor({
    originCountry: "IT",
    registrations: [{ country: "IT" }],
    country: "IT",
    notes: { exempt: "Operazione non soggetta a IVA" },
  });
  ok("a domestic rate exists for the subscription to carry", rateIds.length === 1, rateIds.join(", "));

  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: prices.get(`${STARTER_PLAN}_standard_monthly`), quantity: 1, tax_rates: rateIds }],
    metadata: { org_id: orgId, plan: STARTER_PLAN },
    proration_behavior: "none",
  });
  ctx.state.subscriptionId = sub.id;
  ok("a live subscription exists to change", ["active", "trialing"].includes(sub.status), sub.status);
  ok("on the lower tier, so the move below is a real upgrade", ratesOn(sub).items.length === 1);

  // ── upgrade: quoted == charged ────────────────────────────────────────────
  section("05b — an upgrade charges exactly what it quoted");
  // `invoice_now` on BOTH sides. The default `next_invoice` defers the difference, so
  // `dueNow` would be 0 and nothing would be raised today to compare against.
  const policy = { timing: "now", proration: "invoice_now" };
  const before = await invoiceCount(stripe, customerId);

  const seats = { standard: 1, premium: 1 };
  const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats }, policy);
  note(
    `quote: due now ${eur(quote.dueNow)}, next invoice ${eur(quote.nextInvoiceTotal)}, credit ${eur(quote.credit)}`,
  );
  ok("an upgrade is quoted as immediate", quote.kind === "immediate", quote.kind);

  const applied = await api.subscription.change(orgId, { plan: PRO_PLAN, seats }, policy);
  // The two vocabularies differ on purpose and are easy to compare wrongly: a PREVIEW
  // reports `immediate`, the CHANGE that carries it out reports `updated`. Pinned here so
  // renaming either half cannot drift silently past a caller switching on `kind`.
  ok("and applied immediately, which the change calls 'updated'", applied.kind === "updated", applied.kind);

  const invoice = await newestInvoice(stripe, customerId);
  const raised = (await invoiceCount(stripe, customerId)) > before;
  ok("an invoice was raised today", raised, invoice?.id);
  if (raised) {
    // THE assertion.
    ok(
      "quoted total === charged total",
      invoice.amount_due === quote.dueNow,
      `quoted ${eur(quote.dueNow)} vs charged ${eur(invoice.amount_due)}`,
    );
    // Nobody passed `taxRates`. If this is 0 an added line went out untaxed, which is the
    // seller's money, not the customer's.
    ok("and the prorated charge is taxed without being asked", taxLines(invoice) > 0, `${taxLines(invoice)} tax line(s)`);
  }

  // ── downgrade: scheduled, nothing charged today ───────────────────────────
  section("05c — a downgrade waits for the period already paid for");
  const beforeDown = await invoiceCount(stripe, customerId);
  const downQuote = await api.subscription.preview(orgId, { plan: STARTER_PLAN });
  ok("a downgrade is quoted as scheduled", downQuote.kind === "scheduled", downQuote.kind);
  ok("charging nothing today", downQuote.dueNow === 0, eur(downQuote.dueNow));
  // Nothing is credited: the customer keeps the tier they already paid for, so they lose
  // nothing and are owed nothing.
  ok("and crediting nothing", downQuote.credit === 0, eur(downQuote.credit));

  const down = await api.subscription.change(orgId, { plan: STARTER_PLAN });
  ok("the change is scheduled", down.kind === "scheduled", down.kind);
  ok("effective at the period end, not today", Boolean(down.effectiveAt), down.effectiveAt);
  ok("no invoice was raised", (await invoiceCount(stripe, customerId)) === beforeDown);

  const still = await stripe.subscriptions.retrieve(ctx.state.subscriptionId);
  const livePrices = still.items.data.map((i) => i.price.id);
  ok(
    "and the customer still holds the tier they paid for",
    livePrices.includes(prices.get(`${PRO_PLAN}_premium_monthly`)),
    livePrices.length + " item(s)",
  );

  // ── the renewal ───────────────────────────────────────────────────────────
  section("05d — at the period end the scheduled plan takes effect");
  const periodEnd = still.items.data[0].current_period_end ?? still.current_period_end;
  await advanceClock(stripe, clockId, periodEnd + 3600);

  const renewal = (await stripe.invoices.list({ customer: customerId, limit: 10 })).data.find(
    (i) => i.billing_reason === "subscription_cycle",
  );
  ok("a renewal invoice was issued", Boolean(renewal), renewal?.id);
  if (renewal) {
    // The regression this guards: an included allowance credited as money would show up here
    // as a negative starting balance, silently discounting the renewal.
    ok("with no credit balance applied to it", renewal.starting_balance === 0, eur(renewal.starting_balance));
    ok("and it is taxed", taxLines(renewal) > 0, `${taxLines(renewal)} tax line(s)`);
  }

  const released = await stripe.subscriptions.retrieve(ctx.state.subscriptionId);
  const afterRelease = released.items.data.map((i) => i.price.id);
  ok(
    "the subscription now holds the downgraded tier",
    afterRelease.includes(prices.get(`${STARTER_PLAN}_standard_monthly`)) &&
      !afterRelease.includes(prices.get(`${PRO_PLAN}_premium_monthly`)),
    afterRelease.length + " item(s)",
  );

  // ── the defect this section found ─────────────────────────────────────────
  section("05f — tax survives a schedule, which it did not");
  // A schedule can only carry tax at the SUBSCRIPTION level, so a released one leaves the
  // items bare. `diffItems` read only the items, so the next upgrade's added line was
  // invoiced at 0% — on any subscription that had ever been downgraded. It now reads both.
  const where = ratesOn(released);
  note(`after release: ${where.items.length} item rate(s), ${where.default.length} default rate(s)`);
  ok("the rates survived somewhere", where.items.length + where.default.length > 0);

  const beforeRe = await invoiceCount(stripe, customerId);
  const reQuote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats }, policy);
  await api.subscription.change(orgId, { plan: PRO_PLAN, seats }, policy);
  const reInvoice = await newestInvoice(stripe, customerId);
  if ((await invoiceCount(stripe, customerId)) > beforeRe) {
    ok(
      "an upgrade AFTER a downgrade released is still taxed",
      taxLines(reInvoice) > 0,
      `${taxLines(reInvoice)} tax line(s)`,
    );
    ok(
      "and still charges what it quoted",
      reInvoice.amount_due === reQuote.dueNow,
      `quoted ${eur(reQuote.dueNow)} vs charged ${eur(reInvoice.amount_due)}`,
    );
  }
  ctx.state.taxedInvoiceId = reInvoice?.id;

  // ── cancel ────────────────────────────────────────────────────────────────
  section("05e — cancelling keeps the period already paid for");
  const cancelled = await api.subscription.cancel(orgId);
  ok("cancel is a scheduled move, not an immediate one", cancelled.kind === "canceling", cancelled.kind);
  ok("effective at the period end", Boolean(cancelled.effectiveAt), cancelled.effectiveAt);

  const afterCancel = await stripe.subscriptions.retrieve(ctx.state.subscriptionId);
  ok("Stripe agrees it ends at the period end", afterCancel.cancel_at_period_end === true);

  // `cancel_plan`'s gate, deferred here from the roles matrix because its allowed path IS
  // the mutation. Safe to re-run: `changePlan` returns `canceling` without re-writing when
  // the flag is already set.
  const byMember = await callers.asMember("cancel_plan", {});
  ok(
    "a member cannot cancel the workspace's plan",
    !byMember.ok && /Forbidden \(403\)/.test(byMember.error ?? ""),
    byMember.ok ? "ALLOWED" : (byMember.error ?? "").slice(0, 60),
  );

  ctx.state.freePlan = FREE_PLAN;
}
