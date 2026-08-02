"use client";

import { resolveMessages, type PartialMessages } from "../i18n.js";
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
import {
  loadStripe,
  type Appearance,
  type Stripe,
  type StripeCheckoutTaxIdType,
  type StripeElementLocale,
} from "@stripe/stripe-js";
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

/**
 * Start loading Stripe.js NOW, before there is a client secret to mount.
 *
 * Nothing about the SDK depends on the session, but the provider is what
 * normally triggers the download — so the ~400ms of script + iframes is spent
 * AFTER the server round trip that created the session, one after the other,
 * with the customer watching. Called on mount (an effect, or the module scope of
 * a client component) it overlaps with that round trip instead.
 *
 * Idempotent and cached, so calling it and then rendering the provider loads
 * Stripe once — pass the same `locale`/`taxIdBeta` the provider will use, or the
 * warm instance won't be the one it asks for.
 */
export function preloadStripe(
  publishableKey: string,
  opts: { locale?: StripeElementLocale; taxIdBeta?: boolean } = {},
): void {
  const { locale, taxIdBeta = true } = opts;
  void stripeFor(publishableKey, taxIdBeta ? [TAX_ID_BETA] : undefined, locale);
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
  /**
   * Overrides for the few words this form supplies itself. English by default —
   * this package ships English only. Stripe's own error messages already follow
   * the Elements locale, so these are only the no-message fallback.
   */
  messages?: PartialMessages;
  /**
   * What the client secret refers to. `"setup"` saves a card for later without
   * charging it — a SetupIntent — which is what an "add a card" screen needs;
   * `"payment"` (the default) takes the money now.
   *
   * It has to be told: a PaymentIntent and a SetupIntent are confirmed by
   * different Stripe calls, and the form is given the secret by its provider
   * rather than holding it.
   */
  intent?: "payment" | "setup";
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
  intent = "payment",
  messages,
  children,
  onSuccess,
  onError,
  className,
}: BillingPaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = React.useState(false);
  const t = resolveMessages(messages);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    try {
      // Surface field-level problems before touching the intent.
      const submitted = await elements.submit();
      if (submitted.error) {
        onError?.(submitted.error.message ?? t.paymentDetailsInvalid);
        return;
      }
      const confirmArgs = {
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required" as const,
      };
      const { error } =
        intent === "setup"
          ? await stripe.confirmSetup(confirmArgs)
          : await stripe.confirmPayment(confirmArgs);
      if (error) {
        onError?.(
          error.message ?? (intent === "setup" ? t.cardNotSaved : t.paymentFailed),
        );
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
      {/*
        `tabs` is what makes a card-only form look like a form. The default
        (accordion) always draws a header row for the method — a "Card" label and
        an icon above the fields — even when there is exactly one method and
        nothing to choose. The tabs layout renders no tab bar for a single method,
        so the card fields sit inline with the surrounding inputs. MEASURED, not
        assumed: with one method the accordion still shows its header.

        `wallets.link: never` removes the Link WALLET. It does not remove Link's
        inline signup ("Save my info for faster checkout") — that comes from the
        account's Link setting, and only a payment-method configuration with Link
        off turns it off (see ensurePaymentMethodConfig, passed to the SetupIntent).
        Both are set because the client option can be dropped by a refactor while
        the configuration is server-side and cannot.
      */}
      <PaymentElement
        options={{ layout: { type: "tabs" }, wallets: { link: "never" } }}
      />
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
  /**
   * Two-letter country to start the billing address on, e.g. "IT".
   *
   * Set this for a single-market product. Without it Stripe geolocates by IP,
   * which is right often enough to be dangerous: when it guesses wrong the
   * customer is quoted their WRONG country's tax — and if it lands on a country
   * you have no registration in, Stripe computes ZERO tax and the total silently
   * drops to the pre-tax amount unless they notice the dropdown.
   *
   * It reaches the SESSION, not just the field, so tax is computed from the first
   * render (`tax.status: "ready"`) instead of after the address is filled in. The
   * customer can still change it.
   */
  defaultCountry?: string;
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
  defaultCountry,
  children,
}: BillingCheckoutSessionProviderProps) {
  const stripe = React.useMemo(
    () => stripeFor(publishableKey, taxIdBeta ? [TAX_ID_BETA] : undefined, locale),
    [publishableKey, taxIdBeta, locale],
  );
  return (
    <CheckoutElementsProvider
      stripe={stripe}
      options={{
        clientSecret,
        elementsOptions: { appearance },
        ...(defaultCountry
          ? { defaultValues: { billingAddress: { address: { country: defaultCountry } } } }
          : {}),
      }}
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
      {/* Same reason as AddCardForm: no accordion header when there is one
          method to pick. With several (a wallet, Klarna) the tabs appear, which
          is correct — there is then something to choose. */}
      <CheckoutPaymentElement
        options={{
          layout: { type: "tabs" },
          wallets: { link: link ? "auto" : "never" },
        }}
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

// ── Tax ID without the preview ───────────────────────────────────────────────
//
// Stripe's Tax ID Element is a public preview granted per ACCOUNT, and no
// client-side option substitutes for it: measured on an account without access,
// the checkout SDK exposes `createPaymentElement` but `createTaxIdElement` is
// undefined, with the beta flag as well as without it.
//
// `updateTaxIdInfo` on the session, however, is available to everyone. So the
// capability is never actually blocked — only Stripe's rendered widget is. This
// hook is the difference: the app renders its own input (with its own design
// system, which tends to look better than an iframe anyway) and this pushes the
// value to the session, where Stripe Tax applies reverse charge exactly as it
// would have.
//
// It is HEADLESS on purpose. A styled input shipped from here would be the one
// piece of the form that matches neither Stripe's elements nor the host app.
//
// `handledByStripe` is the whole reason this doesn't become dead code: when the
// account does get the preview, BillingCheckoutSessionForm renders the real
// element and this hook reports true, so the app's own field disappears without
// anyone editing it.

/** Which tax ID type applies in a country, for the countries where collecting
 *  one is routine. Anything not listed reports `type: null`, meaning "don't show
 *  a field" — the same default as the Element's `visibility: "auto"`. */
const TAX_ID_TYPE_BY_COUNTRY: Record<string, StripeCheckoutTaxIdType> = {
  // EU: one type for the whole single market, which is what makes intra-EU
  // reverse charge work.
  AT: "eu_vat", BE: "eu_vat", BG: "eu_vat", CY: "eu_vat", CZ: "eu_vat",
  DE: "eu_vat", DK: "eu_vat", EE: "eu_vat", ES: "eu_vat", FI: "eu_vat",
  FR: "eu_vat", GR: "eu_vat", HR: "eu_vat", HU: "eu_vat", IE: "eu_vat",
  IT: "eu_vat", LT: "eu_vat", LU: "eu_vat", LV: "eu_vat", MT: "eu_vat",
  NL: "eu_vat", PL: "eu_vat", PT: "eu_vat", RO: "eu_vat", SE: "eu_vat",
  SI: "eu_vat", SK: "eu_vat",
  // Non-EU Europe + the majors.
  GB: "gb_vat", CH: "ch_vat", NO: "no_vat",
  AU: "au_abn", NZ: "nz_gst", CA: "ca_bn", US: "us_ein",
  JP: "jp_cn", SG: "sg_gst", IN: "in_gst", BR: "br_cnpj", MX: "mx_rfc",
  ZA: "za_vat", AE: "ae_trn", SA: "sa_vat", TR: "tr_tin", KR: "kr_brn",
};

export type BillingTaxIdState = {
  /** Stripe's own element is rendering the field — render nothing yourself. */
  handledByStripe: boolean;
  /** The type for the current billing country, or null when there is none to
   *  collect (also null before a country is chosen). Hide the field when null. */
  type: StripeCheckoutTaxIdType | null;
  /** Two-letter country the type was derived from, for labelling. */
  country: string | null;
  value: string;
  setValue: (value: string) => void;
  /**
   * Push the value to the session — call on blur, not per keystroke. Resolves to
   * an error message (Stripe's own, e.g. an invalid VAT format) or null on
   * success. An empty value clears the tax ID rather than erroring.
   */
  apply: (businessName?: string) => Promise<string | null>;
  /** Last error from `apply`, cleared as soon as the value changes. */
  error: string | null;
  applying: boolean;
  /** Already accepted by Stripe for this session. */
  applied: boolean;
};

/** Collect a business tax ID without Stripe's preview element. Call inside
 *  BillingCheckoutSessionProvider. */
export function useBillingTaxId(): BillingTaxIdState {
  const result = useCheckoutElements();
  const [value, setValueRaw] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);

  const checkout = result.type === "success" ? result.checkout : null;
  const handledByStripe = typeof checkout?.createTaxIdElement === "function";
  // The country comes from the session, so the field follows the address element
  // without the app having to wire the two together.
  const country = checkout?.billingAddress?.address?.country ?? null;

  const setValue = React.useCallback((next: string) => {
    setValueRaw(next);
    setError(null);
  }, []);

  const apply = React.useCallback(
    async (businessName?: string) => {
      if (!checkout) return null;
      const type = country ? TAX_ID_TYPE_BY_COUNTRY[country.toUpperCase()] : undefined;
      const trimmed = value.trim();
      // Clearing is a legitimate outcome: the customer typed a number, thought
      // better of it, and the session must forget it too.
      if (!trimmed || !type) {
        const cleared = await checkout.updateTaxIdInfo(null);
        return cleared.type === "error" ? (cleared.error.message ?? "Invalid tax ID") : null;
      }
      setApplying(true);
      try {
        const r = await checkout.updateTaxIdInfo({
          taxId: { type, value: trimmed },
          // Stripe requires a business name alongside the id; the name already on
          // the session (the address element's) is the sensible default.
          businessName: businessName ?? checkout.billingAddress?.name ?? "",
        });
        const message = r.type === "error" ? (r.error.message ?? "Invalid tax ID") : null;
        setError(message);
        return message;
      } finally {
        setApplying(false);
      }
    },
    [checkout, country, value],
  );

  return {
    handledByStripe,
    type: country ? (TAX_ID_TYPE_BY_COUNTRY[country.toUpperCase()] ?? null) : null,
    country,
    value,
    setValue,
    apply,
    error,
    applying,
    applied: Boolean(checkout?.taxIdInfo?.taxId?.value),
  };
}

// ── useCheckoutSession ───────────────────────────────────────────────────────
// The lifecycle around BillingCheckoutSessionProvider: as the basket changes,
// open the Checkout Session that prices it, hand back the one to mount, and say
// whether it still matches. A session's line items are fixed, so a changed
// basket means a NEW session — and confirming the old one would charge a total
// the page no longer shows, which is what `stale` exists to prevent.
//
// Three things make the form appear sooner, and they're the reason this is in
// the library rather than in each app:
//
//  - `initial`: a session the SERVER created during the render. There is no
//    round trip at all for the default basket — the form is there on first paint.
//  - the first sync is IMMEDIATE. The debounce is for a customer holding a seat
//    stepper; applying it to the initial load just adds half a second of spinner
//    to a basket nobody has touched yet.
//  - Stripe.js is preloaded as soon as the publishable key is known, so the SDK
//    downloads WHILE the session is being created rather than after.

export type CheckoutSessionIntent = {
  clientSecret: string;
  publishableKey: string;
  sessionId: string;
};

export type CheckoutSessionSync =
  | ({ ok: true } & CheckoutSessionIntent)
  | { ok: false; error: string };

/** A session plus the basket it was created for. */
type InitialSession = ({ basket: string } & CheckoutSessionIntent) | null;

function isThenable(value: unknown): value is PromiseLike<InitialSession> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

export function useCheckoutSession(opts: {
  /** Identity of the current basket (seats + interval). A new value re-syncs;
   *  the app computes it, so the hook needs no pricing. */
  basket: string;
  /** Open a Checkout Session for the current basket. */
  create: () => Promise<CheckoutSessionSync>;
  /**
   * A session the server already created, with the basket it was created for —
   * so the first basket costs no client round trip at all.
   *
   * Pass the PROMISE (unawaited, straight from a server component) to get both:
   * the page shell renders immediately and the session is already in flight,
   * rather than starting after hydration. It is awaited in an effect, never
   * `use`d, so it suspends nothing.
   */
  initial?: InitialSession | PromiseLike<InitialSession>;
  /** Publishable key to warm Stripe.js with before the first session arrives.
   *  Optional — without it the preload starts as soon as a session does. */
  publishableKey?: string;
  /** Debounce before re-syncing a CHANGED basket, ms. Default 500. The first
   *  sync never waits. */
  debounceMs?: number;
  /** Skip syncing while true — e.g. an empty basket below the minimum. */
  paused?: boolean;
}): {
  /** The session to mount the provider against — key the provider on its
   *  `clientSecret`. Stays mounted while a newer basket syncs, so the form
   *  doesn't disappear and remount on every stepper click. */
  session: CheckoutSessionIntent | null;
  /** The mounted session no longer prices the current basket: it is about to be
   *  replaced, so disable submit until it is. */
  stale: boolean;
  status: CheckoutStatus;
  error: string | null;
} {
  const { basket, create, initial, debounceMs = 500, paused = false } = opts;

  // A promise streamed from a server component is a THENABLE, not necessarily a
  // Promise: it is not `instanceof Promise` in every runtime, and chaining
  // `.then().catch()` on it can blow up because `then` returns undefined. Detect
  // it structurally, and adopt it with `Promise.resolve` before chaining.
  const pendingServerSession = isThenable(initial);
  const ready = pendingServerSession ? null : ((initial as InitialSession) ?? null);

  const [state, setState] = React.useState(ready);
  const [status, setStatus] = React.useState<CheckoutStatus>(
    ready || pendingServerSession ? "syncing" : "idle",
  );
  const [error, setError] = React.useState<string | null>(null);
  // Nothing is fetched while the server's session is still streaming in — it is
  // about to answer for this very basket.
  const [awaitingServer, setAwaitingServer] = React.useState(pendingServerSession);

  // The SDK is the same for every session, so warm it from whichever key is
  // known first rather than waiting for the one this render is fetching.
  const warmKey = opts.publishableKey ?? state?.publishableKey;
  React.useEffect(() => {
    if (warmKey) preloadStripe(warmKey);
  }, [warmKey]);

  const latest = React.useRef(0);
  // Baskets that already have a session. The server-provided one counts: it
  // needs no round trip either.
  const synced = React.useRef(new Set<string>(ready ? [ready.basket] : []));

  React.useEffect(() => {
    if (!isThenable(initial)) return;
    let live = true;
    Promise.resolve(initial)
      .then((session) => {
        if (!live || !session) return;
        synced.current.add(session.basket);
        setState(session);
      })
      // A failed server-side session is not an error to show: the client sync
      // this releases will create one and report properly if that fails too.
      .catch(() => {})
      .finally(() => live && setAwaitingServer(false));
    return () => {
      live = false;
    };
    // The promise identity changes on every render in some setups; the first
    // one is the only one that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (paused || awaitingServer || synced.current.has(basket)) return;
    const ticket = ++latest.current;
    setStatus("syncing");
    setError(null);
    const run = async () => {
      const r = await create();
      if (ticket !== latest.current) return; // superseded by a newer basket
      if (r.ok) {
        synced.current.add(basket);
        setState({ basket, ...r });
        setStatus("ready");
      } else {
        setError(r.error);
        setStatus("error");
      }
    };
    // Only a CHANGED basket waits: the first one is a page load, not a customer
    // drumming on the stepper.
    if (synced.current.size === 0) {
      void run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
    // Keyed by the basket it prices; `create` is treated as stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basket, paused, awaitingServer]);

  return {
    session: state
      ? {
          clientSecret: state.clientSecret,
          publishableKey: state.publishableKey,
          sessionId: state.sessionId,
        }
      : null,
    stale: state !== null && state.basket !== basket,
    status: state?.basket === basket ? "ready" : status,
    error,
  };
}

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
  /** Debounce before syncing a CHANGED basket, ms. Default 500 (so holding a
   *  stepper doesn't fire per click). The first sync never waits — nobody has
   *  touched anything yet, so the delay would be pure spinner. */
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
    const run = async () => {
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
    };
    // Only a CHANGED basket waits out the debounce; the first sync is a page
    // load, not a customer drumming on the stepper.
    if (!subIdRef.current) {
      void run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
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

// The session hook. Re-exported here so `@arnaudjnn/billing-tools/ui` is the
// single client entry point; the server half is `resolveSession()` from the
// package root.
export {
  SessionProvider,
  useSession,
  ANONYMOUS_SESSION,
  type BillingSession,
  type SessionUser,
} from "./session.js";

// ── useCheckoutTax ───────────────────────────────────────────────────────────
// Keeps an open Checkout Session's tax correct as the buyer types their address.
//
// This is the client half of computing tax locally instead of paying for Stripe
// Tax. The session is created with the seller's domestic rate, because at
// creation nobody knows where the buyer is; the rate is only knowable once the
// address element has a country. Without this hook the session keeps the rate it
// was born with, and a German buyer is charged Italian VAT.
//
// The server work — resolve the rate, apply it to the line items — is the app's
// `retax` action over `taxRatesFor` + `updateCheckoutSessionTaxRates`. It runs
// inside `runServerUpdate` so Stripe re-reads the session afterwards and every
// total on screen (`useCheckoutTotals`) refreshes with it.
//
// Note what this deliberately does NOT do: write the tax id to the customer.
// `updateTaxIdInfo` belongs to `useBillingTaxId`, and only when a number was
// actually collected — an app that shows no tax field must not push an empty one.

export type CheckoutTaxInput = {
  country: string;
  state?: string | null;
  taxNumber?: string | null;
};

export type CheckoutRetaxResult =
  | { ok: true; percent: number; reverseCharge: boolean }
  | { ok: false; error: string };

export type CheckoutTaxState = {
  /** Applied rate, e.g. 22. Null until the first calculation lands. */
  percent: number | null;
  /** The buyer accounts for the VAT — cross-border EU B2B with a valid number. */
  reverseCharge: boolean;
  /** A recalculation is in flight; the totals on screen are the previous ones. */
  pending: boolean;
  error: string | null;
};

/**
 * Re-tax the session whenever the billing country, state or tax number changes.
 *
 * Call inside `BillingCheckoutSessionProvider`. The tax number comes from the
 * session by default, so rendering `useBillingTaxId`'s field anywhere in the
 * tree is enough to make reverse charge work. With no number the buyer is
 * treated as a consumer — the safe default, since it charges tax rather than
 * exempting.
 */
export function useCheckoutTax(opts: {
  retax: (input: CheckoutTaxInput) => Promise<CheckoutRetaxResult>;
  /** Override the tax number. Omit to use the one on the session. */
  taxNumber?: string | null;
  /** Wait before recalculating, ms. Default 400. */
  debounceMs?: number;
}): CheckoutTaxState {
  const { retax, debounceMs = 400 } = opts;
  const result = useCheckoutElements();
  const checkout = result.type === "success" ? result.checkout : null;

  const country = checkout?.billingAddress?.address?.country ?? null;
  const state = checkout?.billingAddress?.address?.state ?? null;
  // Default to the id already on the session, which is where `useBillingTaxId`
  // (and Stripe's own Tax ID Element) put it. Reading the shared place rather
  // than taking it as a prop is what lets the field and this hook live in
  // different components without the app wiring state between them.
  const taxNumber =
    opts.taxNumber !== undefined
      ? opts.taxNumber
      : (checkout?.taxIdInfo?.taxId?.value ?? null);

  const [tax, setTax] = React.useState<CheckoutTaxState>({
    percent: null,
    reverseCharge: false,
    pending: false,
    error: null,
  });

  // Latest-wins. Address elements emit on every keystroke, so several
  // recalculations can be in flight; without this an earlier, slower response
  // would overwrite a later one and display the wrong rate.
  const runId = React.useRef(0);
  // What the session is currently taxed for. Prevents re-running for a change
  // that doesn't affect the answer (a street edit, a re-render).
  const appliedFor = React.useRef<string | null>(null);
  // Read through a ref so a caller passing an inline arrow doesn't re-trigger
  // the effect on every render.
  const retaxRef = React.useRef(retax);
  retaxRef.current = retax;
  // The SESSION, likewise. `useCheckoutElements` hands back a fresh snapshot
  // object on every render, so depending on it directly is an infinite loop:
  // effect → setTax → render → new `checkout` identity → effect → … The values
  // that decide whether to recalculate (country, state, tax number) are plain
  // strings and are the real dependencies; the session is only the thing the
  // work is done THROUGH, so it belongs in a ref, and "is there one" is a
  // boolean.
  const checkoutRef = React.useRef(checkout);
  checkoutRef.current = checkout;
  const hasSession = checkout !== null;

  React.useEffect(() => {
    if (!hasSession || !country) return;
    const key = `${country}|${state ?? ""}|${taxNumber ?? ""}`;
    if (appliedFor.current === key) return;

    const id = ++runId.current;
    // Identity-stable when it changes nothing: a state object that is merely
    // equal-but-new re-renders, which is what turns any stray re-render into a
    // loop. Belt and braces with the dependency fix above.
    setTax((t) => (t.pending ? t : { ...t, pending: true }));

    const timer = setTimeout(async () => {
      const checkout = checkoutRef.current;
      if (!checkout) return;
      // A box, not a plain `let`: assigned inside a callback, which
      // TypeScript's control-flow analysis cannot see, so a bare variable stays
      // narrowed to its initial `null` at the read below.
      const box: { outcome: CheckoutRetaxResult | null } = { outcome: null };
      const update = await checkout.runServerUpdate(async () => {
        const r = await retaxRef.current({ country, state, taxNumber });
        box.outcome = r;
        // Throwing aborts the update, so Stripe doesn't re-read a session the
        // server declined to change.
        if (!r.ok) throw new Error(r.error);
        return r;
      });
      if (id !== runId.current) return;

      const settled = box.outcome;
      if (update.type === "error" || !settled?.ok) {
        setTax((t) => ({
          ...t,
          pending: false,
          error:
            (settled && !settled.ok ? settled.error : null) ??
            (update.type === "error"
              ? (update.error.message ?? "Tax calculation failed")
              : null),
        }));
        return;
      }
      appliedFor.current = key;
      setTax({
        percent: settled.percent,
        reverseCharge: settled.reverseCharge,
        pending: false,
        error: null,
      });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [hasSession, country, state, taxNumber, debounceMs]);

  return tax;
}

// Field limits, from the leaf module so importing them can never pull the
// server entry into a browser bundle.
export { INVOICE_EMAIL_MAX, COMPANY_NAME_MAX } from "./limits.js";

// Standalone billing-address form (Stripe's Address Element, no payment).
export { BillingAddressForm, type AddressValue } from "./address.js";

// Languages Stripe can issue an invoice in (leaf module: safe for the browser).
export { INVOICE_LOCALES, type InvoiceLocale } from "./locales.js";

// Tax-ID types Stripe accepts (leaf module: safe for the browser).
export { TAX_ID_TYPES, splitTaxIdType, type TaxIdType } from "./tax-id-types.js";
