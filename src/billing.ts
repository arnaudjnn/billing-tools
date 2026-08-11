import Stripe from "stripe";
import { defaultPaymentMethodConfig } from "./payment-method-config.js";
import { creditsForAmount } from "./plan-model.js";
// Both of these import `getStripe` back from here. An ESM cycle, deliberately and
// harmlessly: every binding involved is a hoisted function declaration read at CALL
// time, never at module-evaluation time — the same shape `payment-method-config`
// has always had. Keep it that way (no top-level use of these at import time).
import { taxFor } from "./tax.js";
import type { BillingAdapter, BillingConfig, ResolvedConfig } from "./types.js";

// Credit model: 1 credit = 1 cent. Held in the Stripe customer credit balance,
// where a negative balance = available credit. All functions keyed on a
// stripeCustomerId are pure Stripe math (identical across host apps); the
// customer-id pointer itself is stored by the host via the adapter.

// One memoized Stripe client for the whole lib (lazy — never construct at
// import; STRIPE_SECRET_KEY may be unset at module load in dev).
let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  return (_stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY!));
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Replace the memoised client. TESTS ONLY.
 *
 * The money paths are worth asserting without a network, and the client is a
 * module-local by design (one per process, built lazily). This is the seam that
 * makes those assertions possible; nothing in the library calls it.
 */
export function __setStripeForTests(client: unknown): void {
  _stripe = client as Stripe;
}

// ── Subscription pricing ────────────────────────────────────────────────────
// Prices are pulled live from the Stripe account (via the API key) rather than
// hardcoded in env — create/edit the plan in Stripe and it's picked up. Callers
// reference a price by its Stripe `lookup_key` (portable across price ids), or
// rely on the single-recurring-price shortcut for simple one-plan accounts.

export interface StripePrice {
  id: string;
  productId: string | null;
  productName: string | null;
  lookupKey: string | null;
  nickname: string | null;
  unitAmount: number | null;
  currency: string;
  interval: string | null;
  intervalCount: number | null;
}

function toStripePrice(p: Stripe.Price): StripePrice {
  const product =
    typeof p.product === "object" && p.product && !("deleted" in p.product)
      ? (p.product as Stripe.Product)
      : null;
  return {
    id: p.id,
    productId: product?.id ?? (typeof p.product === "string" ? p.product : null),
    productName: product?.name ?? null,
    lookupKey: p.lookup_key ?? null,
    nickname: p.nickname ?? null,
    unitAmount: p.unit_amount,
    currency: p.currency,
    interval: p.recurring?.interval ?? null,
    intervalCount: p.recurring?.interval_count ?? null,
  };
}

/** All active recurring (subscription) prices on the Stripe account. Uses the
 *  SDK's async auto-pagination so accounts with >1 page of prices aren't
 *  silently truncated. */
export async function listSubscriptionPrices(): Promise<StripePrice[]> {
  const out: StripePrice[] = [];
  for await (const p of getStripe().prices.list({
    active: true,
    type: "recurring",
    limit: 100,
    expand: ["data.product"],
  })) {
    out.push(toStripePrice(p));
  }
  return out;
}

/** Resolve a single subscription price without any env config. Resolution
 *  order: explicit `priceId` → matching `lookupKey` → the sole recurring price.
 *  Returns null if nothing matches or the choice is ambiguous (multiple prices,
 *  no lookupKey) — the caller can then list options via listSubscriptionPrices.
 *  The priceId/lookupKey paths query Stripe directly (no full-list scan). */
export async function resolveSubscriptionPrice(
  opts: { priceId?: string; lookupKey?: string } = {},
): Promise<StripePrice | null> {
  const stripe = getStripe();
  if (opts.priceId) {
    try {
      const p = await stripe.prices.retrieve(opts.priceId, { expand: ["product"] });
      return p.active ? toStripePrice(p) : null;
    } catch {
      return null;
    }
  }
  if (opts.lookupKey) {
    const r = await stripe.prices.list({
      lookup_keys: [opts.lookupKey],
      active: true,
      limit: 1,
      expand: ["data.product"],
    });
    if (r.data[0]) return toStripePrice(r.data[0]);
    return null;
  }
  const all = await listSubscriptionPrices();
  return all.length === 1 ? all[0] : null;
}

export async function getBillingCustomerId(
  adapter: BillingAdapter,
  orgId: string,
): Promise<string | null> {
  return adapter.getBillingCustomerId(orgId);
}

/** Subscription state as the billing-sync recorded it, through the seam.
 *
 *  All-null when the adapter has no org-metadata store to keep it in, which
 *  reads the same as "no subscription" — the caller's fallback either way. The
 *  point of having it here is that an app holding a `BillingAdapter` shouldn't
 *  have to reach past it to WorkOS (and re-derive the metadata key names) to
 *  read what the engine wrote. */
export async function getOrgSubscription(
  adapter: BillingAdapter,
  orgId: string,
): Promise<{
  plan: string | null;
  status: string | null;
  subscriptionId: string | null;
  periodEnd: string | null;
}> {
  return (
    (await adapter.getSubscription?.(orgId)) ?? {
      plan: null,
      status: null,
      subscriptionId: null,
      periodEnd: null,
    }
  );
}

// Idempotent: return the org's Stripe customer id, creating the customer +
// welcome credit and persisting the pointer via the adapter on first use.
export async function ensureStripeCustomer(
  adapter: BillingAdapter,
  orgId: string,
  email: string | undefined,
  config: ResolvedConfig,
): Promise<string> {
  const existing = await adapter.getBillingCustomerId(orgId);
  if (existing) return existing;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    metadata: { org_id: orgId },
    // Ordered list, but one entry: the app configures a single default.
    ...(config.defaultLocale
      ? { preferred_locales: [config.defaultLocale] }
      : {}),
  });
  if (config.freeCredits > 0) {
    // Idempotency key so a race on first-use (two concurrent callers) can't
    // grant the welcome bonus twice for the same org.
    await stripe.customers.createBalanceTransaction(
      customer.id,
      {
        amount: -config.freeCredits,
        currency: config.currency,
        description: `Welcome bonus: ${config.freeCredits} free credits`,
      },
      { idempotencyKey: `welcome:${orgId}` },
    );
  }
  await adapter.setBillingCustomerId(orgId, customer.id);
  return customer.id;
}

/**
 * The customer's credit balance, in `currency`.
 *
 * `customer.balance` is a SINGLE scalar, denominated in `customer.currency` —
 * whichever currency first touched the customer, pinned there for good. Stripe
 * nonetheless tracks a separate running balance per currency: credit a customer
 * pinned to EUR in USD and the call is accepted, the USD balance gets its own
 * `ending_balance`, and the scalar does not move.
 *
 * So reading the scalar for a customer whose currency isn't the one being
 * metered reports the WRONG balance, silently: debits land in the metered
 * currency while the number on screen keeps reflecting the other one. Measured,
 * not theorised. Passing `currency` (do — it's `config.currency`) reads the
 * balance for that currency instead, from the latest balance transaction in it.
 *
 * Without `currency`, or when it matches the customer's own, the scalar is
 * correct and is used directly — one API call, as before.
 */
/**
 * The customer object, or null if it is deleted.
 *
 * Exists so the two reads that both want it — the wallet balance and the spend
 * controls — can share ONE retrieve. They are issued together on the hot path of
 * every metered call, and measured under load `/v1/customers/:id` was the single
 * largest consumer of the account's request budget, because each did its own.
 */
export async function retrieveBillingCustomer(
  stripeCustomerId: string,
): Promise<Stripe.Customer | null> {
  const customer = await getStripe().customers.retrieve(stripeCustomerId);
  return customer.deleted ? null : (customer as Stripe.Customer);
}

export async function getCreditBalance(
  stripeCustomerId: string,
  currency?: string,
  /** An already-retrieved customer, to avoid a second fetch of the same object. */
  prefetched?: Stripe.Customer | null,
): Promise<number> {
  const stripe = getStripe();
  const customer = prefetched ?? (await stripe.customers.retrieve(stripeCustomerId));
  if (!customer || ("deleted" in customer && customer.deleted)) return 0;

  const want = currency?.toLowerCase();
  // Negation is the whole conversion (a negative Stripe balance IS credit), and
  // `-0` is a real JS value that survives it: an untouched wallet returned -0,
  // which `Intl.NumberFormat` renders as "-0,00 €" on the first balance a customer
  // ever sees. `|| 0` normalises it without touching any other value.
  const credit = (n: number) => -n || 0;

  // No currency to reconcile against, or the scalar already denominates in it.
  if (!want || !customer.currency || customer.currency === want) {
    return credit(customer.balance);
  }

  // Mismatch: walk back to the most recent transaction in the wanted currency —
  // its `ending_balance` IS that currency's balance. Transactions come newest
  // first, so the first match ends the scan.
  //
  // Bounded: a customer whose whole history is in the other currency would
  // otherwise be walked in full. 500 transactions back is far more than a
  // currency switch needs, and reporting 0 (no credit in this currency yet) is
  // the truthful answer beyond it.
  let scanned = 0;
  for await (const tx of stripe.customers.listBalanceTransactions(stripeCustomerId, {
    limit: 100,
  })) {
    if (tx.currency === want) return credit(tx.ending_balance);
    if (++scanned >= 500) break;
  }
  return 0;
}

export async function deductCredits(
  stripeCustomerId: string,
  toolName: string,
  cost: number,
  currency: string,
  /** Who ran it — written as balance-transaction metadata so per-seat / per-
   *  caller cycle usage can be summed with `usageSince` (no separate ledger). */
  caller?: { kind: string; id?: string },
): Promise<void> {
  await getStripe().customers.createBalanceTransaction(stripeCustomerId, {
    amount: cost, // positive = debit
    currency,
    description: `Tool call: ${toolName} (${cost} credits)`,
    metadata: {
      action: toolName,
      ...(caller?.kind ? { caller_kind: caller.kind } : {}),
      ...(caller?.id ? { caller_id: caller.id } : {}),
    },
  });
}

// Sum debited credits on a customer since `since` (unix seconds — the cycle
// start), optionally filtered to a caller via balance-transaction metadata.
// This is the Stripe-native usage ledger: debits are positive amounts, credits
// (grants / top-ups) are negative and excluded. The list is newest-first, so we
// stop as soon as we pass the window — only recent transactions are read.
export async function usageSince(
  stripeCustomerId: string,
  since: number,
  filter?: { callerKind?: string; callerId?: string },
): Promise<number> {
  let total = 0;
  for await (const tx of getStripe().customers.listBalanceTransactions(stripeCustomerId, {
    limit: 100,
  })) {
    if (tx.created < since) break;
    if (tx.amount <= 0) continue; // credits/grants aren't usage
    // A correcting debit (a refund reversal, a manual adjustment) moves money
    // but is not something the customer USED, so it must not eat their pack.
    if (tx.metadata?.kind === "adjustment") continue;
    if (filter?.callerKind && tx.metadata?.caller_kind !== filter.callerKind) continue;
    if (filter?.callerId && tx.metadata?.caller_id !== filter.callerId) continue;
    total += tx.amount;
  }
  return total;
}

/**
 * `usageSince` for SEVERAL windows in one pass.
 *
 * The walk is the same whatever the window: transactions come newest-first and it
 * stops at the oldest `since` asked for, adding each transaction to every window
 * that contains it. Two windows over one caller — a monthly pack and a weekly
 * limit — therefore cost ONE walk rather than two, and the pages are the expensive
 * part: an org whose API usage the wallet funds writes a transaction per call.
 *
 * Windows share the filter, because that is how the caller-scoped reads arrive.
 */
export async function usageSinceWindows(
  stripeCustomerId: string,
  windows: readonly { since: number; until?: number }[],
  filter?: { callerKind?: string; callerId?: string },
): Promise<number[]> {
  if (!windows.length) return [];
  const totals = new Array<number>(windows.length).fill(0);
  const oldest = Math.min(...windows.map((w) => w.since));

  for await (const tx of getStripe().customers.listBalanceTransactions(stripeCustomerId, {
    limit: 100,
  })) {
    // Newest-first, so the first transaction older than EVERY window ends it.
    if (tx.created < oldest) break;
    if (tx.amount <= 0) continue; // credits/grants aren't usage
    if (tx.metadata?.kind === "adjustment") continue;
    if (filter?.callerKind && tx.metadata?.caller_kind !== filter.callerKind) continue;
    if (filter?.callerId && tx.metadata?.caller_id !== filter.callerId) continue;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      // [since, until) — the same half-open window the rest of the library uses,
      // so a transaction on a boundary lands in exactly one of two adjacent ones.
      if (tx.created >= w.since && (w.until == null || tx.created < w.until)) totals[i] += tx.amount;
    }
  }
  return totals;
}

export async function grantCredits(
  stripeCustomerId: string,
  amount: number,
  description: string,
  currency: string,
  /** Pass a stable key (e.g. the source invoice/session id) so replayed events
   *  — a re-delivered webhook, an overlapping poll — credit exactly once. */
  idempotencyKey?: string,
): Promise<void> {
  await getStripe().customers.createBalanceTransaction(
    stripeCustomerId,
    {
      amount: -amount, // negative = credit
      currency,
      description,
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
}

/**
 * How a top-up is taxed and where it returns.
 *
 * Tax is an OPTION rather than a default because only the app knows where it is
 * established and what the customer's place of supply is — the same reason the
 * seat checkout takes `taxRates`. What is NOT acceptable is the previous
 * behaviour: a seller charging 22% IVA on its seats and 0% on a top-up bought
 * through the same account, on an invoice that states neither. `checkBillingSetup`
 * warns when a taxed account sells untaxed top-ups.
 */
export interface TopUpCheckoutOptions {
  /** Manual Stripe TaxRate ids, as `taxRatesFor` returns. */
  taxRates?: string[];
  /**
   * Collect a business tax ID (VAT number) on the form. On by default.
   *
   * Off, a business customer has no way to hand over the number that reverse-charges
   * the sale, so a B2B purchase is invoiced as B2C. This session issues an invoice
   * (`invoice_creation`), which makes it the one place that number can be captured.
   */
  taxIdCollection?: boolean;
  /** Use Stripe Tax instead. Ignored when `taxRates` is given — Stripe rejects both. */
  automaticTax?: boolean;
  /** Defaults to `${baseUrl}/billing/success?credits=…`. */
  successUrl?: string;
  /**
   * Render the payment form INSIDE the app instead of sending the customer to
   * Stripe's hosted page.
   *
   * `hosted` (the default) returns a URL to redirect to. `embedded` returns a
   * client secret for a `ui_mode: "elements"` session, which
   * `BillingCheckoutSessionProvider` mounts — the same components the seat
   * checkout uses, so a top-up can show card fields in a dialog rather than
   * leaving the page. `returnUrl` then covers both success and cancel, because an
   * embedded session has one place to come back to after an off-site step.
   *
   * Embedded is NOT the default: a redirect works with no Stripe.js on the page
   * and no publishable key wired, and switching every existing consumer's top-up
   * flow silently is not a thing a minor release should do.
   */
  uiMode?: "hosted" | "embedded";
  /** Defaults to `${baseUrl}/billing/cancel`. */
  cancelUrl?: string;
  /**
   * Whether the embedded form ASKS before keeping the card.
   *
   * `ask` (the default) renders Stripe's "save my payment details" checkbox and
   * lets the answer decide. `always` drops the checkbox and keeps the card
   * regardless — for an account where a saved card is the point of the purchase
   * rather than a favour to the buyer: auto-reload has nothing to charge without
   * one, and a customer who declines silently disables it.
   *
   * Consent is not skipped by `always`. The session already carries
   * `setup_future_usage: "off_session"`, which is what makes Stripe render the
   * mandate line ("by providing your card you allow … to charge it for future
   * payments") under the fields. The checkbox is a second, narrower question on
   * top of that text — removing it leaves the disclosure in place.
   *
   * `ask` stays the default deliberately: which cards a customer ends up with is
   * exactly the kind of behaviour a minor release must not change under an
   * existing consumer.
   */
  savePaymentMethod?: "ask" | "always";
}

/** What a credit purchase costs, before anyone is charged. */
export interface CreditQuote {
  /** Credits bought. 1 unit of currency = 100 credits, as `buy_credits` says. */
  credits: number;
  /** Minor units, exclusive of tax. */
  subtotal: number;
  /** Minor units of tax added on top. 0 under reverse charge, or with no rates. */
  tax: number;
  total: number;
  /** Summed percentage of the EXCLUSIVE rates applied, for a "IVA (22%)" label. */
  taxPercent: number;
  /** Every rate id this quote accounted for — the ones the charge will carry. */
  taxRateIds: readonly string[];
}

// A TaxRate is immutable in the ways that matter here (percentage, inclusive), so
// its percentage is cached for the process. This is on the path of a dialog that
// re-quotes on every preset click.
const taxRatePercent = new Map<string, Promise<{ percentage: number; inclusive: boolean }>>();

/**
 * Quote a credit purchase from the SAME Stripe TaxRate objects the charge will
 * carry — not from a percentage kept somewhere else.
 *
 * A dialog that says "Estimated tax €4.40" and a Checkout Session that charges
 * something else is the drift this library keeps designing out: pass the rate ids
 * you will pass to `createCreditCheckoutSession` (`topUp.taxRates(orgId)`) and the
 * two cannot disagree, because they are the same objects.
 *
 * INCLUSIVE rates are counted as already inside the amount, so `total` stays the
 * amount asked for — that is what "inclusive" means, and adding them on top would
 * overstate the charge.
 */
export async function quoteCreditPurchase(
  amountMajor: number,
  taxRateIds: readonly string[] = [],
): Promise<CreditQuote> {
  const subtotal = creditsForAmount(amountMajor);
  const stripe = getStripe();
  const rates = await Promise.all(
    taxRateIds.map((id) => {
      let hit = taxRatePercent.get(id);
      if (!hit) {
        hit = stripe.taxRates
          .retrieve(id)
          .then((r) => ({ percentage: r.percentage ?? 0, inclusive: r.inclusive === true }));
        // A failed read must not be cached, or one transient error mis-quotes for
        // the life of the process.
        hit.catch(() => taxRatePercent.delete(id));
        taxRatePercent.set(id, hit);
      }
      return hit;
    }),
  );
  const exclusive = rates.filter((r) => !r.inclusive);
  const taxPercent = exclusive.reduce((sum, r) => sum + r.percentage, 0);
  // Rounded ONCE on the summed percentage, the way Stripe totals a line item's
  // rates: rounding each rate first and adding them drifts by a cent.
  const tax = Math.round((subtotal * taxPercent) / 100);
  return {
    credits: subtotal,
    subtotal,
    tax,
    total: subtotal + tax,
    taxPercent,
    taxRateIds: [...taxRateIds],
  };
}

/** Forget cached TaxRate percentages — for a test, or after editing a rate. */
export function invalidateCreditQuotes(): void {
  taxRatePercent.clear();
}

export async function createCreditCheckoutSession(
  stripeCustomerId: string,
  orgId: string,
  amountMajor: number,
  config: ResolvedConfig,
  opts: TopUpCheckoutOptions = {},
): Promise<{ url: string | null; clientSecret: string | null; sessionId: string }> {
  const amountMinor = Math.round(amountMajor * 100);
  const credits = amountMinor; // 1 credit = 1 minor unit
  const taxRates = opts.taxRates?.length ? opts.taxRates : null;
  // Every method the account has enabled, plus the wallets, minus Link — the same
  // default the subscription checkout and the add-card form get. Undefined when a
  // restricted key cannot provision it, or when `paymentMethods.link` opts in.
  const pmc = await defaultPaymentMethodConfig("payment", config);
  const embedded = opts.uiMode === "embedded";
  const session = await getStripe().checkout.sessions.create({
    customer: stripeCustomerId,
    mode: "payment",
    // See createCheckoutSession: the value is `custom` on this API version and the
    // response echoes back `elements`. A newer version renames it.
    ...(embedded
      ? {
          ui_mode: "custom" as "custom",
          return_url: opts.successUrl ?? `${config.baseUrl}/billing/success?credits=${credits}`,
          saved_payment_method_options: {
            // Offer the cards the customer already has. `payment_method_save`
            // alone does NOT do this — measured: with only that set, a customer
            // with a saved card was still shown blank card fields. It controls the
            // "save for future use" CHECKBOX; surfacing existing methods is
            // `allow_redisplay_filters`, matched against each method's own
            // `allow_redisplay`.
            //
            // `unspecified` is in the list and has to be: a card saved through a
            // merchant-created SetupIntent comes back `unspecified`, not `always`
            // (measured on a card this library had just saved), and so does every
            // card saved before the field existed. Filtering to `always` alone
            // showed a customer with a card on file an empty card form.
            allow_redisplay_filters: ["always", "limited", "unspecified"],
            // And keep offering to save a NEW card, so a first purchase leaves
            // something behind for auto-reload.
            //
            // Omitted entirely under `savePaymentMethod: "always"`: present, it
            // hands the decision to the checkbox, and Checkout then honours an
            // unticked box OVER the session's own `setup_future_usage` — which is
            // how a purchase can leave nothing behind for auto-reload to charge.
            // Absent, `setup_future_usage: "off_session"` below is what applies,
            // and the mandate text it renders is the disclosure.
            ...(opts.savePaymentMethod === "always"
              ? {}
              : { payment_method_save: "enabled" as const }),
          },
        }
      : {}),
    ...(pmc ? { payment_method_configuration: pmc } : {}),
    // No payment_method_types → Checkout auto-offers every method the
    // configuration allows (cards + Apple Pay / Google Pay), maximizing
    // conversion.
    line_items: [
      {
        price_data: {
          currency: config.currency,
          product_data: {
            name: `${credits} credits`,
            description: `${amountMajor} = ${credits} credits`,
          },
          unit_amount: amountMinor,
        },
        quantity: 1,
        ...(taxRates ? { tax_rates: taxRates } : {}),
      },
    ],
    // Manual rates and automatic tax are mutually exclusive in Stripe: passing
    // both fails the request outright.
    ...(!taxRates && opts.automaticTax ? { automatic_tax: { enabled: true } } : {}),
    // WHERE the customer is, and WHETHER they are a business — collected here for the
    // same reason the seat checkout collects them, and missing here until now.
    //
    // A top-up is the FIRST purchase for most wallet-funded products, so this was
    // often the only form a customer ever saw, and it asked for neither. Three
    // consequences, none of which raised an error: the invoice this session issues
    // carried no billing address (EU B2C needs evidence of location, and an invoice
    // wants the real thing); a business had no field for the VAT number that
    // reverse-charges the sale, so B2B was invoiced as B2C; and any rate resolved
    // from `customer.address` fell back to the domestic one, so a seller registered
    // abroad charged its own rate to a customer it should have charged the
    // destination rate.
    //
    // `customer_update` is required whenever `customer` is passed — without it the
    // typed address stays on the session and never reaches the Customer, which is
    // exactly where the next charge looks for it.
    billing_address_collection: "required",
    tax_id_collection: { enabled: opts.taxIdCollection ?? true },
    customer_update: { address: "auto", name: "auto" },
    invoice_creation: { enabled: true },
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: { org_id: orgId, credits: String(credits) },
    },
    metadata: { org_id: orgId, credits: String(credits) },
    // A hosted session needs both; an embedded one has `return_url` instead and
    // Stripe rejects these alongside it.
    ...(embedded
      ? {}
      : {
          success_url: opts.successUrl ?? `${config.baseUrl}/billing/success?credits=${credits}`,
          cancel_url: opts.cancelUrl ?? `${config.baseUrl}/billing/cancel`,
        }),
  });
  // BOTH, plus the id. It used to return one string whose meaning depended on the mode,
  // which forced every embedded caller to recover the session id by splitting the client
  // secret on "_secret_" — a consumer really did that, in production, with a comment
  // apologising for it. A hosted caller reads `url`, an embedded one `clientSecret`, and
  // `sessionId` is what settles the purchase afterwards either way.
  return {
    url: session.url ?? null,
    clientSecret: session.client_secret ?? null,
    sessionId: session.id,
  };
}

/**
 * HOW the money is collected. One purchase, four ways to pay for it.
 *
 * Every one of these existed as a different shape or not at all: `checkout` and `embedded`
 * were a `uiMode` on one function, the off-session charge lived only inside `tryAutoReload`
 * (threshold-triggered, uncallable), and the emailed invoice did not exist. So a consumer
 * with a browser wrote its own purchase and a caller without one had a single answer — a
 * link. Two implementations of one act, and only one of them had the app's settlement.
 *
 *   checkout    a hosted Stripe Checkout URL. Anyone can open it. The default.
 *   embedded    a client secret for Stripe.js — what an app's own Elements form mounts.
 *   saved_card  charge the default card off-session. The ONLY fully headless path: no
 *               browser, no link, no human. Refuses `no_card`.
 *   invoice     Stripe emails a payable invoice. The path for a customer with NO card,
 *               which is the case `saved_card` cannot bootstrap. Refuses `no_email`.
 */
export type PurchaseMethod = "checkout" | "embedded" | "saved_card" | "invoice";

export type PurchaseResult =
  | { status: "checkout"; method: PurchaseMethod; credits: number; url: string | null; clientSecret: string | null; sessionId: string }
  | { status: "charged"; method: "saved_card"; credits: number; invoiceId: string }
  | {
      status: "invoiced";
      method: "invoice";
      credits: number;
      invoiceId: string;
      hostedInvoiceUrl: string | null;
      dueAt: number | null;
      /** Whether Stripe actually SENT the email. False means the invoice exists and is
       *  payable at `hostedInvoiceUrl` — the account just cannot email it yet. */
      emailed: boolean;
    }
  | { status: "refused"; reason: "no_card" | "no_email" | "charge_failed"; message: string };

/**
 * Sell credits at a price that is not the list price.
 *
 * The one thing no other path here can do. Everywhere else `credits` IS the money —
 * `CREDITS_PER_UNIT = 100` makes them the same number, deliberately, so a customer typing an
 * amount and an agent calling `buy_credits` cannot be quoted differently. A negotiated deal
 * is precisely the case where they must differ: 600 000 credits for €4 000 is the whole
 * point of an Enterprise conversation, and until now the library could describe that plan and
 * not sell it.
 *
 * So the two numbers are separated HERE and nowhere else, behind an operator gate, and only
 * as an INVOICE:
 *
 *   • The invoice item carries `amountMinor` — what they agreed to pay.
 *   • `metadata.credits` carries the quantity — what they agreed to get.
 *   • Paying it credits the wallet through the `invoice.paid` branch that already exists,
 *     with the `credit:invoice:<id>` key it already uses.
 *
 * That last point is why this is not a grant. There is no second crediting path to keep in
 * step with the first, an unpaid quote hands over nothing, and a refund reverses through the
 * same machinery as any other invoice.
 */
/**
 * What a credit invoice must ACTUALLY grant, once Stripe has taken its bite.
 *
 * Stripe applies a customer's credit balance to any invoice it finalizes, and this
 * library's wallet IS that balance — so an invoice for 600 000 credits at €4 200 was
 * settled €5 cheaper out of the 500 credits the customer was already holding. Measured on
 * a real account: `subtotal 420000, starting_balance -500, amount_due 419500,
 * ending_balance 0`. They pay less money and LOSE credits they had already bought, which
 * is the one outcome nobody would agree to.
 *
 * There is no per-invoice flag to refuse that — it happens at finalization. So the fix is
 * on the other side: grant what was sold PLUS whatever the invoice ate, which puts the
 * customer exactly where the deal said they would be. `starting_balance` is negative when
 * a credit was applied, and is in minor units, which is the same unit as a credit.
 *
 * The same arithmetic serves every invoiced purchase — a quote, a `buy_credits --method
 * invoice`, an auto-reload — which is why it lives here rather than at three call sites.
 */
export function creditsOwedFor(invoice: {
  metadata?: { credits?: string | null } | null;
  starting_balance?: number | null;
}): number {
  const sold = parseInt(invoice.metadata?.credits ?? "0", 10);
  if (!Number.isFinite(sold) || sold <= 0) return 0;
  const eaten = invoice.starting_balance && invoice.starting_balance < 0 ? -invoice.starting_balance : 0;
  return sold + eaten;
}

export async function sellCredits(
  stripeCustomerId: string,
  orgId: string,
  config: ResolvedConfig,
  input: {
    /** What they get. */
    credits: number;
    /** What they pay, in minor units of `config.currency`. Deliberately unrelated to `credits`. */
    amountMinor: number;
    /** Shown on the invoice — the deal, in the customer's own words. */
    description?: string;
    /** Net terms. Procurement rarely pays on receipt; 30 is the usual answer here. */
    daysUntilDue?: number;
    /** Their PO, on the invoice rather than in an email, because that is what unblocks
     *  payment. */
    purchaseOrder?: string;
    /**
     * Resolved tax for this charge. Omitted, it is resolved from `config.tax` — an approved
     * quote is a real invoice and must carry the same rate, and the same mandatory mention,
     * as every other charge on the account.
     */
    tax?: ChargeTax;
    /** Reuse an existing invoice for a retried approval rather than raising a second one. */
    idempotencyKey?: string;
    /**
     * How to collect it.
     *
     * `auto` (the default) charges the CARD ON FILE and falls back to emailing an invoice
     * when there is none — which is the behaviour a person expects from "accept": somebody
     * who has already given us a card does not want a bill in their inbox, and somebody who
     * has not cannot be charged. `invoice` forces the bill; `saved_card` forces the charge
     * and refuses rather than falling back, for a caller that needs to know.
     */
    method?: "auto" | "saved_card" | "invoice";
  },
): Promise<
  | { status: "invoiced"; invoiceId: string; hostedInvoiceUrl: string | null; dueAt: number | null; emailed: boolean }
  | { status: "charged"; invoiceId: string; hostedInvoiceUrl: string | null; paid: true }
  /** The card is fine and the BANK wants the cardholder. Nothing is charged yet; the hosted
   *  invoice page is where they confirm it. */
  | { status: "needs_authentication"; invoiceId: string; hostedInvoiceUrl: string | null; message: string }
  | { status: "refused"; reason: "no_email" | "no_card" | "invalid_amount" | "charge_failed"; message: string }
> {
  const { credits, amountMinor } = input;
  if (!Number.isFinite(credits) || credits <= 0 || !Number.isFinite(amountMinor) || amountMinor <= 0) {
    return { status: "refused", reason: "invalid_amount", message: "Credits and amount must both be positive." };
  }
  const stripe = getStripe();
  const currency = config.currency;
  const method = input.method ?? "auto";
  // The card decides the shape of the whole charge, so it is read before anything is
  // created: an invoice raised and then charged is one object either way, but which
  // `collection_method` it carries cannot be changed afterwards.
  const card =
    method === "invoice"
      ? null
      : (await stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card", limit: 1 })).data[0] ?? null;
  if (!card && method === "saved_card") {
    return {
      status: "refused",
      reason: "no_card",
      message: "No card on file to charge. Use method \"invoice\" to email a payable invoice instead.",
    };
  }
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  const email = !("deleted" in customer && customer.deleted) ? customer.email : null;
  // Only the emailed path needs an address. A card on file is charged whether or not Stripe
  // can write to them, and refusing that would be inventing a requirement.
  if (!email && !card) {
    return {
      status: "refused",
      reason: "no_email",
      message: "Stripe cannot email an invoice to a customer with no email address. Set one with set_billing_profile.",
    };
  }

  // Resolved here rather than left to the caller, for the reason `config.tax` exists at all:
  // a negotiated invoice that went out at 0% while every other charge on the account carried
  // 22% would be the auto-reload defect again, on the largest sale the library makes.
  const tax = input.tax ?? (await taxFor(stripeCustomerId, config.tax));
  const taxRates = tax.taxRates?.length ? tax.taxRates : null;

  const key = input.idempotencyKey ?? `sell:${stripeCustomerId}:${credits}:${amountMinor}`;
  const description = input.description ?? `${credits.toLocaleString("en-US")} credits`;
  await stripe.invoiceItems.create(
    {
      customer: stripeCustomerId,
      currency,
      amount: amountMinor,
      description,
      ...(taxRates ? { tax_rates: taxRates } : {}),
    },
    { idempotencyKey: `${key}:item` },
  );
  const draft = await stripe.invoices.create(
    {
      customer: stripeCustomerId,
      currency,
      // Charge-now or bill-later, decided by whether there is a card. `charge_automatically`
      // is what lets `invoices.pay` take the card below.
      ...(card
        ? { collection_method: "charge_automatically" as const, default_payment_method: card.id }
        : { collection_method: "send_invoice" as const, days_until_due: input.daysUntilDue ?? 30 }),
      auto_advance: false,
      pending_invoice_items_behavior: "include",
      description,
      // On the invoice, where procurement looks for it.
      ...(input.purchaseOrder ? { custom_fields: [{ name: "PO", value: input.purchaseOrder.slice(0, 30) }] } : {}),
      ...(!taxRates && tax.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      // What the webhook grants when this is paid — and the ONE place in this library where
      // it is not simply the amount.
      metadata: { org_id: orgId, credits: String(credits) },
    },
    { idempotencyKey: `${key}:invoice` },
  );
  if (!draft.id) return { status: "refused", reason: "charge_failed", message: "Stripe returned no invoice." };

  const finalized = await stripe.invoices.finalizeInvoice(draft.id);

  if (card) {
    // Off-session, because nobody is at a browser: this is an operator accepting on the
    // customer's behalf, or an admin pressing accept on a price agreed days ago.
    try {
      const paid = await stripe.invoices.pay(finalized.id!, { off_session: true });
      return {
        status: "charged",
        invoiceId: paid.id!,
        hostedInvoiceUrl: paid.hosted_invoice_url ?? finalized.hosted_invoice_url ?? null,
        paid: true,
      };
    } catch (e) {
      // A card that needs the BANK is not a card that failed, and telling somebody "we have
      // emailed you a bill" when their bank is waiting for a tap is how a payable invoice
      // goes unpaid. European cards ask for this routinely on an off-session charge — there
      // is nobody at a browser to authenticate, which is the whole definition of
      // off-session — so it is its own answer, with the page the customer completes it on.
      //
      // Everything else (a decline, a dead card) keeps the finalized invoice: it is payable
      // from its hosted page and still grants through `invoice.paid`, which beats losing the
      // sale to an error nobody sees.
      const code = (e as { code?: string; raw?: { code?: string } })?.code ?? (e as { raw?: { code?: string } })?.raw?.code;
      if (code === "invoice_payment_intent_requires_action" || code === "authentication_required") {
        return {
          status: "needs_authentication",
          invoiceId: finalized.id!,
          hostedInvoiceUrl: finalized.hosted_invoice_url ?? null,
          message:
            "The bank asked the cardholder to confirm this payment. It is not charged yet — " +
            "open the invoice page to authenticate it.",
        };
      }
      return {
        status: "invoiced",
        invoiceId: finalized.id!,
        hostedInvoiceUrl: finalized.hosted_invoice_url ?? null,
        dueAt: finalized.due_date ? finalized.due_date * 1000 : null,
        emailed: false,
      };
    }
  }

  // Finalized is payable whether or not the send succeeds — losing a real bill to an email
  // error is the worst outcome, and it is one this account has actually produced.
  let emailed = true;
  let sent = finalized;
  try {
    sent = await stripe.invoices.sendInvoice(finalized.id!);
  } catch {
    emailed = false;
  }
  return {
    status: "invoiced",
    invoiceId: sent.id!,
    hostedInvoiceUrl: sent.hosted_invoice_url ?? finalized.hosted_invoice_url ?? null,
    dueAt: sent.due_date ? sent.due_date * 1000 : null,
    emailed,
  };
}

/**
 * Buy credits, by whichever method the caller can actually complete.
 *
 * The single implementation behind `buy_credits` AND behind a consuming app's own purchase
 * dialog — which is the point. scartoffie had its own copy that forced the embedded mode
 * and bypassed the tool, so `savePaymentMethod: "always"`, the card prune and the settlement
 * lived on one path and not the other.
 *
 * `credits` are minor units: 1 credit = 1 cent, the same equivalence
 * `createCreditCheckoutSession` and `tryAutoReload` already use.
 */
export async function purchaseCredits(
  stripeCustomerId: string,
  orgId: string,
  amountMajor: number,
  config: ResolvedConfig,
  opts: TopUpCheckoutOptions & {
    method?: PurchaseMethod;
    /** How long an emailed invoice is payable for. Stripe requires it on `send_invoice`. */
    daysUntilDue?: number;
    /** Resolved tax for the charge — the same rates the quote used. */
    tax?: ChargeTax;
  } = {},
): Promise<PurchaseResult> {
  const method = opts.method ?? "checkout";
  const credits = creditsForAmount(amountMajor);
  const currency = config.currency;
  const stripe = getStripe();

  if (method === "checkout" || method === "embedded") {
    const session = await createCreditCheckoutSession(stripeCustomerId, orgId, amountMajor, config, {
      ...opts,
      // The tax the CALLER resolved, flattened into the shape the session builder takes.
      // Passing it nested silently dropped the rates — the session was created untaxed
      // while the quote beside it showed 22%, which is the one discrepancy a checkout
      // must never have.
      ...(opts.tax ?? {}),
      uiMode: method === "embedded" ? "embedded" : "hosted",
    });
    return { status: "checkout", method, credits, ...session };
  }

  const tax = opts.tax ?? (await taxFor(stripeCustomerId, config.tax));
  const taxRates = tax.taxRates?.length ? tax.taxRates : null;
  // Same key for the item and the invoice, so a retried call reuses the invoice Stripe
  // already made rather than billing a second time. Not the amount alone — two callers
  // buying the same amount an hour apart are two purchases.
  const key = `purchase:${stripeCustomerId}:${credits}:${method}:${Date.now()}`;

  if (method === "saved_card") {
    const pms = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card", limit: 1 });
    if (pms.data.length === 0) {
      return {
        status: "refused",
        reason: "no_card",
        message:
          "No card on file to charge. Use method \"invoice\" to have Stripe email a payable invoice, " +
          "or get_billing_portal with flow \"payment_method_update\" to add one.",
      };
    }
    await stripe.invoiceItems.create(
      {
        customer: stripeCustomerId,
        currency,
        amount: credits,
        description: `Purchase: ${credits} credits`,
        ...(taxRates ? { tax_rates: taxRates } : {}),
      },
      { idempotencyKey: `${key}:item` },
    );
    const invoice = await stripe.invoices.create(
      {
        customer: stripeCustomerId,
        currency,
        collection_method: "charge_automatically",
        default_payment_method: pms.data[0].id,
        auto_advance: false,
        // As in `tryAutoReload`: without this, a customer WITH a subscription has the
        // pending item swept onto their next renewal invoice instead — the purchase comes
        // back paid, numbered and totalling zero, and the credits appear a month later.
        pending_invoice_items_behavior: "include",
        description: `Purchase: ${credits} credits`,
        ...(!taxRates && tax.automaticTax ? { automatic_tax: { enabled: true } } : {}),
        metadata: { org_id: orgId, credits: String(credits) },
      },
      { idempotencyKey: `${key}:invoice` },
    );
    if (!invoice.id) return { status: "refused", reason: "charge_failed", message: "Stripe returned no invoice." };
    try {
      const paid = await stripe.invoices.pay(invoice.id, { off_session: true });
      if (paid.status !== "paid") {
        return { status: "refused", reason: "charge_failed", message: `Invoice is ${paid.status}, not paid.` };
      }
    } catch (e) {
      // A decline is an ANSWER, not a crash: the caller can switch to `invoice` or send the
      // customer to the portal to fix the card.
      return {
        status: "refused",
        reason: "charge_failed",
        message: e instanceof Error ? e.message : "The card was declined.",
      };
    }
    // Credited here rather than left to `invoice.paid`, because an off-session charge is
    // synchronous: the caller gets `charged` and the balance is already true. The webhook
    // grants on the same key, so a delivered event cannot double it.
    await grantCredits(stripeCustomerId, credits, `Purchase: ${credits} credits`, currency, `credit:invoice:${invoice.id}`);
    return { status: "charged", method, credits, invoiceId: invoice.id };
  }

  // method === "invoice" — Stripe sends the bill and collects it.
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  const email = !("deleted" in customer && customer.deleted) ? customer.email : null;
  if (!email) {
    return {
      status: "refused",
      reason: "no_email",
      message: "Stripe cannot email an invoice to a customer with no email address. Set one with set_billing_profile.",
    };
  }
  await stripe.invoiceItems.create(
    {
      customer: stripeCustomerId,
      currency,
      amount: credits,
      description: `Purchase: ${credits} credits`,
      ...(taxRates ? { tax_rates: taxRates } : {}),
    },
    { idempotencyKey: `${key}:item` },
  );
  const draft = await stripe.invoices.create(
    {
      customer: stripeCustomerId,
      currency,
      collection_method: "send_invoice",
      days_until_due: opts.daysUntilDue ?? 7,
      auto_advance: false,
      pending_invoice_items_behavior: "include",
      description: `Purchase: ${credits} credits`,
      ...(!taxRates && tax.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      // `credits` is what the webhook reads to grant them when this is paid — a manual
      // invoice has `billing_reason: "manual"`, which every other crediting branch ignores.
      metadata: { org_id: orgId, credits: String(credits) },
    },
    { idempotencyKey: `${key}:invoice` },
  );
  if (!draft.id) return { status: "refused", reason: "charge_failed", message: "Stripe returned no invoice." };
  // Finalize THEN send: an unfinalized invoice has no number, no hosted page and nothing to
  // pay, and `sendInvoice` on a draft is an error rather than a send.
  const finalized = await stripe.invoices.finalizeInvoice(draft.id);
  // The SEND can fail on its own — an account not yet activated for invoice emails answers
  // "This invoice cannot be sent right now", which is Stripe's, not the customer's fault.
  // The invoice is finalized and payable either way, so losing its hosted URL to that error
  // would be the worst outcome: a real bill exists, and the caller was told only that
  // something went wrong. Measured against a live test account, which is how it was found.
  let emailed = true;
  let sent = finalized;
  try {
    sent = await stripe.invoices.sendInvoice(finalized.id!);
  } catch {
    emailed = false;
  }
  return {
    status: "invoiced",
    method: "invoice",
    credits,
    invoiceId: sent.id!,
    hostedInvoiceUrl: sent.hosted_invoice_url ?? finalized.hosted_invoice_url ?? null,
    dueAt: sent.due_date ? sent.due_date * 1000 : null,
    emailed,
  };
}

/**
 * Where a portal link LANDS. Stripe calls it `flow_data`, and it is the difference between
 * handing someone a menu and handing them the form they need.
 *
 * It matters because this link is the library's answer to the one thing that genuinely
 * cannot be done headlessly: entering a card. A caller with no browser cannot confirm a
 * SetupIntent — but it can produce a URL, and a URL that opens on "add a payment method"
 * is a different quality of answer from one that opens on a dashboard the customer then
 * has to navigate.
 */
export type PortalFlow = "payment_method_update" | "subscription_cancel" | "subscription_update";

/** A Stripe Billing Portal session URL — the no-code self-serve surface where a
 *  customer manages their subscription (upgrade/downgrade/cancel), updates the
 *  payment method (fixes a failing card), and views invoices.
 *
 *  Pass `flow` to open a specific one directly. `subscription_cancel` and
 *  `subscription_update` need a subscription id, which is why they are only reachable when
 *  the caller supplies one — Stripe rejects the session otherwise, and a 400 at link-creation
 *  time is a worse failure than the menu. */
export async function createBillingPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
  opts: { flow?: PortalFlow; subscriptionId?: string } = {},
): Promise<string> {
  const session = await getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
    ...(opts.flow
      ? {
          flow_data: (opts.flow === "payment_method_update"
            ? { type: "payment_method_update" as const }
            : opts.flow === "subscription_cancel"
              ? {
                  type: "subscription_cancel" as const,
                  subscription_cancel: { subscription: opts.subscriptionId! },
                }
              : {
                  type: "subscription_update" as const,
                  subscription_update: { subscription: opts.subscriptionId! },
                }) as Stripe.BillingPortal.SessionCreateParams.FlowData,
        }
      : {}),
  });
  return session.url;
}

// ── Spend controls ──────────────────────────────────────────────────────────
// A customer-set ceiling on how much they may CONSUME in a calendar month, plus
// the thresholds they want to be warned at. Both live on the customer's metadata,
// beside auto-reload, because all three are the same kind of thing: a billing
// preference the customer owns, not plan configuration.
//
// The ceiling is a LIMIT in the `resolveAllowance` sense — it funds nothing and
// only refuses — so it is enforced through `state.limits` like every rate limit
// rather than through a gate of its own. See `spendLimitState`.

/** Metadata keys. `spend_alerts` is a comma-separated ascending list. */
const SPEND_LIMIT_KEY = "spend_limit_credits";
const SPEND_ALERTS_KEY = "spend_alert_credits";

export interface SpendControls {
  /** Credits allowed per calendar month, or null for no ceiling. */
  limitCredits: number | null;
  /** Ascending credit thresholds to warn at. Empty when none. */
  alertCredits: number[];
}

/** Parsed from an already-fetched customer, so a caller that has one does not
 *  pay for a second read. `spendControlsOf` is the whole parser. */
export function spendControlsOf(metadata: Stripe.Metadata | null | undefined): SpendControls {
  const md = metadata ?? {};
  const limit = Number.parseInt(md[SPEND_LIMIT_KEY] ?? "", 10);
  return {
    // 0 and negatives mean "no ceiling", never "refuse everything": a limit
    // stored as 0 by a bad write must not silently block a whole workspace.
    limitCredits: Number.isFinite(limit) && limit > 0 ? limit : null,
    alertCredits: (md[SPEND_ALERTS_KEY] ?? "")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b),
  };
}

export async function getSpendControls(
  stripeCustomerId: string,
  /** An already-retrieved customer, to avoid a second fetch of the same object. */
  prefetched?: Stripe.Customer | null,
): Promise<SpendControls> {
  const customer = prefetched ?? (await getStripe().customers.retrieve(stripeCustomerId));
  if (!customer || ("deleted" in customer && customer.deleted)) {
    return { limitCredits: null, alertCredits: [] };
  }
  return spendControlsOf(customer.metadata);
}

/**
 * Write either field; omit one to leave it alone.
 *
 * "" is what CLEARS a Stripe metadata key, which is why null/empty map to it
 * rather than to "0" — a stored "0" would read back as a ceiling of zero.
 */
/**
 * Why an alert threshold cannot be accepted here, or null when it can.
 *
 * `alertCredits` is a promise: "warn me at 10 000". A deployment with no notifier wired
 * cannot keep it — nothing reads the number — and storing it anyway is how a billing page
 * comes to offer "email alerts" that never arrive. That exact defect shipped in one
 * consumer for months and was only found by grepping for who read the field, which is not
 * a way to find things.
 *
 * The CEILING is unaffected and is never refused: the meter enforces it whether or not
 * anybody can be told, so it is a real setting either way. This refuses the whole call
 * rather than accepting half of it — a caller that asked for two things and got one, with
 * no error, is the shape this is here to prevent.
 */
export function spendAlertRefusal(canNotify: boolean, alertCredits?: number[]): string | null {
  if (canNotify || !alertCredits?.length) return null;
  return (
    "This deployment sends no notifications, so alert thresholds cannot be honoured — " +
    "nothing would read them. Set limit_credits on its own (the meter enforces the ceiling " +
    "regardless), or wire `notifications` on the server."
  );
}

export async function setSpendControls(
  stripeCustomerId: string,
  input: { limitCredits?: number | null; alertCredits?: number[] },
): Promise<void> {
  const metadata: Record<string, string> = {};
  if ("limitCredits" in input) {
    metadata[SPEND_LIMIT_KEY] =
      input.limitCredits && input.limitCredits > 0
        ? String(Math.round(input.limitCredits))
        : "";
  }
  if ("alertCredits" in input) {
    const alerts = (input.alertCredits ?? [])
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.round(n))
      .sort((a, b) => a - b);
    metadata[SPEND_ALERTS_KEY] = alerts.length ? alerts.join(",") : "";
  }
  await getStripe().customers.update(stripeCustomerId, { metadata });
}

export async function getAutoReloadSettings(stripeCustomerId: string): Promise<{
  enabled: boolean;
  threshold: number;
  reload_to: number;
} | null> {
  const customer = await getStripe().customers.retrieve(stripeCustomerId);
  if (customer.deleted) return null;
  const meta = customer.metadata;
  if (meta.auto_reload_enabled !== "true") return null;
  return {
    enabled: true,
    threshold: parseInt(meta.auto_reload_threshold || "0", 10),
    reload_to: parseInt(meta.auto_reload_to || "0", 10),
  };
}

export async function setAutoReloadSettings(
  stripeCustomerId: string,
  threshold: number,
  reloadTo: number,
  enabled: boolean,
): Promise<void> {
  await getStripe().customers.update(stripeCustomerId, {
    metadata: {
      auto_reload_enabled: String(enabled),
      auto_reload_threshold: String(threshold),
      auto_reload_to: String(reloadTo),
    },
  });
}

/**
 * Recharge a customer who has dropped to their auto-reload threshold.
 *
 * Two properties this must have, both learned the hard way:
 *
 * **It bills as an INVOICE, not a bare charge.** A PaymentIntent produces a
 * receipt with no invoice number and no tax line. That is not a valid sales
 * document for a business customer (an Italian buyer needs a fattura), and it
 * meant the one purchase a customer never explicitly confirms was also the one
 * with no paperwork. An invoice also carries the same tax treatment as every
 * other line the account bills.
 *
 * **It is idempotent.** This is fired and forgotten from the meter on every
 * metered call and from the auth path, so N concurrent calls all observe the
 * same low balance and all used to charge. The key below collapses them: Stripe
 * returns the first invoice for every duplicate within its 24h window, so the
 * customer is charged once no matter how many callers raced.
 */
/** What a charge carries for tax, as `taxFor` returns it. */
export type ChargeTax = { taxRates?: string[]; automaticTax?: boolean };

/**
 * Fire-and-forget auto-reload with the deployment's tax settings applied.
 *
 * Both trigger points (the meter and the auth gate) go through this, so a reload
 * can't be taxed on one path and untaxed on the other.
 *
 * **The tax settings are passed as a THUNK, not a value, and that is the whole
 * point of this function's shape.** It used to `await taxFor(...)` here and hand
 * the result down — so every wallet-funded metered call resolved tax for a reload
 * that, almost always, was not going to happen. Under `mode: "local"` that meant a
 * live **VIES** request plus a Stripe customer retrieve per metered call, for a
 * customer whose balance was nowhere near their threshold.
 *
 * VIES is a shared European Commission service, and the failure it invites is a
 * cascade rather than an error: get rate-limited there and every B2B customer
 * silently stops reverse-charging, because an unverifiable number means CHARGE. The
 * bill for hammering it would have arrived as "why is everyone suddenly paying VAT".
 */
export async function autoReloadFor(
  stripeCustomerId: string,
  config: { currency: string; tax?: BillingConfig["tax"] },
): Promise<void> {
  await tryAutoReload(stripeCustomerId, config.currency, () =>
    taxFor(stripeCustomerId, config.tax),
  );
}

export async function tryAutoReload(
  stripeCustomerId: string,
  currency: string,
  /** Resolved tax, or a thunk resolving it — the thunk runs only if we actually
   *  charge, which is what keeps `taxFor` off the metered hot path. */
  opts: ChargeTax | (() => Promise<ChargeTax>) = {},
): Promise<void> {
  const settings = await getAutoReloadSettings(stripeCustomerId);
  if (!settings || !settings.enabled) return;

  const balance = await getCreditBalance(stripeCustomerId, currency);
  if (balance > settings.threshold) return;

  const creditsNeeded = settings.reload_to - balance;
  if (creditsNeeded <= 0) return;

  const stripe = getStripe();
  const pms = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    type: "card",
    limit: 1,
  });
  if (pms.data.length === 0) return;

  // Only NOW is tax worth resolving: past every early return above, this customer is
  // definitely being charged. Every one of those returns is the common case on a
  // metered call, which is why resolving tax before them cost a VIES request per call.
  const tax = typeof opts === "function" ? await opts() : opts;

  // Stable across concurrent triggers: same customer, same target, same hour.
  // Not the exact balance — two racing callers can read balances a credit apart
  // and would then key differently, which is precisely the double charge.
  const slot = new Date().toISOString().slice(0, 13);
  const key = `autoreload:${stripeCustomerId}:${settings.reload_to}:${slot}`;
  const taxRates = tax.taxRates?.length ? tax.taxRates : null;

  try {
    await stripe.invoiceItems.create(
      {
        customer: stripeCustomerId,
        currency,
        amount: creditsNeeded,
        description: `Auto-reload: ${creditsNeeded} credits`,
        ...(taxRates ? { tax_rates: taxRates } : {}),
      },
      { idempotencyKey: `${key}:item` },
    );

    const invoice = await stripe.invoices.create(
      {
        customer: stripeCustomerId,
        currency,
        collection_method: "charge_automatically",
        default_payment_method: pms.data[0].id,
        auto_advance: false,
        // Explicit, and load-bearing: for a customer who HAS a subscription,
        // Stripe otherwise leaves the pending item off this invoice and sweeps
        // it onto the next subscription invoice instead. Measured — the reload
        // invoice came back paid, numbered, and totalling zero, while the credits
        // appeared on the renewal a month later.
        pending_invoice_items_behavior: "include",
        description: `Auto-reload: ${creditsNeeded} credits`,
        ...(!taxRates && tax.automaticTax ? { automatic_tax: { enabled: true } } : {}),
        metadata: { auto_reload: "true", credits: String(creditsNeeded) },
      },
      { idempotencyKey: `${key}:invoice` },
    );
    if (!invoice.id) return;

    const paid = await stripe.invoices.pay(invoice.id, { off_session: true });
    if (paid.status === "paid") {
      // Same key: a retry that finds the invoice already paid must not credit
      // a second time.
      await grantCredits(
        stripeCustomerId,
        creditsNeeded,
        `Auto-reload: ${creditsNeeded} credits`,
        currency,
        `credit:${key}`,
      );
    }
  } catch {
    // card declined / off-session failure — never block the triggering call
  }
}

// ── Invoices ────────────────────────────────────────────────────────────────
// One shape for both things a customer can be shown as "a bill": a real Stripe
// invoice (subscriptions, top-ups bought through Checkout) and a bare charge
// from an off-session auto-reload, which produces a receipt and no invoice.

export interface InvoiceEntry {
  id: string;
  /** `purchase` = a Stripe invoice; `auto_reload` = a bare off-session charge. */
  type: "purchase" | "auto_reload";
  number: string | null;
  /**
   * What to SHOW, in minor units: the amount paid once settled, the amount
   * still owed while open. Reading `amount_paid` alone renders every open
   * invoice as zero, which is the one number a customer must not be shown.
   */
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  /** Stripe's own status: draft | open | paid | uncollectible | void. */
  status: string | null;
  paid: boolean;
  created: string;
  /** Due date of an open invoice, ISO; null when Stripe set none. */
  due_date: string | null;
  /** A human line for the row: the invoice description, else its first line. */
  description: string | null;
  invoice_url: string | null;
  invoice_pdf: string | null;
}

function toInvoiceEntry(inv: Stripe.Invoice): InvoiceEntry {
  const paid = inv.status === "paid";
  return {
    id: inv.id!,
    type: "purchase",
    number: inv.number,
    amount: paid ? inv.amount_paid : inv.amount_due,
    amount_paid: inv.amount_paid,
    amount_due: inv.amount_due,
    currency: inv.currency,
    status: inv.status,
    paid,
    created: new Date(inv.created * 1000).toISOString(),
    due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    description: inv.description ?? inv.lines?.data[0]?.description ?? null,
    invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
  };
}

function toChargeEntry(ch: Stripe.Charge): InvoiceEntry {
  return {
    id: ch.id!,
    type: "auto_reload",
    number: null,
    amount: ch.amount,
    amount_paid: ch.status === "succeeded" ? ch.amount : 0,
    amount_due: ch.status === "succeeded" ? 0 : ch.amount,
    currency: ch.currency,
    // Mapped onto invoice vocabulary so one UI can render both rows.
    status: ch.status === "succeeded" ? "paid" : "open",
    paid: ch.status === "succeeded",
    created: new Date(ch.created * 1000).toISOString(),
    due_date: null,
    description: ch.description ?? null,
    // A receipt page, not a PDF, hence no invoice_pdf for this row.
    invoice_url: ch.receipt_url ?? null,
    invoice_pdf: null,
  };
}

export async function listInvoices(stripeCustomerId: string, limit = 10): Promise<InvoiceEntry[]> {
  const stripe = getStripe();
  const [invoices, charges] = await Promise.all([
    stripe.invoices.list({ customer: stripeCustomerId, limit }),
    stripe.charges.list({ customer: stripeCustomerId, limit }),
  ]);

  // Only auto-reload charges: every other charge on the customer is the
  // settlement of an invoice already listed above, and would double the row.
  const autoReloadCharges = charges.data
    .filter((ch) => ch.metadata?.auto_reload === "true" && ch.status === "succeeded")
    .map(toChargeEntry);

  return [...invoices.data.map(toInvoiceEntry), ...autoReloadCharges]
    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
    .slice(0, limit);
}

// The customer on an invoice/charge, whether expanded or a bare id.
function customerIdOf(ref: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * One invoice (or auto-reload charge) belonging to `stripeCustomerId`.
 *
 * **The ownership check is the point.** An invoice id is guessable-adjacent and
 * these are exposed as a tool and a server action, so a retrieve that didn't
 * compare the customer would hand any caller anyone else's invoice. Not theirs
 * (or gone) → null, which every caller renders as "not found"; the two are
 * deliberately indistinguishable to the caller.
 */
export async function getInvoice(
  stripeCustomerId: string,
  invoiceId: string,
): Promise<InvoiceEntry | null> {
  const stripe = getStripe();
  try {
    if (invoiceId.startsWith("ch_")) {
      const charge = await stripe.charges.retrieve(invoiceId);
      if (customerIdOf(charge.customer) !== stripeCustomerId) return null;
      return toChargeEntry(charge);
    }
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (customerIdOf(invoice.customer) !== stripeCustomerId) return null;
    return toInvoiceEntry(invoice);
  } catch (e) {
    if (e instanceof Stripe.errors.StripeInvalidRequestError) return null;
    throw e;
  }
}

/**
 * The PDF link for one of the customer's invoices, ownership-checked.
 *
 * Stripe's `invoice_pdf` is a long-lived unauthenticated URL, so this is what a
 * download button opens. Null when the row has no PDF at all: a draft invoice,
 * or an auto-reload charge (a receipt page: use `invoice_url` for those).
 */
export async function invoicePdfUrl(
  stripeCustomerId: string,
  invoiceId: string,
): Promise<string | null> {
  const entry = await getInvoice(stripeCustomerId, invoiceId);
  return entry?.invoice_pdf ?? null;
}

// The same three, keyed on an org instead of a Stripe customer, which is what
// a UI actually has. An org that never paid has no customer and therefore no
// invoices: that is the normal state of a free workspace, so it reads as an
// empty list, NOT an error, and never creates a customer just to render a page.

/** The org's recent invoices, newest first. Empty when billing never started. */
export async function listOrgInvoices(
  adapter: BillingAdapter,
  orgId: string,
  limit = 10,
): Promise<InvoiceEntry[]> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) return [];
  return listInvoices(customerId, limit);
}

/** One of the org's invoices, or null when it isn't theirs / doesn't exist. */
export async function getOrgInvoice(
  adapter: BillingAdapter,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceEntry | null> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) return null;
  return getInvoice(customerId, invoiceId);
}

/** PDF link for one of the org's invoices; null when it has none. */
export async function orgInvoicePdfUrl(
  adapter: BillingAdapter,
  orgId: string,
  invoiceId: string,
): Promise<string | null> {
  const entry = await getOrgInvoice(adapter, orgId, invoiceId);
  return entry?.invoice_pdf ?? null;
}
