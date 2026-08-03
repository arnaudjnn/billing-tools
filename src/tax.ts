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
// destination where tax is due and no rate exists is marked `approximate` and
// refused rather than charged a rate this library does not have. `sales-tax` did
// carry 86 other countries, but a number with no authority behind it is worse than
// no number: it invoices confidently and under-collects silently.
//
// **A rate is charged where the SELLER's regime says tax is due — never merely
// because the dataset has a number for the destination.** The dataset covers 45
// European countries, only 27 of which are in the EU, and conflating "we have a
// rate" with "you owe it" was a real bug: GB, CH, NO, TR and IS passed the coverage
// gate, fell through every EU branch and were charged their own domestic rate, so an
// Italian seller invoiced 20% "VAT" to a UK customer. That is not EU VAT (the place
// of supply is outside the EU, so none arises) and it is not UK VAT either unless
// you hold a UK registration — it collected 20% with nowhere to pay it over, which
// is the fault `oss: false` already exists to prevent, one border further out.
//
// So there are two inputs, and `registrations` is the second: where tax is due is a
// fact about YOUR registrations, which no dataset can know. Declaring them is the
// only model the US has — post-Wayfair you must not collect in a state until you
// have nexus there — and it is what makes an unregistered US destination 0% and
// CORRECT rather than a refusal.
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
   * Tax IS due here and this library has no rate for the place it is due, so `percent`
   * is 0 because there is nothing to apply — NOT because nothing is owed.
   *
   * The distinction from `outOfScope` is the whole point: there, 0% is the complete
   * answer; here it is a missing one. Set when the rated place falls outside the 45
   * European countries the dataset covers — the US being the case that matters in
   * practice, reached either domestically (a US-established seller) or through a
   * declared US `registrations` entry. US sales tax is destination-based across
   * 13 000+ jurisdictions:
   * counties, cities and special districts stack on the state rate, and SaaS is
   * taxable in some states and not others. Illinois is 6.25% in the table while a
   * Chicago buyer owes ~10.25%. Getting that right needs address → geocode →
   * jurisdiction boundaries, which is a data operation and not something a local
   * table can approximate.
   *
   * `taxRatesFor` refuses to mint a Stripe rate from an approximate decision, and
   * there is no flag to make it stop refusing: the two ways out both say something
   * true (`registrations`, if you do not in fact owe it; `mode: "stripe"`, if you do).
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

/** Where you are registered to collect tax. `state` narrows it to one US state. */
export type TaxRegistration = {
  /** ISO country code — "IT", "GB", "US". */
  country: string;
  /**
   * A US state code ("CA", "TX"), for a registration that is not country-wide.
   *
   * Omitted, the registration covers the whole country, which is what a VAT
   * registration is. Present, it covers only that state — which is what US nexus
   * is, and the reason `state` is threaded here from the customer's address.
   */
  state?: string;
};

/**
 * Does a declared registration cover this place of supply?
 *
 * A country-wide registration covers every state in it; a state-scoped one covers
 * only its own, and matches nothing when the customer's address carries no state —
 * an address too vague to place inside a US registration is not evidence that it
 * falls inside one.
 */
function isRegisteredIn(
  registrations: readonly TaxRegistration[],
  country: string,
  state?: string | null,
): boolean {
  return registrations.some((r) => {
    if (r.country.toUpperCase() !== country) return false;
    if (!r.state) return true;
    return Boolean(state) && r.state.toUpperCase() === state!.toUpperCase();
  });
}

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
   * Where you are registered to collect. **Undefined is "the caller did not say",
   * never "registered nowhere"** — leaving it out keeps the regime rules alone
   * deciding (domestic, plus the EU cross-border rules), which is what every
   * deployment predating this option gets.
   *
   * Declaring it switches to one rule for everywhere, domestic included: tax is due
   * where you say you are registered and nowhere else. An explicit `[]` therefore
   * differs from undefined, and says something useful — a US-established seller with
   * no nexus anywhere charges 0% on every sale, correctly and without a refusal.
   *
   * One obligation is deliberately NOT registration-gated: destination VAT on a sale
   * from outside the EU to an EU consumer, which arises with no threshold to sit
   * under, so an empty list cannot wish it away.
   */
  registrations?: readonly TaxRegistration[];
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
  const domestic = origin === country;
  const originEU = isEUMember(origin);
  const countryEU = isEUMember(country);

  // ── 1. Reverse charge: the CUSTOMER accounts for the tax, so we charge 0% ────
  //
  // Three conditions rather than a library's opinion: the destination is in the EU,
  // it is a DIFFERENT country from ours (an Italian seller has no border with an
  // Italian buyer, so there is nothing to reverse), and a VAT number that stands up.
  //
  // It deliberately does NOT require the SELLER to be in the EU. That test was here,
  // and it billed a German business 19% MwSt on an invoice from a US supplier — tax
  // that supplier has no obligation to collect and no way to remit. A non-EU supplier
  // to an EU business is outside its own regime either way, and the customer
  // self-accounts under Art. 44/196 exactly as it does for an EU one.
  //
  // The order matters for cost: the format check inside `isValidVatNumber` is local
  // and rejects most rubbish, so VIES is only asked about numbers that could be real.
  const crossBorderToEU = countryEU && !domestic;
  const reverseCharge =
    crossBorderToEU && Boolean(opts.taxNumber) && (await isValidVatNumber(opts.taxNumber!));
  if (reverseCharge) {
    const info = getRate(country);
    return {
      percent: 0,
      reverseCharge: true,
      country,
      type: info?.vat_abbr ? "vat" : "none",
      displayName: info?.vat_abbr ?? undefined,
    };
  }

  // ── 2. WHOSE rate applies — or nobody's ─────────────────────────────────────

  // Declaring registrations replaces "domestic, plus the EU rules" with one rule for
  // everywhere: tax is due where you say you are registered. Undefined keeps the
  // former, because undefined is "the caller did not say" and inventing an empty list
  // would stop a working deployment charging its own domestic VAT.
  const dueHere = opts.registrations
    ? isRegisteredIn(opts.registrations, country, opts.state)
    : domestic;

  // A sale from outside the EU to an EU CONSUMER: destination VAT arises with no
  // threshold to sit under (the non-Union OSS scheme), so this is the one place tax
  // is charged without a registration to point at. Under-collecting is the direction
  // that is not recoverable, and an empty list is not a defence against an obligation
  // that never had a threshold.
  const nonUnionDestination = countryEU && !originEU && !domestic;

  // A cross-border EU sale with no valid VAT id is not reverse-chargeable, so it
  // falls to be taxed somewhere, and OSS decides which. Registered (the default),
  // the customer's country; otherwise ours, which is the only rate we can remit.
  // A declared registration adds nothing here — both branches already name a country
  // whose rate you can actually pay over.
  //
  // `oss` defaults to true because charging the customer's rate is what the rule is
  // once you are over the threshold, and being over it is the state a growing
  // business ends in. Opting out is the smaller, more deliberate claim.
  const ratedCountry =
    originEU && crossBorderToEU
      ? opts.oss === false
        ? origin
        : country
      : nonUnionDestination || dueHere
        ? country
        : null;

  // Nothing is due, and that is a COMPLETE answer: an EU seller exporting a digital
  // service (the place of supply is the customer's country, so no EU VAT arises), or
  // any destination no declared registration covers. A separate obligation can still
  // arise there once a nexus threshold is crossed — that is a registration question,
  // and declaring one is how you answer it.
  if (ratedCountry === null) {
    return { percent: 0, reverseCharge: false, country, type: "none", outOfScope: true };
  }

  // Tax IS due and we have no rate for where it is due — the one case where 0% would
  // be a guess rather than a rule, so it is flagged and `taxRatesFor` refuses it.
  if (!isKnownCountry(ratedCountry)) {
    return { percent: 0, reverseCharge: false, country, type: "none", approximate: true };
  }

  const info = getRate(ratedCountry);
  return {
    percent: getStandardRate(ratedCountry) ?? 0,
    reverseCharge: false,
    country,
    // `vat_abbr` is the country's own word for it — "IVA", "TVA", "MwSt" — which is
    // what belongs on the customer's invoice. Consumers used to hardcode a map. It
    // follows the RATED country, not the customer's, or an `oss: false` invoice says
    // MwSt above an Italian figure.
    type: info?.vat_abbr ? "vat" : "none",
    displayName: info?.vat_abbr ?? undefined,
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
  // The format gate stays REAL under the test seam below: it costs nothing, and a
  // stub that also accepted malformed numbers would test a laxer function than ships.
  if (!validateFormat(clean)) return false;
  return vatValidator(clean);
}

// The network leg, injectable.
//
// The suite is OFFLINE by design (see vitest.config.ts — "no Stripe key, no WorkOS
// key, no network. That is why it can gate every push"), and this was the one thing
// in it still reaching out: the reverse-charge tests asserted on a real German
// company's live registration status. So they failed whenever a member state's VIES
// node was down — `MS_UNAVAILABLE`, which is the exact outage this file's fallback
// exists for and the one behaviour that could not be tested while the test WAS the
// outage. Stubbing the leg makes both the valid and the unreachable case assertable.
let vatValidator: (cleanVatNumber: string) => Promise<boolean> = viesLookup;

/** Test seam: replace the VIES lookup. Call with nothing to restore the real one. */
export function __setVatValidatorForTests(
  fn?: (cleanVatNumber: string) => Promise<boolean>,
): void {
  vatValidator = fn ?? viesLookup;
}

async function viesLookup(clean: string): Promise<boolean> {
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
      `Tax is due for ${decision.country} and this library has no rate for it, so it would apply ` +
        "NONE — the rate dataset is European-only. It deliberately does not fall back to a " +
        "state-level figure: US sales tax stacks county, city and district rates on top across " +
        "13 000+ jurisdictions (Illinois 6.25% vs Chicago ~10.25%), and SaaS is taxable in some " +
        "states and not others. Two ways out, and each of them states something true: declare " +
        "`config.tax.registrations` if you are NOT in fact registered there (nothing is collected " +
        "where you are not registered, which is a complete answer rather than an approximation), " +
        'or `config.tax.mode: "stripe"` if you are. To charge nothing anywhere, deliberately, ' +
        'that is `mode: "none"`.',
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
    // Paginated, not `.data`: a TaxRate is immutable and can only be archived, so an
    // account accumulates one per (country, percent, name) forever — every country
    // sold into, every reverse-charge 0%, and every historical rate change. Reading
    // page 1 stopped finding the match past 100 and silently minted a duplicate
    // instead, adding to the very list it was failing to search.
    let existing: string | undefined;
    for await (const r of stripe.taxRates.list({ active: true, limit: 100 })) {
      if (
        r.percentage === decision.percent &&
        r.country === decision.country &&
        r.inclusive === false &&
        r.display_name === displayName
      ) {
        existing = r.id;
        break;
      }
    }
    const id =
      existing ??
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
        oss: tax?.oss,
        registrations: tax?.registrations,
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
  /** See `resolveTax`. Where you are registered to collect; undefined means the
   *  regime rules alone decide. */
  registrations?: readonly TaxRegistration[];
}): Promise<{ decision: TaxDecision; rateIds: string[] }> {
  const decision = await resolveTax(opts);
  // Unconditional, and `allowApproximate` used to be the way past it. It was removed
  // rather than kept, because once `registrations` exists there is no case where it
  // is the right answer. It only ever fired where tax IS due and no rate exists —
  // and where you are genuinely not registered, `registrations` reports 0% as a
  // COMPLETE answer with no flag needed, while where you ARE registered, suppressing
  // this invoices 0% on tax you owe, which is the one unrecoverable direction this
  // whole file is written against. A flag whose only remaining use is to silently
  // under-collect is a footgun, not an escape hatch. `mode: "none"` still says
  // "charge nothing", deliberately and deployment-wide.
  if (decision.approximate) throw new ApproximateTaxError(decision);
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
