import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "../types.js";
export declare function installInputLogging(server: McpServer): void;
export interface RegisterBillingToolsOptions {
    adapter: BillingAdapter;
    config: BillingConfig;
    /** Per-tool token costs (for get_token_balance to echo). Usually from tools.json. */
    toolCosts?: Record<string, number>;
    /** Install the redacted [tool-input] logging wrapper. Default true. */
    installLogging?: boolean;
}
export declare function registerBillingTools(server: McpServer, opts: RegisterBillingToolsOptions): void;
export declare const BILLING_TOOL_NAMES: readonly ["get_api_key", "list_api_keys", "revoke_api_key", "get_token_balance", "buy_tokens", "set_auto_reload", "list_invoices"];
//# sourceMappingURL=register.d.ts.map