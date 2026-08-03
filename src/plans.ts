import type Stripe from "stripe";
import { getStripe } from "./billing.js";
import { resolveLocalized } from "./i18n.js";
import {
  grantFor,
  INTERVALS,
  normalizePlan,
  normalizePlans,
  planModel,
  type BillingInterval,
  type PlanCatalog,
  type PlanModel,
  type PlansConfig,
  type Quantities,
  type Sale,
  type SeatTypeDef,
} from "./plan-model.js";

// Declarative plans. Declare them once in code; billing-tools provisions the
// Stripe products/prices from the API key on first use — nothing to click in
// the Stripe dashboard. Stripe prices are immutable, so a changed amount →
// create a new price, transfer the lookup_key onto it, archive the old one
// (existing subscribers keep theirs). Every managed object is tagged
// metadata.managedBy = "billing-tools" so orphans (plans/intervals you removed)
// get archived too — the Stripe account stays clean.

// The plan SHAPE lives in plan-model.ts — a leaf with no imports, so a browser
// bundle and a docs generator can read it (this module pulls in `stripe`). The
// types are re-exported here so `import { PlanDef } from "@arnaudjnn/billing-tools"`
// keeps working unchanged.
export type {
  BillingInterval,
  Money,
  IntervalPrice,
  SeatTypeDef,
  SeatTypeSpec,
  SeatTypeDisplay,
  PlanDef,
  PlanSpec,
  PlanDisplay,
  PlanLimits,
  PlansConfig,
  PlanCatalog,
  PlanModel,
  NormalSeatType,
  Sells,
  Grant,
  Cap,
  CapWindow,
  CapCovers,
  Exhausted,
  Replenish,
  Sale,
  Quantities,
  BasketProblem,
  CycleWindow,
  Every,
  RateLimit,
} from "./plan-model.js";
export {
  definePlans,
  isLegacyPlan,
  normalizePlan,
  normalizePlans,
  planModel,
  plansWhere,
  selfServePlans,
  defaultBasket,
  validateBasket,
  describeBasketProblem,
  grantFor,
  poolSizeOf,
  poolIsPerSeat,
  packSizeOf,
  exhaustedPolicy,
  capCovers,
  cycleWindowFor,
  rateWindowFor,
  rateLimitsOf,
} from "./plan-model.js";

// Library DEFAULT seat types, priced in USD (the lib's default currency — see
// ensurePlans `opts.currency ?? "usd"`). Consumers use these as-is or override
// (a euro-denominated consumer sets currency "eur" and its own amounts).
// Amounts are cents; `yearly` is the annual total per seat. The `api` seat is
// the shared agent/API pool (≈ 5× a premium seat). `includedCredits` are example
// packs — tune per product.
export const DEFAULT_SEAT_TYPES: Record<string, SeatTypeDef> = {
  standard: { label: "Standard", price: { monthly: 2500, yearly: 24000 }, includedCredits: 1000 }, // $25/mo · $20/mo annually
  premium: { label: "Premium", price: { monthly: 12500, yearly: 120000 }, includedCredits: 5000 }, // $125/mo · $100/mo annually
  api: { label: "API", price: { monthly: 62500, yearly: 600000 }, includedCredits: 25000, seats: 1 }, // ≈ 5× premium, one per workspace
};

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
function priceSpecs(plans: PlanCatalog): PriceSpec[] {
  const specs: PriceSpec[] = [];
  for (const model of normalizePlans(plans)) {
    const of = (interval: BillingInterval, amount: number, seatType?: string) => {
      // A plan can decline an interval — an annual-only commitment declares
      // `intervals: ["yearly"]` and no monthly price is ever minted for it.
      if (amount > 0 && model.intervals.includes(interval)) {
        specs.push({
          plan: model.key,
          interval,
          seatType,
          amount,
          lookupKey: lookupKeyFor(model.key, interval, seatType),
        });
      }
    };
    switch (model.sells.kind) {
      case "seats":
        for (const seat of model.seatTypes) {
          for (const interval of INTERVALS) of(interval, seat.price[interval], seat.key);
        }
        break;
      case "flat":
        for (const interval of INTERVALS) of(interval, model.sells.price[interval]);
        break;
      case "nothing":
        // Free, or a pure prepaid wallet: no Stripe object at all.
        break;
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
  plans: PlanCatalog,
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
  // "42.08 + VAT" listing into "42.08 including VAT" (same charge, less revenue).
  // Exclusive matches how a "+ VAT" price is quoted, which is what these seat
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
        // The display name when the config has one, so the Stripe Dashboard and
        // an invoice line read like the product rather than like its key.
        // Resolved in the DEFAULT locale: a Stripe product name is one string
        // for the account, not per viewer.
        name: resolveLocalized(planModel(plans, plan)?.display?.name) ?? cap(plan),
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

// ── Moving existing subscribers onto a new price ─────────────────────────────
//
// Changing an amount in the config mints a new price and archives the old one,
// but a Stripe price is immutable and a subscription references one BY ID — so
// everyone who already subscribed keeps paying the old amount, forever, until
// something moves them. `ensurePlans` deliberately doesn't: silently repricing
// live customers is not a side effect a config edit should have.
//
// This is that step, made explicit. It is also what a currency change needs:
// the new prices exist the moment the config says so, but the subscriptions
// pointing at the old ones have to be walked over.

export interface MigratedSubscription {
  subscriptionId: string;
  customerId: string | null;
  /** The price left behind, and the one adopted. */
  from: string;
  to: string;
  quantity: number;
  /** Seat type for a seat-typed plan; absent for a flat plan. */
  seatType?: string;
}

export interface MigrateSubscriptionsResult {
  /** What moved — or what WOULD move, when `dryRun`. */
  migrated: MigratedSubscription[];
  /**
   * Subscriptions found on a superseded price that turned out to need no change.
   *
   * NOT a count of every up-to-date subscriber: the search starts from the old
   * prices (which is what keeps it bounded), so a subscription already on the
   * current price is never visited. Zero here after a successful migration means
   * "nothing left on an old price", which is the answer that matters.
   */
  alreadyCurrent: number;
  /** Old price ids that were searched. */
  oldPrices: string[];
  dryRun: boolean;
}

/** Live enough to keep billing, so worth migrating. A canceled or
 *  incomplete_expired subscription will never be invoiced again. */
const MIGRATABLE_STATUSES = new Set<Stripe.Subscription.Status>([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
]);

/**
 * Move live subscriptions from a plan's superseded prices onto its current ones.
 *
 * Run it after changing an amount (or the currency) in the plans config, when
 * the change is meant to apply to existing customers and not only to new ones.
 * It is idempotent: a subscription already on the current price is counted and
 * left alone, so re-running does nothing.
 *
 * `dryRun: true` reports exactly what would change without touching Stripe —
 * worth doing first, since the alternative is re-pricing real subscriptions.
 *
 * Proration defaults to `"none"`: the new amount takes effect at the next
 * renewal and nobody is charged (or credited) mid-cycle for the difference,
 * which is what a straightforward price change usually means. Pass
 * `"create_prorations"` or `"always_invoice"` deliberately.
 *
 * Only prices this library minted are considered (`metadata.managedBy`), so a
 * price attached by hand in the Dashboard is never moved out from under you.
 */
export async function migrateSubscriptions(opts: {
  plans: PlanCatalog;
  plan: string;
  interval: BillingInterval;
  currency?: string;
  dryRun?: boolean;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
  /** Stop after this many subscriptions. Omit for all of them. */
  limit?: number;
}): Promise<MigrateSubscriptionsResult> {
  const stripe = getStripe();
  const dryRun = opts.dryRun ?? false;
  const proration_behavior = opts.prorationBehavior ?? "none";

  // The current prices, provisioning them if this is the first run after the
  // config changed — otherwise there would be nothing to migrate ONTO.
  const ensured = await ensurePlans(opts.plans, {
    currency: opts.currency,
    archive: false,
  });
  const current = new Map<string, { priceId: string; seatType?: string }>();
  for (const e of ensured) {
    if (e.plan === opts.plan && e.interval === opts.interval) {
      current.set(e.lookupKey, { priceId: e.priceId, seatType: e.seatType });
    }
  }
  if (current.size === 0) {
    throw new Error(`No current price for plan ${opts.plan} (${opts.interval})`);
  }
  const currentIds = new Set([...current.values()].map((c) => c.priceId));

  // Superseded prices: same plan + interval, minted by this library, not the
  // current one. Archived prices are exactly what we're looking for, so the
  // listing must NOT filter on `active`.
  const productIds = new Set(ensured.map((e) => e.productId));
  const oldPrices: { id: string; seatType?: string }[] = [];
  for (const product of productIds) {
    for await (const price of stripe.prices.list({ product, limit: 100 })) {
      if (price.metadata?.managedBy !== MANAGED_BY) continue;
      if (price.metadata.plan !== opts.plan) continue;
      if (price.metadata.interval !== opts.interval) continue;
      if (currentIds.has(price.id)) continue;
      oldPrices.push({ id: price.id, seatType: price.metadata.seatType });
    }
  }

  const migrated: MigratedSubscription[] = [];
  let alreadyCurrent = 0;
  const seen = new Set<string>();

  for (const old of oldPrices) {
    // Stripe filters subscriptions by price, which is what makes this bounded
    // rather than a scan of every subscription on the account.
    for await (const sub of stripe.subscriptions.list({
      price: old.id,
      status: "all",
      limit: 100,
    })) {
      if (!MIGRATABLE_STATUSES.has(sub.status)) continue;
      if (seen.has(sub.id)) continue;
      if (opts.limit !== undefined && migrated.length >= opts.limit) break;

      // A seat-typed plan has one item per seat type, and only the items on a
      // superseded price move — the rest of the subscription is left as it is.
      const items: Stripe.SubscriptionUpdateParams.Item[] = [];
      const moves: MigratedSubscription[] = [];
      for (const item of sub.items.data) {
        const target = current.get(item.price.lookup_key ?? "");
        const supersededOf = oldPrices.find((p) => p.id === item.price.id);
        if (!supersededOf) continue;
        // The lookup key travelled to the NEW price, so an archived price no
        // longer carries it — resolve the target by seat type instead.
        const to =
          target ??
          [...current.values()].find((c) => c.seatType === supersededOf.seatType) ??
          [...current.values()][0];
        if (to.priceId === item.price.id) continue;
        items.push({ id: item.id, price: to.priceId, quantity: item.quantity ?? 1 });
        moves.push({
          subscriptionId: sub.id,
          customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
          from: item.price.id,
          to: to.priceId,
          quantity: item.quantity ?? 1,
          seatType: supersededOf.seatType,
        });
      }

      seen.add(sub.id);
      if (items.length === 0) {
        alreadyCurrent++;
        continue;
      }
      if (!dryRun) {
        await stripe.subscriptions.update(sub.id, { items, proration_behavior });
      }
      migrated.push(...moves);
    }
  }

  return { migrated, alreadyCurrent, oldPrices: oldPrices.map((p) => p.id), dryRun };
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

const memoKey = (plans: PlanCatalog, opts: { currency?: string; taxBehavior?: string }) =>
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
  plans: PlanCatalog,
  opts: { currency?: string; taxBehavior?: Stripe.Price.TaxBehavior } = {},
): Promise<PlanPrices> {
  const key = memoKey(plans, opts);
  if (memo?.key === "__test__") return memo.prices;
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

/**
 * Prime the price memo. TESTS ONLY.
 *
 * `resolvePlanPrices` provisions through `ensurePlans`, which WRITES to Stripe
 * and archives anything the passed catalogue doesn't mention — a partial config
 * once archived every real price in the test account that way. So a test that
 * wants the arithmetic downstream of price resolution stubs the map instead of
 * letting the reconcile run. Nothing in the library calls this.
 */
export function __setPlanPricesForTests(prices: PlanPrices): void {
  memo = { key: "__test__", at: Number.MAX_SAFE_INTEGER, prices };
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
/** Member limit for a plan (null = unlimited, unknown plan = null). */
export function seatLimit(plans: PlanCatalog, plan: string): number | null {
  return planModel(plans, plan)?.limits.members ?? null;
}

/** Per-type seat cap, or null when that type is unlimited. This is what makes a
 *  `max: 1` shared API seat mean something. */
export function seatTypeLimit(
  plans: PlanCatalog,
  plan: string,
  seatType: string,
): number | null {
  return planModel(plans, plan)?.seatTypes.find((s) => s.key === seatType)?.max ?? null;
}

/** How a plan is sold, which decides whether any checkout path may accept it. */
export function planSale(plans: PlanCatalog, plan: string): Sale | null {
  return planModel(plans, plan)?.sale ?? null;
}

/**
 * Credits to GRANT for `seatCount` members on a plan, per cycle.
 *
 * Now expressed over `grant`, so a plan whose allowance is an ENTITLEMENT
 * (`grant: none`, the default for everything but a credit-selling plan) returns
 * 0 — crediting it would discount that plan's own invoice.
 */
export function includedCredits(
  plans: PlanCatalog,
  plan: string,
  seatCount: number,
): number {
  return grantFor(planModel(plans, plan), { memberCount: seatCount });
}

/** Credits to GRANT given purchased counts per seat type. Falls back to the
 *  member-count form for plans without seat types, so callers can use it
 *  uniformly. */
export function includedCreditsByType(
  plans: PlanCatalog,
  plan: string | null,
  counts: Record<string, number>,
): number {
  const model = planModel(plans, plan);
  if (!model) return 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return grantFor(model, { seatCounts: counts, memberCount: total });
}
