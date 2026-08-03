// `@arnaudjnn/billing-tools/routes` — the Next route factories.
//
// One import per file you mount: the REST list + dispatch handlers, the MCP
// transport, and the Stripe webhook. Carries Stripe and mcp-handler because those
// ARE the surfaces; carries no WorkOS, no authkit and no React.
//
// `createBilling` is deliberately absent — it composes these three plus the tools,
// the agent-auth handlers and the MPP handler, so it needs the whole graph and
// stays at the root, where it also guarantees the single module instance its shared
// AsyncLocalStorage depends on.

export { createToolListHandler, createToolDispatchHandler, type Dispatcher } from "../routes/rest.js";
export { createMcpTransport, type McpTransportOptions } from "../routes/mcp.js";
export { createStripeWebhookHandler, type WebhookOptions } from "../routes/webhook.js";

// Registering the endpoint from a deploy script rather than the Dashboard: the
// signing secret Stripe returns once, at creation, is why this cannot be lazy.
export {
  ensureWebhookEndpoint,
  BILLING_WEBHOOK_EVENTS,
  type EnsureWebhookResult,
} from "../webhook-setup.js";
