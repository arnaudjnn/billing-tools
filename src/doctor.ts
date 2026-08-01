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
    let seen = 0;
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      seen++;
      if (customer.currency && customer.currency !== want) {
        if (sample.length < 5) sample.push(`${customer.id} (${customer.currency})`);
      }
      // A sample is enough to answer "is this environment mixed?" — walking
      // every customer of a live account is not what a preflight should do.
      if (seen >= 500) break;
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
              "debits go to the new one, so read balances with getTokenBalance(id, config.currency) (the default " +
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

  return { livemode, checks, healthy: !checks.some((c) => c.level === "error") };
}

/**
 * Inspect a plans config for the mistakes that don't announce themselves.
 *
 * Static: no Stripe call, so it can run in CI next to a typecheck. Separate from
 * `checkBillingSetup` because it asks about the CONFIG rather than the account.
 */
export function checkPlansConfig(plans: PlanCatalog): DoctorResult {
  const checks: Check[] = [];
  const models = normalizePlans(plans);

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
          `it is invoiced (${m.sells.kind}) AND credits tokens (grant: ${m.grant.kind}). A Stripe credit ` +
          "balance auto-applies to the next invoice, so this discounts the plan's own renewal — measured " +
          "at ~48% off a seat whose pack was one month's tokens",
        fix:
          "Set `grant: { kind: \"none\" }` and express the included allowance as a `cap` (per_seat or pool), " +
          "which is counted rather than credited. Keep `grant` only for a plan that literally sells credit",
      });
    }
    // Rate limits: the two ways a plausible-looking declaration silently refuses
    // everything, and the one way a set of them contradicts itself.
    for (const l of m.limits.rate) {
      if (l.tokens <= 0) {
        checks.push({
          level: "error",
          title: `Plan "${m.key}" has a zero ${l.every} limit`,
          detail: `a rate limit of ${l.tokens} refuses every call in that window`,
          fix: "Set `tokens` above 0, or drop the limit",
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
      const key = `${l.scope ?? "org"}:${l.seatType ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => lengths[a.every] - lengths[b.every]);
      for (let i = 1; i < sorted.length; i++) {
        const narrow = sorted[i - 1];
        const wide = sorted[i];
        if (wide.tokens <= narrow.tokens) {
          checks.push({
            level: "warn",
            title: `Plan "${m.key}" has an unreachable ${wide.every} limit`,
            detail:
              `the ${wide.every} limit (${wide.tokens}) is no larger than the ${narrow.every} one ` +
              `(${narrow.tokens}) on the same callers, so the ${narrow.every} window always refuses first`,
            fix: `Raise the ${wide.every} limit above the ${narrow.every} one, or drop one of them`,
          });
        }
      }
    }
    if (m.cap.kind === "pool" && poolSizeOf(m) === 0) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" has an empty pool`,
        detail: "cap is a pool but no `tokens` were set, so every metered call is refused",
        fix: "Set `cap.tokens` to the package size",
      });
    }
    if (m.grant.kind === "purchased_seats" && m.seatTypes.every((s) => s.includedTokens === 0)) {
      checks.push({
        level: "warn",
        title: `Plan "${m.key}" grants nothing`,
        detail: "it grants per purchased seat, but every seat type includes 0 tokens",
        fix: "Set `includedTokens` per seat type, or say `grant: { kind: \"none\" }` and use a `cap`",
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
