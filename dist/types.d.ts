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
    validateApiKey(token: string): Promise<{
        orgId: string;
    } | null>;
    /** Optional: resolve an OAuth bearer (JWT) → org id. Omit if no OAuth. */
    resolveOauthOrg?(token: string): Promise<string | null>;
    /** Verified domains for the org (used for the internal-org unmetered check). */
    getOrgDomains(orgId: string): Promise<string[]>;
    /** Read the Stripe customer id pointer for the org (null if none yet). */
    getBillingCustomerId(orgId: string): Promise<string | null>;
    /** Persist the Stripe customer id pointer for the org. */
    setBillingCustomerId(orgId: string, customerId: string): Promise<void>;
    /** After magic-auth: find or create the org/workspace for this user. */
    ensureOrgForUser(user: BillingUser): Promise<{
        orgId: string;
    }>;
    /** Mint a new API key for the org. `createdBy` (the acting user id) is
     *  passed when available; adapters that don't track it may ignore it.
     *  Returns the raw value (shown once). */
    mintApiKey(orgId: string, name: string, createdBy?: string): Promise<{
        id: string;
        value: string;
    }>;
    /** List the org's (non-revoked) keys, obfuscated. */
    listApiKeys(orgId: string): Promise<ApiKeyInfo[]>;
    /** Revoke a key by id, scoped to the org (belongs-to check inside). */
    revokeApiKey(orgId: string, id: string): Promise<{
        id: string;
        name: string;
    } | null>;
    /** Revoke an API key by its raw value — for the RFC 7009 /oauth/revoke
     *  endpoint, where only the token (not the org/id) is known. Optional. */
    revokeApiKeyByToken?(token: string): Promise<boolean>;
    /** Create an org with NO associated user (auth.md `anonymous` registration).
     *  Optional — if absent, anonymous registration reports `anonymous_not_enabled`. */
    createAnonymousOrg?(opts: {
        name: string;
        metadata?: Record<string, string>;
    }): Promise<{
        orgId: string;
    }>;
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
export declare function resolveConfig(c: BillingConfig): ResolvedConfig;
/** Build the `internalDomains` allowlist from the environment: an optional
 *  deployment root domain (whatever your host exposes — pass it if you want the
 *  deployment's own domain treated as internal) plus a comma-separated env var
 *  (default `INTERNAL_ORG_DOMAINS`). Orgs with a verified WorkOS domain matching
 *  any entry get unmetered access (see enforceTokens → isInternalOrg). Result is
 *  lowercased + de-duplicated. Host-agnostic: the caller supplies the root
 *  domain (or nothing); the env var is generic. */
export declare function internalDomainsFromEnv(rootDomain?: string | null, envVar?: string): string[];
export type ToolResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
};
export type ToolErrorResult = {
    isError: true;
    content: Array<{
        type: "text";
        text: string;
    }>;
};
//# sourceMappingURL=types.d.ts.map