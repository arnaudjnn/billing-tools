"use client";

import {
  AddressElement,
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
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

function stripeFor(publishableKey: string): Promise<Stripe | null> {
  const hit = stripeCache.get(publishableKey);
  if (hit) return hit;
  const p = loadStripe(publishableKey);
  stripeCache.set(publishableKey, p);
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
  children: React.ReactNode;
};

/** Wraps Stripe's <Elements> with the bits every consumer would otherwise repeat. */
export function BillingCheckoutProvider({
  publishableKey,
  clientSecret,
  appearance,
  locale,
  children,
}: BillingCheckoutProviderProps) {
  const stripe = React.useMemo(() => stripeFor(publishableKey), [publishableKey]);
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
      {children({ submitting })}
    </form>
  );
}

export { AddressElement, PaymentElement, useElements, useStripe };
