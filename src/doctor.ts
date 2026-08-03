import { getStripe } from "./billing.js";
import { normalizePlans, poolSizeOf, type PlanCatalog } from "./plan-model.js";
import { BILLING_WEBHOOK_EVENTS } from "./webhook-setup.js";

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
  /** Skip Stripe Tax checks if you deliberately don't use automatic_tax. */
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
  const expectTax = opts.expectTax ?? true;

  const account = await stripe.accounts.retrieve();
  const livemode = !(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test");
  checks.push({
    level: "ok",
    title: "Stripe account",
    detail: `${account.id} (${account.country ?? "?"}) — ${livemode ? "LIVE" : "test"} mode`,
  });

  if (expectTax) {
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
  if (opts.currency) {
    const want = opts.currency.toLowerCase();
    const sample: string[] = [];
    // Auto-reload charges a card off-session. Enabled with no card on file, it
    // silently does nothing every time the balance runs out — the customer is
    // simply blocked, with no failure anywhere to explain why.
    const reloadNoCard: string[] = [];
    let seen = 0;
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      seen++;
      if (customer.currency && customer.currency !== want) {
        if (sample.length < 5) sample.push(`${customer.id} (${customer.currency})`);
      }
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
     * Whether a usage ledger is wired — `Boolean(meter.db ?? meter.ledger)`.
     *
     * OMIT it and the check is skipped entirely: undefined means "the caller did
     * not say", which is not the same as "nothing is wired". Defaulting it to
     * false would fail every existing consumer's CI over a config that may be
     * perfectly wired, and `createBilling` already warns at boot when it really
     * is missing. Only a plan that includes usage or rate-limits it needs one.
     */
    usageLedger?: boolean;
  },
): DoctorResult {
  const checks: Check[] = [];
  const models = normalizePlans(plans);

  // A cap or a rate limit counted by the DEFAULT ledger is counted by nothing:
  // that ledger IS the Stripe debits, and included usage moves no money. The
  // failure looks like generosity — every window reads 0%, nothing is ever
  // refused — so it is an ERROR here even though `createBilling` only warns. A
  // warning in a deploy log is missable; a month of unenforced caps is not
  // recoverable after the fact.
  const counted =
    options?.usageLedger === undefined
      ? []
      : models.filter((m) => m.cap.kind !== "wallet" || m.limits.rate.length > 0);
  if (options?.usageLedger === undefined) {
    // Nothing asserted, so nothing claimed.
  } else if (!counted.length) {
    checks.push({
      level: "ok",
      title: "Usage ledger",
      detail: "no plan includes usage or rate-limits it, so the Stripe default counts everything",
    });
  } else if (options?.usageLedger) {
    checks.push({
      level: "ok",
      title: "Usage ledger",
      detail: `wired for ${counted.map((m) => m.key).join(", ")}`,
    });
  } else {
    checks.push({
      level: "error",
      title: "Usage ledger",
      detail: `plans ${counted.map((m) => m.key).join(", ")} include usage or rate-limit it, but no ledger is wired`,
      fix:
        "Pass `meter.db` (a Postgres client — also the only option that gives per-member " +
        "figures) or `meter.ledger` to createBilling, and run ensureUsageLedgerTable(db) from " +
        "your migrations. Without one, that usage counts as 0 and the caps never apply.",
    });
  }

  const legacy = models.filter((m) => m.legacy);
  if (legacy.length) {
    checks.push({
      level: "warn",
      title: "Legacy plan shape",
      detail: `${legacy.map((m) => m.key).join(", ")} use the pre-0.54 shape, so \`sale\` was GUESSED from whether any price exists`,
      fix:
        "Declare `sells`/`cap`/`sale` explicitly (see definePlans). Guessing `sale` is what lets a " +
        "quote-only plan be bought at its placeholder price",
    });
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
        detail: "cap is a pool but no `credits` were set, so every metered call is refused",
        fix: "Set `cap.credits` to the package size",
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
