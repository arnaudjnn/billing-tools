import SalesTax from "sales-tax";
import { getStripe } from "./billing.js";

// Tax computed locally, then applied to Stripe as an explicit rate — the
// alternative to Stripe Tax, which bills 0.5% of every taxed transaction for a
// calculation that is, for a mostly-domestic seller, a constant.
//
// `sales-tax` supplies the rates (kept current, and it exposes reverse charge
// explicitly) and VIES supplies B2B validation. What Stripe Tax also gives you
// and this does NOT: evidence-of-location records for EU B2C, threshold
// monitoring, and filing reports. Those become yours.
//
// The one behaviour worth knowing, because it is the safe direction: a tax
// number that VIES cannot verify falls back to CHARGING tax, not exempting.
// Wrongly charging is recoverable; wrongly exempting means owing the tax
// yourself.

export type TaxDecision = {
  /** e.g. 22 for 22%. Zero for reverse charge and out-of-scope sales. */
  percent: number;
  /** The customer accounts for the VAT (cross-border EU B2B with a valid id). */
  reverseCharge: boolean;
  country: string;
  /** "vat" | "gst" | "none" — from sales-tax. */
  type: string;
};

/**
 * What tax applies to this customer.
 *
 * `originCountry` is where YOU are established: it decides domestic vs
 * cross-border, so an Italian seller charges 22% to an Italian business but
 * reverse-charges a German one.
 *
 * Providing `taxNumber` triggers a live VIES lookup. VIES has outages, and this
 * deliberately does NOT convert one into an exemption — see the note above.
 */
export async function resolveTax(opts: {
  originCountry: string;
  country: string;
  state?: string | null;
  taxNumber?: string | null;
}): Promise<TaxDecision> {
  SalesTax.setTaxOriginCountry(opts.originCountry.toUpperCase());
  const r = await SalesTax.getSalesTax(
    opts.country.toUpperCase(),
    opts.state ?? undefined,
    opts.taxNumber || undefined,
  );
  return {
    percent: Math.round(r.rate * 10000) / 100,
    reverseCharge: Boolean(r.charge?.reverse),
    country: opts.country.toUpperCase(),
    type: r.type,
  };
}

/**
 * A Stripe TaxRate matching a decision, reused rather than recreated.
 *
 * Stripe tax rates are immutable and accumulate forever, so minting one per
 * checkout would litter the account. Returns null when there is nothing to
 * apply and nothing to say on the invoice.
 *
 * Reverse charge still gets a rate — 0%, named so the invoice states it, which
 * is what the buyer's accountant needs to see.
 */
// A Stripe TaxRate is immutable, and there is one per (country, percent, name)
// — so the id, once found, is the answer forever. Without this memo the lookup
// below is a full `taxRates.list` on every call: once per checkout session, and
// again on every address change while the customer types, each ~180ms of the
// wait before the total updates.
//
// Per process, and keyed by everything that identifies the rate. In-flight calls
// share one lookup, so a burst of keystrokes doesn't open a burst of requests.
const rateCache = new Map<string, string | null>();
const rateInflight = new Map<string, Promise<string | null>>();

/** Forget the resolved TaxRate ids — for when one is archived in the Dashboard
 *  and Stripe starts rejecting it. */
export function invalidateTaxRates(): void {
  rateCache.clear();
}

export async function ensureStripeTaxRate(
  decision: TaxDecision,
  opts: { displayName?: string } = {},
): Promise<string | null> {
  if (decision.percent === 0 && !decision.reverseCharge) return null;

  const displayName =
    opts.displayName ??
    (decision.reverseCharge ? "Reverse charge" : decision.type === "gst" ? "GST" : "VAT");

  const key = `${decision.country}|${decision.percent}|${displayName}|${decision.reverseCharge}`;
  const hit = rateCache.get(key);
  if (hit !== undefined) return hit;
  const pending = rateInflight.get(key);
  if (pending) return pending;

  const resolve = (async () => {
    const stripe = getStripe();
    const existing = (await stripe.taxRates.list({ active: true, limit: 100 })).data.find(
      (r) =>
        r.percentage === decision.percent &&
        r.country === decision.country &&
        r.inclusive === false &&
        r.display_name === displayName,
    );
    const id =
      existing?.id ??
      (
        await stripe.taxRates.create({
          display_name: displayName,
          percentage: decision.percent,
          country: decision.country,
          inclusive: false,
          ...(decision.reverseCharge
            ? { description: "VAT reverse charge — customer accounts for VAT" }
            : {}),
        })
      ).id;
    rateCache.set(key, id);
    return id;
  })().finally(() => rateInflight.delete(key));

  rateInflight.set(key, resolve);
  return resolve;
}

/** resolveTax + ensureStripeTaxRate: the ids to put on a session's line items. */
export async function taxRatesFor(opts: {
  originCountry: string;
  country: string;
  state?: string | null;
  taxNumber?: string | null;
  displayName?: string;
}): Promise<{ decision: TaxDecision; rateIds: string[] }> {
  const decision = await resolveTax(opts);
  const id = await ensureStripeTaxRate(decision, { displayName: opts.displayName });
  return { decision, rateIds: id ? [id] : [] };
}

/**
 * Re-tax an OPEN Checkout Session, for when the customer's country changes.
 *
 * This is the piece Stripe Tax would otherwise do: the total has to be right
 * before payment, but the country isn't known until the address is typed. Line
 * item `tax_rates` are updatable mid-session, so the browser triggers this (via
 * the SDK's `runServerUpdate`) and the totals refresh.
 *
 * Every line gets the same rate — one plan, one place of supply.
 */
export async function updateCheckoutSessionTaxRates(
  sessionId: string,
  rateIds: string[],
): Promise<void> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items"],
  });
  const items = session.line_items?.data ?? [];
  if (items.length === 0) return;

  await stripe.checkout.sessions.update(sessionId, {
    line_items: items.map((item) => ({
      id: item.id,
      // An empty array CLEARS the rate, which is what a 0% out-of-scope sale
      // needs — leaving the previous country's rate applied would overcharge.
      tax_rates: rateIds.length ? rateIds : "",
    })),
  });
}
