import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "./types.js";
import { resolveConfig } from "./types.js";
import { registerBillingTools } from "./tools/register.js";
import { createDispatcher } from "./dispatch.js";
import { createToolListHandler, createToolDispatchHandler } from "./routes/rest.js";
import { createMcpTransport } from "./routes/mcp.js";
import { createStripeWebhookHandler } from "./routes/webhook.js";
import {
  createAgentAuth,
  type AgentAuthBranding,
  type AgentAuthPaths,
  type AgentAuthPolicy,
  type AgentIdentityType,
} from "./agent-auth/index.js";
import type { ClaimStore } from "./agent-auth/claim-store.js";
import { createMachinePaymentHandler, createPaymentMd, type MachinePaymentOptions } from "./machine-payment/index.js";
import type { PlansConfig } from "./plans.js";

// One-call composition helper. Instead of wiring the five factories by hand in
// a per-app "composition root", pass your adapter + config (and optionally
// plans, product tools, agent-auth branding) and get back every mounted handler
// from a SINGLE billing-tools module instance (so the AsyncLocalStorage auth
// context is shared). The individual factories stay exported for fine control.

export interface CreateBillingOptions {
  /** Storage adapter (WorkOSOrgAdapter or your own). */
  adapter: BillingAdapter;
  /** Billing config; resolved once internally. */
  config: BillingConfig;
  /** Per-tool token costs (echoed by get_token_balance + the REST tool list). */
  toolCosts?: Record<string, number>;
  /** WWW-Authenticate realm on 401s. */
  realm?: string;
  /** Declarative plans → auto-provisioned Stripe products/prices + list_plans. */
  plans?: PlansConfig;
  defaultPlan?: string;
  /** Register your app's own product tools alongside the billing tools. */
  registerTools?: (server: McpServer) => void;
  /** Enable auth.md agent self-registration. Omit to leave it off. */
  agentAuth?: {
    branding: AgentAuthBranding;
    identityTypes?: AgentIdentityType[];
    baseUrl?: string | ((request: Request) => string);
    policy?: AgentAuthPolicy;
    asMetadataExtra?: Record<string, unknown>;
    paths?: AgentAuthPaths;
    claimStore?: ClaimStore;
  };
  /** Stripe webhook handler. Defaults on (currency from config); `false` to skip. */
  webhook?: { currency?: string } | false;
  /** MCP transport overrides. */
  mcp?: { apiKeyPrefix?: string; maxDuration?: number };
  /** Enable MPP machine payments (pay-per-request 402). Omit to leave it off. */
  machinePayment?: MachinePaymentOptions;
}

export function createBilling(opts: CreateBillingOptions) {
  const resolved = resolveConfig(opts.config);

  const agentAuth = opts.agentAuth
    ? createAgentAuth({ adapter: opts.adapter, config: resolved, ...opts.agentAuth })
    : undefined;
  const resourceMetadata = agentAuth
    ? (request: Request) => agentAuth.resourceMetadataUrl(request)
    : undefined;

  // ONE registrar used by both the dispatcher (REST shadow server) and the live
  // MCP server, so the two surfaces expose an identical tool set.
  const register = (server: McpServer) => {
    registerBillingTools(server, {
      adapter: opts.adapter,
      config: resolved,
      toolCosts: opts.toolCosts,
      plans: opts.plans,
      defaultPlan: opts.defaultPlan,
    });
    opts.registerTools?.(server);
  };

  const dispatcher = createDispatcher(register);

  const restList = createToolListHandler({ dispatcher, toolCosts: opts.toolCosts });
  const restDispatch = createToolDispatchHandler({ dispatcher, realm: opts.realm, resourceMetadata });
  const mcp = createMcpTransport({
    register,
    adapter: opts.adapter,
    realm: opts.realm,
    apiKeyPrefix: opts.mcp?.apiKeyPrefix,
    maxDuration: opts.mcp?.maxDuration,
    resourceMetadata,
  });
  const webhook =
    opts.webhook === false
      ? undefined
      : createStripeWebhookHandler({ currency: opts.webhook?.currency ?? resolved.currency });

  // MPP machine payments (pay-per-request) + its /payment.md discovery doc.
  const machinePayment = opts.machinePayment
    ? createMachinePaymentHandler(opts.machinePayment)
    : undefined;
  const paymentMd = opts.machinePayment
    ? createPaymentMd({
        productName: opts.agentAuth?.branding.productName ?? "This service",
        methods: opts.machinePayment.methods,
        currency: opts.machinePayment.currency ?? resolved.currency,
      })
    : undefined;

  return {
    adapter: opts.adapter,
    config: resolved,
    register,
    dispatcher,
    /** MCP transport: mount `export const { GET, POST } = mcp` in app/[transport]/route.ts. */
    mcp,
    /** GET /api/v0 tool list handler. */
    restList,
    /** POST /api/v0/[tool] dispatch handler. */
    restDispatch,
    /** Stripe webhook POST handler (undefined if `webhook: false`). */
    webhook,
    /** auth.md handlers (undefined unless `agentAuth` was configured). */
    agentAuth,
    /** MPP handler `{ requirePayment, buildChallenges }` (undefined unless `machinePayment` was configured). */
    machinePayment,
    /** `/payment.md` handler (undefined unless `machinePayment` was configured). */
    paymentMd,
  };
}
