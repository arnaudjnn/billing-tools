import {
  getStandardRate,
  getRate,
  isEUMember,
  isKnownCountry,
  validateFormat,
} from "eu-vat-rates-data";
import { getStripe } from "./billing.js";
import type { BillingConfig } from "./types.js";

// Tax computed locally, then applied to Stripe as an explicit rate — the
// alternative to Stripe Tax, which bills 0.5% of every taxed transaction for a
// calculation that is, for a mostly-domestic seller, a constant.
//
// `eu-vat-rates-data` supplies the rates — 45 European countries tracked daily
// from the European Commission's own TEDB — and VIES supplies B2B validation. It
// replaced `sales-tax`, whose rates were a static JSON published whenever someone
// cut a release, and which carried no notion of EU membership so reverse charge
// had to be taken on trust.
//
// Europe ONLY, and that is the deliberate scope. EU VAT is tractable because it is
// 27 states with one published standard rate each; everywhere else it is not, so a
// non-European destination is marked `approximate` and refused rather than charged
// a rate this library does not have. `sales-tax` did carry 86 other countries, but
// a number with no authority behind it is worse than no number: it invoices
// confidently and under-collects silently.
//
// What Stripe Tax also gives you and this does NOT: US local jurisdictions,
// evidence-of-location records for EU B2C, threshold monitoring, and filing
// reports. Those become yours.
//
// The one behaviour worth knowing, because it is the safe direction: a tax
// number that VIES cannot verify falls back to CHARGING tax, not exempting.
// Wrongly charging is recoverable; wrongly exempting means owing the tax
// yourself.

export type TaxDecision = {
  /** e.g. 22 for 22%. Zero for reverse charge and out-of-scope sales. */
  percent: number;
  /**
   * No tax arises, and that is a complete answer rather than a missing one.
   *
   * A European seller exporting a digital service outside the EU: the place of
   * supply is the customer's country, which is outside the EU, so no EU VAT is due.
   * Distinct from `approximate`, where 0% means "we do not know" — this one means
   * "nothing, and here is why", which is what belongs on the invoice.
   */
  outOfScope?: boolean;
  /**
   * The rate is a KNOWN UNDER-ESTIMATE, not an exact answer.
   *
   * Set for every destination outside the 45 European countries the rate dataset
   * covers — the US being the case that matters in practice. US sales tax is
   * destination-based across 13 000+ jurisdictions:
   * counties, cities and special districts stack on the state rate, and SaaS is
   * taxable in some states and not others. Illinois is 6.25% in the table while a
   * Chicago buyer owes ~10.25%. Getting that right needs address → geocode →
   * jurisdiction boundaries, which is a data operation and not something a local
   * table can approximate.
   *
   * `taxRatesFor` refuses to mint a Stripe rate from an approximate decision, so
   * this cannot be applied by accident — see `allowApproximate`.
   */
  approximate?: boolean;
  /** The customer accounts for the VAT (cross-border EU B2B with a valid id). */
  reverseCharge: boolean;
  country: string;
  /** "vat" or "none". GST/other regimes are outside this dataset's scope. */
  type: string;
  /**
   * The country's own word for the tax — "IVA", "TVA", "MwSt" — from the dataset.
   *
   * On the invoice, in the language the customer uses. Consumers used to hardcode a
   * per-country map for this (`{ IT: "IVA", FR: "TVA" }`), which stops at the second
   * market you sell into.
   */
  displayName?: string;
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
  /**
   * Are you registered for the EU One-Stop Shop?
   *
   * It only decides ONE case: a cross-border EU customer with no valid VAT number.
   * Reverse charge needs a valid id, so without one the sale is treated as B2C —
   * and then OSS decides whose rate applies. Registered (the default), the
   * CUSTOMER's; not registered, YOUR OWN, which is what the sub-€10 000 regime
   * allows and the only rate you can actually remit without a foreign registration.
   *
   * Charging the customer's rate while unregistered collects VAT you have nowhere
   * to pay over — the mirror of under-collecting, and awkward in a different way.
   *
   * Nothing else moves: domestic is domestic, valid-id B2B still reverse charges,
   * and non-EU is still out of scope.
   */
  oss?: boolean;
}): Promise<TaxDecision> {
  const origin = opts.originCountry.toUpperCase();
  const country = opts.country.toUpperCase();

  // A destination outside the 45 covered countries. Whether 0% is the RIGHT answer
  // or an unknown one depends entirely on where the seller is, and conflating the
  // two was a real bug:
  //
  //   • A EUROPEAN seller exporting a digital service outside the EU is OUT OF
  //     SCOPE for EU VAT — the place of supply is the customer's country, which is
  //     not in the EU, so no EU VAT arises. 0% is correct and complete. (A separate
  //     obligation may exist in the destination once a nexus threshold is crossed;
  //     that is a registration question, not a rate this library can compute.)
  //
  //   • A seller we have NO regime for — one established outside these countries —
  //     is different: we cannot compute their domestic rate either, so 0% is a
  //     guess and gets refused.
  if (!isKnownCountry(country)) {
    const sellerCovered = isKnownCountry(origin);
    return {
      percent: 0,
      reverseCharge: false,
      country,
      type: "none",
      ...(sellerCovered ? { outOfScope: true } : { approximate: true }),
    };
  }

  const standard = getStandardRate(country) ?? 0;
  const info = getRate(country);
  const bothEU = isEUMember(origin) && isEUMember(country);

  // Reverse charge, as three conditions rather than a library's opinion: both in
  // the EU, DIFFERENT countries (an Italian seller has no border with an Italian
  // buyer, so there is nothing to reverse), and a VAT number that stands up.
  //
  // The order matters for cost: the format check is local and rejects most
  // rubbish, so VIES is only asked about numbers that could be real.
  const crossBorderEU = bothEU && origin !== country;
  const reverseCharge =
    crossBorderEU && Boolean(opts.taxNumber) && (await isValidVatNumber(opts.taxNumber!));

  // A cross-border EU sale with no valid VAT id is not reverse-chargeable, so it
  // falls to be taxed somewhere. OSS-registered, that is the customer's country;
  // otherwise it is yours, and yours is the only one you can remit.
  //
  // `oss` defaults to true because charging the customer's rate is what the rule is
  // once you are over the threshold, and being over it is the state a growing
  // business ends in. Opting out is the smaller, more deliberate claim.
  const unregisteredCrossBorder = crossBorderEU && !reverseCharge && opts.oss === false;
  const applicable = unregisteredCrossBorder ? (getStandardRate(origin) ?? 0) : standard;
  const applicableInfo = unregisteredCrossBorder ? getRate(origin) : info;

  return {
    percent: reverseCharge ? 0 : applicable,
    reverseCharge,
    country,
    // `vat_abbr` is the country's own word for it — "IVA", "TVA", "MwSt" — which is
    // what belongs on the customer's invoice. Consumers used to hardcode a map.
    type: applicableInfo?.vat_abbr ? "vat" : "none",
    displayName: applicableInfo?.vat_abbr ?? undefined,
  };
}

/**
 * Does this VAT number exist, per VIES?
 *
 * Format first, locally, from the dataset's own per-country pattern — it costs
 * nothing and VIES is a shared public service. Then the real check.
 *
 * **An unverifiable number is NOT an exemption.** VIES has regular outages and
 * per-member-state downtime, and treating either as "valid" would zero-rate a sale
 * on the strength of a service being unreachable. Returning false means the
 * standard rate is charged, which is the recoverable direction: a wrongly charged
 * customer asks for it back, a wrongly exempted one leaves you owing the VAT.
 */
async function isValidVatNumber(vatNumber: string): Promise<boolean> {
  const clean = vatNumber.replace(/[\s-]/g, "").toUpperCase();
  if (!validateFormat(clean)) return false;

  const country = clean.slice(0, 2);
  const number = clean.slice(2);
  try {
    const res = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${country}/vat/${number}`,
      { signal: AbortSignal.timeout(VIES_TIMEOUT_MS) },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { isValid?: boolean };
    return body.isValid === true;
  } catch {
    // Timeout, network, or malformed response — all of them "not verified".
    return false;
  }
}

/** VIES is a shared public service and this sits on a checkout path, so the wait
 *  is bounded. A slow lookup means the standard rate, not a slow checkout. */
const VIES_TIMEOUT_MS = 4_000;

/** Thrown when a charge would carry a rate this library knows to be wrong. */
export class ApproximateTaxError extends Error {
  constructor(readonly decision: TaxDecision) {
    super(
      `Refusing to apply an approximate tax rate for ${decision.country}: ${decision.percent}% is ` +
        "the state-level rate, and US sales tax stacks county, city and district rates on top " +
        "(Illinois 6.25% vs Chicago ~10.25%), with SaaS taxable in some states and not others. " +
        'Use `config.tax.mode: "stripe"` for US destinations, or set ' +
        "`config.tax.allowApproximate: true` to accept a known under-estimate.",
    );
    this.name = "ApproximateTaxError";
  }
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
    (decision.reverseCharge
      ? "Reverse charge"
      : // The country's own abbreviation when the dataset has one, so an Italian
        // invoice says IVA and a French one TVA without the app supplying a map.
        (decision.displayName ?? "VAT"));

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
  /** This library: `resolveTax` (eu-vat-rates-data + VIES) → an explicit Stripe TaxRate. */
  | "local"
  /** Stripe Tax (`automatic_tax`). Requires registrations, or it computes 0%. */
  | "stripe"
  /** No tax on anything the library charges. */
  | "none";

/**
 * The declared mode. **Nothing declared means `"local"`.**
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
  return "local";
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

// A missing `origin` under the `local` mode is a config error, not a
// per-charge one, so it is said once rather than on every invoice.
let warnedNoOrigin = false;

/**
 * What to put on a charge, derived from `config.tax` alone.
 *
 * Returns the same `{ taxRates, automaticTax }` shape every charge site already
 * takes, so wiring it is one line per site and an explicit argument still wins.
 *
 * Under `"local"` the rate comes from the CUSTOMER: their address decides
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
    case "local": {
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
        allowApproximate: tax?.allowApproximate,
        oss: tax?.oss,
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
      // Decided from the number itself, by VIES.
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
  /** See `resolveTax`. Decides whose rate a cross-border EU sale carries when the
   *  customer has no valid VAT id. */
  oss?: boolean;
  /**
   * Apply a rate this library knows to be an under-estimate (US destinations).
   *
   * Off by default, and the refusal is the point: a 6.25% Illinois rate on an
   * invoice to a Chicago buyer who owes ~10.25% is a liability that surfaces at
   * audit, long after the customer is gone and the difference is yours. A charge
   * that fails with a reason is recoverable; one that succeeds at the wrong rate
   * is not. `config.tax.allowApproximate` is how a caller who understands that
   * says so.
   */
  allowApproximate?: boolean;
}): Promise<{ decision: TaxDecision; rateIds: string[] }> {
  const decision = await resolveTax(opts);
  if (decision.approximate && !opts.allowApproximate) throw new ApproximateTaxError(decision);
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
