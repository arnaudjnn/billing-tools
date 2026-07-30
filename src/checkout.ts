import type Stripe from "stripe";
import { getStripe } from "./billing.js";
import { ensurePlans, lookupKeyFor, planPriceId } from "./plans.js";
import type { BillingInterval, PlansConfig } from "./plans.js";

// Server side of the embedded checkout: turn "these seats, this interval" into a
// subscription whose first payment is still pending, and hand back the client
// secret that `@arnaudjnn/billing-tools/ui` mounts Elements against.
//
// Why this lives here rather than in each app: the sequence has four steps that
// are easy to get subtly wrong (ensure prices exist → resolve them by lookup key
// → create/reuse the customer → create the subscription INCOMPLETE and expand the
// intent), and getting the last one wrong means either charging immediately or
// creating a subscription that can never be paid.
//
// Deliberately customer-first, not org-first (unlike startSubscriptionForOrg):
// a signup flow that collects payment BEFORE provisioning has no org yet. The
// caller provisions on success and stores the returned customer id then.

export type Quantities = Record<string, number>;

export type SubscriptionResult = {
  subscriptionId: string;
  customerId: string;
  /** Pass to BillingCheckoutProvider. Null only if Stripe returned no intent. */
  clientSecret: string | null;
};

/**
 * Create a subscription for `seats` that is awaiting its first payment.
 *
 * `payment_behavior: "default_incomplete"` is the crux: Stripe creates the
 * subscription and the invoice but does NOT charge, leaving a PaymentIntent whose
 * client secret the browser confirms. Without it Stripe would attempt payment
 * server-side and fail for any card needing SCA.
 *
 * Quantities of 0 are dropped rather than sent — Stripe rejects a zero-quantity
 * line, and "no Premium seats" must mean "no Premium line".
 */
export async function createSubscription(opts: {
  plans: PlansConfig;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  /** Reuse an existing customer, else one is created from `email`. */
  customerId?: string;
  email?: string;
  currency?: string;
  /**
   * Let Stripe compute the tax itself (Stripe Tax).
   *
   * CAVEAT: this requires the customer to ALREADY have a recognised address when
   * the subscription is created — "The customer's location isn't recognized" —
   * which a pay-then-provision flow doesn't have, because the address is
   * collected by the form that the client secret mounts. Use it only when you
   * collect a country BEFORE calling this; otherwise use `vat` below.
   */
  automaticTax?: boolean;
  /**
   * Apply a FIXED tax rate instead, so the invoice total matches a figure the UI
   * already showed. Deterministic and needs no address up front, which is what a
   * signup checkout needs; the trade is that it applies the same rate to
   * everyone, so it's right for a single-country product and wrong for
   * cross-border B2B (no reverse charge). Move to Stripe Tax once you collect the
   * country first.
   */
  vat?: { percent: number; country: string; displayName?: string };
  metadata?: Record<string, string>;
}): Promise<SubscriptionResult> {
  const stripe = getStripe();

  const wanted = Object.entries(opts.seats).filter(([, qty]) => qty > 0);
  if (wanted.length === 0) throw new Error("No seats selected");

  // Idempotent: creates the managed products/prices the first time a seat type is
  // ever sold, and is a no-op afterwards.
  await ensurePlans(opts.plans, { currency: opts.currency });

  const items: Stripe.SubscriptionCreateParams.Item[] = [];
  for (const [seatType, quantity] of wanted) {
    const price = await planPriceId(opts.plan, opts.interval, seatType);
    if (!price) {
      throw new Error(
        `No Stripe price for ${lookupKeyFor(opts.plan, opts.interval, seatType)}`,
      );
    }
    items.push({ price, quantity });
  }

  const customerId =
    opts.customerId ??
    (await stripe.customers.create({ email: opts.email, metadata: opts.metadata })).id;

  // Reuse a matching rate rather than creating one per checkout: Stripe tax
  // rates are immutable and accumulate forever otherwise.
  let defaultTaxRates: string[] | undefined;
  if (opts.vat) {
    const { percent, country, displayName } = opts.vat;
    const existing = (await stripe.taxRates.list({ active: true, limit: 100 })).data.find(
      (r) => r.percentage === percent && r.country === country && r.inclusive === false,
    );
    defaultTaxRates = [
      existing?.id ??
        (
          await stripe.taxRates.create({
            display_name: displayName ?? "VAT",
            percentage: percent,
            country,
            inclusive: false,
          })
        ).id,
    ];
  }

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items,
    payment_behavior: "default_incomplete",
    // Keep the card on file, so renewals don't re-prompt.
    payment_settings: { save_default_payment_method: "on_subscription" },
    ...(opts.automaticTax ? { automatic_tax: { enabled: true } } : {}),
    ...(defaultTaxRates ? { default_tax_rates: defaultTaxRates } : {}),
    metadata: opts.metadata,
    // `confirmation_secret`, not the older `latest_invoice.payment_intent`: on
    // current Stripe API versions the invoice exposes the secret directly and the
    // payment_intent field is gone.
    expand: ["latest_invoice.confirmation_secret"],
  });

  const invoice = subscription.latest_invoice as Stripe.Invoice | null;

  return {
    subscriptionId: subscription.id,
    customerId,
    clientSecret: invoice?.confirmation_secret?.client_secret ?? null,
  };
}

/**
 * Re-price an EXISTING still-incomplete subscription for a new basket.
 *
 * The alternative — create a fresh subscription every time the seat count or
 * interval changes — litters Stripe with abandoned incompletes (cleared only by
 * ~23h auto-expiry). Updating the one subscription in place keeps a single object
 * per checkout session: the draft invoice is re-priced and Stripe mints a new
 * confirmation secret for the browser to confirm.
 *
 * `proration_behavior: "none"` because nothing has been paid yet — there is no
 * prior amount to prorate against, only a draft to overwrite.
 */
export async function updateSubscription(opts: {
  subscriptionId: string;
  plans: PlansConfig;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  currency?: string;
}): Promise<{ subscriptionId: string; clientSecret: string | null }> {
  const stripe = getStripe();

  const wanted = Object.entries(opts.seats).filter(([, qty]) => qty > 0);
  if (wanted.length === 0) throw new Error("No seats selected");

  await ensurePlans(opts.plans, { currency: opts.currency });

  // Desired priceId → quantity for the new basket.
  const desired = new Map<string, number>();
  for (const [seatType, quantity] of wanted) {
    const price = await planPriceId(opts.plan, opts.interval, seatType);
    if (!price) {
      throw new Error(
        `No Stripe price for ${lookupKeyFor(opts.plan, opts.interval, seatType)}`,
      );
    }
    desired.set(price, quantity);
  }

  // Diff against the live items: bump quantities, delete removed lines, add new.
  const sub = await stripe.subscriptions.retrieve(opts.subscriptionId);
  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  const seen = new Set<string>();
  for (const it of sub.items.data) {
    const priceId = it.price.id;
    const quantity = desired.get(priceId);
    if (quantity != null) {
      items.push({ id: it.id, quantity });
      seen.add(priceId);
    } else {
      items.push({ id: it.id, deleted: true });
    }
  }
  for (const [priceId, quantity] of desired) {
    if (!seen.has(priceId)) items.push({ price: priceId, quantity });
  }

  const updated = await stripe.subscriptions.update(opts.subscriptionId, {
    items,
    proration_behavior: "none",
    payment_behavior: "default_incomplete",
    expand: ["latest_invoice.confirmation_secret"],
  });

  const invoice = updated.latest_invoice as Stripe.Invoice | null;
  return {
    subscriptionId: updated.id,
    clientSecret: invoice?.confirmation_secret?.client_secret ?? null,
  };
}

/** Cancel an abandoned still-incomplete subscription. Idempotent: a subscription
 *  that is already gone (or was paid in the meantime) is left as-is. */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch {
    /* already canceled / not cancelable — nothing to clean up */
  }
}
