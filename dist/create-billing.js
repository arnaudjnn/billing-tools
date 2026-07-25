import { resolveConfig } from "./types.js";
import { registerBillingTools } from "./tools/register.js";
import { createDispatcher } from "./dispatch.js";
import { createToolListHandler, createToolDispatchHandler } from "./routes/rest.js";
import { createMcpTransport } from "./routes/mcp.js";
import { createStripeWebhookHandler } from "./routes/webhook.js";
import { createAgentAuth, } from "./agent-auth/index.js";
export function createBilling(opts) {
    const resolved = resolveConfig(opts.config);
    const agentAuth = opts.agentAuth
        ? createAgentAuth({ adapter: opts.adapter, config: resolved, ...opts.agentAuth })
        : undefined;
    const resourceMetadata = agentAuth
        ? (request) => agentAuth.resourceMetadataUrl(request)
        : undefined;
    // ONE registrar used by both the dispatcher (REST shadow server) and the live
    // MCP server, so the two surfaces expose an identical tool set.
    const register = (server) => {
        registerBillingTools(server, {
            adapter: opts.adapter,
            config: resolved,
            toolCosts: opts.toolCosts,
            plans: opts.plans,
            defaultPlan: opts.defaultPlan,
        });
        opts.registerTools?.(server);
    };
    const dispatcher = createDispatcher(register);
    const restList = createToolListHandler({ dispatcher, toolCosts: opts.toolCosts });
    const restDispatch = createToolDispatchHandler({ dispatcher, realm: opts.realm, resourceMetadata });
    const mcp = createMcpTransport({
        register,
        adapter: opts.adapter,
        realm: opts.realm,
        apiKeyPrefix: opts.mcp?.apiKeyPrefix,
        maxDuration: opts.mcp?.maxDuration,
        resourceMetadata,
    });
    const webhook = opts.webhook === false
        ? undefined
        : createStripeWebhookHandler({ currency: opts.webhook?.currency ?? resolved.currency });
    return {
        adapter: opts.adapter,
        config: resolved,
        register,
        dispatcher,
        /** MCP transport: mount `export const { GET, POST } = mcp` in app/[transport]/route.ts. */
        mcp,
        /** GET /api/v0 tool list handler. */
        restList,
        /** POST /api/v0/[tool] dispatch handler. */
        restDispatch,
        /** Stripe webhook POST handler (undefined if `webhook: false`). */
        webhook,
        /** auth.md handlers (undefined unless `agentAuth` was configured). */
        agentAuth,
    };
}
//# sourceMappingURL=create-billing.js.map