import { resolveConfig } from "../types.js";
import { registerKeyTools } from "./keys.js";
import { registerBillingOnlyTools } from "./billing.js";
import { ensurePlans } from "../plans.js";
// Keys whose values must never hit the logs (magic-auth codes, API keys, etc.).
const SENSITIVE_KEY_RE = /cookie|token|secret|password|passwd|authorization|api[_-]?key|session|credential|code/i;
function redactForLog(value, depth = 0) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "string" && value.length > 300) {
            return `${value.slice(0, 300)}…(${value.length} chars)`;
        }
        return value;
    }
    if (depth > 4)
        return "[…]";
    if (Array.isArray(value))
        return value.map((v) => redactForLog(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactForLog(v, depth + 1);
    }
    return out;
}
// Wrap server.tool so every handler logs its (redacted) input. Call before
// registering tools so both the live MCP server and the REST dispatch shadow
// server emit uniform [tool-input] lines.
export function installInputLogging(server) {
    const orig = server.tool.bind(server);
    server.tool = function (...args) {
        const name = args[0];
        const cbIdx = args.length - 1;
        const cb = args[cbIdx];
        if (typeof cb === "function" && typeof name === "string") {
            args[cbIdx] = async (toolArgs, extra) => {
                try {
                    console.log(`[tool-input] ${name} ${JSON.stringify(redactForLog(toolArgs))}`);
                }
                catch {
                    console.log(`[tool-input] ${name} (unserializable args)`);
                }
                return cb(toolArgs, extra);
            };
        }
        return orig(...args);
    };
}
// Register the billing-tools surface (auth/key management + token billing) on
// an MCP server. Host apps call this, then register their own product tools.
export function registerBillingTools(server, opts) {
    const config = resolveConfig(opts.config);
    if (opts.installLogging !== false)
        installInputLogging(server);
    registerKeyTools(server, opts.adapter, config);
    registerBillingOnlyTools(server, opts.adapter, config, opts.toolCosts ?? {});
    if (opts.plans)
        registerPlanTools(server, opts.plans, opts.defaultPlan, config.currency);
}
// list_plans: returns the configured plans + live Stripe prices, provisioning
// the Stripe products/prices on first call (idempotent). Zero dashboard setup.
function registerPlanTools(server, plans, defaultPlan, currency) {
    server.tool("list_plans", "List the available subscription plans (seats, included tokens, and monthly/yearly prices). Prices are provisioned in Stripe automatically.", {}, async () => {
        const ensured = await ensurePlans(plans, { currency });
        const priceOf = (plan, interval) => ensured.find((e) => e.plan === plan && e.interval === interval) ?? null;
        const out = Object.entries(plans).map(([key, def]) => ({
            plan: key,
            default: key === defaultPlan,
            seats: def.seats,
            tokens_per_seat: def.tokensPerSeat,
            prices: {
                monthly: { amount: def.price.monthly, currency, price_id: priceOf(key, "monthly")?.priceId ?? null },
                yearly: { amount: def.price.yearly, currency, price_id: priceOf(key, "yearly")?.priceId ?? null },
            },
        }));
        return { content: [{ type: "text", text: JSON.stringify({ plans: out }, null, 2) }] };
    });
}
export const BILLING_TOOL_NAMES = [
    "get_api_key",
    "list_api_keys",
    "revoke_api_key",
    "get_token_balance",
    "buy_tokens",
    "set_auto_reload",
    "list_invoices",
];
//# sourceMappingURL=register.js.map