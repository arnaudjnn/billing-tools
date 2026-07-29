import type Stripe from "stripe";
import { getStripe } from "./billing.js";

// Declarative plans. Declare them once in code; billing-tools provisions the
// Stripe products/prices from the API key on first use — nothing to click in
// the Stripe dashboard. Stripe prices are immutable, so a changed amount →
// create a new price, transfer the lookup_key onto it, archive the old one
// (existing subscribers keep theirs). Every managed object is tagged
// metadata.managedBy = "billing-tools" so orphans (plans/intervals you removed)
// get archived too — the Stripe account stays clean.

/** One seat type within a plan (e.g. `standard` vs `premium`). Each type has
 *  its own recurring per-seat price and included-token allowance, so a plan's
 *  subscription carries one line item per seat type (quantity = members of that
 *  type). Introduced for the Claude-style Standard/Premium seat model. */
export interface SeatTypeDef {
  /** Per-seat recurring price (cents). 0 = free (no Stripe price). */
  price: { monthly: number; yearly: number };
  /** Included tokens granted per seat of THIS type, per billing cycle. */
  includedTokens: number;
  /** Optional cap on seats of this type (null/undefined = unlimited). */
  seats?: number | null;
  /** Optional display label. */
  label?: string;
}

export interface PlanDef {
  /** Max members per workspace. null = unlimited. */
  seats: number | null;
  /** Included tokens granted per seat, per billing cycle (flat model). */
  tokensPerSeat: number;
  /** Recurring price in the smallest currency unit (cents). 0 = free (no Stripe price). */
  price: { monthly: number; yearly: number };
  /** Optional multi-seat-type pricing. When present, `ensurePlans` mints one
   *  Stripe price per (plan, seatType, interval), the subscription carries one
   *  line item per seat type, and included tokens sum per type
   *  (`includedTokensByType`). When ABSENT the flat {seats, tokensPerSeat,
   *  price} model applies unchanged — existing consumers are unaffected. */
  seatTypes?: Record<string, SeatTypeDef>;
}

export type PlansConfig = Record<string, PlanDef>;
export type BillingInterval = "monthly" | "yearly";

// Library DEFAULT seat types, priced in USD (the lib's default currency — see
// ensurePlans `opts.currency ?? "usd"`). Consumers use these as-is or override
// (scartoffie, for instance, sets currency "eur" and its own EUR amounts).
// Amounts are cents; `yearly` is the annual total per seat. The `api` seat is
// the shared agent/API pool (≈ 5× a premium seat). `includedTokens` are example
// packs — tune per product.
export const DEFAULT_SEAT_TYPES: Record<string, SeatTypeDef> = {
  standard: { label: "Standard", price: { monthly: 2500, yearly: 24000 }, includedTokens: 1000 }, // $25/mo · $20/mo annually
  premium: { label: "Premium", price: { monthly: 12500, yearly: 120000 }, includedTokens: 5000 }, // $125/mo · $100/mo annually
  api: { label: "API", price: { monthly: 62500, yearly: 600000 }, includedTokens: 25000, seats: 1 }, // ≈ 5× premium, one per workspace
};

const INTERVALS: BillingInterval[] = ["monthly", "yearly"];
const STRIPE_INTERVAL: Record<BillingInterval, "month" | "year"> = {
  monthly: "month",
  yearly: "year",
};
const MANAGED_BY = "billing-tools";

export const lookupKeyFor = (
  plan: string,
  interval: BillingInterval,
  seatType?: string,
): string => (seatType ? `${plan}_${seatType}_${interval}` : `${plan}_${interval}`);

export interface EnsuredPrice {
  plan: string;
  interval: BillingInterval;
  /** Set only for seat-typed plans. */
  seatType?: string;
  priceId: string;
  productId: string;
  amount: number;
  lookupKey: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The single managed Stripe product for a plan (reuse across price versions),
 *  discovered via any existing managed price's product. */
async function findPlanProduct(
  stripe: Stripe,
  plan: string,
): Promise<string | null> {
  for (const interval of INTERVALS) {
    const found = await stripe.prices.list({
      lookup_keys: [lookupKeyFor(plan, interval)],
      limit: 1,
      expand: ["data.product"],
    });
    const p = found.data[0];
    if (p) return typeof p.product === "string" ? p.product : p.product.id;
  }
  return null;
}

/** Idempotently create/reconcile Stripe products + prices for the paid plans.
 *  Returns the resolved price for every paid plan × interval. Free plans (both
 *  prices 0) create no Stripe objects. Safe to call on every boot / first use. */
export async function ensurePlans(
  plans: PlansConfig,
  opts: { currency?: string } = {},
): Promise<EnsuredPrice[]> {
  const stripe = getStripe();
  const currency = (opts.currency ?? "usd").toLowerCase();
  const result: EnsuredPrice[] = [];
  const wanted = new Set<string>();

  for (const [plan, def] of Object.entries(plans)) {
    let productId = await findPlanProduct(stripe, plan);
    // One spec per Stripe price to ensure. Flat plans: one per interval.
    // Seat-typed plans: one per (seatType, interval). One managed product per
    // plan holds all of a plan's prices.
    const specs: { interval: BillingInterval; amount: number; seatType?: string }[] = [];
    if (def.seatTypes) {
      for (const [seatType, st] of Object.entries(def.seatTypes)) {
        for (const interval of INTERVALS) {
          specs.push({ interval, amount: st.price[interval], seatType });
        }
      }
    } else {
      for (const interval of INTERVALS) specs.push({ interval, amount: def.price[interval] });
    }

    for (const { interval, amount, seatType } of specs) {
      if (!amount || amount <= 0) continue; // free interval/seat — no Stripe price
      const lookupKey = lookupKeyFor(plan, interval, seatType);
      wanted.add(lookupKey);

      const existing = (
        await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
      ).data[0];
      const matches =
        existing &&
        existing.unit_amount === amount &&
        existing.currency === currency &&
        existing.recurring?.interval === STRIPE_INTERVAL[interval];
      if (existing && matches) {
        productId =
          typeof existing.product === "string" ? existing.product : existing.product.id;
        result.push({ plan, interval, seatType, priceId: existing.id, productId, amount, lookupKey });
        continue;
      }

      if (!productId) {
        const product = await stripe.products.create({
          name: cap(plan),
          metadata: { managedBy: MANAGED_BY, plan },
        });
        productId = product.id;
      }
      // Create the new price and move the lookup_key onto it (frees it from the
      // old price), then archive the old price. Subscribers on it are untouched.
      const created = await stripe.prices.create({
        product: productId,
        currency,
        unit_amount: amount,
        recurring: { interval: STRIPE_INTERVAL[interval] },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        metadata: { managedBy: MANAGED_BY, plan, interval, ...(seatType ? { seatType } : {}) },
      });
      if (existing) await stripe.prices.update(existing.id, { active: false });
      result.push({ plan, interval, seatType, priceId: created.id, productId, amount, lookupKey });
    }
  }

  await archiveOrphans(stripe, wanted);
  return result;
}

/** Archive managed prices whose lookup_key is no longer configured (a plan or
 *  interval you removed), and deactivate now-empty managed products. */
async function archiveOrphans(stripe: Stripe, wanted: Set<string>): Promise<void> {
  const managedProducts = new Set<string>();
  for await (const price of stripe.prices.list({ active: true, limit: 100 })) {
    if (price.metadata?.managedBy !== MANAGED_BY) continue;
    const productId = typeof price.product === "string" ? price.product : price.product.id;
    if (price.lookup_key && wanted.has(price.lookup_key)) {
      managedProducts.add(productId);
      continue;
    }
    await stripe.prices.update(price.id, { active: false });
  }
  // A managed product with no remaining wanted price → archive it.
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata?.managedBy !== MANAGED_BY) continue;
    if (!managedProducts.has(product.id)) {
      await stripe.products.update(product.id, { active: false }).catch(() => {});
    }
  }
}

/** Resolve the current Stripe price id for a plan + interval (via lookup_key).
 *  Returns null for a free/absent price. */
export async function planPriceId(
  plan: string,
  interval: BillingInterval,
  seatType?: string,
): Promise<string | null> {
  const r = await getStripe().prices.list({
    lookup_keys: [lookupKeyFor(plan, interval, seatType)],
    active: true,
    limit: 1,
  });
  return r.data[0]?.id ?? null;
}

/** Reverse-map a Stripe price id → plan key (via the price's metadata). */
export async function planForPriceId(priceId: string): Promise<string | null> {
  try {
    const price = await getStripe().prices.retrieve(priceId);
    return price.metadata?.plan ?? null;
  } catch {
    return null;
  }
}

/** Reverse-map a Stripe price id → its seat type (via metadata), or null for a
 *  flat (non-seat-typed) price. */
export async function seatTypeForPriceId(priceId: string): Promise<string | null> {
  try {
    const price = await getStripe().prices.retrieve(priceId);
    return price.metadata?.seatType ?? null;
  } catch {
    return null;
  }
}

/** Seat limit for a plan (null = unlimited, undefined plan = null). */
export function seatLimit(plans: PlansConfig, plan: string): number | null {
  return plans[plan]?.seats ?? null;
}

/** Included tokens for `seatCount` members on a plan (per cycle, flat model). */
export function includedTokens(
  plans: PlansConfig,
  plan: string,
  seatCount: number,
): number {
  const def = plans[plan];
  if (!def) return 0;
  return def.tokensPerSeat * Math.max(1, seatCount);
}

/** Included tokens for a seat-typed plan given member counts per seat type
 *  (per cycle): Σ seatTypes[t].includedTokens × counts[t]. Falls back to the
 *  flat `includedTokens` (over the total member count) for plans without seat
 *  types, so callers can use it uniformly. */
export function includedTokensByType(
  plans: PlansConfig,
  plan: string | null,
  counts: Record<string, number>,
): number {
  const def = plan ? plans[plan] : undefined;
  if (!def) return 0;
  if (!def.seatTypes) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return includedTokens(plans, plan!, total);
  }
  let sum = 0;
  for (const [type, st] of Object.entries(def.seatTypes)) {
    sum += st.includedTokens * (counts[type] ?? 0);
  }
  return sum;
}
