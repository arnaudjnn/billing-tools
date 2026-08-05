// The status an API-route refusal comes back as, which was wrong for two of them.
//
// `createApiMeterGuard` guards a consumer's OWN product routes, and it answered **402 for
// every refusal** — so a caller who had merely hit a rate limit was told to buy credits. The
// body carried the right sentence and the status contradicted it, and a status is the part an
// HTTP client acts on: a 402 handler prompts a purchase, which does nothing for a limit that
// resets in forty minutes.
//
// `createToolDispatchHandler` already got this right for the tool surface (429 +
// `Retry-After`). The two must not disagree about one refusal, which is the whole point of
// these tests.

import assert from "node:assert/strict";
import { test } from "vitest";

import { createApiMeterGuard } from "../dist/metering.js";

const adapter = {
  async validateApiKey(token) {
    return token === "sk_good" ? { orgId: "org_1", keyId: "key_1" } : null;
  },
};

const request = (token = "sk_good") =>
  new Request("https://app.test/api/run", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const guardWith = (result) => createApiMeterGuard(adapter, async () => result, { realm: "test" });

test("a rate limit is 429 with Retry-After, not 402", async () => {
  const resetsIn = 40 * 60;
  const guard = guardWith({
    ok: false,
    reason: "rate_limit_reached",
    message: "Rate limit reached (5000 per day). Try again after 00:00 UTC.",
    retryAt: Date.now() + resetsIn * 1000,
  });

  const res = await guard(request(), "run");
  assert.equal(res.status, 429);
  const seconds = Number(res.headers.get("Retry-After"));
  assert.ok(seconds > resetsIn - 5 && seconds <= resetsIn, `Retry-After ${seconds}`);
  const body = await res.json();
  assert.equal(body.reason, "rate_limit_reached");
  assert.equal(body.retry_after_seconds, seconds);
});

test("a spend ceiling is 429 too — buying credits is not the remedy for a cap you set", async () => {
  const guard = guardWith({
    ok: false,
    reason: "spend_limit_reached",
    message: "Monthly spend limit reached (10000 credits). Raise it with set_spend_controls.",
    retryAt: Date.now() + 86_400_000,
  });

  const res = await guard(request(), "run");
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("Retry-After"));
  assert.equal((await res.json()).reason, "spend_limit_reached");
});

test("an empty wallet stays 402, because money IS the remedy", async () => {
  const guard = guardWith({
    ok: false,
    reason: "insufficient_balance",
    message: "Insufficient credits (balance 0). Buy credits to continue.",
  });

  const res = await guard(request(), "run");
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("Retry-After"), null, "nothing to wait for");
  assert.equal((await res.json()).reason, "insufficient_balance");
});

test("an exhausted committed pool is 402 as well, and NAMED", async () => {
  // `pool_exhausted` exists because such an org used to be told "insufficient balance", which
  // pointed at the wrong problem. The remedy is a conversation, not a wait — so not 429 — and
  // the reason has to reach the client for it to say anything better than "payment required".
  const guard = guardWith({
    ok: false,
    reason: "pool_exhausted",
    message: "This workspace's included package is used up.",
  });

  const res = await guard(request(), "run");
  assert.equal(res.status, 402);
  assert.equal((await res.json()).reason, "pool_exhausted");
});

test("a refusal with no retryAt is still 429 when it is waitable, just without the header", async () => {
  // `retryAt` comes from the window's end and an implementation could omit it. The status must
  // not silently fall back to "buy credits" because a timestamp was missing.
  const guard = guardWith({ ok: false, reason: "rate_limit_reached", message: "Slow down." });

  const res = await guard(request(), "run");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), null);
});

test("an allowed call returns null so the route continues", async () => {
  const guard = guardWith({ ok: true, funded: "wallet" });
  assert.equal(await guard(request(), "run"), null);
});

test("no key is 401 with WWW-Authenticate, unchanged", async () => {
  const guard = guardWith({ ok: true });
  const res = await guard(request(null), "run");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /Bearer realm="test"/);
});

test("a bad key is 401, not 402 — the caller is unknown, not broke", async () => {
  const guard = guardWith({ ok: true });
  const res = await guard(request("sk_wrong"), "run");
  assert.equal(res.status, 401);
});
