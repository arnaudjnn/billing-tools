import { runWithAuth } from "../auth.js";
import { ToolValidationError } from "../dispatch.js";

// Framework-light REST factories (standard Request/Response; works in Next app
// router). The host creates a dispatcher via createDispatcher(register) once and
// passes it in.

export interface Dispatcher {
  dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getToolNames(): string[];
}

function wwwAuth(realm: string, resourceMetadata?: string): string {
  const base = `Bearer realm="${realm}", error="invalid_token"`;
  return resourceMetadata ? `${base}, resource_metadata="${resourceMetadata}"` : base;
}

// GET /api/v0 → { tools: [{ name, cost }] }
export function createToolListHandler(opts: {
  dispatcher: Dispatcher;
  toolCosts?: Record<string, number>;
}) {
  return async (request: Request): Promise<Response> => {
    const authHeader = request.headers.get("authorization");
    return runWithAuth(authHeader, async () => {
      try {
        const names = opts.dispatcher.getToolNames();
        return Response.json({
          tools: names.map((name) => ({ name, cost: opts.toolCosts?.[name] ?? 0 })),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    });
  };
}

function isUnauthorizedResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  if (!r.isError || !Array.isArray(r.content)) return false;
  return r.content.some((c) => typeof c.text === "string" && /\bUnauthorized\b/i.test(c.text));
}

// POST /api/v0/[tool] → dispatch. Next passes ctx.params as a Promise.
export function createToolDispatchHandler(opts: {
  dispatcher: Dispatcher;
  realm?: string;
  /** Advertise the auth.md PRM discovery doc in the 401 WWW-Authenticate header
   *  (`resource_metadata="…"`) so agents can bootstrap. String or per-request. */
  resourceMetadata?: string | ((request: Request) => string);
}) {
  const realm = opts.realm ?? "billing-tools";
  return async (
    request: Request,
    ctx: { params: Promise<{ tool: string }> },
  ): Promise<Response> => {
    const { tool } = await ctx.params;
    const authHeader = request.headers.get("authorization");
    const rm =
      typeof opts.resourceMetadata === "function" ? opts.resourceMetadata(request) : opts.resourceMetadata;
    return runWithAuth(authHeader, async () => {
      try {
        const body = await request.json().catch(() => ({}));
        const result = await opts.dispatcher.dispatchTool(tool, body as Record<string, unknown>);
        if (result && typeof result === "object" && (result as { status?: string }).status === "try_again_later") {
          const retryAfter = (result as { retry_after_seconds?: number }).retry_after_seconds;
          return Response.json(result, {
            status: 429,
            headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
          });
        }
        if (isUnauthorizedResult(result)) {
          return Response.json(result, { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm, rm) } });
        }
        return Response.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/\bUnauthorized\b|\b401\b/i.test(message)) {
          return Response.json({ error: message }, { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm, rm) } });
        }
        // 402 for an empty wallet, because this library is the one that WROTE that
        // message (`enforceCredits`, `describeDenial`) and 500 tells the caller the
        // server is broken when the truthful answer is "buy credits" — the one
        // refusal an agent can act on without a human. A consumer had already
        // hand-rolled this mapping over the same string; it belongs here, next to
        // the 401 and 429 that were already mapped for the same reason.
        const status =
          err instanceof ToolValidationError
            ? 400
            : /\bInsufficient credits\b/i.test(message)
              ? 402
              : message.includes("Unknown tool")
                ? 404
                : 500;
        return Response.json({ error: message }, { status });
      }
    });
  };
}
