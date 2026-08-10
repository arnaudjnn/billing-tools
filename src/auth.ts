import { AsyncLocalStorage } from "node:async_hooks";
import type { BillingAdapter, ResolvedConfig, ToolErrorResult } from "./types.js";
import {
  getBillingCustomerId,
  getCreditBalance,
  deductCredits,
  autoReloadFor,
  stripeConfigured,
} from "./billing.js";

/**
 * Who is making this call, when that is known.
 *
 * An org API key identifies an ORG, not a person — it is the credential a
 * headless agent holds, and there is no user behind it. A session-backed caller
 * (the app's own server actions, an OAuth token minted for a user) does know,
 * and passing it here is what lets the admin-only tools tell an owner from a
 * member. Absent, the caller is treated as org-scoped, which is what every
 * caller was before this existed.
 */
export interface Principal {
  /** The user id the adapter's `isAdmin` understands (a WorkOS user id). */
  userId: string;
  /** Pre-resolved role, when the caller already knows it — skips the lookup. */
  isAdmin?: boolean;
  /**
   * Their address, when the surface knows it.
   *
   * Only `enforceOperator` reads it, and it has to: a platform operator is identified by
   * WHO THEY ARE across every workspace, not by a role inside one — an operator answering a
   * customer's quote is typically not a member of that customer's workspace at all.
   */
  email?: string;
}

interface AuthStore {
  authHeader: string | null;
  /**
   * A platform-operator credential presented by a machine (`X-Operator-Token`).
   *
   * Separate from `authHeader` because it answers a different question: that one says which
   * WORKSPACE is calling, this says the caller acts for the deployment itself. An agent
   * doing operator work holds both — its own workspace key, and this.
   */
  operatorToken?: string;
  // Pre-resolved org (e.g. the MCP transport verified an OAuth JWT). When set,
  // enforceAccess returns it without re-validating an API key.
  orgId?: string;
  principal?: Principal;
}

export const authContext = new AsyncLocalStorage<AuthStore>();

export function runWithAuth<T>(
  header: string | null,
  fn: () => T,
  extra?: { operatorToken?: string },
): T {
  return authContext.run({ authHeader: header, ...extra }, fn);
}

// Used by the MCP transport's OAuth path: run with a pre-resolved org.
export function runWithResolvedOrg<T>(header: string | null, orgId: string, fn: () => T): T {
  return authContext.run({ authHeader: header, orgId }, fn);
}

/** Run with a known caller, so admin-only tools can check their role. Use this
 *  from a session-backed surface (a server action, an OAuth token carrying a
 *  user). The org may be pre-resolved or left to the API key. */
export function runWithPrincipal<T>(
  ctx: {
    authHeader?: string | null;
    orgId?: string;
    principal: Principal;
    operatorToken?: string;
  },
  fn: () => T,
): T {
  return authContext.run(
    {
      authHeader: ctx.authHeader ?? null,
      orgId: ctx.orgId,
      principal: ctx.principal,
      operatorToken: ctx.operatorToken,
    },
    fn,
  );
}

/** The caller, if this surface established one. */
export function currentPrincipal(): Principal | null {
  return authContext.getStore()?.principal ?? null;
}

/** The machine operator credential this call presented, if any. */
export function currentOperatorToken(): string | null {
  return authContext.getStore()?.operatorToken ?? null;
}

/**
 * Who the deployment lets sell at a negotiated price.
 *
 * `BILLING_OPERATOR_EMAILS` (comma-separated) plus `BILLING_OPERATOR_TOKEN` for a machine.
 * Read at call time rather than at boot so rotating either needs a restart of nothing.
 */
export function operatorConfig(): { emails: string[]; token: string | null } {
  return {
    emails: (process.env.BILLING_OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    token: process.env.BILLING_OPERATOR_TOKEN?.trim() || null,
  };
}

/**
 * Is this REQUEST an operator's, judged without the auth context.
 *
 * `enforceOperator` reads AsyncLocalStorage, which is right at call time and unavailable to
 * the two places that have to decide what to ADVERTISE — the REST tool list and the MCP
 * transport picking which tool set to build. Both hold the raw request, so they ask here.
 */
export function operatorFromRequest(
  request: Request,
  principal?: { email?: string } | null,
): boolean {
  const { emails, token } = operatorConfig();
  const presented = request.headers.get("x-operator-token")?.trim();
  if (token && presented && presented === token) return true;
  const email = principal?.email?.trim().toLowerCase();
  return Boolean(email && emails.includes(email));
}

/**
 * The platform's own staff — and the ONE gate in this library that fails CLOSED.
 *
 * Everywhere else, an unanswerable question allows: `enforceAdmin` lets an org API key
 * through because that credential has no user behind it, and an adapter that cannot report
 * roles must not lock every admin tool. Both are the right trade when the thing being
 * prevented is smaller than the thing being broken.
 *
 * Here it is the other way round. This gate stands between a customer and their own
 * discount: "unknown allows" would mean any workspace key could approve the price its own
 * admin just asked for, which is not a permission that should exist at any level of doubt.
 * So a caller who cannot be identified as an operator is refused, and a deployment that has
 * configured no operators has nobody who can approve — which is correct, and says so.
 */
export function enforceOperator(action: string): { authorized: true } | ToolErrorResult {
  const { emails, token } = operatorConfig();
  const presented = currentOperatorToken();
  const email = currentPrincipal()?.email?.trim().toLowerCase();

  const byToken = Boolean(token && presented && presented === token);
  const byEmail = Boolean(email && emails.includes(email));
  if (byToken || byEmail) return { authorized: true };

  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Forbidden (403): ${action} is a platform-operator action. ` +
          (emails.length || token
            ? "Sign in as an operator, or present X-Operator-Token."
            : "This deployment has configured no operators (BILLING_OPERATOR_EMAILS)."),
      },
    ],
  };
}

// Resolve the caller's org from the Bearer API key (via the adapter). Returns
// the org id or a parseable 401 envelope (REST/MCP layers sniff "Unauthorized
// (401)" to map to HTTP 401 + WWW-Authenticate).
export async function enforceAccess(
  adapter: BillingAdapter,
): Promise<{ authorized: true; orgId: string } | ToolErrorResult> {
  const store = authContext.getStore();
  if (store?.orgId) return { authorized: true, orgId: store.orgId };

  const header = store?.authHeader;
  if (!header || !header.startsWith("Bearer ")) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Unauthorized (401): Missing or malformed Authorization header. Use get_api_key to obtain an API key.",
        },
      ],
    };
  }
  const token = header.slice("Bearer ".length).trim();
  const resolved = await adapter.validateApiKey(token);
  if (!resolved) {
    return {
      isError: true,
      content: [{ type: "text", text: "Unauthorized (401): Invalid API key." }],
    };
  }
  return { authorized: true, orgId: resolved.orgId };
}

/**
 * `enforceAccess`, plus a role check when the surface knows who is calling.
 *
 * The rule, and why it is shaped like this: an ORG API KEY has no user behind
 * it, so there is no role to check and it stays owner-level — that is what the
 * credential means, and it is what every caller got before this function
 * existed, so adding the check breaks nobody. A caller that DOES identify a user
 * (a server action, an OAuth token for a person) gets checked against the
 * adapter, which is what stops a member from approving their own top-up or
 * moving themselves onto a premium seat through the API while the app's own UI
 * refuses them.
 *
 * An adapter with no `isAdmin` cannot answer, so the call is allowed rather than
 * refused: silently locking out every management tool would be a worse failure
 * than the one being prevented.
 */
export async function enforceAdmin(
  adapter: BillingAdapter,
  action: string,
): Promise<{ authorized: true; orgId: string; principal: Principal | null } | ToolErrorResult> {
  const auth = await enforceAccess(adapter);
  if ("isError" in auth) return auth;

  const principal = currentPrincipal();
  if (!principal) return { authorized: true, orgId: auth.orgId, principal: null };
  if (principal.isAdmin === true) return { authorized: true, orgId: auth.orgId, principal };
  if (!adapter.isAdmin) return { authorized: true, orgId: auth.orgId, principal };

  const ok = await adapter.isAdmin(auth.orgId, principal.userId);
  if (!ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Forbidden (403): ${action} requires an owner or admin of this workspace.`,
        },
      ],
    };
  }
  return { authorized: true, orgId: auth.orgId, principal };
}

/**
 * Refuse a `member_id` that does not belong to the caller's workspace.
 *
 * Three tools take one — `assign_seat_type`, `grant_top_up`, `request_top_up` — and none of
 * them checked it, so ANY valid org key could name ANY user id in the environment. The org
 * gate was doing its job and still let this through, because it answers "which workspace is
 * calling", never "is this person in it".
 *
 * What that reaches, measured: all three write to the named user's WorkOS **user** metadata,
 * which is global to the user rather than scoped to an org. Per-org keying meant the victim's
 * own seat was not overwritten — so the damage is not a wrong seat, it is the BUDGET. WorkOS
 * allows 10 keys and 600 characters per value, and `setUserMetadata` rejects the whole object
 * once it overflows; enough writes from a stranger and the victim's real workspace can no
 * longer assign a seat or record a grant. A cross-tenant denial of service, from a legitimate
 * key, against a store whose limits this file already treats as a budget.
 *
 * An adapter with no `listMemberIds` cannot answer, so the call is allowed — the same
 * trade-off `enforceAdmin` documents above, for the same reason: disabling seats and top-ups
 * outright for every adapter without a membership concept is a worse failure than the one
 * being prevented. `WorkOSOrgAdapter` has it, so the shipped path is checked.
 */
export async function enforceMember(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  action: string,
): Promise<ToolErrorResult | null> {
  if (!adapter.listMemberIds) return null;
  const members = await adapter.listMemberIds(orgId);
  if (members.includes(memberId)) return null;
  return {
    isError: true,
    content: [
      {
        type: "text",
        // "Forbidden (403)" is the wire contract the REST and MCP routes pattern-match on,
        // so this refusal reaches an HTTP caller as a 403 rather than a 500.
        text: `Forbidden (403): ${action} names a user who is not a member of this workspace.`,
      },
    ],
  };
}

export async function isInternalOrg(
  adapter: BillingAdapter,
  orgId: string,
  internalDomains: string[],
): Promise<boolean> {
  if (internalDomains.length === 0) return false;
  const set = new Set(internalDomains.map((d) => d.toLowerCase()));
  const domains = await adapter.getOrgDomains(orgId);
  return domains.some((d) => set.has(d.toLowerCase()));
}

// Metering gate for paid tools. Free (cost 0), Stripe-unset, and internal orgs
// are skipped. Otherwise deduct from the org's credit balance and fire
// auto-reload in the background.
export async function enforceCredits(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  orgId: string,
  toolName: string,
  cost: number,
): Promise<ToolErrorResult | null> {
  if (!cost) return null;
  if (!stripeConfigured()) return null;
  if (await isInternalOrg(adapter, orgId, config.internalDomains)) return null;

  const customerId = await getBillingCustomerId(adapter, orgId);
  if (!customerId) {
    return {
      isError: true,
      content: [{ type: "text", text: "No billing account found. Please contact support." }],
    };
  }
  const balance = await getCreditBalance(customerId, config.currency);
  if (balance < cost) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Insufficient credits. This tool costs ${cost} credits but you only have ${balance}. Use buy_credits to purchase more.`,
        },
      ],
    };
  }
  await deductCredits(customerId, toolName, cost, config.currency);
  autoReloadFor(customerId, config).catch(() => {});
  return null;
}
