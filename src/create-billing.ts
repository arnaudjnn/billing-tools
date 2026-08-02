import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "./types.js";
import { resolveConfig } from "./types.js";
import { registerBillingTools, type RegisterBillingToolsOptions } from "./tools/register.js";
import { createDispatcher } from "./dispatch.js";
import { createToolListHandler, createToolDispatchHandler } from "./routes/rest.js";
import { createMcpTransport } from "./routes/mcp.js";
import { createStripeWebhookHandler, type WebhookOptions } from "./routes/webhook.js";
import {
  CLAIM_GRANT_TYPE,
  createAgentAuth,
  type AgentAuthBranding,
  type AgentAuthPaths,
  type AgentAuthPolicy,
  type AgentIdentityType,
} from "./agent-auth/index.js";
import type { ClaimStore } from "./agent-auth/claim-store.js";
import { createMachinePaymentHandler, createPaymentMd, type MachinePaymentOptions } from "./machine-payment/index.js";
import { createOAuthProxy, type OAuthProxyOptions } from "./oauth-proxy/index.js";
import { createMeter, createApiMeterGuard } from "./metering.js";
import type { UsageLedger } from "./usage-ledger.js";
import { normalizePlans } from "./plan-model.js";
import type { PlanCatalog } from "./plans.js";

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
  /** Per-tool credit costs (echoed by get_credit_balance + the REST tool list). */
  toolCosts?: Record<string, number>;
  /** WWW-Authenticate realm on 401s. */
  realm?: string;
  /** Declarative plans → auto-provisioned Stripe products/prices + list_plans. */
  plans?: PlanCatalog;
  defaultPlan?: string;
  /** Tax and return URLs for `buy_credits`. Supply `taxRates` on any account that
   *  charges tax on its subscriptions — a top-up has no address form of its own,
   *  so without this it invoices at 0%. */
  topUp?: RegisterBillingToolsOptions["topUp"];
  /** How to find an org's plan when it isn't on the adapter's subscription. */
  resolvePlan?: (orgId: string) => Promise<string | null>;
  /** Lifecycle tools (`change_plan`, `preview_plan_change`, …). Default on when
   *  `plans` is set; pass false to keep plan changes in the app's own UI. */
  subscriptionTools?: RegisterBillingToolsOptions["subscriptionTools"];
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
  /**
   * Stripe webhook handler. Defaults on (currency from config); `false` to skip.
   *
   * Pass `onOtherEvent` to handle the events the route doesn't credit itself —
   * typically `createStripeEventHandler(...)`, so invoice.paid and
   * invoice.payment_failed run the same code the poller would.
   */
  webhook?: (WebhookOptions & { currency?: string }) | false;
  /** MCP transport overrides. */
  mcp?: { apiKeyPrefix?: string; maxDuration?: number };
  /** Enable MPP machine payments (pay-per-request 402). Omit to leave it off. */
  machinePayment?: MachinePaymentOptions;
  /** Enable the MCP OAuth 2.1 + Dynamic Client Registration proxy, so MCP
   *  clients (Claude Desktop, Claude.ai) can connect without an API key. When
   *  set, the authorization_code + refresh_token grants are advertised, the
   *  authorization/registration endpoints appear in AS metadata, and
   *  `billing.oauth` exposes the four route handlers. Requires
   *  REFRESH_TOKEN_SECRET. */
  oauthProxy?: OAuthProxyOptions | true;
  /** Enable the bound call-site meter (`billing.meter`) + the API route guard
   *  (`billing.meterRequest`). Pass your rate card; the meter uses `plans` above
   *  for seat packs. Plan resolution defaults to the org's `plan` metadata key
   *  (override via `resolvePlan`). Omit to leave metering off. */
  meter?: {
    /** action → credit cost (per unit). Consumer-authored product data. */
    rateCard?: Record<string, number>;
    /** Resolve the org's current plan key. Default: the org's `plan` metadata
     *  (via adapter.getOrgMetadata). Override to read a subscription, etc. */
    resolvePlan?: (orgId: string) => Promise<string | null>;
    /** Seat-type keys a caller maps to by identity. Default standard / api. */
    seatDefaults?: { user?: string; api?: string };
    /** Plan-cache TTL (ms). Default 60_000. */
    planCacheTtlMs?: number;
    /** Cycle window (unix s) + key. Default: 1st-of-month UTC / "YYYY-MM". */
    cycleStart?: () => number;
    cycleKey?: () => string;
    /**
     * Where usage is COUNTED. Default: the balance-transaction ledger.
     *
     * Pass one whenever any plan has a `cap` or a `limits.rate`. The default
     * ledger is the debits themselves, and an included call moves no money, so
     * it writes no transaction to count: a pool or a per-seat pack read through
     * it is permanently 0, which means the cap never bites and a usage screen
     * reads 0% forever. `stripeMeterUsageLedger()` sees included usage but
     * aggregates one dimension, so it cannot answer per-caller — a product that
     * needs per-member figures wants its own store behind this seam.
     */
    ledger?: UsageLedger;
  };
}

export function createBilling(opts: CreateBillingOptions) {
  const resolved = resolveConfig(opts.config);

  // MCP OAuth 2.1 + DCR proxy (opt-in). Built first so agentAuth can advertise
  // its endpoints and grants in the discovery document.
  // eslint-disable-next-line prefer-const -- assigned below; the closure reads it lazily
  let agentAuthRef: ReturnType<typeof createAgentAuth> | undefined;
  const oauthProxy = opts.oauthProxy
    ? createOAuthProxy({
        ...(opts.oauthProxy === true ? {} : opts.oauthProxy),
        baseUrl:
          (opts.oauthProxy === true ? undefined : opts.oauthProxy.baseUrl) ??
          opts.agentAuth?.baseUrl,
        // Late-bound: agentAuth is built after this (it needs the endpoints
        // above for discovery), and the getter runs per request.
        claimGrant: () =>
          agentAuthRef
            ? { type: CLAIM_GRANT_TYPE, handle: agentAuthRef.handleClaimGrant }
            : undefined,
      })
    : undefined;

  const agentAuth = opts.agentAuth
    ? createAgentAuth({
        adapter: opts.adapter,
        config: resolved,
        ...opts.agentAuth,
        // An OAuth proxy adds two grants and two endpoints to discovery. Merged
        // here (not asked of the caller) so enabling `oauthProxy` is the only
        // thing needed for a client to discover the flow.
        ...(oauthProxy
          ? {
              policy: {
                ...opts.agentAuth.policy,
                extraGrantTypes: [
                  ...(opts.agentAuth.policy?.extraGrantTypes ?? []),
                  ...oauthProxy.grantTypes,
                ],
              },
              asMetadataExtra: (request: Request) => ({
                ...oauthProxy.asMetadata(request),
              }),
            }
          : {}),
      })
    : undefined;
  agentAuthRef = agentAuth;
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
      topUp: opts.topUp,
      subscriptionTools: opts.subscriptionTools,
      resolvePlan: opts.resolvePlan ?? opts.meter?.resolvePlan,
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
      : createStripeWebhookHandler({
          ...(opts.webhook || {}),
          currency: opts.webhook?.currency ?? resolved.currency,
        });

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

  // A cap or a rate limit counted by the DEFAULT ledger is counted by nothing:
  // the default ledger IS the debits, and included usage moves no money. The
  // failure is silent and looks like generosity (every window reads 0%, nothing
  // is ever refused), so it is worth one line at boot.
  if (opts.meter && !opts.meter.ledger && opts.plans) {
    const counted = normalizePlans(opts.plans).filter(
      (m) => m.cap.kind !== "wallet" || m.limits.rate.length > 0,
    );
    if (counted.length) {
      console.warn(
        `[billing] plans ${counted.map((m) => m.key).join(", ")} declare an included window or a rate ` +
          "limit, but no `meter.ledger` was passed. The default ledger can only see wallet-funded " +
          "calls, so that usage counts as 0 and the limits never apply. Pass a ledger " +
          "(stripeMeterUsageLedger(), or your own store for per-caller figures).",
      );
    }
  }

  // Bound call-site meter + API route guard (opt-in). Plan resolution defaults to
  // the org's `plan` metadata so the common case needs no resolver.
  const meter = opts.meter
    ? createMeter(opts.adapter, resolved, {
        plans: opts.plans ?? {},
        rateCard: opts.meter.rateCard,
        resolvePlan:
          opts.meter.resolvePlan ??
          (async (orgId: string) =>
            (await opts.adapter.getOrgMetadata?.(orgId))?.plan ?? null),
        seatDefaults: opts.meter.seatDefaults,
        planCacheTtlMs: opts.meter.planCacheTtlMs,
        cycleStart: opts.meter.cycleStart,
        cycleKey: opts.meter.cycleKey,
        ledger: opts.meter.ledger,
      })
    : undefined;
  const meterRequest = meter
    ? createApiMeterGuard(opts.adapter, meter, { realm: opts.realm })
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
    /** Bound call-site meter (undefined unless `meter` was configured):
     *  `await meter(orgId, action, { caller })`. */
    meter,
    /** API route guard (undefined unless `meter` was configured):
     *  `const gate = await meterRequest(req, action); if (gate) return gate`. */
    meterRequest,
    /** auth.md handlers (undefined unless `agentAuth` was configured). */
    agentAuth,
    /** MPP handler `{ requirePayment, buildChallenges }` (undefined unless `machinePayment` was configured). */
    machinePayment,
    /** `/payment.md` handler (undefined unless `machinePayment` was configured). */
    paymentMd,
    /** MCP OAuth proxy handlers (undefined unless `oauthProxy` was configured).
     *  Mount as app/oauth/{authorize,register,callback,token}/route.ts. `token`
     *  also serves the auth.md claim grant, so it replaces agentAuth.token. */
    oauth: oauthProxy
      ? {
          authorize: oauthProxy.authorize,
          register: oauthProxy.register,
          callback: oauthProxy.callback,
          token: oauthProxy.token,
        }
      : undefined,
  };
}
