import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter } from "../types.js";
import { runWithAuth, runWithPrincipal, runWithResolvedOrg, type Principal } from "../auth.js";

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
  /**
   * Require a resolvable org before the MCP handler runs at all, so the HANDSHAKE
   * is gated too — `initialize` and `tools/list`, not just the tool calls.
   *
   * Default false, which is the looser posture and the one every deployment on this
   * factory already has: each tool calls `enforceAccess` itself, so an anonymous
   * client can complete the handshake and enumerate the catalogue, then be refused
   * on every call. That is fine for a public catalogue and wrong for a private one —
   * "which tools exist, and what do they cost" is itself information, and an
   * unauthenticated client that connects successfully and fails on use looks like a
   * broken product rather than a closed door.
   *
   * On, a request with no usable credential gets 401 + `WWW-Authenticate` before the
   * handler is reached, which is also what starts OAuth discovery.
   */
  requireAuth?: boolean;
  /**
   * WHO is calling, when this surface knows — see `createToolDispatchHandler`. An MCP
   * client authenticating with an org API key has no user behind it, so this stays null
   * for the common case; an OAuth path that resolved a user should return one, or the
   * admin-only tools cannot be enforced here either.
   */
  principal?: (request: Request) => Principal | null | Promise<Principal | null>;
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

    const principal = opts.principal ? await opts.principal(request) : null;

    if (token && !token.startsWith(apiKeyPrefix) && opts.adapter.resolveOauthOrg) {
      const orgId = await opts.adapter.resolveOauthOrg(token);
      if (orgId) {
        return principal
          ? runWithPrincipal({ authHeader, orgId, principal }, () => mcp(request))
          : runWithResolvedOrg(authHeader, orgId, () => mcp(request));
      }
    }

    // Gated: resolve the org HERE, so a caller with no usable credential never
    // reaches the handshake. An API key is validated through the adapter; anything
    // else has already had its chance above.
    if (opts.requireAuth) {
      let orgId: string | null = null;
      if (token) {
        try {
          orgId = token.startsWith(apiKeyPrefix)
            ? ((await opts.adapter.validateApiKey(token))?.orgId ?? null)
            : null;
        } catch {
          orgId = null;
        }
      }
      if (!orgId) {
        return Response.json(
          { error: "unauthorized" },
          { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm, rm) } },
        );
      }
      // Pre-resolved, so `enforceAccess` reads it from the store rather than
      // validating the same key a second time on every tool call.
      return principal
        ? runWithPrincipal({ authHeader, orgId, principal }, () => mcp(request))
        : runWithResolvedOrg(authHeader, orgId, () => mcp(request));
    }

    const res = await (principal
      ? runWithPrincipal({ authHeader, principal }, () => mcp(request))
      : runWithAuth(authHeader, () => mcp(request)));
    return withAuthHeader(res, rm);
  }

  return { GET: handler, POST: handler, maxDuration: opts.maxDuration ?? 60 };
}
