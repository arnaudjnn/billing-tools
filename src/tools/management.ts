import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { enforceAccess } from "../auth.js";
import { getBillingCustomerId, usageSince, stripeConfigured } from "../billing.js";
import { requestTopUp, listTopUpRequests, approveTopUp, denyTopUp } from "../topup.js";
import { assignSeatType, listSeatAssignments } from "../seats.js";
import { normalizePlans, type PlanCatalog } from "../plans.js";

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}
function monthStartUnix(): number {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}
function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Workspace-management tools: usage read, per-member seat assignment, and the
// user-seat top-up request/approval flow. All ORG-SCOPED (auth = the org's key /
// session). Seat + top-up tools require the adapter's metadata methods; when they
// are absent (an adapter without an org-metadata store) only get_usage registers.
export function registerManagementTools(
  server: McpServer,
  adapter: BillingAdapter,
  _config: ResolvedConfig,
  opts: { plans?: PlanCatalog } = {},
) {
  server.tool(
    "get_usage",
    `Get your workspace's token usage for the current cycle (summed from the Stripe
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
      const since = since_days ? Math.floor(Date.now() / 1000) - since_days * 86400 : monthStartUnix();
      const filter = caller_kind ? { callerKind: caller_kind, callerId: caller_id } : undefined;
      const usage = await usageSince(cid, since, filter);
      return json({ usage, since, cycle: monthKey(), filter: filter ?? null });
    },
  );

  // The rest need an org-metadata store on the adapter.
  if (!adapter.getOrgMetadata || !adapter.setOrgMetadata) return;

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
usage then draws that seat's per-cycle token pack. Pass an empty seat_type to clear
the assignment (back to the default seat).`,
    {
      member_id: z.string().describe("The member's user id"),
      seat_type: z.string().optional().describe("Seat type key, or empty to clear"),
    },
    async ({ member_id, seat_type }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      const st = seat_type && seat_type.length ? seat_type : null;
      if (st && knownSeatTypes.size && !knownSeatTypes.has(st)) {
        return err(`Unknown seat type "${st}". Known: ${[...knownSeatTypes].join(", ") || "(none configured)"}.`);
      }
      await assignSeatType(adapter, auth.orgId, member_id, st);
      return json({ status: "ok", member_id, seat_type: st });
    },
  );

  server.tool(
    "list_top_up_requests",
    `List the workspace's token top-up requests (pending and handled) — the extra
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
    `Request extra tokens for a member's seat this cycle (the owner approves with
approve_top_up). Use when a user seat has hit its per-cycle pack.`,
    {
      member_id: z.string().describe("The member the extra allowance is for"),
      amount: z.number().int().min(1).describe("Extra tokens requested (e.g. 25% of the seat pack)"),
      cycle: z.string().optional().describe('Cycle key the grant applies to (default current "YYYY-MM")'),
    },
    async ({ member_id, amount, cycle }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      const id = crypto.randomUUID();
      const c = cycle ?? monthKey();
      await requestTopUp(adapter, auth.orgId, {
        id,
        memberId: member_id,
        amount,
        cycle: c,
        createdAt: new Date().toISOString(),
      });
      return json({ status: "requested", id, member_id, amount, cycle: c });
    },
  );

  server.tool(
    "approve_top_up",
    `Approve a pending top-up request → grants the requested extra tokens to that
member for the cycle (added on top of their seat pack by the meter).`,
    { request_id: z.string().describe("The request id from list_top_up_requests") },
    async ({ request_id }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      const r = await approveTopUp(adapter, auth.orgId, request_id);
      if (!r.ok) return err(`Request not found or already handled: ${request_id}`);
      return json({ status: "approved", request_id });
    },
  );

  server.tool(
    "deny_top_up",
    `Deny a pending top-up request.`,
    { request_id: z.string().describe("The request id from list_top_up_requests") },
    async ({ request_id }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      const r = await denyTopUp(adapter, auth.orgId, request_id);
      if (!r.ok) return err(`Request not found or already handled: ${request_id}`);
      return json({ status: "denied", request_id });
    },
  );
}
