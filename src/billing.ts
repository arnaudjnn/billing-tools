import Stripe from "stripe";
import { defaultPaymentMethodConfig } from "./payment-method-config.js";
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
export async function getCreditBalance(
  stripeCustomerId: string,
  currency?: string,
): Promise<number> {
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) return 0;

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
  const subtotal = Math.round(amountMajor * 100);
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
): Promise<string> {
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
            // `allow_redisplay` (cards saved off-session are `always`).
            allow_redisplay_filters: ["always"],
            // And keep offering to save a NEW card, so a first purchase leaves
            // something behind for auto-reload.
            payment_method_save: "enabled",
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
  // The caller knows which it asked for; returning one string keeps the signature.
  return embedded ? session.client_secret! : session.url!;
}

/** A Stripe Billing Portal session URL — the no-code self-serve surface where a
 *  customer manages their subscription (upgrade/downgrade/cancel), updates the
 *  payment method (fixes a failing card), and views invoices. */
export async function createBillingPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
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
/** Fire-and-forget auto-reload with the deployment's tax settings applied.
 *  Both trigger points (the meter and the auth gate) go through this, so a
 *  reload can't be taxed on one path and untaxed on the other. */
export async function autoReloadFor(
  stripeCustomerId: string,
  config: { currency: string; tax?: BillingConfig["tax"] },
): Promise<void> {
  const rates = config.tax?.rates ? await config.tax.rates(stripeCustomerId) : undefined;
  await tryAutoReload(stripeCustomerId, config.currency, {
    taxRates: rates,
    automaticTax: config.tax?.automatic,
  });
}

export async function tryAutoReload(
  stripeCustomerId: string,
  currency: string,
  opts: { taxRates?: string[]; automaticTax?: boolean } = {},
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

  // Stable across concurrent triggers: same customer, same target, same hour.
  // Not the exact balance — two racing callers can read balances a credit apart
  // and would then key differently, which is precisely the double charge.
  const slot = new Date().toISOString().slice(0, 13);
  const key = `autoreload:${stripeCustomerId}:${settings.reload_to}:${slot}`;
  const taxRates = opts.taxRates?.length ? opts.taxRates : null;

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
        ...(!taxRates && opts.automaticTax ? { automatic_tax: { enabled: true } } : {}),
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
