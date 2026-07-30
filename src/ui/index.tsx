"use client";

import {
  AddressElement,
  Elements,
  PaymentElement,
  TaxIdElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
// The session-bound variants: same elements, but they read and mutate the
// Checkout Session. Aliased where the name collides with the root export above —
// mixing the two families inside one provider renders nothing at all.
import {
  BillingAddressElement,
  CheckoutElementsProvider,
  PaymentElement as CheckoutPaymentElement,
  TaxIdElement as CheckoutTaxIdElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { loadStripe, type Appearance, type Stripe, type StripeElementLocale } from "@stripe/stripe-js";
import * as React from "react";

// The checkout UI, so every consumer app mounts the SAME payment form instead of
// re-deriving one from the Stripe docs.
//
// Imported from a SEPARATE entry point — `@arnaudjnn/billing-tools/ui` — because
// the rest of this package is server-side (WorkOS, Stripe secret key, MCP tools)
// and must never reach a browser bundle. The Stripe BROWSER SDKs
// (@stripe/stripe-js, @stripe/react-stripe-js) are regular dependencies of this
// package, so a consumer app imports `<BillingCheckoutProvider>` from here WITHOUT
// installing Stripe itself — the whole point of centralising checkout here. Only
// `react` stays an (optional) peer, so it resolves to the host app's single
// instance; a CLI/server consumer that never imports `/ui` simply doesn't load
// these modules (they tree-shake out of any non-UI bundle).
//
// The provider owns exactly two things a consumer shouldn't have to rediscover:
// the publishable-key singleton (loadStripe must be called once per page, not
// once per render) and the Elements options shape. Everything money-related still
// happens on the server — this only collects a payment method and confirms an
// intent whose client secret the server minted.

// loadStripe returns a promise and Stripe asks that it be created once. Keyed by
// publishable key so a consumer switching keys (test → live) still gets one
// instance per key rather than one forever.
const stripeCache = new Map<string, Promise<Stripe | null>>();

// The Tax ID Element is in PUBLIC PREVIEW and only loads when Stripe.js is
// instantiated with this beta. It is opted into per-provider rather than always,
// because a beta can change without notice.
const TAX_ID_BETA = "elements_tax_id_1";

function stripeFor(
  publishableKey: string,
  betas?: string[],
  locale?: StripeElementLocale,
): Promise<Stripe | null> {
  // The betas and locale are part of the cache key: loadStripe is memoised per
  // page, so keying on the publishable key alone would let whichever provider
  // mounted FIRST decide both for every later one.
  const key = `${publishableKey}|${(betas ?? []).join(",")}|${locale ?? ""}`;
  const hit = stripeCache.get(key);
  if (hit) return hit;
  const options = { ...(betas?.length ? { betas } : {}), ...(locale ? { locale } : {}) };
  const p = Object.keys(options).length
    ? loadStripe(publishableKey, options)
    : loadStripe(publishableKey);
  stripeCache.set(key, p);
  return p;
}

export type BillingCheckoutProviderProps = {
  /** Stripe publishable key (pk_…). Safe in the browser by design. */
  publishableKey: string;
  /** Client secret of the PaymentIntent/SetupIntent the SERVER created. */
  clientSecret: string;
  /** Stripe Elements appearance, so the form inherits the host app's theme. */
  appearance?: Appearance;
  /** e.g. "it" — defaults to the browser's locale. */
  locale?: StripeElementLocale;
  /**
   * Load the beta that the Tax ID Element needs. Set this on the provider AND
   * pass `collectTaxId` to BillingPaymentForm — the element cannot render unless
   * Stripe.js was instantiated with the beta, so the two go together.
   */
  taxIdBeta?: boolean;
  children: React.ReactNode;
};

/** Wraps Stripe's <Elements> with the bits every consumer would otherwise repeat. */
export function BillingCheckoutProvider({
  publishableKey,
  clientSecret,
  appearance,
  locale,
  taxIdBeta,
  children,
}: BillingCheckoutProviderProps) {
  const stripe = React.useMemo(
    () => stripeFor(publishableKey, taxIdBeta ? [TAX_ID_BETA] : undefined),
    [publishableKey, taxIdBeta],
  );
  return (
    <Elements stripe={stripe} options={{ clientSecret, appearance, locale }}>
      {children}
    </Elements>
  );
}

export type BillingPaymentFormProps = {
  /**
   * Collect a billing address. Required when the subscription was created with
   * automatic_tax: Stripe needs a location to compute VAT, and without it the
   * tax line stays 0 and the total silently disagrees with the summary above.
   */
  collectAddress?: boolean;
  /**
   * Render Stripe's Tax ID Element — the "Business tax ID (Optional)" field with
   * its type selector.
   *
   * Requires `taxIdBeta` on the provider (it is a public-preview feature). Paired
   * with `collectAddress`, Stripe infers the tax ID type and whether to show the
   * field at all from the country, so an Italian customer is offered IT VAT
   * rather than a global list.
   *
   * NOTE: collecting a tax ID does not by itself change what is charged. Reverse
   * charge is applied only when the IDs reach a Stripe Tax calculation — with a
   * fixed tax rate the ID is recorded on the invoice and nothing more.
   */
  collectTaxId?: boolean;
  /** Where Stripe returns the browser after an off-site step (3DS, bank redirect). */
  returnUrl: string;
  /** Rendered as the submit button. Receives the live submitting state. */
  children: (state: { submitting: boolean }) => React.ReactNode;
  /** Called after the intent is confirmed without a redirect. */
  onSuccess?: () => void;
  /** Called with a human-readable message when Stripe declines or validation fails. */
  onError?: (message: string) => void;
  className?: string;
};

/**
 * The card/payment-method form: Stripe's PaymentElement plus confirmation.
 *
 * The button is passed in as a render prop rather than styled here, so the host
 * app's own Button keeps the design system consistent — this component owns the
 * Stripe wiring, not the look.
 *
 * `redirect: "if_required"` keeps the common card case on-page and only leaves
 * for methods that genuinely need it (3DS challenge, bank redirects).
 */
export function BillingPaymentForm({
  collectAddress = false,
  collectTaxId = false,
  returnUrl,
  children,
  onSuccess,
  onError,
  className,
}: BillingPaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    try {
      // Surface field-level problems before touching the intent.
      const submitted = await elements.submit();
      if (submitted.error) {
        onError?.(submitted.error.message ?? "Dati di pagamento non validi");
        return;
      }
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });
      if (error) {
        onError?.(error.message ?? "Pagamento non riuscito");
        return;
      }
      onSuccess?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={className}>
      {collectAddress && <AddressElement options={{ mode: "billing" }} />}
      <PaymentElement />
      {collectTaxId && <TaxIdElement options={{}} />}
      {children({ submitting })}
    </form>
  );
}

export { AddressElement, PaymentElement, TaxIdElement, useElements, useStripe };

// ── Checkout Sessions (elements mode) — the DEFAULT ──────────────────────────
//
// Pairs with `createCheckoutSession` on the server. Same shape as the provider +
// form above, with the difference that makes it the default: the session is live,
// so entering an address recalculates the tax and the page can render STRIPE'S
// total instead of arithmetic it did itself. Two sources of truth for what is
// owed is how a checkout ends up displaying one number and charging another.
//
// The elements come from `@stripe/react-stripe-js/checkout`, not the package
// root: they are the session-bound variants (they read and mutate the session)
// and mixing them with the root ones inside this provider silently renders
// nothing.

/** Amounts as Stripe computed them for the current session. */
export type CheckoutTotals = {
  /** Pre-tax, in the smallest currency unit. */
  subtotalCents: number;
  /** Tax added on top. Zero until Stripe can compute it — see `taxPending`. */
  taxCents: number;
  /** What will actually be charged. */
  totalCents: number;
  /** e.g. "eur". */
  currency: string;
  /** Stripe's own formatted strings, already localised. */
  formatted: { subtotal: string; tax: string; total: string };
  /**
   * Stripe has no location yet, so `taxCents` is not the real tax — the customer
   * hasn't entered an address. Show "calculated at payment" rather than "€0,00".
   */
  taxPending: boolean;
  /** Tax rate Stripe applied, when it computed one (e.g. 22). */
  taxPercent?: number;
};

export type BillingCheckoutSessionProviderProps = {
  /** Stripe publishable key (pk_…). Safe in the browser by design. */
  publishableKey: string;
  /** `clientSecret` from `createCheckoutSession`. Cannot be changed once set —
   *  to price a new basket, create a new session and remount (key on it). */
  clientSecret: string;
  /** Stripe Elements appearance, so the form inherits the host app's theme. */
  appearance?: Appearance;
  /**
   * e.g. "it" — defaults to the browser's locale. In elements mode this is a
   * Stripe.js load-time option, not an Elements one, so it is baked into the
   * cached Stripe instance rather than passed per-provider.
   */
  locale?: StripeElementLocale;
  /**
   * Load the beta the Tax ID Element needs (public preview). Defaults to ON,
   * because `createCheckoutSession` enables tax ID collection by default; pass
   * false to drop the beta along with the element.
   */
  taxIdBeta?: boolean;
  children: React.ReactNode;
};

/** Wraps Stripe's <CheckoutElementsProvider> with the publishable-key singleton
 *  and options shape every consumer would otherwise repeat. */
export function BillingCheckoutSessionProvider({
  publishableKey,
  clientSecret,
  appearance,
  locale,
  taxIdBeta = true,
  children,
}: BillingCheckoutSessionProviderProps) {
  const stripe = React.useMemo(
    () => stripeFor(publishableKey, taxIdBeta ? [TAX_ID_BETA] : undefined, locale),
    [publishableKey, taxIdBeta, locale],
  );
  return (
    <CheckoutElementsProvider
      stripe={stripe}
      options={{ clientSecret, elementsOptions: { appearance } }}
    >
      {children}
    </CheckoutElementsProvider>
  );
}

/**
 * Live totals for the surrounding session, or null while it loads.
 *
 * Call from inside BillingCheckoutSessionProvider — including from the order
 * summary, which is the point: the summary and the payment form then read the
 * same numbers from the same place.
 */
export function useCheckoutTotals(): CheckoutTotals | null {
  const result = useCheckoutElements();
  if (result.type !== "success") return null;
  const { total, taxAmounts, tax, currency } = result.checkout;
  // `taxAmounts` is null (not []) before a location is known, and the status says
  // why. Either way the tax line is not yet real.
  const taxPending =
    tax.status === "requires_billing_address" || taxAmounts === null;
  // Stripe hands each amount over twice: `minorUnitsAmount` is the integer,
  // `amount` is its already-localised display string.
  return {
    subtotalCents: total.subtotal.minorUnitsAmount,
    taxCents: total.taxExclusive.minorUnitsAmount,
    totalCents: total.total.minorUnitsAmount,
    currency,
    formatted: {
      subtotal: total.subtotal.amount,
      tax: total.taxExclusive.amount,
      total: total.total.amount,
    },
    taxPending,
    taxPercent: taxAmounts?.[0]?.percentage,
  };
}

export type BillingCheckoutSessionFormProps = {
  /**
   * Collect a full billing address. ON by default: Stripe Tax needs a location,
   * and `createCheckoutSession` sets `billing_address_collection: "required"`,
   * which this element is what satisfies.
   */
  collectAddress?: boolean;
  /**
   * Render Stripe's Tax ID Element — the "Business tax ID (optional)" field.
   *
   * ON by default, matching `taxIdCollection` on the server. Unlike the
   * fixed-rate path, the ID reaches a real Stripe Tax calculation here, so a valid
   * EU VAT number from another member state actually applies reverse charge.
   *
   * The element is a public preview and is SKIPPED unless the account has been
   * granted it (see `taxIdAvailable` below) — leaving this on costs nothing if it
   * hasn't been. Measured on an account without access: the checkout SDK exposes
   * `createPaymentElement` but `createTaxIdElement` is undefined, WITH the beta
   * flag as well as without it. So a missing tax ID field is account access to
   * request from Stripe, never a client-side option to find.
   */
  collectTaxId?: boolean;
  /**
   * Offer Link — Stripe's one-click wallet, which appears INSIDE the card form as
   * a "save my info for faster checkout" block asking for email, phone and name.
   *
   * OFF by default, to match `createCheckoutSession`'s card-only default. It is a
   * separate switch because Link is not a payment method type: restricting
   * `payment_method_types` to ["card"] does not remove it, so a checkout that
   * asked for card-only was still showing a Link signup and collecting a phone
   * number nobody asked for.
   */
  link?: boolean;
  /** Rendered as the submit button. Receives the live submitting state. */
  children: (state: { submitting: boolean }) => React.ReactNode;
  /** Called once the session is confirmed without a redirect. */
  onSuccess?: () => void;
  /** Called with a human-readable message when Stripe declines or validation fails. */
  onError?: (message: string) => void;
  className?: string;
};

/**
 * The payment form for a Checkout Session: address, payment method, tax ID.
 *
 * The button is passed in as a render prop rather than styled here, so the host
 * app's own Button keeps the design system consistent — this component owns the
 * Stripe wiring, not the look.
 *
 * `redirect: "if_required"` keeps the common card case on-page and only leaves for
 * methods that genuinely need it (3DS challenge, bank redirects); the session's
 * `return_url` is where Stripe comes back to.
 */
export function BillingCheckoutSessionForm({
  collectAddress = true,
  collectTaxId = true,
  link = false,
  children,
  onSuccess,
  onError,
  className,
}: BillingCheckoutSessionFormProps) {
  const result = useCheckoutElements();
  const [submitting, setSubmitting] = React.useState(false);

  // The Tax ID Element is a PUBLIC PREVIEW: Stripe.js only exposes it to accounts
  // that have been granted it, and the beta flag alone doesn't grant it. Rendering
  // it anyway throws `createTaxIdElement is not a function` mid-render and takes
  // the whole payment form down with it, so ask the SDK rather than assume. When
  // it's missing the checkout still works — no tax ID field, and B2B customers
  // enter their VAT number on the invoice side instead.
  const taxIdAvailable =
    result.type === "success" && typeof result.checkout.createTaxIdElement === "function";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (result.type !== "success" || submitting) return;
    setSubmitting(true);
    try {
      // Surface field-level problems before touching the session.
      const validated = await result.checkout.validateElements();
      if (validated.type === "error") {
        onError?.(validated.error.message ?? "Payment details are incomplete");
        return;
      }
      const confirmed = await result.checkout.confirm({ redirect: "if_required" });
      if (confirmed.type === "error") {
        onError?.(confirmed.error.message ?? "Payment failed");
        return;
      }
      onSuccess?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={className}>
      {collectAddress && <BillingAddressElement />}
      <CheckoutPaymentElement
        options={{ wallets: { link: link ? "auto" : "never" } }}
      />
      {collectTaxId && taxIdAvailable && <CheckoutTaxIdElement options={{}} />}
      {children({ submitting })}
    </form>
  );
}

export {
  BillingAddressElement,
  CheckoutElementsProvider,
  CheckoutPaymentElement,
  CheckoutTaxIdElement,
  useCheckoutElements,
};

// ── useCheckout ──────────────────────────────────────────────────────────────
// Owns the subscription LIFECYCLE for an embedded checkout so the consumer app
// writes none of it: as the basket changes it creates the pending subscription,
// then re-prices that same one (createSubscription → updateSubscription), and
// cancels it on unmount (cancelSubscription). Debounced, race-guarded, and
// staleness-gated — the client secret it hands back always matches the CURRENT
// basket, so a stale amount can never be confirmed.
//
// The Stripe calls happen on the server (secret key), so the app passes them as
// `create`/`update`/`cancel` — thin actions over billing-tools' checkout helpers.
// The app owns the UI + copy (its natural home) and just renders from the state
// this returns: wrap the form in <BillingCheckoutProvider clientSecret={…}> once
// `status === "ready"`.

export type CheckoutSync =
  | { ok: true; clientSecret: string; subscriptionId: string }
  | { ok: false; error: string };

export type CheckoutStatus = "idle" | "syncing" | "ready" | "error";

export function useCheckout(opts: {
  /** Identity of the current basket (seats + interval). The hook re-syncs
   *  whenever it changes; the app computes it, so the hook needs no pricing. */
  basket: string;
  /** Create the pending subscription for the current basket. */
  create: () => Promise<CheckoutSync>;
  /** Re-price the existing pending subscription (falls back to create if absent). */
  update?: (subscriptionId: string) => Promise<CheckoutSync>;
  /** Cancel the pending subscription on unmount / abandon. */
  cancel?: (subscriptionId: string) => Promise<void>;
  /** Debounce before syncing, ms. Default 500 (so holding a stepper doesn't
   *  fire per click). */
  debounceMs?: number;
  /** Skip syncing while true — e.g. an empty basket below the minimum. */
  paused?: boolean;
}): {
  clientSecret: string | null;
  subscriptionId: string | null;
  status: CheckoutStatus;
  error: string | null;
} {
  const { basket, create, update, cancel, debounceMs = 500, paused = false } = opts;

  const [state, setState] = React.useState<
    { basket: string; clientSecret: string; subscriptionId: string } | null
  >(null);
  const [status, setStatus] = React.useState<CheckoutStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const latest = React.useRef(0);
  // The live subscription to update/cancel. Kept in a ref so a change mid-flight
  // still targets the right object.
  const subIdRef = React.useRef<string | null>(null);
  if (state) subIdRef.current = state.subscriptionId;

  React.useEffect(() => {
    if (paused) return;
    const ticket = ++latest.current;
    setStatus("syncing");
    setError(null);
    const timer = setTimeout(async () => {
      const existing = subIdRef.current;
      const r = existing && update ? await update(existing) : await create();
      if (ticket !== latest.current) return; // superseded by a newer basket
      if (r.ok) {
        subIdRef.current = r.subscriptionId;
        setState({ basket, clientSecret: r.clientSecret, subscriptionId: r.subscriptionId });
        setStatus("ready");
      } else {
        setError(r.error);
        setStatus("error");
      }
    }, debounceMs);
    return () => clearTimeout(timer);
    // Keyed by the basket it prices; the callbacks are treated as stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basket, paused]);

  // Abandon: cancel the still-pending subscription when the flow unmounts.
  React.useEffect(() => {
    return () => {
      const id = subIdRef.current;
      if (id && cancel) void cancel(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only surface the secret when it matches the CURRENT basket; while a change is
  // in flight the previous secret is withheld (status stays "syncing").
  const current = state?.basket === basket ? state : null;
  return {
    clientSecret: current?.clientSecret ?? null,
    subscriptionId: current?.subscriptionId ?? null,
    status: current ? "ready" : status,
    error,
  };
}
