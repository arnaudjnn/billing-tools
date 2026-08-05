import type Stripe from "stripe";
import { getBillingCustomerId, getStripe } from "./billing.js";
import { clearMemberRecords } from "./seats.js";
import type { BillingAdapter } from "./types.js";

// Closing a workspace, in the order that money and records survive it.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// Deleting a workspace was one call — `deleteOrg` (org-mirror.ts) — and it deleted the WorkOS
// organization and nothing else. Three consequences, none of them visible from the call site:
//
//  1. The Stripe SUBSCRIPTION kept billing. Every month, the customer's card was charged for a
//     workspace that no longer existed. Nobody was refused, nothing errored, and the invoice
//     landed in an inbox for a product the customer had already left.
//  2. The POINTER was destroyed with the org. `stripeCustomerId` lives on the WorkOS org, so
//     deleting the org deletes the only mapping from that subscription back to anything. The
//     charge is then unattributable — you cannot find who is being billed or for what without
//     reading Stripe metadata by hand.
//  3. Nothing said to KEEP the customer. An invoice is a legally required record (ten years in
//     most of the EU), and deleting a Stripe customer takes its invoices with it. The instinct
//     when "deleting everything" is to delete that too, and it is the one object that must
//     stay.
//
// So the order is the whole design: **stop the billing, keep the records, then remove the
// org** — and if the billing cannot be stopped, the org is NOT removed, because an
// unattributable recurring charge is far worse than a workspace that is still listed.
//
// ── What is deliberately NOT done ───────────────────────────────────────────
//
// The Stripe customer is never deleted, and no refund is issued. A refund is a commercial
// decision with tax consequences (a credit note, not a negative charge), so it stays the
// operator's call — `cancelAt: "period_end"` is the no-refund way to let a customer use what
// they already paid for.

export interface CloseWorkspaceOptions {
  /**
   * `"now"` (default) stops the billing immediately: the workspace is going away, so a
   * subscription outliving it is the failure this function exists to prevent. Stripe issues no
   * refund for the unused part — see the note above.
   *
   * `"period_end"` lets the customer keep the period they paid for, at the cost of a live
   * subscription attached to an org that is gone. Only safe with `deleteOrg: false`, and this
   * refuses the combination rather than creating the orphan itself.
   */
  cancelAt?: "now" | "period_end";
  /** Remove the WorkOS organization at the end. Default true. Needs `adapter.deleteOrg`. */
  deleteOrg?: boolean;
  /** Clear this workspace's entries from each member's own metadata. Default true. */
  clearMembers?: boolean;
  /** Recorded on the Stripe customer so the kept record explains itself. */
  reason?: string;
}

export interface CloseWorkspaceResult {
  orgId: string;
  customerId: string | null;
  /** Subscription ids whose billing was stopped. */
  cancelled: string[];
  /** How each one ended, so a caller can tell "gone" from "ends later". */
  endsAt: Record<string, string | null>;
  /** Invoices left in place on purpose — the legal record. */
  invoicesKept: number;
  /** Members whose per-workspace metadata was cleared. */
  membersCleared: number;
  orgDeleted: boolean;
  /** Anything that could not be completed. Non-empty means finish by hand. */
  warnings: string[];
}

const LIVE: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);

/**
 * Close `orgId`: stop its billing, keep its invoices, then remove it.
 *
 * Returns what happened rather than throwing, EXCEPT where continuing would create the orphan
 * it exists to prevent: if a subscription cannot be cancelled, the org is left in place and
 * the reason is in `warnings`.
 */
export async function closeWorkspace(
  adapter: BillingAdapter,
  orgId: string,
  opts: CloseWorkspaceOptions = {},
): Promise<CloseWorkspaceResult> {
  const cancelAt = opts.cancelAt ?? "now";
  const wantDelete = opts.deleteOrg ?? true;
  const warnings: string[] = [];
  const result: CloseWorkspaceResult = {
    orgId,
    customerId: null,
    cancelled: [],
    endsAt: {},
    invoicesKept: 0,
    membersCleared: 0,
    orgDeleted: false,
    warnings,
  };

  // `period_end` plus deletion is precisely the orphan: a live subscription whose org is gone.
  // Refused up front rather than half-done, because the half that already ran is a deletion.
  if (cancelAt === "period_end" && wantDelete) {
    warnings.push(
      "cancelAt: 'period_end' with deleteOrg: true would leave a live subscription whose org no longer exists. Pass deleteOrg: false, or cancel now.",
    );
    return result;
  }

  const customerId = await getBillingCustomerId(adapter, orgId);
  result.customerId = customerId;

  // ── 1. stop the billing ───────────────────────────────────────────────────
  if (customerId) {
    const stripe = getStripe();
    const live: Stripe.Subscription[] = [];
    for await (const sub of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
      if (LIVE.has(sub.status)) live.push(sub);
    }

    for (const sub of live) {
      try {
        if (cancelAt === "now") {
          // A schedule refuses cancellation while attached — the same rule `cancelPlan` hit.
          if (sub.schedule) {
            await stripe.subscriptionSchedules.release(
              typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id,
            );
          }
          const done = await stripe.subscriptions.cancel(sub.id, {
            // No proration credit: the customer is leaving, and a credit balance on a customer
            // nobody will bill again is a number that can only mislead a later reconciliation.
            prorate: false,
          });
          result.cancelled.push(sub.id);
          result.endsAt[sub.id] = done.canceled_at ? new Date(done.canceled_at * 1000).toISOString() : null;
        } else {
          const done = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
          result.cancelled.push(sub.id);
          const end = (done.items?.data ?? [])
            .map((i) => (i as unknown as { current_period_end?: number }).current_period_end)
            .filter((v): v is number => !!v);
          result.endsAt[sub.id] = end.length ? new Date(Math.max(...end) * 1000).toISOString() : null;
        }
      } catch (e) {
        warnings.push(`could not stop subscription ${sub.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ── 2. keep the records, and say why they are there ─────────────────────
    // The customer object is NOT deleted: its invoices are the legal record. Marking it means a
    // later audit can tell a closed workspace from a lost pointer.
    try {
      const invoices = await stripe.invoices.list({ customer: customerId, limit: 100 });
      result.invoicesKept = invoices.data.length;
      await stripe.customers.update(customerId, {
        metadata: {
          bt_closed_at: new Date().toISOString(),
          bt_closed_org: orgId,
          ...(opts.reason ? { bt_closed_reason: opts.reason.slice(0, 500) } : {}),
        },
      });
    } catch (e) {
      warnings.push(`could not annotate the kept customer ${customerId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Billing still running means the org must stay: deleting it now is what makes the charge
  // unattributable, which is the whole failure being prevented.
  const billingStopped = warnings.every((w) => !w.startsWith("could not stop subscription"));

  // ── 3. give every ex-member their metadata budget back ────────────────────
  if ((opts.clearMembers ?? true) && adapter.listMemberIds && adapter.getUserMetadata) {
    try {
      const members = await adapter.listMemberIds(orgId);
      result.membersCleared = await clearMemberRecords(adapter, orgId, members);
    } catch (e) {
      warnings.push(`could not clear member records: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 4. remove the org, last ───────────────────────────────────────────────
  if (wantDelete) {
    if (!billingStopped) {
      warnings.push("org NOT deleted: its billing is still running, and deleting it would make that charge unattributable.");
    } else if (!adapter.deleteOrg) {
      warnings.push("org NOT deleted: this adapter has no deleteOrg. Billing is stopped, so remove it wherever it lives.");
    } else {
      try {
        await adapter.deleteOrg(orgId);
        result.orgDeleted = true;
      } catch (e) {
        warnings.push(`could not delete org: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return result;
}

/**
 * Live subscriptions whose org cannot be resolved any more — the wreckage of a workspace
 * deleted the old way.
 *
 * Bounded by subscriptions EXAMINED rather than orphans found, for the same reason the usage
 * scans are: an account with thousands of healthy subscriptions must not be walked in full to
 * answer a health question.
 */
export async function findOrphanedSubscriptions(
  adapter: BillingAdapter,
  { examine = 200 }: { examine?: number } = {},
): Promise<Array<{ subscriptionId: string; customerId: string | null; orgId: string | null; amount: number | null }>> {
  const stripe = getStripe();
  const out: Array<{ subscriptionId: string; customerId: string | null; orgId: string | null; amount: number | null }> = [];
  let seen = 0;

  for await (const sub of stripe.subscriptions.list({ status: "active", limit: 100 })) {
    if (++seen > examine) break;
    const orgId = sub.metadata?.org_id ?? null;
    // No org id at all is not an orphan by itself — a subscription created outside this
    // library never had one, and calling that broken would cry wolf.
    if (!orgId) continue;
    let resolvable = true;
    try {
      // Any adapter read that needs the org to exist will do; domains is the cheapest.
      await adapter.getOrgDomains(orgId);
    } catch {
      resolvable = false;
    }
    if (!resolvable) {
      out.push({
        subscriptionId: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
        orgId,
        amount: sub.items.data.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0),
      });
    }
  }
  return out;
}
