// Accepting an invitation, and the refusal that made it impossible.
//
// SENDING an invitation makes WorkOS create a PENDING organization membership
// for the invited user. Acceptance here creates the membership itself (rather
// than calling WorkOS's accept) so that a `canAccept` hook can widen acceptance
// to a verified secondary email — and that create is refused, because a pending
// membership already exists:
//
//   400 cannot_reactivate_pending_organization_membership
//   "Pending organization memberships cannot be reactivated. The invite must be
//    accepted instead."
//
// Only `ConflictException` was tolerated, so this threw for EVERY ordinary
// invitee. Nothing caught it because the whole suite adds members directly
// through WorkOS, and the one path a real colleague walks had never been run.
//
// A fake would have accepted the create happily — which is precisely why this
// pins the SHAPE of the real refusal (bare `GenericServerException`, no class to
// narrow to, a stable machine `code`) rather than a fake's convenience.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test, afterEach } from "vitest";

import { createWorkOSInvitations } from "../dist/invitations.js";
import { __setWorkOSForTests } from "../dist/workos.js";

const PENDING_CODE = "cannot_reactivate_pending_organization_membership";

/** WorkOS's real refusal: a bare error carrying a code, NOT a typed exception. */
function pendingMembershipError() {
  const e = new Error(
    "Pending organization memberships cannot be reactivated. The invite must be accepted instead.",
  );
  e.status = 400;
  e.code = PENDING_CODE;
  return e;
}

function fakeWorkOS({ createFails }) {
  const calls = [];
  return {
    calls,
    userManagement: {
      async getInvitation(id) {
        return {
          id,
          email: "new@acme.com",
          state: "pending",
          organizationId: "org_1",
          roleSlug: "member",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      async createOrganizationMembership(opts) {
        calls.push(["create", opts.userId, opts.roleSlug]);
        if (createFails) throw pendingMembershipError();
        return { id: "om_1" };
      },
      async acceptInvitation(id) {
        calls.push(["accept", id]);
        return { id, state: "accepted" };
      },
      async revokeInvitation(id) {
        calls.push(["revoke", id]);
        return { id, state: "revoked" };
      },
    },
  };
}

const USER = { id: "user_1", email: "new@acme.com" };
const service = () =>
  createWorkOSInvitations({ map: { toWorkosOrgId: async (o) => o, toOrgId: async (o) => o } });

afterEach(() => __setWorkOSForTests(undefined));

test("a pending membership falls back to WorkOS's own accept", async () => {
  const wos = fakeWorkOS({ createFails: true });
  __setWorkOSForTests(wos);

  const r = await service().accept("invitation_1", USER);
  assert.equal(r.orgId, "org_1");

  // It TRIED the create first — that is what serves a secondary-email acceptor,
  // whom WorkOS's accept would enrol as the wrong account.
  assert.deepEqual(wos.calls[0], ["create", "user_1", "member"]);
  assert.deepEqual(wos.calls[1], ["accept", "invitation_1"]);
  // And it does NOT then revoke: WorkOS has already moved the invitation to
  // `accepted`, so revoking would be undoing the acceptance just performed.
  assert.equal(
    wos.calls.some(([kind]) => kind === "revoke"),
    false,
    "an accepted invitation must not be revoked afterwards",
  );
});

test("with no pending membership the create path still owns acceptance", async () => {
  const wos = fakeWorkOS({ createFails: false });
  __setWorkOSForTests(wos);

  await service().accept("invitation_1", USER);
  // Create, then consume the invitation — the path a secondary-email acceptor
  // takes, and the reason WorkOS's accept is a fallback rather than the lead.
  assert.deepEqual(wos.calls, [
    ["create", "user_1", "member"],
    ["revoke", "invitation_1"],
  ]);
});

test("an unrelated failure is still a failure", async () => {
  const wos = fakeWorkOS({ createFails: false });
  wos.userManagement.createOrganizationMembership = async () => {
    const e = new Error("Organization not found");
    e.status = 404;
    e.code = "organization_not_found";
    throw e;
  };
  __setWorkOSForTests(wos);

  // The fallback keys on ONE code. A status-based guard would have swallowed
  // this, and a caller would read "joined" for a workspace that does not exist.
  await assert.rejects(() => service().accept("invitation_1", USER), /Organization not found/);
  assert.equal(
    wos.calls.some(([kind]) => kind === "accept"),
    false,
  );
});

test("the wrong person cannot accept, whatever WorkOS would allow", async () => {
  const wos = fakeWorkOS({ createFails: true });
  __setWorkOSForTests(wos);

  await assert.rejects(
    () => service().accept("invitation_1", { id: "user_2", email: "someone@else.com" }),
    /This invitation is for new@acme.com/,
  );
  // Refused BEFORE any WorkOS write — the fallback must not become a way past
  // the identity check, since `acceptInvitation` asks WorkOS for no user at all.
  assert.deepEqual(wos.calls, []);
});
