import { NotFoundException, ConflictException, type Invitation as WorkOSInvitation } from "@workos-inc/node";
import type { BillingUser } from "./types.js";
import type { WorkOSOrgMap } from "./adapters/workos-org.js";
import { getWorkOS } from "./workos.js";

// Shared WorkOS organization-invitation service. WorkOS owns the invitation
// record + membership; two behaviours are selected by hooks:
//  - Default (no hooks): WorkOS sends its own invitation email and acceptance
//    matches the invited address against the user's WorkOS primary email.
//  - Custom (hooks): the app sends a branded email (sendEmail) and/or widens
//    who may accept (canAccept — e.g. also match verified secondary emails the
//    app keeps outside WorkOS). The WorkOS invitation is still created as the
//    record; acceptance creates the membership directly.
//
// Note: WorkOS has no per-call "don't email" flag. If you provide sendEmail to
// deliver your own branded invite, disable the WorkOS invitation email template
// in the dashboard to avoid double-sending.

export interface InvitationEmailContext {
  /** WorkOS invitation id (use it in your accept link). */
  id: string;
  email: string;
  roleSlug: string;
  /** App orgId (post-map). */
  orgId: string;
  /** WorkOS organization id. */
  organizationId: string;
  /** `${baseUrl}${acceptPath}/${id}` — ready-made link for a custom email. */
  acceptUrl: string;
  inviterUserId?: string;
}

export interface InvitationHooks {
  /** Send a branded email. Omit → rely on WorkOS's default invitation email. */
  sendEmail?(ctx: InvitationEmailContext): Promise<void>;
  /** Decide whether `user` may accept an invite addressed to `invitedEmail`.
   *  Omit → case-insensitive match against the user's WorkOS primary email.
   *  Return false for a generic rejection, or throw for a custom message. */
  canAccept?(invitedEmail: string, user: BillingUser): Promise<boolean>;
}

export interface Invitation {
  id: string;
  email: string;
  roleSlug: string;
  /** App orgId (post-map), or "" if it can't be resolved. */
  orgId: string;
  organizationId: string;
  state: "pending" | "accepted" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  /**
   * Where the invited person accepts, built from this service's own `baseUrl` + `acceptPath`.
   *
   * On the record rather than only in the email hook's context, because the email is no
   * longer the only thing that needs it: a notification carries the link to whoever renders
   * it, and the alternative — every consumer of the event re-deriving the path — is how the
   * link in the email and the route that accepts it come to disagree.
   */
  acceptUrl?: string;
}

export interface WorkOSInvitationsOptions {
  apiKey?: string;
  clientId?: string;
  /** ws↔org id map (share the adapter's). Omit → orgId IS the WorkOS org id. */
  map?: WorkOSOrgMap;
  /** Base URL for the custom-email accept link. */
  baseUrl?: string;
  /** Accept-link path prefix. Default "/invita". */
  acceptPath?: string;
  hooks?: InvitationHooks;
}

export interface InvitationService {
  send(orgId: string, email: string, roleSlug: string, inviterUserId?: string): Promise<Invitation>;
  list(orgId: string): Promise<Invitation[]>;
  get(invitationId: string): Promise<Invitation | null>;
  accept(invitationId: string, user: BillingUser): Promise<{ orgId: string }>;
  revoke(orgId: string, invitationId: string): Promise<void>;
}

const PAGE = 100;

export function createWorkOSInvitations(
  opts: WorkOSInvitationsOptions = {},
): InvitationService {
  // Shared, lazily-memoized WorkOS client (see workos.ts).
  const workos = () => getWorkOS({ apiKey: opts.apiKey, clientId: opts.clientId });
  const hooks = opts.hooks ?? {};
  const baseUrl = opts.baseUrl ?? "";
  const acceptPath = opts.acceptPath ?? "/invita";

  const toWid = (orgId: string): Promise<string> =>
    opts.map ? opts.map.toWorkosOrgId(orgId) : Promise.resolve(orgId);
  const toOrgId = (workosOrgId: string): Promise<string | null> =>
    opts.map ? opts.map.toOrgId(workosOrgId) : Promise.resolve(workosOrgId);

  async function normalize(inv: WorkOSInvitation, orgId?: string): Promise<Invitation> {
    const resolved =
      orgId ?? (inv.organizationId ? await toOrgId(inv.organizationId) : null);
    return {
      id: inv.id,
      email: inv.email,
      roleSlug: inv.roleSlug ?? "member",
      orgId: resolved ?? "",
      organizationId: inv.organizationId ?? "",
      state: inv.state,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    };
  }

  async function get(invitationId: string): Promise<Invitation | null> {
    let inv: WorkOSInvitation;
    try {
      inv = await workos().userManagement.getInvitation(invitationId);
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
    if (inv.state !== "pending") return null;
    return normalize(inv);
  }

  async function send(
    orgId: string,
    email: string,
    roleSlug: string,
    inviterUserId?: string,
  ): Promise<Invitation> {
    const organizationId = await toWid(orgId);
    const inv = await workos().userManagement.sendInvitation({
      email: email.trim().toLowerCase(),
      organizationId,
      roleSlug,
      inviterUserId,
    });
    const acceptUrl = `${baseUrl}${acceptPath}/${inv.id}`;
    if (hooks.sendEmail) {
      await hooks.sendEmail({
        id: inv.id,
        email: inv.email,
        roleSlug: inv.roleSlug ?? roleSlug,
        orgId,
        organizationId,
        acceptUrl,
        inviterUserId,
      });
    }
    return { ...(await normalize(inv, orgId)), acceptUrl };
  }

  async function list(orgId: string): Promise<Invitation[]> {
    const organizationId = await toWid(orgId);
    const paginatable = await workos().userManagement.listInvitations({ organizationId, limit: PAGE });
    const pending = (await paginatable.autoPagination()).filter((i) => i.state === "pending");
    return Promise.all(pending.map((i) => normalize(i, orgId)));
  }

  /** WorkOS refusing to create a membership because a PENDING one exists.
   *
   *  Matched on the machine CODE, not on `instanceof`: WorkOS raises this as a
   *  bare `GenericServerException` (400), so there is no class to narrow to and
   *  a `status === 400` test would swallow every other bad request. The code is
   *  the only stable, specific signal — measured against a live environment. */
  function isPendingMembership(e: unknown): boolean {
    return (
      typeof e === "object" &&
      e !== null &&
      (e as { code?: unknown }).code === "cannot_reactivate_pending_organization_membership"
    );
  }

  async function accept(
    invitationId: string,
    user: BillingUser,
  ): Promise<{ orgId: string }> {
    const inv = await get(invitationId);
    if (!inv) throw new Error("Invitation is invalid or already used");
    const allowed = hooks.canAccept
      ? await hooks.canAccept(inv.email, user)
      : inv.email.toLowerCase() === user.email.toLowerCase();
    if (!allowed) {
      throw new Error(`This invitation is for ${inv.email}.`);
    }
    const organizationId = await toWid(inv.orgId);
    // Tolerate an already-present membership (never downgrade).
    try {
      await workos().userManagement.createOrganizationMembership({
        organizationId,
        userId: user.id,
        roleSlug: inv.roleSlug,
      });
    } catch (e) {
      if (isPendingMembership(e)) {
        // SENDING an invitation already creates a PENDING membership for the
        // invited user, so creating one on acceptance is refused — 400
        // `cannot_reactivate_pending_organization_membership`, whose own message
        // says "The invite must be accepted instead". Nothing tolerated that, so
        // acceptance threw for EVERY ordinary invitee and the only people who
        // ever reached a workspace were the ones a fixture added directly.
        //
        // WorkOS's own accept is the answer, and it takes the invitation id
        // against the API key — it does NOT need the invited user's session,
        // which was this reimplementation's whole premise and was simply wrong.
        // Create-first still leads, because it is what serves the case WorkOS
        // cannot: a `canAccept` hook widening acceptance to a verified secondary
        // email, where the accepting user is not the invited one and WorkOS
        // would enrol the wrong account. The fallback is reached only when the
        // pending membership is the ACCEPTING user's own, which is the refusal
        // WorkOS just raised about them.
        await workos().userManagement.acceptInvitation(invitationId);
        return { orgId: inv.orgId };
      }
      if (!(e instanceof ConflictException)) throw e;
    }
    // Consume the pending invitation. Not reached on the accept path above:
    // WorkOS has already moved it to `accepted` there, and revoking is only for
    // the invitation this function bypassed by creating the membership itself.
    try {
      await workos().userManagement.revokeInvitation(invitationId);
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
    }
    return { orgId: inv.orgId };
  }

  async function revoke(orgId: string, invitationId: string): Promise<void> {
    const organizationId = await toWid(orgId);
    let inv: WorkOSInvitation;
    try {
      inv = await workos().userManagement.getInvitation(invitationId);
    } catch (e) {
      if (e instanceof NotFoundException) return;
      throw e;
    }
    // Belongs-to check: the invitation must target this org.
    if (inv.organizationId !== organizationId) return;
    await workos().userManagement.revokeInvitation(invitationId);
  }

  return { send, list, get, accept, revoke };
}
