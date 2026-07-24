import { runWithAuth, runWithResolvedOrg } from "../auth.js";
function wwwAuth(realm) {
    return `Bearer realm="${realm}", error="invalid_token"`;
}
export function createMcpTransport(opts) {
    const realm = opts.realm ?? "billing-tools";
    const apiKeyPrefix = opts.apiKeyPrefix ?? "sk_";
    let handlerPromise = null;
    async function getHandler() {
        if (!handlerPromise) {
            handlerPromise = import("mcp-handler").then(({ createMcpHandler }) => createMcpHandler((server) => opts.register(server), {}, { basePath: "/", maxDuration: opts.maxDuration ?? 60 }));
        }
        return handlerPromise;
    }
    async function withAuthHeader(res) {
        if (res.status !== 401)
            return res;
        const headers = new Headers(res.headers);
        if (!headers.has("WWW-Authenticate"))
            headers.set("WWW-Authenticate", wwwAuth(realm));
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    async function handler(request) {
        const mcp = await getHandler();
        const authHeader = request.headers.get("authorization");
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (token && !token.startsWith(apiKeyPrefix) && opts.adapter.resolveOauthOrg) {
            const orgId = await opts.adapter.resolveOauthOrg(token);
            if (orgId)
                return runWithResolvedOrg(authHeader, orgId, () => mcp(request));
        }
        const res = await runWithAuth(authHeader, () => mcp(request));
        return withAuthHeader(res);
    }
    return { GET: handler, POST: handler, maxDuration: opts.maxDuration ?? 60 };
}
//# sourceMappingURL=mcp.js.map