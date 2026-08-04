// The countries the LOCAL engine has rates for, as a type.
//
// This exists so `mode: "local"` with an origin the engine cannot compute is a
// COMPILE error rather than a refused charge at runtime. `origin` used to be a plain
// `string`, so `origin: "US"` typechecked, deployed, and then threw
// `ApproximateTaxError` on the first US-destined charge — the failure arriving as far
// as possible from the line that caused it.
//
// It is not only the US. `eu-vat-rates-data` covers 45 EUROPEAN countries, so a seller
// established in AU, NZ, JP, SG, CA, IN, BR or MX was equally unable to compute its own
// domestic rate and equally unwarned. All of them are now rejected at the config site.
//
// Generated from the dataset rather than hand-typed — `npm run origins:check` fails if
// the two drift, because a country added upstream that is missing here would be
// rejected for no reason, and one removed upstream would typecheck and then throw.
export const LOCAL_TAX_ORIGINS = [
  "AD", "AL", "AT", "BA", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES",
  "FI", "FR", "GB", "GE", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU",
  "LV", "MC", "MD", "ME", "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE",
  "SI", "SK", "TR", "UA", "XI", "XK",
] as const;

/**
 * An establishment country the local engine can compute tax for.
 *
 * If your establishment is not in this list — the United States above all — the local
 * mode cannot help you, and that is a fact about published rate data rather than a
 * gap someone forgot to fill. Use `mode: "stripe"`, or `mode: "external"` with a
 * provider that covers you.
 */
export type LocalTaxOrigin = (typeof LOCAL_TAX_ORIGINS)[number];

/** Is this establishment one the local engine can compute for? */
export function isLocalTaxOrigin(country: string | null | undefined): country is LocalTaxOrigin {
  return !!country && (LOCAL_TAX_ORIGINS as readonly string[]).includes(country.toUpperCase());
}
