import { ConflictException, NotFoundException } from "@workos-inc/node";
import { getWorkOS } from "./workos.js";
import type { WorkOSOrgMap } from "./adapters/workos-org.js";

// Pattern B, packaged: the org side of an app that keeps its own row (a
// workspace, a team, a tenant) 1:1 with a WorkOS Organization.
//
// The adapter takes a `WorkOSOrgMap` — `toWorkosOrgId` / `toOrgId` — and every
// app that implements one writes the same thing: look up the stored pointer,
// fall back to `getOrganizationByExternalId`, create the org if it isn't there,
// write the pointer back, and reverse-map through `org.externalId` when the
// pointer is missing. Both apps on this library had grown their own copy — and
// scartoffie had grown TWO, one in the app and one in its toolkit, each with its
// own WorkOS client.
//
// What is genuinely app-specific is only where the pointer lives: a Postgres
// column, a KV entry, a row in something else entirely. So that is all the app
// supplies (`readPointer` / `writePointer` / `nameFor`), and everything around
// it — the reconcile-on-read, the idempotent create, the reverse map, the
// membership helpers — lives here once.
//
// The self-healing part matters and is easy to get subtly wrong: the org is
// keyed by `externalId = <local id>`, so a create that fails after WorkOS has
// committed leaves an org a retry FINDS rather than duplicates, and a lost
// pointer is recovered from the org rather than by minting a second org for the
// same row.

export interface WorkOSOrgMirrorOptions {
  /** The stored WorkOS org id for a local id, or null if none is recorded yet. */
  readPointer(localId: string): Promise<string | null>;
  /** Persist the pointer. Called whenever it was missing or had drifted. */
  writePointer(localId: string, workosOrgId: string): Promise<void>;
  /** The local id a WorkOS org id maps back to, when the app can answer it from
   *  its own store. Return null to fall back to the org's `externalId`. */
  reversePointer?(workosOrgId: string): Promise<string | null>;
  /** Organization name to create with. Receives the local id; default "Workspace". */
  nameFor?(localId: string): Promise<string> | string;
  /** Thrown when a local id has no row at all. Default: a generic Error. */
  onMissing?(localId: string): Error;
}

export interface WorkOSOrgMirror extends WorkOSOrgMap {
  /** Create-or-fetch the org backing `localId` and persist the pointer.
   *  Idempotent — keyed on `externalId`, so a retry finds rather than duplicates. */
  ensureOrg(localId: string, name?: string): Promise<string>;
  /** The org id for a local id, reconciling on read when the pointer is missing. */
  toWorkosOrgId(localId: string): Promise<string>;
  /** The local id for an org id, via the app's store then the org's externalId. */
  toOrgId(workosOrgId: string): Promise<string | null>;
  /** Rename the org. A deleted org is not an error — nothing to rename. */
  renameOrg(workosOrgId: string, name: string): Promise<void>;
  /** Delete the org. Already gone is success. */
  deleteOrg(workosOrgId: string): Promise<void>;
  /** Add a user with a role, tolerating a membership that already exists. */
  ensureMembership(workosOrgId: string, userId: string, roleSlug: string): Promise<void>;
  /** Membership id for (org, user) across ALL statuses, or null. WorkOS keys
   *  membership mutations by this id, not by user id — and the default listing
   *  is active-only, which silently hides a pending or deactivated member. */
  membershipId(workosOrgId: string, userId: string): Promise<string | null>;
}

/** Every membership status. The WorkOS listing defaults to active-only. */
export const ALL_MEMBERSHIP_STATUSES = ["active", "inactive", "pending"] as const;

export function createWorkOSOrgMirror(opts: WorkOSOrgMirrorOptions): WorkOSOrgMirror {
  const workos = () => getWorkOS();

  const ensureOrg = async (localId: string, name?: string): Promise<string> => {
    const resolvedName =
      name ?? (opts.nameFor ? await opts.nameFor(localId) : undefined) ?? "Workspace";
    let orgId: string;
    try {
      orgId = (await workos().organizations.getOrganizationByExternalId(localId)).id;
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
      orgId = (
        await workos().organizations.createOrganization({
          name: resolvedName,
          externalId: localId,
        })
      ).id;
    }
    await opts.writePointer(localId, orgId);
    return orgId;
  };

  return {
    ensureOrg,

    async toWorkosOrgId(localId: string): Promise<string> {
      const stored = await opts.readPointer(localId);
      if (stored) return stored;
      // No pointer: either it was never written or the row predates the mirror.
      // Reconciling here (rather than throwing) is what makes the pointer a
      // cache of the truth in WorkOS instead of a second source of it.
      return ensureOrg(localId);
    },

    async toOrgId(workosOrgId: string): Promise<string | null> {
      const local = await opts.reversePointer?.(workosOrgId);
      if (local) return local;
      try {
        return (await workos().organizations.getOrganization(workosOrgId)).externalId ?? null;
      } catch {
        return null;
      }
    },

    async renameOrg(workosOrgId: string, name: string): Promise<void> {
      try {
        await workos().organizations.updateOrganization({ organization: workosOrgId, name });
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
      }
    },

    async deleteOrg(workosOrgId: string): Promise<void> {
      try {
        await workos().organizations.deleteOrganization(workosOrgId);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
      }
    },

    async ensureMembership(workosOrgId: string, userId: string, roleSlug: string): Promise<void> {
      try {
        await workos().userManagement.createOrganizationMembership({
          organizationId: workosOrgId,
          userId,
          roleSlug,
        });
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
      }
    },

    async membershipId(workosOrgId: string, userId: string): Promise<string | null> {
      const memberships = await workos().userManagement.listOrganizationMemberships({
        organizationId: workosOrgId,
        userId,
        statuses: [...ALL_MEMBERSHIP_STATUSES],
      });
      return memberships.data[0]?.id ?? null;
    },
  };
}
