// The WorkOS half of the doctor.
//
// It exists because `checkBillingSetup` audited Stripe thoroughly and WorkOS not at
// all, while WorkOS holds the orgs, the memberships and the `sk_` API keys. The
// credentials are read LAZILY — they have to be, since constructing a client at
// import time throws when a key is unset and takes the app's boot with it — so an
// environment looks perfectly healthy until the first person signs in.
//
// The case that motivated it, measured on a real deployment: `oauthProxy: true` was
// set and `REFRESH_TOKEN_SECRET` was in neither .env.example nor .env.local. The
// OAuth proxy refuses to sign a refresh token without it (deliberately — it used to
// fall back to WORKOS_CLIENT_ID, which is PUBLIC, so the token was forgeable), so
// the token endpoint answered `server_error` and no MCP client could connect.
// Nothing anywhere said which variable was missing.

import assert from "node:assert/strict";
import { test } from "vitest";

import { checkWorkOSSetup } from "../dist/doctor.js";

/** Run with a specific env, restoring whatever was there. */
async function withEnv(env, fn) {
  const keys = ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "REFRESH_TOKEN_SECRET"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const find = (r, title) => r.checks.find((c) => c.title === title);

test("a missing REFRESH_TOKEN_SECRET is an ERROR when the OAuth proxy is mounted", async () => {
  const r = await withEnv({}, () => checkWorkOSSetup({ oauthProxy: true }));
  const c = find(r, "REFRESH_TOKEN_SECRET");
  assert.equal(c?.level, "error");
  assert.equal(r.healthy, false);
  // The fix has to name the command, because "set a secret" is the advice that
  // leaves someone guessing at the format.
  assert.match(c.fix, /openssl rand/);
  // And it has to say WHY there is no fallback, or the next person adds one back.
  assert.match(c.fix, /public|forgeable/);
});

test("and is not mentioned at all when the proxy is not mounted", async () => {
  // An app serving only humans needs no refresh-token secret; reporting it as
  // missing would be noise, and noise in a doctor is how real findings get skipped.
  const r = await withEnv({}, () => checkWorkOSSetup());
  assert.equal(find(r, "REFRESH_TOKEN_SECRET"), undefined);
});

test("set is fine", async () => {
  const r = await withEnv({ REFRESH_TOKEN_SECRET: "x".repeat(64) }, () =>
    checkWorkOSSetup({ oauthProxy: true }),
  );
  assert.equal(find(r, "REFRESH_TOKEN_SECRET")?.level, "ok");
});

test("missing credentials are errors, and say why the app still booted", async () => {
  const r = await withEnv({}, () => checkWorkOSSetup());
  for (const name of ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"]) {
    assert.equal(find(r, name)?.level, "error", `${name} should be an error`);
  }
  // The whole point: it is read lazily, so nothing failed at boot.
  assert.match(find(r, "WORKOS_API_KEY").fix, /lazily|500/);
  assert.equal(r.healthy, false);
});

test("the key names the environment, so a staging key in prod is visible", async () => {
  // A staging key in production points every org and API key at the wrong WorkOS
  // environment, and nothing else would say so.
  const staging = await withEnv({ WORKOS_API_KEY: "sk_test_abc", WORKOS_CLIENT_ID: "client_1" }, () =>
    checkWorkOSSetup(),
  );
  assert.match(find(staging, "WorkOS environment").detail, /test|staging/);
  assert.equal(staging.livemode, false);

  const live = await withEnv({ WORKOS_API_KEY: "sk_live_abc", WORKOS_CLIENT_ID: "client_1" }, () =>
    checkWorkOSSetup(),
  );
  assert.match(find(live, "WorkOS environment").detail, /production/);
  assert.equal(live.livemode, true);
});

test("a present-but-rejected key fails here, not on a customer's first request", async () => {
  // A fake key reaches WorkOS and is refused. The check must report that as an
  // error rather than throw, or the doctor dies before printing anything.
  const r = await withEnv({ WORKOS_API_KEY: "sk_test_bogus", WORKOS_CLIENT_ID: "client_1" }, () =>
    checkWorkOSSetup(),
  );
  const c = find(r, "WorkOS API key");
  assert.ok(c, "the API-key check did not run");
  assert.ok(["ok", "error"].includes(c.level));
  if (c.level === "error") assert.match(c.fix, /revoked|different environment/);
});
