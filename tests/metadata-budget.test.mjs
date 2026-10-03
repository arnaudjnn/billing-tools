// The org metadata KEY budget: WorkOS allows 10 keys per org and validates the MERGED
// object, so a write that adds an eleventh fails as a whole — subscription sync included.
// The library's own keys reach eleven on an org that has been through every feature.
//
//   (a) the legacy org maps (`seatAssignments`, `topUpGrants`) migrate onto their members on
//       the next write and stop counting — without changing a single read;
//   (b) an over-budget write lands its ESSENTIAL keys (subscription state) first, evicting
//       the alert ledger if it must, and refuses only the non-essential key, loudly;
//   (c) the doctor lists orgs at 9+ keys before they get there.
//
// The fake WorkOS enforces the limit on the merged object, as WorkOS does — a fake that
// accepted anything is how every one of these would pass while production failed.

process.env.WORKOS_API_KEY ??= "sk_test_fake";
process.env.WORKOS_CLIENT_ID ??= "client_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { MetadataBudgetError, WorkOSOrgAdapter } from "../dist/adapters/workos-org.js";
import { checkWorkOSSetup } from "../dist/doctor.js";
import { listSeatAssignments } from "../dist/seats.js";
import { __setWorkOSForTests } from "../dist/workos.js";

afterEach(() => __setWorkOSForTests(null));

const MAX = 10;

function fakeWorkOS({ orgs = { org_1: {} }, users = {}, failUserWrites = false } = {}) {
  const orgMd = Object.fromEntries(Object.entries(orgs).map(([id, md]) => [id, { ...md }]));
  const userMd = Object.fromEntries(Object.entries(users).map(([id, md]) => [id, { ...md }]));
  const updates = [];
  const merge = (target, patch) => {
    const next = { ...target };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    return next;
  };
  return {
    orgMd,
    userMd,
    updates,
    organizations: {
      async getOrganization(id) {
        return { id, name: id, domains: [], metadata: { ...(orgMd[id] ?? {}) } };
      },
      async updateOrganization({ organization, metadata }) {
        updates.push(metadata);
        const next = merge(orgMd[organization] ?? {}, metadata ?? {});
        if (Object.keys(next).length > MAX) {
          throw new Error(`metadata may have at most ${MAX} keys`);
        }
        orgMd[organization] = next;
        return { id: organization, metadata: next };
      },
      async listOrganizations() {
        const rows = Object.entries(orgMd).map(([id, metadata]) => ({ id, metadata }));
        return { data: rows, autoPagination: async () => rows };
      },
    },
    userManagement: {
      async getUser(id) {
        return { id, metadata: { ...(userMd[id] ?? {}) } };
      },
      async updateUser({ userId, metadata }) {
        if (failUserWrites) throw new Error("WorkOS 503");
        userMd[userId] = merge(userMd[userId] ?? {}, metadata);
        return { id: userId, metadata: userMd[userId] };
      },
      async listOrganizationMemberships() {
        const members = Object.keys(userMd).concat(["u1", "u2"]);
        return { data: [...new Set(members)].map((userId) => ({ userId, status: "active" })), autoPagination: async () => [...new Set(members)].map((userId) => ({ userId, status: "active" })) };
      },
    },
  };
}

const json = (v) => JSON.stringify(v);

// ── (a) legacy keys migrate out ──────────────────────────────────────────────

test("the legacy maps move onto their members and leave the org", async () => {
  const wos = fakeWorkOS({
    orgs: {
      org_1: {
        seatAssignments: json({ u1: "premium", u2: "standard" }),
        topUpGrants: json({ u1: { "2026-10": 500 } }),
      },
    },
    // u2 already has its own record for this org, which has always won on read.
    users: { u2: { btSeatType: json({ org_1: "premium" }) } },
  });
  __setWorkOSForTests(wos);
  const adapter = new WorkOSOrgAdapter();

  await adapter.setOrgMetadata("org_1", { someAppKey: "v" });

  assert.equal(wos.orgMd.org_1.seatAssignments, undefined, "no longer counts against the budget");
  assert.equal(wos.orgMd.org_1.topUpGrants, undefined);
  assert.equal(wos.orgMd.org_1.someAppKey, "v", "and the write itself landed");
  assert.deepEqual(JSON.parse(wos.userMd.u1.btSeatType), { org_1: "premium" });
  assert.deepEqual(JSON.parse(wos.userMd.u2.btSeatType), { org_1: "premium" }, "the member's own record is kept");
  assert.deepEqual(JSON.parse(wos.userMd.u1.btTopUpGrants), { org_1: { "2026-10": 500 } });
});

test("reads are unchanged by the migration", async () => {
  const before = { seatAssignments: json({ u1: "premium", u2: "standard" }) };
  const users = { u2: { btSeatType: json({ org_1: "" }) } }; // u2 explicitly cleared
  const read = async (wos) => {
    __setWorkOSForTests(wos);
    return listSeatAssignments(new WorkOSOrgAdapter(), "org_1");
  };
  const old = await read(fakeWorkOS({ orgs: { org_1: before }, users }));
  const wos = fakeWorkOS({ orgs: { org_1: before }, users });
  __setWorkOSForTests(wos);
  await new WorkOSOrgAdapter().setOrgMetadata("org_1", { x: "1" });
  assert.equal(wos.orgMd.org_1.seatAssignments, undefined);
  assert.deepEqual(await read(wos), old);
});

test("a member write that fails keeps the legacy key: nothing is deleted that was not copied", async () => {
  const wos = fakeWorkOS({
    orgs: { org_1: { seatAssignments: json({ u1: "premium" }) } },
    failUserWrites: true,
  });
  __setWorkOSForTests(wos);
  const log = console.error;
  console.error = () => {};
  try {
    await new WorkOSOrgAdapter().setOrgMetadata("org_1", { x: "1" });
  } finally {
    console.error = log;
  }
  assert.equal(wos.orgMd.org_1.seatAssignments, json({ u1: "premium" }));
  assert.equal(wos.orgMd.org_1.x, "1", "the write itself still lands");
});

// ── (b) an over-budget write ─────────────────────────────────────────────────

const FULL = {
  subscriptionStatus: "active",
  stripeSubscriptionId: "sub_1",
  subscriptionPeriodEnd: "2026-11-01T00:00:00.000Z",
  plan: "pro",
  subscriptionSeatCounts: json({ standard: 2 }),
  btPlanRequests: "[]",
  btAlerts: json({ a: 1 }),
  topUpRequests: "[]",
  appA: "1",
  appB: "2",
};

test("the subscription sync still lands on a full org — the alert ledger makes room", async () => {
  // REGRESSION: the eleventh key failed the whole update, so `past_due` / a plan change was
  // never recorded for an org whose metadata happened to be full.
  const wos = fakeWorkOS({ orgs: { org_1: { ...FULL } } });
  __setWorkOSForTests(wos);
  await new WorkOSOrgAdapter().setSubscription("org_1", {
    plan: "pro",
    status: "past_due",
    subscriptionId: "sub_1",
    periodStart: "2026-10-01T00:00:00.000Z", // a NEW key: the eleventh
    periodEnd: "2026-11-01T00:00:00.000Z",
  });
  const md = wos.orgMd.org_1;
  assert.equal(md.subscriptionStatus, "past_due");
  assert.equal(md.subscriptionPeriodStart, "2026-10-01T00:00:00.000Z");
  assert.equal(md.btAlerts, undefined, "evicted — at worst an alert is re-sent");
  assert.equal(md.btPlanRequests, "[]", "the request queue is NEVER evicted");
  assert.ok(Object.keys(md).length <= MAX);
});

test("a non-essential key that does not fit is refused by name, and nothing else is lost", async () => {
  const wos = fakeWorkOS({ orgs: { org_1: { ...FULL } } });
  __setWorkOSForTests(wos);
  const err = await new WorkOSOrgAdapter()
    .setOrgMetadata("org_1", { newFeatureKey: "x" })
    .catch((e) => e);
  assert.ok(err instanceof MetadataBudgetError, String(err));
  assert.deepEqual(err.keys, ["newFeatureKey"]);
  assert.match(err.message, /metadata is full .*newFeatureKey/);
  assert.deepEqual(wos.orgMd.org_1, FULL, "the org is untouched");
});

test("a mixed write lands its essential half, then refuses the rest", async () => {
  const wos = fakeWorkOS({ orgs: { org_1: { ...FULL } } });
  __setWorkOSForTests(wos);
  const err = await new WorkOSOrgAdapter()
    .setOrgMetadata("org_1", { pendingPlan: "team", btNewThing: "x" })
    .catch((e) => e);
  assert.ok(err instanceof MetadataBudgetError);
  assert.deepEqual(err.keys, ["btNewThing"]);
  assert.equal(wos.orgMd.org_1.pendingPlan, "team", "the essential key landed first");
  assert.equal(wos.orgMd.org_1.btAlerts, undefined, "by evicting the alert ledger");
});

test("an essential write that cannot fit even after eviction is refused whole, and loudly", async () => {
  const wos = fakeWorkOS({ orgs: { org_1: { ...FULL } } });
  __setWorkOSForTests(wos);
  const err = await new WorkOSOrgAdapter()
    .setOrgMetadata("org_1", { pendingPlan: "team", pendingPlanAt: "2026-11-01" })
    .catch((e) => e);
  assert.ok(err instanceof MetadataBudgetError);
  assert.deepEqual(err.keys.sort(), ["pendingPlan", "pendingPlanAt"]);
  assert.deepEqual(wos.orgMd.org_1, FULL, "a partial essential write would be worse than none");
});

test("updating a key that already exists never counts as a new one", async () => {
  const wos = fakeWorkOS({ orgs: { org_1: { ...FULL } } });
  __setWorkOSForTests(wos);
  await new WorkOSOrgAdapter().setOrgMetadata("org_1", { btPlanRequests: json([{ id: "r1" }]) });
  assert.equal(wos.orgMd.org_1.btPlanRequests, json([{ id: "r1" }]));
  assert.equal(wos.updates.length, 1, "a write that fits is ONE update");
});

test("deletions are never refused — they are how an org gets back under budget", async () => {
  const wos = fakeWorkOS({ orgs: { org_1: { ...FULL } } });
  __setWorkOSForTests(wos);
  await new WorkOSOrgAdapter().setOrgMetadata("org_1", { appA: null, newKey: "fits now" });
  assert.equal(wos.orgMd.org_1.appA, undefined);
  assert.equal(wos.orgMd.org_1.newKey, "fits now");
});

// ── (c) the doctor ───────────────────────────────────────────────────────────

test("the doctor lists orgs at 9 or more keys", async () => {
  const nine = Object.fromEntries(Object.entries(FULL).slice(0, 9));
  __setWorkOSForTests(
    fakeWorkOS({ orgs: { org_full: { ...FULL }, org_nine: nine, org_fine: { plan: "pro" } } }),
  );
  const r = await checkWorkOSSetup();
  const c = r.checks.find((x) => x.title === "Org metadata key budget");
  assert.equal(c.level, "warn");
  assert.match(c.detail, /org_full \(10 keys\)/);
  assert.match(c.detail, /org_nine \(9 keys\)/);
  assert.doesNotMatch(c.detail, /org_fine/);
});

test("…and says so when none is", async () => {
  __setWorkOSForTests(fakeWorkOS({ orgs: { org_fine: { plan: "pro" } } }));
  const r = await checkWorkOSSetup();
  assert.equal(r.checks.find((x) => x.title === "Org metadata key budget").level, "ok");
});
