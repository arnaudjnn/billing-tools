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
  enforceAccess,
  enforceTokens,
} from "./auth.js";

// Billing engine (Stripe math)
export {
  getStripe,
  stripeConfigured,
  ensureStripeCustomer,
  getBillingCustomerId,
  getTokenBalance,
  deductTokens,
  creditTokens,
  usageSince,
  createTokenCheckoutSession,
  createBillingPortalSession,
  getAutoReloadSettings,
  setAutoReloadSettings,
  tryAutoReload,
  listInvoices,
  listSubscriptionPrices,
  resolveSubscriptionPrice,
  type StripePrice,
} from "./billing.js";

// Declarative plans (auto-provision Stripe products/prices from config)
export {
  ensurePlans,
  planPriceId,
  planForPriceId,
  seatTypeForPriceId,
  seatLimit,
  includedTokens,
  includedTokensByType,
  lookupKeyFor,
  DEFAULT_SEAT_TYPES,
  type PlanDef,
  type SeatTypeDef,
  type PlansConfig,
  type BillingInterval,
  type EnsuredPrice,
} from "./plans.js";

// Per-execution metering engine (prepaid balance; per-seat packs or a global
// pool; usage summed from Stripe balance-transaction metadata — no new backend).
export {
  meterUsage,
  createMeter,
  type MeterCaller,
  type MeterInput,
  type MeterResult,
  type MeterConfig,
  type MeterCallOpts,
  type Meter,
} from "./metering.js";

// Top-up requests (user → owner approval) + admin-gated auto-top-up. Stored in
// WorkOS org metadata via the adapter — no new backend.
export {
  requestTopUp,
  listTopUpRequests,
  approveTopUp,
  denyTopUp,
  extraAllowance,
  setAutoTopUp,
  type TopUpRequest,
} from "./topup.js";

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

// Turn-key billing sync engine (owns the poll→dispatch→plan/token/mirror loop)
export {
  createBillingSync,
  createSyncRoute,
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
