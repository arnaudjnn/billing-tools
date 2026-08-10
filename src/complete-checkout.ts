import { getStripe } from "./billing.js";
import { updateBillingProfile, type BillingAddress } from "./billing-profile.js";
import { checkoutSessionOutcome } from "./checkout.js";
import { planForPriceId } from "./plans.js";
import type { BillingAdapter } from "./types.js";
import type Stripe from "stripe";

// AFTER the payment: the five things that have to happen, in one call.
//
// Opening a Checkout Session was always the library's; finishing one was every consumer's,
// and it is not one step. Measured on the first app to do it, which wrote it three times —
// once for signup, once for a plan change, once for a credit top-up — each copy a slightly
// different subset:
//
//   1. was it actually PAID (not just "the tab came back")
//   2. attach the Stripe customer to the org, if this is the first thing it ever bought
//   3. stamp `org_id` on the subscription — the signup path CANNOT do this at create time,
//      because no workspace exists until the payment succeeds, and without it every sync
//      handler reads `subscription.metadata.org_id` as undefined and silently does nothing:
//      no plan mirrored, no `past_due`, no per-cycle credit grant
//   4. mirror the plan onto the org, so the meter resolves it before the webhook arrives
//   5. put the billing profile BACK, if the payer's address was not meant to replace the
//      workspace's
//
// (5) is the one nobody thinks of. Checkout writes the payer's name and address onto the
// customer (`customer_update`) because Stripe Tax computes zero tax without a location on the
// customer — and those are the very fields that ARE the workspace's billing address and
// company name. Paying with a personal address silently replaced the team's. It cannot be
// prevented during the payment; undoing it afterwards is the honest version of "no", and it
// only works if the pre-payment values were carried ON the session, which is why
// `createCheckoutSession` puts them there.

export interface CompleteCheckoutOptions {
  /**
   * The org the payment belongs to. Omit for the SIGNUP case, where the workspace does not
   * exist until this returns — the caller creates it from `metadata` and then calls again (or
   * passes `attachTo`).
   */
  orgId?: string;
  /**
   * Whether the address typed at checkout should STAY as the workspace's billing address.
   *
   * Default true, which is Stripe's own behaviour and what most purchases mean. `false`
   * restores whatever was there before, from the values `createCheckoutSession` carried on
   * the session — see the note above for why it cannot simply be prevented.
   */
  keepBillingAddress?: boolean;
  /** The plan this session was buying, when the catalogue cannot be reached from the price. */
  plan?: string | null;
}

export interface CompleteCheckoutResult {
  paid: boolean;
  customerId: string | null;
  subscriptionId: string | null;
  /** What the session was created with — a workspace name, the user it belongs to. */
  metadata: Record<string, string>;
  /** "subscription" | "payment" | "setup". */
  mode: string | null;
  /** The plan recorded on the org, when this was a subscription purchase. */
  plan: string | null;
  /** Steps that did not complete. Non-empty means finish by hand: the payment SUCCEEDED, so
   *  this is never a reason to refuse the customer what they bought. */
  warnings: string[];
}

/**
 * Verify a Checkout Session and record everything that follows from it.
 *
 * Safe to call twice — every step is idempotent (the customer pointer is only written when
 * absent, the metadata write is the same value, the mirror is the same plan), which matters
 * because a return URL is a page a browser reloads.
 */
export async function completeCheckout(
  adapter: BillingAdapter,
  sessionId: string,
  opts: CompleteCheckoutOptions = {},
): Promise<CompleteCheckoutResult> {
  const outcome = await checkoutSessionOutcome(sessionId);
  const warnings: string[] = [];
  const result: CompleteCheckoutResult = {
    ...outcome,
    plan: null,
    warnings,
  };
  if (!outcome.paid) return result;

  const orgId = opts.orgId;
  if (!orgId) {
    // The signup case: nothing to attach to yet. The caller creates the workspace from
    // `metadata` and calls again with `orgId` — which is why every step below is idempotent.
    return result;
  }

  // (2) The customer pointer, only when the org has none: overwriting it would repoint a
  // workspace at a different customer's invoices and credit.
  if (outcome.customerId) {
    try {
      const existing = await adapter.getBillingCustomerId(orgId);
      if (!existing) await adapter.setBillingCustomerId(orgId, outcome.customerId);
      else if (existing !== outcome.customerId) {
        warnings.push(
          `org already points at ${existing}; session paid as ${outcome.customerId} and was left alone`,
        );
      }
    } catch (e) {
      warnings.push(`customer not attached: ${msg(e)}`);
    }
  }

  if (outcome.subscriptionId) {
    const stripe = getStripe();
    let sub: Stripe.Subscription | null = null;
    try {
      sub = await stripe.subscriptions.retrieve(outcome.subscriptionId);
    } catch (e) {
      warnings.push(`subscription not read: ${msg(e)}`);
    }

    // (3) `org_id`, without which every sync handler silently does nothing for this
    // subscription for the rest of its life.
    if (sub && sub.metadata?.org_id !== orgId) {
      try {
        await stripe.subscriptions.update(sub.id, { metadata: { ...sub.metadata, org_id: orgId } });
      } catch (e) {
        warnings.push(`org_id not stamped on ${sub.id}: ${msg(e)}`);
      }
    }

    // (4) The plan, mirrored now rather than when the webhook lands: the customer is looking
    // at the page that says what they just bought.
    const priceId = sub?.items?.data?.[0]?.price?.id;
    const plan = opts.plan ?? (priceId ? await planForPriceId(priceId) : null);
    result.plan = plan;
    if (sub) {
      try {
        await adapter.setSubscription?.(orgId, {
          plan: plan ?? undefined,
          status: sub.status,
          subscriptionId: sub.id,
          periodStart: periodOf(sub).start,
          periodEnd: periodOf(sub).end,
        });
      } catch (e) {
        warnings.push(`plan not mirrored: ${msg(e)}`);
      }
    }
  }

  // (5) The billing profile, restored only when the caller says the payer's address was not
  // meant to replace the workspace's.
  if (opts.keepBillingAddress === false) {
    const raw = outcome.metadata.prev_billing_address;
    const name = outcome.metadata.prev_billing_name;
    if (raw || name) {
      try {
        await updateBillingProfile(adapter, orgId, {
          ...(raw ? { address: JSON.parse(raw) as BillingAddress } : {}),
          ...(name ? { companyName: name } : {}),
        });
      } catch (e) {
        warnings.push(`billing profile not restored: ${msg(e)}`);
      }
    }
  }

  return result;
}

/**
 * The subscription's current period.
 *
 * On the API version this SDK pins, `current_period_end` lives on the ITEM rather than on the
 * subscription — the same relocation that moved `invoice.subscription`. Reading the old place
 * returns undefined, which reads downstream as "no period known" and quietly turns every
 * cycle-scoped window into a calendar month.
 */
function periodOf(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  const item = sub.items?.data?.[0] as { current_period_start?: number; current_period_end?: number } | undefined;
  const start = item?.current_period_start;
  const end = item?.current_period_end;
  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
