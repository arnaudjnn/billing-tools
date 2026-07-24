import Stripe from "stripe";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

// Token model: 1 token = 1 cent. Held in the Stripe customer credit balance,
// where a negative balance = available credit. All functions keyed on a
// stripeCustomerId are pure Stripe math (identical across host apps); the
// customer-id pointer itself is stored by the host via the adapter.

export function getStripe(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!);
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

/** All active recurring (subscription) prices on the Stripe account. */
export async function listSubscriptionPrices(): Promise<StripePrice[]> {
  const res = await getStripe().prices.list({
    active: true,
    type: "recurring",
    limit: 100,
    expand: ["data.product"],
  });
  return res.data.map(toStripePrice);
}

/** Resolve a single subscription price without any env config. Resolution
 *  order: explicit `priceId` → matching `lookupKey` → the sole recurring price.
 *  Returns null if nothing matches or the choice is ambiguous (multiple prices,
 *  no lookupKey) — the caller can then list options via listSubscriptionPrices. */
export async function resolveSubscriptionPrice(
  opts: { priceId?: string; lookupKey?: string } = {},
): Promise<StripePrice | null> {
  const prices = await listSubscriptionPrices();
  if (opts.priceId) return prices.find((p) => p.id === opts.priceId) ?? null;
  if (opts.lookupKey) {
    const match = prices.find((p) => p.lookupKey === opts.lookupKey);
    if (match) return match;
  }
  return prices.length === 1 ? prices[0] : null;
}

export async function getBillingCustomerId(
  adapter: BillingAdapter,
  orgId: string,
): Promise<string | null> {
  return adapter.getBillingCustomerId(orgId);
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
  });
  if (config.freeTokens > 0) {
    await stripe.customers.createBalanceTransaction(customer.id, {
      amount: -config.freeTokens,
      currency: config.currency,
      description: `Welcome bonus: ${config.freeTokens} free tokens`,
    });
  }
  await adapter.setBillingCustomerId(orgId, customer.id);
  return customer.id;
}

export async function getTokenBalance(stripeCustomerId: string): Promise<number> {
  const customer = await getStripe().customers.retrieve(stripeCustomerId);
  if (customer.deleted) return 0;
  return -customer.balance; // negative balance = credit
}

export async function deductTokens(
  stripeCustomerId: string,
  toolName: string,
  cost: number,
  currency: string,
): Promise<void> {
  await getStripe().customers.createBalanceTransaction(stripeCustomerId, {
    amount: cost, // positive = debit
    currency,
    description: `Tool call: ${toolName} (${cost} tokens)`,
  });
}

export async function creditTokens(
  stripeCustomerId: string,
  amount: number,
  description: string,
  currency: string,
): Promise<void> {
  await getStripe().customers.createBalanceTransaction(stripeCustomerId, {
    amount: -amount, // negative = credit
    currency,
    description,
  });
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
    payment_method_types: ["card"],
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

  const balance = await getTokenBalance(stripeCustomerId);
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
