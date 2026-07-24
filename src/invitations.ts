import { WorkOS } from "@workos-inc/node";
import type { BillingUser } from "./types.js";
import type { WorkOSOrgMap } from "./adapters/workos-org.js";

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
const statusOf = (e: unknown): number | undefined =>
  typeof e === "object" && e !== null && "status" in e
    ? (e as { status?: number }).status
    : undefined;

export function createWorkOSInvitations(
  opts: WorkOSInvitationsOptions = {},
): InvitationService {
  // Lazy: constructing WorkOS eagerly would throw when WORKOS_API_KEY is unset,
  // which must not break app boot (the service is often instantiated at module
  // load). The client is built on first actual use instead.
  let client: WorkOS | null = null;
  const workos = (): WorkOS =>
    (client ??= new WorkOS(opts.apiKey ?? process.env.WORKOS_API_KEY, {
      clientId: opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "",
    }));
  const hooks = opts.hooks ?? {};
  const baseUrl = opts.baseUrl ?? "";
  const acceptPath = opts.acceptPath ?? "/invita";

  const toWid = (orgId: string): Promise<string> =>
    opts.map ? opts.map.toWorkosOrgId(orgId) : Promise.resolve(orgId);
  const toOrgId = (workosOrgId: string): Promise<string | null> =>
    opts.map ? opts.map.toOrgId(workosOrgId) : Promise.resolve(workosOrgId);

  // WorkOS invitation shape (subset we use).
  type WosInvitation = {
    id: string;
    email: string;
    roleSlug: string | null;
    organizationId: string | null;
    state: Invitation["state"];
    createdAt: string;
    expiresAt: string;
  };

  async function normalize(inv: WosInvitation, orgId?: string): Promise<Invitation> {
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
    let inv: WosInvitation;
    try {
      inv = (await workos().userManagement.getInvitation(invitationId)) as WosInvitation;
    } catch (e) {
      if (statusOf(e) === 404) return null;
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
    const inv = (await workos().userManagement.sendInvitation({
      email: email.trim().toLowerCase(),
      organizationId,
      roleSlug,
      inviterUserId,
    })) as WosInvitation;
    if (hooks.sendEmail) {
      await hooks.sendEmail({
        id: inv.id,
        email: inv.email,
        roleSlug: inv.roleSlug ?? roleSlug,
        orgId,
        organizationId,
        acceptUrl: `${baseUrl}${acceptPath}/${inv.id}`,
        inviterUserId,
      });
    }
    return normalize(inv, orgId);
  }

  async function list(orgId: string): Promise<Invitation[]> {
    const organizationId = await toWid(orgId);
    const r = await workos().userManagement.listInvitations({ organizationId, limit: PAGE });
    const pending = (r.data as WosInvitation[]).filter((i) => i.state === "pending");
    return Promise.all(pending.map((i) => normalize(i, orgId)));
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
      if (statusOf(e) !== 409) throw e;
    }
    // Consume the pending invitation.
    try {
      await workos().userManagement.revokeInvitation(invitationId);
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
    }
    return { orgId: inv.orgId };
  }

  async function revoke(orgId: string, invitationId: string): Promise<void> {
    const organizationId = await toWid(orgId);
    let inv: WosInvitation;
    try {
      inv = (await workos().userManagement.getInvitation(invitationId)) as WosInvitation;
    } catch (e) {
      if (statusOf(e) === 404) return;
      throw e;
    }
    // Belongs-to check: the invitation must target this org.
    if (inv.organizationId !== organizationId) return;
    await workos().userManagement.revokeInvitation(invitationId);
  }

  return { send, list, get, accept, revoke };
}
