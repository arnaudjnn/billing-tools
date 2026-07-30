"use client";

import {
  AddressElement,
  Elements,
  PaymentElement,
  TaxIdElement,
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

// The Tax ID Element is in PUBLIC PREVIEW and only loads when Stripe.js is
// instantiated with this beta. It is opted into per-provider rather than always,
// because a beta can change without notice.
const TAX_ID_BETA = "elements_tax_id_1";

function stripeFor(publishableKey: string, betas?: string[]): Promise<Stripe | null> {
  // The betas are part of the cache key: loadStripe is memoised per page, so
  // keying on the publishable key alone would let whichever provider mounted
  // FIRST decide whether the beta is active for every later one.
  const key = `${publishableKey}|${(betas ?? []).join(",")}`;
  const hit = stripeCache.get(key);
  if (hit) return hit;
  const p = betas?.length
    ? loadStripe(publishableKey, { betas })
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
