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
 * The declared mode. **Nothing declared means `"billing-tools"`.**
 *
 * That default is the whole point, and it used to be `"none"`. Silence meant no tax
 * on anything the library charged — so a deployment that never thought about VAT
 * shipped charging none of it, which is the expensive direction: over-charging is
 * recoverable and under-collecting means owing it yourself, with interest, in every
 * jurisdiction you sold into. "I did not configure tax" is not a statement that the
 * sale is untaxed.
 *
 * The mode needs to know where you are ESTABLISHED, and that used to be why it
 * could not default: no `origin`, no rate. It no longer has to be declared —
 * `originFor` falls back to the Stripe account's own country, which is the country
 * you gave Stripe when you signed up and the best available answer. So the default
 * needs no config at all.
 *
 * `automatic: true` is still `"stripe"`, and `"none"` is now an explicit opt-out —
 * correct for an account that genuinely charges no tax, and something you have to
 * write down rather than arrive at by omission.
 */
export function taxModeOf(tax: BillingConfig["tax"] | undefined): TaxMode {
  if (tax?.mode) return tax.mode;
  if (tax?.automatic) return "stripe";
  return "billing-tools";
}

// The Stripe account's country, memoised. One read per process: an account does not
// change country, and this sits behind `taxFor` on the hot path of every metered
// call (the auto-reload invoice is raised there).
let accountCountry: string | null | undefined;

/**
 * Where the business is established: `config.tax.origin`, else the Stripe account's
 * country.
 *
 * Explicit always wins — an account registered in one country can be established in
 * another, and only the app knows. The fallback exists so the common case needs no
 * config, and it NEVER throws: it is on a charge path, so a Stripe blip must cost a
 * tax rate, not the charge.
 */
export async function originFor(tax: BillingConfig["tax"] | undefined): Promise<string | null> {
  if (tax?.origin) return tax.origin;
  if (accountCountry !== undefined) return accountCountry;
  try {
    const account = await getStripe().accounts.retrieve();
    accountCountry = account.country ?? null;
  } catch {
    // Not cached as null on failure: a transient error should be retried, whereas a
    // genuine "no country on the account" is settled and worth remembering.
    return null;
  }
  return accountCountry;
}

/**
 * Test seam + escape hatch after an account's country changes.
 *
 * Also re-arms the one-time "no origin" warning. That warning is deliberately
 * once-per-process (it is a config error, not a per-charge one, so it must not
 * appear on every invoice) — which makes it unobservable to any test that is not
 * the first to trigger it. Resetting it here is what keeps the "says so once"
 * property testable instead of only asserted in a comment.
 */
export function invalidateTaxOrigin(): void {
  accountCountry = undefined;
  warnedNoOrigin = false;
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
      const originCountry = await originFor(tax);
      if (!originCountry) {
        if (!warnedNoOrigin) {
          warnedNoOrigin = true;
          console.warn(
            "[billing] no tax origin: `config.tax.origin` is unset and the Stripe account's " +
              "country could not be read, so no rate can be worked out (domestic vs cross-border " +
              "is decided by where you are established). Charges go out UNTAXED until one of the " +
              'two is available. Set `config.tax.origin`, or `mode: "none"` if that is intended.',
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
