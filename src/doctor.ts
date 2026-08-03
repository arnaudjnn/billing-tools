import { getStripe } from "./billing.js";
import { getWorkOS } from "./workos.js";
import {
  ledgerGaps,
  normalizePlans,
  poolSizeOf,
  type LedgerCoverage,
  type PlanCatalog,
} from "./plan-model.js";
import { USAGE_SCOPE_KIND } from "./usage-scopes.js";
import { BILLING_WEBHOOK_EVENTS } from "./webhook-setup.js";
import { taxModeOf, type TaxMode } from "./tax.js";
import type { BillingConfig } from "./types.js";

// Preflight for a billing environment: the checks that catch the failures which
// DON'T announce themselves.
//
// Every item here is a trap that costs real money or real time and produces no
// error when it fires — Stripe Tax quietly computing zero because no
// registration exists, a price left `tax_behavior: unspecified` so tax can't be
// calculated at all, two endpoints on one URL doubling delivery, an endpoint
// missing invoice.paid so per-cycle grants never happen. Each was found the
// expensive way; this is where that knowledge lives so the next environment
// doesn't repeat it.
//
// Read-only. Run it per environment — the secret key decides which one.

export type CheckLevel = "ok" | "warn" | "error";

export type Check = {
  level: CheckLevel;
  title: string;
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
};

export type DoctorResult = {
  livemode: boolean;
  checks: Check[];
  /** True when no check failed at `error`. */
  healthy: boolean;
};

/**
 * Inspect a Stripe environment for the misconfigurations that fail silently.
 *
 * @param webhookUrl - the endpoint you expect to be registered. Omit to skip the
 *   webhook checks (correct for a local machine, which has none by design).
 */
export async function checkBillingSetup(opts: {
  webhookUrl?: string;
  /**
   * WHO calculates tax on this account — a choice the deployment makes, so it is
   * named after the thing doing the calculating rather than after how it feels:
   *
   * - `"local"` (default) — this library: `taxRatesFor` derives the rate
   *   from `sales-tax` + VIES and applies it as an explicit Stripe TaxRate. No
   *   per-transaction fee, and nothing to set up in the Dashboard. Same spelling
   *   Named for WHERE the calculation happens, not for how it feels — and
   *   deliberately not `"auto"`, because Stripe's own field is `automatic_tax`, so
   *   `"auto"` would name this mode after the one it is the alternative to.
   * - `"stripe"` — Stripe Tax (`automatic_tax`), for an account that wants
   *   evidence-of-location, threshold monitoring and filing handled.
   * - `"none"` — an account that charges no tax; tax is not inspected.
   *
   * It decides WHICH silent failure is worth looking for, so the wrong mode is
   * worse than no check: `"stripe"` audits the head office, the registrations and
   * `tax_behavior`, none of which a `"local"` account has any reason to
   * hold — reporting those as errors is how a doctor sends someone to fix a config
   * that was already right.
   */
  taxMode?: TaxMode;
  /**
   * Your `BillingConfig`, so the mode is read from `config.tax` rather than stated
   * again here — the point of one declaration is that nothing can disagree with it.
   * `taxMode` and `currency` above still win if passed.
   */
  config?: BillingConfig;
  /** @deprecated Use `taxMode`. `false` → `"none"`, `true` → `"stripe"`. */
  expectTax?: boolean;
  /** `config.currency`. Pass it to check for customers pinned to another one —
   *  the half-applied currency change that produces no error anywhere. */
  currency?: string;
  /** Flag customers with more than one ACTIVE subscription (double billing).
   *  Default true. */
  expectSingleSubscription?: boolean;
} = {}): Promise<DoctorResult> {
  const stripe = getStripe();
  const checks: Check[] = [];
  // Explicit wins, then the config's own declaration, then the deprecated boolean.
  // The final default is `"local"` rather than `"none"` so a caller that
  // passes nothing still gets its rates listed — a doctor that inspected no tax by
  // default would be silent on the account most likely to have got it wrong.
  const taxMode: TaxMode =
    opts.taxMode ??
    (opts.config ? taxModeOf(opts.config.tax) : undefined) ??
    (opts.expectTax === undefined ? "local" : opts.expectTax ? "stripe" : "none");
  const currency = opts.currency ?? opts.config?.currency;

  const account = await stripe.accounts.retrieve();
  const livemode = !(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test");
  checks.push({
    level: "ok",
    title: "Stripe account",
    detail: `${account.id} (${account.country ?? "?"}) — ${livemode ? "LIVE" : "test"} mode`,
  });

  if (taxMode === "local") {
    // `taxRatesFor` mints a TaxRate per (country, percent, name) on first use and
    // reuses it forever, so the account accumulates a handful. Nothing to provision,
    // and nothing here can be an error: a fresh account legitimately holds none
    // until the first taxed checkout. What IS worth saying is which rates exist,
    // because that is the whole audit trail of what this account has charged.
    const rates = (await stripe.taxRates.list({ active: true, limit: 100 })).data;
    checks.push({
      level: "ok",
      title: "Tax calculation",
      detail: rates.length
        ? `billing-tools (taxRatesFor): ${rates
            .slice(0, 8)
            .map((r) => `${r.country ?? "?"} ${r.percentage}%${r.inclusive ? " incl" : ""}`)
            .join(", ")}`
        : "billing-tools (taxRatesFor) — no rate minted yet; the first taxed checkout creates one",
    });
  }

  if (taxMode === "stripe") {
    // The silent one: with no registration Stripe Tax returns ZERO tax rather
    // than an error, so the checkout total simply drops to the pre-tax amount.
    const settings = await stripe.tax.settings.retrieve();
    const registrations = await stripe.tax.registrations.list({ status: "active", limit: 100 });
    const active = registrations.data.map((r) => r.country);

    checks.push(
      settings.status === "active"
        ? { level: "ok", title: "Stripe Tax settings", detail: "active" }
        : {
            level: "error",
            title: "Stripe Tax settings",
            detail: `status=${settings.status}, missing: ${
              settings.status_details?.pending?.missing_fields?.join(", ") || "unknown"
            }`,
            fix: "Set the head office: stripe.tax.settings.update({ head_office: { address: { country } } })",
          },
    );

    checks.push(
      active.length
        ? { level: "ok", title: "Tax registrations", detail: active.join(", ") }
        : {
            level: "error",
            title: "Tax registrations",
            detail: "none active — Stripe Tax will compute ZERO tax, silently",
            fix: "Register each jurisdiction you collect in: Dashboard → Tax → Registrations (per mode)",
          },
    );

    // `unspecified` is refused by Stripe Tax, and the account default
    // `inferred_by_currency` reads EUR as tax-INCLUSIVE — which turns a
    // "€X + VAT" price into "€X including VAT" without any error.
    const prices = await stripe.prices.list({ active: true, limit: 100 });
    const managed = prices.data.filter((p) => p.metadata?.managedBy === "billing-tools");
    const unspecified = managed.filter((p) => p.tax_behavior === "unspecified");
    checks.push(
      unspecified.length === 0
        ? {
            level: "ok",
            title: "Price tax_behavior",
            detail: `${managed.length} managed price(s), all specified`,
          }
        : {
            level: "error",
            title: "Price tax_behavior",
            detail: `${unspecified.length} managed price(s) are 'unspecified': ${unspecified
              .map((p) => p.lookup_key ?? p.id)
              .join(", ")}`,
            fix: "Run ensurePlans() — it backfills tax_behavior on existing prices",
          },
    );
  }

  if (opts.webhookUrl) {
    const all = (await stripe.webhookEndpoints.list({ limit: 100 })).data;
    const matches = all.filter((e) => e.url === opts.webhookUrl);

    if (matches.length === 0) {
      checks.push({
        level: "error",
        title: "Webhook endpoint",
        detail: `nothing registered for ${opts.webhookUrl}`,
        fix: "ensureWebhookEndpoint({ url }) — payments are delivered by webhook",
      });
    } else {
      const missing = BILLING_WEBHOOK_EVENTS.filter(
        (e) => !matches[0].enabled_events.includes(e) && !matches[0].enabled_events.includes("*"),
      );
      checks.push(
        missing.length === 0
          ? { level: "ok", title: "Webhook events", detail: BILLING_WEBHOOK_EVENTS.join(", ") }
          : {
              level: "error",
              title: "Webhook events",
              detail: `endpoint is missing: ${missing.join(", ")}`,
              fix: "ensureWebhookEndpoint({ url }) adds them without removing your own",
            },
      );
      checks.push(
        matches[0].status === "enabled"
          ? { level: "ok", title: "Webhook status", detail: "enabled" }
          : {
              level: "error",
              title: "Webhook status",
              detail: `endpoint is ${matches[0].status} — Stripe disables endpoints after ~3 days of failures`,
              fix: "Fix the failures, then re-enable it in the Dashboard",
            },
      );
      if (matches.length > 1) {
        checks.push({
          level: "warn",
          title: "Duplicate endpoints",
          detail: `${matches.length} endpoints share this URL; Stripe delivers to every one`,
          fix: "ensureWebhookEndpoint({ url, pruneDuplicates: true })",
        });
      }
    }

    checks.push(
      process.env.STRIPE_WEBHOOK_SECRET
        ? { level: "ok", title: "Signing secret", detail: "STRIPE_WEBHOOK_SECRET is set" }
        : {
            level: "error",
            title: "Signing secret",
            detail: "STRIPE_WEBHOOK_SECRET is unset — deliveries will be rejected with 503",
            fix: "Take it from ensureWebhookEndpoint's output, or from `stripe listen` when developing",
          },
    );
  }

  // ── Customers pinned to a different currency ──────────────────────────────
  //
  // `customer.currency` is set by whatever first touched the customer (for this
  // library, the welcome credit) and cannot be changed afterwards. Stripe still
  // accepts balance transactions in any currency, keeping a separate running
  // balance per one — so a customer pinned to the old currency keeps reporting
  // the old balance from `customer.balance` while new debits accumulate in the
  // configured currency. Nothing errors. That silence is the reason this check
  // exists: it is the one way to see a currency change half-applied.
  // Counted during the customer sample below, so the US-exposure check costs no
  // extra requests. Declared out here because the sample is inside `if (currency)`
  // and the check is not.
  let usCustomers = 0;
  if (currency) {
    const want = currency.toLowerCase();
    const sample: string[] = [];
    // Auto-reload charges a card off-session. Enabled with no card on file, it
    // silently does nothing every time the balance runs out — the customer is
    // simply blocked, with no failure anywhere to explain why.
    const reloadNoCard: string[] = [];
    let seen = 0;
    // Objects EXAMINED, not counted. The two differ once `stripeScopeUsageLedger`
    // is wired: a deployment with many members has more usage-scope customers than
    // real ones, and they are the most recently created, so they sit at the front
    // of this list. Bounding only `seen` would page through every one of them —
    // 100 per request — before the sample filled. The doctor is a preflight; it
    // must cost a bounded number of requests whatever the account looks like.
    let scanned = 0;
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      if (++scanned > 2_000) break;
      // A per-caller usage scope is a COUNTER wearing a customer's shape
      // (`stripeScopeUsageLedger`): it buys nothing, is never invoiced and has no
      // currency to be pinned to. Counting them would dilute the ratio below.
      if (customer.metadata?.bt_kind === USAGE_SCOPE_KIND) continue;
      seen++;
      if (customer.currency && customer.currency !== want) {
        if (sample.length < 5) sample.push(`${customer.id} (${customer.currency})`);
      }
      // WHERE THE CUSTOMER IS, not where we are. Tax is owed at the place of
      // supply, so a French seller with US customers has US exposure and a US
      // seller with only EU customers has none — the earlier version of this check
      // keyed off `config.tax.origin` and had it exactly backwards.
      if (customer.address?.country?.toUpperCase() === "US") usCustomers++;
      if (customer.metadata?.auto_reload_enabled === "true" && reloadNoCard.length < 5) {
        const pms = await stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 });
        if (pms.data.length === 0) reloadNoCard.push(customer.id);
      }
      // A sample is enough to answer "is this environment mixed?" — walking
      // every customer of a live account is not what a preflight should do.
      if (seen >= 500) break;
    }
    if (reloadNoCard.length) {
      checks.push({
        level: "warn",
        title: "Auto-reload with no card",
        detail:
          `${reloadNoCard.length} customer(s) have auto-reload enabled but no saved card: ${reloadNoCard.join(", ")}. ` +
          "Each recharge attempt returns without charging, so they are blocked at zero balance with no error",
        fix: "Have them add a card (get_billing_portal), or turn auto-reload off so the refusal is honest",
      });
    }
    checks.push(
      sample.length === 0
        ? {
            level: "ok",
            title: "Customer currency",
            detail: `every customer sampled (${seen}) is pinned to ${want} or unpinned`,
          }
        : {
            level: "warn",
            title: "Customer currency",
            detail:
              `${sample.length === 5 ? "at least 5" : sample.length} of ${seen} customers are pinned to another currency ` +
              `than the configured ${want}: ${sample.join(", ")}`,
            fix:
              "A pinned currency cannot be changed. Their credit balance lives in the OLD currency while new " +
              "debits go to the new one, so read balances with getCreditBalance(id, config.currency) (the default " +
              "since 0.52) and migrate live subscriptions with migrateSubscriptions() — or keep those customers " +
              "on the old currency deliberately",
          },
    );
  }

  // ── US customers under local calculation ───────────────────────────────────
  //
  // Keyed on WHERE THE CUSTOMER IS, not where we are. Tax is owed at the place of
  // supply, so a French seller with US customers has US exposure and a US seller
  // with only EU customers has none. The first version of this check read
  // `config.tax.origin` and had it exactly backwards — it would have stayed silent
  // for the one deployment that needed it.
  //
  // It is a WARNING, not an error: whether those customers are actually taxable
  // depends on economic-nexus thresholds per state (commonly ~$100k or 200
  // transactions), which no local dataset knows. What the doctor can say is that
  // the exposure exists and the rate this mode would apply is state-level only.
  if (taxMode === "local" && usCustomers > 0 && !opts.config?.tax?.allowApproximate) {
    checks.push({
      level: "warn",
      title: "US customers under local tax calculation",
      detail:
        `${usCustomers} customer(s) sampled have a US address, and charges to them will THROW ` +
        "rather than go out under-taxed (state-level rates only: Illinois 6.25% vs Chicago ~10.25%)",
      fix:
        'Use `tax: { mode: "stripe" }` if you have crossed a state\'s economic-nexus threshold — ' +
        "no free dataset resolves the 13 000+ US local jurisdictions. Set `allowApproximate: true` " +
        "only if you have decided the state rate is close enough, or `mode: \"none\"` if you are not " +
        "registered anywhere in the US",
    });
  }

  // ── More than one live subscription per customer ───────────────────────────
  //
  // Belongs here for the file's stated reason: it costs real money and produces
  // no error. A flow that opens a fresh Checkout Session for every plan or seat
  // change leaves the previous subscription running — the customer is billed
  // twice, both subscriptions renew, and the app's own pointer names only one of
  // them, so nothing downstream notices.
  if (opts.expectSingleSubscription ?? true) {
    const perCustomer = new Map<string, number>();
    let scanned = 0;
    for await (const sub of stripe.subscriptions.list({ status: "active", limit: 100 })) {
      const id = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      perCustomer.set(id, (perCustomer.get(id) ?? 0) + 1);
      if (++scanned >= 500) break;
    }
    const doubled = [...perCustomer.entries()].filter(([, n]) => n > 1);
    checks.push(
      doubled.length === 0
        ? {
            level: "ok",
            title: "One subscription per customer",
            detail: `${scanned} active subscription(s), none doubled up`,
          }
        : {
            level: "error",
            title: "One subscription per customer",
            detail:
              `${doubled.length} customer(s) have more than one ACTIVE subscription and are being ` +
              `billed twice: ${doubled.slice(0, 5).map(([c, n]) => `${c} (${n})`).join(", ")}`,
            fix:
              "Reconcile with findDuplicateSubscriptions(), and route every plan/seat change through " +
              "one entry point that UPDATES the live subscription instead of opening a second one",
          },
    );
  }

  // ── Top-ups sold untaxed by an account that taxes everything else ─────────
  //
  // Both charges the library can raise without a form behind them — the
  // `buy_credits` Checkout and the auto-reload invoice — were untaxed, so a
  // seller charging 22% on its seats charged 0% on a top-up bought through the
  // same account. Detected by comparing what the recent invoices actually did.
  {
    let taxed = 0;
    let untaxedTopUps: string[] = [];
    for await (const inv of stripe.invoices.list({ limit: 100, status: "paid" })) {
      const hasTax = (inv.total_taxes ?? []).length > 0 || (inv.default_tax_rates ?? []).length > 0;
      if (hasTax) taxed++;
      const isTopUp =
        inv.metadata?.auto_reload === "true" ||
        inv.lines.data.some((l) => /credit/i.test(l.description ?? ""));
      if (isTopUp && !hasTax && untaxedTopUps.length < 5) untaxedTopUps.push(inv.id ?? "(unknown)");
      if (taxed > 0 && untaxedTopUps.length >= 5) break;
    }
    if (taxed > 0 && untaxedTopUps.length) {
      checks.push({
        level: "error",
        title: "Top-ups invoiced without tax",
        detail:
          `this account charges tax on other invoices, but ${untaxedTopUps.length} credit/auto-reload ` +
          `invoice(s) carry none: ${untaxedTopUps.join(", ")}`,
        fix:
          "Pass `topUp.taxRates` to registerBillingTools for buy_credits, and `config.tax.rates` for the " +
          "auto-reload invoice — neither has an address form to derive a rate from on its own",
      });
    }
  }

  return { livemode, checks, healthy: !checks.some((c) => c.level === "error") };
}

/**
 * Inspect a plans config for the mistakes that don't announce themselves.
 *
 * Static: no Stripe call, so it can run in CI next to a typecheck. Separate from
 * `checkBillingSetup` because it asks about the CONFIG rather than the account.
 */
export function checkPlansConfig(
  plans: PlanCatalog,
  options?: {
    /** Whether this deployment can actually sell a plan. Pass true when a
     *  checkout is mounted; without it, self-serve plans are flagged as
     *  advertised-but-unbuyable. */
    hasCheckout?: boolean;
    /**
     * What the wired ledger can count.
     *
     * Pass the ledger's own `covers` (every implementation here declares one) —
     * or `true`/`false` for the older shorthand, which meant "a per-member store
     * is wired". The coverage form is strictly better because it catches the case
     * the boolean cannot express: a ledger that counts per-member usage but not
     * ORG-wide included usage, which reads 0% on a pooled plan forever.
     *
     * OMIT it and the check is skipped entirely: undefined means "the caller did
     * not say", which is not the same as "nothing is wired". Defaulting it to
     * false would fail every existing consumer's CI over a config that may be
     * perfectly wired, and `createMeter` already warns at boot when it really is
     * missing. Only a plan that includes usage or rate-limits it needs one.
     */
    usageLedger?: boolean | LedgerCoverage;
  },
): DoctorResult {
  const checks: Check[] = [];
  const models = normalizePlans(plans);

  // Which included windows the wired ledger can actually count — the same question
  // `warnLedgerGaps` answers at boot, through the same `ledgerGaps`, because a
  // doctor that disagreed with the engine would send someone to fix a config that
  // was already right. An ERROR here where the engine warns: a warning in a deploy
  // log is missable, and a month of unenforced caps can't be recovered afterwards.
  //
  // The boolean shorthand keeps its old meaning (a per-member store is wired /
  // isn't), and says nothing about the org axis — which the default composite
  // covers anyway. Passing the ledger's `covers` is what catches the other half.
  if (options?.usageLedger !== undefined) {
    const covers: LedgerCoverage =
      typeof options.usageLedger === "boolean"
        ? { orgIncluded: true, callerIncluded: options.usageLedger }
        : options.usageLedger;
    const { org, caller } = ledgerGaps(models, covers);
    for (const [gap, detail, fix] of [
      [
        org,
        "include usage ORG-WIDE (a pool, or an org-scoped rate limit), which this ledger cannot count: it only sees calls the wallet paid for",
        'Use the default `stripeUsageLedger()` — it counts these on a Stripe meter at any volume, with no store.',
      ],
      [
        caller,
        "meter an INCLUDED window PER MEMBER (a seat pack, or a caller-scoped rate limit), which no Stripe primitive can count",
        "Pass `meter.db` (a Postgres client) or `meter.ledger` to createBilling, and run " +
          "ensureUsageLedgerTable(db) from your migrations. Or pool the allowance instead " +
          '(`cap: { kind: "pool", perSeat: N }`), which is counted in Stripe and needs no store.',
      ],
    ] as const) {
      if (!gap.length) continue;
      checks.push({
        level: "error",
        title: "Usage ledger",
        detail: `plans ${gap.map((m) => m.key).join(", ")} ${detail} — that usage counts as 0, so the window never applies and nothing is ever refused`,
        fix,
      });
    }
    if (!org.length && !caller.length) {
      checks.push({
        level: "ok",
        title: "Usage ledger",
        detail: "every included window in this config is countable by the wired ledger",
      });
    }
  }

  for (const m of models) {
    // The defect this release exists to fix: crediting an allowance discounts the
    // invoice that allowance came with.
    const invoiced = m.sells.kind !== "nothing";
    if (invoiced && m.grant.kind !== "none") {
      checks.push({
        level: "error",
        title: `Plan "${m.key}" credits its own invoice`,
        detail:
          `it is invoiced (${m.sells.kind}) AND GRANTS credits (grant: ${m.grant.kind}). A Stripe credit ` +
          "balance auto-applies to the next invoice, so this discounts the plan's own renewal — measured " +
          "at ~48% off a seat whose pack was one month's credits",
        fix:
          "Set `grant: { kind: \"none\" }` and express the included allowance as a `cap` (per_seat or pool), " +
          "which is counted rather than credited. Keep `grant` only for a plan that literally sells credit",
      });
    }
    // Rate limits: the two ways a plausible-looking declaration silently refuses
    // everything, and the one way a set of them contradicts itself.
    for (const l of m.limits.rate) {
      if (l.credits <= 0) {
        checks.push({
          level: "error",
          title: `Plan "${m.key}" has a zero ${l.every} limit`,
          detail: `a rate limit of ${l.credits} refuses every call in that window`,
          fix: "Set `credits` above 0, or drop the limit",
        });
      }
      if ((l.scope ?? "org") === "org" && l.seatType) {
        checks.push({
          level: "warn",
          title: `Plan "${m.key}" scopes an org limit to a seat type`,
          detail: `the ${l.every} limit sets \`seatType: ${l.seatType}\` but its scope is org-wide, so the seat type is ignored`,
          fix: 'Add `scope: "caller"`, or remove `seatType`',
        });
      }
    }
    // A wider window that is no larger than a narrower one can never be reached:
    // the narrow one refuses first, every time. This catches "300 a week" sitting
    // under "1000 a day".
    //
    // Only limits that can apply to the SAME caller are compared. Two limits with
    // different scopes, or on different seat types, never meet — an hourly cap on
    // the shared API seat does not shadow a weekly cap on a person's, and
    // comparing them was a false positive on a perfectly good config.
    const lengths: Record<string, number> = { hour: 1, day: 2, week: 3, month: 4, cycle: 5 };
    const groups = new Map<string, typeof m.limits.rate[number][]>();
    for (const l of m.limits.rate) {
      const key = `${l.scope ?? "org"}:${l.seatType ?? ""}:${l.callerKind ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => lengths[a.every] - lengths[b.every]);
      for (let i = 1; i < sorted.length; i++) {
        const narrow = sorted[i - 1];
        const wide = sorted[i];
        if (wide.credits <= narrow.credits) {
          checks.push({
            level: "warn",
            title: `Plan "${m.key}" has an unreachable ${wide.every} limit`,
            detail:
              `the ${wide.every} limit (${wide.credits}) is no larger than the ${narrow.every} one ` +
              `(${narrow.credits}) on the same callers, so the ${narrow.every} window always refuses first`,
            fix: `Raise the ${wide.every} limit above the ${narrow.every} one, or drop one of them`,
          });
        }
      }
    }
    // "Pay as you go" has to be fundable. A plan that falls through to the wallet
    // when its window runs out — or has no window at all — refuses every call past
    // that point unless the customer can put money in, so the claim and the
    // capability have to travel together.
    const covers =
      m.cap.kind === "per_seat" || m.cap.kind === "pool" ? (m.cap.covers ?? "all") : "all";
    const overflows =
      m.cap.kind === "wallet" ||
      // `covers: "users"` puts every machine caller on the wallet from its first
      // call, so the wallet is not a fallback there, it is the only funding an
      // agent has.
      covers === "users" ||
      ((m.cap.kind === "per_seat" || m.cap.kind === "pool") && m.cap.onExhausted === "wallet");
    if (overflows && !m.replenish.purchase && !m.replenish.autoReload) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" overflows to a wallet it cannot fill`,
        detail:
          m.cap.kind === "wallet"
            ? "the wallet is its only gate, but the plan offers no way to buy credits"
            : covers === "users"
              ? 'its cap covers people only (`covers: "users"`), so every API key and agent is funded by the ' +
                "wallet from its FIRST call — and the plan offers no way to buy credits"
              : 'its cap falls through to the wallet (`onExhausted: "wallet"`), but the plan offers no way to buy credits',
        fix:
          covers === "users"
            ? "Add `replenish: { purchase: {} }` (and/or `autoReload`), or drop `covers` so agents draw the included window"
            : 'Add `replenish: { purchase: {} }` (and/or `autoReload`), or set `onExhausted: "block"`',
      });
    }
    // Two windows, one allowance: `rollover` widens the window to the
    // subscription's start, `window: "month"` narrows it to the calendar month.
    // Declaring both asks for a window that both ignores and follows the period.
    if (m.cap.kind === "pool" && m.cap.rollover && m.cap.window === "month") {
      checks.push({
        level: "error",
        title: `Plan "${m.key}" declares two different windows`,
        detail:
          'cap.rollover widens the window to the subscription start while cap.window: "month" pins it ' +
          "to the calendar month — the month wins, so the rollover silently does nothing",
        fix: "Drop one: rollover for a package that accumulates, month for an allowance quoted per month",
      });
    }
    if (m.cap.kind === "pool" && poolSizeOf(m) === 0) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" has an empty pool`,
        detail: "cap is a pool but neither `credits` nor `perSeat` was set, so every metered call is refused",
        fix: "Set `cap.credits` for a flat package, or `cap.perSeat` for one sized by seats",
      });
    }
    // Both would be a pool whose size depends on which field the reader checks
    // first. `perSeat` wins in `poolSizeOf`, so `credits` would silently do
    // nothing — the kind of disagreement that only shows up as a wrong number.
    if (m.cap.kind === "pool" && m.cap.perSeat != null && m.cap.credits != null) {
      checks.push({
        level: "error",
        title: `Plan "${m.key}" sizes its pool twice`,
        detail:
          "cap.credits and cap.perSeat are mutually exclusive; perSeat wins, so the flat credits are ignored",
        fix: "Keep `perSeat` for a pool that scales with seats, or `credits` for a fixed package",
      });
    }
    // A FLAT per-seat number cannot express a plan with tiers that include
    // different amounts: 3 Standard (1 000) + 1 Premium (5 000) should pool 8 000,
    // and `perSeat: 1_000` gives 4 000 while `perSeat: 5_000` gives 20 000. One
    // under-delivers against the pricing page; the other hands Standard seats five
    // times what they paid for. `"included"` is the form that can say it.
    if (
      m.cap.kind === "pool" &&
      typeof m.cap.perSeat === "number" &&
      new Set(m.seatTypes.map((s) => s.includedCredits)).size > 1
    ) {
      checks.push({
        level: "error",
        title: `Plan "${m.key}" pools one number across seat tiers that include different amounts`,
        detail: `seat types include ${m.seatTypes.map((s) => `${s.key}: ${s.includedCredits}`).join(", ")}, so a flat cap.perSeat either under-delivers or over-grants`,
        fix: 'Use `cap: { kind: "pool", perSeat: "included" }`, which multiplies each tier by its own includedCredits',
      });
    }
    // `"included"` reads each seat type's own allowance, so there has to be one.
    if (
      m.cap.kind === "pool" &&
      m.cap.perSeat === "included" &&
      m.seatTypes.every((s) => s.includedCredits === 0)
    ) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" pools the seat types' included credits, but they are all 0`,
        detail: 'cap.perSeat: "included" sums includedCredits per purchased seat, so the pool is empty',
        fix: "Set `includedCredits` on the seat types, or give `cap.credits` a flat package size",
      });
    }
    // A per-seat pool multiplies by a seat count, and the count comes from the
    // subscription — a plan that sells nothing has no seats to multiply, so every
    // org would fall back to the member count or to 1.
    if (m.cap.kind === "pool" && m.cap.perSeat != null && m.sells.kind === "nothing") {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" sizes a pool per seat but sells no seats`,
        detail:
          "there is no purchased quantity to multiply, so the pool falls back to the active member count",
        fix: "Use `cap.credits` for a free plan's package, or sell seats",
      });
    }
    if (m.grant.kind === "purchased_seats" && m.seatTypes.every((s) => s.includedCredits === 0)) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" grants nothing`,
        detail: "it grants per purchased seat, but every seat type includes 0 credits",
        fix: "Set `includedCredits` per seat type, or say `grant: { kind: \"none\" }` and use a `cap`",
      });
    }
    for (const s of m.seatTypes.filter((s) => s.shared && s.max === null)) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" shared seat "${s.key}" is unbounded`,
        detail: "a shared (agent) seat is normally one per workspace, but any quantity can be bought",
        fix: `Set max: 1 on seatTypes.${s.key}`,
      });
    }
    if (m.sale === "self_serve" && m.sells.kind === "nothing") {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" is self-serve but sells nothing`,
        detail: "no Stripe price exists for it, so a checkout for it cannot succeed",
        fix: 'Use sale: "free"',
      });
    }
  }

  // A catalogue nothing can sell. gtm-tools shipped exactly this: plans declared
  // and advertised on a pricing page, no checkout and no subscription sync, so
  // `resolvePlan` was permanently null and the pooled cap never activated —
  // wallet-only in practice, while the site promised plans.
  const sellable = models.filter((m) => m.sale === "self_serve" && m.sells.kind !== "nothing");
  if (sellable.length && !options?.hasCheckout) {
    checks.push({
      level: "warn",
      title: "Self-serve plans with no way to buy them",
      detail:
        `${sellable.map((m) => m.key).join(", ")} are marked self_serve, but this deployment reports no ` +
        "checkout path. Without one no subscription is ever created, so any pool or per-seat cap stays " +
        "inert and the plan is advertised but unreachable",
      fix:
        "Mount a checkout (createBilling's `mcp`/`restDispatch` with the change_plan tool, or the app's own " +
        'flow) and pass `hasCheckout: true` here — or mark the plans sale: "quote"',
    });
  }

  if (checks.length === 0) {
    checks.push({ level: "ok", title: "Plans config", detail: `${models.length} plan(s), nothing to flag` });
  }
  return {
    livemode: false,
    checks,
    healthy: !checks.some((c) => c.level === "error"),
  };
}

/** Render a DoctorResult for a terminal. Returns the exit code to use. */
export function formatDoctorResult(result: DoctorResult): { text: string; exitCode: number } {
  const icon = { ok: "✓", warn: "!", error: "✗" } as const;
  const lines = result.checks.map((c) => {
    const head = `${icon[c.level]} ${c.title}: ${c.detail}`;
    return c.fix && c.level !== "ok" ? `${head}\n    → ${c.fix}` : head;
  });
  const failed = result.checks.filter((c) => c.level === "error").length;
  lines.push(
    "",
    failed === 0
      ? `All good (${result.livemode ? "LIVE" : "test"} mode).`
      : `${failed} problem(s) in ${result.livemode ? "LIVE" : "test"} mode.`,
  );
  return { text: lines.join("\n"), exitCode: failed === 0 ? 0 : 1 };
}

// ── The runner ──────────────────────────────────────────────────────────────
//
// `checkPlansConfig` and `checkBillingSetup` are the checks; this is the CLI around
// them, and it exists because both consumers hand-wrote the same one. Measured: two
// scripts, 64 and 75 lines, 87 differing lines, doing the same thing — the same
// `--url` / `--no-webhook` argv parsing, the same "which do I run first", the same
// exit-code arithmetic. The second was written by copying the first.
//
// It cannot live in the `billing-tools doctor` bin subcommand, because
// `checkPlansConfig` needs the app's own catalogue and only the app has it. So the
// app keeps a script; what it stops keeping is the plumbing.
//
//     // scripts/ops/billing-doctor.ts
//     import { runBillingDoctor } from "@arnaudjnn/billing-tools";
//     import { buildConfig, PLANS } from "@myapp/toolkit/config";
//     import { LEDGER_COVERAGE } from "@myapp/toolkit/runtime";
//
//     await runBillingDoctor({
//       plans: PLANS,
//       config: buildConfig(),
//       usageLedger: LEDGER_COVERAGE,
//       hasCheckout: true,
//       webhookUrl: "https://myapp.example/api/stripe/webhook",
//     });

export interface RunDoctorOptions {
  /** The app's catalogue. Checked FIRST: it needs no network, and a config mistake
   *  explains most account-level symptoms. */
  plans?: PlanCatalog;
  /** The app's `BillingConfig`. Supplies currency and the tax mode, so the doctor
   *  reads the same declaration the engine does rather than being told twice. */
  config?: BillingConfig;
  /** What the wired ledger can count — pass the ledger's own `covers`. */
  usageLedger?: boolean | LedgerCoverage;
  /** True when a checkout is mounted, so self-serve plans are not flagged as
   *  advertised-but-unbuyable. */
  hasCheckout?: boolean;
  /** The deployed endpoint, used unless `--url` or `--no-webhook` says otherwise. */
  webhookUrl?: string;
  /** Audit WorkOS too — the other half of the substrate. Pass `{ oauthProxy: true }`
   *  when the app mounts the MCP OAuth proxy, which is what makes
   *  `REFRESH_TOKEN_SECRET` required. Omit to skip. */
  workos?: boolean | { oauthProxy?: boolean };
  /** Defaults to `process.argv.slice(2)`. */
  argv?: string[];
  /** Defaults to `process.exit`. Injectable so this is testable. */
  exit?: (code: number) => never;
  log?: (line: string) => void;
}

/**
 * Run both doctors, print them, and exit non-zero when something is actually wrong.
 *
 * Flags: `--url <url>` checks a different endpoint, `--no-webhook` skips the webhook
 * check entirely (correct locally, where by design there IS no endpoint).
 *
 * Exits 2 with a clear message when `STRIPE_SECRET_KEY` is unset, because that
 * variable decides WHICH environment is being checked — a doctor run against the
 * wrong account is worse than no run.
 */
export async function runBillingDoctor(opts: RunDoctorOptions = {}): Promise<void> {
  const argv = opts.argv ?? process.argv.slice(2);
  const log = opts.log ?? ((line: string) => console.log(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not set — it decides which environment is checked");
    return exit(2);
  }

  const urlFlag = argv.indexOf("--url");
  const webhookUrl = argv.includes("--no-webhook")
    ? undefined
    : urlFlag !== -1
      ? argv[urlFlag + 1]
      : opts.webhookUrl;

  // The config check first: no network, and it explains most of what the account
  // check would otherwise report as a symptom.
  let planExit = 0;
  if (opts.plans) {
    const plans = formatDoctorResult(
      checkPlansConfig(opts.plans, {
        hasCheckout: opts.hasCheckout,
        usageLedger: opts.usageLedger,
      }),
    );
    log(plans.text);
    planExit = plans.exitCode;
  }

  // The account half TALKS TO STRIPE, so it can fail outright rather than report a
  // failing check — an invalid key, a revoked one, no network. Both hand-written
  // copies of this caught that at the top level and printed a raw error; here it
  // becomes a legible line and a non-zero exit, and crucially it does not discard
  // the config report already printed above. That report is the half that needs no
  // network and the half Stripe can never tell you about.
  let accountExit = 0;
  try {
    const account = formatDoctorResult(
      await checkBillingSetup({ webhookUrl, config: opts.config }),
    );
    log(account.text);
    accountExit = account.exitCode;
  } catch (e) {
    log(`✗ Stripe: ${e instanceof Error ? e.message : String(e)}`);
    log("    → check STRIPE_SECRET_KEY, and that this machine can reach api.stripe.com");
    accountExit = 1;
  }

  // WorkOS last, and in its own try: it is a different vendor with a different key,
  // so a WorkOS outage must not read as a Stripe problem.
  let workosExit = 0;
  if (opts.workos) {
    const w = typeof opts.workos === "object" ? opts.workos : {};
    try {
      const workos = formatDoctorResult(await checkWorkOSSetup(w));
      log(workos.text);
      workosExit = workos.exitCode;
    } catch (e) {
      log(`✗ WorkOS: ${e instanceof Error ? e.message : String(e)}`);
      workosExit = 1;
    }
  }

  // Any of the three failing fails the run: a good Stripe account with a broken
  // catalogue is still broken, and so is one whose WorkOS half cannot sign anybody in.
  return exit(accountExit || planExit || workosExit);
}

// ── WorkOS ──────────────────────────────────────────────────────────────────
//
// `checkBillingSetup` audits Stripe thoroughly and WorkOS not at all, which left
// half the substrate unchecked: WorkOS is where orgs, memberships and the `sk_`
// API keys live, and it is assumed by every adapter this library ships.
//
// The failures worth catching are the ones that produce a 500 at request time
// rather than an error at boot, because the credentials are read lazily (they have
// to be — constructing at import time throws when a key is unset and takes the
// app's boot with it). So an environment can look perfectly healthy until the
// first person tries to sign in.
//
// `REFRESH_TOKEN_SECRET` is the sharpest of them and the reason this exists. The
// OAuth proxy refuses to sign a refresh token without it — deliberately, because
// it used to fall back to `WORKOS_CLIENT_ID`, a PUBLIC identifier, so anyone who
// knew it could forge a 30-day token. The consequence of the safe behaviour is a
// `server_error` from the token endpoint, which reads as "MCP is broken" rather
// than "one variable is unset". Measured on a real deployment: absent from both
// `.env.example` and `.env.local` while `oauthProxy: true` was set, so no agent
// could connect and nothing said why.
export async function checkWorkOSSetup(opts: {
  /** True when the app mounts the MCP OAuth proxy (`createBilling({ oauthProxy })`).
   *  Only then is `REFRESH_TOKEN_SECRET` required. */
  oauthProxy?: boolean;
} = {}): Promise<DoctorResult> {
  const checks: Check[] = [];

  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;

  if (!apiKey) {
    checks.push({
      level: "error",
      title: "WORKOS_API_KEY",
      detail: "not set",
      fix: "Set it from WorkOS → API Keys. Every adapter here reads it lazily, so the app boots fine and then 500s on the first org lookup",
    });
  }
  if (!clientId) {
    checks.push({
      level: "error",
      title: "WORKOS_CLIENT_ID",
      detail: "not set",
      fix: "Set it from WorkOS → Configuration. AuthKit and the OAuth proxy both need it",
    });
  }

  // Live-vs-test is a WorkOS ENVIRONMENT, and the key names it: a staging key in
  // production points every org and API key at the wrong environment, silently.
  if (apiKey) {
    const staging = apiKey.startsWith("sk_test");
    checks.push({
      level: "ok",
      title: "WorkOS environment",
      detail: staging ? "test/staging key" : "production key",
    });
  }

  // One real call, so a key that is present but revoked or from another
  // environment fails here instead of on a customer's first request.
  if (apiKey) {
    try {
      const orgs = await getWorkOS().organizations.listOrganizations({ limit: 1 });
      checks.push({
        level: "ok",
        title: "WorkOS API key",
        detail: `usable (${orgs.data.length ? "organizations exist" : "no organizations yet"})`,
      });
    } catch (e) {
      checks.push({
        level: "error",
        title: "WorkOS API key",
        detail: e instanceof Error ? e.message : String(e),
        fix: "The key is set but WorkOS rejected it — revoked, or from a different environment",
      });
    }
  }

  if (opts.oauthProxy) {
    checks.push(
      process.env.REFRESH_TOKEN_SECRET
        ? { level: "ok", title: "REFRESH_TOKEN_SECRET", detail: "set" }
        : {
            level: "error",
            title: "REFRESH_TOKEN_SECRET",
            detail: "not set, but the OAuth proxy is mounted",
            fix: "Set it to any long random string (`openssl rand -hex 32`). Without it the token endpoint returns server_error and no MCP client can connect. There is no fallback on purpose: it used to fall back to WORKOS_CLIENT_ID, which is public, so the secret was forgeable",
          },
    );
  }

  return {
    // WorkOS has no `livemode` of its own; the key names the environment.
    livemode: Boolean(apiKey) && !apiKey!.startsWith("sk_test"),
    checks,
    healthy: !checks.some((c) => c.level === "error"),
  };
}
