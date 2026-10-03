// Whether a payment form can be submitted yet — the one decision both forms make, kept
// free of React and Stripe.js so it can be asserted without a browser.
//
// The defect it closes: both forms returned early from `onSubmit` while Stripe was still
// initialising (`!stripe || !elements`, `result.type !== "success"`), so a click on the
// consumer's button did NOTHING — no error, no state, no way for the app to know. Scartoffie
// worked around it by disabling its own button until ready; every other consumer shipped a
// button that silently ignores its first press on a slow network. And a load failure (a bad
// publishable key, a blocked script) left the form in that state for ever, saying nothing.

/** What the render prop receives, beside `submitting`. */
export interface PaymentFormState {
  /** Stripe has loaded and the payment fields are mounted: a submit will be attempted. */
  ready: boolean;
  /** Disable the submit button while true: not ready, already submitting, or broken. */
  disabled: boolean;
  /** Why the form cannot be used — Stripe failed to load or the element did not mount. */
  error: string | null;
}

export interface PaymentFormInputs {
  /** The SDK half: `useStripe()` + `useElements()` returned, or the checkout hook succeeded. */
  sdkReady: boolean;
  /** The Payment Element fired `onReady`. Ignored when `elementRequired` is false. */
  elementReady: boolean;
  /** False when nothing needs mounting — a saved card is being charged. */
  elementRequired: boolean;
  /** A load failure from the SDK or the element, already a human message. */
  loadError: string | null;
  submitting: boolean;
}

export function paymentFormState(i: PaymentFormInputs): PaymentFormState {
  const ready = !i.loadError && i.sdkReady && (!i.elementRequired || i.elementReady);
  return { ready, disabled: !ready || i.submitting, error: i.loadError };
}

/**
 * What a submit should do when it arrives: `null` to go ahead, or the message to report.
 * A submit the form cannot honour is REPORTED through `onError`, never dropped.
 */
export function submitRefusal(
  state: PaymentFormState,
  submitting: boolean,
  messages: { paymentFormNotReady: string },
): string | null {
  if (submitting) return SUBMITTING;
  if (state.error) return state.error;
  if (!state.ready) return messages.paymentFormNotReady;
  return null;
}

/** A second press while the first is in flight: ignored, deliberately, and not an error. */
export const SUBMITTING = "__submitting__";
