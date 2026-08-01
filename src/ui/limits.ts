// Field limits, in a leaf module with NO imports.
//
// Forms need these, and forms are client components. Reaching for them through
// the package root would drag the server entry — Stripe's secret-key client,
// the MCP handler, `async_hooks` — into a browser bundle, which does not
// build. Keeping them importable from `/ui` means the number lives once
// instead of being copied into every consumer as a magic constant.
//
// These are Stripe's limits on the customer fields they map to, not ours.

/** Stripe Customer `email`. */
export const INVOICE_EMAIL_MAX = 254;

/** Stripe Customer `name`. */
export const COMPANY_NAME_MAX = 64;
