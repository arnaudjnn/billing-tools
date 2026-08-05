import type Stripe from "stripe";
import { getStripe } from "./billing.js";

// Stripe Tax configuration as code, so an environment is set up by running
// something rather than by clicking through a Dashboard and hoping live matches
// test.
//
// All three pieces are ordinary API surface: the origin address, the account
// defaults, and the registrations. Only the DECISION of which jurisdictions you
// are obliged to collect in is not — that is a compliance question, which is
// exactly why this takes them as an explicit argument and never infers them.
//
// It never deactivates a registration either. Ceasing to collect somewhere has
// legal meaning and a date attached; a deploy script that quietly expired one
// because it vanished from a config file would be a genuinely bad day. Extras
// are reported, not removed.

export type TaxRegistrationSpec = {
  /** Two-letter country code, e.g. "IT". */
  country: string;
  /**
   * Registration type. Defaults to "standard" (domestic).
   *
   * For an EU seller shipping digital services across the union, "oss_union" is
   * the usual companion to a domestic registration — it makes Stripe charge each
   * buyer's national rate under the One Stop Shop.
   */
  type?: "standard" | "oss_union" | "oss_non_union" | "ioss";
  /** Unix seconds, or "now" (default). */
  activeFrom?: number | "now";
  /**
   * Raw `country_options[<country>]` when a jurisdiction needs a shape this
   * helper doesn't model. Wins over `type`.
   */
  countryOptions?: Record<string, unknown>;
};

export type TaxSetupResult = {
  settingsStatus: string;
  /** Countries registered by this run. */
  created: string[];
  /** Countries that were already active. */
  existing: string[];
  /** Active registrations NOT in the spec — reported, never removed. */
  unmanaged: string[];
};

/** country_options for the common cases; EU "standard" needs a nested hash that
 *  is easy to get wrong (Stripe rejects the bare type). */
function countryOptionsFor(spec: TaxRegistrationSpec): Record<string, unknown> {
  if (spec.countryOptions) return spec.countryOptions;
  const cc = spec.country.toLowerCase();
  const type = spec.type ?? "standard";
  if (type === "standard") {
    return { [cc]: { type: "standard", standard: { place_of_supply_scheme: "standard" } } };
  }
  return { [cc]: { type } };
}

/**
 * Idempotently configure Stripe Tax for the environment the secret key points at.
 *
 * Safe to run on every deploy: an active registration for a country in the spec
 * is left alone, and the settings write is a no-op when it already matches.
 */
export async function ensureTaxSetup(opts: {
  /** Where you operate from. Required before Stripe Tax will calculate anything. */
  headOffice: {
    country: string;
    state?: string;
    city?: string;
    line1?: string;
    line2?: string;
    postalCode?: string;
  };
  /** The jurisdictions you are registered to collect in. Yours to decide. */
  registrations: TaxRegistrationSpec[];
  defaults?: {
    /** Preset tax code, e.g. txcd_10000000 (electronically supplied services). */
    taxCode?: string;
    /**
     * Whether listed prices exclude tax. Default "exclusive", matching
     * ensurePlans — and worth setting, because the account default
     * `inferred_by_currency` reads EUR as INCLUSIVE.
     */
    taxBehavior?: "exclusive" | "inclusive";
  };
}): Promise<TaxSetupResult> {
  const stripe = getStripe();

  const address: Stripe.Tax.SettingsUpdateParams.HeadOffice["address"] = {
    country: opts.headOffice.country,
    ...(opts.headOffice.state ? { state: opts.headOffice.state } : {}),
    ...(opts.headOffice.city ? { city: opts.headOffice.city } : {}),
    ...(opts.headOffice.line1 ? { line1: opts.headOffice.line1 } : {}),
    ...(opts.headOffice.line2 ? { line2: opts.headOffice.line2 } : {}),
    ...(opts.headOffice.postalCode ? { postal_code: opts.headOffice.postalCode } : {}),
  };

  const settings = await stripe.tax.settings.update({
    head_office: { address },
    defaults: {
      tax_behavior: opts.defaults?.taxBehavior ?? "exclusive",
      ...(opts.defaults?.taxCode ? { tax_code: opts.defaults.taxCode } : {}),
    },
  });

  const active = await stripe.tax.registrations.list({ status: "active", limit: 100 });
  const activeCountries = new Set(active.data.map((r) => r.country.toUpperCase()));

  const created: string[] = [];
  const existing: string[] = [];
  for (const spec of opts.registrations) {
    const cc = spec.country.toUpperCase();
    if (activeCountries.has(cc)) {
      existing.push(cc);
      continue;
    }
    await stripe.tax.registrations.create({
      country: cc,
      active_from: spec.activeFrom ?? "now",
      country_options: countryOptionsFor(
        spec,
      ) as Stripe.Tax.RegistrationCreateParams.CountryOptions,
    });
    created.push(cc);
  }

  const wanted = new Set(opts.registrations.map((r) => r.country.toUpperCase()));
  return {
    settingsStatus: settings.status,
    created,
    existing,
    unmanaged: [...activeCountries].filter((c) => !wanted.has(c)),
  };
}

// ── The SELLER's own VAT number, on every invoice ───────────────────────────
//
// Art. 226(3) of the VAT Directive requires an invoice to carry the SUPPLIER's VAT
// identification number, and for a reverse-charged EU B2B supply the supplier's
// intracommunity number is mandatory beside the customer's — CJEU C-247/21 again: an
// omitted mention cannot be cured after the fact.
//
// Nothing here put it there. Stripe prints the account's business name and address from
// Dashboard settings, and the number itself lives in the consuming app's own entity
// declaration (`LEGAL_VAT_INTRA`), which never reached Stripe. So every invoice this
// library produced — subscription, top-up, auto-reload — was missing it, and the
// invoice-reading tools returned that same incomplete document faithfully.
//
// Stripe models it as a tax id OWNED BY THE ACCOUNT rather than by a customer, plus an
// account-level default so it lands on every invoice without being passed per charge.

export interface AccountTaxIdResult {
  id: string;
  created: boolean;
  /** True when it is now the account's invoice default. */
  isDefault: boolean;
}

/**
 * Put the seller's own tax id on the account, and make it the invoice default.
 *
 * Idempotent by VALUE: an existing id with the same number is reused, because creating a
 * second one would leave Stripe choosing which to print. Safe to call from a deploy step;
 * it THROWS, unlike the lazy provisioning on a charge path — a missing supplier VAT
 * number is a defective invoice, not a degraded one, so it should stop a deploy.
 *
 * ```ts
 * // A French micro-entreprise: not VAT-registered, but it holds an intracommunity
 * // number, which is mandatory on EU B2B invoices from the first euro.
 * await ensureAccountTaxId({ type: "eu_vat", value: process.env.LEGAL_VAT_INTRA! });
 * ```
 */
export async function ensureAccountTaxId(opts: {
  /** Stripe's tax id type — "eu_vat", "gb_vat", "ch_vat", … */
  type: string;
  /** The number itself, as it must appear on the invoice. */
  value: string;
  /** Also set it as the account's `default_account_tax_ids`. Default true — an id that
   *  exists but is not the default prints on nothing. */
  makeDefault?: boolean;
}): Promise<AccountTaxIdResult> {
  const stripe = getStripe();
  const wanted = opts.value.replace(/\s+/g, "").toUpperCase();

  const existing = (await stripe.taxIds.list({ limit: 100 })).data.find(
    (t) => t.value.replace(/\s+/g, "").toUpperCase() === wanted,
  );
  const id =
    existing?.id ??
    (
      await stripe.taxIds.create({
        type: opts.type as Parameters<typeof stripe.taxIds.create>[0]["type"],
        value: opts.value,
        owner: { type: "account" },
      })
    ).id;

  let isDefault = false;
  if (opts.makeDefault !== false) {
    // `accounts.update` needs the account id even for your own account — the
    // no-argument form updates nothing and typechecks as a string parameter.
    const account = await stripe.accounts.retrieve();
    await stripe.accounts.update(account.id, {
      settings: { invoices: { default_account_tax_ids: [id] } },
    });
    isDefault = true;
  }
  return { id, created: !existing, isDefault };
}

/** The account's own tax ids, for the doctor. Never throws — a restricted key that
 *  cannot read them is a different finding from having none. */
export async function accountTaxIds(): Promise<Array<{ id: string; type: string; value: string }>> {
  const list = await getStripe().taxIds.list({ limit: 100 });
  return list.data.map((t) => ({ id: t.id, type: t.type, value: t.value }));
}
