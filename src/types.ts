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
  /** ISO timestamp the key was created. Optional so third-party adapters that
   *  don't track it stay source-compatible. */
  createdAt?: string;
  /** ISO timestamp of the key's last successful use, or null if never used. */
  lastUsedAt?: string | null;
  /** Scopes granted to the key; empty/absent means full access. */
  permissions?: string[];
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
  /** Mint a new API key for the org. `createdBy` (the acting user id) is
   *  passed when available; adapters that don't track it may ignore it.
   *  Returns the raw value (shown once). */
  mintApiKey(orgId: string, name: string, createdBy?: string): Promise<{ id: string; value: string }>;
  /** List the org's (non-revoked) keys, obfuscated. */
  listApiKeys(orgId: string): Promise<ApiKeyInfo[]>;
  /** Revoke a key by id, scoped to the org (belongs-to check inside). */
  revokeApiKey(orgId: string, id: string): Promise<{ id: string; name: string } | null>;
  /** Revoke an API key by its raw value — for the RFC 7009 /oauth/revoke
   *  endpoint, where only the token (not the org/id) is known. Optional. */
  revokeApiKeyByToken?(token: string): Promise<boolean>;
  /** Create an org with NO associated user (auth.md `anonymous` registration).
   *  Optional — if absent, anonymous registration reports `anonymous_not_enabled`. */
  createAnonymousOrg?(opts: { name: string; metadata?: Record<string, string> }): Promise<{ orgId: string }>;

  // ── Optional metering-support methods (used by the metering + top-up engine).
  // They persist to the org's existing store (e.g. WorkOS org metadata) so no
  // separate database is required. Omit them if the consumer doesn't use
  // per-seat metering / top-up requests.

  /** Read the org's free-form metadata map (small key→string store). */
  getOrgMetadata?(orgId: string): Promise<Record<string, string>>;
  /** Merge a patch into the org metadata (null value = delete the key). */
  setOrgMetadata?(orgId: string, patch: Record<string, string | null>): Promise<void>;
  /** Whether a user is an admin/owner of the org (gates auto-top-up + approvals). */
  isAdmin?(orgId: string, userId: string): Promise<boolean>;
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

/** Build the `internalDomains` allowlist from the environment: an optional
 *  deployment root domain (whatever your host exposes — pass it if you want the
 *  deployment's own domain treated as internal) plus a comma-separated env var
 *  (default `INTERNAL_ORG_DOMAINS`). Orgs with a verified WorkOS domain matching
 *  any entry get unmetered access (see enforceTokens → isInternalOrg). Result is
 *  lowercased + de-duplicated. Host-agnostic: the caller supplies the root
 *  domain (or nothing); the env var is generic. */
export function internalDomainsFromEnv(
  rootDomain?: string | null,
  envVar = "INTERNAL_ORG_DOMAINS",
): string[] {
  const extras = (process.env[envVar] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const root = rootDomain?.trim().toLowerCase();
  return Array.from(new Set([...(root ? [root] : []), ...extras]));
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
