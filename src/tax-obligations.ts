// WHERE A NON-ESTABLISHED SELLER OWES TAX — one file, because these rules move.
//
// This is the half of the tax question no dataset of RATES can answer. `eu-vat-rates-data`
// says what Italy's rate is; it cannot say that a French seller owes UK VAT on its first
// sale to a UK consumer, or that Norway waits until NOK 50 000. Those are facts about
// each country's rules for non-resident suppliers of digital services, and until now they
// lived in prose — in AGENTS.md, in a consumer's code comments, in an advisor's email.
//
// Two different facts, deliberately kept apart:
//
//   • WHAT EACH COUNTRY DEMANDS (this file) — objective, the same for every deployment,
//     and the thing a developer should not have to research. It belongs in the library
//     exactly as the rate data does.
//
//   • WHERE YOU ARE ACTUALLY REGISTERED (`config.tax.registrations`) — a fact only the
//     seller knows, and the library must never assume. Charging UK VAT without a UK
//     registration is collecting tax you cannot remit, which is worse than not charging.
//
// So this file does not replace the registration declaration; it is what lets the doctor
// tell you that the declaration is INCOMPLETE — you have UK customers and no UK entry —
// which is the warning nobody was getting.
//
// ── SCOPE, stated honestly ─────────────────────────────────────────────────
//
// Only countries whose rule has been read and cited. It is deliberately NOT a list of
// fifty: a plausible-looking threshold for a country nobody checked is worse than no
// entry, because it would be trusted. An absent country means "this library makes no
// claim", never "there is no obligation" — `nonResidentRule` returns undefined and the
// doctor stays quiet rather than reassuring you.
//
// EU member states are absent for a different reason: the engine already models them
// (place of supply, the €10 000 cross-border B2C threshold, OSS, reverse charge), so a
// second statement here could only disagree with it.

export interface NonResidentRule {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /**
   * When a B2C obligation starts for a supplier with no establishment there.
   *
   * `"first-sale"` means no threshold at all — the obligation exists from the first
   * consumer sale, so it is the one case a library can act on without knowing your
   * turnover. A `{ amount, currency }` threshold can only ever be a warning: whether
   * you have crossed it is a fact about your books.
   */
  b2cThreshold: "first-sale" | { amount: number; currency: string };
  /**
   * Does a B2B supply shift to the customer, so no registration is needed for it?
   *
   * True nearly everywhere digital services are taxed, and the reason "can I sell
   * there" usually has different answers for businesses and consumers.
   */
  b2bReverseCharge: boolean;
  /** The registration scheme's name, as that country calls it. */
  scheme?: string;
  /** Why we believe this. A rule with no source is a rumour. */
  source: string;
  /** ISO date this entry was last read against the source. */
  reviewed: string;
  /** What a report should tell someone who has customers here. */
  note?: string;
}

/**
 * The rules, keyed by country.
 *
 * ⚠️ These change. When you update one, move `reviewed` and keep `source` pointing at
 * something citable. When you ADD one, read the primary source — a blog post repeating
 * a threshold from three years ago is how a wrong number gets into a charge.
 */
export const NON_RESIDENT_RULES: readonly NonResidentRule[] = [
  {
    country: "GB",
    // The outlier, and the reason this file exists. The £90 000 registration threshold
    // applies to UK-ESTABLISHED businesses only; a non-established supplier of digital
    // services to UK consumers registers from the first sale.
    b2cThreshold: "first-sale",
    // HMRC's own manual: a non-established business is "not entitled or liable to
    // register" where all its UK supplies are reverse-charged. So B2B needs nothing.
    b2bReverseCharge: true,
    scheme: "UK VAT registration (NETP)",
    source: "https://www.gov.uk/hmrc-internal-manuals/vat-registration-manual/vatreg37200",
    reviewed: "2026-08-05",
    note: "No threshold for a non-established seller: UK B2C is 20% from the first sale. B2B is reverse-charged and needs no registration.",
  },
  {
    country: "NO",
    b2cThreshold: { amount: 50_000, currency: "nok" },
    b2bReverseCharge: true,
    scheme: "VOES",
    source: "https://www.regjeringen.no/en/aktuelt/vat-on-electronic-services-voesnorway--s/id643060",
    reviewed: "2026-08-05",
  },
  {
    country: "AU",
    b2cThreshold: { amount: 75_000, currency: "aud" },
    b2bReverseCharge: true,
    scheme: "Simplified GST registration",
    source: "https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/gst-on-imported-services-digital-products-and-low-value-imported-goods",
    reviewed: "2026-08-05",
  },
];

const BY_COUNTRY = new Map(NON_RESIDENT_RULES.map((r) => [r.country.toUpperCase(), r]));

/**
 * The rule for a country, or undefined when this library makes no claim about it.
 *
 * Undefined is NOT "no obligation" — most of the world taxes non-resident digital
 * services somewhere, and the entries here are the ones that have been read. Treat it as
 * "unknown", which is what the doctor does.
 */
export function nonResidentRule(country: string | null | undefined): NonResidentRule | undefined {
  return country ? BY_COUNTRY.get(country.toUpperCase()) : undefined;
}

/** Countries where the obligation starts at the first consumer sale — the only ones a
 *  library can be certain about without seeing your turnover. */
export function zeroThresholdCountries(): string[] {
  return NON_RESIDENT_RULES.filter((r) => r.b2cThreshold === "first-sale").map((r) => r.country);
}

/** How a threshold reads in a report. */
export function describeThreshold(rule: NonResidentRule): string {
  return rule.b2cThreshold === "first-sale"
    ? "from the first consumer sale (no threshold)"
    : `above ${rule.b2cThreshold.amount.toLocaleString("en-US")} ${rule.b2cThreshold.currency.toUpperCase()} a year`;
}
