// Languages Stripe can issue an invoice in, as BCP-47 codes.
//
// A leaf module with no imports, like the field limits next door: a language
// picker is a client component, and reaching for this through the package root
// would drag the server entry into the browser bundle.
//
// Labels are deliberately absent. `Intl.DisplayNames` already knows every one
// of these in whatever language the app is written in, so shipping a name table
// here would be a worse copy of something the platform has — and it would be in
// English for an app that isn't.
//
// Source: Stripe Invoicing's supported languages. Region-qualified entries are
// separate languages to Stripe (en vs en-GB, pt vs pt-BR), not fallbacks.
export const INVOICE_LOCALES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "en-GB",
  "es",
  "es-419",
  "et",
  "fi",
  "fil",
  "fr",
  "fr-CA",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "ml",
  "ms",
  "mt",
  "nb",
  "nl",
  "pl",
  "pt",
  "pt-BR",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "th",
  "tr",
  "vi",
  "zh",
  "zh-HK",
  "zh-TW",
] as const;

export type InvoiceLocale = (typeof INVOICE_LOCALES)[number];
