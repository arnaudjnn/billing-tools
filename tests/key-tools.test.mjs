// create_api_key / list_api_keys / revoke_api_key, through the REST dispatcher and the
// shipped WorkOSOrgAdapter — the stack a headless caller actually reaches.
//
// The property worth a test is TENANCY: a key resolves to one org, and every key operation
// stays inside it. `revokeApiKey` deletes by id, and the WorkOS delete needs only the id,
// so the adapter's belongs-to check is the only thing between a caller and every other
// workspace's keys.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { WorkOSOrgAdapter } from "../dist/adapters/workos-org.js";
import { runWithAuth, runWithPrincipal } from "../dist/auth.js";
import { createDispatcher, ToolValidationError } from "../dist/dispatch.js";
import { registerBillingTools } from "../dist/tools/register.js";
import { __setWorkOSForTests } from "../dist/workos.js";

afterEach(() => __setWorkOSForTests(null));

/** WorkOS org API keys, in memory: values validate to their owner until deleted. */
function fakeWorkOS(seed = []) {
  const keys = [...seed];
  const deleted = [];
  let seq = keys.length;
  const page = (orgId) => keys.filter((k) => k.owner === orgId);
  return {
    keys,
    deleted,
    apiKeys: {
      async createOrganizationApiKey({ organizationId, name }) {
        const id = `api_key_${++seq}`;
        const value = `sk_live_${id}_secret`;
        keys.push({ id, name, value, owner: organizationId });
        return { id, name, value };
      },
      async listOrganizationApiKeys({ organizationId }) {
        const rows = page(organizationId).map((k) => ({
          id: k.id,
          name: k.name,
          obfuscatedValue: `sk_…${k.value.slice(-4)}`,
          createdAt: "2026-10-01T00:00:00.000Z",
          lastUsedAt: null,
          permissions: [],
        }));
        return { data: rows, autoPagination: async () => rows };
      },
      async createValidation({ value }) {
        const k = keys.find((x) => x.value === value);
        return { apiKey: k ? { id: k.id, owner: { id: k.owner } } : null };
      },
      async deleteApiKey(id) {
        deleted.push(id);
        const i = keys.findIndex((k) => k.id === id);
        if (i >= 0) keys.splice(i, 1);
      },
    },
  };
}

function setup(seed) {
  const wos = fakeWorkOS(
    seed ?? [
      { id: "api_key_a", name: "Primary", value: "sk_org_a", owner: "org_a" },
      { id: "api_key_b", name: "Theirs", value: "sk_org_b", owner: "org_b" },
    ],
  );
  __setWorkOSForTests(wos);
  const d = createDispatcher((server) =>
    registerBillingTools(server, {
      adapter: new WorkOSOrgAdapter(),
      config: { currency: "eur", baseUrl: "https://t.local", internalDomains: [] },
      installLogging: false,
    }),
  );
  const as = (token) => (tool, args = {}) => runWithAuth(token ? `Bearer ${token}` : null, () => d.dispatchTool(tool, args));
  return { wos, d, as };
}

// ── create ───────────────────────────────────────────────────────────────────

test("create_api_key mints a named key in the CALLER's org and shows it once", async () => {
  const { wos, as } = setup();
  const r = await as("sk_org_a")("create_api_key", { name: "  CI runner  " });

  assert.equal(r.status, "ok");
  assert.equal(r.name, "CI runner", "trimmed");
  assert.match(r.api_key, /^sk_live_/);
  assert.equal(r.usage.header, `Authorization: Bearer ${r.api_key}`);
  const minted = wos.keys.find((k) => k.id === r.id);
  assert.equal(minted.owner, "org_a");
  assert.equal(minted.name, "CI runner");

  // And the new key works, for the same org.
  const listed = await as(r.api_key)("list_api_keys");
  assert.deepEqual(listed.keys.map((k) => k.name).sort(), ["CI runner", "Primary"]);
});

test("a blank name is refused before anything is minted", async () => {
  // REGRESSION: `min(1)` ran on the untrimmed string, so "   " passed and minted a key
  // named "" — the indistinguishable key this tool exists to stop producing.
  const { wos, as } = setup();
  const before = wos.keys.length;
  for (const name of ["", "   ", "\t\n"]) {
    await assert.rejects(as("sk_org_a")("create_api_key", { name }), ToolValidationError, JSON.stringify(name));
  }
  await assert.rejects(as("sk_org_a")("create_api_key", { name: "x".repeat(81) }), ToolValidationError);
  assert.equal(wos.keys.length, before);
});

test("create_api_key needs an existing key: no header, or a bad one, is a 401", async () => {
  const { wos, as } = setup();
  const before = wos.keys.length;
  await assert.rejects(as(null)("create_api_key", { name: "x" }), /Unauthorized \(401\)/);
  await assert.rejects(as("sk_forged")("create_api_key", { name: "x" }), /Unauthorized \(401\): Invalid API key/);
  assert.equal(wos.keys.length, before);
});

test("a member principal may create a key — it is not admin-gated", async () => {
  const { wos } = setup();
  const d = createDispatcher((server) =>
    registerBillingTools(server, {
      adapter: Object.assign(new WorkOSOrgAdapter(), { isAdmin: async () => false }),
      config: { currency: "eur", internalDomains: [] },
      installLogging: false,
    }),
  );
  const r = await runWithPrincipal({ authHeader: "Bearer sk_org_a", principal: { userId: "user_m" } }, () =>
    d.dispatchTool("create_api_key", { name: "mine" }),
  );
  assert.equal(r.status, "ok");
  assert.equal(wos.keys.find((k) => k.id === r.id).owner, "org_a");
});

// ── list ─────────────────────────────────────────────────────────────────────

test("list_api_keys shows only this org's keys, and never a full value", async () => {
  const { as } = setup();
  const r = await as("sk_org_a")("list_api_keys");
  assert.deepEqual(r.keys.map((k) => k.id), ["api_key_a"]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes("sk_org_a"), "the full value is not in the response");
  assert.ok(!text.includes("sk_org_b"));
});

// ── revoke ───────────────────────────────────────────────────────────────────

test("revoke_api_key deletes a key of this org, and it stops working", async () => {
  const { wos, as } = setup([
    { id: "api_key_a", name: "Primary", value: "sk_org_a", owner: "org_a" },
    { id: "api_key_a2", name: "Old", value: "sk_org_a2", owner: "org_a" },
  ]);
  const r = await as("sk_org_a")("revoke_api_key", { api_key_id: "api_key_a2" });
  assert.deepEqual(r, { status: "ok", revoked: { id: "api_key_a2", name: "Old" } });
  assert.deepEqual(wos.deleted, ["api_key_a2"]);
  await assert.rejects(as("sk_org_a2")("list_api_keys"), /Unauthorized \(401\)/);
});

test("revoking ANOTHER org's key is 'not found', and nothing is deleted", async () => {
  const { wos, as } = setup();
  await assert.rejects(
    as("sk_org_a")("revoke_api_key", { api_key_id: "api_key_b" }),
    /Key api_key_b not found in this workspace/,
  );
  assert.deepEqual(wos.deleted, [], "the other org's key is untouched");
  assert.equal((await as("sk_org_b")("list_api_keys")).keys.length, 1, "and still works");
});

test("revoking an id that does not exist is 'not found'", async () => {
  const { wos, as } = setup();
  await assert.rejects(as("sk_org_a")("revoke_api_key", { api_key_id: "api_key_nope" }), /not found/);
  assert.deepEqual(wos.deleted, []);
});

test("a key may revoke itself — the org-key holder is owner-level by design", async () => {
  const { as } = setup();
  const r = await as("sk_org_a")("revoke_api_key", { api_key_id: "api_key_a" });
  assert.equal(r.status, "ok");
  await assert.rejects(as("sk_org_a")("list_api_keys"), /Unauthorized \(401\)/);
});

test("revoke_api_key without an id is a validation error", async () => {
  const { as } = setup();
  await assert.rejects(as("sk_org_a")("revoke_api_key", {}), ToolValidationError);
});
