import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter } from "../types.js";
export interface McpTransportOptions {
    register: (server: McpServer) => void;
    adapter: BillingAdapter;
    realm?: string;
    /** Prefix that marks a raw API key (vs an OAuth JWT). Default "sk_". */
    apiKeyPrefix?: string;
    maxDuration?: number;
    /** Advertise the auth.md PRM discovery doc in the 401 WWW-Authenticate header
     *  (`resource_metadata="…"`) so agents can bootstrap. String or per-request. */
    resourceMetadata?: string | ((request: Request) => string);
}
export declare function createMcpTransport(opts: McpTransportOptions): {
    GET: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
    maxDuration: number;
};
//# sourceMappingURL=mcp.d.ts.map