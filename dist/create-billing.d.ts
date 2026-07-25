import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "./types.js";
import { type AgentAuthBranding, type AgentAuthPaths, type AgentAuthPolicy, type AgentIdentityType } from "./agent-auth/index.js";
import type { ClaimStore } from "./agent-auth/claim-store.js";
import type { PlansConfig } from "./plans.js";
export interface CreateBillingOptions {
    /** Storage adapter (WorkOSOrgAdapter or your own). */
    adapter: BillingAdapter;
    /** Billing config; resolved once internally. */
    config: BillingConfig;
    /** Per-tool token costs (echoed by get_token_balance + the REST tool list). */
    toolCosts?: Record<string, number>;
    /** WWW-Authenticate realm on 401s. */
    realm?: string;
    /** Declarative plans → auto-provisioned Stripe products/prices + list_plans. */
    plans?: PlansConfig;
    defaultPlan?: string;
    /** Register your app's own product tools alongside the billing tools. */
    registerTools?: (server: McpServer) => void;
    /** Enable auth.md agent self-registration. Omit to leave it off. */
    agentAuth?: {
        branding: AgentAuthBranding;
        identityTypes?: AgentIdentityType[];
        baseUrl?: string | ((request: Request) => string);
        policy?: AgentAuthPolicy;
        asMetadataExtra?: Record<string, unknown>;
        paths?: AgentAuthPaths;
        claimStore?: ClaimStore;
    };
    /** Stripe webhook handler. Defaults on (currency from config); `false` to skip. */
    webhook?: {
        currency?: string;
    } | false;
    /** MCP transport overrides. */
    mcp?: {
        apiKeyPrefix?: string;
        maxDuration?: number;
    };
}
export declare function createBilling(opts: CreateBillingOptions): {
    adapter: BillingAdapter;
    config: Required<BillingConfig>;
    register: (server: McpServer) => void;
    dispatcher: {
        dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
        getToolNames: () => string[];
    };
    /** MCP transport: mount `export const { GET, POST } = mcp` in app/[transport]/route.ts. */
    mcp: {
        GET: (request: Request) => Promise<Response>;
        POST: (request: Request) => Promise<Response>;
        maxDuration: number;
    };
    /** GET /api/v0 tool list handler. */
    restList: (request: Request) => Promise<Response>;
    /** POST /api/v0/[tool] dispatch handler. */
    restDispatch: (request: Request, ctx: {
        params: Promise<{
            tool: string;
        }>;
    }) => Promise<Response>;
    /** Stripe webhook POST handler (undefined if `webhook: false`). */
    webhook: ((request: Request) => Promise<Response>) | undefined;
    /** auth.md handlers (undefined unless `agentAuth` was configured). */
    agentAuth: {
        protectedResource: (request: Request) => Response;
        authorizationServer: (request: Request) => Response;
        authMd: (request: Request) => Response;
        identity: (request: Request) => Promise<Response>;
        claim: (request: Request) => Promise<Response>;
        token: (request: Request) => Promise<Response>;
        handleClaimGrant: (params: Record<string, string>) => Promise<Response>;
        revoke: (request: Request) => Promise<Response>;
        resourceMetadataUrl: (request: Request) => string;
        wwwAuthenticate: (request: Request) => string;
    } | undefined;
};
//# sourceMappingURL=create-billing.d.ts.map