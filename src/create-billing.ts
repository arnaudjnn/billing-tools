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
import { defaultUsageLedger, type UsageLedger } from "./usage-ledger.js";
import type { PlanCatalog } from "./plans.js";
import type { RunBillingCliOptions } from "./setup.js";
import { createBoundApi } from "./bound-api.js";

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
     * Where usage is COUNTED. Default: `stripeUsageLedger()` — the composite.
     *
     * It counts every ORG-wide window in Stripe (a meter summary, which sees
     * included usage and costs one request at any window width), and reads
     * per-CALLER windows from balance-transaction metadata. So a config whose
     * windows are all org-scoped — `cap: pool`, `cap: wallet`, `scope: "org"`
     * limits — needs no store at all.
     *
     * When a window is both INCLUDED and PER-MEMBER — a seat pack, or a
     * `scope: "caller"` limit — the default cannot see it, and it reads 0 forever.
     * Pass `stripeUsageLedger({ perCaller: stripeScopeUsageLedger() })`, which
     * counts that pair in Stripe too, with no store: each usage scope gets a Stripe
     * Customer of its own, which is the only second grouping key Stripe offers.
     * It is opt-in rather than default because creating those customers is a side
     * effect a consumer should choose. `checkPlansConfig` names the plans that
     * need it, and `createMeter` warns at boot.
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

  // The ledger, resolved once: an explicit one wins, otherwise the composite.
  //
  // The composite is the default because it counts every ORG-wide window in
  // Stripe — included usage too, one request per window at any volume — so a
  // config whose windows are all org-scoped needs nothing else. That was
  // previously impossible: the old default was the debits themselves, so an
  // included call counted as 0 and every window read 0%.
  //
  // A per-MEMBER included window (a seat pack, a `scope: "caller"` limit) is the
  // one case the default cannot see, and the answer is `ledger` above with
  // `stripeScopeUsageLedger()` as the per-caller leg — still no store. There is
  // no longer a `db` or `counters` shortcut: they existed only for that case, and
  // a database is no longer the way to solve it.
  const ledger = opts.meter?.ledger ?? defaultUsageLedger();

  // What the wired ledger cannot count is warned about by `createMeter` below,
  // which every metered call goes through whichever constructor composed the app —
  // so the rule lives in one place (`warnLedgerGaps`) instead of once per entry
  // point, which is how the two copies came to disagree about pooled plans.

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
        ledger,
      })
    : undefined;
  const meterRequest = meter
    ? createApiMeterGuard(opts.adapter, meter, { realm: opts.realm })
    : undefined;

  // Every org-scoped library function, with adapter/config/plans/ledger/resolvePlan
  // already applied. This is what removes the ~40 hand-written pass-throughs each
  // consumer used to need before writing any product code — and, more importantly,
  // removes the place where a wrapper could file a grant against the wrong cycle.
  const api = createBoundApi({
    adapter: opts.adapter,
    config: resolved,
    plans: opts.plans,
    ledger,
    resolvePlan: opts.resolvePlan ?? opts.meter?.resolvePlan,
  });

  return {
    adapter: opts.adapter,
    config: resolved,
    /**
     * What `runBillingCli` needs, taken from THIS composition — spread it into the
     * app's billing script and add only the webhook URL:
     *
     *     runBillingCli({ ...billing.cli, webhookUrl: "https://myapp.example/api/stripe/webhook" })
     *
     * Derived rather than restated, because every value here is one the script used
     * to name a second time: the catalogue, the config, and — the sharp one — what
     * the wired ledger can COUNT. A script that states its own coverage can be
     * right while the app is wrong, which is the exact shape of the worst bug this
     * library has had (a wallet-only ledger counting pooled usage as 0, so every
     * subscriber got unlimited requests, with every check passing).
     *
     * `hasCheckout` is true when a catalogue is registered with the lifecycle tools
     * left on, because `change_plan` then opens a hosted Checkout Session itself —
     * so a self-serve plan really is buyable without the app mounting anything.
     *
     * `workos` audits by default (WorkOS is the substrate every adapter here
     * assumes) and asks for `REFRESH_TOKEN_SECRET` only when the OAuth proxy is
     * actually mounted, which is the one thing that makes it required.
     *
     * The webhook URL stays the app's to give: it is a deployment fact, and putting
     * a production URL in this object would let a laptop run register it.
     */
    cli: {
      plans: opts.plans,
      config: resolved,
      usageLedger: ledger.covers,
      hasCheckout: Boolean(opts.plans) && opts.subscriptionTools !== false,
      workos: oauthProxy ? { oauthProxy: true } : true,
    } satisfies Omit<RunBillingCliOptions, "webhookUrl">,
    /** The bound, org-scoped API: `api.invoices.list(orgId)`, `api.usage.summary(orgId)`, … */
    api,
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
