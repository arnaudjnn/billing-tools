// billing-tools — make your Stripe + WorkOS app ready to get paid.

// The whole PURE half of the library, in one line: the plan model and its five
// axes, the storage seam (`BillingAdapter`, `BillingConfig`, `resolveConfig`) and
// the i18n helpers. It is re-exported wholesale from the `/plans` leaf rather than
// re-listed here, because a hand-maintained list of 89 names is a list that drifts
// — `list_plans` sat in `BILLING_TOOL_NAMES`-adjacent limbo for exactly that
// reason, registered and unadvertised. The leaf is curated, so `export *` widens
// nothing that was not already intended public.
export * from "./entries/plans.js";

// Auth engine
export {
  authContext,
  runWithAuth,
  runWithResolvedOrg,
  runWithPrincipal,
  currentPrincipal,
  enforceAccess,
  enforceAdmin,
  type Principal,
  enforceCredits,
} from "./auth.js";

// The two SDK clients. Both are memoised singletons that read the env lazily,
// and they are the only constructors anywhere — including in consuming apps.
// A second `new WorkOS(...)` in a route handler is a second client (and, per
// request, a second connection pool) reading the same key to do the same thing.
export { getWorkOS } from "./workos.js";

// Pattern B: the app's own row 1:1 with a WorkOS org. Supplies the adapter's
// `map` and the membership helpers every mirror app would otherwise rewrite.
export {
  createWorkOSOrgMirror,
  ALL_MEMBERSHIP_STATUSES,
  type WorkOSOrgMirror,
  type WorkOSOrgMirrorOptions,
} from "./org-mirror.js";

// Billing engine (Stripe math)
export {
  getStripe,
  stripeConfigured,
  ensureStripeCustomer,
  getBillingCustomerId,
  getOrgSubscription,
  getCreditBalance,
  deductCredits,
  grantCredits,
  usageSince,
  createCreditCheckoutSession,
  quoteCreditPurchase,
  invalidateCreditQuotes,
  type CreditQuote,
  createBillingPortalSession,
  getAutoReloadSettings,
  setAutoReloadSettings,
  getSpendControls,
  setSpendControls,
  spendControlsOf,
  type SpendControls,
  tryAutoReload,
  autoReloadFor,
  type ChargeTax,
  type TopUpCheckoutOptions,
  listInvoices,
  getInvoice,
  invoicePdfUrl,
  listOrgInvoices,
  getOrgInvoice,
  orgInvoicePdfUrl,
  listSubscriptionPrices,
  resolveSubscriptionPrice,
  type InvoiceEntry,
  type StripePrice,
} from "./billing.js";

// Declarative plans (auto-provision Stripe products/prices from config)
export {
  // The Stripe-touching half of the catalogue: minting prices, reading them back,
  // and repricing live subscribers. The pure model comes from the leaf above.
  ensurePlans,
  resolvePlanPrices,
  invalidatePlanPrices,
  migrateSubscriptions,
  planPriceId,
  planForPriceId,
  seatTypeForPriceId,
  seatLimit,
  seatTypeLimit,
  planSale,
  includedCredits,
  includedCreditsByType,
  lookupKeyFor,
  type EnsuredPrice,
  type PlanPrices,
  type MigratedSubscription,
  type MigrateSubscriptionsResult,
  // Aliased because checkout.ts exports a `Quantities` of its own.
  type Quantities as PlanQuantities,
} from "./plans.js";

// The subscription lifecycle: one entry point for up, down and off. Before this,
// every plan or seat change opened a fresh Checkout Session and created a SECOND
// subscription, so the customer was billed twice.
export {
  changePlan,
  cancelPlan,
  planActions,
  planRank,
  // The READ side of the same arithmetic, and it was missing from this barrel:
  // `preview_plan_change` used it internally, so an agent could quote a change and
  // a server action could not. That is the parity rule inverted — a confirm dialog
  // saying "nothing is charged today" with no way to say what the NEXT invoice comes
  // to is the surprise `nextInvoiceAt` + `nextInvoiceTotal` exist to remove.
  previewPlanChange,
  PlanChangeError,
  type PlanChangePreview,
  type PlanChangeResult,
  type PlanChangeKind,
  type PlanChangeTiming,
  type PlanChangeErrorCode,
  type ProrationPolicy,
  type PlanActions,
} from "./subscription.js";

// Pricing view models: the plan config turned into what a surface renders. Also
// available as the leaf entry point `@arnaudjnn/billing-tools/pricing`, which
// pulls in neither Stripe nor WorkOS — so a client component and a docs
// generator can both read it.
export {
  derivePlanViews,
  derivePlanView,
  renderPlansMarkdown,
  renderRateCardMarkdown,
  // The comparison table: authored as a table, cells keyed BY PLAN (a positional
  // tuple silently shifted every cell when a plan moved), and rows that restate a
  // configured number can be DERIVED from it instead.
  defineCompare,
  deriveCompareTable,
  compareRowLabels,
  type PlanView,
  type PlanPriceView,
  type SeatRowView,
  type CtaView,
  type MoneyView,
  type DerivePlanViewsOptions,
  type MarkdownOptions,
  type CompareConfig,
  type CompareSection,
  type CompareGroup,
  type CompareRow,
  type CompareValue,
  type CompareSource,
  type CompareCell,
  type CompareTableView,
  type CompareSectionView,
  type CompareGroupView,
  type CompareRowView,
  type DeriveCompareOptions,
} from "./pricing.js";

// Included allowance as a counted WINDOW (a pool, or a per-seat pack) rather than
// as credit — a Stripe credit balance auto-applies to the next invoice, so
// crediting a plan's own included credits discounts its own renewal.
export {
  resolveAllowance,
  fundingFor,
  describeDenial,
  // The one definition of "this cycle". Anything that files something against a
  // cycle must use it, or the meter will look the grant up under another key.
  currentCycle,
  type AllowanceState,
  type AllowanceInput,
  type FundingDecision,
  type DenialReason,
  type LimitState,
} from "./allowance.js";
// The read side of the same arithmetic: what a usage screen shows, per window and
// per member, from the numbers the meter itself enforces.
export {
  usageSummary,
  memberUsage,
  resolveSeat,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageWindow,
  type UsageSeat,
  type MemberUsage,
} from "./usage.js";
// Counting usage separately from moving money — the seam an included window needs.
export {
  stripeBalanceUsageLedger,
  stripeMeterUsageLedger,
  stripeUsageLedger,
  defaultUsageLedger,
  warnLedgerGaps,
  ensureMeters,
  invalidateMeters,
  USAGE_METER_EVENT,
  type UsageLedger,
  type UsageEvent,
  type UsageQuery,
  type FundingSource,
} from "./usage-ledger.js";

// The per-caller leg, and the reason this library ships no store at all any more:
// one Stripe Customer per usage SCOPE, so the one window Stripe supposedly cannot
// count — INCLUDED and PER-MEMBER — is counted by Stripe after all. Wallet-funded
// usage still comes from the debits, which is why a caller-scoped rate limit keeps
// its zero lag while a seat pack tolerates the meter's.
//
// No database anywhere. Bring your own `ledger` if you want the per-action history
// a store keeps — nothing here can say WHICH actions made up a total.
// A short-lived cache in front of ANY ledger. Opt-in, because a cached window is
// a stale window and the gate reads through it — see the file for the overspend
// bound. It is what keeps a per-seat catalogue off Stripe's 25 req/s per-endpoint
// limit, and it collapses a usage screen's N per-member reads into one round.
export { cachedUsageLedger, type UsageCacheOptions } from "./usage-cache.js";

// Counting fails as a number that is silently wrong, not as an exception. This is
// how a deployment gets told, and what the library did about it.
export {
  onUsageFault,
  resetUsageFaults,
  type UsageFault,
  type UsageFaultHandler,
  type UsageFaultOperation,
  type UsageFaultOutcome,
} from "./usage-faults.js";

export {
  stripeScopeUsageLedger,
  invalidateUsageScopes,
  scopeOf,
  scopesFor,
  SCOPE_METER_EVENT,
  USAGE_SCOPE_KIND,
  USAGE_SCOPE_KEY,
  type ScopeLedgerOptions,
} from "./usage-scopes.js";

// Per-execution metering engine (prepaid balance; per-seat packs or a global
// pool; usage summed from Stripe balance-transaction metadata — no new backend).
export {
  meterUsage,
  createMeter,
  createApiMeterGuard,
  type MeterCaller,
  type MeterInput,
  type MeterResult,
  type MeterConfig,
  type MeterCallOpts,
  type Meter,
  type ApiMeterGuard,
} from "./metering.js";

// Top-up requests (user → owner approval) + admin-gated auto-top-up. Stored via
// the adapter — no new backend. A GRANT goes on the MEMBER (setUserMetadata) so
// there is no member ceiling; the request queue stays on the org, trimmed to what
// a metadata value actually holds. See the note at the top of topup.ts.
export {
  requestTopUp,
  listTopUpRequests,
  approveTopUp,
  denyTopUp,
  grantTopUp,
  grantExtraAllowance,
  extraAllowance,
  trimRequestsToBudget,
  METADATA_VALUE_LIMIT,
  type TopUpRequest,
} from "./topup.js";

// Seat-type assignments (per-member seat, stored in org metadata)
export {
  assignSeatType,
  listSeatAssignments,
  getSeatType,
} from "./seats.js";

// WorkOS magic-auth
export { sendMagicAuth, verifyMagicAuth } from "./magic-auth.js";

// WorkOS organization invitations (shared, hook-configurable)
export {
  createWorkOSInvitations,
  type InvitationService,
  type Invitation,
  type InvitationHooks,
  type InvitationEmailContext,
  type WorkOSInvitationsOptions,
} from "./invitations.js";

// Event-polling sync (zero-webhook: poll Stripe + WorkOS Events APIs)
export { pollStripeEvents, pollWorkOSEvents, type PollResult } from "./events.js";

// Turn-key billing sync engine (owns the poll→dispatch→plan/credit/mirror loop)
export {
  createBillingSync,
  createSyncRoute,
  // Shared handlers: wire into a webhook (payments) and/or let the sync poll
  // them (state). One implementation, either trigger.
  createStripeEventHandler,
  PAYMENT_EVENT_TYPES,
  SYNC_EVENT_TYPES,
  type BillingSync,
  type BillingSyncOptions,
  type CursorStore,
} from "./sync.js";

// Generic DB mirror for WorkOS entities (table-agnostic; org + user shapes)
export {
  createMirror,
  type Mirror,
  type MirrorOptions,
  type MirrorQuery,
  type MirrorQueryResult,
} from "./mirror.js";

// Tool registration
export {
  registerBillingTools,
  installInputLogging,
  BILLING_TOOL_NAMES,
  type RegisterBillingToolsOptions,
} from "./tools/register.js";
export type { TopUpToolOptions } from "./tools/billing.js";

// REST dispatch bridge
export { createDispatcher, ToolValidationError, type RegisterFn } from "./dispatch.js";

// One-call composition helper (mount every surface from one config)
export { createBilling, type CreateBillingOptions } from "./create-billing.js";
// The org-scoped API with adapter/config/plans/ledger already applied — what
// `createBilling().api` returns. Exported standalone for a consumer composing the
// factories by hand: 37 functions here take the adapter first, and re-binding them
// per app is ~40 files of mechanical wrappers AND the one place a grant can be
// filed against the wrong cycle.
export { createBoundApi, type BillingApi, type BoundApiDeps } from "./bound-api.js";

// auth.md — agent self-registration protocol (framework-agnostic handlers)
export {
  createAgentAuth,
  CLAIM_GRANT_TYPE,
  type AgentAuthOptions,
  type AgentAuthBranding,
  type AgentAuthPaths,
  type AgentAuthPolicy,
  type AgentIdentityType,
} from "./agent-auth/index.js";
export {
  inMemoryClaimStore,
  type ClaimStore,
  type ClaimStatus,
  type ClaimReadResult,
} from "./agent-auth/claim-store.js";

// Machine payments — MPP (the 402 payment sibling of auth.md)
export {
  createMachinePaymentHandler,
  createPaymentMd,
  type MachinePaymentOptions,
  type MachinePaymentMethod,
  type PaymentChallenge,
  type SettleFn,
  type PaymentMdOptions,
} from "./machine-payment/index.js";

// MCP OAuth 2.1 + Dynamic Client Registration proxy (opt-in via
// createBilling({ oauthProxy }) or standalone).
export {
  createOAuthProxy,
  type OAuthProxy,
  type OAuthProxyOptions,
  type OAuthProxyPaths,
  type ClaimGrantChain,
} from "./oauth-proxy/index.js";

// Next route factories
export { createToolListHandler, createToolDispatchHandler, type Dispatcher } from "./routes/rest.js";
export { createMcpTransport, type McpTransportOptions } from "./routes/mcp.js";
export { createStripeWebhookHandler, type WebhookOptions } from "./routes/webhook.js";
// Register the endpoint from a deploy script instead of the Dashboard.
export {
  ensureWebhookEndpoint,
  BILLING_WEBHOOK_EVENTS,
  type EnsureWebhookResult,
} from "./webhook-setup.js";
// Tax computed locally (eu-vat-rates-data + VIES) and applied to Stripe as an explicit
// rate — the alternative to paying Stripe Tax for the calculation.
export {
  resolveTax,
  ensureStripeTaxRate,
  invalidateTaxRates,
  invalidateVatNumbers,
  taxRatesFor,
  updateCheckoutSessionTaxRates,
  // WHO calculates, declared once in `config.tax` and read by every charge.
  taxFor,
  taxModeOf,
  // Where the business is established, resolved in ONE place: `config.tax.origin`,
  // else the Stripe account's own country. Nothing else may read `tax.origin` — it
  // decides domestic vs cross-border, which is the whole question a VAT rate turns
  // on, so a second copy of it is a second answer.
  originFor,
  invalidateTaxOrigin,
  type TaxMode,
  type TaxDecision,
  type TaxRegistration,
  type TaxNotes,
  noteFor,
} from "./tax.js";
// Stripe Tax configuration as code (origin address, defaults, registrations).
export {
  ensureTaxSetup,
  type TaxRegistrationSpec,
  type TaxSetupResult,
} from "./tax-setup.js";
// Preflight for the misconfigurations that fail silently (zero tax, unspecified
// tax_behavior, a missing or disabled endpoint, duplicates).
export {
  checkBillingSetup,
  // The other half of the substrate. Stripe was audited thoroughly and WorkOS not
  // at all, so an environment could look healthy until the first sign-in.
  checkWorkOSSetup,
  checkPlansConfig,
  formatDoctorResult,
  // The CLI around the two checks. Both consumers hand-wrote the same argv parsing
  // and exit-code arithmetic (64 and 75 lines, 87 of them differing, same job).
  runBillingDoctor,
  type RunDoctorOptions,
  type Check,
  type CheckLevel,
  type DoctorResult,
} from "./doctor.js";
// Provision + verify one Stripe environment in one call — the deploy-time twin of
// the lazy provisioning the request path does. `billing-tools dev` / `doctor` (the
// bin) cover the parts that need no app config.
export {
  setupBilling,
  formatSetupReport,
  type SetupOptions,
  type SetupResult,
  type SetupStep,
} from "./setup.js";

// CLI factory
export { registerBillingCommands } from "./cli/commands.js";
export { callTool, listTools, type ApiClientConfig } from "./cli/client.js";
export {
  type CliOptions,
  type CliConfig,
  configPath,
  readConfig,
  writeConfig,
  resolveBaseUrl,
  resolveApiKey,
} from "./cli/config.js";

// Utils
export { lookupCompany } from "./util/clearout.js";

// Embedded-checkout server side (pairs with @arnaudjnn/billing-tools/ui).
// createCheckoutSession is the default path — Stripe Tax calculates the tax;
// createSubscription is the older fixed-rate one.
export {
  createCheckoutSession,
  checkoutSessionOutcome,
  expireCheckoutSession,
  forgetCheckoutSession,
  createSubscription,
  updateSubscription,
  cancelSubscription,
} from "./checkout.js";
export type {
  Quantities,
  CheckoutSessionResult,
  SubscriptionResult,
} from "./checkout.js";
export { resolveSession, ANONYMOUS_SESSION } from "./session.js";
export type { BillingSession, SessionUser } from "./session.js";
export type { PlanSource } from "./session.js";
export {
  listPaymentMethods,
  createCardSetupIntent,
  createCardSetupCheckoutSession,
  savedCardFromCheckoutSession,
  setDefaultPaymentMethod,
  detachPaymentMethod,
} from "./payment-methods.js";
export type { SavedCard } from "./payment-methods.js";
// Which payment methods a form offers, provisioned from code. The only lever that
// removes Link: its inline signup ignores `payment_method_types`.
export {
  defaultPaymentMethodConfig,
  ensurePaymentMethodConfig,
  invalidatePaymentMethodConfigs,
  type PaymentMethodConfigOptions,
} from "./payment-method-config.js";
export {
  getBillingProfile,
  updateBillingProfile,
  INVOICE_EMAIL_MAX,
  COMPANY_NAME_MAX,
} from "./billing-profile.js";
export type { BillingProfile } from "./billing-profile.js";
export type { BillingAddress } from "./billing-profile.js";
export { listCustomerTaxIds, setCustomerTaxId } from "./tax-ids.js";
export type { CustomerTaxId } from "./tax-ids.js";

export { LOCAL_TAX_ORIGINS, isLocalTaxOrigin, type LocalTaxOrigin } from "./tax-origins.js";
export type { TaxConfig, TaxCalculator, TaxCalculation } from "./types.js";
