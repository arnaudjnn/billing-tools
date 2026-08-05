// The four ways a call can arrive, so a section can say "as a member" and mean it.
//
// Each resolves `{ ok, value, error }` instead of throwing, because `dispatchTool` throws
// on an `isError` tool result and the entire roles matrix is about READING those messages.
// A try/catch per probe, 39 times over, would bury the assertion.

import { runWithAuth, runWithPrincipal } from "../../dist/auth.js";

export function makeCallers({ dispatcher, restDispatch, apiKey, adminUserId, memberUserId }) {
  const header = `Bearer ${apiKey}`;

  const settle = async (fn) => {
    try {
      return { ok: true, value: await fn(), error: null };
    } catch (e) {
      return { ok: false, value: null, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /** An org API key with no human behind it — the headless-agent case, owner-level by
   *  design (auth.ts: no principal → allow). */
  const asOrgKey = (tool, args = {}) =>
    settle(() => runWithAuth(header, () => dispatcher.dispatchTool(tool, args)));

  /**
   * A known human. `isAdmin` is deliberately NOT passed: setting it short-circuits the
   * adapter lookup, and hitting real WorkOS is the entire point of these two.
   */
  const asPrincipal = (userId) => (tool, args = {}) =>
    settle(() =>
      runWithPrincipal({ authHeader: header, principal: { userId } }, () =>
        dispatcher.dispatchTool(tool, args),
      ),
    );

  /**
   * Through the real REST handler, so the HTTP mapping is exercised too — the status a
   * refusal becomes, and the `WWW-Authenticate` on a 401.
   *
   * `ctx.params` must be a Promise: Next passes it that way and the handler awaits it.
   */
  const viaRest = async (tool, args = {}, { token = apiKey, principal = null } = {}) => {
    const handler = restDispatch(principal);
    const request = new Request(`https://e2e.test/api/v0/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(args),
    });
    const res = await handler(request, { params: Promise.resolve({ tool }) });
    const body = await res.json().catch(() => null);
    return {
      status: res.status,
      body,
      wwwAuthenticate: res.headers.get("WWW-Authenticate"),
      error: body && typeof body === "object" ? body.error ?? null : null,
    };
  };

  return {
    asOrgKey,
    asAdmin: asPrincipal(adminUserId),
    asMember: asPrincipal(memberUserId),
    viaRest,
  };
}
