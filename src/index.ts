// billing-tools — make your Stripe + WorkOS app ready to get paid.

// Types + config
export type {
  BillingAdapter,
  BillingUser,
  ApiKeyInfo,
  BillingConfig,
  ResolvedConfig,
  ToolResult,
  ToolErrorResult,
} from "./types.js";
export { resolveConfig, internalDomainsFromEnv } from "./types.js";

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
  // The plan model: five independent axes (what it sells, what it credits, what
  // it includes, how it's replenished, whether it can be bought) + presentation.
  // The legacy PlanDef keeps working — `normalizePlans` maps it.
  definePlans,
  isLegacyPlan,
  normalizePlan,
  normalizePlans,
  planModel,
  plansWhere,
  selfServePlans,
  defaultBasket,
  validateBasket,
  describeBasketProblem,
  grantFor,
  poolSizeOf,
  poolIsPerSeat,
  packSizeOf,
  exhaustedPolicy,
  capCovers,
  cycleWindowFor,
  rateWindowFor,
  rateLimitsOf,
  ledgerGaps,
  coverageNeededBy,
  includedCredits,
  includedCreditsByType,
  lookupKeyFor,
  DEFAULT_SEAT_TYPES,
  type PlanDef,
  type SeatTypeDef,
  type PlansConfig,
  type BillingInterval,
  type EnsuredPrice,
  type PlanPrices,
  type MigratedSubscription,
  type MigrateSubscriptionsResult,
  type PlanCatalog,
  type PlanSpec,
  type PlanModel,
  type LedgerCoverage,
  type PlanDisplay,
  type PlanLimits,
  type SeatTypeSpec,
  type SeatTypeDisplay,
  type NormalSeatType,
  type Sells,
  type Grant,
  type Cap,
  type CapWindow,
  type CapCovers,
  type Every,
  type RateLimit,
  type Exhausted,
  type Replenish,
  type Sale,
  type Money,
  type IntervalPrice,
  type Quantities as PlanQuantities,
  type BasketProblem,
  type CycleWindow,
} from "./plans.js";

// The subscription lifecycle: one entry point for up, down and off. Before this,
// every plan or seat change opened a fresh Checkout Session and created a SECOND
// subscription, so the customer was billed twice.
export {
  changePlan,
  cancelPlan,
  planActions,
  planRank,
  PlanChangeError,
  type PlanChangeResult,
  type PlanChangeKind,
  type PlanChangeTiming,
  type PlanChangeErrorCode,
  type ProrationPolicy,
  type PlanActions,
} from "./subscription.js";

// i18n: the config's display text can be one string or one per locale, and the
// handful of words the LIBRARY supplies default to English and are overridable.
export {
  resolveLocalized,
  resolveLocalizedList,
  resolveMessages,
  formatMessage,
  DEFAULT_MESSAGES,
  type Localized,
  type LocalizedList,
  type LocaleOptions,
  type Messages,
  type PartialMessages,
} from "./i18n.js";

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
  postgresUsageLedger,
  ensureUsageLedgerTable,
  USAGE_EVENTS_DDL,
  type SqlClient,
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
// Tax computed locally (sales-tax + VIES) and applied to Stripe as an explicit
// rate — the alternative to paying Stripe Tax for the calculation.
export {
  resolveTax,
  ensureStripeTaxRate,
  invalidateTaxRates,
  taxRatesFor,
  updateCheckoutSessionTaxRates,
  // WHO calculates, declared once in `config.tax` and read by every charge.
  taxFor,
  taxModeOf,
  type TaxMode,
  type TaxDecision,
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
  checkPlansConfig,
  formatDoctorResult,
  type Check,
  type CheckLevel,
  type DoctorResult,
} from "./doctor.js";

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
