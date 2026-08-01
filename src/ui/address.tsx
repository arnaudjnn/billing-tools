"use client";

import { AddressElement, Elements } from "@stripe/react-stripe-js";
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
// It mounts an Elements group with NO client secret: nothing is being paid or
// set up here, so there is no intent to confirm. The value is reported to the
// caller, who decides when to save it.

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
  /** Prefilled name line. Stripe requires one when `display.name` is shown; it
   *  is hidden by default here because the invoice name is its own field. */
  showName = false,
  className,
}: {
  publishableKey: string;
  defaultValue?: AddressValue | null;
  /**
   * Called on every edit. `null` while the address is incomplete, so a caller
   * can disable Save until Stripe considers it valid for the chosen country.
   */
  onChange: (address: AddressValue | null) => void;
  appearance?: Appearance;
  locale?: StripeElementLocale;
  showName?: boolean;
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
        autocomplete: { mode: "automatic" as const },
        ...(defaultValue
          ? {
              defaultValues: {
                address: {
                  line1: defaultValue.line1,
                  line2: defaultValue.line2 ?? undefined,
                  city: defaultValue.city ?? undefined,
                  state: defaultValue.state ?? undefined,
                  postal_code: defaultValue.postal_code ?? undefined,
                  country: defaultValue.country,
                },
              },
            }
          : {}),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time only: re-keying the element mid-edit resets the fields
      }) as const,
    [],
  );

  return (
    <Elements stripe={stripe} options={{ appearance, locale }}>
      <div className={className}>
        <AddressElement
          options={options}
          onChange={(e) =>
            onChangeRef.current(e.complete ? (e.value.address as AddressValue) : null)
          }
        />
      </div>
    </Elements>
  );
}
