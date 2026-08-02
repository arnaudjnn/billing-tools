"use client";

import { AddressElement, Elements, PaymentElement } from "@stripe/react-stripe-js";
import {
  loadStripe,
  type Appearance,
  type Stripe,
  type StripeElementLocale,
} from "@stripe/stripe-js";
import * as React from "react";

// A standalone billing-address form: Stripe's Address Element, outside any
// payment.
//
// Worth using rather than hand-rolling six inputs, because the element already
// knows what an address looks like in each country — which fields exist, what
// they're called, which are required, how the postcode validates — and offers
// autocomplete as you type. Hand-rolled address forms get this wrong for
// everywhere except the author's own country.
//
// It mounts an Elements group in DEFERRED mode: no client secret, no intent
// created on Stripe, nothing to confirm. The value is reported to the caller,
// who decides when to save it.
//
// ── About the autocomplete ──────────────────────────────────────────────────
// Stripe gives the Address Element free address autocomplete (their own Google
// Maps key) on one documented condition: a Payment Element is rendered in the
// SAME Elements group. Used alone, the element still works but you must bring
// your own Google Maps Places key.
//
// So when no key is supplied, this mounts a Payment Element off-screen purely
// to satisfy that condition. Be honest about what that is: it leans on a
// requirement Stripe words in terms of what you render, and it costs one extra
// iframe and a payment-method-list request. If Stripe ever checks visibility,
// autocomplete quietly stops and manual entry keeps working — the failure mode
// is degradation, not breakage. Pass `googleMapsApiKey` to do it the
// documented way and skip the hidden element entirely.

/** Same shape as `BillingAddress` on the server; declared here so importing the
 *  form never pulls the server entry into a browser bundle. */
export type AddressValue = {
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country: string;
};

const cache = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string): Promise<Stripe | null> {
  let p = cache.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    cache.set(publishableKey, p);
  }
  return p;
}

export function BillingAddressForm({
  publishableKey,
  defaultValue,
  onChange,
  appearance,
  locale,
  /** Label the name line as a person (`full`) rather than an organization.
   *  It is NOT a way to hide the field — Stripe always collects a name. */
  showName = false,
  defaultName,
  googleMapsApiKey,
  currency = "eur",
  className,
}: {
  publishableKey: string;
  defaultValue?: AddressValue | null;
  /**
   * Called on every edit. `null` while the address is incomplete, so a caller
   * can disable Save until Stripe considers it valid for the chosen country.
   *
   * "Incomplete" includes an empty NAME, which is easy to miss: every address
   * field can be filled and this still reports null. Pass `defaultName` so the
   * caller's Save button isn't disabled by a field they never asked for.
   */
  onChange: (address: AddressValue | null) => void;
  appearance?: Appearance;
  locale?: StripeElementLocale;
  showName?: boolean;
  /**
   * Prefill for the name field.
   *
   * Not cosmetic: Stripe ALWAYS collects a name here and will not report the
   * address `complete` until it has one, so a form left with an empty name can
   * never be saved. Pass the name you already hold (the invoice name, the
   * account name) and the field starts satisfied.
   */
  defaultName?: string;
  /**
   * Your own Google Maps Places key. Supplying it is the documented way to get
   * autocomplete standalone, and skips the hidden Payment Element described
   * above.
   */
  googleMapsApiKey?: string;
  /** Required by Stripe for the deferred Elements group. Only used to satisfy
   *  that API — nothing is ever charged here. */
  currency?: string;
  className?: string;
}) {
  const stripe = React.useMemo(() => stripeFor(publishableKey), [publishableKey]);

  // Read through a ref: callers pass inline arrows, and re-rendering the
  // element on every keystroke would fight the user for the caret.
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  const options = React.useMemo(
    () =>
      ({
        mode: "billing" as const,
        display: { name: showName ? ("full" as const) : ("organization" as const) },
        autocomplete: googleMapsApiKey
          ? { mode: "google_maps_api" as const, apiKey: googleMapsApiKey }
          : { mode: "automatic" as const },
        defaultValues: {
          ...(defaultName ? { name: defaultName } : {}),
          ...(defaultValue
            ? {
                address: {
                  line1: defaultValue.line1,
                  line2: defaultValue.line2 ?? undefined,
                  city: defaultValue.city ?? undefined,
                  state: defaultValue.state ?? undefined,
                  postal_code: defaultValue.postal_code ?? undefined,
                  country: defaultValue.country,
                },
              }
            : {}),
        },
      }) as const,
    // Mount-time only, deliberately: rebuilding the options mid-edit remounts
    // the element and wipes what the user has typed. `defaultValue` is a
    // starting point, not a controlled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <Elements
      stripe={stripe}
      options={{
        appearance,
        locale,
        // Deferred: describes an intent's shape without creating one.
        mode: "setup",
        currency,
        paymentMethodCreation: "manual",
      }}
    >
      <div className={className}>
        <AddressElement
          options={options}
          onChange={(e) =>
            onChangeRef.current(e.complete ? (e.value.address as AddressValue) : null)
          }
        />
        {!googleMapsApiKey && (
          // Off-screen rather than display:none — a zero-size or hidden
          // container can stop a Stripe iframe mounting at all, and an
          // unmounted Payment Element wouldn't unlock the autocomplete this is
          // here for. aria-hidden + inert keep it out of the a11y tree and the
          // tab order.
          <div
            aria-hidden
            inert
            style={{
              position: "absolute",
              left: "-9999px",
              top: 0,
              width: "360px",
              height: "360px",
              overflow: "hidden",
              pointerEvents: "none",
            }}
          >
            {/* Decorative preview; matches the real forms' layout. */}
            <PaymentElement options={{ layout: { type: "tabs" } }} />
          </div>
        )}
      </div>
    </Elements>
  );
}
