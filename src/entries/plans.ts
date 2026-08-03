// `@arnaudjnn/billing-tools/plans` — the plan catalogue and its arithmetic, with
// NOTHING behind it.
//
// The root barrel re-exports 45 modules, so `import { planModel } from
// "@arnaudjnn/billing-tools"` in a Server Component pulls in the MCP SDK,
// mcp-handler, authkit-nextjs, Stripe, WorkOS and eu-vat-rates-data to answer a question
// about a plain object. This leaf is the same three modules the pricing entry
// already proves can stand alone: `plan-model.ts`, `i18n.ts` and `types.ts` import
// no external package at all, so this graph is pure TypeScript.
//
// What that buys, beyond bundle size: a config file, a docs generator, a pricing
// page and a test can all read the catalogue without a Stripe key in the
// environment. `test/conventions.test.mjs` asserts the purity, because the way it
// would be lost is one convenient re-export at a time.
//
// NOT here, deliberately:
//   • `ensurePlans`, `planPriceId`, `migrateSubscriptions` — they MINT Stripe
//     prices, which is the whole reason `plans.ts` imports Stripe.
//   • `checkPlansConfig` — it lives in `doctor.ts` beside the account audit, which
//     reads Stripe. Import it from the root; it is a deploy-time call, not one a
//     page makes.
// Both stay available from the root barrel.

// The five axes, the normalised model, and everything derived from it:
// definePlans, planModel, normalizePlans, poolSizeOf, packSizeOf, capCovers,
// rateLimitsOf, cycleWindowFor, validateBasket, toolCapabilities, …
export * from "../plan-model.js";

// Localisation of app-authored strings (`Localized`, `resolveLocalized`) and the
// library's own English defaults (`DEFAULT_MESSAGES`). A plan's display copy is
// localised, so the plan model cannot be read without these.
export * from "../i18n.js";

// The storage seam and the config shape: `BillingAdapter`, `BillingConfig`,
// `resolveConfig`, `internalDomainsFromEnv`. Deliberately SDK-independent — that
// abstraction is exactly what lets a non-WorkOS adapter satisfy the interface, and
// it is why they belong in a pure entry.
export * from "../types.js";
