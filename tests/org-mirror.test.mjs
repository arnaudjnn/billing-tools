// Pattern B — an app row kept 1:1 with a WorkOS org (scartoffie's workspaces).
//
// The seam is two functions over wherever the app keeps its pointer; a `Map` satisfies it,
// which is what these use. WorkOS is an in-memory fake that ENFORCES what the real API
// does and a permissive fake would not: `externalId` is unique, a missing org is a
// `NotFoundException`, a duplicate membership a `ConflictException`. Without those the
// self-healing claims below would be true of any implementation.

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { ConflictException, NotFoundException } from "@workos-inc/node";

import { createWorkOSOrgMirror, ALL_MEMBERSHIP_STATUSES } from "../dist/org-mirror.js";
import { __setWorkOSForTests } from "../dist/workos.js";
import { WorkOSOrgAdapter } from "../dist/adapters/workos-org.js";

afterEach(() => __setWorkOSForTests(null));

const notFound = (path) => new NotFoundException({ path });

function fakeWorkOS() {
  const orgs = new Map();
  const memberships = [];
  const calls = { create: 0, getByExternalId: 0, listMemberships: [] };
  let seq = 0;
  // Hooks a test sets to interleave a concurrent request at an exact point.
  const hooks = { beforeCreate: null };
  return {
    orgs,
    memberships,
    calls,
    hooks,
    organizations: {
      async getOrganization(id) {
        const o = orgs.get(id);
        if (!o) throw notFound(`/organizations/${id}`);
        return o;
      },
      async getOrganizationByExternalId(externalId) {
        calls.getByExternalId++;
        const o = [...orgs.values()].find((x) => x.externalId === externalId);
        if (!o) throw notFound(`/organizations/external_id/${externalId}`);
        return o;
      },
      async createOrganization({ name, externalId }) {
        calls.create++;
        if (hooks.beforeCreate) await hooks.beforeCreate();
        if (externalId && [...orgs.values()].some((x) => x.externalId === externalId)) {
          throw new ConflictException({ message: "An organization with this external_id already exists." });
        }
        const o = { id: `org_${++seq}`, name, externalId: externalId ?? null, domains: [], metadata: {} };
        orgs.set(o.id, o);
        return o;
      },
      async updateOrganization({ organization, name }) {
        const o = orgs.get(organization);
        if (!o) throw notFound(`/organizations/${organization}`);
        o.name = name;
        return o;
      },
      async deleteOrganization(id) {
        if (!orgs.delete(id)) throw notFound(`/organizations/${id}`);
      },
    },
    userManagement: {
      async createOrganizationMembership({ organizationId, userId, roleSlug }) {
        if (memberships.some((m) => m.organizationId === organizationId && m.userId === userId)) {
          throw new ConflictException({ message: "already a member" });
        }
        const m = { id: `om_${memberships.length + 1}`, organizationId, userId, roleSlug, status: "active" };
        memberships.push(m);
        return m;
      },
      async listOrganizationMemberships(params) {
        calls.listMemberships.push(params);
        const statuses = params.statuses ?? ["active"];
        return {
          data: memberships.filter(
            (m) =>
              m.organizationId === params.organizationId &&
              m.userId === params.userId &&
              statuses.includes(m.status),
          ),
        };
      },
    },
  };
}

/** The app's pointer column, as a Map, plus a record of writes. */
function pointerStore(rows = ["ws_1", "ws_2"]) {
  const pointer = new Map();
  const writes = [];
  return {
    pointer,
    writes,
    async readPointer(localId) {
      if (!rows.includes(localId)) throw new Error(`no workspace ${localId}`);
      return pointer.get(localId) ?? null;
    },
    async writePointer(localId, workosOrgId) {
      writes.push([localId, workosOrgId]);
      pointer.set(localId, workosOrgId);
    },
  };
}

test("first read of a row with no pointer creates the org, keyed by the local id", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const store = pointerStore();
  const mirror = createWorkOSOrgMirror({ ...store, nameFor: (id) => `Workspace ${id}` });

  const orgId = await mirror.toWorkosOrgId("ws_1");

  assert.equal(wos.orgs.get(orgId).externalId, "ws_1");
  assert.equal(wos.orgs.get(orgId).name, "Workspace ws_1");
  assert.deepEqual(store.writes, [["ws_1", orgId]]);
});

test("a stored pointer is trusted — no WorkOS call at all", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const store = pointerStore();
  store.pointer.set("ws_1", "org_existing");
  const mirror = createWorkOSOrgMirror(store);

  assert.equal(await mirror.toWorkosOrgId("ws_1"), "org_existing");
  assert.equal(wos.calls.create + wos.calls.getByExternalId, 0);
});

test("a lost pointer is RECOVERED from the org, not answered with a second org", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const store = pointerStore();
  const mirror = createWorkOSOrgMirror(store);
  const first = await mirror.toWorkosOrgId("ws_1");

  store.pointer.clear(); // a restore from backup, a column dropped and re-added…
  const again = await mirror.toWorkosOrgId("ws_1");

  assert.equal(again, first);
  assert.equal(wos.orgs.size, 1);
  assert.equal(wos.calls.create, 1);
  assert.deepEqual(store.pointer.get("ws_1"), first, "and the pointer is written back");
});

test("a row that does not exist is an error, never a fresh org", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const mirror = createWorkOSOrgMirror(pointerStore(["ws_1"]));
  await assert.rejects(mirror.toWorkosOrgId("ws_ghost"), /no workspace ws_ghost/);
  assert.equal(wos.orgs.size, 0);
});

test("ensureOrg is idempotent, and an explicit name beats nameFor", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const mirror = createWorkOSOrgMirror({ ...pointerStore(), nameFor: () => "From nameFor" });
  const a = await mirror.ensureOrg("ws_2", "Acme");
  const b = await mirror.ensureOrg("ws_2", "Ignored second time");
  assert.equal(a, b);
  assert.equal(wos.orgs.get(a).name, "Acme");
  assert.equal(wos.calls.create, 1);
});

test("no name anywhere falls back to 'Workspace'", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const id = await createWorkOSOrgMirror(pointerStore()).ensureOrg("ws_1");
  assert.equal(wos.orgs.get(id).name, "Workspace");
});

test("two first reads of the same row racing end on ONE org, and neither fails", async () => {
  // REGRESSION: both requests miss the externalId lookup, both create, and WorkOS refuses
  // the second for its duplicate externalId. That refusal is proof the org exists, but it
  // was re-thrown — so the second of two concurrent first page loads failed.
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const store = pointerStore();
  const mirror = createWorkOSOrgMirror(store);

  // Hold both creates until both lookups have missed.
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  wos.hooks.beforeCreate = async () => {
    if (++waiting === 2) release();
    await gate;
  };

  const [a, b] = await Promise.all([mirror.toWorkosOrgId("ws_1"), mirror.toWorkosOrgId("ws_1")]);
  assert.equal(a, b);
  assert.equal(wos.orgs.size, 1);
  assert.equal(store.pointer.get("ws_1"), a);
});

test("a create that fails for any other reason still fails", async () => {
  const wos = fakeWorkOS();
  wos.organizations.createOrganization = async () => {
    throw new Error("WorkOS is down");
  };
  __setWorkOSForTests(wos);
  const store = pointerStore();
  await assert.rejects(createWorkOSOrgMirror(store).ensureOrg("ws_1"), /WorkOS is down/);
  assert.equal(store.writes.length, 0, "no pointer written for an org that does not exist");
});

test("a lookup failure other than not-found is not mistaken for 'create one'", async () => {
  const wos = fakeWorkOS();
  wos.organizations.getOrganizationByExternalId = async () => {
    throw new Error("rate limited");
  };
  __setWorkOSForTests(wos);
  await assert.rejects(createWorkOSOrgMirror(pointerStore()).ensureOrg("ws_1"), /rate limited/);
  assert.equal(wos.calls.create, 0);
});

// ── the reverse map ──────────────────────────────────────────────────────────

test("toOrgId prefers the app's own answer, then the org's externalId", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const plain = createWorkOSOrgMirror(pointerStore());
  const orgId = await plain.ensureOrg("ws_1");
  assert.equal(await plain.toOrgId(orgId), "ws_1", "from externalId");

  const withReverse = createWorkOSOrgMirror({
    ...pointerStore(),
    reversePointer: async (w) => (w === orgId ? "ws_from_db" : null),
  });
  assert.equal(await withReverse.toOrgId(orgId), "ws_from_db");
});

test("toOrgId of an org that does not exist, or has no externalId, is null", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const mirror = createWorkOSOrgMirror(pointerStore());
  assert.equal(await mirror.toOrgId("org_missing"), null);
  const bare = await wos.organizations.createOrganization({ name: "No external id" });
  assert.equal(await mirror.toOrgId(bare.id), null);
});

// ── rename / delete / membership ─────────────────────────────────────────────

test("rename and delete tolerate an org already gone, and nothing else", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const mirror = createWorkOSOrgMirror(pointerStore());
  const id = await mirror.ensureOrg("ws_1");

  await mirror.renameOrg(id, "Renamed");
  assert.equal(wos.orgs.get(id).name, "Renamed");
  await mirror.deleteOrg(id);
  assert.equal(wos.orgs.has(id), false);

  await mirror.deleteOrg(id); // already gone: success
  await mirror.renameOrg(id, "x"); // nothing to rename: success

  wos.organizations.deleteOrganization = async () => {
    throw new Error("forbidden");
  };
  await assert.rejects(mirror.deleteOrg("org_other"), /forbidden/);
});

test("ensureMembership tolerates an existing membership; membershipId sees every status", async () => {
  const wos = fakeWorkOS();
  __setWorkOSForTests(wos);
  const mirror = createWorkOSOrgMirror(pointerStore());
  const id = await mirror.ensureOrg("ws_1");

  await mirror.ensureMembership(id, "user_1", "admin");
  await mirror.ensureMembership(id, "user_1", "admin"); // ConflictException swallowed
  assert.equal(wos.memberships.length, 1);

  // A pending member is invisible to the default (active-only) listing.
  wos.memberships[0].status = "pending";
  assert.equal(await mirror.membershipId(id, "user_1"), "om_1");
  assert.deepEqual(wos.calls.listMemberships.at(-1).statuses, [...ALL_MEMBERSHIP_STATUSES]);
  assert.equal(await mirror.membershipId(id, "user_nobody"), null);
});

test("ensureMembership does not swallow a failure that is not a conflict", async () => {
  const wos = fakeWorkOS();
  wos.userManagement.createOrganizationMembership = async () => {
    throw notFound("/users/user_x");
  };
  __setWorkOSForTests(wos);
  await assert.rejects(createWorkOSOrgMirror(pointerStore()).ensureMembership("org_1", "user_x", "member"));
});

// ── as the adapter's map ─────────────────────────────────────────────────────

test("the mirror plugs into WorkOSOrgAdapter: a key resolves to the LOCAL id", async () => {
  const wos = fakeWorkOS();
  const mirror = createWorkOSOrgMirror(pointerStore());
  __setWorkOSForTests(wos);
  const workosOrgId = await mirror.ensureOrg("ws_1");
  wos.apiKeys = {
    async createValidation({ value }) {
      return value === "sk_good" ? { apiKey: { id: "key_1", owner: { id: workosOrgId } } } : { apiKey: null };
    },
  };
  const adapter = new WorkOSOrgAdapter({ map: mirror });
  assert.deepEqual(await adapter.validateApiKey("sk_good"), { orgId: "ws_1", keyId: "key_1" });
  assert.equal(await adapter.validateApiKey("sk_bad"), null);
});
