import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "../types.js";
import { resolveConfig } from "../types.js";
import { registerKeyTools } from "./keys.js";
import { registerBillingOnlyTools } from "./billing.js";

// Keys whose values must never hit the logs (magic-auth codes, API keys, etc.).
const SENSITIVE_KEY_RE =
  /cookie|token|secret|password|passwd|authorization|api[_-]?key|session|credential|code/i;

function redactForLog(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 300) {
      return `${value.slice(0, 300)}…(${value.length} chars)`;
    }
    return value;
  }
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactForLog(v, depth + 1);
  }
  return out;
}

// Wrap server.tool so every handler logs its (redacted) input. Call before
// registering tools so both the live MCP server and the REST dispatch shadow
// server emit uniform [tool-input] lines.
export function installInputLogging(server: McpServer) {
  const orig = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = function (...args: unknown[]) {
    const name = args[0];
    const cbIdx = args.length - 1;
    const cb = args[cbIdx];
    if (typeof cb === "function" && typeof name === "string") {
      args[cbIdx] = async (toolArgs: unknown, extra: unknown) => {
        try {
          console.log(`[tool-input] ${name} ${JSON.stringify(redactForLog(toolArgs))}`);
        } catch {
          console.log(`[tool-input] ${name} (unserializable args)`);
        }
        return (cb as (a: unknown, e: unknown) => unknown)(toolArgs, extra);
      };
    }
    return orig(...args);
  };
}

export interface RegisterBillingToolsOptions {
  adapter: BillingAdapter;
  config: BillingConfig;
  /** Per-tool token costs (for get_token_balance to echo). Usually from tools.json. */
  toolCosts?: Record<string, number>;
  /** Install the redacted [tool-input] logging wrapper. Default true. */
  installLogging?: boolean;
}

// Register the billing-tools surface (auth/key management + token billing) on
// an MCP server. Host apps call this, then register their own product tools.
export function registerBillingTools(server: McpServer, opts: RegisterBillingToolsOptions) {
  const config = resolveConfig(opts.config);
  if (opts.installLogging !== false) installInputLogging(server);
  registerKeyTools(server, opts.adapter, config);
  registerBillingOnlyTools(server, opts.adapter, config, opts.toolCosts ?? {});
}

export const BILLING_TOOL_NAMES = [
  "get_api_key",
  "list_api_keys",
  "revoke_api_key",
  "get_token_balance",
  "buy_tokens",
  "set_auto_reload",
  "list_invoices",
] as const;
