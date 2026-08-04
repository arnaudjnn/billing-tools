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
  /**
   * Resolve a raw Bearer API key → org, or null if invalid/revoked.
   *
   * `keyId` is WHICH key was used, and it exists because dropping it here made a
   * documented capability impossible everywhere downstream. `MeterCaller.id` says
   * "API key id (api) — for per-caller attribution", but this seam returned only
   * the org, so `createApiMeterGuard` had nothing else to pass and sent the ORG id
   * instead: every metered API call recorded a `caller_id` that claimed to name a
   * key and named a workspace. No gate read it (an `api` caller's windows are
   * summed by KIND across the org, deliberately), so nothing was mis-charged — but
   * "which key burned the quota" was unanswerable for every consumer, and the
   * counter written under it looked like a member whose id happened to be a
   * workspace id.
   *
   * Optional, so an adapter that cannot tell keys apart stays source-compatible.
   * When it is absent the meter records NO caller id rather than a wrong one.
   */
  validateApiKey(token: string): Promise<{ orgId: string; keyId?: string } | null>;
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

  /**
   * The same store, for ONE MEMBER — where per-member records belong.
   *
   * The org map is a single shared budget (WorkOS: 600 chars per value), so a
   * per-member map packed into one of its values has a member ceiling. Measured,
   * that ceiling was 12: the 12th member's top-up grant overflowed the value and
   * the write failed. A record that is per-member is stored per-member instead,
   * where each one has a budget of its own and there is no ceiling.
   *
   * Optional, and the top-up engine falls back to the org map when it is absent —
   * so an existing adapter keeps working, with that ceiling.
   */
  getUserMetadata?(userId: string): Promise<Record<string, string>>;
  /** Merge a patch into a member's metadata (null value = delete the key). */
  setUserMetadata?(userId: string, patch: Record<string, string | null>): Promise<void>;

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
    /** PURCHASED seat quantity, summed across seat types. Sizes a `cap.perSeat`
     *  pool. Purchased rather than active, because a workspace that bought ten
     *  seats and filled six paid for ten; when it is absent the active member
     *  count is used instead. */
    seats?: number | null;
    /** The same quantity broken down by seat type. Required by
     *  `cap.perSeat: "included"`, which multiplies each tier by its OWN
     *  `includedCredits` — the only form that can size a pool for a plan with more
     *  than one tier. The total above is its sum. */
    seatCounts?: Record<string, number> | null;
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
  /** Active member ids. Needed by any read that must ENUMERATE a per-member
   *  record (`listSeatAssignments`), because a per-member store can be asked
   *  about a member but cannot be asked who the members are. */
  listMemberIds?(orgId: string): Promise<string[]>;
  /** Whether a user is an admin/owner of the org (gates auto-top-up + approvals). */
  isAdmin?(orgId: string, userId: string): Promise<boolean>;
}

export interface BillingConfig {
  /** Welcome credit granted on first Stripe customer creation. Default 100. */
  freeCredits?: number;
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
   * WHO calculates tax, declared ONCE for the whole deployment.
   *
   * Every charge the library builds reads this — the seat Checkout Session, the
   * `buy_credits` top-up, and the auto-reload invoice — so the answer to "does
   * this account charge VAT" lives in one place instead of at each call site. An
   * explicit `taxRates` / `automaticTax` argument at a call site still wins.
   *
   * That per-site arrangement is why the two charges with no form behind them (the
   * auto-reload and the top-up) went out untaxed while every seat invoice on the
   * same account charged 22% IVA: nothing was wrong at any one site, there was
   * simply no single place that said what the account does.
   */
  tax?: {
    /**
     * Where YOU are established, as an ISO country code ("IT", "FR", "US").
     *
     * Setting it selects `mode: "local"` — the library works the rate out
     * itself (`eu-vat-rates-data` + VIES) from the customer's address and tax id, and
     * applies it as an explicit Stripe TaxRate. It decides domestic vs
     * cross-border, which is the whole question a VAT rate turns on, so there is
     * nothing else to configure.
     */
    origin?: string;
    /** Override the mode `origin` / `automatic` imply. See `TaxMode`. */
    mode?: "local" | "stripe" | "none";
    /**
     * Where you are registered to collect tax, under `mode: "local"`.
     *
     * The second input a rate needs and no dataset can supply. `origin` says where
     * you are established; this says where you have taken on an obligation, which is
     * what actually decides whether a sale is taxed at all.
     *
     * **Undefined is "the caller did not say"**, never "registered nowhere": the
     * regime rules alone then decide (your domestic sales, plus the EU cross-border
     * rules), which is what every deployment predating this option already gets.
     * Declaring it switches to one rule for everywhere, domestic included — tax is
     * due where you say you are registered and nowhere else — so `[]` is a real
     * statement and not the same as omitting it.
     *
     * ```ts
     * // An Italian seller who also holds a UK registration.
     * registrations: [{ country: "IT" }, { country: "GB" }]
     * // A US seller with nexus in two states, and none anywhere else.
     * registrations: [{ country: "US", state: "CA" }, { country: "US", state: "TX" }]
     * ```
     *
     * This is what makes a US destination answerable rather than a refusal: post-
     * Wayfair you must NOT collect in a state until you have nexus there, so for the
     * common case — no registration — 0% is the complete and correct answer, needing
     * no flag to permit it. Where you ARE registered, the charge still refuses,
     * because this library has no US rate; that is what `mode: "stripe"` is for.
     *
     * One obligation is deliberately not gated by it: destination VAT on a sale from
     * outside the EU to an EU consumer arises with no threshold to sit under, so an
     * empty list cannot wish it away.
     */
    registrations?: readonly { country: string; state?: string }[];
    /**
     * Are you registered for the EU One-Stop Shop? Default true.
     *
     * It decides ONE case: a cross-border EU customer with no valid VAT number.
     * Reverse charge needs a valid id, so without one the sale is taxed somewhere —
     * registered, at the CUSTOMER's rate; not registered, at YOUR OWN, which is what
     * the sub-€10 000 regime allows and the only rate you can remit without a
     * foreign registration.
     *
     * Set `false` if you sell B2B and are not OSS-registered: an EU business that
     * cannot produce a valid id (below its own registration threshold, a typo, or
     * VIES unreachable — where this library charges rather than exempts) would
     * otherwise be billed its country's VAT, which you would have collected with
     * nowhere to pay it over.
     *
     * Domestic sales, valid-id reverse charge and non-EU sales are all unaffected.
     */
    oss?: boolean;
    /**
     * Resolve the TaxRate ids yourself, e.g. from your own records. Wins over
     * `mode` when it returns any — the hook exists to be authoritative.
     */
    rates?: (stripeCustomerId: string) => Promise<string[]> | string[];
    /**
     * Use Stripe Tax. Equivalent to `mode: "stripe"`, and ignored when `rates`
     * returns any (Stripe rejects both on one charge).
     *
     * Off unless set, everywhere: a charge with neither is untaxed rather than
     * quietly handed to Stripe Tax, which without an active registration
     * computes 0% and reports no error.
     */
    automatic?: boolean;
  };
  /** What the payment forms offer. See `defaultPaymentMethodConfig`. */
  paymentMethods?: {
    /**
     * Offer Stripe Link. Default FALSE, and that default is the whole point:
     * Link's inline signup ("Save my info for faster checkout") is drawn by the
     * Payment Element from the ACCOUNT's Link setting, so it survives both
     * `wallets.link: "never"` and `payment_method_types: ["card"]`. The only
     * lever is a payment-method configuration, which the library now provisions
     * itself rather than leaving every app to discover this.
     *
     * Set `true` to keep Stripe's behaviour (no configuration is imposed).
     */
    link?: boolean;
  };
}

// `tax` and `paymentMethods` stay optional: they are "unset means Stripe's own
// behaviour", which is not a value `resolveConfig` can invent.
export type ResolvedConfig = Required<Omit<BillingConfig, "tax" | "paymentMethods">> &
  Pick<BillingConfig, "tax" | "paymentMethods">;

export function resolveConfig(c: BillingConfig): ResolvedConfig {
  return {
    freeCredits: c.freeCredits ?? 100,
    currency: c.currency ?? "usd",
    baseUrl: c.baseUrl,
    internalDomains: c.internalDomains ?? [],
    defaultLocale: c.defaultLocale ?? "",
    tax: c.tax,
    paymentMethods: c.paymentMethods,
  };
}

/** Build the `internalDomains` allowlist from the environment: an optional
 *  deployment root domain (whatever your host exposes — pass it if you want the
 *  deployment's own domain treated as internal) plus a comma-separated env var
 *  (default `INTERNAL_ORG_DOMAINS`). Orgs with a verified WorkOS domain matching
 *  any entry get unmetered access (see enforceCredits → isInternalOrg). Result is
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
