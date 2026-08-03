import SalesTax from "sales-tax";
import { getStripe } from "./billing.js";
import type { BillingConfig } from "./types.js";

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

// ── One declaration: WHO calculates (`config.tax.mode`) ─────────────────────
//
// Before this, every charge site took `taxRates` / `automaticTax` and each caller
// had to remember to resolve and pass them — so the tax an account applied depended
// on which call site the app had got round to wiring, and the answer to "does this
// deployment charge VAT" lived in as many places as there were charges. The two
// charges with no form behind them (auto-reload, `buy_credits`) were untaxed for
// exactly that reason.
//
// Now the deployment says it once, in config, and every charge the library builds
// reads it. An explicit argument at a call site still wins — that is the escape
// hatch for a charge that genuinely differs.

export type TaxMode =
  /** This library: `resolveTax` (sales-tax + VIES) → an explicit Stripe TaxRate. */
  | "billing-tools"
  /** Stripe Tax (`automatic_tax`). Requires registrations, or it computes 0%. */
  | "stripe"
  /** No tax on anything the library charges. */
  | "none";

/**
 * The declared mode, with the older fields folded in.
 *
 * `origin` alone means `"billing-tools"`: naming where you are established is the
 * only thing that mode needs, so requiring a second field to say "yes, really"
 * would be ceremony. `automatic: true` remains `"stripe"`. Nothing declared is
 * `"none"` — the same silence that used to mean "untaxed", now spelled.
 */
export function taxModeOf(tax: BillingConfig["tax"] | undefined): TaxMode {
  if (!tax) return "none";
  if (tax.mode) return tax.mode;
  if (tax.automatic) return "stripe";
  return tax.origin ? "billing-tools" : "none";
}

// A missing `origin` under the billing-tools mode is a config error, not a
// per-charge one, so it is said once rather than on every invoice.
let warnedNoOrigin = false;

/**
 * What to put on a charge, derived from `config.tax` alone.
 *
 * Returns the same `{ taxRates, automaticTax }` shape every charge site already
 * takes, so wiring it is one line per site and an explicit argument still wins.
 *
 * Under `"billing-tools"` the rate comes from the CUSTOMER: their address decides
 * domestic vs cross-border and their Stripe tax id decides reverse charge. A
 * customer with no address on file is charged the DOMESTIC rate rather than
 * nothing — the same direction `resolveTax` takes for an unverifiable VAT number,
 * because over-charging is recoverable and under-charging means owing it yourself.
 */
export async function taxFor(
  stripeCustomerId: string | null,
  tax: BillingConfig["tax"] | undefined,
): Promise<{ taxRates?: string[]; automaticTax?: boolean }> {
  // The consumer's own resolver wins outright: it may read a rate from their own
  // records, and second-guessing it would be worse than not offering the hook.
  if (tax?.rates && stripeCustomerId) {
    const rates = await tax.rates(stripeCustomerId);
    if (rates?.length) return { taxRates: rates };
  }

  switch (taxModeOf(tax)) {
    case "stripe":
      return { automaticTax: true };
    case "none":
      return {};
    case "billing-tools": {
      const originCountry = tax?.origin;
      if (!originCountry) {
        if (!warnedNoOrigin) {
          warnedNoOrigin = true;
          console.warn(
            '[billing] config.tax.mode is "billing-tools" but no `origin` country is set, so no ' +
              "rate can be worked out (domestic vs cross-border is decided by where you are " +
              "established). Every charge the library raises goes out untaxed until you set it.",
          );
        }
        return {};
      }
      const where = stripeCustomerId ? await customerPlaceOfSupply(stripeCustomerId) : null;
      const { rateIds } = await taxRatesFor({
        originCountry,
        // No address on file → treat it as a domestic sale (see above).
        country: where?.country ?? originCountry,
        state: where?.state,
        taxNumber: where?.taxNumber,
      });
      return rateIds.length ? { taxRates: rateIds } : {};
    }
  }
}

/** Country/state/VAT number as Stripe holds them for this customer. */
async function customerPlaceOfSupply(
  stripeCustomerId: string,
): Promise<{ country?: string; state?: string | null; taxNumber?: string | null } | null> {
  try {
    const customer = await getStripe().customers.retrieve(stripeCustomerId, {
      expand: ["tax_ids"],
    });
    if (customer.deleted) return null;
    return {
      country: customer.address?.country ?? undefined,
      state: customer.address?.state ?? null,
      // Any tax id on file: `eu_vat` is the one that reverse-charges, and
      // `sales-tax` decides that from the number itself.
      taxNumber: customer.tax_ids?.data?.[0]?.value ?? null,
    };
  } catch {
    // A charge must not fail because the customer read did. Domestic is the safe
    // fallback, as above.
    return null;
  }
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
