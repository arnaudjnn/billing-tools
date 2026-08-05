import {
  checkBillingSetup,
  checkWorkOSSetup,
  checkPlansConfig,
  formatDoctorResult,
  runBillingDoctor,
  webhookUrlFromArgv,
  type Check,
  type DoctorResult,
  type RunDoctorOptions,
} from "./doctor.js";
import { ensurePlans } from "./plans.js";
import { ensureMeters } from "./usage-ledger.js";
import { ensureTaxSetup, type TaxRegistrationSpec } from "./tax-setup.js";
import { ensureWebhookEndpoint } from "./webhook-setup.js";
import { taxModeOf } from "./tax.js";
import { ensureWorkOSRoles, type WorkOSRoleSpec } from "./workos-setup.js";
import type { BillingConfig } from "./types.js";
import type { PlanCatalog } from "./plans.js";

// Everything a Stripe environment needs, in one call — the deploy-time twin of
// the lazy provisioning the request path already does.
//
// Almost nothing here is REQUIRED any more: prices, the payment-method
// configuration and the usage meter all provision themselves on first use, from
// the secret key alone. What's left is the handful that genuinely cannot be lazy,
// and the reason each can't is worth stating because it's the whole argument for
// this function existing:
//
//   - the WEBHOOK endpoint, because Stripe returns its signing secret exactly
//     once, at creation, and no request can put that into your env store for you;
//   - TAX REGISTRATIONS, because only a human knows where the business is
//     registered to collect (and Stripe Tax silently computes 0% without them);
//   - and everything else, only because paying for a full reconcile on a
//     customer's first request is a worse place to discover a broken config than
//     a deploy log.
//
// So: run it once per Stripe account+mode (the key decides which), from a script
// or a deploy hook. It is idempotent — every step underneath is — and it finishes
// by running the doctor, because "it ran" and "it is right" are different claims.

export type SetupStep = Check & {
  /** What ran. Stable, so a caller can filter or key off it. */
  step: "plans" | "meter" | "tax" | "webhook" | "workos";
  /** True when this step was skipped because the caller didn't ask for it. */
  skipped?: boolean;
};

export type SetupResult = {
  livemode: boolean;
  steps: SetupStep[];
  /** `checkBillingSetup` + `checkPlansConfig`, run afterwards. */
  doctor: DoctorResult;
  /** Present ONLY when this run created the webhook endpoint. Stripe never
   *  returns it again: put it in the environment now or lose it. */
  webhookSecret?: string;
  /** True when nothing errored, in the steps or in the doctor. */
  healthy: boolean;
};

export interface SetupOptions {
  /** Your `BillingConfig`. Gives the currency and the tax mode, so neither is
   *  restated here and nothing can disagree with what the app runs on. */
  config: BillingConfig;
  /** Reconcile Stripe products/prices for these plans. Omit to skip. */
  plans?: PlanCatalog;
  /** Absolute URL of your Stripe webhook handler. Omit to skip — correct for a
   *  local machine, which uses `stripe listen` instead (see ./dev). */
  webhookUrl?: string;
  /** Prune other endpoints registered on the same URL. Destructive. */
  pruneDuplicateWebhooks?: boolean;
  /**
   * Stripe Tax setup, for a deployment whose `config.tax` mode is `"stripe"`.
   *
   * Ignored otherwise: an account whose rates this library computes has no head
   * office or registration to configure, and running this on one would create
   * registrations it doesn't need and will be charged against.
   */
  stripeTax?: {
    headOffice: Parameters<typeof ensureTaxSetup>[0]["headOffice"];
    registrations: TaxRegistrationSpec[];
    taxCode?: string;
  };
  /** Create the usage meter eagerly. Default true. */
  meter?: boolean;
  /**
   * Provision and audit the WorkOS half.
   *
   * PROVISIONED: only the roles YOU name in `roles`. WorkOS ships `admin` and
   * `member`, so there is no default list — a step that never fires would still read
   * as one that does something. Whether the `admin` slug is present is checked by the
   * doctor, which is a different claim.
   *
   * NOT provisioned, because v10 exposes no API for either: AuthKit's **redirect
   * URIs** and its appearance/settings. The SDK's only writable `redirect_uris`
   * belong to a Connect application, which is a different object. The closing report
   * prints the exact redirect URI to paste rather than implying it was handled.
   *
   * Orgs, memberships and `sk_` keys are not provisioned either — they are created
   * lazily per customer, which is the behaviour you want.
   *
   * Pass `{ oauthProxy: true }` when the app mounts the MCP OAuth proxy, which is
   * what makes `REFRESH_TOKEN_SECRET` required.
   */
  workos?: boolean | { oauthProxy?: boolean; roles?: WorkOSRoleSpec[] };
}

/**
 * Provision + verify one Stripe environment. Idempotent; safe on every deploy.
 *
 * Which environment is decided by `STRIPE_SECRET_KEY` and nothing else, so the
 * same call is your test setup and your live setup.
 */
export async function setupBilling(opts: SetupOptions): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  let webhookSecret: string | undefined;

  const ok = (step: SetupStep["step"], title: string, detail: string) =>
    steps.push({ step, level: "ok", title, detail });
  const skip = (step: SetupStep["step"], title: string, detail: string) =>
    steps.push({ step, level: "ok", title, detail, skipped: true });
  const fail = (step: SetupStep["step"], title: string, e: unknown, fix?: string) =>
    steps.push({ step, level: "error", title, detail: (e as Error).message, fix });

  // Every step is independent and each one's failure is worth reporting on its
  // own, so nothing here throws: a missing tax registration must not stop the
  // webhook from being registered, and a report of four outcomes is more useful
  // than the first exception.

  if (opts.plans) {
    try {
      const ensured = await ensurePlans(opts.plans, { currency: opts.config.currency });
      ok(
        "plans",
        "Products and prices",
        `${ensured.length} price(s) reconciled: ${ensured.map((p) => p.lookupKey).join(", ") || "none"}`,
      );
    } catch (e) {
      fail("plans", "Products and prices", e);
    }
  } else {
    skip("plans", "Products and prices", "no `plans` passed; they provision on first use anyway");
  }

  if (opts.meter !== false) {
    try {
      const { meterId, created } = await ensureMeters();
      ok("meter", "Usage meter", `${meterId}${created ? " (created)" : ""}`);
    } catch (e) {
      fail(
        "meter",
        "Usage meter",
        e,
        "Grant the key write access to billing meters. Until it exists, every org-wide " +
          "window reads 0 and no cap or org-scoped rate limit applies.",
      );
    }
  } else {
    skip("meter", "Usage meter", "not requested");
  }

  const taxMode = taxModeOf(opts.config.tax);
  if (taxMode === "stripe" && opts.stripeTax) {
    try {
      const r = await ensureTaxSetup({
        headOffice: opts.stripeTax.headOffice,
        registrations: opts.stripeTax.registrations,
        defaults: { taxCode: opts.stripeTax.taxCode },
      });
      const detail =
        `settings ${r.settingsStatus}; registrations ` +
        `${[...r.created.map((c) => `${c} (created)`), ...r.existing].join(", ") || "none"}`;
      steps.push(
        r.settingsStatus === "active"
          ? { step: "tax", level: "ok", title: "Stripe Tax", detail }
          : {
              step: "tax",
              level: "error",
              title: "Stripe Tax",
              detail,
              fix: "Complete the head office address — Stripe Tax computes 0% until the settings are active",
            },
      );
    } catch (e) {
      fail("tax", "Stripe Tax", e);
    }
  } else if (taxMode === "stripe") {
    steps.push({
      step: "tax",
      level: "warn",
      title: "Stripe Tax",
      detail: 'config.tax mode is "stripe" but no `stripeTax` was passed, so registrations were not checked',
      fix: "Pass `stripeTax: { headOffice, registrations }` — with no active registration Stripe Tax computes ZERO tax, silently",
    });
  } else {
    skip(
      "tax",
      "Tax",
      `mode is "${taxMode}" — nothing to provision in Stripe (rates are minted on first use)`,
    );
  }

  if (opts.webhookUrl) {
    try {
      const r = await ensureWebhookEndpoint({
        url: opts.webhookUrl,
        pruneDuplicates: opts.pruneDuplicateWebhooks,
      });
      webhookSecret = r.secret;
      ok(
        "webhook",
        "Webhook endpoint",
        `${r.id} ${r.created ? "created" : r.updated ? "events updated" : "already correct"}` +
          (r.duplicates.length ? ` — ${r.duplicates.length} duplicate(s) on the same URL` : ""),
      );
    } catch (e) {
      fail("webhook", "Webhook endpoint", e);
    }
  } else {
    skip(
      "webhook",
      "Webhook endpoint",
      "no `webhookUrl`; use `stripe listen` locally, or the poller with `reconcilePayments: true`",
    );
  }

  // Verify, don't assume. Runs last so it sees what the steps above just did — and
  // in a try, because it TALKS TO STRIPE and can fail outright (invalid key, no
  // network) rather than report a failing check.
  //
  // Letting that throw out of `setupBilling` was a real defect, and the worst kind:
  // the webhook step above may just have minted a signing secret, and Stripe never
  // shows it again. A closing verification that discards the one value the caller
  // cannot recover is strictly worse than no verification. So the report always
  // comes back, with the failure as a check inside it.
  let account: DoctorResult;
  try {
    account = await checkBillingSetup({
      config: opts.config,
      webhookUrl: opts.webhookUrl,
    });
  } catch (e) {
    account = {
      livemode: !(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test"),
      checks: [
        {
          level: "error",
          title: "Stripe",
          detail: e instanceof Error ? e.message : String(e),
          fix: "check STRIPE_SECRET_KEY, and that this machine can reach api.stripe.com",
        },
      ],
      healthy: false,
    };
  }
  // ── WorkOS roles ──────────────────────────────────────────────────────────
  //
  // Only the roles the APP invents. WorkOS environments ship `admin` and `member`
  // already, so provisioning those would be a step that never fires while reading
  // like it does something. Whether the `admin` slug is actually present is a
  // different question and the doctor's, not this step's.
  //
  // Nothing else about WorkOS is provisioned: AuthKit's redirect URIs and appearance
  // have no API in v10 (its only writable `redirect_uris` belong to a Connect
  // application, a different object), and orgs, memberships and `sk_` keys are
  // created lazily per customer, which is the behaviour you want.
  const workosRoles = typeof opts.workos === "object" ? opts.workos.roles : undefined;
  if (workosRoles?.length) {
    try {
      const roles = await ensureWorkOSRoles({ roles: workosRoles });
      ok(
        "workos",
        "WorkOS roles",
        roles.created.length
          ? `created ${roles.created.join(", ")}${roles.existing.length ? `; ${roles.existing.join(", ")} already existed` : ""}`
          : `already present: ${roles.existing.join(", ")}`,
      );
    } catch (e) {
      fail(
        "workos",
        "WorkOS roles",
        e,
        "Needs a WORKOS_API_KEY that can write /authorization/roles",
      );
    }
  } else {
    skip("workos", "WorkOS roles", "none declared; `admin`/`member` ship with the environment");
  }

  const plans = opts.plans
    ? checkPlansConfig(opts.plans, { hasCheckout: true })
    : { livemode: account.livemode, checks: [], healthy: true };
  // In its own try: WorkOS is a different vendor with a different key, so its
  // being down must not read as a Stripe problem — or take the report with it.
  let workos: DoctorResult = { livemode: account.livemode, checks: [], healthy: true };
  if (opts.workos) {
    const w = typeof opts.workos === "object" ? opts.workos : {};
    try {
      // The mismatch matters most HERE: this is the run that writes prices and a
      // webhook endpoint, so a live Stripe key beside a staging WorkOS key
      // provisions the real account and points it at the wrong identity store.
      workos = await checkWorkOSSetup({
        ...w,
        expectLivemode: account.livemode,
        baseUrl: opts.config.baseUrl,
      });
    } catch (e) {
      workos = {
        livemode: account.livemode,
        checks: [
          {
            level: "error",
            title: "WorkOS",
            detail: e instanceof Error ? e.message : String(e),
          },
        ],
        healthy: false,
      };
    }
  }
  const doctor: DoctorResult = {
    livemode: account.livemode,
    checks: [...account.checks, ...plans.checks, ...workos.checks],
    healthy: account.healthy && plans.healthy && workos.healthy,
  };

  return {
    livemode: account.livemode,
    steps,
    doctor,
    ...(webhookSecret ? { webhookSecret } : {}),
    healthy: doctor.healthy && !steps.some((s) => s.level === "error"),
  };
}

/**
 * The report as lines of text, because every consumer would otherwise write this
 * same loop — and the ONE line that must not be missed (a freshly minted webhook
 * secret, which Stripe will never show again) deserves to be formatted right once.
 */
export function formatSetupReport(result: SetupResult): string {
  // A skipped step reads as "–" rather than "✓": it did not happen, and a tick
  // against something that didn't run is the kind of report that gets trusted
  // wrongly. Everything else defers to the doctor's renderer.
  const line = (c: SetupStep) =>
    `  ${c.skipped ? "–" : { ok: "✓", warn: "!", error: "✗" }[c.level]} ${c.title}: ${c.detail}` +
    (c.fix && c.level !== "ok" ? `\n      → ${c.fix}` : "");

  const out = [
    `${result.livemode ? "LIVE MODE" : "test mode"} — ${result.healthy ? "healthy" : "ATTENTION NEEDED"}`,
    "",
    "Provisioned:",
    ...result.steps.map(line),
    "",
    "Checked:",
    ...formatDoctorResult(result.doctor)
      .text.split("\n")
      .map((l) => (l ? `  ${l}` : l)),
  ];

  if (result.webhookSecret) {
    out.push(
      "",
      "The webhook signing secret, shown ONCE by Stripe. Put it in this environment now:",
      "",
      `  STRIPE_WEBHOOK_SECRET=${result.webhookSecret}`,
    );
  }
  return out.join("\n");
}

// ── One runner, two verbs ───────────────────────────────────────────────────
//
// `setupBilling` provisions and `checkBillingSetup` decides whether it worked —
// separate claims, deliberately. But they are separate CLAIMS, not separate
// COMMANDS: they take the same inputs (this app's `plans`, this app's `config`, this
// app's webhook URL), and every consumer was keeping two scripts and two
// package.json entries to pass the same three values to each. Both copies then
// carried the same ~30 lines of prose explaining what setup cannot do lazily, which
// is documentation living in the two places nobody reads it.
//
// So the argv, the report and the exit arithmetic live here, and an app keeps one
// script naming only what an app knows:
//
//     // scripts/ops/billing.ts    →    "billing": "tsx --env-file-if-exists=.env.local scripts/ops/billing.ts"
//     import { runBillingCli } from "@arnaudjnn/billing-tools";
//     import { buildConfig, PLANS } from "@myapp/toolkit/config";
//
//     runBillingCli({
//       config: buildConfig(),
//       plans: PLANS,
//       webhookUrl: "https://myapp.example/api/stripe/webhook",
//       workos: { oauthProxy: true },
//     });
//
//       pnpm billing            audit (read-only)
//       pnpm billing setup      provision, then audit
//
// It still cannot be a `billing-tools` bin subcommand: `plans` is a TypeScript value
// in the app, and no flag can pass it. What the app stops keeping is the plumbing.

export interface RunBillingCliOptions extends Omit<RunDoctorOptions, "config"> {
  /** Required here, unlike on the doctor: `setup` provisions FROM it (currency,
   *  tax mode), so a run without it would provision a guess. */
  config: BillingConfig;
  /** Stripe Tax head office + registrations. Ignored unless `config.tax` mode is
   *  `"stripe"` — see `setupBilling`. */
  stripeTax?: SetupOptions["stripeTax"];
}

/**
 * `setup` | `doctor` (default) over one options object.
 *
 * Flags, the same for both verbs: `--url <url>` names a different endpoint,
 * `--no-webhook` says there isn't one. `setup` also takes `--prune`, which deletes
 * other endpoints registered on the same URL.
 *
 * **`doctor` is the default and `setup` must be typed**, because the default has to
 * be the verb that cannot change anything: a bare `pnpm billing` from a laptop
 * holding live keys should read the account, never provision it.
 *
 * Exits the process itself — call it, do not `await` it at the top level, which does
 * not survive a CJS transform.
 */
export async function runBillingCli(opts: RunBillingCliOptions): Promise<void> {
  const argv = opts.argv ?? process.argv.slice(2);
  const log = opts.log ?? ((line: string) => console.log(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const verb = argv.find((a) => !a.startsWith("--")) ?? "doctor";
  if (verb === "doctor") return runBillingDoctor({ ...opts, argv, log, exit });
  if (verb !== "setup") {
    console.error(`Unknown command: ${verb}\n\n  billing [doctor]   audit this environment\n  billing setup      provision it, then audit\n\n  --url <url>  --no-webhook  --prune`);
    return exit(2);
  }

  // The same rule the doctor exits 2 on, for the same reason and more sharply: this
  // verb WRITES, and the key decides which account it writes to.
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not set — it decides which environment is provisioned");
    return exit(2);
  }

  // No step inside `setupBilling` throws; a call that fails outright is the account
  // being unreachable. Reported as a line rather than a stack, like the doctor's.
  try {
    const result = await setupBilling({
      config: opts.config,
      plans: opts.plans,
      webhookUrl: webhookUrlFromArgv(argv, opts.webhookUrl),
      pruneDuplicateWebhooks: argv.includes("--prune"),
      stripeTax: opts.stripeTax,
      workos: opts.workos,
    });
    log(formatSetupReport(result));
    return exit(result.healthy ? 0 : 1);
  } catch (e) {
    log(`✗ Stripe: ${e instanceof Error ? e.message : String(e)}`);
    log("    → check STRIPE_SECRET_KEY, and that this machine can reach api.stripe.com");
    return exit(1);
  }
}
