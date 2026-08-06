import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { currentPrincipal, enforceAccess, enforceAdmin, enforceMember } from "../auth.js";
import { getBillingCustomerId, usageSince, stripeConfigured } from "../billing.js";
import {
  requestTopUp,
  requestExtraAllowance,
  listTopUpRequests,
  approveTopUp,
  denyTopUp,
  grantExtraAllowance,
} from "../topup.js";
import { currentCycle } from "../allowance.js";
import { assignSeatType, listSeatAssignments } from "../seats.js";
import { normalizePlans, type PlanCatalog } from "../plans.js";
import { ALL_TOOL_CAPABILITIES, type ToolCapabilities } from "../plan-model.js";
import { usageSummary } from "../usage.js";

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}
// No local "what cycle is it" any more. These tools file and report things
// against a cycle, and the meter reads them back, so both go through
// `currentCycle` — see the note there for what drifting apart cost.

// Workspace-management tools: usage read, per-member seat assignment, and the
// user-seat top-up request/approval flow. All ORG-SCOPED (auth = the org's key /
// session). Seat + top-up tools require the adapter's metadata methods; when they
// are absent (an adapter without an org-metadata store) only get_usage registers.
//
// Two independent gates, and both have to pass. `caps` says whether the plan
// CATALOGUE can ever need the group (seats to assign, requests to approve); the
// metadata check below says whether this adapter can STORE the answer. Neither
// implies the other, which is why they are not merged.
export function registerManagementTools(
  server: McpServer,
  adapter: BillingAdapter,
  config: ResolvedConfig,
  opts: { plans?: PlanCatalog; resolvePlan?: (orgId: string) => Promise<string | null> } = {},
  caps: ToolCapabilities = ALL_TOOL_CAPABILITIES,
) {
  // Every tool here that names a cycle resolves it the same way the meter does,
  // including the plan lookup — a pooled or annual plan's cycle is its
  // subscription period, and guessing it from the calendar silently misfiles.
  const cycleFor = async (orgId: string) =>
    currentCycle(adapter, {
      orgId,
      plans: opts.plans,
      plan: opts.resolvePlan
        ? await opts.resolvePlan(orgId)
        : ((await adapter.getSubscription?.(orgId))?.plan ?? null),
    });

  server.tool(
    "get_usage",
    `Get your workspace's credit usage for the current cycle (summed from the Stripe
balance-transaction ledger). Optionally filter by caller (user/api) or look back a
number of days instead of the calendar month.`,
    {
      caller_kind: z.enum(["user", "api"]).optional().describe("Only count usage by this caller kind"),
      caller_id: z.string().optional().describe("Only count usage by this caller id (member or API-key id)"),
      since_days: z.number().int().min(1).max(366).optional().describe("Look back this many days instead of the current calendar month"),
    },
    async ({ caller_kind, caller_id, since_days }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      const cid = await getBillingCustomerId(adapter, auth.orgId);
      if (!cid) return json({ usage: 0, note: "No billing account yet." });
      // The billing cycle, not the calendar month: on an annual plan those differ
      // by up to eleven months, and this tool was reporting the wrong one.
      const cycle = await cycleFor(auth.orgId);
      const since = since_days
        ? Math.floor(Date.now() / 1000) - since_days * 86400
        : Math.floor(cycle.start / 1000);
      const filter = caller_kind ? { callerKind: caller_kind, callerId: caller_id } : undefined;
      const usage = await usageSince(cid, since, filter);
      return json({ usage, since, cycle: cycle.key, filter: filter ?? null });
    },
  );

  // Only where a plan HAS a window to report: an included cap, or a rate limit.
  // `get_usage` above stays unconditional — it is the historical spend read, and
  // that question is answerable on any catalogue.
  if (caps.usage) {
    // What an agent needs BEFORE it spends: every window that applies, how much of
    // each is gone, and when each resets. Without this a caller can only discover a
    // limit by being refused by it, which is a poor way to pace a long run — the
    // `resets_at` on each window is what lets an agent wait instead of retrying.
    server.tool(
      "get_usage_limits",
      `Get every usage limit that applies to you right now (per hour/day/week/month and
per billing cycle), how much of each is used, and when each resets.`,
      {
        caller_kind: z
          .enum(["user", "api"])
          .optional()
          .describe("Whose limits to report. Defaults to `api` — a tool call is an API caller"),
        caller_id: z.string().optional().describe("Member or API-key id, for per-caller windows"),
      },
      async ({ caller_kind, caller_id }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
        if (!opts.plans) return json({ limits: [], note: "No plans configured." });

        const plan = opts.resolvePlan
          ? await opts.resolvePlan(auth.orgId)
          : ((await adapter.getSubscription?.(auth.orgId))?.plan ?? null);

        const summary = await usageSummary(adapter, config, {
          orgId: auth.orgId,
          plans: opts.plans,
          plan,
          caller: { kind: caller_kind ?? "api", id: caller_id ?? auth.orgId },
        });

        // Flattened for a reader: one array of windows, whether a window came from
        // a rate limit, the pool or the seat pack. `remaining` is what decides
        // whether to make the next call; `resets_at` is what decides when to retry.
        const windows = [
          ...summary.windows.map((w) => ({ kind: "rate_limit" as const, ...w })),
          ...(summary.pool ? [{ kind: "included_pool" as const, ...summary.pool }] : []),
          ...(summary.pack ? [{ kind: "seat_pack" as const, ...summary.pack }] : []),
        ].map((w) => ({
          kind: w.kind,
          every: w.every,
          scope: w.scope,
          label: w.label,
          limit: w.size,
          used: w.used,
          remaining: w.remaining,
          percent_used: w.percent,
          resets_at: w.resetsAt ? new Date(w.resetsAt).toISOString() : null,
        }));

        return json({
          plan: summary.plan,
          windows,
          wallet_balance: summary.wallet,
          cycle: { start: new Date(summary.cycle.start).toISOString(), key: summary.cycle.key },
          checked_at: new Date(summary.at).toISOString(),
        });
      },
    );
  }

  // The rest need an org-metadata store on the adapter.
  if (!adapter.getOrgMetadata || !adapter.setOrgMetadata) return;

  // Seats are assignable only where a plan sells them. On a flat or free
  // catalogue `list_seats` answered `seat_types: []` and `assign_seat_type`
  // refused everything with "(none configured)" — two tools whose only possible
  // reply was that they do not apply here.
  if (caps.seats) {
    // Union of seat-type keys across all plans, for validating assign_seat_type.
    // Through the model, so it works whichever shape the config is written in.
    const knownSeatTypes = new Set<string>();
    for (const model of normalizePlans(opts.plans ?? {})) {
      for (const seat of model.seatTypes) knownSeatTypes.add(seat.key);
    }

    server.tool(
      "list_seats",
      `List the workspace's per-member seat-type assignments. Members without an entry
draw the default seat.`,
      {},
      async () => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        return json({
          assignments: await listSeatAssignments(adapter, auth.orgId),
          seat_types: [...knownSeatTypes],
        });
      },
    );

    server.tool(
      "assign_seat_type",
      `Assign a workspace member to a seat type (e.g. standard, premium). The member's
usage then draws that seat's per-cycle credit pack. Pass an empty seat_type to clear
the assignment (back to the default seat).`,
      {
        member_id: z.string().describe("The member's user id"),
        seat_type: z.string().optional().describe("Seat type key, or empty to clear"),
      },
      async ({ member_id, seat_type }) => {
        // Who sits on which seat decides who spends what, so it is an admin action
        // wherever the caller is a known person.
        const auth = await enforceAdmin(adapter, "assign_seat_type");
        if ("isError" in auth) return auth;
        // Being an admin of YOUR workspace says nothing about whether this user is in it.
        const stranger = await enforceMember(adapter, auth.orgId, member_id, "assign_seat_type");
        if (stranger) return stranger;
        const st = seat_type && seat_type.length ? seat_type : null;
        if (st && knownSeatTypes.size && !knownSeatTypes.has(st)) {
          return err(`Unknown seat type "${st}". Known: ${[...knownSeatTypes].join(", ") || "(none configured)"}.`);
        }
        await assignSeatType(adapter, auth.orgId, member_id, st);
        return json({ status: "ok", member_id, seat_type: st });
      },
    );
  }

  // The top-up flow exists only where a plan lets a member ask for extra
  // allowance (`replenish.request`). Without it there is nothing to grant: the
  // request landed in org metadata, the approval raised a pack the plan does not
  // have, and the owner was asked to rubber-stamp a no-op.
  if (caps.request) {
    server.tool(
      "list_top_up_requests",
      `List the workspace's credit top-up requests (pending and handled) — the extra
allowance members have asked the owner to grant this cycle.`,
      {},
      async () => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        return json({ requests: await listTopUpRequests(adapter, auth.orgId) });
      },
    );

    server.tool(
      "request_top_up",
      `Ask for extra credits on a member's seat for this cycle (an owner approves with
approve_top_up). Use when a user seat has hit its per-cycle pack. The amount is optional —
omit it and the plan decides, which is usually what you want: the caller knows they are out,
not what a reasonable top-up is.`,
      {
        member_id: z.string().describe("The member the extra allowance is for"),
        amount: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Credits to ask for. Omit to use the plan's share of that member's seat pack (default 25%)"),
        cycle: z
          .string()
          .optional()
          .describe("Cycle key the grant applies to. Defaults to the current billing cycle — pass one only to backfill"),
      },
      async ({ member_id, amount, cycle }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        // Requesting is not an admin action — asking is the whole point. But a
        // known non-admin caller may only ask for THEMSELVES: `member_id` arrives
        // from the caller, and an unchecked one lets a member queue a grant against
        // anyone's seat, which an owner approving in bulk would rubber-stamp.
        const principal = currentPrincipal();
        if (principal && member_id !== principal.userId) {
          const admin = principal.isAdmin ?? (await adapter.isAdmin?.(auth.orgId, principal.userId)) ?? true;
          if (!admin) return err("Forbidden (403): you can only request a top-up for yourself.");
        }
        const stranger = await enforceMember(adapter, auth.orgId, member_id, "request_top_up");
        if (stranger) return stranger;

        // `cycle` is a backfill escape hatch, so it keeps the raw path. Everything else goes
        // through `requestExtraAllowance`, which is where the amount is derived and where the
        // two refusals live — one open ask per member per cycle, and the plan's `maxPerCycle`.
        if (cycle) {
          const id = crypto.randomUUID();
          await requestTopUp(adapter, auth.orgId, {
            id,
            memberId: member_id,
            amount: amount ?? 0,
            cycle,
            createdAt: new Date().toISOString(),
          });
          return json({ status: "requested", id, member_id, amount: amount ?? 0, cycle });
        }

        if (!opts.plans) return err("No plans configured.");
        const plan = opts.resolvePlan
          ? await opts.resolvePlan(auth.orgId)
          : ((await adapter.getSubscription?.(auth.orgId))?.plan ?? null);
        const res = await requestExtraAllowance(adapter, {
          orgId: auth.orgId,
          plans: opts.plans,
          plan,
          memberId: member_id,
          ...(amount != null ? { amount } : {}),
        });
        if (!res.ok) {
          // Each refusal names what to do instead — an agent that is told "already pending"
          // waits, one told "not capped" stops asking.
          if (res.reason === "already_pending") {
            return json({
              status: "already_pending",
              member_id,
              cycle: res.cycle,
              pending: res.pending,
              message: "This member already has a top-up waiting for an answer this cycle.",
            });
          }
          return err(
            res.reason === "not_capped"
              ? "This plan has no per-seat packs, so extra allowance cannot be requested. " +
                  "Its limits are workspace-wide (see get_usage_limits)."
              : res.reason === "limit_reached"
                ? "This member has reached the plan's top-up ceiling for this cycle."
                : "Invalid amount.",
          );
        }
        return json({
          status: "requested",
          id: res.id,
          member_id,
          amount: res.amount,
          seat_pack: res.packSize,
          cycle: res.cycle,
        });
      },
    );

    server.tool(
      "approve_top_up",
      `Approve a pending top-up request → grants the requested extra credits to that
member for the cycle (added on top of their seat pack by the meter).`,
      { request_id: z.string().describe("The request id from list_top_up_requests") },
      async ({ request_id }) => {
        const auth = await enforceAdmin(adapter, "approve_top_up");
        if ("isError" in auth) return auth;
        const r = await approveTopUp(adapter, auth.orgId, request_id);
        if (!r.ok) return err(`Request not found or already handled: ${request_id}`);
        return json({ status: "approved", request_id });
      },
    );

    server.tool(
      "grant_top_up",
      `Grant a member extra allowance for the current cycle WITHOUT waiting for them to
request it, as a percentage of their own seat pack (default 25%). Admin action.`,
      {
        member_id: z.string().describe("WorkOS user id of the member to top up"),
        percent: z
          .number()
          .min(1)
          .max(1000)
          .optional()
          .default(25)
          .describe("Percentage of the member's seat pack to add (25 = +25%)"),
        credits: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Absolute credits instead of a percentage"),
      },
      async ({ member_id, percent, credits }) => {
        // Guarded like approve_top_up, and more so: this hands out allowance with
        // no request behind it, so leaving it open while approval is checked would
        // let a member simply grant themselves what they would have had to ask for.
        const auth = await enforceAdmin(adapter, "grant_top_up");
        if ("isError" in auth) return auth;
        const stranger = await enforceMember(adapter, auth.orgId, member_id, "grant_top_up");
        if (stranger) return stranger;
        if (!opts.plans) return err("No plans configured.");

        const plan = opts.resolvePlan
          ? await opts.resolvePlan(auth.orgId)
          : ((await adapter.getSubscription?.(auth.orgId))?.plan ?? null);

        const res = await grantExtraAllowance(adapter, {
          orgId: auth.orgId,
          plans: opts.plans,
          plan,
          memberId: member_id,
          // An explicit credit figure wins; otherwise the percentage (default 25).
          ...(credits != null ? { amount: credits } : { percent }),
        });

        if (!res.ok) {
          return err(
            res.reason === "not_capped"
              ? "This plan has no per-seat packs, so extra allowance cannot be granted. " +
                  "Its limits are workspace-wide (see get_usage_limits)."
              : "Invalid amount.",
          );
        }
        return json({
          status: "granted",
          member_id,
          granted: res.granted,
          seat_pack: res.packSize,
          total_extra_this_cycle: res.total,
          cycle: res.cycle,
        });
      },
    );

    server.tool(
      "deny_top_up",
      `Deny a pending top-up request.`,
      { request_id: z.string().describe("The request id from list_top_up_requests") },
      async ({ request_id }) => {
        const auth = await enforceAdmin(adapter, "deny_top_up");
        if ("isError" in auth) return auth;
        const r = await denyTopUp(adapter, auth.orgId, request_id);
        if (!r.ok) return err(`Request not found or already handled: ${request_id}`);
        return json({ status: "denied", request_id });
      },
    );
  }
}
