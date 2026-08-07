import { getStripe } from "./billing.js";
import { defaultPaymentMethodConfig } from "./payment-method-config.js";
import type { BillingAdapter, BillingConfig } from "./types.js";

// Saved cards for an organization: list, add, promote, remove.
//
// The Stripe Billing Portal covers this too, but it is a hosted page on
// Stripe's domain with Stripe's chrome. These primitives let an app keep card
// management inside its own settings UI, which is where users look for it.
//
// "Default" here means the customer's `invoice_settings.default_payment_method`
// — what future invoices actually charge. Stripe also has a legacy
// `default_source`; it is not consulted, because everything this package
// creates is a PaymentMethod.

export type SavedCard = {
  id: string;
  /** "visa" | "mastercard" | "amex" | … as Stripe reports it. */
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** "credit" | "debit" | "prepaid" | "unknown" — Stripe's funding type. */
  funding: string;
  /** Charged by future invoices. */
  isDefault: boolean;
  /** Two-letter country of the billing address, when one was collected. */
  country: string | null;
};

/** The customer id for an org, or null when billing was never started. */
async function customerFor(adapter: BillingAdapter, orgId: string): Promise<string | null> {
  return adapter.getBillingCustomerId(orgId);
}

/**
 * Cards saved against the org's customer, default first.
 *
 * Returns an empty array (never throws) when the org has no Stripe customer
 * yet, which is the normal state for a workspace that has never paid.
 */
export async function listPaymentMethods(
  adapter: BillingAdapter,
  orgId: string,
): Promise<SavedCard[]> {
  const customerId = await customerFor(adapter, orgId);
  if (!customerId) return [];

  const stripe = getStripe();
  const [customer, methods] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }),
  ]);

  const defaultId =
    customer.deleted !== true
      ? typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : (customer.invoice_settings?.default_payment_method?.id ?? null)
      : null;

  const cards = methods.data.flatMap<SavedCard>((pm) => {
    if (!pm.card) return [];
    return [
      {
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
        funding: pm.card.funding,
        isDefault: pm.id === defaultId,
        country: pm.billing_details?.address?.country ?? null,
      },
    ];
  });

  // Default first, then newest — Stripe lists by creation date descending.
  return cards.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/**
 * A SetupIntent for adding a card without charging it.
 *
 * `usage: "off_session"` is what makes the saved card usable for later
 * invoices; with the default (`on_session`) a renewal would fail
 * authentication with nobody there to complete it.
 *
 * Needs an existing customer — call `ensureStripeCustomer` first if the org
 * might not have one.
 */
export async function createCardSetupIntent(
  adapter: BillingAdapter,
  orgId: string,
  opts: {
    /**
     * A payment-method configuration id (see `ensurePaymentMethodConfig`).
     *
     * The ONLY way to keep Link out of this form. `payment_method_types: ["card"]`
     * removes Link as a payment METHOD but not its inline signup ("Save my info
     * for faster checkout"), which the Payment Element draws from the account's
     * Link setting. Mutually exclusive with `payment_method_types`, so passing
     * this replaces it.
     *
     * Omit it and the library provisions its own (card + the wallets, no Link) —
     * `defaultPaymentMethodConfig`. Pass one only to offer something else.
     */
    paymentMethodConfiguration?: string;
    /** Config, read for `paymentMethods.link`. */
    config?: BillingConfig;
  } = {},
): Promise<{ clientSecret: string; customerId: string }> {
  const customerId = await customerFor(adapter, orgId);
  if (!customerId) throw new Error("No billing customer for this organization");

  // Defaulted rather than left to the caller: every app that mounts this form
  // wants the same thing (a card, the wallets, no Link), and the one lever that
  // achieves it is obscure enough that leaving it out meant every consumer
  // shipped the Link signup by accident.
  const pmc =
    opts.paymentMethodConfiguration ??
    (await defaultPaymentMethodConfig("setup", opts.config));

  const intent = await getStripe().setupIntents.create({
    customer: customerId,
    usage: "off_session",
    // NOTE `allow_redisplay` cannot be set here: it is a confirm-time field on
    // `payment_method_data`, and confirmation happens in the browser. A card saved
    // through this intent therefore comes back `unspecified`, which is why
    // `createCreditCheckoutSession` includes that value in its
    // `allow_redisplay_filters` — filtering to `always` hid cards this library had
    // just saved.
    ...(pmc
      ? {
          payment_method_configuration: pmc,
          automatic_payment_methods: { enabled: true },
        }
      : { payment_method_types: ["card"] }),
  });
  if (!intent.client_secret) throw new Error("Stripe returned no client secret");
  return { clientSecret: intent.client_secret, customerId };
}

/**
 * A Checkout Session in `mode: "setup"` — saves a card, charges nothing.
 *
 * Same job as `createCardSetupIntent`, different UI. A SetupIntent is mounted with
 * `BillingPaymentForm`, which renders Stripe's plain `AddressElement`: six prefilled
 * address inputs. A Checkout Session is mounted with `BillingCheckoutSessionForm`,
 * which renders `BillingAddressElement` — the collapsed "name / street / city"
 * summary with a change link, and the saved cards the customer already has. That
 * collapsed box CANNOT be had from the SetupIntent path at any configuration, so a
 * surface that must look like the subscription checkout or a top-up has to be a
 * session. Use this one there, and `createCardSetupIntent` for a plain
 * "add a card" screen where matching a payment flow doesn't matter.
 *
 * `currency` is required by Stripe in setup mode before it will offer the wallets —
 * a session without it silently drops Apple Pay and Google Pay.
 *
 * Returns the id as well as the secret, because a setup session carries its result
 * in a SetupIntent the browser never sees: read the saved card back with
 * `savedCardFromCheckoutSession(sessionId)` once the form confirms.
 */
export async function createCardSetupCheckoutSession(
  adapter: BillingAdapter,
  orgId: string,
  opts: {
    /** Where Stripe returns after an off-site step (3DS). Must be absolute. */
    returnUrl: string;
    /** Three-letter code. Needed for the wallets — see above. */
    currency: string;
    paymentMethodConfiguration?: string;
    config?: BillingConfig;
  },
): Promise<{ clientSecret: string; sessionId: string }> {
  const customerId = await customerFor(adapter, orgId);
  if (!customerId) throw new Error("No billing customer for this organization");

  const pmc =
    opts.paymentMethodConfiguration ??
    (await defaultPaymentMethodConfig("setup", opts.config));

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: "setup",
    currency: opts.currency,
    // `custom` on this API version; the response echoes back `elements`. Same note
    // as createCheckoutSession — a newer version renames it.
    ui_mode: "custom" as "custom",
    return_url: opts.returnUrl,
    // Collect the address, so the session carries one and the element renders its
    // collapsed summary rather than empty fields.
    billing_address_collection: "required",
    // NO `saved_payment_method_options` here, unlike the payment-mode sessions:
    // Stripe rejects it outright — "`saved_payment_method_options` may not be
    // specified in setup mode" — and it would have nothing to do anyway. Setup mode
    // does not prefill or offer existing cards; it exists to collect a new one. A
    // caller with a card already on file should not be opening this session at all.
    ...(pmc ? { payment_method_configuration: pmc } : {}),
  });
  if (!session.client_secret) throw new Error("Stripe returned no client secret");
  return { clientSecret: session.client_secret, sessionId: session.id };
}

/**
 * The card a confirmed setup session saved, or null if it saved none.
 *
 * The browser only learns that confirmation succeeded, so the id has to be read
 * here — from the session's SetupIntent, not by listing the customer's cards and
 * taking the newest, which is a race the moment two tabs are open.
 */
export async function savedCardFromCheckoutSession(
  sessionId: string,
): Promise<string | null> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ["setup_intent"],
  });
  const intent = session.setup_intent;
  if (!intent || typeof intent === "string") return null;
  const pm = intent.payment_method;
  return typeof pm === "string" ? pm : (pm?.id ?? null);
}

/** Assert the card belongs to this org's customer before acting on its id. */
async function assertOwned(
  adapter: BillingAdapter,
  orgId: string,
  paymentMethodId: string,
): Promise<void> {
  const customerId = await customerFor(adapter, orgId);
  if (!customerId) throw new Error("No billing customer for this organization");
  const pm = await getStripe().paymentMethods.retrieve(paymentMethodId);
  const owner = typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
  // A payment-method id reaching this from a client is untrusted input: without
  // this check one org could promote or detach another's card.
  if (owner !== customerId) throw new Error("Payment method not found");
}

/** Make a saved card the one future invoices charge. */
export async function setDefaultPaymentMethod(
  adapter: BillingAdapter,
  orgId: string,
  paymentMethodId: string,
): Promise<void> {
  await assertOwned(adapter, orgId, paymentMethodId);
  const customerId = await customerFor(adapter, orgId);
  await getStripe().customers.update(customerId as string, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

/**
 * Remove a saved card.
 *
 * Refuses to remove the default while another card exists, because Stripe does
 * not promote a replacement — the customer would silently be left with cards on
 * file and no default, and the next invoice would fail. Removing the LAST card
 * is allowed: that is a deliberate "I'm done here", not an accident.
 */
export async function detachPaymentMethod(
  adapter: BillingAdapter,
  orgId: string,
  paymentMethodId: string,
): Promise<void> {
  await assertOwned(adapter, orgId, paymentMethodId);
  const cards = await listPaymentMethods(adapter, orgId);
  const target = cards.find((c) => c.id === paymentMethodId);
  if (target?.isDefault && cards.length > 1) {
    throw new Error("Set another card as default before removing this one");
  }
  await getStripe().paymentMethods.detach(paymentMethodId);
}

/** Our own last-used stamp on the PaymentMethod. Stripe carries `created` and no usage
 *  field at all, so nothing records this unless we do. */
const LAST_USED_KEY = "last_used_at";

/**
 * Record that a card was just charged.
 *
 * Written to the PaymentMethod's own metadata rather than a table: it is a fact about the
 * card, it survives every path that charges one (an app, the dashboard, a future service),
 * and it cannot drift from the card's lifetime — a detached card takes its stamp with it.
 */
export async function touchPaymentMethod(paymentMethodId: string): Promise<void> {
  await getStripe().paymentMethods.update(paymentMethodId, {
    metadata: { [LAST_USED_KEY]: new Date().toISOString() },
  });
}

/**
 * How many cards a customer keeps, by default.
 *
 * Not a Stripe limit — measured: 105 cards attached to one customer with no error. It is a
 * product rule, to keep the list a list, and Stripe's own list call pages at 100, so an
 * unbounded list would need pagination to stay honest. Override per deployment with
 * `config.paymentMethods.maxCards`.
 */
export const DEFAULT_MAX_CARDS = 3;

/**
 * Keep the newest cards and drop the stalest, so paying with a new card does not need the
 * customer to go and delete an old one first.
 *
 * WHICH card goes: the LEAST recently used one that is not the default. Least recently used,
 * not most — the point is to evict the card nobody reaches for. Ranked by the `last_used_at`
 * stamp `touchPaymentMethod` writes, falling back to Stripe's `created` for a card never
 * charged, so a never-used card is always evicted before a used one.
 *
 * The DEFAULT is never evicted at any count: it is what every invoice and every auto-reload
 * charges, and dropping it would leave a customer with cards on file and no way to bill them.
 *
 * Returns the ids actually detached — the caller decides whether to mention it.
 */
export async function prunePaymentMethods(
  adapter: BillingAdapter,
  orgId: string,
  max: number = DEFAULT_MAX_CARDS,
): Promise<string[]> {
  const cards = await listPaymentMethods(adapter, orgId);
  if (cards.length <= max) return [];

  const stripe = getStripe();
  // The full objects, for the timestamps `SavedCard` does not carry.
  const detailed = await Promise.all(
    cards.map(async (c) => {
      const pm = await stripe.paymentMethods.retrieve(c.id);
      const stamp = pm.metadata?.[LAST_USED_KEY];
      const usedAt = stamp ? Date.parse(stamp) : NaN;
      return {
        id: c.id,
        isDefault: c.isDefault,
        // Never-used cards sort oldest via `created`, which is always < now.
        rank: Number.isFinite(usedAt) ? usedAt : pm.created * 1000,
      };
    }),
  );

  const doomed = detailed
    .filter((c) => !c.isDefault)
    .sort((a, b) => a.rank - b.rank) // stalest first
    .slice(0, cards.length - max);

  for (const c of doomed) await detachPaymentMethod(adapter, orgId, c.id);
  return doomed.map((c) => c.id);
}

/**
 * The FIRST card a customer saves becomes the default, asked for or not.
 *
 * Not a convenience: a customer with exactly one card and no default has a card on file
 * and nothing to charge — every invoice and every auto-reload reads the default, so the
 * quiet failure is a payment that never happens. Saving a second card changes nothing
 * unless `setDefault` says so.
 */
export async function attachedPaymentMethod(
  adapter: BillingAdapter,
  orgId: string,
  paymentMethodId: string,
  opts: { setDefault?: boolean } = {},
): Promise<{ madeDefault: boolean }> {
  const existing = await listPaymentMethods(adapter, orgId);
  const isOnlyCard = existing.filter((c) => c.id !== paymentMethodId).length === 0;
  const madeDefault = opts.setDefault === true || isOnlyCard;
  if (madeDefault) await setDefaultPaymentMethod(adapter, orgId, paymentMethodId);
  return { madeDefault };
}
