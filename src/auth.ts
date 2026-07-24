import { AsyncLocalStorage } from "node:async_hooks";
import type { BillingAdapter, ResolvedConfig, ToolErrorResult } from "./types.js";
import {
  getBillingCustomerId,
  getTokenBalance,
  deductTokens,
  tryAutoReload,
  stripeConfigured,
} from "./billing.js";

interface AuthStore {
  authHeader: string | null;
  // Pre-resolved org (e.g. the MCP transport verified an OAuth JWT). When set,
  // enforceAccess returns it without re-validating an API key.
  orgId?: string;
}

export const authContext = new AsyncLocalStorage<AuthStore>();

export function runWithAuth<T>(header: string | null, fn: () => T): T {
  return authContext.run({ authHeader: header }, fn);
}

// Used by the MCP transport's OAuth path: run with a pre-resolved org.
export function runWithResolvedOrg<T>(header: string | null, orgId: string, fn: () => T): T {
  return authContext.run({ authHeader: header, orgId }, fn);
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

async function isInternalOrg(
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
  const balance = await getTokenBalance(customerId);
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
  tryAutoReload(customerId, config.currency).catch(() => {});
  return null;
}
