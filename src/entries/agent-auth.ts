// `@arnaudjnn/billing-tools/agent-auth` — the two agent-facing protocols and the
// OAuth proxy that fronts them.
//
// auth.md (WorkOS agent self-registration) and MPP (Stripe's 402 machine-payment
// challenge) are siblings: one gets an agent an identity, the other gets it a paid
// resource. Grouped in one entry because an app that mounts either almost always
// mounts both, and neither is on the path of an app that only sells to humans —
// which is the reason they should not have been in the root barrel.

// auth.md — agent self-registration protocol (framework-agnostic handlers).
export {
  createAgentAuth,
  CLAIM_GRANT_TYPE,
  type AgentAuthOptions,
  type AgentAuthBranding,
  type AgentAuthPaths,
  type AgentAuthPolicy,
  type AgentIdentityType,
} from "../agent-auth/index.js";
export {
  inMemoryClaimStore,
  type ClaimStore,
  type ClaimStatus,
  type ClaimReadResult,
} from "../agent-auth/claim-store.js";

// MPP — 402 + WWW-Authenticate: Payment. Settlement is injected, so the challenge
// side is offline-testable without a machine-payments-eligible Stripe account.
export {
  createMachinePaymentHandler,
  createPaymentMd,
  type MachinePaymentOptions,
  type MachinePaymentMethod,
  type PaymentChallenge,
  type SettleFn,
  type PaymentMdOptions,
} from "../machine-payment/index.js";

// MCP OAuth 2.1 + Dynamic Client Registration proxy.
export {
  createOAuthProxy,
  type OAuthProxy,
  type OAuthProxyOptions,
  type OAuthProxyPaths,
  type ClaimGrantChain,
} from "../oauth-proxy/index.js";
