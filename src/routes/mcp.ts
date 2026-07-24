import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter } from "../types.js";
import { runWithAuth, runWithResolvedOrg } from "../auth.js";

// MCP transport factory (uses mcp-handler, an optional peer dep — imported
// lazily so apps that don't mount MCP don't need it). Handles both the
// API-key path (runWithAuth → enforceAccess validates) and, if the adapter
// implements resolveOauthOrg, a pre-resolved OAuth JWT path.

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

function wwwAuth(realm: string, resourceMetadata?: string): string {
  const base = `Bearer realm="${realm}", error="invalid_token"`;
  return resourceMetadata ? `${base}, resource_metadata="${resourceMetadata}"` : base;
}

export function createMcpTransport(opts: McpTransportOptions) {
  const realm = opts.realm ?? "billing-tools";
  const apiKeyPrefix = opts.apiKeyPrefix ?? "sk_";
  let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;

  async function getHandler(): Promise<(req: Request) => Promise<Response>> {
    if (!handlerPromise) {
      handlerPromise = import("mcp-handler").then(({ createMcpHandler }) =>
        createMcpHandler((server) => opts.register(server), {}, { basePath: "/", maxDuration: opts.maxDuration ?? 60 }),
      );
    }
    return handlerPromise;
  }

  async function withAuthHeader(res: Response, rm?: string): Promise<Response> {
    if (res.status !== 401) return res;
    const headers = new Headers(res.headers);
    if (!headers.has("WWW-Authenticate")) headers.set("WWW-Authenticate", wwwAuth(realm, rm));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  async function handler(request: Request): Promise<Response> {
    const mcp = await getHandler();
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const rm =
      typeof opts.resourceMetadata === "function" ? opts.resourceMetadata(request) : opts.resourceMetadata;

    if (token && !token.startsWith(apiKeyPrefix) && opts.adapter.resolveOauthOrg) {
      const orgId = await opts.adapter.resolveOauthOrg(token);
      if (orgId) return runWithResolvedOrg(authHeader, orgId, () => mcp(request));
    }
    const res = await runWithAuth(authHeader, () => mcp(request));
    return withAuthHeader(res, rm);
  }

  return { GET: handler, POST: handler, maxDuration: opts.maxDuration ?? 60 };
}
