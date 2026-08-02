import { rmSync } from "node:fs";
import type { Command } from "commander";
import { callTool, type ApiClientConfig } from "./client.js";
import {
  type CliOptions,
  configPath,
  readConfig,
  writeConfig,
  resolveBaseUrl,
  resolveApiKey,
} from "./config.js";

function extractApiKey(result: unknown): string | undefined {
  const visit = (v: unknown): string | undefined => {
    if (typeof v === "string") {
      const m = v.match(/sk_[A-Za-z0-9_-]+/);
      return m ? m[0] : undefined;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) {
        const found = visit(x);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(result);
}

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// Register the shared billing commands on a commander program (or subcommand).
// Reads global options --api-key / --url off `program`.
export function registerBillingCommands(program: Command, opts: CliOptions) {
  const requireConfig = (): ApiClientConfig => {
    const apiKey = resolveApiKey(opts, program.opts().apiKey);
    if (!apiKey) {
      console.error(`Error: API key required. Run 'auth <email> --code <code>' to log in,`);
      console.error(`or pass --api-key / set ${opts.envPrefix}_API_KEY.`);
      process.exit(1);
    }
    return { baseUrl: resolveBaseUrl(opts, program.opts().url), apiKey };
  };

  program
    .command("auth <email>")
    .description("Get an API key via email + 6-digit code")
    .option("--code <code>", "6-digit verification code from email")
    .action(async (email: string, o: { code?: string }) => {
      const baseUrl = resolveBaseUrl(opts, program.opts().url);
      const apiKey = resolveApiKey(opts, program.opts().apiKey) || "bootstrap";
      const args: Record<string, unknown> = { email };
      if (o.code) args.code = o.code;
      const result = await callTool({ baseUrl, apiKey }, "get_api_key", args);
      print(result);
      const key = extractApiKey(result);
      if (key) {
        writeConfig(opts, { ...readConfig(opts), apiKey: key, email, baseUrl });
        console.error(`\n✓ Logged in as ${email}. Credentials saved to ${configPath(opts)}.`);
      }
    });

  program
    .command("logout")
    .description("Sign out by clearing local credentials")
    .action(() => {
      try {
        rmSync(configPath(opts), { force: true });
      } catch {
        /* best effort */
      }
      console.log(`✓ Signed out. Removed ${configPath(opts)}.`);
    });

  program
    .command("balance")
    .description("Get current credit balance and tool costs")
    .action(async () => print(await callTool(requireConfig(), "get_credit_balance")));

  program
    .command("buy <amount>")
    .description("Buy credits (returns a Stripe Checkout URL)")
    .action(async (amount: string) =>
      print(await callTool(requireConfig(), "buy_credits", { amount: parseInt(amount, 10) })),
    );

  program
    .command("invoices")
    .description("List recent invoices")
    .option("--limit <n>", "Number to return (default 10)", (v) => parseInt(v, 10))
    .action(async (o: { limit?: number }) => {
      const args: Record<string, unknown> = {};
      if (o.limit) args.limit = o.limit;
      print(await callTool(requireConfig(), "list_invoices", args));
    });

  const keys = program.command("keys").description("List and revoke API keys");
  keys
    .command("list")
    .description("List API keys")
    .action(async () => print(await callTool(requireConfig(), "list_api_keys")));
  keys
    .command("revoke <id>")
    .description("Revoke an API key by id")
    .action(async (id: string) => print(await callTool(requireConfig(), "revoke_api_key", { api_key_id: id })));

  // ── Usage & seats ─────────────────────────────────────────────────────────
  program
    .command("usage")
    .description("Get workspace credit usage for the current cycle")
    .option("--caller-kind <kind>", "Filter by caller kind: user | api")
    .option("--caller-id <id>", "Filter by caller id (member or API-key id)")
    .option("--since-days <n>", "Look back N days instead of the calendar month", (v) => parseInt(v, 10))
    .action(async (o: { callerKind?: string; callerId?: string; sinceDays?: number }) => {
      const args: Record<string, unknown> = {};
      if (o.callerKind) args.caller_kind = o.callerKind;
      if (o.callerId) args.caller_id = o.callerId;
      if (o.sinceDays) args.since_days = o.sinceDays;
      print(await callTool(requireConfig(), "get_usage", args));
    });

  program
    .command("seats")
    .description("List per-member seat-type assignments")
    .action(async () => print(await callTool(requireConfig(), "list_seats")));

  program
    .command("assign-seat <member_id> [seat_type]")
    .description("Assign a member to a seat type (omit seat_type to clear → default seat)")
    .action(async (memberId: string, seatType: string | undefined) =>
      print(
        await callTool(requireConfig(), "assign_seat_type", {
          member_id: memberId,
          seat_type: seatType ?? "",
        }),
      ),
    );

  // ── Credit top-up requests ─────────────────────────────────────────────────
  const topup = program
    .command("topup")
    .description("Credit top-up requests (a seat over its cap → owner approval)");
  topup
    .command("list")
    .description("List top-up requests (pending and handled)")
    .action(async () => print(await callTool(requireConfig(), "list_top_up_requests")));
  topup
    .command("request <member_id> <amount>")
    .description("Request extra credits for a member's seat this cycle")
    .option("--cycle <cycle>", "Cycle key the grant applies to (default: the current billing cycle)")
    .action(async (memberId: string, amount: string, o: { cycle?: string }) => {
      const args: Record<string, unknown> = { member_id: memberId, amount: parseInt(amount, 10) };
      if (o.cycle) args.cycle = o.cycle;
      print(await callTool(requireConfig(), "request_top_up", args));
    });
  topup
    .command("grant <member_id> [percent]")
    .description("Grant a member extra allowance now, without waiting for a request (default +25%)")
    .option("--credits <n>", "Absolute credits instead of a percentage", (v) => parseInt(v, 10))
    .action(async (memberId: string, percent: string | undefined, o: { credits?: number }) => {
      const args: Record<string, unknown> = { member_id: memberId };
      if (o.credits) args.credits = o.credits;
      else if (percent) args.percent = parseInt(percent, 10);
      print(await callTool(requireConfig(), "grant_top_up", args));
    });
  topup
    .command("approve <request_id>")
    .description("Approve a pending top-up request (grants the extra credits)")
    .action(async (id: string) => print(await callTool(requireConfig(), "approve_top_up", { request_id: id })));
  topup
    .command("deny <request_id>")
    .description("Deny a pending top-up request")
    .action(async (id: string) => print(await callTool(requireConfig(), "deny_top_up", { request_id: id })));

  registerPlanCommands(program, requireConfig);
}

// ── Plans, the billing account, and the rest of the tool surface ────────────
//
// Split out only for length. The rule these follow: the CLI is a thin shell over
// the SAME tools the API and MCP expose, so a command exists here if and only if
// a tool exists there — a capability reachable from one surface and not another
// is the gap this whole pass was about.
function registerPlanCommands(program: Command, requireConfig: () => ApiClientConfig) {
  program
    .command("plans")
    .description("List the available plans, with prices and included usage")
    .action(async () => print(await callTool(requireConfig(), "list_plans")));

  const plan = program.command("plan").description("Show and change this workspace's plan");
  plan
    .command("show", { isDefault: true })
    .description("Current plan, any scheduled change, and the moves available")
    .action(async () => print(await callTool(requireConfig(), "get_plan")));
  plan
    .command("preview <plan>")
    .description("What moving to a plan would cost — prorated, without making the change")
    .option("--interval <interval>", "monthly | yearly")
    .option("--seats <json>", 'Seats per type, e.g. \'{"standard":3}\'')
    .option("--timing <timing>", "auto | now | period_end")
    .action(async (target: string, o: { interval?: string; seats?: string; timing?: string }) =>
      print(await callTool(requireConfig(), "preview_plan_change", planArgs(target, o))),
    );
  plan
    .command("change <plan>")
    .description("Move to another plan (upgrades prorate now, downgrades apply at the period end)")
    .option("--interval <interval>", "monthly | yearly")
    .option("--seats <json>", 'Seats per type, e.g. \'{"standard":3}\'')
    .option("--timing <timing>", "auto | now | period_end")
    .option("--proration <mode>", "next_invoice | invoice_now | none")
    .action(async (target: string, o: { interval?: string; seats?: string; timing?: string; proration?: string }) => {
      const args = planArgs(target, o);
      if (o.proration) args.proration = o.proration;
      print(await callTool(requireConfig(), "change_plan", args));
    });
  plan
    .command("cancel")
    .description("Cancel at the end of the period already paid for")
    .action(async () => print(await callTool(requireConfig(), "cancel_plan")));

  program
    .command("limits")
    .description("Every usage limit that applies right now, and when each resets")
    .option("--caller-kind <kind>", "user | api")
    .option("--caller-id <id>", "Member or API-key id")
    .action(async (o: { callerKind?: string; callerId?: string }) => {
      const args: Record<string, unknown> = {};
      if (o.callerKind) args.caller_kind = o.callerKind;
      if (o.callerId) args.caller_id = o.callerId;
      print(await callTool(requireConfig(), "get_usage_limits", args));
    });

  program
    .command("portal")
    .description("Open the Stripe billing portal (manage subscription, cards, invoices)")
    .action(async () => print(await callTool(requireConfig(), "get_billing_portal")));

  const autoReload = program
    .command("auto-reload")
    .description("Automatic top-up when the balance runs low");
  autoReload
    .command("set <threshold> <reload_to>")
    .description("Recharge to <reload_to> credits whenever the balance falls to <threshold>")
    .action(async (threshold: string, reloadTo: string) =>
      print(
        await callTool(requireConfig(), "set_auto_reload", {
          enabled: true,
          threshold: parseInt(threshold, 10),
          reload_to: parseInt(reloadTo, 10),
        }),
      ),
    );
  autoReload
    .command("off")
    .description("Turn automatic top-up off")
    .action(async () =>
      print(await callTool(requireConfig(), "set_auto_reload", { enabled: false, threshold: 0, reload_to: 1 })),
    );

  // ── The billing account ───────────────────────────────────────────────────
  const profile = program
    .command("profile")
    .description("Invoice recipient, company name, billing address and tax id");
  profile
    .command("show", { isDefault: true })
    .description("Show the billing details")
    .action(async () => print(await callTool(requireConfig(), "get_billing_profile")));
  profile
    .command("set")
    .description("Update the billing details (only the flags you pass are changed)")
    .option("--invoice-email <email>")
    .option("--company-name <name>")
    .option("--invoice-locale <locale>", 'e.g. "it"')
    .option("--line1 <line1>")
    .option("--line2 <line2>")
    .option("--city <city>")
    .option("--state <state>")
    .option("--postal-code <code>")
    .option("--country <country>", "Two-letter code, e.g. IT")
    .action(async (o: Record<string, string | undefined>) => {
      const map: Record<string, string> = {
        invoiceEmail: "invoice_email",
        companyName: "company_name",
        invoiceLocale: "invoice_locale",
        line1: "address_line1",
        line2: "address_line2",
        city: "address_city",
        state: "address_state",
        postalCode: "address_postal_code",
        country: "address_country",
      };
      const args: Record<string, unknown> = {};
      for (const [flag, arg] of Object.entries(map)) if (o[flag] !== undefined) args[arg] = o[flag];
      print(await callTool(requireConfig(), "set_billing_profile", args));
    });
  profile
    .command("tax-id <value>")
    .description('Set the tax id printed on invoices (empty string removes it)')
    .option("--type <type>", 'Stripe tax id type, e.g. "eu_vat" (inferred from the country when omitted)')
    .action(async (value: string, o: { type?: string }) => {
      const args: Record<string, unknown> = { value };
      if (o.type) args.type = o.type;
      print(await callTool(requireConfig(), "set_tax_id", args));
    });

  const cards = program.command("cards").description("Saved payment methods");
  cards
    .command("list", { isDefault: true })
    .description("List saved cards and which one is the default")
    .action(async () => print(await callTool(requireConfig(), "list_payment_methods")));
  cards
    .command("default <payment_method_id>")
    .description("Bill future charges to this card")
    .action(async (id: string) =>
      print(await callTool(requireConfig(), "set_default_payment_method", { payment_method_id: id })),
    );
  cards
    .command("remove <payment_method_id>")
    .description("Remove a saved card (adding one needs a browser — use `portal`)")
    .action(async (id: string) =>
      print(await callTool(requireConfig(), "remove_payment_method", { payment_method_id: id })),
    );

  const invoice = program.command("invoice").description("A single invoice");
  invoice
    .command("show <invoice_id>")
    .description("Invoice detail")
    .action(async (id: string) => print(await callTool(requireConfig(), "view_invoice", { invoice_id: id })));
  invoice
    .command("download <invoice_id>")
    .description("A link to the invoice PDF")
    .action(async (id: string) => print(await callTool(requireConfig(), "download_invoice", { invoice_id: id })));
}

/** Shared parsing for the plan commands: the seat basket arrives as JSON. */
function planArgs(
  plan: string,
  o: { interval?: string; seats?: string; timing?: string },
): Record<string, unknown> {
  const args: Record<string, unknown> = { plan };
  if (o.interval) args.interval = o.interval;
  if (o.timing) args.timing = o.timing;
  if (o.seats) {
    try {
      args.seats = JSON.parse(o.seats);
    } catch {
      throw new Error(`--seats must be JSON, e.g. '{"standard":3}' (got: ${o.seats})`);
    }
  }
  return args;
}
