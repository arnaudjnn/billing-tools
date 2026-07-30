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
    .description("Get current token balance and tool costs")
    .action(async () => print(await callTool(requireConfig(), "get_token_balance")));

  program
    .command("buy <amount>")
    .description("Buy tokens (returns a Stripe Checkout URL)")
    .action(async (amount: string) =>
      print(await callTool(requireConfig(), "buy_tokens", { amount: parseInt(amount, 10) })),
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
    .description("Get workspace token usage for the current cycle")
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

  // ── Token top-up requests ─────────────────────────────────────────────────
  const topup = program
    .command("topup")
    .description("Token top-up requests (a seat over its cap → owner approval)");
  topup
    .command("list")
    .description("List top-up requests (pending and handled)")
    .action(async () => print(await callTool(requireConfig(), "list_top_up_requests")));
  topup
    .command("request <member_id> <amount>")
    .description("Request extra tokens for a member's seat this cycle")
    .option("--cycle <cycle>", 'Cycle key the grant applies to (default current "YYYY-MM")')
    .action(async (memberId: string, amount: string, o: { cycle?: string }) => {
      const args: Record<string, unknown> = { member_id: memberId, amount: parseInt(amount, 10) };
      if (o.cycle) args.cycle = o.cycle;
      print(await callTool(requireConfig(), "request_top_up", args));
    });
  topup
    .command("approve <request_id>")
    .description("Approve a pending top-up request (grants the extra tokens)")
    .action(async (id: string) => print(await callTool(requireConfig(), "approve_top_up", { request_id: id })));
  topup
    .command("deny <request_id>")
    .description("Deny a pending top-up request")
    .action(async (id: string) => print(await callTool(requireConfig(), "deny_top_up", { request_id: id })));
}
