import { rmSync } from "node:fs";
import { callTool, type ApiClientConfig } from "./client.js";
import { toolCapabilities } from "../plan-model.js";
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

/**
 * The slice of a commander `Command` these commands actually use.
 *
 * Structural, so `commander` is not a dependency of this package at all — not even
 * a peer. It never was one at RUNTIME (the import was `import type`, which tsc
 * erases), but it sat in `dependencies`, so every consumer installed it to satisfy a
 * type. Both consumers already declare their own — they are the ones constructing
 * the program — so the copy here was duplication that also pinned them to a major.
 *
 * A real `Command` satisfies this by shape; `test/cli-shape.test.mjs` pins that,
 * because the risk of a structural type is drifting from the thing it describes.
 */
export interface CommandLike {
  command(nameAndArgs: string, opts?: { isDefault?: boolean; hidden?: boolean }): CommandLike;
  description(text: string): CommandLike;
  // Overloaded, like commander's own: a bare flag, a flag with a literal default, or
  // a flag with a coercion callback (`--limit <n>` → parseInt). A single signature
  // unioning the last two collapses to `unknown` and the callback loses its parameter
  // types, which is how the first attempt at this failed.
  option(flags: string, description?: string): CommandLike;
  option(
    flags: string,
    description: string,
    fn: (value: string, previous: unknown) => unknown,
    defaultValue?: unknown,
  ): CommandLike;
  option(
    flags: string,
    description: string,
    defaultValue: string | boolean | string[],
  ): CommandLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- commander's own signature
  action(handler: (...args: any[]) => unknown): CommandLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- commander's OptionValues
  opts(): Record<string, any>;
}

// Register the shared billing commands on a commander program (or subcommand).
// Reads global options --api-key / --url off `program`.
export function registerBillingCommands(program: CommandLike, opts: CliOptions) {
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
    .description("Buy credits (Checkout URL by default; --method saved_card charges the card on file)")
    // `--quote` rather than a second command: "what would this cost" is the same
    // intent as buying, one step earlier, and it keeps the CLI at parity with the
    // tool surface without adding a verb nobody would guess.
    .option("--quote", "Show credits, tax and total without opening a checkout")
    // The whole point of the flag: a terminal has no browser. `saved_card` completes the
    // purchase right here, `invoice` has Stripe email a payable one.
    .option("--method <method>", "checkout | saved_card | invoice")
    .action(async (amount: string, o: { quote?: boolean; method?: string }) =>
      print(
        await callTool(requireConfig(), o.quote ? "preview_credit_purchase" : "buy_credits", {
          amount: parseInt(amount, 10),
          ...(o.method && !o.quote ? { method: o.method } : {}),
        }),
      ),
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

  const keys = program.command("keys").description("Create, list and revoke API keys");
  keys
    .command("create <name>")
    .description("Create an additional API key with a name of your choosing (shown once)")
    .action(async (name: string) => print(await callTool(requireConfig(), "create_api_key", { name })));
  keys
    .command("list")
    .description("List API keys")
    .action(async () => print(await callTool(requireConfig(), "list_api_keys")));
  keys
    .command("revoke <id>")
    .description("Revoke an API key by id")
    .action(async (id: string) => print(await callTool(requireConfig(), "revoke_api_key", { api_key_id: id })));

  // ── Members ───────────────────────────────────────────────────────────────
  // NOT gated by the catalogue. Who is in a workspace is not something a plan decides, so
  // unlike `seats` and `topup` below these are always offered; a deployment whose adapter or
  // invitation service cannot serve one gets "Unknown tool", which is the honest answer for a
  // capability that genuinely is not wired.
  const members = program.command("members").description("Who is in the workspace, and invitations");
  members
    .command("list")
    .description("List members with their roles, plus how many seats the plan has left")
    .action(async () => print(await callTool(requireConfig(), "list_members")));
  members
    .command("invite <email>")
    .description("Invite somebody by email")
    .option("--role <slug>", "Role to grant (default: member)")
    .action(async (email: string, o: { role?: string }) =>
      print(
        await callTool(requireConfig(), "invite_member", {
          email,
          ...(o.role ? { role: o.role } : {}),
        }),
      ),
    );
  members
    .command("role <member_id> <role>")
    .description("Change a member's role (refuses the last admin)")
    .action(async (memberId: string, role: string) =>
      print(await callTool(requireConfig(), "change_member_role", { member_id: memberId, role })),
    );
  members
    .command("remove <member_id>")
    .description("Remove a member, clearing their seat and granted allowance first")
    .action(async (memberId: string) =>
      print(await callTool(requireConfig(), "remove_member", { member_id: memberId })),
    );

  const invites = program.command("invitations").description("Pending invitations");
  invites
    .command("list")
    .description("List invitations and their state")
    .action(async () => print(await callTool(requireConfig(), "list_invitations")));
  invites
    .command("revoke <invitation_id>")
    .description("Cancel a pending invitation, freeing the seat it holds")
    .action(async (id: string) =>
      print(await callTool(requireConfig(), "revoke_invitation", { invitation_id: id })),
    );

  // ── The workspace itself ──────────────────────────────────────────────────
  const workspace = program.command("workspace").description("Rename or close the workspace");
  workspace
    .command("rename <name>")
    .description("Rename the workspace")
    .action(async (name: string) => print(await callTool(requireConfig(), "rename_workspace", { name })));
  workspace
    .command("close")
    .description("Cancel the billing and keep the invoices. --delete also removes the workspace")
    .option("--period-end", "Let them use the period already paid for (cannot be combined with --delete)")
    .option("--delete", "Remove the workspace once its billing is stopped")
    .option("--reason <text>", "Recorded on the Stripe customer, so the kept record explains itself")
    .action(async (o: { periodEnd?: boolean; delete?: boolean; reason?: string }) =>
      print(
        await callTool(requireConfig(), "close_workspace", {
          ...(o.periodEnd ? { cancel_at: "period_end" } : {}),
          ...(o.delete ? { delete_workspace: true } : {}),
          ...(o.reason ? { reason: o.reason } : {}),
        }),
      ),
    );

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

  // Gated exactly as the TOOLS are, by the same `toolCapabilities`. A flat/pooled
  // catalogue registers no seat or top-up tools, so these commands could only ever
  // answer "Unknown tool" — and a customer cannot tell that from holding it wrong.
  // No catalogue passed means "the caller did not say", so everything registers.
  const caps = opts.plans ? toolCapabilities(opts.plans) : null;
  const has = (key: "seats" | "request" | "lifecycle") => !caps || caps[key];

  if (has("seats")) {
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
  }

  // `plans` and `plan show` are READS and always register, matching the tool rule:
  // "what is on offer" and "what am I on" are answerable on any catalogue, including
  // a wholly quote-only one. Only the moves that CHANGE a subscription need a plan a
  // customer can buy without a salesperson.
  registerPlanCommands(program, requireConfig, has("lifecycle"));
}

// ── Plans, the billing account, and the rest of the tool surface ────────────
//
// Split out only for length. The rule these follow: the CLI is a thin shell over
// the SAME tools the API and MCP expose, so a command exists here if and only if
// a tool exists there — a capability reachable from one surface and not another
// is the gap this whole pass was about.
function registerPlanCommands(
  program: CommandLike,
  requireConfig: () => ApiClientConfig,
  lifecycle: boolean,
) {
  program
    .command("plans")
    .description("List the available plans, with prices and included usage")
    .action(async () => print(await callTool(requireConfig(), "list_plans")));

  const plan = program.command("plan").description("Show and change this workspace's plan");
  plan
    .command("show", { isDefault: true })
    .description("Current plan, any scheduled change, the moves available, and who has asked to move up")
    .action(async () => print(await callTool(requireConfig(), "get_plan")));
  // Asking is not changing, so these are NOT behind the `lifecycle` gate below: the one
  // catalogue where asking matters most is the one whose plan you cannot self-serve out of.
  plan
    .command("request")
    .description("Ask an owner to move this workspace up a plan (does not change or charge anything)")
    .option("--plan <plan>", "Plan to ask for. Defaults to the next one up")
    .option("--note <note>", "A line for the owner")
    .action(async (o: { plan?: string; note?: string }) =>
      print(
        await callTool(requireConfig(), "request_plan_change", {
          ...(o.plan ? { plan: o.plan } : {}),
          ...(o.note ? { note: o.note } : {}),
        }),
      ),
    );
  plan
    .command("request-seat")
    .description("Ask an owner to move you to a bigger seat (does not change or charge anything)")
    .option("--seat <seatType>", "Seat type to ask for. Defaults to the next one up")
    .option("--note <note>", "A line for the owner")
    .action(async (o: { seat?: string; note?: string }) =>
      print(
        await callTool(requireConfig(), "request_seat_change", {
          ...(o.seat ? { seat_type: o.seat } : {}),
          ...(o.note ? { note: o.note } : {}),
        }),
      ),
    );
  plan
    .command("resolve <requestId>")
    .description("Mark a plan-change request handled or refused (admin)")
    .option("--deny", "Refuse it rather than recording it handled")
    .action(async (requestId: string, o: { deny?: boolean }) =>
      print(
        await callTool(requireConfig(), "resolve_plan_request", {
          request_id: requestId,
          decision: o.deny ? "denied" : "done",
        }),
      ),
    );
  // Only the three that CHANGE a subscription. On a catalogue that is entirely free
  // or quote-only there is no such move, so `change_plan` is not registered and these
  // could only refuse — while `plans` and `plan show` above stay useful reads.
  if (lifecycle) {
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
  }

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

  // The owner's view of the same question `limits` answers for one caller: who in the
  // workspace is at their cap. A command exists here if and only if a tool exists there.
  program
    .command("team-usage")
    .description("Every member measured against their own cap, and who is at or over it")
    .option("--include-api", "Also report the shared API caller")
    .action(async (o: { includeApi?: boolean }) =>
      print(
        await callTool(
          requireConfig(),
          "get_org_usage",
          o.includeApi ? { include_api: true } : {},
        ),
      ),
    );

  program
    .command("portal")
    .description("Open the Stripe billing portal (manage subscription, cards, invoices)")
    // `--flow payment_method_update` is how a terminal gets a card added: it cannot confirm
    // a SetupIntent, but it can print a link that opens on the card form.
    .option("--flow <flow>", "payment_method_update | subscription_cancel | subscription_update")
    .action(async (o: { flow?: string }) =>
      print(await callTool(requireConfig(), "get_billing_portal", o.flow ? { flow: o.flow } : {})),
    );

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

  // The customer's OWN ceiling, as opposed to the plan's rate limits — which is why
  // it sits under its own noun rather than inside `usage`: `usage limits` reports
  // what the product allows, `spend` sets what you allow yourself.
  //
  // Named `spend` and NOT `limit`, deliberately: `usage limits` already exists, and
  // two commands differing by a single letter is a footgun no description fixes.
  const spend = program
    .command("spend")
    .description("Your own monthly spending ceiling, and the thresholds to be warned at");
  spend
    .command("show", { isDefault: true })
    .description("Show the ceiling and alert thresholds")
    .action(async () => print(await callTool(requireConfig(), "get_spend_controls")));
  spend
    .command("limit <credits>")
    .description("Allow at most <credits> per calendar month. Pass 0 to remove the ceiling")
    .action(async (credits: string) =>
      print(
        await callTool(requireConfig(), "set_spend_controls", {
          limit_credits: parseInt(credits, 10),
        }),
      ),
    );
  spend
    .command("alerts [credits...]")
    .description("Warn at these credit thresholds. Pass none to clear them")
    .action(async (credits: string[]) =>
      print(
        await callTool(requireConfig(), "set_spend_controls", {
          alert_credits: credits.map((c) => parseInt(c, 10)),
        }),
      ),
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
