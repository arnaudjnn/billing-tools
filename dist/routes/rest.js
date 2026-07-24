import { runWithAuth } from "../auth.js";
import { ToolValidationError } from "../dispatch.js";
function wwwAuth(realm, resourceMetadata) {
    const base = `Bearer realm="${realm}", error="invalid_token"`;
    return resourceMetadata ? `${base}, resource_metadata="${resourceMetadata}"` : base;
}
// GET /api/v0 → { tools: [{ name, cost }] }
export function createToolListHandler(opts) {
    return async (request) => {
        const authHeader = request.headers.get("authorization");
        return runWithAuth(authHeader, async () => {
            try {
                const names = opts.dispatcher.getToolNames();
                return Response.json({
                    tools: names.map((name) => ({ name, cost: opts.toolCosts?.[name] ?? 0 })),
                });
            }
            catch (err) {
                return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
            }
        });
    };
}
function isUnauthorizedResult(result) {
    if (!result || typeof result !== "object")
        return false;
    const r = result;
    if (!r.isError || !Array.isArray(r.content))
        return false;
    return r.content.some((c) => typeof c.text === "string" && /\bUnauthorized\b/i.test(c.text));
}
// POST /api/v0/[tool] → dispatch. Next passes ctx.params as a Promise.
export function createToolDispatchHandler(opts) {
    const realm = opts.realm ?? "billing-tools";
    return async (request, ctx) => {
        const { tool } = await ctx.params;
        const authHeader = request.headers.get("authorization");
        const rm = typeof opts.resourceMetadata === "function" ? opts.resourceMetadata(request) : opts.resourceMetadata;
        return runWithAuth(authHeader, async () => {
            try {
                const body = await request.json().catch(() => ({}));
                const result = await opts.dispatcher.dispatchTool(tool, body);
                if (result && typeof result === "object" && result.status === "try_again_later") {
                    const retryAfter = result.retry_after_seconds;
                    return Response.json(result, {
                        status: 429,
                        headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
                    });
                }
                if (isUnauthorizedResult(result)) {
                    return Response.json(result, { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm, rm) } });
                }
                return Response.json(result);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (/\bUnauthorized\b|\b401\b/i.test(message)) {
                    return Response.json({ error: message }, { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm, rm) } });
                }
                const status = err instanceof ToolValidationError ? 400 : message.includes("Unknown tool") ? 404 : 500;
                return Response.json({ error: message }, { status });
            }
        });
    };
}
//# sourceMappingURL=rest.js.map