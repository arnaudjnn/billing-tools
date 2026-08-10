import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "./types.js";
import { resolveConfig } from "./types.js";
import { registerBillingTools, type RegisterBillingToolsOptions } from "./tools/register.js";
import { createDispatcher } from "./dispatch.js";
import { createToolListHandler, createToolDispatchHandler } from "./routes/rest.js";
import { createMcpTransport } from "./routes/mcp.js";
import { getBillingCustomerId, grantCredits } from "./billing.js";
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
import type { Notifier } from "./notifications/index.js";
import { createEmitter } from "./notifications/emit.js";
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
  /**
   * Membership: the invitation service, and the roles this deployment invites into.
   *
   * Passing it is what turns on `invite_member` / `list_invitations` / `revoke_invitation` and
   * `api.members.invite` — there is nowhere to put an invitation record without one. The other
   * three member tools need only an adapter that can describe and change a membership.
   */
  members?: RegisterBillingToolsOptions["members"];
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
  /** MCP transport overrides. `requireAuth` gates the handshake itself — see
   *  `createMcpTransport`. */
  mcp?: { apiKeyPrefix?: string; maxDuration?: number; requireAuth?: boolean };
  /**
   * Enable MPP machine payments (pay-per-request 402). Omit to leave it off.
   *
   * `amount` is optional HERE, unlike in the standalone handler: omitted, a request is
   * priced at what the tool it is calling costs — `toolCosts[<tool>]`, read from the
   * path, which is the same map `get_credit_balance` and the REST tool list publish. A
   * consumer that wrote that function by hand was re-deriving its own rate card, and a
   * flat fee is wrong in both directions across a catalogue that spans 0 to 80 credits.
   * Pass a number to charge one price per request regardless of tool.
   */
  machinePayment?: Omit<MachinePaymentOptions, "amount"> & {
    amount?: MachinePaymentOptions["amount"];
  };
  /**
   * Where to send the things this library learns and cannot say itself.
   *
   * It knows the moment a member is invited, the moment somebody asks their admin for more
   * credit, and the moment an allowance crosses a threshold — and it renders no email, in
   * no language. Configure a notifier and each of those becomes an event, with the
   * recipients already resolved from the workspace's membership; the consumer renders and
   * sends. Omit it and every emission is a no-op that costs nothing.
   *
   * `webhookNotifier({ endpoint, secret })` is the shipped transport, for the common case
   * where the code that CAN render the email is an HTTP route away (a Next app whose
   * templates are JSX the billing package cannot compile). Any object with `deliver` works.
   */
  notifications?: Notifier;
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
    /**
     * Percentages of an included allowance worth telling somebody about. Default `[80, 100]`.
     *
     * Only meaningful with `notifications` configured, and only for allowances the plan
     * GIVES (a seat pack, the shared pool). Rate limits are deliberately never alerted on:
     * they reset within days and the customer cannot act on one. The customer's own spend
     * alerts are theirs, set through `set_spend_controls`, and are not a deployment default.
     */
    alertThresholds?: readonly number[];
  };
}

export function createBilling(opts: CreateBillingOptions) {
  const resolved = resolveConfig(opts.config);

  // Telling somebody. `undefined` when no notifier is configured, and every call site is
  // `notify?.(…)`, so a deployment that wants none pays nothing.
  const notify = createEmitter(opts.adapter, opts.notifications);

  // The invitation service, with the "it happened" event attached.
  //
  // Wrapped HERE rather than emitted from inside `send()`: the service is the consumer's
  // object (it may not even be this library's WorkOS one), and what the library owns is the
  // fact that an invitation now exists and somebody should be told. `hooks.sendEmail` stays
  // for a consumer that renders in-process — a deployment can have both, and one that has
  // neither still gets WorkOS's own email.
  const invitations = opts.members?.invitations;
  const invitationsWithEvents =
    invitations && notify
      ? {
          ...invitations,
          send: async (
            orgId: string,
            email: string,
            roleSlug: string,
            inviterUserId?: string,
          ) => {
            const invitation = await invitations.send(orgId, email, roleSlug, inviterUserId);
            notify({
              // The invitation id: one invitation, one email, however many times a retry or
              // a second replica re-delivers this.
              id: `invite:${invitation.id}`,
              type: "invitation.created",
              orgId,
              to: [],
              audience: { kind: "email", email: invitation.email },
              data: {
                invitationId: invitation.id,
                email: invitation.email,
                roleSlug: invitation.roleSlug,
                // The service builds this from its own accept path; the fallback is that
                // service's own default, for a custom implementation that records none.
                acceptUrl: invitation.acceptUrl ?? `${resolved.baseUrl}/invita/${invitation.id}`,
                organizationId: invitation.organizationId,
                ...(inviterUserId ? { inviterUserId } : {}),
              },
            });
            return invitation;
          },
        }
      : invitations;

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
      // The SAME ledger the meter gates with, so a tool cannot report allowance a call
      // would be refused for. It is resolved below as `ledger`; hoisting is not possible
      // (this closure runs per request, long after), which is why it reads it there.
      usageLedger: ledger,
      members: { ...opts.members, invitations: invitationsWithEvents },
      notify,
    });
    opts.registerTools?.(server);
  };

  const dispatcher = createDispatcher(register);

  const restList = createToolListHandler({ dispatcher, toolCosts: opts.toolCosts });
  // The payment gate, referenced lazily because it is composed further down (and only
  // ever called at request time). Wiring it HERE is what makes `billing.restDispatch`
  // answer an empty wallet with an offer instead of a dead end — the consumer gets it by
  // configuring `machinePayment`, not by wrapping the handler.
  const payment = opts.machinePayment
    ? { requirePayment: (request: Request) => machinePayment!.requirePayment(request) }
    : undefined;
  const restDispatch = createToolDispatchHandler({
    dispatcher,
    realm: opts.realm,
    resourceMetadata,
    payment,
  });
  const mcp = createMcpTransport({
    register,
    adapter: opts.adapter,
    realm: opts.realm,
    apiKeyPrefix: opts.mcp?.apiKeyPrefix,
    maxDuration: opts.mcp?.maxDuration,
    requireAuth: opts.mcp?.requireAuth,
    resourceMetadata,
  });
  const webhook =
    opts.webhook === false
      ? undefined
      : createStripeWebhookHandler({
          ...(opts.webhook || {}),
          currency: opts.webhook?.currency ?? resolved.currency,
        });

  /**
   * WHICH org just paid an MPP charge.
   *
   * An MPP retry puts the payment credential in `Authorization: Payment …`, so the API key
   * — if the caller has one — travels in `X-Api-Key` on that request. Both are read, and a
   * caller with neither is anonymous: the payment still settles (that is between the agent
   * and Stripe), it simply credits no wallet, because there is no wallet to credit.
   */
  const orgForRequest = async (request: Request): Promise<string | null> => {
    const auth = request.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const token = bearer ?? request.headers.get("x-api-key")?.trim() ?? null;
    if (!token) return null;
    return (await opts.adapter.validateApiKey(token).catch(() => null))?.orgId ?? null;
  };

  // MPP machine payments (pay-per-request) + its /payment.md discovery doc.
  //
  // `creditWallet` is what makes a paid MPP request MEAN something. The module implements
  // the protocol — 402 challenge, retry, settle — and then handed the consumer an `onPaid`
  // callback to write, so a request that was genuinely paid for granted nothing unless the
  // app remembered to credit it. The caller here is an agent that hit 402 on an empty
  // wallet, which is to say a caller holding an API key: the org is resolvable from the
  // request, and the money it just paid belongs in that org's wallet.
  const machinePayment = opts.machinePayment
    ? createMachinePaymentHandler({
        ...opts.machinePayment,
        // Priced from the rate card this composition already holds: the tool being called
        // names itself in the path (`/api/v0/<tool>`), so an agent is challenged for what
        // that call actually costs. Anything unrecognised falls back to 1 — a challenge
        // for a small wrong amount beats one for 0, which would mean nothing.
        amount:
          opts.machinePayment.amount ??
          ((request: Request) => {
            const tool = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
            return opts.toolCosts?.[tool] || 1;
          }),
        onPaid: async (challenge, receipt, request) => {
          if (opts.machinePayment?.creditWallet) {
            const orgId = await orgForRequest(request);
            const customerId = orgId ? await getBillingCustomerId(opts.adapter, orgId) : null;
            if (customerId) {
              await grantCredits(
                customerId,
                challenge.amount,
                `Machine payment: ${challenge.amount} credits (${challenge.method})`,
                challenge.currency,
                // The challenge id is single-use and server-issued, so a replayed retry
                // credits once — the same discipline every other credit path follows.
                `credit:mpp:${challenge.id}`,
              );
            }
          }
          await opts.machinePayment?.onPaid?.(challenge, receipt, request);
        },
      })
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
        // The alerts ride the same emitter as everything else, and they are the one kind
        // this library can only notice on the hot path: nothing else knows the moment a
        // call took somebody from 79% to 81%.
        notify,
        ...(opts.meter.alertThresholds ? { alertThresholds: opts.meter.alertThresholds } : {}),
      })
    : undefined;
  const meterRequest = meter
    ? createApiMeterGuard(opts.adapter, meter, { realm: opts.realm, payment })
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
    invitations: invitationsWithEvents,
    notify,
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
