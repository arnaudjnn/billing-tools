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

  // Subscription state + seat count. The billing-sync engine relies on these,
  // but they were only ever declared on the concrete WorkOSOrgAdapter — so an
  // app holding the seam type had no way to READ what the engine had written,
  // and wrote its own metadata reader instead (a consumer had one). Optional,
  // because an adapter with no org-metadata store legitimately has none.

  /** Subscription state as the sync engine records it. */
  getSubscription?(orgId: string): Promise<{
    plan: string | null;
    status: string | null;
    subscriptionId: string | null;
    /** Start of the current period. An included allowance is measured over the
     *  SUBSCRIPTION window, not the calendar month — an annual package measured
     *  monthly would reset twelve times a year. */
    periodStart?: string | null;
    periodEnd: string | null;
  }>;
  /** Record subscription state. `plan: undefined` leaves the plan as-is; `null`
   *  clears it (back to the default plan). */
  setSubscription?(
    orgId: string,
    sub: {
      plan?: string | null;
      status: string | null;
      subscriptionId: string | null;
      periodStart?: string | null;
      periodEnd: string | null;
    },
  ): Promise<void>;
  /** Active members, for per-seat grants and seat limits. */
  memberCount?(orgId: string): Promise<number>;
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
  /**
   * Language new customers get their invoices in, as a BCP-47 code.
   *
   * Stripe's own fallback is English, which is wrong for a product sold in one
   * country: a settings screen showing "Italian" as the default while Stripe
   * mails English invoices is a lie the user only discovers on the first
   * invoice. Setting it at customer creation makes the default real.
   *
   * Existing customers are untouched — this is a default, not a migration.
   * Default: unset, i.e. Stripe's English.
   */
  defaultLocale?: string;
  /**
   * How to tax the charges the library raises on its OWN initiative — today the
   * auto-reload invoice, which no form precedes.
   *
   * A subscription is taxed by whoever builds its Checkout Session, which is the
   * app. An auto-reload has no session and no address form: it fires from the
   * meter, so the only way for it to carry the same VAT as everything else the
   * account bills is for the deployment to say here how to work the rate out.
   * Leave unset only on an account that charges no tax at all — `checkBillingSetup`
   * warns when a taxed account is auto-reloading untaxed.
   */
  tax?: {
    /** Stripe TaxRate ids for this customer, e.g. from `taxRatesFor`. */
    rates?: (stripeCustomerId: string) => Promise<string[]> | string[];
    /** Use Stripe Tax instead. Ignored when `rates` returns any. */
    automatic?: boolean;
  };
}

export type ResolvedConfig = Required<Omit<BillingConfig, "tax">> & Pick<BillingConfig, "tax">;

export function resolveConfig(c: BillingConfig): ResolvedConfig {
  return {
    freeTokens: c.freeTokens ?? 100,
    currency: c.currency ?? "usd",
    baseUrl: c.baseUrl,
    internalDomains: c.internalDomains ?? [],
    defaultLocale: c.defaultLocale ?? "",
    tax: c.tax,
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
