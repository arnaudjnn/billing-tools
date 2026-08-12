import { seatTypeExists } from "./ladder.js";
import { planModel } from "./plan-model.js";
import { seatLimit } from "./plans.js";
import { assignSeatType, clearMemberRecords, seatAssignable } from "./seats.js";
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
  | "unsupported"
  /** A `seatType` this workspace's own plan does not sell. */
  | "unknown_seat"
  /** The seat exists and there is no room: nobody bought it, or the plan caps it. */
  | "seat_unavailable";

export interface MemberSeats {
  /** Active memberships. */
  active: number;
  /** Invitations sent and not yet accepted — they are seats already promised. */
  pending: number;
  /** The ceiling that actually binds, or null for unlimited. */
  limit: number | null;
  /** How many more people may be invited. Null when unlimited. */
  remaining: number | null;
  /**
   * WHICH ceiling that is, because the two mean opposite things to whoever is refused.
   *
   * `"purchased"` — every seat the workspace BOUGHT is taken. Money fixes it: buy another.
   * `"plan"` — the plan's own `limits.members`. Money does not fix it at this tier; a
   *   different plan does.
   *
   * A screen that cannot tell them apart offers "upgrade" to somebody who needs one more
   * seat, or "buy a seat" to somebody whose plan forbids a fourth person.
   */
  limitSource: "purchased" | "plan" | null;
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
  const model = opts.plans && opts.plan ? planModel(opts.plans, opts.plan) : null;
  const planCap = opts.plans && opts.plan ? seatLimit(opts.plans, opts.plan) : null;

  // THE SEATS ACTUALLY BOUGHT, and on a plan that sells them this is the ceiling that
  // matters. `limits.members` is a product rule ("a Pro workspace tops out at 100"), not a
  // price — so reading it alone let a workspace paying for 3 seats admit 100 people, and
  // under `cap: per_seat` every one of them drew a full pack. Measured on a real
  // deployment: 3 purchased, 10 members, `aggregate.limit` 10 000 against 3 000 sold.
  // Seven monthly allowances nobody paid for, with nothing refusing and nothing reporting.
  //
  // Unknown capacity ALLOWS, as everywhere else here: no subscription on a seats plan
  // means nothing has been bought yet, and there `limits.members` is the honest cap (it is
  // 1 on a free tier, which is what makes that case still refuse).
  // Unreadable counts as unknown, never as zero: an adapter that throws (WorkOS down, a
  // workspace with no subscription record) must not refuse every invitation in the product.
  // The same fail-open trade `seatAssignable` makes, and the same reason — the giveaway is
  // cheaper than locking owners out of their own team.
  const purchased =
    model?.sells.kind === "seats"
      ? await Promise.resolve(adapter.getSubscription?.(orgId))
          .then(totalPurchasedSeats)
          .catch(() => null)
      : null;

  const active = (await adapter.memberCount?.(orgId)) ?? (await adapter.listMemberIds?.(orgId))?.length ?? 0;
  const pending = opts.invitations
    ? (await opts.invitations.list(orgId)).filter((i) => i.state === "pending").length
    : 0;

  // The TIGHTER of the two binds, and which one it was travels with the number: "buy
  // another seat" and "this plan stops here" are different sentences and different buttons.
  let limit: number | null = null;
  let limitSource: MemberSeats["limitSource"] = null;
  if (purchased !== null && (planCap === null || purchased <= planCap)) {
    limit = purchased;
    limitSource = "purchased";
  } else if (planCap !== null) {
    limit = planCap;
    limitSource = "plan";
  }

  return {
    active,
    pending,
    limit,
    limitSource,
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
    /**
     * Seat to put them on, checked BEFORE the invitation goes out.
     *
     * A seat is a PRICE, and assigning one touches no subscription — so offering the choice
     * on an invite form without this check is the same giveaway `seatAssignable` exists to
     * stop, arriving through a different door. Omit it and the invitee draws the plan's
     * default seat, which is what every invitation did before.
     */
    seatType?: string | null;
  },
): Promise<
  | { ok: true; invitation: Invitation; seats: MemberSeats; seatType?: string | null }
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

  // Both seat checks run BEFORE `send`, because an invitation is not undoable: revoking one
  // already delivered still leaves the invitee an email about a workspace that then refuses
  // them. Refusing first costs nothing and says why.
  const model = input.plans && input.plan ? planModel(input.plans, input.plan) : null;
  const seatType = input.seatType ?? null;
  if (seatType) {
    // Against the ORG's OWN plan, never the catalogue union: "premium is a seat type
    // somewhere" is not "this workspace may sell it".
    if (!model || !seatTypeExists(model, seatType)) {
      return { ok: false, reason: "unknown_seat", seats };
    }
    // Counted with an id nobody holds, so it asks "is there room for ONE MORE" rather than
    // "may this person move here" — which is the question at invite time, when the person
    // does not exist yet.
    const room = await seatAssignable(adapter, orgId, model, INVITEE_PLACEHOLDER, seatType);
    if (!room.ok) return { ok: false, reason: "seat_unavailable", seats };
  }

  const invitation = await input.invitations.send(
    orgId,
    input.email.trim().toLowerCase(),
    input.roleSlug ?? "member",
    input.inviterUserId,
  );

  // Seat them now. Sending CREATES the WorkOS user, so the seat can be recorded before they
  // ever sign in — and it must be, because acceptance is the app's own flow and a seat
  // applied "on join" would be one more thing each consumer remembers to do. The write is
  // per-user metadata, which acceptance does not touch, so it simply survives.
  if (seatType && invitation.userId) {
    await assignSeatType(adapter, orgId, invitation.userId, seatType);
  }
  // No `userId` means the invitation stands and the seat did not: reported, never thrown,
  // since the person HAS been invited and they fall back to the plan's default seat.
  return { ok: true, invitation, seats, seatType: invitation.userId ? seatType : null };
}

/** How many seats of any type this subscription pays for. Null when it cannot be told —
 *  no adapter read, no subscription, or a subscription carrying no counts. */
function totalPurchasedSeats(
  sub: { seats?: number | null; seatCounts?: Record<string, number> | null } | null | undefined,
): number | null {
  if (!sub) return null;
  if (sub.seatCounts) return Object.values(sub.seatCounts).reduce((a, b) => a + b, 0);
  return typeof sub.seats === "number" ? sub.seats : null;
}

/** Stands in for the person being invited, who has no id until `send` returns.
 *  `seatAssignable` only uses it to exclude an EXISTING assignment from the count, and there
 *  is none — so any id nobody holds asks exactly the right question. */
const INVITEE_PLACEHOLDER = " invitee";

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
