// `@arnaudjnn/billing-tools/tools` — registering the billing tool surface, and the
// REST bridge that turns it into endpoints.
//
// Carries the MCP SDK, zod, Stripe and WorkOS (the handlers move money and read
// the org), which is unavoidable. What it does NOT carry is mcp-handler or
// authkit-nextjs — those belong to the transports and the UI, and the root barrel
// reaches both, so an app that only registers tools was resolving two peer deps it
// never called.
//
// `createDispatcher` is here rather than under `/routes` because it is what makes
// the parity rule structural — it monkey-patches `server.tool`, so every tool
// registered here is a REST endpoint with no extra wiring, and the route factories
// are just its HTTP shell.

export {
  registerBillingTools,
  installInputLogging,
  BILLING_TOOL_NAMES,
  OPERATOR_TOOL_NAMES,
  type RegisterBillingToolsOptions,
} from "../tools/register.js";
export {
  registerMemberTools,
  registerWorkspaceTools,
  type MemberToolOptions,
} from "../tools/members.js";
export { registerQuoteTools, type QuoteToolOptions } from "../tools/quotes.js";
export type { TopUpToolOptions } from "../tools/billing.js";
export type { SubscriptionToolOptions } from "../tools/subscription.js";

// Which groups the catalogue can satisfy. Exported here as well as from the pure
// `/plans` leaf because it is the argument `registerBillingTools` reads, and an app
// overriding a group wants both names from one import.
export {
  toolCapabilities,
  ALL_TOOL_CAPABILITIES,
  type ToolCapabilities,
} from "../plan-model.js";

export { createDispatcher, ToolValidationError, type RegisterFn } from "../dispatch.js";
