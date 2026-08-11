// WHO may join, and who may leave — the two rules that were every consumer's to remember.
//
// `limits.members` was advertised by `list_plans` on every plan and enforced by nothing, and
// the last admin was protected by nothing: demote them and `isAdmin` answers false for
// everybody, so every admin-gated tool returns 403 to every human in the workspace. AGENTS.md
// said both out loud and left both to the app — so scartoffie counted seats itself and
// re-implemented the admin check, and gtm-tools, having no members UI, had neither rule and no
// way to add a person at all.
//
// These pin the rules, not the plumbing: what is refused, what is allowed, and the one place
// the library deliberately refuses on "I cannot tell" instead of allowing.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  changeMemberRole,
  inviteMember,
  isLastAdmin,
  lastAdminId,
  listMembers,
  memberSeats,
  removeMember,
} from "../dist/members.js";
import { assignSeatType, getSeatType } from "../dist/seats.js";
import { grantExtraAllowance } from "../dist/topup.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  team: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 } },
    },
    cap: { kind: "per_seat" },
    limits: { members: 3 },
    sale: "self_serve",
  },
  solo: {
    sells: { kind: "nothing" },
    cap: { kind: "pool", credits: 100 },
    limits: { members: 1 },
    sale: "free",
  },
  unlimited: {
    sells: { kind: "flat", price: { monthly: 9900 } },
    cap: { kind: "pool", credits: 100_000 },
    sale: "self_serve",
  },
};

/** A workspace whose memberships can be described and changed, like WorkOSOrgAdapter's. */
function withMembers(rows, opts = {}) {
  const list = [...rows];
  const adapter = fakeAdapter({ members: list.map((m) => m.userId), ...opts });
  // Every count reads the SAME list the writes mutate. The fake's own `memberCount` closes
  // over the array it was constructed with, so without this a removal frees no seat and the
  // test would be asserting the fixture rather than the rule.
  adapter.listMembers = async () => list.map((m) => ({ email: null, name: null, status: "active", ...m }));
  adapter.listMemberIds = async () => list.map((m) => m.userId);
  adapter.memberCount = async () => list.length;
  adapter.setMemberRole = async (_orgId, userId, roleSlug) => {
    const row = list.find((m) => m.userId === userId);
    if (row) row.roleSlug = roleSlug;
  };
  adapter.removeMember = async (_orgId, userId) => {
    const i = list.findIndex((m) => m.userId === userId);
    if (i >= 0) list.splice(i, 1);
  };
  adapter.rows = list;
  return adapter;
}

/** An invitation service that remembers what it was asked to send. */
function fakeInvitations(pending = []) {
  const sent = [...pending];
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

// ── the member limit ─────────────────────────────────────────────────────────

test("a PENDING invitation is a seat already taken", async () => {
  // The whole reason this is not "count the members": a three-seat workspace with one member
  // can send two invitations, and the third has nowhere to land. Checked against members
  // alone, all three go out and the refusal — if it ever comes — arrives when the last person
  // ACCEPTS, addressed to the one person who cannot do anything about it.
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }]);
  const invitations = fakeInvitations();

  const first = await inviteMember(adapter, "org_1", {
    email: "a@example.test", invitations, plans: PLANS, plan: "team",
  });
  assert.equal(first.ok, true);
  const second = await inviteMember(adapter, "org_1", {
    email: "b@example.test", invitations, plans: PLANS, plan: "team",
  });
  assert.equal(second.ok, true);
  assert.deepEqual(
    [second.seats.active, second.seats.pending, second.seats.remaining],
    [1, 1, 1],
    "one member, one invitation already out, one seat left",
  );

  const third = await inviteMember(adapter, "org_1", {
    email: "c@example.test", invitations, plans: PLANS, plan: "team",
  });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "limit_reached");
  assert.equal(invitations.sent.length, 2, "and nothing was sent");
});

test("a revoked invitation gives the seat back", async () => {
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }]);
  const invitations = fakeInvitations();
  await inviteMember(adapter, "org_1", { email: "a@x.test", invitations, plans: PLANS, plan: "team" });
  await inviteMember(adapter, "org_1", { email: "b@x.test", invitations, plans: PLANS, plan: "team" });
  assert.equal(
    (await inviteMember(adapter, "org_1", { email: "c@x.test", invitations, plans: PLANS, plan: "team" })).ok,
    false,
  );

  await invitations.revoke("org_1", "inv_1");
  const after = await inviteMember(adapter, "org_1", {
    email: "c@x.test", invitations, plans: PLANS, plan: "team",
  });
  assert.equal(after.ok, true, "the freed seat is usable");
});

test("a one-seat plan admits nobody but the owner", async () => {
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }]);
  const res = await inviteMember(adapter, "org_1", {
    email: "a@x.test", invitations: fakeInvitations(), plans: PLANS, plan: "solo",
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "limit_reached");
});

test("no declared limit is UNLIMITED, not zero", async () => {
  // `limits.members` absent means the plan did not say — the same reading `undefined` gets
  // everywhere else in this library. Treating it as 0 would refuse every invitation on a
  // plan that never intended a ceiling.
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }]);
  const seats = await memberSeats(adapter, "org_1", { plans: PLANS, plan: "unlimited" });
  assert.deepEqual([seats.limit, seats.remaining], [null, null]);
  assert.equal(
    (await inviteMember(adapter, "org_1", { email: "a@x.test", invitations: fakeInvitations(), plans: PLANS, plan: "unlimited" })).ok,
    true,
  );
});

test("and no plan at all is unlimited too", async () => {
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }]);
  const seats = await memberSeats(adapter, "org_1", { plans: PLANS, plan: null });
  assert.equal(seats.limit, null);
});

// ── the last admin ───────────────────────────────────────────────────────────

test("the last admin cannot be demoted", async () => {
  // What this prevents: `isAdmin` false for everyone, so every admin-gated tool answers 403
  // to every human in the workspace. Only an org API key gets back in — which is why the
  // failure survives a headless test suite and only bites a real person.
  const adapter = withMembers([
    { userId: "u1", roleSlug: "admin" },
    { userId: "u2", roleSlug: "member" },
  ]);
  assert.equal(await isLastAdmin(adapter, "org_1", "u1"), true);

  const res = await changeMemberRole(adapter, "org_1", "u1", "member");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "last_admin");
  assert.equal(adapter.rows[0].roleSlug, "admin", "and the role did not move");
});

test("promote somebody else first, and then it is allowed", async () => {
  const adapter = withMembers([
    { userId: "u1", roleSlug: "admin" },
    { userId: "u2", roleSlug: "member" },
  ]);
  assert.equal((await changeMemberRole(adapter, "org_1", "u2", "admin")).ok, true);
  assert.equal(await isLastAdmin(adapter, "org_1", "u1"), false, "no longer the only one");
  assert.equal((await changeMemberRole(adapter, "org_1", "u1", "member")).ok, true);
});

test("PROMOTING is never refused by the rule — it can only add an admin", async () => {
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }, { userId: "u2", roleSlug: "member" }]);
  assert.equal((await changeMemberRole(adapter, "org_1", "u2", "admin")).ok, true);
});

test("the last admin cannot be removed either", async () => {
  const adapter = withMembers([
    { userId: "u1", roleSlug: "admin" },
    { userId: "u2", roleSlug: "member" },
  ]);
  const res = await removeMember(adapter, "org_1", "u1");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "last_admin");
  assert.equal(adapter.rows.length, 2);
});

test("an unanswerable admin count REFUSES, unlike everything else here", async () => {
  // The deliberate exception to "unknown allows". Elsewhere a fact the adapter cannot report
  // (seat capacity, membership, whether somebody is blocked) allows, because refusing on it
  // strands a real customer. Here the thing being prevented IS the stranding: allow it and
  // nobody in the workspace can administer it again.
  const adapter = withMembers([{ userId: "u1", roleSlug: null }, { userId: "u2", roleSlug: null }]);
  assert.equal(await isLastAdmin(adapter, "org_1", "u1"), null, "cannot tell");
  assert.equal((await changeMemberRole(adapter, "org_1", "u1", "member")).reason, "last_admin");
});

// ── removing somebody ────────────────────────────────────────────────────────

test("their records go BEFORE the membership, because after is too late", async () => {
  // Both per-member stores are keyed by org and live on the MEMBER. Delete the membership
  // first and this workspace's seat and grants sit in an ex-member's own metadata for ever,
  // spending a character budget their remaining workspaces still need — and with the
  // membership gone there is nothing left to enumerate them from.
  const adapter = withMembers(
    [{ userId: "u1", roleSlug: "admin" }, { userId: "u2", roleSlug: "member" }],
    { subscription: { plan: "team", status: "active" } },
  );
  await assignSeatType(adapter, "org_1", "u2", "standard");
  await grantExtraAllowance(adapter, {
    orgId: "org_1", plans: PLANS, plan: "team", memberId: "u2", percent: 25,
  });
  assert.equal(await getSeatType(adapter, "org_1", "u2"), "standard");

  const res = await removeMember(adapter, "org_1", "u2");
  assert.equal(res.ok, true);
  assert.ok(res.cleared >= 1, "something was actually cleared");
  assert.equal(adapter.rows.length, 1, "and the membership is gone");
  assert.deepEqual(await adapter.getUserMetadata("u2"), {}, "nothing of this org left on them");
});

test("removing frees a seat for the next invitation", async () => {
  const adapter = withMembers([
    { userId: "u1", roleSlug: "admin" },
    { userId: "u2", roleSlug: "member" },
    { userId: "u3", roleSlug: "member" },
  ]);
  const invitations = fakeInvitations();
  assert.equal(
    (await inviteMember(adapter, "org_1", { email: "d@x.test", invitations, plans: PLANS, plan: "team" })).ok,
    false,
    "three of three seats taken",
  );
  await removeMember(adapter, "org_1", "u3");
  assert.equal(
    (await inviteMember(adapter, "org_1", { email: "d@x.test", invitations, plans: PLANS, plan: "team" })).ok,
    true,
  );
});

test("a stranger is refused rather than silently succeeding", async () => {
  const adapter = withMembers([{ userId: "u1", roleSlug: "admin" }, { userId: "u2", roleSlug: "admin" }]);
  assert.equal((await removeMember(adapter, "org_1", "nobody")).reason, "not_a_member");
  assert.equal((await changeMemberRole(adapter, "org_1", "nobody", "member")).reason, "not_a_member");
});

test("an adapter that cannot write memberships says so, rather than reporting success", async () => {
  const adapter = fakeAdapter({ members: ["u1"] });
  assert.equal((await changeMemberRole(adapter, "org_1", "u1", "member")).reason, "unsupported");
  assert.equal((await removeMember(adapter, "org_1", "u1")).reason, "unsupported");
});

// ── reading ──────────────────────────────────────────────────────────────────

test("listMembers falls back to ids where that is all the adapter has", async () => {
  // An adapter with `listMemberIds` and no `listMembers` still answers "who is in here",
  // which is what a seat screen needs — with a null role, which is exactly what makes the
  // last-admin rule refuse rather than guess.
  const adapter = fakeAdapter({ members: ["u1", "u2"] });
  const members = await listMembers(adapter, "org_1");
  assert.deepEqual(members.map((m) => m.userId), ["u1", "u2"]);
  assert.deepEqual(members.map((m) => m.roleSlug), [null, null]);
});

test("and an adapter that can enumerate nothing reports nobody, not an error", async () => {
  const adapter = fakeAdapter({ userMetadata: false });
  assert.deepEqual(await listMembers(adapter, "org_1"), []);
});

// ── lastAdminId: the list-shaped read of isLastAdmin ──────────────────────────

test("lastAdminId names the sole admin in ONE call — a table needs it once, not per row", async () => {
  const adapter = withMembers([
    { userId: "u1", roleSlug: "admin" },
    { userId: "u2", roleSlug: "member" },
    { userId: "u3", roleSlug: "member" },
  ]);
  assert.equal(await lastAdminId(adapter, "org_1"), "u1");
  // And it agrees with the per-candidate guard, which is the enforcement.
  assert.equal(await isLastAdmin(adapter, "org_1", "u1"), true);
});

test("several admins, or unreadable roles, answer null — the UI then disables nothing", async () => {
  const two = withMembers([
    { userId: "u1", roleSlug: "admin" },
    { userId: "u2", roleSlug: "admin" },
  ]);
  assert.equal(await lastAdminId(two, "org_1"), null);
  // Roles unreadable: null here disables no rendering hint, while the WRITE path
  // still refuses via isLastAdmin's own fail-closed null.
  const blind = fakeAdapter({ members: ["u1", "u2"] });
  assert.equal(await lastAdminId(blind, "org_1"), null);
  assert.equal(await isLastAdmin(blind, "org_1", "u1"), null);
});
