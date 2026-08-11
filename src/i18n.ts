// Localisation, in two halves — because there are two kinds of text here and they
// belong to different people.
//
//  1. Text the APP authors: plan names, taglines, features, CTA labels, compare
//     row labels. The library never invents these. They are `Localized`, so a
//     config can hold one language today and several later without changing shape.
//
//  2. The few words the LIBRARY has to supply because they are structural:
//     "Unlimited" in a members column, "Monthly"/"Yearly" in a billing-cycle row,
//     the headers of a generated markdown table, and the messages a customer sees
//     when a basket or an allowance is refused. Those default to ENGLISH and are
//     overridable per consumer.
//
// Money formatting is already locale-aware via Intl (with a `formatMoney` escape
// hatch, because de-DE renders "18,00 €" where a house style may want "€18").

/**
 * A string, or the same string per locale.
 *
 * A plain string is the single-language case and keeps working unchanged — which
 * is most configs, most of the time. A map opts into more:
 *
 *     name: "Pro"
 *     name: { en: "Pro", it: "Pro" }
 *     tagline: { en: "Search, analyse, organise", fr: "Cherchez, analysez, organisez" }
 */
export type Localized = string | Readonly<Record<string, string>>;

/** A list of strings, or one list per locale. A separate type because translated
 *  lists legitimately differ in LENGTH — a language may merge two bullets. */
export type LocalizedList = readonly string[] | Readonly<Record<string, readonly string[]>>;

export interface LocaleOptions {
  /** BCP 47 tag the surface is rendering in, e.g. "fr" or "fr-CA". */
  locale?: string;
  /** Fallback when a locale has no entry. Default "en". */
  defaultLocale?: string;
}

/**
 * Pick the best entry for `locale`.
 *
 * Exact tag → language subtag ("fr-CA" → "fr") → the default locale and ITS
 * language → the first entry. The last step is deliberate: a config with one
 * language under an unexpected key should still render, rather than showing a
 * customer nothing at all.
 */
export function resolveLocalized(
  value: Localized | undefined,
  opts: LocaleOptions = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const fallback = opts.defaultLocale ?? "en";
  for (const key of candidates(opts.locale, fallback)) {
    const hit = value[key];
    if (typeof hit === "string") return hit;
  }
  const first = Object.values(value)[0];
  return typeof first === "string" ? first : undefined;
}

/** {@link resolveLocalized} for a list. */
export function resolveLocalizedList(
  value: LocalizedList | undefined,
  opts: LocaleOptions = {},
): readonly string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  const map = value as Record<string, readonly string[]>;
  const fallback = opts.defaultLocale ?? "en";
  for (const key of candidates(opts.locale, fallback)) {
    const hit = map[key];
    if (Array.isArray(hit)) return hit;
  }
  const first = Object.values(map)[0];
  return Array.isArray(first) ? first : [];
}

function candidates(locale: string | undefined, fallback: string): string[] {
  const out: string[] = [];
  const push = (tag: string | undefined) => {
    if (!tag) return;
    if (!out.includes(tag)) out.push(tag);
    const lang = tag.split("-")[0];
    if (lang && !out.includes(lang)) out.push(lang);
  };
  push(locale);
  push(fallback);
  return out;
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * Minor units → a currency string via Intl — THE formatter `derivePlanViews` defaults to,
 * exported so an app's other screens format identically to its pricing cards.
 *
 * One consumer kept seven local copies of this, two of which hardcoded EUR next to a
 * config that declares the currency. `formatMoney` on the pricing derivations stays the
 * override for a house style Intl won't reproduce ("€18" where it-IT writes "18,00 €").
 */
export function formatMinor(minor: number, currency: string, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

// ── The library's own words ─────────────────────────────────────────────────

export interface Messages {
  /** A limit that isn't one — a members column, a usage row. */
  unlimited: string;
  /** Billing intervals, for a derived "billing cycle" row. */
  monthly: string;
  yearly: string;
  /** Joins a list of seat types or intervals. */
  separator: string;
  /** A plan whose price is quoted rather than listed. */
  contactUs: string;
  /** A plan that costs nothing. */
  free: string;
  /** Column headers for a generated markdown plan table. */
  columnPlan: string;
  columnSeats: string;
  columnIncluded: string;
  columnMonthly: string;
  columnYearly: string;
  columnSeatTypes: string;
  columnTool: string;
  columnCost: string;
  /** Heading for rate-card entries the caller didn't group. */
  otherGroup: string;
  /** Refusals a customer sees. `{n}`-style placeholders are substituted. */
  seatMinimum: string;
  seatMaximum: string;
  seatTypeMaximum: string;
  memberMaximum: string;
  unknownPlan: string;
  notPurchasable: string;
  unknownSeatType: string;
  intervalUnavailable: string;
  poolExhausted: string;
  seatAllowanceReached: string;
  insufficientBalance: string;
  /** The two refusals that had no key at all, so `describeDenial` could not be
   *  translated even in part. `{name}` is the window's own label or its `every`;
   *  `{size}` its ceiling; `{resets}` an ISO instant, already formatted or "". */
  rateLimitReached: string;
  spendLimitReached: string;
  /** Payment-form fallbacks, used only when Stripe returns an error with no
   *  message of its own (Stripe's own messages are already localized by the
   *  Elements locale, so these are the rare path, not the usual one). */
  paymentDetailsInvalid: string;
  cardNotSaved: string;
  paymentFailed: string;
}

/**
 * English, and the only language this package ships.
 *
 * A consumer overrides what it needs; anything not overridden stays English
 * rather than becoming a missing string.
 */
export const DEFAULT_MESSAGES: Messages = {
  unlimited: "Unlimited",
  monthly: "Monthly",
  yearly: "Yearly",
  separator: ", ",
  contactUs: "Contact us",
  free: "Free",
  columnPlan: "Plan",
  columnSeats: "Seats",
  columnIncluded: "Included / cycle",
  columnMonthly: "Monthly",
  columnYearly: "Yearly",
  columnSeatTypes: "Seat types",
  columnTool: "Tool",
  columnCost: "Cost (credits)",
  otherGroup: "Other",
  seatMinimum: "At least {min} seats are required (got {got})",
  seatMaximum: "At most {max} seats (got {got})",
  seatTypeMaximum: 'At most {max} "{seatType}" seat(s) (got {got})',
  memberMaximum: "This plan allows at most {max} members (got {got})",
  unknownPlan: "Unknown plan",
  notPurchasable: "This plan is not self-serve ({sale})",
  unknownSeatType: 'Unknown seat type "{seatType}"',
  intervalUnavailable: "This plan is not sold {interval}",
  poolExhausted:
    "Plan allowance used up for this cycle ({size} credits). Contact us to extend the package.",
  seatAllowanceReached:
    "Seat credit allowance reached for this cycle. Ask an owner for a top-up, or buy credits.",
  insufficientBalance: "Insufficient credits (balance {balance}). Buy credits to continue.",
  rateLimitReached: "Usage limit reached for this {name} ({size}).{resets}",
  spendLimitReached:
    "Monthly spend limit reached ({size} credits). Raise the limit to continue.{resets}",
  paymentDetailsInvalid: "Invalid payment details",
  cardNotSaved: "Card not saved",
  paymentFailed: "Payment failed",
};

export type PartialMessages = Partial<Messages>;

/** Fill the gaps in a consumer's bundle with the English defaults. */
export const resolveMessages = (messages?: PartialMessages): Messages => ({
  ...DEFAULT_MESSAGES,
  ...messages,
});

/** Substitute `{name}` placeholders. Unknown names are left as-is, so a typo is
 *  visible rather than silently blank. */
export function formatMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? String(values[key]) : whole,
  );
}
