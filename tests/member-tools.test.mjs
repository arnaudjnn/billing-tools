// The member tools as a SURFACE: which of them register, who may call them, and what a
// refusal tells the caller to do next.
//
// `members.test.mjs` pins the rules; this pins the envelope, which is a separate claim and
// has its own failure modes. A group registered where the adapter cannot serve it is six
// tools that always fail — the false statement this project keeps deleting — and a refusal
// that says only "last_admin" leaves an agent to retry the same call for ever.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

const CONFIG = { currency: "eur", baseUrl: "https://t.local", internalDomains: [] };

const PLANS = {
  team: {
    sells: { kind: "flat", price: { monthly: 1000 } },
    cap: { kind: "pool", credits: 1000 },
    limits: { members: 2 },
    sale: "self_serve",
  },
};

/** The membership half of an adapter, on top of the minimum a tool needs. */
function adapterWith(extra = {}, rows = [{ userId: "u1", roleSlug: "admin", status: "active" }]) {
  const list = [...rows];
  return {
    rows: list,
    async validateApiKey() {
      return { orgId: "org_1" };
    },
    async getOrgDomains() {
      return [];
    },
    async getBillingCustomerId() {
      return "cus_1";
    },
    async setBillingCustomerId() {},
    async getOrgMetadata() {
      return {};
    },
    async setOrgMetadata() {},
    async getSubscription() {
      return { plan: "team", status: "active", subscriptionId: null, periodEnd: null };
    },
    async isAdmin() {
      return true;
    },
    async listMemberIds() {
      return list.map((m) => m.userId);
    },
    async memberCount() {
      return list.length;
    },
    ...extra,
  };
}

const describable = (rows) => ({
  async listMembers() {
    return rows;
  },
});

function invitationService(sent = []) {
  return {
    sent,
    async send(orgId, email, roleSlug) {
      const inv = {
        id: `inv_${sent.length + 1}`,
        email,
        roleSlug,
        orgId,
        organizationId: "org_1",
        state: "pending",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z",
      };
      sent.push(inv);
      return inv;
    },
    async list() {
      return sent;
    },
    async get() {
      return null;
    },
    async accept() {
      return { orgId: "org_1" };
    },
    async revoke(_orgId, id) {
      const i = sent.findIndex((s) => s.id === id);
      if (i >= 0) sent[i] = { ...sent[i], state: "revoked" };
    },
  };
}

async function surface(adapter, members) {
  const { createDispatcher } = await import("../dist/dispatch.js");
  const { registerBillingTools } = await import("../dist/tools/register.js");
  const { __setStripeForTests } = await import("../dist/billing.js");
  __setStripeForTests({
    subscriptions: { list: async () => ({ data: [] }) },
    customers: {
      async retrieve() {
        return { id: "cus_1", metadata: {}, balance: 0, currency: "eur" };
      },
    },
  });
  const { runWithPrincipal } = await import("../dist/auth.js");
  const d = createDispatcher((server) =>
    registerBillingTools(server, { adapter, config: CONFIG, plans: PLANS, members }),
  );
  // Every dispatch needs an auth context — the tools read the org off it, and a bare call is
  // a 401 before any of this is reached. `userId` is who the principal IS; whether they are an
  // admin comes from the adapter, deliberately, so a test cannot grant itself a role.
  const as = (userId) => (tool, args = {}) =>
    runWithPrincipal({ authHeader: "Bearer sk_x", principal: { userId } }, () => d.dispatchTool(tool, args));
  return { tools: new Set(d.getToolNames()), dispatch: as("u1"), as };
}

// `dispatchTool` parses the tool's JSON envelope already — a second JSON.parse here reads
// "[object Object]" and fails, which is the same trap the live harness hit.
const parse = (res) => res;

// ── which tools exist ────────────────────────────────────────────────────────

test("an adapter that cannot describe or change memberships gets none of the writes", async () => {
  // It can still LIST — `listMemberIds` answers "who is in here", which a seat screen needs.
  // What it must not advertise is a role change or a removal it cannot perform.
  const { tools } = await surface(adapterWith());
  assert.ok(tools.has("list_members"));
  for (const absent of ["change_member_role", "remove_member"]) {
    assert.ok(!tools.has(absent), `${absent} must not register`);
  }
});

test("no invitation service means no invitation tools", async () => {
  // There is nowhere to put the record. Registering them would be three tools whose only
  // possible answer is an error a caller cannot distinguish from holding it wrong.
  const { tools } = await surface(adapterWith({ ...describable([]), async setMemberRole() {}, async removeMember() {} }));
  for (const absent of ["invite_member", "list_invitations", "revoke_invitation"]) {
    assert.ok(!tools.has(absent), `${absent} must not register`);
  }
  assert.ok(tools.has("change_member_role"), "but the ones it CAN serve do");
});

test("the full set registers where everything is wired", async () => {
  const { tools } = await surface(
    adapterWith({ ...describable([]), async setMemberRole() {}, async removeMember() {} }),
    { invitations: invitationService() },
  );
  for (const name of [
    "list_members",
    "invite_member",
    "list_invitations",
    "revoke_invitation",
    "change_member_role",
    "remove_member",
  ]) {
    assert.ok(tools.has(name), `missing ${name}`);
  }
});

// ── who may call them ────────────────────────────────────────────────────────

test("reading the team is member-visible; changing it is not", async () => {
  // Every read in this library is member-visible and this is not the tool that breaks the
  // rule — "who is on my team" is not privileged to somebody on that team. The writes are
  // `enforceAdmin`, and a member's refusal is a 403 sentence, not a 500.
  const rows = [
    { userId: "u1", email: "a@x.test", name: "A", roleSlug: "admin", status: "active" },
    { userId: "u2", email: "b@x.test", name: "B", roleSlug: "member", status: "active" },
  ];
  const { as } = await surface(
    adapterWith(
      {
        ...describable(rows),
        async isAdmin() {
          return false; // the caller is a plain member
        },
        async setMemberRole() {},
        async removeMember() {},
      },
      rows,
    ),
    { invitations: invitationService() },
  );
  const asMember = as("u2");

  const read = parse(await asMember("list_members"));
  assert.equal(read.members.length, 2);
  assert.deepEqual(read.members[0], {
    member_id: "u1",
    email: "a@x.test",
    name: "A",
    role: "admin",
    status: "active",
  });

  for (const [tool, args] of [
    ["invite_member", { email: "c@x.test" }],
    ["change_member_role", { member_id: "u1", role: "member" }],
    ["remove_member", { member_id: "u1" }],
    ["revoke_invitation", { invitation_id: "inv_1" }],
  ]) {
    await assert.rejects(() => asMember(tool, args), /Forbidden \(403\)/, `${tool} must be admin-only`);
  }
});

// ── what the answers say ─────────────────────────────────────────────────────

test("list_members reports the seats, so a caller knows before it invites", async () => {
  const rows = [{ userId: "u1", email: "a@x.test", name: null, roleSlug: "admin", status: "active" }];
  const invitations = invitationService();
  const { dispatch } = await surface(adapterWith(describable(rows), rows), { invitations });
  await invitations.send("org_1", "b@x.test", "member");

  const res = parse(await dispatch("list_members", {}));
  assert.deepEqual(res.seats, {
    active: 1,
    pending_invitations: 1,
    limit: 2,
    remaining: 0,
  });
});

test("the limit refusal names what the seats are spent ON", async () => {
  // "The limit is 2" alone sends an owner looking for a bug when they can see one person.
  // The pending invitation they have forgotten about is the whole explanation.
  const rows = [{ userId: "u1", email: "a@x.test", name: null, roleSlug: "admin", status: "active" }];
  const invitations = invitationService();
  const { dispatch } = await surface(
    adapterWith({ ...describable(rows), async setMemberRole() {}, async removeMember() {} }, rows),
    { invitations },
  );
  await invitations.send("org_1", "b@x.test", "member");

  await assert.rejects(
    () => dispatch("invite_member", { email: "c@x.test" }),
    /1 active and 1 invitation\(s\) already pending/,
  );
  assert.equal(invitations.sent.length, 1, "and it did not send anyway");
});

test("the last-admin refusal says how to get past it", async () => {
  const rows = [
    { userId: "u1", email: "a@x.test", name: null, roleSlug: "admin", status: "active" },
    { userId: "u2", email: "b@x.test", name: null, roleSlug: "member", status: "active" },
  ];
  const { dispatch } = await surface(
    adapterWith({ ...describable(rows), async setMemberRole() {}, async removeMember() {} }, rows),
    { invitations: invitationService() },
  );

  await assert.rejects(
    () => dispatch("change_member_role", { member_id: "u1", role: "member" }),
    /only admin left[\s\S]*Promote somebody else first/,
  );
  await assert.rejects(
    () => dispatch("remove_member", { member_id: "u1" }),
    /only admin left/,
  );
});

test("a successful removal reports what it cleared", async () => {
  // The number is the point of the ordering: records first, then the membership. A caller
  // that sees `records_cleared` knows the ex-member's metadata budget came back.
  const rows = [
    { userId: "u1", email: "a@x.test", name: null, roleSlug: "admin", status: "active" },
    { userId: "u2", email: "b@x.test", name: null, roleSlug: "member", status: "active" },
  ];
  let removed = null;
  const { dispatch } = await surface(
    adapterWith(
      {
        ...describable(rows),
        async setMemberRole() {},
        async removeMember(_orgId, userId) {
          removed = userId;
        },
        async getUserMetadata() {
          return { btSeatType: JSON.stringify({ org_1: "standard" }) };
        },
        async setUserMetadata() {},
      },
      rows,
    ),
    { invitations: invitationService() },
  );

  const res = parse(await dispatch("remove_member", { member_id: "u2" }));
  assert.equal(res.status, "removed");
  assert.equal(res.member_id, "u2");
  assert.equal(res.records_cleared, 1);
  assert.equal(removed, "u2");
});

// ── the workspace itself ─────────────────────────────────────────────────────

test("close_workspace does NOT delete by default, and says what it kept", async () => {
  // The function's own default removes the org; the TOOL's does not. A tool call is one line
  // an agent can emit from a misread instruction, and the recoverable half of this — billing
  // stopped, invoices and workspace kept — is the half worth doing without being asked.
  const { __setStripeForTests } = await import("../dist/billing.js");
  let deleted = false;
  const rows = [{ userId: "u1", email: null, name: null, roleSlug: "admin", status: "active" }];
  const adapter = adapterWith(
    {
      ...describable(rows),
      async setMemberRole() {},
      async removeMember() {},
      async deleteOrg() {
        deleted = true;
      },
      async getUserMetadata() {
        return {};
      },
      async setUserMetadata() {},
    },
    rows,
  );
  const { dispatch } = await surface(adapter, { invitations: invitationService() });
  __setStripeForTests({
    subscriptions: {
      // `closeWorkspace` pages with `for await`, per the SDK-pagination rule — so the fake
      // has to be an async iterable, not a `{ data }` page.
      async *list() {
        yield { id: "sub_1", status: "active", cancel_at_period_end: false };
      },
      async cancel() {
        return { id: "sub_1", status: "canceled", canceled_at: 1_760_000_000 };
      },
      async update() {
        return { id: "sub_1", status: "active" };
      },
    },
    customers: {
      async retrieve() {
        return { id: "cus_1", metadata: {}, balance: 0, currency: "eur" };
      },
      async update() {
        return { id: "cus_1" };
      },
    },
    invoices: {
      async *list() {},
    },
  });

  const res = parse(await dispatch("close_workspace", {}));
  assert.equal(res.status, "closed");
  assert.equal(res.workspace_deleted, false);
  assert.equal(deleted, false, "the org survives unless asked");
  assert.deepEqual(res.subscriptions_cancelled, ["sub_1"], "and the billing did stop");
});

test("rename_workspace registers only where the adapter can write a name", async () => {
  const rows = [{ userId: "u1", email: null, name: null, roleSlug: "admin", status: "active" }];
  const without = await surface(adapterWith(describable(rows), rows));
  assert.ok(!without.tools.has("rename_workspace"));

  const with_ = await surface(
    adapterWith({ ...describable(rows), async renameOrg() {}, async getOrgName() { return "Old"; } }, rows),
  );
  assert.ok(with_.tools.has("rename_workspace"));
  const res = parse(await with_.dispatch("rename_workspace", { name: "New" }));
  assert.deepEqual([res.from, res.to], ["Old", "New"], "it reports what it changed");
});

test("an unknown role is refused by the schema, not by WorkOS", async () => {
  const rows = [{ userId: "u1", email: null, name: null, roleSlug: "admin", status: "active" }];
  const { dispatch } = await surface(
    adapterWith({ ...describable(rows), async setMemberRole() {}, async removeMember() {} }, rows),
    { invitations: invitationService(), roles: ["admin", "member"] },
  );
  await assert.rejects(() => dispatch("invite_member", { email: "a@x.test", role: "owner" }));
});
