import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { enforceAccess, enforceAdmin } from "../auth.js";
import { closeWorkspace } from "../close-workspace.js";
import type { InvitationService } from "../invitations.js";
import {
  changeMemberRole,
  inviteMember,
  listMembers,
  memberSeats,
  removeMember,
} from "../members.js";
import type { PlanCatalog } from "../plans.js";
import type { BillingAdapter } from "../types.js";

// WHO is in the workspace, as tools — the group that did not exist.
//
// Every other capability in this library reached three surfaces (a tool, the CLI, the bound
// API) and membership reached none, so a workspace could be billed, metered, capped, topped
// up and closed headlessly, and could not be given a second person. gtm-tools has no members
// UI and therefore no way at all; scartoffie had 721 lines of one, where the two rules that
// matter (`limits.members`, the last admin) were its own to remember.
//
// The rules are in `members.ts`, not here. These are the envelope: gate, call, and turn a
// `reason` into a sentence that says what to do instead.

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export interface MemberToolOptions {
  plans?: PlanCatalog;
  resolvePlan?: (orgId: string) => Promise<string | null>;
  /** The invitation service (`createWorkOSInvitations`). Without it the three invitation
   *  tools do not register — there is nowhere to put the record. */
  invitations?: InvitationService;
  /** Roles this deployment invites into. Advertised in the tool description so an agent
   *  does not have to guess a slug, and validated, so it cannot invent one. */
  roles?: readonly string[];
}

const DEFAULT_ROLES = ["admin", "member"] as const;

/**
 * Register the member tools this adapter and this deployment can actually serve.
 *
 * Two gates, the same pair the seat and top-up groups use: the ADAPTER decides whether the
 * question is answerable (`listMembers` to read, `setMemberRole`/`removeMember` to write) and
 * the DEPLOYMENT decides whether invitations exist at all. A tool that could only ever answer
 * "not supported" is the false statement this project keeps deleting.
 */
export function registerMemberTools(
  server: McpServer,
  adapter: BillingAdapter,
  opts: MemberToolOptions = {},
) {
  const roles = opts.roles ?? DEFAULT_ROLES;
  const planFor = async (orgId: string) =>
    opts.resolvePlan
      ? await opts.resolvePlan(orgId)
      : ((await adapter.getSubscription?.(orgId))?.plan ?? null);

  if (adapter.listMembers || adapter.listMemberIds) {
    server.tool(
      "list_members",
      "List everyone in the workspace: user id, email, role, and status. Also reports how many " +
        "seats the plan allows and how many are left, counting pending invitations.",
      {},
      async () => {
        // A READ, so member-visible like every other read in this library — "who is on my
        // team" is not privileged information to somebody on that team.
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        const [members, seats] = await Promise.all([
          listMembers(adapter, auth.orgId),
          memberSeats(adapter, auth.orgId, {
            plans: opts.plans,
            plan: await planFor(auth.orgId),
            invitations: opts.invitations,
          }),
        ]);
        return json({
          members: members.map((m) => ({
            member_id: m.userId,
            email: m.email,
            name: m.name,
            role: m.roleSlug,
            status: m.status,
          })),
          seats: {
            active: seats.active,
            pending_invitations: seats.pending,
            limit: seats.limit,
            remaining: seats.remaining,
          },
        });
      },
    );
  }

  if (opts.invitations) {
    const invitations = opts.invitations;

    server.tool(
      "invite_member",
      `Invite somebody to the workspace by email. Roles: ${roles.join(", ")}. Refused when the ` +
        "plan's member limit is already met by current members plus pending invitations.",
      {
        email: z.string().email().describe("Who to invite"),
        role: z
          .enum(roles as [string, ...string[]])
          .optional()
          .describe(`Role to grant. Defaults to "member"`),
      },
      async ({ email, role }) => {
        const auth = await enforceAdmin(adapter, "invite_member");
        if ("isError" in auth) return auth;
        const res = await inviteMember(adapter, auth.orgId, {
          email,
          roleSlug: role,
          invitations,
          plans: opts.plans,
          plan: await planFor(auth.orgId),
        });
        if (!res.ok) {
          // The refusal names the ceiling AND what it is made of: an owner who reads "10
          // members" while seeing 7 people has 3 invitations they have forgotten about, and
          // "the limit is 10" alone sends them looking for a bug.
          return err(
            `This plan allows ${res.seats.limit} member(s): ${res.seats.active} active and ` +
              `${res.seats.pending} invitation(s) already pending. Move up a plan (change_plan) ` +
              `or revoke an invitation (list_invitations, revoke_invitation) first.`,
          );
        }
        return json({
          status: "invited",
          invitation_id: res.invitation.id,
          email: res.invitation.email,
          role: res.invitation.roleSlug,
          expires_at: res.invitation.expiresAt,
          seats_remaining: res.seats.remaining === null ? null : res.seats.remaining - 1,
        });
      },
    );

    server.tool(
      "list_invitations",
      "Invitations for this workspace and their state (pending, accepted, expired, revoked).",
      {},
      async () => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        const list = await invitations.list(auth.orgId);
        return json({
          invitations: list.map((i) => ({
            invitation_id: i.id,
            email: i.email,
            role: i.roleSlug,
            state: i.state,
            created_at: i.createdAt,
            expires_at: i.expiresAt,
          })),
        });
      },
    );

    server.tool(
      "revoke_invitation",
      "Cancel a pending invitation, freeing the seat it was holding.",
      {
        invitation_id: z.string().describe("From list_invitations"),
      },
      async ({ invitation_id }) => {
        const auth = await enforceAdmin(adapter, "revoke_invitation");
        if ("isError" in auth) return auth;
        // Ownership is the service's: `revoke` takes the org and refuses an invitation that
        // belongs to another one, so an id from a caller cannot reach across workspaces.
        await invitations.revoke(auth.orgId, invitation_id);
        return json({ status: "revoked", invitation_id });
      },
    );
  }

  if (adapter.setMemberRole) {
    server.tool(
      "change_member_role",
      `Move a member between roles (${roles.join(", ")}). Refuses to demote the last admin, ` +
        "which would leave every admin-only action unreachable for everyone.",
      {
        member_id: z.string().describe("WorkOS user id, from list_members"),
        role: z.enum(roles as [string, ...string[]]).describe("The role to give them"),
      },
      async ({ member_id, role }) => {
        const auth = await enforceAdmin(adapter, "change_member_role");
        if ("isError" in auth) return auth;
        const res = await changeMemberRole(adapter, auth.orgId, member_id, role);
        if (!res.ok) return err(refusal(res.reason, member_id));
        return json({ status: "role_changed", member_id, role: res.roleSlug });
      },
    );
  }

  if (adapter.removeMember) {
    server.tool(
      "remove_member",
      "Remove somebody from the workspace. Their seat assignment and any granted allowance " +
        "for this workspace are cleared first. Refuses to remove the last admin.",
      {
        member_id: z.string().describe("WorkOS user id, from list_members"),
      },
      async ({ member_id }) => {
        const auth = await enforceAdmin(adapter, "remove_member");
        if ("isError" in auth) return auth;
        const res = await removeMember(adapter, auth.orgId, member_id);
        if (!res.ok) return err(refusal(res.reason, member_id));
        return json({ status: "removed", member_id, records_cleared: res.cleared });
      },
    );
  }
}

/**
 * The workspace itself: what it is called, and stopping it.
 *
 * `closeWorkspace` has existed and been bound for a while and reached no tool, so the one
 * operation with real money on the other side of it — a subscription that keeps charging a
 * card for a workspace nobody can see — was the app's to remember to call. Renaming had no
 * home at all.
 */
export function registerWorkspaceTools(server: McpServer, adapter: BillingAdapter) {
  if (adapter.renameOrg) {
    server.tool(
      "rename_workspace",
      "Rename the workspace. The name appears on invoices, in the members list, and wherever " +
        "the workspace is chosen.",
      { name: z.string().min(1).max(120).describe("The new name") },
      async ({ name }) => {
        const auth = await enforceAdmin(adapter, "rename_workspace");
        if ("isError" in auth) return auth;
        const from = (await adapter.getOrgName?.(auth.orgId)) ?? null;
        await adapter.renameOrg!(auth.orgId, name.trim());
        return json({ status: "renamed", from, to: name.trim() });
      },
    );
  }

  server.tool(
    "close_workspace",
    `Stop a workspace: cancel its billing, KEEP its invoices, and return each member's metadata
budget. Deleting the workspace itself is opt-in (delete_workspace), because the invoices are a
legal record and a deletion cannot be undone.

The ORDER is the point, and it is why this is one tool rather than three calls: if the billing
cannot be stopped, nothing is removed. A workspace still listed is a nuisance; a subscription
still charging a card for a workspace whose Stripe pointer has been destroyed is a customer's
money, indefinitely, with nothing to attribute it to.`,
    {
      cancel_at: z
        .enum(["now", "period_end"])
        .optional()
        .describe(
          `"now" (default) stops the billing immediately with no refund. "period_end" lets them ` +
            `use what they paid for, and cannot be combined with delete_workspace`,
        ),
      delete_workspace: z
        .boolean()
        .optional()
        .describe("Remove the workspace after the billing is stopped. Default false"),
      reason: z.string().max(200).optional().describe("Recorded on the Stripe customer"),
    },
    async ({ cancel_at, delete_workspace, reason }) => {
      const auth = await enforceAdmin(adapter, "close_workspace");
      if ("isError" in auth) return auth;
      try {
        const res = await closeWorkspace(adapter, auth.orgId, {
          ...(cancel_at ? { cancelAt: cancel_at } : {}),
          // Default FALSE here, unlike the function's own default: a tool call is one line
          // an agent can emit from a misread instruction, and the recoverable half of this
          // (billing stopped, records kept) is the half worth doing by default.
          deleteOrg: delete_workspace ?? false,
          ...(reason ? { reason } : {}),
        });
        return json({
          status: res.orgDeleted ? "closed_and_deleted" : "closed",
          subscriptions_cancelled: res.cancelled,
          ends_at: res.endsAt,
          invoices_kept: res.invoicesKept,
          members_cleared: res.membersCleared,
          workspace_deleted: res.orgDeleted,
          // Non-empty means finish by hand — the caller has to see it, not find it in a log.
          warnings: res.warnings,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/** Each refusal says what to do instead — an agent told "last admin" and nothing else asks again. */
function refusal(reason: string, memberId: string): string {
  switch (reason) {
    case "last_admin":
      return (
        `${memberId} is the only admin left, so this would leave the workspace with none: every ` +
        `admin-only action would then be refused for everyone. Promote somebody else first ` +
        `(change_member_role), then try again.`
      );
    case "not_a_member":
      return `${memberId} is not a member of this workspace (see list_members).`;
    case "unsupported":
      return "This deployment's adapter cannot change memberships.";
    default:
      return `Refused: ${reason}.`;
  }
}
