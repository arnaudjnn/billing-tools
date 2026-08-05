// A real WorkOS org with a real admin and a real member.
//
// This is the half no offline test can reach. `WorkOSOrgAdapter.isAdmin` asks WorkOS
// whether the member's membership carries the role slug `admin`, and everything about that
// claim — that the role exists in this environment, that `roleSlug` on a membership is
// what `isAdmin` reads, that a default membership is NOT an admin — is only true or false
// against the live API. A fake adapter returning `true`/`false` proves the gate's wiring
// and nothing about the role.

import { getWorkOS } from "../../dist/workos.js";
import { ADMIN_ROLE_SLUG, listWorkOSRoleSlugs } from "../../dist/workos-setup.js";
import { defer, ignoreMissing, note } from "./harness.mjs";
import { RUN } from "./scratch-stripe.mjs";

/**
 * Refuse early if the environment lacks the roles.
 *
 * Without an `admin` role no membership can carry it, so `isAdmin` is false for everyone
 * and EVERY "an admin is allowed" assertion fails — for a reason that has nothing to do
 * with the code under test. Better to stop here, named, than to read 13 red lines and go
 * looking in the wrong place.
 */
export async function preflightRoles() {
  const slugs = await listWorkOSRoleSlugs();
  const missing = [ADMIN_ROLE_SLUG, "member"].filter((s) => !slugs.includes(s));
  if (missing.length) {
    console.error(
      `Refusing to run: this WorkOS environment has no ${missing.map((m) => `"${m}"`).join(" or ")} role ` +
        `(found: ${slugs.join(", ") || "none"}).\n` +
        `Without them isAdmin is false for everyone and every role assertion fails for the wrong reason.\n` +
        `Fix: ensureWorkOSRoles({ roles: [{ slug: "member", name: "Member" }] }) — "admin" ships with the environment.`,
    );
    process.exit(2);
  }
  return slugs;
}

/**
 * Org + two users + two memberships, one `admin` and one `member`.
 *
 * No `domainData`: a verified domain would make the org match `internalDomains` on some
 * configs and be silently unmetered, which would quietly void the usage assertions.
 */
export async function createScratchOrg({ name = `E2E Live ${RUN}`, suffix = "" } = {}) {
  const workos = getWorkOS();

  const org = await workos.organizations.createOrganization({ name });
  // `ignoreMissing`, because section 10 CLOSES a workspace on purpose: its teardown finding
  // the org already gone is the one tolerated outcome. Anything else still fails the run.
  defer(`WorkOS org ${org.id}`, () => workos.organizations.deleteOrganization(org.id).catch(ignoreMissing));

  const mkUser = async (role) => {
    const user = await workos.userManagement.createUser({
      // `suffix` keeps a SECOND org's users from colliding: WorkOS requires a unique email,
      // so cross-org isolation could not be tested without it.
      email: `${RUN}${suffix}-${role}@example.test`,
      firstName: role === "admin" ? "Ada" : "Mem",
      lastName: `${RUN}${suffix}`,
      emailVerified: true,
    });
    defer(`WorkOS user ${role} ${user.id}`, () => workos.userManagement.deleteUser(user.id).catch(ignoreMissing));

    const membership = await workos.userManagement.createOrganizationMembership({
      organizationId: org.id,
      userId: user.id,
      roleSlug: role,
    });
    defer(`membership ${role} ${membership.id}`, () =>
      workos.userManagement.deleteOrganizationMembership(membership.id).catch(ignoreMissing),
    );
    return { userId: user.id, membershipId: membership.id };
  };

  // Sequential on purpose: two creates racing on the same fresh org is a needless way to
  // meet a WorkOS rate limit in the first second of a run.
  const admin = await mkUser(ADMIN_ROLE_SLUG);
  const member = await mkUser("member");

  note(`org ${org.id} — admin ${admin.userId}, member ${member.userId}`);
  return {
    orgId: org.id,
    adminUserId: admin.userId,
    memberUserId: member.userId,
  };
}
