import { runWithAuth } from "../auth.js";
import { ToolValidationError } from "../dispatch.js";

// Framework-light REST factories (standard Request/Response; works in Next app
// router). The host creates a dispatcher via createDispatcher(register) once and
// passes it in.

export interface Dispatcher {
  dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getToolNames(): string[];
}

function wwwAuth(realm: string): string {
  return `Bearer realm="${realm}", error="invalid_token"`;
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
export function createToolDispatchHandler(opts: { dispatcher: Dispatcher; realm?: string }) {
  const realm = opts.realm ?? "billing-tools";
  return async (
    request: Request,
    ctx: { params: Promise<{ tool: string }> },
  ): Promise<Response> => {
    const { tool } = await ctx.params;
    const authHeader = request.headers.get("authorization");
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
          return Response.json(result, { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm) } });
        }
        return Response.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/\bUnauthorized\b|\b401\b/i.test(message)) {
          return Response.json({ error: message }, { status: 401, headers: { "WWW-Authenticate": wwwAuth(realm) } });
        }
        const status =
          err instanceof ToolValidationError ? 400 : message.includes("Unknown tool") ? 404 : 500;
        return Response.json({ error: message }, { status });
      }
    });
  };
}
