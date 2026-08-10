import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { currentPrincipal, enforceAccess, enforceAdmin } from "../auth.js";
import { stripeConfigured } from "../billing.js";
import {
  cancelPlan,
  changePlan,
  planActions,
  previewPlanChange,
  PlanChangeError,
} from "../subscription.js";
import { normalizePlans, type PlanCatalog } from "../plans.js";
import {
  isSatisfied,
  listPlanRequests,
  requestPlanChange,
  requestSeatChange,
  resolvePlanRequest,
} from "../plan-request.js";
import { getSeatType } from "../seats.js";
import { ALL_TOOL_CAPABILITIES, type ToolCapabilities } from "../plan-model.js";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import type { Notify } from "../notifications/index.js";

// The subscription lifecycle, as tools.
//
// This is the gap the QA pass found: changing plan was reachable from the app's
// own UI and from nowhere else. An agent could read the plans, buy credits and
// meter usage, but could not move between plans, cancel, or even ask what a move
// would cost — the one thing a customer most wants to know before committing.
//
// Everything routes through `changePlan`, so the tool has the same properties the
// UI does: one live subscription, prorated up, scheduled down, cancel as a move
// to the free plan.

function json(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}
function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/** Map a PlanChangeError onto a tool error the caller can act on. */
function toolError(e: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  if (e instanceof PlanChangeError) {
    // `detail` carries the candidate subscription ids for the ambiguous case and
    // the basket problems for an invalid one — both actionable, so pass them on.
    const detail = Array.isArray(e.detail)
      ? ` [${e.detail.map(String).join(", ")}]`
      : "";
    return err(`${e.message} (${e.code})${detail}`);
  }
  return err(e instanceof Error ? e.message : String(e));
}

export interface SubscriptionToolOptions {
  plans: PlanCatalog;
  /** Where Stripe returns after a first-purchase Checkout, which has no
   *  subscription to prorate against. Defaults to `config.baseUrl`: the option is
   *  easy not to know about, and unset it made `change_plan` throw
   *  `needs_return_url` on exactly that path — a refusal the caller cannot act on,
   *  in place of a landing page every deployment already has. */
  returnUrl?: string;
  /** Stripe TaxRate ids for a change, when the account computes its own tax.
   *  Defaults to the rates already on the subscription's items. */
  taxRates?: (orgId: string) => Promise<string[]> | string[];
  /** Say that somebody asked to move up. See `notifications/`. */
  notify?: Notify;
}

export function registerSubscriptionTools(
  server: McpServer,
  adapter: BillingAdapter,
  config: ResolvedConfig,
  opts: SubscriptionToolOptions,
  caps: ToolCapabilities = ALL_TOOL_CAPABILITIES,
) {
  const seatsSchema = z
    .record(z.string(), z.number().int().min(0))
    .optional()
    .describe(
      'Seats per seat type, e.g. {"standard": 3, "premium": 1}. Defaults to the plan minimum',
    );

  const rates = async (orgId: string) =>
    opts.taxRates ? await opts.taxRates(orgId) : undefined;

  // The three tools that CHANGE a subscription need a plan a customer can move to
  // without a salesperson. On a catalogue that is entirely free + quote-only there
  // is no such move, and `change_plan` could only ever refuse — while `get_plan`
  // below stays a useful read on any catalogue.
  if (caps.lifecycle) {
    server.tool(
      "preview_plan_change",
      `What moving to a plan would cost, WITHOUT making the change.

Returns four numbers, and they mean different things: \`due_now\` is charged today
(zero unless proration is invoice_now), \`next_invoice_total\` is what the NEXT
invoice comes to including any deferred difference, \`recurring_total\` is the
steady-state price after that, and \`credit_applied\` is the unused part of the
  current plan credited back. On a mid-cycle upgrade the next invoice is LARGER
than the plan price — quote it together with \`next_invoice_at\` so the customer
  is told rather than surprised.

Quote this before change_plan, with the same \`proration\`: both come from the
same arithmetic, so the number shown is the number charged.`,
      {
        plan: z.string().describe("Target plan key, from list_plans"),
        interval: z.enum(["monthly", "yearly"]).optional(),
        seats: seatsSchema,
        timing: z
          .enum(["auto", "now", "period_end"])
          .optional()
          .describe(
            "Default `auto`: upgrades apply now, downgrades at the period end",
          ),
        proration: z
          .enum(["next_invoice", "invoice_now", "none"])
          .optional()
          .describe(
            "Must match what you pass to change_plan — it decides whether the difference is billed today",
          ),
      },
      async ({ plan, interval, seats, timing, proration }) => {
        const auth = await enforceAdmin(adapter, "preview_plan_change");
        if ("isError" in auth) return auth;
        if (!stripeConfigured())
          return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
        try {
          const p = await previewPlanChange(adapter, auth.orgId, {
            plans: opts.plans,
            to: { plan, interval, seats },
            currency: config.currency,
            timing,
            proration,
            taxRates: await rates(auth.orgId),
          });
          return json({
            outcome: p.kind,
            currency: p.currency,
            due_now: p.dueNow,
            next_invoice_total: p.nextInvoiceTotal,
            recurring_total: p.recurringTotal,
            credit_applied: p.credit,
            effective_at: p.effectiveAt,
            next_invoice_at: p.nextInvoiceAt,
            lines: p.lines,
          });
        } catch (e) {
          return toolError(e);
        }
      },
    );

    server.tool(
      "change_plan",
      `Move this workspace to another plan — up, down, or off. One entry point for all
  three: an upgrade applies immediately and is prorated, a downgrade is scheduled for
  the end of the paid period (no refund, nothing lost early), and moving to the free
  plan cancels at the period end. Moving back to the current plan while a cancellation
is pending resumes it. Preview the cost first with preview_plan_change.`,
      {
        plan: z.string().describe("Target plan key, from list_plans"),
        interval: z.enum(["monthly", "yearly"]).optional(),
        seats: seatsSchema,
        timing: z
          .enum(["auto", "now", "period_end"])
          .optional()
          .describe(
            "Default `auto`: upgrades now, downgrades at the period end",
          ),
        proration: z
          .enum(["next_invoice", "invoice_now", "none"])
          .optional()
          .describe(
            "Default `next_invoice`: the prorated difference lands on the next invoice",
          ),
      },
      async ({ plan, interval, seats, timing, proration }) => {
        const auth = await enforceAdmin(adapter, "change_plan");
        if ("isError" in auth) return auth;
        if (!stripeConfigured())
          return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
        try {
          const r = await changePlan(adapter, auth.orgId, {
            plans: opts.plans,
            to: { plan, interval, seats },
            config,
            currency: config.currency,
            timing,
            proration,
            returnUrl: opts.returnUrl ?? config.baseUrl,
            // Hosted, because THIS caller has no browser. An agent handed a client
            // secret can do nothing with it — which is how a consumer ends up
            // hand-rolling a hosted session next to this one and losing the
            // deployment's tax and payment-method configuration with it.
            uiMode: "hosted",
            taxRates: await rates(auth.orgId),
          });
          return json({
            outcome: r.kind,
            plan: r.plan,
            status: r.status,
            effective_at: r.effectiveAt,
            subscription_id: r.subscriptionId,
            // Only on the first-purchase path: there is nothing to change yet, so
            // the caller has to send someone through Checkout.
            ...(r.kind === "checkout"
              ? {
                  checkout_url: r.checkoutUrl,
                  checkout_session_id: r.sessionId,
                }
              : {}),
          });
        } catch (e) {
          return toolError(e);
        }
      },
    );

    server.tool(
      "cancel_plan",
      `Cancel the subscription at the end of the period already paid for. Nothing is
  refunded and nothing is lost today — the workspace drops to the free plan when the
period ends. Reverse it before then with change_plan back to the current plan.`,
      {},
      async () => {
        const auth = await enforceAdmin(adapter, "cancel_plan");
        if ("isError" in auth) return auth;
        if (!stripeConfigured())
          return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
        try {
          const r = await cancelPlan(adapter, auth.orgId, {
            plans: opts.plans,
            currency: config.currency,
          });
          return json({
            outcome: r.kind,
            plan: r.plan,
            status: r.status,
            effective_at: r.effectiveAt,
          });
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  server.tool(
    "get_plan",
    `The workspace's current plan: what it is on, whether a change is already
scheduled, and which moves are available (the plan above, the plan below, whether it
can be cancelled) — the same set the billing screen offers.`,
    {},
    async () => {
      // A READ, so `enforceAccess` — any member may see which plan their workspace is
      // on. It was `enforceAdmin`, copied from the three tools that CHANGE a plan
      // beside it, which meant a member could not answer "what am I paying for".
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      const sub = (await adapter.getSubscription?.(auth.orgId)) ?? null;
      const md = (await adapter.getOrgMetadata?.(auth.orgId)) ?? {};
      const current = sub?.plan ?? null;
      const actions = planActions(opts.plans, current);
      const named = (key: string | null) =>
        key
          ? (normalizePlans(opts.plans).find((m) => m.key === key)?.key ?? key)
          : null;
      return json({
        plan: current,
        status: sub?.status ?? null,
        period_end: sub?.periodEnd ?? null,
        pending_plan: md.pendingPlan ?? null,
        pending_plan_at: md.pendingPlanAt ?? null,
        actions: {
          upgrade_to: named(actions.upgradeTo),
          downgrade_to: named(actions.downgradeTo),
          can_cancel: actions.canCancel,
          cancel_to: named(actions.cancelTo),
        },
        // Who has ASKED to move up, folded in here rather than given a tool of its own:
        // "what is this workspace on, and what does anyone want it to be on" is one
        // question, and a separate `list_plan_requests` would be a second call every
        // billing screen makes. Satisfied asks are dropped — a want the workspace has
        // already met is not pending, however it got there.
        plan_requests: (await listPlanRequests(adapter, auth.orgId))
          .filter((r) => r.status === "pending")
          // A SEAT request needs that member's seat to know whether it is satisfied, and
          // reading one per row would be a query per request on a page that already reads
          // plenty. Plan requests are filtered here; a seat one is filtered by the caller,
          // which is holding the seat map anyway (`list_seats`).
          .filter(
            (r) => r.kind === "seat" || !isSatisfied(r, opts.plans, current),
          )
          .map((r) => ({
            id: r.id,
            member_id: r.memberId,
            kind: r.kind ?? "plan",
            target: r.plan,
            plan: r.plan,
            created_at: r.createdAt,
            note: r.note ?? null,
          })),
      });
    },
  );

  // ── Asking to move up ─────────────────────────────────────────────────────
  //
  // The other answer to "I am out of usage", and the only one on a plan whose windows belong
  // to the workspace: a pooled plan has nothing per-member to top up, so `request_top_up`
  // refuses it outright and a screen offering one is offering a door that does not open.

  server.tool(
    "request_plan_change",
    `Ask an owner to move the workspace up a plan. Use when usage is exhausted and the plan
has no per-seat allowance to top up. Does NOT change the plan or take a payment — it queues
the ask for whoever can. The plan defaults to the next one up.`,
    {
      plan: z
        .string()
        .optional()
        .describe("Plan key to ask for. Defaults to the next one up"),
      note: z
        .string()
        .max(140)
        .optional()
        .describe("A line for the owner, e.g. why"),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          "Anything this deployment's own form collects — e.g. {\"totalEstimatedSeats\": 12}. " +
            "Stored verbatim and acted on by nothing here; kept small, since the whole queue " +
            "shares one metadata value",
        ),
    },
    async ({ plan, note, metadata }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      // Whoever is asking is who it is FROM: unlike a top-up there is no `member_id`
      // argument, so there is nothing to name someone else with.
      const principal = currentPrincipal();
      const memberId = principal?.userId ?? auth.orgId;
      const current =
        (await adapter.getSubscription?.(auth.orgId))?.plan ?? null;

      const res = await requestPlanChange(adapter, auth.orgId, {
        memberId,
        plans: opts.plans,
        notify: opts.notify,
        ...(metadata ? { metadata } : {}),
        currentPlan: current,
        ...(plan ? { plan } : {}),
        ...(note ? { note } : {}),
      });
      if (!res.ok) {
        if (res.reason === "already_pending") {
          return json({
            status: "already_pending",
            pending: res.pending,
            message:
              "Somebody has already asked to move this workspace up; it is waiting on an owner.",
          });
        }
        return err(
          res.reason === "no_upgrade"
            ? "There is no plan above this one to ask for."
            : res.reason === "already_on_it"
              ? `This workspace is already on ${res.plan} or better.`
              : "Unknown plan.",
        );
      }
      return json({
        status: "requested",
        id: res.id,
        plan: res.plan,
        from: current,
      });
    },
  );

  // A SEAT ask needs a catalogue with seats in it. This registered unconditionally, so a
  // flat or pooled catalogue — one that sells no seat at any price — advertised a tool for
  // asking to be moved to a bigger one. `nextSeatUp` has nothing to return there, so the
  // best case was a refusal and the honest case is not offering it: the same gate
  // `list_seats` and `assign_seat_type` have always used.
  if (caps.seats) {
    server.tool(
      "request_seat_change",
      `Ask an owner to move you to a bigger seat. Use when a seat's per-cycle pack is exhausted
and a better seat exists — that is the answer, not a top-up, because a bigger seat raises the
pack permanently while a top-up buys a few days. Does NOT change the seat or take a payment.`,
      {
        seat_type: z
          .string()
          .optional()
          .describe("Seat type to ask for. Defaults to the next one up"),
        note: z
          .string()
          .max(140)
          .optional()
          .describe("A line for the owner, e.g. why"),
      },
      async ({ seat_type, note }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        const principal = currentPrincipal();
        const memberId = principal?.userId ?? auth.orgId;
        const current =
          (await adapter.getSubscription?.(auth.orgId))?.plan ?? null;
        const seat = await getSeatType(adapter, auth.orgId, memberId);

        const res = await requestSeatChange(adapter, auth.orgId, {
          memberId,
          plans: opts.plans,
          notify: opts.notify,
          currentPlan: current,
          currentSeatType: seat,
          ...(seat_type ? { seatType: seat_type } : {}),
          ...(note ? { note } : {}),
        });
        if (!res.ok) {
          if (res.reason === "already_pending") {
            return json({
              status: "already_pending",
              pending: res.pending,
              message: "You already have a request waiting on an owner.",
            });
          }
          return err(
            res.reason === "no_upgrade"
              ? "There is no better seat to ask for on this plan."
              : res.reason === "already_on_it"
                ? `You are already on ${res.seatType} or better.`
                : "Unknown seat type.",
          );
        }
        return json({
          status: "requested",
          id: res.id,
          seat_type: res.seatType,
          from: seat,
        });
      },
    );
  }

  server.tool(
    "resolve_plan_request",
    `Mark a plan-change or seat-change request handled or refused (admin). Recording it handled
does NOT move anything — use change_plan or assign_seat_type for that, and change_plan takes
a payment.`,
    {
      request_id: z.string().describe("The id from get_plan's plan_requests"),
      decision: z
        .enum(["done", "denied"])
        .describe("`done` once you have acted on it"),
    },
    async ({ request_id, decision }) => {
      const auth = await enforceAdmin(adapter, "resolve_plan_request");
      if ("isError" in auth) return auth;
      const r = await resolvePlanRequest(
        adapter,
        auth.orgId,
        request_id,
        decision,
      );
      if (!r) return err(`Request not found or already handled: ${request_id}`);
      return json({ status: r.status, request_id, plan: r.plan });
    },
  );
}
