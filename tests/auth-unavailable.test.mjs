// "Your key is invalid" versus "your key could not be checked".
//
// `WorkOSOrgAdapter.validateApiKey` used to catch EVERY error and return null, so a WorkOS
// outage answered each caller "401 Invalid API key". That is the one answer that causes
// damage beyond the outage itself: a client told its key is bad discards or rotates it.
//
// The rule these pin, on the REST route and on both MCP paths:
//   • WorkOS REJECTED the value (no such key, not a key at all) → null → 401;
//   • anything else (network, 5xx, rate limit, our own WorkOS key refused) → 503 with a
//     short Retry-After and an `{error}` envelope.
// The second must hold even when the provider's error text looks like an auth failure,
// because the route's 401 matcher reads text.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  BadRequestException,
  GenericServerException,
  NotFoundException,
  RateLimitExceededException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@workos-inc/node";

import { WorkOSOrgAdapter } from "../dist/adapters/workos-org.js";
import { AUTH_UNAVAILABLE_RETRY_AFTER } from "../dist/auth.js";
import { createDispatcher } from "../dist/dispatch.js";
import { createMcpTransport } from "../dist/routes/mcp.js";
import { createToolDispatchHandler } from "../dist/routes/rest.js";
import { registerBillingTools } from "../dist/tools/register.js";
import { __setWorkOSForTests } from "../dist/workos.js";

afterEach(() => {
  __setWorkOSForTests(null);
  vi.restoreAllMocks();
});

const CONFIG = { currency: "eur", baseUrl: "https://t.local", internalDomains: [] };

/** WorkOS whose key validation answers with `outcome`: a key, null, or a throw. */
function workosValidating(outcome) {
  __setWorkOSForTests({
    apiKeys: {
      async createValidation() {
        if (outcome instanceof Error) throw outcome;
        return { apiKey: outcome };
      },
      async listOrganizationApiKeys() {
        return { autoPagination: async () => [] };
      },
    },
  });
}

const GOOD = { id: "api_key_1", owner: { id: "org_1" } };

const REJECTIONS = {
  "no such key": null,
  "WorkOS 404": new NotFoundException({ path: "/api_keys/validations" }),
  "WorkOS 422": new UnprocessableEntityException({ errors: [], requestID: "r" }),
  "WorkOS 400": new BadRequestException({ code: "invalid", message: "Invalid value", requestID: "r" }),
};

const UNAVAILABLE = {
  "WorkOS 500": new GenericServerException(500, "Internal error", {}, "r"),
  "WorkOS 503": new GenericServerException(503, undefined, {}, "r"),
  "WorkOS 429": new RateLimitExceededException("Too many requests", "r", 1),
  // OUR WorkOS key refused. Not the caller's fault, and its text reads like an auth failure.
  "WorkOS 401 (our key)": new UnauthorizedException("r"),
  network: new TypeError("fetch failed"),
  "an error that SAYS Unauthorized": new Error("Unauthorized upstream (401)"),
};

function restHandler(adapter = new WorkOSOrgAdapter()) {
  const dispatcher = createDispatcher((server) =>
    registerBillingTools(server, { adapter, config: CONFIG, installLogging: false }),
  );
  return createToolDispatchHandler({ dispatcher, realm: "t" });
}

const restCall = (handler, tool = "list_api_keys", body = {}) =>
  handler(
    new Request(`https://t.local/api/v0/${tool}`, {
      method: "POST",
      headers: { authorization: "Bearer sk_some_key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

// ── the adapter ──────────────────────────────────────────────────────────────

test("validateApiKey: a rejection is null, an outage throws", async () => {
  for (const [name, outcome] of Object.entries(REJECTIONS)) {
    workosValidating(outcome);
    assert.equal(await new WorkOSOrgAdapter().validateApiKey("sk_x"), null, name);
  }
  for (const [name, err] of Object.entries(UNAVAILABLE)) {
    workosValidating(err);
    await assert.rejects(new WorkOSOrgAdapter().validateApiKey("sk_x"), (e) => e === err, name);
  }
  workosValidating(GOOD);
  assert.deepEqual(await new WorkOSOrgAdapter().validateApiKey("sk_x"), { orgId: "org_1", keyId: "api_key_1" });
});

test("validateApiKey: a Pattern B map that cannot answer is an outage too", async () => {
  workosValidating(GOOD);
  const adapter = new WorkOSOrgAdapter({
    map: {
      toWorkosOrgId: async (id) => id,
      toOrgId: async () => {
        throw new GenericServerException(502, undefined, {}, "r");
      },
    },
  });
  await assert.rejects(adapter.validateApiKey("sk_x"));
  // While an org the map positively does not know is still a rejection.
  const unmapped = new WorkOSOrgAdapter({ map: { toWorkosOrgId: async (id) => id, toOrgId: async () => null } });
  assert.equal(await unmapped.validateApiKey("sk_x"), null);
});

// ── REST ─────────────────────────────────────────────────────────────────────

test("REST: a rejected key is 401 with WWW-Authenticate", async () => {
  for (const [name, outcome] of Object.entries(REJECTIONS)) {
    workosValidating(outcome);
    const res = await restCall(restHandler());
    assert.equal(res.status, 401, name);
    assert.match(res.headers.get("WWW-Authenticate"), /invalid_token/, name);
    assert.match((await res.json()).error, /Invalid API key/, name);
  }
});

test("REST: a key that could not be checked is 503 + Retry-After, never 401", async () => {
  // REGRESSION: every one of these was "401 Invalid API key".
  const log = quiet();
  for (const [name, err] of Object.entries(UNAVAILABLE)) {
    workosValidating(err);
    const res = await restCall(restHandler());
    assert.equal(res.status, 503, name);
    assert.equal(res.headers.get("Retry-After"), String(AUTH_UNAVAILABLE_RETRY_AFTER), name);
    assert.equal(res.headers.get("WWW-Authenticate"), null, `${name}: no invalid_token challenge`);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["error"], name);
    assert.match(body.error, /could not be verified/, name);
    assert.doesNotMatch(body.error, /Unauthorized|Invalid API key/, `${name}: says nothing about the key being bad`);
  }
  assert.ok(log.mock.calls.length >= Object.keys(UNAVAILABLE).length, "the cause is logged server-side");
});

test("REST: Retry-After is short", () => {
  assert.ok(AUTH_UNAVAILABLE_RETRY_AFTER > 0 && AUTH_UNAVAILABLE_RETRY_AFTER <= 30);
});

test("REST: an admin-gated tool answers the same 503", async () => {
  quiet();
  workosValidating(UNAVAILABLE["WorkOS 500"]);
  const res = await restCall(restHandler(), "set_tax_id", { value: "" });
  assert.equal(res.status, 503);
});

test("REST: a consumer's own adapter that throws is a 503 as well", async () => {
  // The adapter contract is now the one the WorkOS adapter keeps: null rejects, a throw
  // means "could not tell".
  quiet();
  const adapter = {
    async validateApiKey() {
      throw new Error("ECONNREFUSED");
    },
    async getOrgDomains() {
      return [];
    },
    async getBillingCustomerId() {
      return null;
    },
    async setBillingCustomerId() {},
    async ensureOrgForUser() {
      return { orgId: "x" };
    },
    async mintApiKey() {
      return { id: "k", value: "v" };
    },
    async listApiKeys() {
      return [];
    },
    async revokeApiKey() {
      return null;
    },
  };
  const res = await restCall(restHandler(adapter));
  assert.equal(res.status, 503);
});

test("REST: a valid key still works", async () => {
  workosValidating(GOOD);
  const res = await restCall(restHandler());
  assert.equal(res.status, 200);
});

// ── MCP ──────────────────────────────────────────────────────────────────────

function transport(requireAuth) {
  const adapter = new WorkOSOrgAdapter();
  return createMcpTransport({
    adapter,
    realm: "t",
    requireAuth,
    register: (server) => registerBillingTools(server, { adapter, config: CONFIG, installLogging: false }),
  });
}

const mcpRequest = (method, params = {}) =>
  new Request("https://t.local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer sk_some_key",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

const callTool = () => mcpRequest("tools/call", { name: "list_api_keys", arguments: {} });

test("MCP requireAuth: rejected → 401, could not check → 503 + Retry-After", async () => {
  quiet();
  for (const [name, outcome] of Object.entries(REJECTIONS)) {
    workosValidating(outcome);
    const res = await transport(true).POST(mcpRequest("tools/list"));
    assert.equal(res.status, 401, name);
    assert.ok(res.headers.get("WWW-Authenticate"), name);
  }
  for (const [name, err] of Object.entries(UNAVAILABLE)) {
    // REGRESSION: the transport's own catch turned every one of these into a 401.
    workosValidating(err);
    const res = await transport(true).POST(mcpRequest("tools/list"));
    assert.equal(res.status, 503, name);
    assert.equal(res.headers.get("Retry-After"), String(AUTH_UNAVAILABLE_RETRY_AFTER), name);
    assert.match((await res.json()).error, /could not be verified/, name);
  }
});

test("MCP default: a tool call whose key could not be checked is an HTTP 503", async () => {
  // REGRESSION: the refusal was a JSON-RPC tool result saying "Invalid API key", sent as 200.
  quiet();
  for (const [name, err] of Object.entries(UNAVAILABLE)) {
    workosValidating(err);
    const res = await transport(false).POST(callTool());
    assert.equal(res.status, 503, name);
    assert.equal(res.headers.get("Retry-After"), String(AUTH_UNAVAILABLE_RETRY_AFTER), name);
    assert.deepEqual(Object.keys(await res.json()), ["error"], name);
  }
});

test("MCP default: a rejected key still reaches the tool, which refuses it as before", async () => {
  workosValidating(null);
  const res = await transport(false).POST(callTool());
  assert.notEqual(res.status, 503);
  const text = await res.text();
  assert.match(text, /Unauthorized \(401\): Invalid API key/);
});

test("MCP default: a valid key calls the tool", async () => {
  workosValidating(GOOD);
  const res = await transport(false).POST(callTool());
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /\\"status\\": \\"ok\\"/);
});

test("MCP default: the handshake reads no key, so an outage does not block it", async () => {
  workosValidating(UNAVAILABLE["WorkOS 500"]);
  const res = await transport(false).POST(mcpRequest("tools/list"));
  assert.notEqual(res.status, 503);
});
