// The OAuth proxy's state, and why it is pluggable.
//
// Registered clients, parked sessions and codes lived in Maps inside one proxy
// instance. A redeploy is a new instance, so every connector (claude.ai, ChatGPT,
// Claude Code) answered `400 invalid_client "Unknown client_id"` on its next
// authorize until its user removed and re-added it — and behind two replicas a
// code minted by one was unknown to the other. These tests pin both halves: the
// default still behaves like one process's memory, and a store shared by two
// instances survives the "restart" and keeps a code single-use.

process.env.WORKOS_CLIENT_ID ??= "client_test";
process.env.REFRESH_TOKEN_SECRET ??= "test-refresh-secret";

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, test, vi } from "vitest";

import { createOAuthProxy } from "../dist/oauth-proxy/index.js";
import { inMemoryOAuthStore } from "../dist/entries/agent-auth.js";
import { __setWorkOSForTests } from "../dist/workos.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const BASE = "https://app.test";

beforeEach(() => {
  let n = 0;
  __setWorkOSForTests({
    userManagement: {
      authenticateWithCode: async ({ code }) => ({
        accessToken: `wos_at_${code}`,
        refreshToken: `wos_rt_${code}`,
      }),
      authenticateWithRefreshToken: async () => ({
        accessToken: `wos_at_refreshed_${++n}`,
        refreshToken: `wos_rt_refreshed_${n}`,
      }),
    },
  });
});
afterEach(() => {
  __setWorkOSForTests(null);
  vi.useRealTimers();
});

/** A store the way a database would be one: values round-trip through JSON (so
 *  nothing the proxy stores may depend on object identity), and every write is
 *  recorded so a test can read what actually landed in the "table". */
function fakeStore() {
  const rows = new Map();
  const writes = [];
  const k = (kind, key) => `${kind}:${key}`;
  const live = (kind, key) => {
    const r = rows.get(k(kind, key));
    if (!r) return null;
    if (r.expiresAt !== null && Date.now() >= r.expiresAt) {
      rows.delete(k(kind, key));
      return null;
    }
    return r;
  };
  return {
    rows,
    writes,
    async get(kind, key) {
      const r = live(kind, key);
      return r ? JSON.parse(r.json) : null;
    },
    async set(kind, key, value, ttlMs) {
      writes.push({ kind, key, ttlMs });
      rows.set(k(kind, key), { json: JSON.stringify(value), expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
    },
    async delete(kind, key) {
      rows.delete(k(kind, key));
    },
    async take(kind, key) {
      const r = live(kind, key);
      rows.delete(k(kind, key));
      return r ? JSON.parse(r.json) : null;
    },
  };
}

const proxy = (opts = {}) => createOAuthProxy({ baseUrl: BASE, ...opts });

async function register(p) {
  const res = await p.register(
    new Request(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    }),
  );
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorize(p, clientId, challenge) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return p.authorize(new Request(`${BASE}/oauth/authorize?${q}`));
}

/** authorize → (AuthKit) → callback, each leg on whichever instance is given. */
async function obtainCode(onAuthorize, onCallback, clientId, challenge) {
  const res = await authorize(onAuthorize, clientId, challenge);
  assert.equal(res.status, 302);
  const sessionId = new URL(res.headers.get("location")).searchParams.get("state");
  const back = await onCallback.callback(
    new Request(`${BASE}/oauth/callback?code=wos_code&state=${sessionId}`),
  );
  assert.equal(back.status, 302);
  const to = new URL(back.headers.get("location"));
  assert.equal(`${to.origin}${to.pathname}`, REDIRECT);
  assert.equal(to.searchParams.get("state"), "client-state");
  return to.searchParams.get("code");
}

function exchange(p, clientId, code, verifier) {
  return p.token(
    new Request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    }),
  );
}

// ── the default: one process's memory, as before ────────────────────────────

test("default store: the full flow works inside one instance", async () => {
  const p = proxy();
  const clientId = await register(p);
  const { verifier, challenge } = pkce();
  const code = await obtainCode(p, p, clientId, challenge);

  const res = await exchange(p, clientId, code, verifier);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.access_token, "wos_at_wos_code");
  assert.equal(body.token_type, "bearer");
  assert.ok(body.refresh_token.split(".").length === 3);
});

test("default store: a NEW instance does not know the client (the redeploy bug, documented)", async () => {
  const clientId = await register(proxy());
  const res = await authorize(proxy(), clientId, pkce().challenge);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_client");
});

test("default store: a code is single-use", async () => {
  const p = proxy();
  const clientId = await register(p);
  const { verifier, challenge } = pkce();
  const code = await obtainCode(p, p, clientId, challenge);
  assert.equal((await exchange(p, clientId, code, verifier)).status, 200);
  const replay = await exchange(p, clientId, code, verifier);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
});

test("default store: a client still expires after 24h, sessions after 10 min", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const p = proxy();
  const clientId = await register(p);

  vi.setSystemTime(Date.now() + 11 * 60 * 1000);
  // The session parked 11 minutes ago is gone...
  const res = await authorize(p, clientId, pkce().challenge);
  const stale = new URL(res.headers.get("location")).searchParams.get("state");
  vi.setSystemTime(Date.now() + 11 * 60 * 1000);
  const cb = await p.callback(new Request(`${BASE}/oauth/callback?code=c&state=${stale}`));
  assert.equal(cb.status, 400);

  // ...and the client, touched at the authorize above, lives 24h from THAT, not from
  // registration: in use is what keeps it.
  vi.setSystemTime(Date.now() + 23 * 60 * 60 * 1000);
  assert.equal((await authorize(p, clientId, pkce().challenge)).status, 302);
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal((await authorize(p, clientId, pkce().challenge)).status, 400);
});

test("inMemoryOAuthStore: TTL, null TTL and take", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const s = inMemoryOAuthStore();
  await s.set("code", "a", { x: 1 }, 1000);
  await s.set("client", "b", { y: 2 }, null);
  assert.deepEqual(await s.get("code", "a"), { x: 1 });
  vi.setSystemTime(Date.now() + 1000);
  assert.equal(await s.get("code", "a"), null);
  vi.setSystemTime(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await s.get("client", "b"), { y: 2 });
  assert.deepEqual(await s.take("client", "b"), { y: 2 });
  assert.equal(await s.take("client", "b"), null);
  // Kinds are separate namespaces.
  await s.set("session", "k", { s: 1 }, null);
  assert.equal(await s.get("code", "k"), null);
});

// ── a shared store: restart survival and cross-instance single use ─────────────

test("shared store: a client registered before a restart still authorizes after it", async () => {
  const store = fakeStore();
  const clientId = await register(proxy({ store }));
  // The redeploy: a brand-new proxy, nothing in common with the first but the store.
  const res = await authorize(proxy({ store }), clientId, pkce().challenge);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^https:\/\/api\.workos\.com\/user_management\/authorize\?/);
});

test("shared store: each leg on a different instance (two replicas)", async () => {
  const store = fakeStore();
  const [a, b] = [proxy({ store }), proxy({ store })];
  const clientId = await register(a);
  const { verifier, challenge } = pkce();
  const code = await obtainCode(b, a, clientId, challenge);
  const res = await exchange(b, clientId, code, verifier);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).access_token, "wos_at_wos_code");
});

test("shared store: a code redeemed concurrently on two instances succeeds ONCE", async () => {
  const store = fakeStore();
  const [a, b] = [proxy({ store }), proxy({ store })];
  const clientId = await register(a);
  const { verifier, challenge } = pkce();
  const code = await obtainCode(a, a, clientId, challenge);
  const results = await Promise.all([exchange(a, clientId, code, verifier), exchange(b, clientId, code, verifier)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
});

test("shared store: a wrong PKCE verifier burns the code (one guess, not many)", async () => {
  const store = fakeStore();
  const p = proxy({ store });
  const clientId = await register(p);
  const { verifier, challenge } = pkce();
  const code = await obtainCode(p, p, clientId, challenge);
  assert.equal((await exchange(p, clientId, code, "wrong-verifier")).status, 400);
  assert.equal((await exchange(p, clientId, code, verifier)).status, 400);
});

test("shared store: no row holds a replayable code, session id or WorkOS token", async () => {
  const store = fakeStore();
  const p = proxy({ store });
  const clientId = await register(p);
  const { challenge } = pkce();
  const res = await authorize(p, clientId, challenge);
  const sessionId = new URL(res.headers.get("location")).searchParams.get("state");
  const back = await p.callback(new Request(`${BASE}/oauth/callback?code=wos_code&state=${sessionId}`));
  const code = new URL(back.headers.get("location")).searchParams.get("code");

  const dump = [...store.rows.entries()].map(([k, v]) => `${k} ${v.json}`).join("\n");
  assert.ok(!dump.includes(code), "the code itself is stored");
  assert.ok(!dump.includes(sessionId), "the session id itself is stored");
  assert.ok(!dump.includes("wos_at_"), "the WorkOS access token is stored in clear");
  assert.ok(!dump.includes("wos_rt_"), "the WorkOS refresh token is stored in clear");
  // The client_id is public (it travels in every authorize URL) and is the key.
  assert.ok(dump.includes(`client:${clientId}`));
});

test("shared store: clients default to a long TTL; clientMs overrides, null never expires", async () => {
  const s1 = fakeStore();
  await register(proxy({ store: s1 }));
  assert.equal(s1.writes.find((w) => w.kind === "client").ttlMs, 90 * 24 * 60 * 60 * 1000);

  const s2 = fakeStore();
  await register(proxy({ store: s2, ttl: { clientMs: null } }));
  assert.equal(s2.writes.find((w) => w.kind === "client").ttlMs, null);

  const s3 = fakeStore();
  await register(proxy({ store: s3, ttl: { clientMs: 5000 } }));
  assert.equal(s3.writes.find((w) => w.kind === "client").ttlMs, 5000);

  // Sessions and codes keep their short lifetimes whatever the store.
  const p = proxy({ store: s1 });
  const clientId = await register(p);
  await obtainCode(p, p, clientId, pkce().challenge);
  assert.equal(s1.writes.find((w) => w.kind === "session").ttlMs, 10 * 60 * 1000);
  assert.equal(s1.writes.find((w) => w.kind === "code").ttlMs, 5 * 60 * 1000);
});

test("shared store: a connector that keeps refreshing keeps its client alive", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const store = fakeStore();
  const day = 24 * 60 * 60 * 1000;
  const p = proxy({ store, ttl: { clientMs: 10 * day } });
  const clientId = await register(p);
  const { verifier, challenge } = pkce();
  const code = await obtainCode(p, p, clientId, challenge);
  let { refresh_token } = await (await exchange(p, clientId, code, verifier)).json();

  const refresh = async () => {
    const res = await p.token(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token, client_id: clientId }),
      }),
    );
    assert.equal(res.status, 200);
    refresh_token = (await res.json()).refresh_token;
  };
  // Refreshing every 4 days for 40 days — four TTLs past registration.
  for (let i = 0; i < 10; i++) {
    vi.setSystemTime(Date.now() + 4 * day);
    await refresh();
  }
  // Throttled: not a write per refresh.
  assert.ok(store.writes.filter((w) => w.kind === "client").length < 10);
  assert.equal((await authorize(proxy({ store }), clientId, pkce().challenge)).status, 302);
});
