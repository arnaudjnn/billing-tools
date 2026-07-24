import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter } from "../types.js";
export interface McpTransportOptions {
    register: (server: McpServer) => void;
    adapter: BillingAdapter;
    realm?: string;
    /** Prefix that marks a raw API key (vs an OAuth JWT). Default "sk_". */
    apiKeyPrefix?: string;
    maxDuration?: number;
}
export declare function createMcpTransport(opts: McpTransportOptions): {
    GET: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
    maxDuration: number;
};
//# sourceMappingURL=mcp.d.ts.map