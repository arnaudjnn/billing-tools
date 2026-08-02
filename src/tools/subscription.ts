import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { enforceAdmin } from "../auth.js";
import { stripeConfigured } from "../billing.js";
import {
  cancelPlan,
  changePlan,
  planActions,
  previewPlanChange,
  PlanChangeError,
} from "../subscription.js";
import { normalizePlans, type PlanCatalog } from "../plans.js";
import type { BillingAdapter, ResolvedConfig } from "../types.js";

// The subscription lifecycle, as tools.
//
// This is the gap the QA pass found: changing plan was reachable from the app's
// own UI and from nowhere else. An agent could read the plans, buy tokens and
// meter usage, but could not move between plans, cancel, or even ask what a move
// would cost — the one thing a customer most wants to know before committing.
//
// Everything routes through `changePlan`, so the tool has the same properties the
// UI does: one live subscription, prorated up, scheduled down, cancel as a move
// to the free plan.

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/** Map a PlanChangeError onto a tool error the caller can act on. */
function toolError(e: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  if (e instanceof PlanChangeError) {
    // `detail` carries the candidate subscription ids for the ambiguous case and
    // the basket problems for an invalid one — both actionable, so pass them on.
    const detail = Array.isArray(e.detail) ? ` [${e.detail.map(String).join(", ")}]` : "";
    return err(`${e.message} (${e.code})${detail}`);
  }
  return err(e instanceof Error ? e.message : String(e));
}

export interface SubscriptionToolOptions {
  plans: PlanCatalog;
  /** Where Stripe returns after a first-purchase Checkout, which has no
   *  subscription to prorate against. */
  returnUrl?: string;
  /** Stripe TaxRate ids for a change, when the account computes its own tax.
   *  Defaults to the rates already on the subscription's items. */
  taxRates?: (orgId: string) => Promise<string[]> | string[];
}

export function registerSubscriptionTools(
  server: McpServer,
  adapter: BillingAdapter,
  config: ResolvedConfig,
  opts: SubscriptionToolOptions,
) {
  const seatsSchema = z
    .record(z.string(), z.number().int().min(0))
    .optional()
    .describe('Seats per seat type, e.g. {"standard": 3, "premium": 1}. Defaults to the plan minimum');

  const rates = async (orgId: string) => (opts.taxRates ? await opts.taxRates(orgId) : undefined);

  server.tool(
    "preview_plan_change",
    `What moving to a plan would cost, WITHOUT making the change. Returns the prorated
amount due now (the unused part of the current plan credited against the new one),
the recurring total afterwards, and when it takes effect. Quote this before
change_plan — the numbers come from the same arithmetic, so they agree.`,
    {
      plan: z.string().describe("Target plan key, from list_plans"),
      interval: z.enum(["monthly", "yearly"]).optional(),
      seats: seatsSchema,
      timing: z
        .enum(["auto", "now", "period_end"])
        .optional()
        .describe("Default `auto`: upgrades apply now, downgrades at the period end"),
      proration: z
        .enum(["next_invoice", "invoice_now", "none"])
        .optional()
        .describe("Must match what you pass to change_plan — it decides whether the difference is billed today"),
    },
    async ({ plan, interval, seats, timing, proration }) => {
      const auth = await enforceAdmin(adapter, "preview_plan_change");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
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
        .describe("Default `auto`: upgrades now, downgrades at the period end"),
      proration: z
        .enum(["next_invoice", "invoice_now", "none"])
        .optional()
        .describe("Default `next_invoice`: the prorated difference lands on the next invoice"),
    },
    async ({ plan, interval, seats, timing, proration }) => {
      const auth = await enforceAdmin(adapter, "change_plan");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      try {
        const r = await changePlan(adapter, auth.orgId, {
          plans: opts.plans,
          to: { plan, interval, seats },
          config,
          currency: config.currency,
          timing,
          proration,
          returnUrl: opts.returnUrl,
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
          ...(r.kind === "checkout" ? { checkout_client_secret: r.clientSecret, checkout_session_id: r.sessionId } : {}),
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
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      try {
        const r = await cancelPlan(adapter, auth.orgId, { plans: opts.plans, currency: config.currency });
        return json({ outcome: r.kind, plan: r.plan, status: r.status, effective_at: r.effectiveAt });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    "get_plan",
    `The workspace's current plan: what it is on, whether a change is already
scheduled, and which moves are available (the plan above, the plan below, whether it
can be cancelled) — the same set the billing screen offers.`,
    {},
    async () => {
      const auth = await enforceAdmin(adapter, "get_plan");
      if ("isError" in auth) return auth;
      const sub = (await adapter.getSubscription?.(auth.orgId)) ?? null;
      const md = (await adapter.getOrgMetadata?.(auth.orgId)) ?? {};
      const current = sub?.plan ?? null;
      const actions = planActions(opts.plans, current);
      const named = (key: string | null) =>
        key ? (normalizePlans(opts.plans).find((m) => m.key === key)?.key ?? key) : null;
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
      });
    },
  );
}
