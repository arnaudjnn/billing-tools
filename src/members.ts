import { seatLimit } from "./plans.js";
import { clearMemberRecords } from "./seats.js";
import { ADMIN_ROLE_SLUG } from "./workos-setup.js";
import type { PlanCatalog } from "./plan-model.js";
import type { BillingAdapter, OrgMember } from "./types.js";
import type { Invitation, InvitationService } from "./invitations.js";

// WHO is in a workspace — and the two rules that decide who may join and who may leave.
//
// This existed nowhere. `createWorkOSInvitations` shipped the invitation record and the
// mirror shipped `ensureMembership`, so a consumer could build a members screen — and both
// consumers that needed one did, 721 lines of it in scartoffie's `lib/`, outside the seam.
// Nothing reached it: no tool, no CLI, no bound API. A deployment with no frontend
// (gtm-tools) could not add a second person to a workspace by any means at all.
//
// The volume was never the point. What ends up in a hand-written members page is POLICY:
//
//   • `limits.members` — advertised by `list_plans` on every plan and enforced by nothing,
//     so a plan selling ten seats admitted a hundred. AGENTS.md said so explicitly and left
//     it to each app, which means each app counts active-plus-pending itself and the count
//     that matters (the one an invitation is refused by) exists per consumer.
//   • the LAST ADMIN — demote or remove them and `isAdmin` answers false for everybody, so
//     every admin-gated tool returns 403 to every human in that workspace. An org API key
//     still works, which is why this survives a headless test suite and only bites a real
//     person, and why it is the way back in. The same doc left this to the UI too.
//
// Both are now here, so a tool, a CLI command and a consumer's own screen get the identical
// refusal — and neither rule can be "the one this app forgot".

/** What a refusal was, for a caller that wants to branch rather than read a sentence. */
export type MemberRefusal =
  /** The plan's `limits.members` is already met by active members + pending invitations. */
  | "limit_reached"
  /** They are the only admin left: demoting or removing them locks every human out. */
  | "last_admin"
  /** Not in this workspace (or already gone). */
  | "not_a_member"
  /** The adapter cannot answer the question this rule needs. */
  | "unsupported";

export interface MemberSeats {
  /** Active memberships. */
  active: number;
  /** Invitations sent and not yet accepted — they are seats already promised. */
  pending: number;
  /** The plan's ceiling, or null for unlimited. */
  limit: number | null;
  /** How many more people may be invited. Null when unlimited. */
  remaining: number | null;
}

/**
 * How many seats are taken and how many are left.
 *
 * PENDING INVITATIONS COUNT. A limit checked against active members alone is not a limit: a
 * ten-seat workspace can send a hundred invitations and let every one of them in, and the
 * refusal arrives — if at all — when the eleventh person accepts, to the person accepting,
 * who cannot do anything about it. Counting the promise at the moment it is made is the
 * only version that refuses the right person.
 */
export async function memberSeats(
  adapter: BillingAdapter,
  orgId: string,
  opts: { plans?: PlanCatalog; plan?: string | null; invitations?: InvitationService },
): Promise<MemberSeats> {
  const limit = opts.plans && opts.plan ? seatLimit(opts.plans, opts.plan) : null;
  const active = (await adapter.memberCount?.(orgId)) ?? (await adapter.listMemberIds?.(orgId))?.length ?? 0;
  const pending = opts.invitations
    ? (await opts.invitations.list(orgId)).filter((i) => i.state === "pending").length
    : 0;
  return {
    active,
    pending,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - active - pending),
  };
}

/** Everyone in the workspace, with their role. Empty when the adapter cannot enumerate. */
export async function listMembers(adapter: BillingAdapter, orgId: string): Promise<OrgMember[]> {
  if (adapter.listMembers) return adapter.listMembers(orgId);
  // Fall back to ids alone rather than to nothing: an adapter that can list members but not
  // describe them still answers "who is in here", which is what a seat screen needs.
  const ids = (await adapter.listMemberIds?.(orgId)) ?? [];
  return ids.map((userId) => ({ userId, email: null, name: null, roleSlug: null, status: "active" }));
}

/**
 * Is this the only admin left?
 *
 * `null` means the question could not be answered — no `listMembers`, or a list with no role
 * on it. Callers must treat that as REFUSE, which is the opposite of the "unknown allows"
 * rule the rest of this library follows, and deliberately: the failure being prevented is
 * every human in a workspace getting 403 from every admin-gated tool, recoverable only with
 * an org API key. Refusing one demotion is the cheaper mistake.
 */
export async function isLastAdmin(
  adapter: BillingAdapter,
  orgId: string,
  userId: string,
): Promise<boolean | null> {
  const members = await listMembers(adapter, orgId);
  if (!members.length || members.every((m) => m.roleSlug == null)) return null;
  const admins = members.filter((m) => m.roleSlug === ADMIN_ROLE_SLUG && m.status === "active");
  return admins.length <= 1 && admins.some((m) => m.userId === userId);
}

/**
 * The sole active admin's id, or null when there are several — or none can be read.
 *
 * The list-shaped read of `isLastAdmin`, which answers one candidate at a time: a
 * members TABLE drawing a lock icon per row would cost N `listMembers` calls asking N
 * times about one list. Null disables nothing in a UI, and that is safe in both
 * directions — with several admins there is no lock to draw, and with unreadable
 * roles the WRITE path still refuses via `isLastAdmin`'s fail-closed null.
 */
export async function lastAdminId(
  adapter: BillingAdapter,
  orgId: string,
): Promise<string | null> {
  const members = await listMembers(adapter, orgId);
  const admins = members.filter((m) => m.roleSlug === ADMIN_ROLE_SLUG && m.status === "active");
  return admins.length === 1 ? admins[0].userId : null;
}

/**
 * Invite somebody, refusing when the plan has no seat for them.
 *
 * The invitation record and the email are the service's (`createWorkOSInvitations`); what is
 * here is the one thing it cannot know — whether this plan may have another member.
 */
export async function inviteMember(
  adapter: BillingAdapter,
  orgId: string,
  input: {
    email: string;
    roleSlug?: string;
    inviterUserId?: string;
    invitations: InvitationService;
    plans?: PlanCatalog;
    plan?: string | null;
  },
): Promise<
  | { ok: true; invitation: Invitation; seats: MemberSeats }
  | { ok: false; reason: MemberRefusal; seats: MemberSeats }
> {
  const seats = await memberSeats(adapter, orgId, {
    plans: input.plans,
    plan: input.plan,
    invitations: input.invitations,
  });
  if (seats.remaining !== null && seats.remaining <= 0) {
    return { ok: false, reason: "limit_reached", seats };
  }
  const invitation = await input.invitations.send(
    orgId,
    input.email.trim().toLowerCase(),
    input.roleSlug ?? "member",
    input.inviterUserId,
  );
  return { ok: true, invitation, seats };
}

/** Move somebody between roles, refusing the demotion that locks everyone out. */
export async function changeMemberRole(
  adapter: BillingAdapter,
  orgId: string,
  userId: string,
  roleSlug: string,
): Promise<{ ok: true; roleSlug: string } | { ok: false; reason: MemberRefusal }> {
  if (!adapter.setMemberRole) return { ok: false, reason: "unsupported" };
  const members = await listMembers(adapter, orgId);
  if (members.length && !members.some((m) => m.userId === userId)) {
    return { ok: false, reason: "not_a_member" };
  }
  if (roleSlug !== ADMIN_ROLE_SLUG) {
    const last = await isLastAdmin(adapter, orgId, userId);
    // `null` refuses — see `isLastAdmin`.
    if (last !== false) return { ok: false, reason: "last_admin" };
  }
  await adapter.setMemberRole(orgId, userId, roleSlug);
  return { ok: true, roleSlug };
}

/**
 * Remove somebody — their records first, then the membership.
 *
 * That order is the `closeWorkspace` rule applied to one person: both per-member stores are
 * keyed by org, so a membership deleted first leaves this workspace's seat and grants sitting
 * in an ex-member's own metadata for ever, spending a character budget their remaining
 * workspaces still need. Once the membership is gone there is nothing left to enumerate them
 * from, so the cleanup cannot be done afterwards.
 */
export async function removeMember(
  adapter: BillingAdapter,
  orgId: string,
  userId: string,
): Promise<{ ok: true; cleared: number } | { ok: false; reason: MemberRefusal }> {
  if (!adapter.removeMember) return { ok: false, reason: "unsupported" };
  const members = await listMembers(adapter, orgId);
  if (members.length && !members.some((m) => m.userId === userId)) {
    return { ok: false, reason: "not_a_member" };
  }
  const last = await isLastAdmin(adapter, orgId, userId);
  if (last === true) return { ok: false, reason: "last_admin" };

  const cleared = await clearMemberRecords(adapter, orgId, [userId]);
  await adapter.removeMember(orgId, userId);
  return { ok: true, cleared };
}
