// What the HTTP layer says when a tool refuses.
//
// A tool result is a 200-shaped envelope; the route factories are what turn a
// refusal into a status an HTTP client can act on. Two of those mappings were
// already here (401 for unauthorized, 429 for try_again_later) and one was not,
// which is how a consumer came to hand-roll it over the same string.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { createToolDispatchHandler, createToolListHandler } from "../dist/routes/rest.js";
import { createMcpTransport } from "../dist/routes/mcp.js";
import { ToolValidationError } from "../dist/dispatch.js";

const ctx = { params: Promise.resolve({ tool: "whatever" }) };
const post = (body = {}) =>
  new Request("https://t.local/api/v0/whatever", {
    method: "POST",
    headers: { authorization: "Bearer sk_x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A dispatcher that fails the way the engine actually fails: by throwing. */
const throwing = (err) => ({
  async dispatchTool() {
    throw err;
  },
  getToolNames: () => [],
});

test("an empty wallet is 402, not 500", async () => {
  // This library WRITES that message (enforceCredits / describeDenial), so it is the
  // one place that can map it. 500 tells the caller the server is broken when the
  // truthful answer is "buy credits" — the one refusal an agent can act on with no
  // human in the loop.
  const handler = createToolDispatchHandler({
    dispatcher: throwing(
      new Error("Insufficient credits. This tool costs 5 credits but you only have 0."),
    ),
  });
  const res = await handler(post(), ctx);
  assert.equal(res.status, 402);
});

test("the other mappings are unchanged", async () => {
  const cases = [
    [new ToolValidationError("Invalid arguments for x: y: required"), 400],
    [new Error("Unauthorized (401)"), 401],
    [new Error("Unknown tool: nope"), 404],
    [new Error("something actually broke"), 500],
  ];
  for (const [err, expected] of cases) {
    const handler = createToolDispatchHandler({ dispatcher: throwing(err) });
    const res = await handler(post(), ctx);
    assert.equal(res.status, expected, `${err.message} should be ${expected}`);
  }
});

test("a 401 always carries WWW-Authenticate, with the PRM doc when there is one", async () => {
  const handler = createToolDispatchHandler({
    dispatcher: throwing(new Error("Unauthorized (401)")),
    realm: "gtm-tools",
    resourceMetadata: "https://t.local/.well-known/oauth-protected-resource",
  });
  const res = await handler(post(), ctx);
  const header = res.headers.get("WWW-Authenticate");
  assert.match(header, /realm="gtm-tools"/);
  assert.match(header, /resource_metadata="https:\/\/t\.local/);
});

test("the tool list reports costs, defaulting to 0", async () => {
  const handler = createToolListHandler({
    dispatcher: { async dispatchTool() {}, getToolNames: () => ["a", "b"] },
    toolCosts: { a: 7 },
  });
  const res = await handler(new Request("https://t.local/api/v0"));
  assert.deepEqual(await res.json(), { tools: [{ name: "a", cost: 7 }, { name: "b", cost: 0 }] });
});

// ── The MCP handshake ────────────────────────────────────────────────────────

const adapter = {
  async validateApiKey(token) {
    return token === "sk_good" ? { orgId: "org_1" } : null;
  },
  async getOrgDomains() {
    return [];
  },
};

const mcpPost = (auth) =>
  new Request("https://t.local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("requireAuth gates the handshake, not just the tool calls", async () => {
  // Off, every tool enforces access itself, so an anonymous client completes the
  // handshake and enumerates the catalogue — fine for a public one, wrong for a
  // private one, and it reads as a broken product rather than a closed door.
  const transport = createMcpTransport({
    register: () => {},
    adapter,
    realm: "gtm-tools",
    requireAuth: true,
    resourceMetadata: "https://t.local/.well-known/oauth-protected-resource",
  });

  const anon = await transport.POST(mcpPost());
  assert.equal(anon.status, 401, "an anonymous handshake must not reach the handler");
  assert.match(anon.headers.get("WWW-Authenticate"), /resource_metadata=/);

  const bad = await transport.POST(mcpPost("Bearer sk_nope"));
  assert.equal(bad.status, 401, "an unknown key must not reach the handler either");
});

test("requireAuth defaults off, so no existing deployment's posture changes", async () => {
  const transport = createMcpTransport({ register: () => {}, adapter, realm: "r" });
  const anon = await transport.POST(mcpPost());
  // Whatever mcp-handler answers, it must have been REACHED — the point is that the
  // transport did not refuse it itself.
  assert.notEqual(anon.status, 401);
});

// ── 403, and the principal that makes it reachable ───────────────────────────
//
// `enforceAdmin` writes "Forbidden (403)", and every one of those was served as HTTP
// 500 — telling the caller the server is broken when the truthful answer is "you are not
// an admin here", which is neither a fault nor retryable.
//
// It had never been noticed because it was also UNREACHABLE: `runWithAuth` installs a
// fresh AsyncLocalStorage store, so a principal set outside the handler was discarded,
// `currentPrincipal()` read null, and `enforceAdmin` took its org-key branch and allowed
// everything. A route could not enforce an admin-only tool at all.
test("a role refusal is 403, not 500", async () => {
  const handler = createToolDispatchHandler({
    dispatcher: throwing(new Error("Forbidden (403): change_plan requires an owner or admin of this workspace.")),
  });
  const res = await handler(post(), ctx);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /requires an owner or admin/);
});

test("the principal resolver reaches enforceAdmin through the route", async () => {
  // The adapter is the authority: a principal alone is not enough, `adapter.isAdmin`
  // decides. Both directions asserted, because a resolver that reached nothing would
  // look identical to today's behaviour from outside.
  const seen = [];
  const adapter = {
    async validateApiKey() {
      return { orgId: "org_1" };
    },
    async getOrgDomains() {
      return [];
    },
    async isAdmin(orgId, userId) {
      seen.push(userId);
      return userId === "usr_admin";
    },
  };

  const { enforceAdmin } = await import("../dist/auth.js");
  const dispatcher = {
    async dispatchTool() {
      const r = await enforceAdmin(adapter, "change_plan");
      if ("isError" in r) throw new Error(r.content[0].text);
      return { ok: true };
    },
    getToolNames: () => ["change_plan"],
  };

  const handlerFor = (userId) =>
    createToolDispatchHandler({ dispatcher, principal: () => (userId ? { userId } : null) });

  assert.equal((await handlerFor("usr_admin")(post(), ctx)).status, 200, "an admin must get through");
  assert.equal((await handlerFor("usr_member")(post(), ctx)).status, 403, "a member must be refused");
  assert.deepEqual(seen, ["usr_admin", "usr_member"], "the adapter must be the one asked");

  // No resolver, or one returning null: the org-key path, still owner-level. That is the
  // documented behaviour for a headless agent holding an `sk_` key, and it must not change.
  assert.equal((await handlerFor(null)(post(), ctx)).status, 200);
  assert.equal((await createToolDispatchHandler({ dispatcher })(post(), ctx)).status, 200);
});
