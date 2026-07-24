// The storage seam. `orgId` is an opaque string — a WorkOS org id, a Postgres
// workspace id ("ws_…"), whatever the host uses. Implement this and the rest of
// billing-tools (auth flow, metering, all Stripe math, tool/route/CLI surfaces)
// works unchanged.

export interface BillingUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  obfuscatedValue: string;
}

export interface BillingAdapter {
  /** Resolve a raw Bearer API key → org, or null if invalid/revoked. */
  validateApiKey(token: string): Promise<{ orgId: string } | null>;
  /** Optional: resolve an OAuth bearer (JWT) → org id. Omit if no OAuth. */
  resolveOauthOrg?(token: string): Promise<string | null>;
  /** Verified domains for the org (used for the internal-org unmetered check). */
  getOrgDomains(orgId: string): Promise<string[]>;
  /** Read the Stripe customer id pointer for the org (null if none yet). */
  getBillingCustomerId(orgId: string): Promise<string | null>;
  /** Persist the Stripe customer id pointer for the org. */
  setBillingCustomerId(orgId: string, customerId: string): Promise<void>;
  /** After magic-auth: find or create the org/workspace for this user. */
  ensureOrgForUser(user: BillingUser): Promise<{ orgId: string }>;
  /** Mint a new API key for the org. Returns the raw value (shown once). */
  mintApiKey(orgId: string, name: string): Promise<{ id: string; value: string }>;
  /** List the org's (non-revoked) keys, obfuscated. */
  listApiKeys(orgId: string): Promise<ApiKeyInfo[]>;
  /** Revoke a key by id, scoped to the org (belongs-to check inside). */
  revokeApiKey(orgId: string, id: string): Promise<{ id: string; name: string } | null>;
}

export interface BillingConfig {
  /** Welcome credit granted on first Stripe customer creation. Default 100. */
  freeTokens?: number;
  /** Stripe currency, e.g. "usd" | "eur". Default "usd". */
  currency?: string;
  /** Base URL for Checkout success/cancel + billing-portal return. */
  baseUrl: string;
  /** Domains whose orgs are unmetered (internal). Default []. */
  internalDomains?: string[];
}

export type ResolvedConfig = Required<BillingConfig>;

export function resolveConfig(c: BillingConfig): ResolvedConfig {
  return {
    freeTokens: c.freeTokens ?? 100,
    currency: c.currency ?? "usd",
    baseUrl: c.baseUrl,
    internalDomains: c.internalDomains ?? [],
  };
}

// The MCP tool-result envelope every handler returns.
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
};
