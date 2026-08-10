// Tax, and the one claim the offline suite structurally cannot make.
//
// `tests/tax*.test.mjs` proves the decision table exhaustively — and stubs `getStripe` and
// the VIES validator to do it. So what has never been established is the step AFTER the
// decision: that the rate becomes a real Stripe TaxRate carrying the legally mandatory
// wording, and that it lands on a real invoice at the right amount.
//
// That is all this section asserts. It deliberately does NOT re-walk the decision table
// (OSS, registrations, US nexus, the Greek EL/GR spelling) — offline covers those
// deterministically, and live would add only latency and a dependency on a member state's
// uptime.

import { createCheckoutSession, expireCheckoutSession } from "../../dist/checkout.js";
import {
  invalidateTaxRates,
  resolveTax,
  taxRatesFor,
  updateCheckoutSessionTaxRates,
} from "../../dist/tax.js";
import { defer, eur, note, ok, section, skip } from "../lib/harness.mjs";
import { RUN, STARTER_PLAN } from "../lib/scratch-stripe.mjs";

const REGIME = { originCountry: "IT", registrations: [{ country: "IT" }], oss: true };
const NOTES = {
  exempt: "Operazione non soggetta a IVA",
  reverseCharge: "Inversione contabile, art. 196 dir. 2006/112/CE",
};

/** Charge €100 and read what tax Stripe actually put on it. */
async function invoiceWith(stripe, customerId, rateIds, { net = 10_000 } = {}) {
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: "charge_automatically",
    auto_advance: false,
    metadata: { bt_scratch: RUN },
  });
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: invoice.id,
    currency: "eur",
    amount: net,
    description: `${RUN} tax probe`,
    ...(rateIds?.length ? { tax_rates: rateIds } : {}),
  });
  return stripe.invoices.finalizeInvoice(invoice.id);
}

const rateIdOf = (line) => line?.tax_rate_details?.tax_rate ?? line?.tax_rate?.id ?? line?.tax_rate;

export async function run(ctx) {
  const { stripe, customerId } = ctx;
  invalidateTaxRates();

  // ── domestic ──────────────────────────────────────────────────────────────
  section("03a — domestic: computed, minted, and charged");
  const domestic = await resolveTax({ ...REGIME, country: "IT" });
  ok("an Italian customer of an Italian seller is 22%", domestic.percent === 22, `${domestic.percent}%`);
  ok("and it is VAT, not 'none'", domestic.type === "vat", domestic.type);

  const domesticRates = await taxRatesFor({ ...REGIME, country: "IT", notes: NOTES });
  ok("one TaxRate is minted", domesticRates.rateIds.length === 1, domesticRates.rateIds.join(", "));

  const rate = await stripe.taxRates.retrieve(domesticRates.rateIds[0]);
  ok(
    "the minted rate really is 22% IT",
    rate.percentage === 22 && rate.country === "IT",
    `${rate.percentage}% ${rate.country}`,
  );
  ok("exclusive, so it is added rather than assumed included", rate.inclusive === false);
  ok("its display name comes from the dataset", Boolean(rate.display_name), rate.display_name);

  // The claim. Everything above is arithmetic; this is money.
  const charged = await invoiceWith(stripe, customerId, domesticRates.rateIds);
  ok("the invoice carries exactly one tax line", charged.total_taxes?.length === 1, String(charged.total_taxes?.length));
  ok("and it is the rate we minted", rateIdOf(charged.total_taxes?.[0]) === rate.id, rateIdOf(charged.total_taxes?.[0]));
  ok("€100 + 22% is charged as €122", charged.total === 12_200, eur(charged.total));
  ctx.state.domesticInvoiceId = charged.id;

  // ── reverse charge ────────────────────────────────────────────────────────
  section("03b — reverse charge: 0%, and the mention is the wording on the invoice");
  const vatNumber = process.env.E2E_EU_VAT_NUMBER;
  const vatCountry = process.env.E2E_EU_VAT_COUNTRY;
  if (!vatNumber || !vatCountry) {
    skip(
      "EU B2B reverse charge",
      "set E2E_EU_VAT_NUMBER + E2E_EU_VAT_COUNTRY to a real registration (never hardcode a third party's)",
    );
  } else {
    const b2b = await resolveTax({ ...REGIME, country: vatCountry, taxNumber: vatNumber });
    if (!b2b.reverseCharge) {
      // VIES conflates "no such number" with "that member state is unreachable", and the
      // library resolves the ambiguity toward CHARGING. Failing the run for an outage would
      // blame the code for the network.
      skip("EU B2B reverse charge", `VIES did not confirm ${vatCountry} ${vatNumber} — outage or bad number`);
    } else {
      ok("a valid EU VAT id reverse-charges", b2b.reverseCharge === true);
      ok("at 0%", b2b.percent === 0, `${b2b.percent}%`);

      const rcRates = await taxRatesFor({
        ...REGIME,
        country: vatCountry,
        taxNumber: vatNumber,
        notes: NOTES,
      });
      const rcRate = await stripe.taxRates.retrieve(rcRates.rateIds[0]);
      // The mention is not decoration: C-247/21 held that an omitted reverse-charge mention
      // cannot be cured after the fact, and `display_name` is where it reaches the PDF.
      ok("the mention IS the rate's display name", rcRate.display_name === NOTES.reverseCharge, rcRate.display_name);
      ok(
        "within Stripe's 50-char display_name limit",
        rcRate.display_name.length <= 50,
        `${rcRate.display_name.length} chars`,
      );
      ok("and the rate is 0%", rcRate.percentage === 0);

      const rcInvoice = await invoiceWith(stripe, customerId, rcRates.rateIds, { net: 5_000 });
      ok("a reverse-charged invoice adds nothing", rcInvoice.total === 5_000, eur(rcInvoice.total));
      ok("but still carries the line that says why", rcInvoice.total_taxes?.length === 1);
    }
  }

  // ── out of scope ──────────────────────────────────────────────────────────
  section("03c — outside the EU: out of scope, not 'unknown'");
  const jp = await resolveTax({ ...REGIME, country: "JP" });
  ok("a Japanese customer is out of scope", jp.outOfScope === true);
  ok("at 0%", jp.percent === 0);
  // The distinction that matters: out-of-scope is a complete answer; `approximate` is a
  // refusal. Only the second blocks a charge.
  ok("and NOT approximate — 0% here is an answer, not a guess", jp.approximate !== true);

  // ── the retax handoff ─────────────────────────────────────────────────────
  //
  // The one step in the tax story that a fake cannot reach, and the only one that MUTATES a
  // live object a customer is looking at.
  //
  // A seat session has to be created before the customer types an address, so it goes out at
  // the seller's DOMESTIC rate and is corrected once the billing country is known. That
  // correction is `updateCheckoutSessionTaxRates`, and it is the work Stripe Tax would
  // otherwise do for 0.5% — so if it silently does nothing, every cross-border customer pays
  // the seller's own rate and the seller owes the difference. Nothing had ever called it
  // against a real session.
  section("03d — an open session is re-taxed once the customer's country is known");
  const session = await createCheckoutSession({
    plans: ctx.plans,
    plan: STARTER_PLAN,
    interval: "monthly",
    seats: { standard: 1 },
    returnUrl: "https://e2e.test/done",
    customerId,
    currency: "eur",
    config: ctx.config,
    // Elements, not hosted: `checkout.sessions.update` can rewrite line items on a
    // `ui_mode: custom` session, which is exactly the "the session is a live object the
    // browser mutates" design the retax depends on. It is also what a consumer doing this
    // actually runs.
    taxRates: domesticRates.rateIds,
  });
  defer(`checkout session ${session.sessionId}`, () => expireCheckoutSession(session.sessionId));

  const ratesOnSession = async () => {
    const s = await stripe.checkout.sessions.retrieve(session.sessionId, { expand: ["line_items"] });
    const item = s.line_items?.data?.[0];
    return {
      total: s.amount_total,
      net: s.amount_subtotal,
      rates: (item?.taxes ?? []).map((t) => t.rate?.id ?? t.rate).filter(Boolean),
    };
  };

  const atCreation = await ratesOnSession();
  ok(
    "it goes out at the seller's own rate, because no address exists yet",
    atCreation.rates.includes(domesticRates.rateIds[0]),
    `${atCreation.rates.join(",")} — total ${eur(atCreation.total)}`,
  );

  // The customer types a country the seller is NOT registered in. Under OSS that is the
  // CUSTOMER's rate — 19% in Germany, against 22% at creation.
  const de = await taxRatesFor({ ...REGIME, country: "DE", notes: NOTES });
  ok("a German consumer resolves to their own rate", (await resolveTax({ ...REGIME, country: "DE" })).percent === 19);

  await updateCheckoutSessionTaxRates(session.sessionId, de.rateIds);
  const afterRetax = await ratesOnSession();
  ok(
    "the OPEN session now carries the customer's rate instead",
    afterRetax.rates.includes(de.rateIds[0]) && !afterRetax.rates.includes(domesticRates.rateIds[0]),
    `${afterRetax.rates.join(",")} — total ${eur(afterRetax.total)}`,
  );
  ok(
    "and the total the browser renders moved with it",
    afterRetax.total < atCreation.total,
    `${eur(atCreation.total)} → ${eur(afterRetax.total)} (22% → 19%)`,
  );

  // The branch the code comments single out and nothing had executed: an EMPTY list must
  // CLEAR the rate. Leaving the previous country's rate applied is how an out-of-scope sale
  // gets charged 22% it does not owe.
  await updateCheckoutSessionTaxRates(session.sessionId, []);
  const cleared = await ratesOnSession();
  ok(
    "an out-of-scope customer has the rate REMOVED, not merely replaced",
    cleared.rates.length === 0,
    `${cleared.rates.length} rate(s) — total ${eur(cleared.total)}`,
  );
  ok(
    "so the total charged is exactly the net",
    cleared.total === cleared.net,
    `${eur(cleared.net)} net → ${eur(cleared.total)} total`,
  );

  note("the decision table itself (OSS, registrations, US nexus, EL/GR) is covered offline");
}
