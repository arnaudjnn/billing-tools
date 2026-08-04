import { isLocalTaxOrigin, type LocalTaxOrigin } from "./tax-origins.js";

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
  tax?: TaxConfig;
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
/**
 * A third-party tax calculation, as an injected function.
 *
 * `mode: "external"` exists because the two built-in answers do not cover everyone:
 * `local` cannot compute US sales tax (no national rate exists), and Stripe Tax costs
 * 0.5% of every taxed transaction. A provider — Numeral, Anrok, Kintsugi, Vertex — sits
 * between them, and the calculation is INJECTED rather than built in so this package
 * keeps no network I/O and stays testable offline.
 *
 * **No adapter ships.** One did briefly, for Numeral, written from a docs summary
 * rather than the OpenAPI spec — and it could not have worked: the version header is
 * mandatory, `customer` / `origin_address` / `order_details` are all required, and the
 * response carries `total_tax_amount` rather than any rate field, so it would have
 * thrown on every call. Writing an adapter needs the provider's spec in front of you
 * and one real call against a sandbox. This type is the contract for doing that.
 *
 * Return `null` to mean "no tax applies", which is charged as untaxed. Throwing is
 * also honest — it refuses the charge rather than guessing, which is what this library
 * does everywhere else when it cannot answer.
 */
export type TaxCalculator = (input: {
  /** The Stripe customer the charge is for. */
  customerId: string;
  /** Destination, from the customer's Stripe address. */
  country?: string;
  state?: string | null;
  postalCode?: string | null;
  city?: string | null;
  line1?: string | null;
  /** The customer's tax id, if one is on file. Decides B2B treatment. */
  taxNumber?: string | null;
}) => Promise<TaxCalculation | null> | TaxCalculation | null;

// ── What this seam CANNOT do yet, stated so nobody rediscovers it ──────────────
//
// It passes a place of supply and expects a RATE back. That fits a rate-lookup
// service, and it does NOT fit the major providers: Numeral, Anrok and Stripe's own
// Tax API all take a BASKET (line items, quantities, currency) and return a tax
// AMOUNT, because the amount is what gets filed. Two things block wiring one here:
//
//   1. `taxFor(customerId, tax)` has no basket to pass. The charge sites all know it
//      — the Checkout Session, the auto-reload invoice, the top-up — so threading
//      `currency` + `lineItems` through is the change that unblocks this, and it is a
//      breaking signature change to an exported function on a money path.
//   2. A returned amount has to become a percentage to ride a Stripe TaxRate, and
//      that conversion can drift a cent from the provider's own figure — which is the
//      figure on their return.
//
// Until both are settled, `mode: "stripe"` is the supported answer for a US
// establishment: Stripe owns the calculation AND the invoice, so no conversion exists
// to be wrong. An adapter written against this seam today must be for a provider that
// answers with a rate.

/**
 * What a `TaxCalculator` answers. Applied as an explicit Stripe TaxRate.
 *
 * **A percentage, and that is an impedance mismatch worth knowing.** This library
 * applies tax as a Stripe `TaxRate`, which is a percentage of the line — but providers
 * return an AMOUNT (`total_tax_amount`), because that is what gets filed. Converting
 * amount → percent can drift a cent from the provider's own figure on some baskets, and
 * the provider's figure is the one on the return. If that matters for your volume, do
 * not use this seam: charge through a provider that writes the amount itself, or use
 * `mode: "stripe"`, where Stripe owns both the calculation and the invoice.
 */
export type TaxCalculation = {
  /** e.g. 8.875 for 8.875%. Zero is a valid answer and means no tax is due. */
  percent: number;
  /** What the invoice line says. Keep to 50 chars — Stripe's TaxRate limit. */
  displayName?: string;
  /** ISO country the rate belongs to, for the TaxRate object. */
  country?: string;
  /** True for a tax already included in the price. */
  inclusive?: boolean;
  /** Set where the customer accounts for the tax, so the invoice says so. */
  reverseCharge?: boolean;
};

/** Settings every tax mode shares. */
type TaxConfigCommon = {
  /**
   * Where you are registered to collect tax.
   *
   * The second input a rate needs and no dataset can supply. `origin` says where you
   * are established; this says where you took on an obligation, which is what decides
   * whether a sale is taxed at all.
   *
   * ```ts
   * registrations: [{ country: "IT" }, { country: "GB" }]     // VAT registrations
   * registrations: [{ country: "US", state: "CA" }]           // US nexus
   * ```
   *
   * **Undefined is "the caller did not say"**, never "registered nowhere": the regime
   * rules alone then decide, which is what every deployment predating this option
   * gets. Declared, there is ONE rule for everywhere including domestic — so `[]` says
   * something omitting it cannot, and is how a small-business exemption (France's
   * franchise en base, Germany's Kleinunternehmerregelung) is expressed: charge
   * nothing, anywhere.
   *
   * One obligation is deliberately not gated by it: destination VAT on a sale from
   * outside the EU to an EU consumer arises with no threshold to sit under.
   */
  registrations?: readonly { country: string; state?: string }[];
  /**
   * Mandatory invoice wording, per outcome.
   *
   * ```ts
   * notes: {
   *   exempt: "TVA non applicable, art. 293 B du CGI",
   *   reverseCharge: "Autoliquidation, art. 196 dir. 2006/112/CE",
   * }
   * ```
   *
   * Where a regime requires the invoice to state WHY a sale is untaxed, that mention
   * is not decoration: France fines €15 per invoice missing the 293 B wording, and the
   * CJEU held in C-247/21 that an omitted reverse-charge mention cannot be cured
   * afterwards. Supplying `exempt` mints a 0% Stripe TaxRate carrying it, so it renders
   * as a tax line on every invoice from every charge path. Supply nothing and an
   * untaxed sale carries no line, exactly as before.
   *
   * Stripe caps a TaxRate display name at 50 characters — the mention, not the
   * explanation.
   */
  notes?: { exempt?: string; reverseCharge?: string };
  /**
   * Are you registered for the EU One-Stop Shop? Default true. `local` only.
   *
   * Decides ONE case: a cross-border EU customer with no valid VAT number. Reverse
   * charge needs a valid id, so without one the sale is taxed somewhere — registered,
   * at the CUSTOMER's rate; not registered, at YOUR OWN, which is what the sub-€10 000
   * regime allows and the only rate you can remit without a foreign registration.
   */
  oss?: boolean;
  /**
   * Resolve the TaxRate ids yourself, e.g. from your own records.
   *
   * **Wins over `mode` when it returns any**, because the hook exists to be
   * authoritative — which also makes it the one place a setting can go quietly dead:
   * whatever this function does not account for is not applied, whatever the config
   * says. Prefer `mode: "external"` with a `calculate` for a third-party provider;
   * this is for per-ORG rates that `config.tax` cannot express.
   */
  rates?: (stripeCustomerId: string) => Promise<string[]> | string[];
  /**
   * Use Stripe Tax. Equivalent to `mode: "stripe"`, and ignored when `rates` returns
   * any (Stripe rejects manual rates and `automatic_tax` on one charge).
   *
   * Off unless set: a charge with neither is untaxed rather than quietly handed to
   * Stripe Tax, which without an active registration computes 0% and reports no error.
   */
  automatic?: boolean;
};

/**
 * WHO calculates tax, declared ONCE for the whole deployment.
 *
 * Every charge the library builds reads this — the seat Checkout Session, the
 * `buy_credits` top-up, the auto-reload invoice — so the answer to "does this account
 * charge VAT" lives in one place instead of at each call site. That per-site
 * arrangement is why the two charges with no form behind them once went out untaxed
 * while every seat invoice on the same account charged 22% IVA.
 *
 * **The union is what makes `origin: "US"` with the local mode impossible to write.**
 * The local engine has rates for 45 European countries and no others, so a US, AU, JP,
 * SG, CA, IN, BR or MX establishment cannot compute its own domestic tax here. That
 * used to typecheck and then throw on the first charge; it is now a compile error at
 * the config site, which is where the decision was made.
 */
export type TaxConfig = TaxConfigCommon &
  (
    | {
        /**
         * This library calculates, in process, from `eu-vat-rates-data` + VIES, and
         * applies the answer as an explicit Stripe TaxRate. The default.
         */
        mode?: "local";
        /**
         * Where YOU are established. Decides domestic vs cross-border, which is the
         * whole question a VAT rate turns on.
         *
         * Constrained to the countries the local engine has rates for. If yours is
         * absent — the US above all — that is a fact about published rate data, not an
         * omission: use `mode: "stripe"` or `mode: "external"`.
         *
         * Omitted, it falls back to the Stripe account's own country, and a fallback
         * the local engine cannot compute is caught at boot instead.
         */
        origin?: LocalTaxOrigin;
      }
    | {
        /** Stripe Tax (`automatic_tax`). 0.5% per taxed transaction, and it needs
         *  registrations — without one it returns ZERO tax rather than an error. */
        mode: "stripe";
        origin?: string;
      }
    | {
        /** A third-party provider, injected. See `TaxCalculator`. */
        mode: "external";
        origin?: string;
        /** Your provider. None ships — see the note on `TaxCalculator` for why, and
         *  for what it cannot reach yet. */
        calculate: TaxCalculator;
      }
    | {
        /** No tax on anything the library charges. Correct for an account that
         *  genuinely charges none, and something you write down rather than arrive at
         *  by omission. */
        mode: "none";
        origin?: string;
      }
  );

export type ResolvedConfig = Required<Omit<BillingConfig, "tax" | "paymentMethods">> &
  Pick<BillingConfig, "tax" | "paymentMethods">;


/** `taxModeOf` without importing tax.ts, which imports this file. Same precedence. */
function taxModeOfConfig(tax: TaxConfig | undefined): "local" | "stripe" | "external" | "none" {
  if (tax?.mode) return tax.mode;
  if (tax?.automatic) return "stripe";
  return "local";
}

export function resolveConfig(c: BillingConfig): ResolvedConfig {
  // The half the type system cannot reach.
  //
  // `TaxConfig` makes `{ mode: "local", origin: "US" }` a compile error, which covers
  // the case where the establishment is WRITTEN DOWN. It cannot cover the case where it
  // is inferred: omit `origin` and the local engine falls back to the Stripe account's
  // country, so a US Stripe account with no declared origin is a local-mode US seller
  // that typechecks perfectly and then refuses its first charge.
  //
  // A cast is also a way in — `origin: x as LocalTaxOrigin`, or a config assembled from
  // env strings. So the same rule is checked here, at boot, where it is loud and early and
  // where the stack points at the config rather than at a customer's checkout.
  const declared = c.tax && "origin" in c.tax ? c.tax.origin : undefined;
  if (declared && taxModeOfConfig(c.tax) === "local" && !isLocalTaxOrigin(declared)) {
    throw new Error(
      `config.tax.origin "${declared}" cannot be used with mode "local": this library ` +
        "has rates for 45 European countries and no others, so it cannot compute a " +
        `domestic rate for ${declared}. That is a fact about published rate data, not a ` +
        'gap — use `mode: "stripe"` (Stripe Tax, 0.5% per taxed transaction, and the ' +
        'supported answer for a US establishment), or `mode: "external"` with your own ' +
        "`calculate` if you have a provider that answers with a rate.",
    );
  }
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
