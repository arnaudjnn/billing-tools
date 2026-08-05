// The WorkOS half of provisioning: the roles an APP invents.
//
// There is no default list, and that is the point being pinned. A WorkOS environment
// ships `admin` and `member` already (verified against a live one), so provisioning
// them would be a step that never fires while reading like it does something — and it
// would spend a `listEnvironmentRoles` call on every deploy to find that out.
//
// Whether the `admin` slug EXISTS is a separate claim, and the doctor's: `isAdmin`
// matches on it, so a team that renames or deletes it gets false for everyone and a
// 403 from every admin-gated tool, while org API keys keep working — which is why
// that one survives a headless pass and fails on the first real person.

import assert from "node:assert/strict";
import { test } from "vitest";

import { ensureWorkOSRoles, oauthCallbackUri } from "../dist/workos-setup.js";
import { __setWorkOSForTests } from "../dist/workos.js";

function fakeWorkOS({ existing = [], failCreate = null } = {}) {
  const created = [];
  const state = { listed: 0 };
  return {
    created,
    get listed() {
      return state.listed;
    },
    authorization: {
      async listEnvironmentRoles() {
        state.listed += 1;
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

test("naming no roles costs nothing at all — not even a request", async () => {
  // The common case. `admin`/`member` are already there, so the honest default is to
  // do nothing, and doing nothing must not mean "list every role to confirm it".
  const fake = fakeWorkOS({ existing: [] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles();
  assert.deepEqual(r, { created: [], existing: [] });
  assert.equal(fake.listed, 0, "an empty request must not read the role list");
  assert.equal(fake.created.length, 0);
});

test("the roles an app invents are created", async () => {
  const fake = fakeWorkOS({ existing: ["admin", "member"] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles({
    roles: [{ slug: "billing_viewer", name: "Billing viewer", description: "Reads invoices." }],
  });
  assert.deepEqual(r.created, ["billing_viewer"]);
  assert.deepEqual(r.existing, []);
  // A slug alone is not enough — the Dashboard lists roles by name.
  assert.equal(fake.created[0].name, "Billing viewer");
});

test("it is idempotent, so it is safe on every deploy", async () => {
  const fake = fakeWorkOS({ existing: ["admin", "member", "billing_viewer"] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles({ roles: [{ slug: "billing_viewer" }] });
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.existing, ["billing_viewer"]);
  assert.equal(fake.created.length, 0, "an existing role must not be re-created");
});

test("a partially configured environment is topped up, not duplicated", async () => {
  // The likely real state: WorkOS ships `admin`/`member` in some environments and an
  // app adds its own. Only what is missing is created.
  const fake = fakeWorkOS({ existing: ["admin"] });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles({
    roles: [{ slug: "admin" }, { slug: "auditor" }, { slug: "billing_viewer" }],
  });
  assert.deepEqual(r.created.sort(), ["auditor", "billing_viewer"]);
  assert.deepEqual(r.existing, ["admin"]);
});

test("a concurrent deploy racing on the same role is not a failure", async () => {
  // Two instances of one commit both create it; the loser gets a conflict and the
  // outcome asked for (the role exists) is the outcome it got.
  const conflict = Object.assign(new Error("Role with slug already exists"), { status: 409 });
  const fake = fakeWorkOS({ existing: [], failCreate: conflict });
  __setWorkOSForTests(fake);

  const r = await ensureWorkOSRoles({ roles: [{ slug: "auditor", name: "Auditor" }] });
  assert.deepEqual(r.existing, ["auditor"]);
  assert.deepEqual(r.created, []);
});

test("a real failure is not swallowed as a race", async () => {
  const denied = Object.assign(new Error("Insufficient permissions"), { status: 403 });
  __setWorkOSForTests(fakeWorkOS({ existing: [], failCreate: denied }));
  await assert.rejects(
    () => ensureWorkOSRoles({ roles: [{ slug: "auditor" }] }),
    /Insufficient permissions/,
  );
});

test("the redirect URI is printed, because v10 cannot check it", async () => {
  // AuthKit's redirect URIs have no API in @workos-inc/node v10 — the only writable
  // `redirect_uris` belong to a Connect application, a different object. So the
  // honest output is the exact string to paste.
  assert.equal(oauthCallbackUri("https://app.example"), "https://app.example/oauth/callback");
  // A trailing slash must not produce a double slash: an allowlist compares strings.
  assert.equal(oauthCallbackUri("https://app.example/"), "https://app.example/oauth/callback");
});
