import { getStripe } from "./billing.js";
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

  return { livemode, checks, healthy: !checks.some((c) => c.level === "error") };
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
