import { rmSync } from "node:fs";
import { callTool } from "./client.js";
import { configPath, readConfig, writeConfig, resolveBaseUrl, resolveApiKey, } from "./config.js";
function extractApiKey(result) {
    const visit = (v) => {
        if (typeof v === "string") {
            const m = v.match(/sk_[A-Za-z0-9_-]+/);
            return m ? m[0] : undefined;
        }
        if (v && typeof v === "object") {
            for (const x of Object.values(v)) {
                const found = visit(x);
                if (found)
                    return found;
            }
        }
        return undefined;
    };
    return visit(result);
}
function print(data) {
    console.log(JSON.stringify(data, null, 2));
}
// Register the shared billing commands on a commander program (or subcommand).
// Reads global options --api-key / --url off `program`.
export function registerBillingCommands(program, opts) {
    const requireConfig = () => {
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
        .action(async (email, o) => {
        const baseUrl = resolveBaseUrl(opts, program.opts().url);
        const apiKey = resolveApiKey(opts, program.opts().apiKey) || "bootstrap";
        const args = { email };
        if (o.code)
            args.code = o.code;
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
        }
        catch {
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
        .action(async (amount) => print(await callTool(requireConfig(), "buy_tokens", { amount: parseInt(amount, 10) })));
    program
        .command("invoices")
        .description("List recent invoices")
        .option("--limit <n>", "Number to return (default 10)", (v) => parseInt(v, 10))
        .action(async (o) => {
        const args = {};
        if (o.limit)
            args.limit = o.limit;
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
        .action(async (id) => print(await callTool(requireConfig(), "revoke_api_key", { api_key_id: id })));
}
//# sourceMappingURL=commands.js.map