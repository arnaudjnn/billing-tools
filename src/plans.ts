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
  /** How usage is metered against the plan's seats (default `per_seat`):
   *   • `per_seat` — each seat has its own per-cycle pack (user seats capped
   *     personally; the API seat is a shared pool + top-up).
   *   • `global`   — pay per seat, but NO per-seat cap: all usage draws one
   *     committed workspace token pool (e.g. an Enterprise annual commitment). */
  allowanceMode?: "per_seat" | "global";
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

/** One price to ensure. Flat plans: one per interval. Seat-typed plans: one per
 *  (seatType, interval). */
type PriceSpec = {
  plan: string;
  interval: BillingInterval;
  seatType?: string;
  amount: number;
  lookupKey: string;
};

/** Every price a plans config expects to exist, in a fixed order. Free
 *  intervals/seat types produce no Stripe object, so they're dropped here. */
function priceSpecs(plans: PlansConfig): PriceSpec[] {
  const specs: PriceSpec[] = [];
  for (const [plan, def] of Object.entries(plans)) {
    const of = (interval: BillingInterval, amount: number, seatType?: string) => {
      if (amount > 0) {
        specs.push({ plan, interval, seatType, amount, lookupKey: lookupKeyFor(plan, interval, seatType) });
      }
    };
    if (def.seatTypes) {
      for (const [seatType, st] of Object.entries(def.seatTypes)) {
        for (const interval of INTERVALS) of(interval, st.price[interval], seatType);
      }
    } else {
      for (const interval of INTERVALS) of(interval, def.price[interval]);
    }
  }
  return specs;
}

/**
 * Look every wanted lookup_key up in ONE round trip per 10 keys.
 *
 * This used to be a `prices.list` per key plus two more per plan to find the
 * product — sixteen sequential calls for a three-plan config, ~175ms each, on
 * the critical path of every checkout. `lookup_keys` takes up to 10 at a time,
 * so the same information costs one or two calls.
 */
async function fetchByLookupKey(
  stripe: Stripe,
  keys: string[],
): Promise<Map<string, Stripe.Price>> {
  const found = new Map<string, Stripe.Price>();
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 10) chunks.push(keys.slice(i, i + 10));
  const pages = await Promise.all(
    chunks.map((lookup_keys) =>
      stripe.prices.list({
        lookup_keys,
        active: true,
        limit: 100,
        // The product matters as much as the price: `active` filters PRICES, and
        // a price on an archived product stays active and listable while being
        // unusable for a new subscription.
        expand: ["data.product"],
      }),
    ),
  );
  for (const page of pages) {
    for (const price of page.data) if (price.lookup_key) found.set(price.lookup_key, price);
  }
  return found;
}

/** A price Stripe will actually accept on a new subscription: its product must
 *  be live too, or Stripe refuses with "product … is marked as inactive". */
function usable(price: Stripe.Price | undefined): boolean {
  if (!price) return false;
  const product = price.product;
  return typeof product === "string" || (!product.deleted && product.active);
}

const productIdOf = (price: Stripe.Price): string =>
  typeof price.product === "string" ? price.product : price.product.id;

/** Idempotently create/reconcile Stripe products + prices for the paid plans.
 *  Returns the resolved price for every paid plan × interval. Free plans (both
 *  prices 0) create no Stripe objects. Safe to call on every boot / first use. */
export async function ensurePlans(
  plans: PlansConfig,
  opts: {
    currency?: string;
    taxBehavior?: Stripe.Price.TaxBehavior;
    /**
     * Sweep the account for managed prices/products this config no longer wants.
     *
     * It is a FULL account scan (every active price, every active product), so
     * it is not something to do on a request: `true` (the default) for an
     * explicit reconcile — a CLI/sync/boot call — and `"background"` on a hot
     * path, which starts the sweep without awaiting it. `false` skips it.
     */
    archive?: boolean | "background";
  } = {},
): Promise<EnsuredPrice[]> {
  const stripe = getStripe();
  const currency = (opts.currency ?? "usd").toLowerCase();
  // EXCLUSIVE by default: the listed amount is pre-tax and tax is added on top.
  //
  // This has to be stated, not left to Stripe. Stripe Tax REFUSES to calculate on
  // a price whose tax_behavior is `unspecified`, and the account-level default is
  // `inferred_by_currency` — which for EUR infers INCLUSIVE, silently turning a
  // "€42,08 + IVA" listing into "€42,08 including IVA" (same charge, less revenue).
  // Exclusive matches how a "+ IVA" price is quoted, which is what these seat
  // prices are.
  const taxBehavior = opts.taxBehavior ?? "exclusive";
  const result: EnsuredPrice[] = [];

  const specs = priceSpecs(plans);
  const wanted = new Set(specs.map((s) => s.lookupKey));
  // Everything the config wants, in one or two calls. Also the ONLY place the
  // managed product per plan is discovered: any existing price of the plan
  // carries it, so a separate product lookup per plan is redundant.
  const existingByKey = await fetchByLookupKey(stripe, [...wanted]);

  // Reuse one product per plan across price versions. Seeded from whatever the
  // batch found (a price on an archived product doesn't count — Stripe refuses
  // new subscriptions against it, so the plan gets a fresh product).
  const productByPlan = new Map<string, string>();
  for (const spec of specs) {
    const price = existingByKey.get(spec.lookupKey);
    if (price && usable(price) && !productByPlan.has(spec.plan)) {
      productByPlan.set(spec.plan, productIdOf(price));
    }
  }

  for (const { plan, interval, seatType, amount, lookupKey } of specs) {
    const existing = existingByKey.get(lookupKey);
    // A price on an ARCHIVED product looks perfectly reusable — same amount,
    // currency and interval, still active — but Stripe refuses new subscriptions
    // against it. Treating it as a non-match falls through to the create branch
    // below, which moves the lookup key onto a fresh price
    // (transfer_lookup_key) and archives the old one.
    const matches =
      existing &&
      usable(existing) &&
      existing.unit_amount === amount &&
      existing.currency === currency &&
      existing.recurring?.interval === STRIPE_INTERVAL[interval];

    if (existing && matches) {
      // Backfill: prices minted before this package set tax_behavior are
      // `unspecified`, which Stripe Tax won't calculate on. It is settable once
      // (unspecified → inclusive|exclusive) and immutable after, so this
      // upgrades old prices in place rather than replacing them and moving every
      // subscriber onto a new price id.
      if (existing.tax_behavior === "unspecified") {
        await stripe.prices.update(existing.id, { tax_behavior: taxBehavior });
      }
      const productId = productIdOf(existing);
      productByPlan.set(plan, productId);
      result.push({ plan, interval, seatType, priceId: existing.id, productId, amount, lookupKey });
      continue;
    }

    let productId = productByPlan.get(plan);
    if (!productId) {
      const product = await stripe.products.create({
        name: cap(plan),
        metadata: { managedBy: MANAGED_BY, plan },
      });
      productId = product.id;
      productByPlan.set(plan, productId);
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
      tax_behavior: taxBehavior,
      metadata: { managedBy: MANAGED_BY, plan, interval, ...(seatType ? { seatType } : {}) },
    });
    if (existing) await stripe.prices.update(existing.id, { active: false });
    result.push({ plan, interval, seatType, priceId: created.id, productId, amount, lookupKey });
  }

  const archive = opts.archive ?? true;
  if (archive === "background") void archiveOrphans(stripe, wanted).catch(() => {});
  else if (archive) await archiveOrphans(stripe, wanted);
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

// ── The hot path: resolved prices, memoised ─────────────────────────────────
//
// `ensurePlans` is a RECONCILE. Checkout only needs the price ids, and those
// change when the app's plan config changes — not once per customer. Running the
// reconcile per request cost ~16 Stripe round trips on the critical path of
// every checkout (~2.8s measured), which the customer spent watching a spinner.
//
// So the reconcile runs once per process (per config), and every later checkout
// reads the resolved ids out of memory. The memo is keyed by the CONFIG, so
// editing a price in code invalidates it on deploy, and expires on a timer so a
// change made in the Stripe dashboard is picked up without a restart.

/** Resolved prices for one plans config: lookup_key → price id. */
export type PlanPrices = ReadonlyMap<string, string>;

const MEMO_TTL_MS = 10 * 60 * 1000;

let memo: { key: string; at: number; prices: PlanPrices } | null = null;
// Concurrent cold requests share one reconcile rather than each starting their own.
let inflight: { key: string; promise: Promise<PlanPrices> } | null = null;

const memoKey = (plans: PlansConfig, opts: { currency?: string; taxBehavior?: string }) =>
  JSON.stringify([plans, opts.currency ?? "usd", opts.taxBehavior ?? "exclusive"]);

/**
 * The price ids for `plans`, provisioning them on first use.
 *
 * Same guarantee as `ensurePlans` — the Stripe objects exist and match the
 * config — without paying for the check every time. Use this wherever a price id
 * is needed to serve a request; call `ensurePlans` directly when the point IS
 * the reconcile (a deploy hook, `billing sync`, a test).
 *
 * Look ids up with `lookupKeyFor(plan, interval, seatType)`.
 */
export async function resolvePlanPrices(
  plans: PlansConfig,
  opts: { currency?: string; taxBehavior?: Stripe.Price.TaxBehavior } = {},
): Promise<PlanPrices> {
  const key = memoKey(plans, opts);
  if (memo && memo.key === key && Date.now() - memo.at < MEMO_TTL_MS) return memo.prices;
  if (inflight && inflight.key === key) return inflight.promise;

  const promise = (async () => {
    // Orphan archiving is account hygiene, not something this request needs:
    // start it, don't wait for it.
    const ensured = await ensurePlans(plans, { ...opts, archive: "background" });
    const prices: PlanPrices = new Map(ensured.map((e) => [e.lookupKey, e.priceId]));
    memo = { key, at: Date.now(), prices };
    return prices;
  })().finally(() => {
    if (inflight?.key === key) inflight = null;
  });

  inflight = { key, promise };
  return promise;
}

/**
 * Drop the memo, so the next `resolvePlanPrices` reconciles against Stripe again.
 *
 * Worth calling when a price id turns out to be stale — Stripe rejecting a
 * checkout because a price was archived in the dashboard is exactly the case the
 * TTL alone would leave broken for ten minutes.
 */
export function invalidatePlanPrices(): void {
  memo = null;
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
    limit: 10,
    // The product matters as much as the price: `active: true` above filters
    // PRICES, and a price on an archived product stays active and listable while
    // being unusable for a new subscription.
    expand: ["data.product"],
  });
  const usable = r.data.find(
    (p) =>
      typeof p.product === "string" ||
      (!p.product.deleted && p.product.active),
  );
  return usable?.id ?? null;
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
