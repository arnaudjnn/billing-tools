import type Stripe from "stripe";
import { getStripe } from "./billing.js";
import {
  invalidatePlanPrices,
  lookupKeyFor,
  resolvePlanPrices,
  type PlanPrices,
  type PlanCatalog,
} from "./plans.js";
import type { BillingInterval } from "./plans.js";
import { describeBasketProblem, InvalidBasketError, validateBasket } from "./plan-model.js";
import { defaultPaymentMethodConfig } from "./payment-method-config.js";
import { taxFor } from "./tax.js";
import type { BillingConfig } from "./types.js";

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

/** The seat types with a quantity, in a stable order. Zeros are dropped rather
 *  than sent: Stripe rejects a zero-quantity line, and "no Premium seats" must
 *  mean "no Premium line". */
function selected(seats: Quantities): [string, number][] {
  const wanted = Object.entries(seats).filter(([, qty]) => qty > 0);
  if (wanted.length === 0) throw new Error("No seats selected");
  return wanted;
}

/**
 * Price id per selected seat type, from the memoised resolver.
 *
 * One in-memory lookup per line instead of one `prices.list` per line — the
 * prices were already resolved (and provisioned, on first use) by
 * `resolvePlanPrices`.
 */
function priceIdsFor(
  prices: PlanPrices,
  plan: string,
  interval: BillingInterval,
  wanted: [string, number][],
): [string, number][] {
  return wanted.map(([seatType, quantity]) => {
    const lookupKey = lookupKeyFor(plan, interval, seatType);
    const price = prices.get(lookupKey);
    if (!price) {
      // The memo can only be wrong about a price that vanished from Stripe;
      // drop it so the next attempt reconciles instead of failing again.
      invalidatePlanPrices();
      throw new Error(`No Stripe price for ${lookupKey}`);
    }
    return [price, quantity];
  });
}

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
// object the browser mutates, so the rate can be recalculated from the address
// the customer actually typed and the UI renders the session's own numbers
// instead of its own arithmetic.
//
// WHO CALCULATES IS THE CALLER'S CHOICE, and the default is this library's own
// calculation, not Stripe Tax:
//
//   - `taxRates` (the default path) — `taxRatesFor` in src/tax.ts works the rate
//     out from `eu-vat-rates-data` + VIES and applies it as an explicit Stripe TaxRate.
//     No per-transaction fee and no registrations needed to CALCULATE. Re-apply
//     with `updateCheckoutSessionTaxRates` when the typed country differs from
//     the one you guessed; that handoff is the work Stripe Tax charges 0.5% for.
//     What you take on: evidence-of-location records for EU B2C, threshold
//     monitoring, and filing.
//   - `automaticTax: true` — Stripe Tax instead, for an account that wants the
//     above handled. It must be set up first (`Tax > Registrations` per
//     jurisdiction, and a head office), because with no registration Stripe
//     computes ZERO tax rather than erroring: the total silently drops to the
//     pre-tax amount. It also refuses to calculate on a price whose
//     `tax_behavior` is `unspecified` (ensurePlans sets `exclusive`).
//
// Neither is inferred. Passing nothing means an untaxed session, which is right
// for an account that charges no tax and loud enough to notice for one that does
// — where the old inferred default gave a silent 0% that looked like a rate.

export type CheckoutSessionResult = {
  sessionId: string;
  customerId: string;
  /** Elements mode: pass to BillingCheckoutSessionProvider. Null under
   *  `uiMode: "hosted"`, which has no elements to mount. */
  clientSecret: string | null;
  /** Hosted mode: Stripe's own payment page. Null in elements mode — a session
   *  the browser confirms itself has no page to send anyone to. */
  url: string | null;
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
  plans: PlanCatalog;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  /** Where Stripe returns the browser after an off-site step (3DS, bank app), and
   *  the `success_url` under `uiMode: "hosted"`. */
  returnUrl: string;
  /**
   * Who draws the payment form, and therefore what comes back.
   *
   * `"elements"` (default) mounts our own layout and returns a **client secret**.
   * `"hosted"` is Stripe's page and returns a **URL** — which is the only form a
   * caller with no browser can use, so it is what an agent-facing tool wants: an
   * MCP caller handed a client secret cannot do anything with it, and the first
   * purchase is exactly where that caller arrives. Hand-rolling the hosted session
   * to get a URL is how a consumer ends up with a second checkout that inherits
   * neither the deployment's tax nor its payment-method configuration.
   */
  uiMode?: "elements" | "hosted";
  /** Hosted mode only: where Stripe sends a customer who backs out. Defaults to
   *  `returnUrl`. */
  cancelUrl?: string;
  /** Reuse an existing customer, else one is created from `email`. */
  customerId?: string;
  email?: string;
  currency?: string;
  /**
   * Stripe Tax. OFF unless you ask for it.
   *
   * Off is the default because the library ships its own calculation
   * (`taxRatesFor` — `eu-vat-rates-data` + VIES, no per-transaction fee) and because
   * "on" is the more expensive mistake: Stripe Tax with no active registration
   * computes ZERO tax rather than erroring, so the total silently drops to the
   * pre-tax amount and the seller owes the difference. Opting in is a statement
   * that the registrations exist; inheriting it from an unset field never was.
   *
   * Mutually exclusive with `taxRates` — Stripe rejects both, and it would tax
   * the same line twice.
   */
  automaticTax?: boolean;
  /**
   * Apply these Stripe TaxRate ids instead of Stripe Tax (see src/tax.ts).
   *
   * The rate has to be chosen before the customer types an address, so pass the
   * one for your own country and re-apply with `updateCheckoutSessionTaxRates`
   * when the billing country turns out to be different. That handoff is the
   * work Stripe Tax would otherwise do for 0.5%.
   */
  taxRates?: string[];
  /** Collect a business tax ID (VAT number). On by default. */
  taxIdCollection?: boolean;
  /**
   * REQUIRE a tax id, not just offer the field. Off by default.
   *
   * Two Stripe constraints make this blunter than it looks, and both matter before you
   * reach for it:
   *
   * 1. It is **all-or-nothing across countries**. Stripe's only value is
   *    `"if_supported"` — required wherever Stripe supports a tax id type for the
   *    customer's country — so there is NO "require it for UK addresses only". Turning
   *    it on also forces a French or Italian consumer to produce a VAT number, which
   *    blocks every legitimate B2C sale.
   * 2. It is **unavailable in elements mode** (`ui_mode: "custom"`). Stripe rejects the
   *    parameter there, so a deployment that owns its own form has to enforce it itself.
   *
   * So "the address is in a country where I am not registered, therefore the VAT number
   * becomes mandatory" is not expressible in ONE hosted session: the address is typed
   * inside Stripe's form, after the session was created with this flag already fixed.
   * The two shapes that work are to ask for the country in your own step first and then
   * create the session accordingly, or to register where you owe and charge the rate —
   * which needs no tax id from the customer at all.
   */
  taxIdRequired?: boolean;
  /**
   * Which payment methods the form offers. Defaults to CARD ONLY — no Link,
   * Klarna, wallets — because that's what most subscription checkouts want, and
   * Checkout otherwise shows every method enabled on the account. Pass a list to
   * add methods (e.g. ["card", "klarna"]) or "automatic" to defer to the
   * account's dashboard settings.
   */
  paymentMethods?: string[] | "automatic";
  /**
   * A payment-method configuration id (see `ensurePaymentMethodConfig`). Replaces
   * `payment_method_types` (Stripe rejects both) and is the only way to remove
   * Link, whose inline signup ignores the method list.
   */
  paymentMethodConfiguration?: string;
  metadata?: Record<string, string>;
  /**
   * Hand back the session already open for this exact basket instead of opening
   * another one.
   *
   * `checkout.sessions.create` costs 400-500ms at Stripe, and it is the last
   * thing standing between a customer arriving and a payment form existing. The
   * same customer asking for the same basket twice — a reload, a back-button, a
   * router prefetch followed by the click it was prefetching for — does not need
   * two sessions, and creating them anyway leaves a trail of abandoned ones.
   *
   * Keyed on EVERYTHING that shapes the session (customer, plan, interval,
   * seats, currency, return url, tax rates, metadata, …), so a reused session is
   * one Stripe would have created identically. Requires `customerId`: without
   * one every call mints a new customer, and there is nothing stable to key on.
   *
   * Off by default — reusing anything payment-related should be a decision, not
   * a surprise. Dropped as soon as the session is paid (`checkoutSessionOutcome`)
   * or expired, and after `ttlMs` (default 30 min, well inside Stripe's ~24h
   * session lifetime).
   */
  reuse?: boolean | { ttlMs?: number };
  /**
   * The deployment's `BillingConfig` — where tax comes from when this call names
   * none, and where `paymentMethods.link` is read.
   *
   * The body has always read it; the TYPE did not have it, so no TypeScript caller
   * could pass it and every seat session fell back to "no declaration": mode
   * `local` with the origin guessed from the Stripe account's country. Which is
   * right by luck when the account and the establishment are the same country, and
   * silently wrong for `mode: "none"`, `mode: "stripe"`, `registrations` and `oss`
   * — the whole point of declaring tax once.
   */
  config?: BillingConfig;
}): Promise<CheckoutSessionResult> {
  // A basket the catalogue does not permit never becomes a session — refused BEFORE the
  // reuse cache, so an invalid one is not remembered either.
  //
  // `changePlan` has validated since it was written, and this path had not, which made the
  // two ways of buying the same basket disagree: every declared limit — `maxSeats`, a seat
  // type's own `max`, `limits.members`, the plan's `sale` — was enforced on an UPGRADE and
  // by nothing at all on a first purchase. A stepper is a UI, so the only gate on the money
  // path was a number the browser sent. Fifty of a seat declared unique was one crafted
  // request away, and it would have been a real subscription at a real price.
  const problems = validateBasket(opts.plans, {
    plan: opts.plan,
    interval: opts.interval,
    seats: opts.seats,
  });
  if (problems.length) {
    throw new InvalidBasketError(
      problems,
      problems.map((problem) => describeBasketProblem(problem, opts.config?.messages)).join("; "),
    );
  }

  const key = reuseKeyFor(opts);
  if (key) {
    const ttl =
      (typeof opts.reuse === "object" ? opts.reuse.ttlMs : undefined) ?? REUSE_TTL_MS;
    const hit = sessionCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.result;
    // Two renders of the same page at once (a prefetch and the navigation it was
    // for) share one create rather than racing to make two sessions.
    const inflight = sessionInflight.get(key);
    if (inflight) return inflight;
    const started = openCheckoutSession(opts).then((result) => {
      sessionCache.set(key, { at: Date.now(), result });
      sessionKeys.set(result.sessionId, key);
      return result;
    });
    sessionInflight.set(
      key,
      started.finally(() => sessionInflight.delete(key)),
    );
    return started;
  }
  return openCheckoutSession(opts);
}

/** How long a reusable session is handed back for. Stripe expires an open
 *  session after ~24h; this stays far inside that. */
const REUSE_TTL_MS = 30 * 60 * 1000;

const sessionCache = new Map<string, { at: number; result: CheckoutSessionResult }>();
const sessionInflight = new Map<string, Promise<CheckoutSessionResult>>();
/** sessionId → cache key, so a session can be dropped once it is paid. */
const sessionKeys = new Map<string, string>();

/** Identity of a reusable session: every input that changes what Stripe would
 *  create. Null when reuse is off, or when there is no customer to key on. */
function reuseKeyFor(opts: {
  reuse?: boolean | { ttlMs?: number };
  customerId?: string;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  currency?: string;
  returnUrl: string;
  automaticTax?: boolean;
  taxRates?: string[];
  taxIdCollection?: boolean;
  taxIdRequired?: boolean;
  paymentMethods?: string[] | "automatic";
  metadata?: Record<string, string>;
  uiMode?: "elements" | "hosted";
  cancelUrl?: string;
}): string | null {
  if (!opts.reuse || !opts.customerId) return null;
  return JSON.stringify([
    opts.customerId,
    opts.plan,
    opts.interval,
    // Part of the identity: handing an elements session back to a caller that asked
    // for a URL would return `url: null` and look like Stripe's fault.
    opts.uiMode ?? "elements",
    opts.cancelUrl ?? null,
    Object.entries(opts.seats)
      .filter(([, qty]) => qty > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
    opts.currency ?? null,
    opts.returnUrl,
    opts.automaticTax ?? null,
    opts.taxRates ?? null,
    opts.taxIdCollection ?? null,
    opts.taxIdRequired ?? null,
    opts.paymentMethods ?? null,
    opts.metadata ?? null,
  ]);
}

/**
 * Stop handing out a session.
 *
 * Called automatically once `checkoutSessionOutcome` sees it paid and by
 * `expireCheckoutSession`; call it directly if payment is confirmed some other
 * way. Handing a completed session to the next visitor would mount a form that
 * cannot be confirmed.
 */
export function forgetCheckoutSession(sessionId: string): void {
  const key = sessionKeys.get(sessionId);
  if (key) sessionCache.delete(key);
  sessionKeys.delete(sessionId);
}

async function openCheckoutSession(opts: {
  plans: PlanCatalog;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  returnUrl: string;
  uiMode?: "elements" | "hosted";
  cancelUrl?: string;
  customerId?: string;
  email?: string;
  currency?: string;
  automaticTax?: boolean;
  taxRates?: string[];
  taxIdCollection?: boolean;
  taxIdRequired?: boolean;
  paymentMethods?: string[] | "automatic";
  paymentMethodConfiguration?: string;
  config?: BillingConfig;
  metadata?: Record<string, string>;
}): Promise<CheckoutSessionResult> {
  const stripe = getStripe();

  const wanted = selected(opts.seats);

  // Independent, and all three on the critical path of a customer waiting for the
  // payment form: resolve the prices (memoised; provisions them the first time a
  // seat type is ever sold) and the method configuration (memoised too) while the
  // customer is created.
  const [prices, customerId, pmc] = await Promise.all([
    resolvePlanPrices(opts.plans, { currency: opts.currency }),
    opts.customerId ??
      stripe.customers
        .create({ email: opts.email, metadata: opts.metadata })
        .then((c) => c.id),
    // Only when the caller named neither a configuration nor an explicit method
    // list: an app that asked for exactly SEPA meant it.
    opts.paymentMethodConfiguration ??
      (opts.paymentMethods
        ? undefined
        : defaultPaymentMethodConfig("payment", opts.config)),
  ]);

  // Tax, from the deployment's ONE declaration (`config.tax`) unless this call
  // named its own. Needs the customer id, so it can't join the round above — and
  // under `mode: "local"` it is the customer's address that decides the
  // rate, which on a brand-new customer is not typed yet: the domestic rate goes on
  // now and the browser re-applies via `updateCheckoutSessionTaxRates` once the
  // address exists. That handoff is what Stripe Tax would otherwise charge for.
  const tax =
    opts.taxRates?.length || opts.automaticTax !== undefined
      ? { taxRates: opts.taxRates, automaticTax: opts.automaticTax }
      : await taxFor(customerId, opts.config?.tax);

  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = priceIdsFor(
    prices,
    opts.plan,
    opts.interval,
    wanted,
  ).map(([price, quantity]) => ({
    price,
    quantity,
    ...(tax.taxRates?.length ? { tax_rates: tax.taxRates } : {}),
  }));

  const hosted = opts.uiMode === "hosted";
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    // Elements mode (the default): Stripe hosts no page, we mount the elements and
    // own the layout. The value was RENAMED "custom" → "elements"; the pinned SDK
    // still sends "custom" (and its types only allow that), and the API accepts it
    // and echoes back `ui_mode: "elements"`. A newer API version rejects it outright
    // — "The ui_mode value `custom` is no longer supported. Use `elements` instead."
    // So when the stripe dependency is bumped, this line changes with it.
    //
    // Hosted is Stripe's own page, and the difference that matters is the RETURN
    // VALUE: a URL anyone can open, versus a client secret that only a browser
    // running Stripe.js can do anything with.
    ...(hosted
      ? { success_url: opts.returnUrl, cancel_url: opts.cancelUrl ?? opts.returnUrl }
      : { ui_mode: "custom" as const, return_url: opts.returnUrl }),
    line_items,
    customer: customerId,
    // Writes the address (and business name) the customer types onto the Customer.
    // Without it the typed address stays on the session, so Stripe Tax has no
    // location for the customer and the tax is computed as zero. Required
    // whenever `customer` is passed rather than `customer_email`.
    customer_update: { address: "auto", name: "auto" },
    // Explicit opt-in — from this call or from `config.tax.mode`, never inferred
    // from the absence of `taxRates`. Inferring it meant a caller that passed no tax
    // at all got Stripe Tax silently, which on an account with no registration
    // computes 0% and says nothing.
    automatic_tax: { enabled: tax.automaticTax === true },
    tax_id_collection: {
      enabled: opts.taxIdCollection ?? true,
      // Only on the hosted page: Stripe rejects `required` under `ui_mode: "custom"`,
      // so setting it in elements mode would fail the whole session rather than degrade.
      ...(opts.taxIdRequired && hosted ? { required: "if_supported" as const } : {}),
    },
    // A full address, collected by the billing-address element. The alternative
    // ("auto", country + postal code inside the payment element) is enough for
    // tax in most places but not everywhere, and an invoice wants the real thing.
    billing_address_collection: "required",
    // A configuration wins: it is the only lever that removes Link, and Stripe
    // rejects a session that carries both it and an explicit method list.
    ...(pmc
      ? { payment_method_configuration: pmc }
      : opts.paymentMethods === "automatic"
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
    url: session.url,
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
  /**
   * The metadata the session was created with.
   *
   * This is what makes fulfilment possible from a WEBHOOK and not just from the
   * browser: whatever provisioning needs — a workspace name, the user it belongs
   * to — has to travel with the session, because the tab that knew it may be
   * gone by the time payment completes.
   */
  metadata: Record<string, string>;
  /** "subscription" | "payment" | "setup". */
  mode: string | null;
}> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });
  const subscription = session.subscription as Stripe.Subscription | null;
  // Anything that is no longer an open basket must stop being handed out by the
  // reuse cache — a completed session mounts a form that cannot be confirmed.
  if (session.status !== "open") forgetCheckoutSession(sessionId);
  return {
    paid:
      session.status === "complete" &&
      (subscription?.status === "active" || subscription?.status === "trialing"),
    subscriptionId: subscription?.id ?? null,
    customerId:
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null),
    metadata: (session.metadata ?? {}) as Record<string, string>,
    mode: session.mode ?? null,
  };
}

/** Close an abandoned session. Idempotent: one already completed or expired is
 *  left as-is. Optional — Stripe expires open sessions by itself (~24h) and an
 *  unconfirmed session has created nothing. */
export async function expireCheckoutSession(sessionId: string): Promise<void> {
  forgetCheckoutSession(sessionId);
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
  plans: PlanCatalog;
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

  const wanted = selected(opts.seats);

  // Independent — resolve the prices (memoised; provisions them the first time a
  // seat type is ever sold) while the customer is created.
  const [prices, customerId] = await Promise.all([
    resolvePlanPrices(opts.plans, { currency: opts.currency }),
    opts.customerId ??
      stripe.customers
        .create({ email: opts.email, metadata: opts.metadata })
        .then((c) => c.id),
  ]);

  const items: Stripe.SubscriptionCreateParams.Item[] = priceIdsFor(
    prices,
    opts.plan,
    opts.interval,
    wanted,
  ).map(([price, quantity]) => ({ price, quantity }));

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
  plans: PlanCatalog;
  plan: string;
  interval: BillingInterval;
  seats: Quantities;
  currency?: string;
}): Promise<{ subscriptionId: string; clientSecret: string | null }> {
  const stripe = getStripe();

  const wanted = selected(opts.seats);

  // The live subscription is needed to diff against, and the prices to diff it
  // WITH — neither depends on the other.
  const [prices, sub] = await Promise.all([
    resolvePlanPrices(opts.plans, { currency: opts.currency }),
    stripe.subscriptions.retrieve(opts.subscriptionId),
  ]);

  // Desired priceId → quantity for the new basket.
  const desired = new Map(priceIdsFor(prices, opts.plan, opts.interval, wanted));

  // Diff against the live items: bump quantities, delete removed lines, add new.
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
