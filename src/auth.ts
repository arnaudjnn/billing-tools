import { AsyncLocalStorage } from "node:async_hooks";
import type { BillingAdapter, ResolvedConfig, ToolErrorResult } from "./types.js";
import {
  getBillingCustomerId,
  getTokenBalance,
  deductTokens,
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
}

interface AuthStore {
  authHeader: string | null;
  // Pre-resolved org (e.g. the MCP transport verified an OAuth JWT). When set,
  // enforceAccess returns it without re-validating an API key.
  orgId?: string;
  principal?: Principal;
}

export const authContext = new AsyncLocalStorage<AuthStore>();

export function runWithAuth<T>(header: string | null, fn: () => T): T {
  return authContext.run({ authHeader: header }, fn);
}

// Used by the MCP transport's OAuth path: run with a pre-resolved org.
export function runWithResolvedOrg<T>(header: string | null, orgId: string, fn: () => T): T {
  return authContext.run({ authHeader: header, orgId }, fn);
}

/** Run with a known caller, so admin-only tools can check their role. Use this
 *  from a session-backed surface (a server action, an OAuth token carrying a
 *  user). The org may be pre-resolved or left to the API key. */
export function runWithPrincipal<T>(
  ctx: { authHeader?: string | null; orgId?: string; principal: Principal },
  fn: () => T,
): T {
  return authContext.run(
    { authHeader: ctx.authHeader ?? null, orgId: ctx.orgId, principal: ctx.principal },
    fn,
  );
}

/** The caller, if this surface established one. */
export function currentPrincipal(): Principal | null {
  return authContext.getStore()?.principal ?? null;
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
// are skipped. Otherwise deduct from the org's token balance and fire
// auto-reload in the background.
export async function enforceTokens(
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
  const balance = await getTokenBalance(customerId, config.currency);
  if (balance < cost) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Insufficient tokens. This tool costs ${cost} tokens but you only have ${balance}. Use buy_tokens to purchase more.`,
        },
      ],
    };
  }
  await deductTokens(customerId, toolName, cost, config.currency);
  autoReloadFor(customerId, config).catch(() => {});
  return null;
}
