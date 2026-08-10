import { operatorFromRequest, runWithAuth, runWithPrincipal, type Principal } from "../auth.js";
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
  /**
   * Names to withhold from a caller who is not a platform operator.
   *
   * The dispatcher keeps them — an operator calls them through this same surface — so this
   * is what a caller is TOLD exists, not what exists. `createBilling` passes
   * `OPERATOR_TOOL_NAMES`.
   */
  operatorTools?: readonly string[];
  /** How this deployment decides. Defaults to the env-configured operator check. */
  isOperator?: (request: Request) => boolean | Promise<boolean>;
}) {
  return async (request: Request): Promise<Response> => {
    const authHeader = request.headers.get("authorization");
    const hidden = opts.operatorTools?.length
      ? (await (opts.isOperator?.(request) ?? operatorFromRequest(request)))
        ? []
        : opts.operatorTools
      : [];
    return runWithAuth(authHeader, async () => {
      try {
        const names = opts.dispatcher.getToolNames().filter((n) => !hidden.includes(n));
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
  /**
   * WHO is calling, when this surface knows — a session cookie, an OAuth token carrying
   * a user id. Return null for a request that carries only an org API key.
   *
   * Without it the admin-only tools cannot be enforced through this route AT ALL, which
   * was true until now: `runWithAuth` installs a fresh AsyncLocalStorage store, so an
   * outer `runWithPrincipal` was discarded, `currentPrincipal()` read null, and
   * `enforceAdmin` took its org-key branch and allowed everything. An app whose own UI
   * calls these endpoints was relying on gating it did itself, or on nothing.
   *
   * Only pass `isAdmin` if you have already resolved the role and want to skip the
   * adapter lookup — otherwise leave it off and let `adapter.isAdmin` answer, which is
   * the path that reads the real role.
   */
  principal?: (request: Request) => Principal | null | Promise<Principal | null>;
  /**
   * The MPP gate, when the app accepts machine payments. Turns the empty-wallet 402
   * below into an OFFER: the same refusal comes back carrying a `WWW-Authenticate:
   * Payment` challenge, and a caller that settles it has its call dispatched.
   *
   * This lives here because the 402 is written here. Both consumers had wrapped this
   * handler to do it — clone the request, dispatch, look for a 402, call
   * `requirePayment`, dispatch again — which is the same ten lines twice, in the one
   * place where getting the retry wrong means either charging twice or serving for
   * free. `createBilling` wires it automatically whenever `machinePayment` is
   * configured.
   *
   * Only the money 402. A 429 is a rate or spend limit and no payment lifts either.
   */
  payment?: {
    requirePayment(request: Request): Promise<Response | { paid: true }>;
  };
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
    const principal = opts.principal ? await opts.principal(request) : null;
    // The machine half of the operator gate. A header rather than the Bearer slot because
    // an operator agent still holds a workspace key: it is acting FOR the deployment on
    // somebody else's workspace, so the two credentials answer different questions.
    const operatorToken = request.headers.get("x-operator-token")?.trim() || undefined;
    // One store either way: `runWithPrincipal` sets the same `authHeader` plus the
    // caller, so `enforceAccess` behaves identically and only `enforceAdmin` sees more.
    const withContext = <T>(fn: () => T): T =>
      principal
        ? runWithPrincipal({ authHeader, principal, operatorToken }, fn)
        : runWithAuth(authHeader, fn, { operatorToken });
    // Read the body ONCE, up front. The paid retry below re-dispatches, and a Request
    // body can only be read once — parsing here (rather than cloning the request) is
    // what makes the retry a plain second call with the same arguments.
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return withContext(async () => {
      try {
        const result = await opts.dispatcher.dispatchTool(tool, body);
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
        // 403 for a role refusal, for the same reason as the 402 above: `enforceAdmin`
        // writes "Forbidden (403)" and every one of those was being served as a 500 —
        // telling the caller the server is broken when the truthful answer is "you are
        // not an admin of this workspace", which is not a fault and not retryable.
        const status =
          err instanceof ToolValidationError
            ? 400
            : /\bInsufficient credits\b/i.test(message)
              ? 402
              : /\bForbidden\b|\b403\b/i.test(message)
                ? 403
                : message.includes("Unknown tool")
                  ? 404
                  : 500;
        // An empty wallet is the one refusal a payment can lift, so offer to take one.
        // Paid, the wallet was credited (`creditWallet`) and the call is dispatched
        // again — properly metered, because paying funds the meter rather than skipping
        // it. Unpaid, the caller holds the challenge instead of a dead end.
        if (status === 402 && opts.payment) {
          const paid = await opts.payment.requirePayment(request);
          if (paid instanceof Response) return paid;
          const result = await opts.dispatcher.dispatchTool(tool, body);
          return Response.json(result);
        }
        return Response.json({ error: message }, { status });
      }
    });
  };
}
