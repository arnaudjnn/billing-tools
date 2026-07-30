import type Stripe from "stripe";
import { getStripe } from "./billing.js";
import { ensurePlans, lookupKeyFor, planPriceId } from "./plans.js";
import type { BillingInterval, PlansConfig } from "./plans.js";

// Server side of the embedded checkout: turn "these seats, this interval" into
// something the browser can pay, and hand back the client secret that
// `@arnaudjnn/billing-tools/ui` mounts against.
//
// Two paths, and the FIRST is the default:
//
//   createCheckoutSession — a Checkout Session in elements mode. Stripe Tax
//     computes the tax from the address the customer enters. Use this.
//   createSubscription — a `default_incomplete` subscription, with tax either a
//     fixed rate you pass or an address the customer already has. Older, still
//     supported, and the only option if you need to price a basket entirely
//     server-side.
//
// Why this lives here rather than in each app: the sequence has four steps that
// are easy to get subtly wrong (ensure prices exist → resolve them by lookup key
// → create/reuse the customer → create the payable object WITHOUT charging), and
// getting the last one wrong means either charging immediately or creating
// something that can never be paid.
//
// Deliberately customer-first, not org-first (unlike startSubscriptionForOrg):
// a signup flow that collects payment BEFORE provisioning has no org yet. The
// caller provisions on success and stores the returned customer id then.

export type Quantities = Record<string, number>;

// ── Checkout Sessions (the DEFAULT path) ─────────────────────────────────────
//
// A Checkout Session in elements mode (`ui_mode: "custom"`) is what a seat
// checkout should use, and `createCheckoutSession` below is the entry point.
// `createSubscription` further down is the older PaymentIntent-style path, kept
// for integrations that already ship it.
//
// The reason is tax. A subscription created `default_incomplete` must know its
// total BEFORE the customer types anything, so tax can only be a rate you picked
// in advance — one country, no reverse charge, wrong the moment someone buys from
// another member state. A Checkout Session inverts that: the session is a live
// object the browser mutates (address → tax recalculated → new total), so Stripe
// Tax computes the real rate for the real customer and the UI renders Stripe's
// numbers instead of its own arithmetic.
//
// What it costs: Stripe Tax must be set up on the account (`Tax > Registrations`
// per jurisdiction, and a head office). With no registration Stripe computes ZERO
// tax rather than erroring — the total silently drops to the pre-tax amount, so
// verify a registration exists before trusting the figures.
//
// The prices must also carry an explicit `tax_behavior` (ensurePlans sets
// `exclusive`); Stripe Tax refuses to calculate on `unspecified`.

export type CheckoutSessionResult = {
  sessionId: string;
  customerId: string;
  /** Pass to BillingCheckoutSessionProvider. Null only if Stripe returned none. */
  clientSecret: string | null;
};

/**
 * Create a seat Checkout Session whose tax Stripe calculates itself.
 *
 * Nothing is charged and no subscription exists yet: the session is an open
 * basket the browser confirms. Read the result with `checkoutSessionOutcome`
 * afterwards — never trust the client's word that payment happened.
 *
 * Quantities of 0 are dropped rather than sent (Stripe rejects a zero-quantity
 * line, and "no Premium seats" must mean "no Premium line").
 */
export async function createCheckoutSession(opts: {
  plans: PlansConfig;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  /** Where Stripe returns the browser after an off-site step (3DS, bank app). */
  returnUrl: string;
  /** Reuse an existing customer, else one is created from `email`. */
  customerId?: string;
  email?: string;
  currency?: string;
  /** Stripe Tax. On by default — the whole point of this path. */
  automaticTax?: boolean;
  /** Collect a business tax ID (VAT number). On by default. */
  taxIdCollection?: boolean;
  /**
   * Which payment methods the form offers. Defaults to CARD ONLY — no Link,
   * Klarna, wallets — because that's what most subscription checkouts want, and
   * Checkout otherwise shows every method enabled on the account. Pass a list to
   * add methods (e.g. ["card", "klarna"]) or "automatic" to defer to the
   * account's dashboard settings.
   */
  paymentMethods?: string[] | "automatic";
  metadata?: Record<string, string>;
}): Promise<CheckoutSessionResult> {
  const stripe = getStripe();

  const wanted = Object.entries(opts.seats).filter(([, qty]) => qty > 0);
  if (wanted.length === 0) throw new Error("No seats selected");

  // Idempotent: creates the managed products/prices the first time a seat type is
  // ever sold, and is a no-op afterwards.
  await ensurePlans(opts.plans, { currency: opts.currency });

  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  for (const [seatType, quantity] of wanted) {
    const price = await planPriceId(opts.plan, opts.interval, seatType);
    if (!price) {
      throw new Error(
        `No Stripe price for ${lookupKeyFor(opts.plan, opts.interval, seatType)}`,
      );
    }
    line_items.push({ price, quantity });
  }

  const customerId =
    opts.customerId ??
    (await stripe.customers.create({ email: opts.email, metadata: opts.metadata })).id;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    // Elements mode: Stripe hosts no page, we mount the elements and own the
    // layout. The value was RENAMED "custom" → "elements"; the pinned SDK still
    // sends "custom" (and its types only allow that), and the API accepts it and
    // echoes back `ui_mode: "elements"`. A newer API version rejects it outright —
    // "The ui_mode value `custom` is no longer supported. Use `elements` instead."
    // So when the stripe dependency is bumped, this line changes with it.
    ui_mode: "custom",
    line_items,
    customer: customerId,
    // Writes the address (and business name) the customer types onto the Customer.
    // Without it the typed address stays on the session, so Stripe Tax has no
    // location for the customer and the tax is computed as zero. Required
    // whenever `customer` is passed rather than `customer_email`.
    customer_update: { address: "auto", name: "auto" },
    automatic_tax: { enabled: opts.automaticTax ?? true },
    tax_id_collection: { enabled: opts.taxIdCollection ?? true },
    // A full address, collected by the billing-address element. The alternative
    // ("auto", country + postal code inside the payment element) is enough for
    // tax in most places but not everywhere, and an invoice wants the real thing.
    billing_address_collection: "required",
    return_url: opts.returnUrl,
    ...(opts.paymentMethods === "automatic"
      ? {}
      : { payment_method_types: (opts.paymentMethods ?? ["card"]) as Stripe.Checkout.SessionCreateParams.PaymentMethodType[] }),
    // Metadata on BOTH: the session is the checkout attempt, the subscription is
    // what outlives it, and reconciliation reads the subscription.
    metadata: opts.metadata,
    subscription_data: { metadata: opts.metadata },
  });

  return {
    sessionId: session.id,
    customerId,
    clientSecret: session.client_secret,
  };
}

/**
 * What actually happened, read from Stripe.
 *
 * The server-side proof of payment: a caller could post any session id, so the
 * subscription is required to be live as well as the session complete.
 */
export async function checkoutSessionOutcome(sessionId: string): Promise<{
  paid: boolean;
  subscriptionId: string | null;
  customerId: string | null;
}> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });
  const subscription = session.subscription as Stripe.Subscription | null;
  return {
    paid:
      session.status === "complete" &&
      (subscription?.status === "active" || subscription?.status === "trialing"),
    subscriptionId: subscription?.id ?? null,
    customerId:
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null),
  };
}

/** Close an abandoned session. Idempotent: one already completed or expired is
 *  left as-is. Optional — Stripe expires open sessions by itself (~24h) and an
 *  unconfirmed session has created nothing. */
export async function expireCheckoutSession(sessionId: string): Promise<void> {
  try {
    await getStripe().checkout.sessions.expire(sessionId);
  } catch {
    /* already complete / expired — nothing to close */
  }
}

export type SubscriptionResult = {
  subscriptionId: string;
  customerId: string;
  /** Pass to BillingCheckoutProvider. Null only if Stripe returned no intent. */
  clientSecret: string | null;
};

/**
 * Create a subscription for `seats` that is awaiting its first payment.
 *
 * Prefer `createCheckoutSession` — it lets Stripe Tax calculate the tax from the
 * address the customer enters, which this path structurally cannot do (the total
 * is fixed before the form is shown). Keep using this one only when the basket
 * must be priced entirely server-side.
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
  /**
   * Which payment methods the form offers. Defaults to CARD ONLY — no Link,
   * Klarna, wallets — because that's what most subscription checkouts want, and
   * Stripe otherwise shows every method enabled on the account. The developer
   * never sees the others unless they opt in: pass a list to add methods
   * (e.g. ["card", "klarna"]) or "automatic" to defer to the account's dashboard.
   */
  paymentMethods?: string[] | "automatic";
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
    payment_settings: {
      save_default_payment_method: "on_subscription",
      // Card-only by default; setting the types is what suppresses Link/Klarna/
      // wallets. An explicit list overrides; "automatic" defers to the account.
      ...(opts.paymentMethods === "automatic"
        ? {}
        : {
            payment_method_types: (opts.paymentMethods ??
              ["card"]) as Stripe.SubscriptionCreateParams.PaymentSettings.PaymentMethodType[],
          }),
    },
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
