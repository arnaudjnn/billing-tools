// The WorkOS half of provisioning.
//
// Stripe provisions itself from the secret key — prices, the meter, the
// payment-method configuration, TaxRates. WorkOS did not, so "it worked in sandbox"
// said nothing about production, and one gap was silent in the worst way: `isAdmin`
// matches a member's role slug against ADMIN_ROLE_SLUG, so an environment with no
// such role answers 403 from every admin-gated tool to every human — while org API
// keys keep working, which is exactly why a headless test pass cannot see it.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ADMIN_ROLE_SLUG,
  DEFAULT_WORKOS_ROLES,
  ensureWorkOSRoles,
  oauthCallbackUri,
} from "../dist/workos-setup.js";
import { __setWorkOSForTests } from "../dist/workos.js";

function fakeWorkOS({ existing = [], failCreate = null } = {}) {
  const created = [];
  return {
    created,
    authorization: {
      async listEnvironmentRoles() {
        return { data: existing.map((slug) => ({ slug, id: `role_${slug}` })) };
      },
      async createEnvironmentRole(opts) {
        if (failCreate) throw failCreate;
        created.push(opts);
        return { id: `role_${opts.slug}`, ...opts };
      },
    },
  };
}

test("a fresh environment gets the roles the gate depends on", async () => {
  const fake = fakeWorkOS({ existing: [] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles();
  assert.deepEqual(r.created.sort(), DEFAULT_WORKOS_ROLES.map((x) => x.slug).sort());
  assert.deepEqual(r.existing, []);
  // The one that matters: without it enforceAdmin 403s every member.
  assert.ok(fake.created.some((c) => c.slug === ADMIN_ROLE_SLUG));
  // A slug is not enough on its own — the Dashboard shows the name.
  assert.ok(fake.created.every((c) => typeof c.name === "string" && c.name.length > 0));
});

test("it is idempotent, so it is safe on every deploy", async () => {
  const fake = fakeWorkOS({ existing: ["admin", "member"] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles();
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.existing.sort(), ["admin", "member"]);
  assert.equal(fake.created.length, 0, "an existing role must not be re-created");
});

test("a partially configured environment is topped up, not duplicated", async () => {
  // The likely real state: WorkOS ships `admin`/`member` in some environments and an
  // app adds its own. Only what is missing is created.
  const fake = fakeWorkOS({ existing: ["admin"] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles({
    roles: [...DEFAULT_WORKOS_ROLES, { slug: "billing_viewer", name: "Billing viewer" }],
  });
  assert.deepEqual(r.created.sort(), ["billing_viewer", "member"]);
  assert.deepEqual(r.existing, ["admin"]);
});

test("a concurrent deploy racing on the same role is not a failure", async () => {
  // Two instances of one commit both create it; the loser gets a conflict and the
  // outcome asked for (the role exists) is the outcome it got.
  const conflict = Object.assign(new Error("Role with slug already exists"), { status: 409 });
  const fake = fakeWorkOS({ existing: [], failCreate: conflict });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles({ roles: [{ slug: "admin", name: "Admin" }] });
  assert.deepEqual(r.existing, ["admin"]);
  assert.deepEqual(r.created, []);
});

test("a real failure is not swallowed as a race", async () => {
  const denied = Object.assign(new Error("Insufficient permissions"), { status: 403 });
  __setWorkOSForTests(fakeWorkOS({ existing: [], failCreate: denied }));
  await assert.rejects(() => ensureWorkOSRoles(), /Insufficient permissions/);
});

test("the redirect URI is printed, because v10 cannot check it", async () => {
  // AuthKit's redirect URIs have no API in @workos-inc/node v10 — the only writable
  // `redirect_uris` belong to a Connect application, a different object. So the
  // honest output is the exact string to paste.
  assert.equal(oauthCallbackUri("https://app.example"), "https://app.example/oauth/callback");
  // A trailing slash must not produce a double slash: an allowlist compares strings.
  assert.equal(oauthCallbackUri("https://app.example/"), "https://app.example/oauth/callback");
});
