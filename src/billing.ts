import Stripe from "stripe";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

// Token model: 1 token = 1 cent. Held in the Stripe customer credit balance,
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
  if (config.freeTokens > 0) {
    // Idempotency key so a race on first-use (two concurrent callers) can't
    // grant the welcome bonus twice for the same org.
    await stripe.customers.createBalanceTransaction(
      customer.id,
      {
        amount: -config.freeTokens,
        currency: config.currency,
        description: `Welcome bonus: ${config.freeTokens} free tokens`,
      },
      { idempotencyKey: `welcome:${orgId}` },
    );
  }
  await adapter.setBillingCustomerId(orgId, customer.id);
  return customer.id;
}

/**
 * The customer's token credit, in `currency`.
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
export async function getTokenBalance(
  stripeCustomerId: string,
  currency?: string,
): Promise<number> {
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) return 0;

  const want = currency?.toLowerCase();
  // No currency to reconcile against, or the scalar already denominates in it.
  if (!want || !customer.currency || customer.currency === want) {
    return -customer.balance; // negative balance = credit
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
    if (tx.currency === want) return -tx.ending_balance;
    if (++scanned >= 500) break;
  }
  return 0;
}

export async function deductTokens(
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
    description: `Tool call: ${toolName} (${cost} tokens)`,
    metadata: {
      action: toolName,
      ...(caller?.kind ? { caller_kind: caller.kind } : {}),
      ...(caller?.id ? { caller_id: caller.id } : {}),
    },
  });
}

// Sum debited tokens on a customer since `since` (unix seconds — the cycle
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
    if (filter?.callerKind && tx.metadata?.caller_kind !== filter.callerKind) continue;
    if (filter?.callerId && tx.metadata?.caller_id !== filter.callerId) continue;
    total += tx.amount;
  }
  return total;
}

export async function creditTokens(
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

export async function createTokenCheckoutSession(
  stripeCustomerId: string,
  orgId: string,
  amountMajor: number,
  config: ResolvedConfig,
): Promise<string> {
  const amountMinor = Math.round(amountMajor * 100);
  const tokens = amountMinor; // 1 token = 1 minor unit
  const session = await getStripe().checkout.sessions.create({
    customer: stripeCustomerId,
    mode: "payment",
    // No payment_method_types → Checkout auto-offers every method enabled in the
    // Dashboard (cards + Apple Pay / Google Pay / Link), maximizing conversion.
    line_items: [
      {
        price_data: {
          currency: config.currency,
          product_data: {
            name: `${tokens} tokens`,
            description: `${amountMajor} = ${tokens} tokens`,
          },
          unit_amount: amountMinor,
        },
        quantity: 1,
      },
    ],
    invoice_creation: { enabled: true },
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: { org_id: orgId, tokens: String(tokens) },
    },
    metadata: { org_id: orgId, tokens: String(tokens) },
    success_url: `${config.baseUrl}/billing/success?tokens=${tokens}`,
    cancel_url: `${config.baseUrl}/billing/cancel`,
  });
  return session.url!;
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

export async function tryAutoReload(
  stripeCustomerId: string,
  currency: string,
): Promise<void> {
  const settings = await getAutoReloadSettings(stripeCustomerId);
  if (!settings || !settings.enabled) return;

  const balance = await getTokenBalance(stripeCustomerId, currency);
  if (balance > settings.threshold) return;

  const tokensNeeded = settings.reload_to - balance;
  if (tokensNeeded <= 0) return;

  const stripe = getStripe();
  const pms = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    type: "card",
    limit: 1,
  });
  if (pms.data.length === 0) return;

  try {
    const pi = await stripe.paymentIntents.create({
      amount: tokensNeeded,
      currency,
      customer: stripeCustomerId,
      payment_method: pms.data[0].id,
      off_session: true,
      confirm: true,
      description: `Auto-reload: ${tokensNeeded} tokens`,
      metadata: { auto_reload: "true", tokens: String(tokensNeeded) },
    });
    if (pi.status === "succeeded") {
      await creditTokens(stripeCustomerId, tokensNeeded, `Auto-reload: ${tokensNeeded} tokens`, currency);
    }
  } catch {
    // card declined / off-session failure — never block the triggering call
  }
}

export async function listInvoices(
  stripeCustomerId: string,
  limit = 10,
): Promise<
  Array<{
    id: string;
    type: string;
    number: string | null;
    amount: number;
    status: string | null;
    created: string;
    invoice_url: string | null;
    invoice_pdf: string | null;
  }>
> {
  const stripe = getStripe();
  const [invoices, charges] = await Promise.all([
    stripe.invoices.list({ customer: stripeCustomerId, limit }),
    stripe.charges.list({ customer: stripeCustomerId, limit }),
  ]);

  const invoiceEntries = invoices.data.map((inv) => ({
    id: inv.id!,
    type: "purchase" as const,
    number: inv.number,
    amount: inv.amount_paid,
    status: inv.status,
    created: new Date(inv.created * 1000).toISOString(),
    invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
  }));

  const autoReloadCharges = charges.data
    .filter((ch) => ch.metadata?.auto_reload === "true" && ch.status === "succeeded")
    .map((ch) => ({
      id: ch.id!,
      type: "auto_reload" as const,
      number: null,
      amount: ch.amount,
      status: ch.status,
      created: new Date(ch.created * 1000).toISOString(),
      invoice_url: ch.receipt_url ?? null,
      invoice_pdf: null,
    }));

  return [...invoiceEntries, ...autoReloadCharges]
    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
    .slice(0, limit);
}
