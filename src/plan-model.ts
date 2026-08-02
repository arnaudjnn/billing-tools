// What a plan IS, as data — and the normaliser that turns any accepted shape
// into one internal form.
//
// NO RUNTIME DEPENDENCIES, deliberately — the one import is `i18n.ts`, itself a
// zero-import leaf. `plans.ts` imports `billing.ts` → `stripe`, so
// anything defined there can never be read by a browser bundle or a docs
// generator. The plan model has to be readable by both (a pricing card and a
// markdown table are the same derivation), so it lives here on its own, like
// `ui/limits.ts` does for the same reason.
//
// ── Why five axes instead of one ────────────────────────────────────────────
//
// A plan used to be `{ seats, creditsPerSeat, price, seatTypes?, allowanceMode? }`
// and that shape can only really express one product: per-seat, with a per-seat
// pack. Everything else was squeezed into `allowanceMode`, which despite its
// name does exactly ONE thing — skip the per-seat cap. There was no org-level
// allowance anywhere, so "we don't care about seats, here is a package of N tool
// requests" was unrepresentable, and a plan-level `creditsPerSeat` on such a plan
// was simply never read.
//
// What varies between products turns out to be five independent things:
//
//   sells      what Stripe charges for      (nothing | seats | flat)
//   grant      what is CREDITED as money    (none | purchased_seats | …)
//   cap        what is INCLUDED, as a limit (wallet | per_seat | pool)
//   replenish  how to get more              (purchase | autoReload | request)
//   sale       whether it can be bought     (free | self_serve | quote | legacy)
//
// Only `sells` is a discriminated union, because it alone decides which other
// fields are REQUIRED and what `ensurePlans` mints. Tagging all five under one
// `kind` would need a member per combination (`flat_pool_block_quote`), so the
// rest are plain fields with defaults derived from `sells`.
//
// ── Why `grant` and `cap` are different axes ────────────────────────────────
//
// This is the distinction the old model was missing, and it is a money bug, not
// a modelling preference. `grant` credits the Stripe customer balance. A Stripe
// credit balance AUTO-APPLIES to the customer's next invoice and cannot be
// opted out of — measured: granting 1000 credits to a customer on a €21.04 seat
// produced an invoice with `starting_balance: -1000` and `amount_due: 1104`. So
// crediting a plan's "included" allowance discounts its own renewal by half, and
// an annual pool credited as money would invoice year two at zero.
//
// An included allowance is therefore a `cap`: a window that usage is COUNTED
// against, with no money moving. Credit stays what it is actually for —
// PURCHASED credits (a top-up), which the customer really can spend.

import {
  formatMessage,
  resolveMessages,
  type Localized,
  type LocalizedList,
  type PartialMessages,
} from "./i18n.js";

// ── Primitives ──────────────────────────────────────────────────────────────

export type BillingInterval = "monthly" | "yearly";

/** Minor units (cents). 1 credit = 1 minor unit, throughout this library. */
export type Money = number;

export interface IntervalPrice {
  monthly: Money;
  yearly: Money;
}

export const INTERVALS: readonly BillingInterval[] = ["monthly", "yearly"];

// ── Presentation ────────────────────────────────────────────────────────────
//
// On the plan, not in a parallel file. A second file holding the same numbers is
// exactly what drifts: the app this was extracted from advertised a 17% annual
// saving next to a checkout that charged 14%, "50 searches a day" against a
// config of 1000 per cycle, and "up to 10 members" against a limit of 100.
//
// The library ships NO strings. Everything here is authored by the app (one
// consumer writes Italian, the other English); the library only formats numbers,
// via Intl, with an override.

export interface SeatTypeDisplay {
  /** "Standard seat". A plain string, or one per locale. */
  label: Localized;
  /** One muted line on what the seat buys. */
  usage?: Localized;
}

export interface PlanDisplay {
  /**
   * Commercial proper noun: "Pro".
   *
   * Every text field here is {@link Localized} — a plain string for one language,
   * or `{ en: …, it: … }` to serve several from one config. The library resolves
   * it against the surface's locale, falling back to the language subtag and then
   * to `defaultLocale` (English).
   */
  name: Localized;
  /** Short fragment under the name. No full stop. */
  tagline?: Localized;
  /** Ascending. Plans without one sort after, in config order. */
  order?: number;
  /** Badge text: "Most popular". */
  badge?: Localized;
  featured?: boolean;
  /** Lead-in above the bullets: "Everything in Hobby, plus:". */
  featuresIntro?: Localized;
  /** A list, or one list per locale — translations legitimately differ in length. */
  features?: LocalizedList;
  /** The library picks the CTA *kind* from `sale`; the words are the app's. */
  cta?: { label: Localized; href?: string };
  /** Copy for a plan with no per-seat figure to show (a committed package). */
  pooled?: { title: Localized; note?: Localized };
  /** Keep out of generated pricing surfaces (internal or grandfathered). */
  hidden?: boolean;
}

// ── Axis 1: what Stripe SELLS ───────────────────────────────────────────────

export interface SeatTypeSpec {
  /** Per-seat recurring price. 0 = free (no Stripe price is minted). */
  price: IntervalPrice;
  /** Credits this seat contributes to the cycle's entitlement. Default 0. */
  includedCredits?: number;
  /** Max seats of this type. null/absent = unlimited. */
  max?: number | null;
  /** Minimum purchasable, and where a stepper starts. Default 0. */
  min?: number;
  /**
   * A seat drawn by API keys and agents rather than by a named person.
   *
   * There is normally one per workspace (`max: 1`), it is not a card row, and
   * its allowance defaults to overflowing into the wallet rather than blocking —
   * an agent hitting a hard stop mid-run is worse than a small charge. This
   * makes declarative what used to be a hardcoded `caller.kind === "user"` test.
   */
  shared?: boolean;
  display?: SeatTypeDisplay;
}

export type Sells =
  /** No Stripe product and no subscription: a free plan, or a pure wallet. */
  | { kind: "nothing" }
  /** One line item per seat type; quantity = seats bought of that type. */
  | {
      kind: "seats";
      seatTypes: Record<string, SeatTypeSpec>;
      /** Minimum TOTAL seats across every type ("a team of one is Hobby"). */
      minSeats?: number;
      maxSeats?: number | null;
      /** Intervals actually sold. Default both. */
      intervals?: readonly BillingInterval[];
    }
  /**
   * ONE line item, quantity 1 — a flat subscription or an annual commitment.
   *
   * Note there is no plan-level price on the `seats` variant: a seat-typed
   * plan's plan-level price was never minted by `ensurePlans`, yet it was read
   * elsewhere to decide whether the plan was purchasable. Making it
   * unrepresentable is the point.
   */
  | { kind: "flat"; price: IntervalPrice; intervals?: readonly BillingInterval[] };

// ── Axis 2: what is CREDITED (money into the prepaid wallet, on invoice.paid) ─

export type Grant =
  /**
   * Nothing is credited. The right answer for a free plan, for a committed
   * plan, and for anything whose included usage is an entitlement — i.e. for
   * everything except a plan that literally sells prepaid credit.
   */
  | { kind: "none" }
  /** Σ seatTypes[t].includedCredits × PURCHASED quantity. */
  | { kind: "purchased_seats" }
  /** credits × active member count. */
  | { kind: "per_member"; credits: Money }
  /** A fixed number of credits per cycle. For a plan whose product IS credit. */
  | { kind: "fixed"; credits: Money };

// ── Axis 3: what is INCLUDED (a counted window; no money moves) ──────────────

/** What happens when an entitlement window is used up. */
export type Exhausted =
  /**
   * Refuse, even if the wallet could pay. Right for a committed package (its
   * overage is a conversation, not a silent charge) and for a free plan (whose
   * users have no wallet to protect).
   */
  | "block"
  /** Fall through to the prepaid wallet, so a top-up funds the overage. */
  | "wallet";

/**
 * The window a `cap` is measured over.
 *
 * `cycle` (the default, and the historical behaviour) is the SUBSCRIPTION period:
 * a plan billed annually gets one window a year. That is right for a committed
 * package — a year's worth, bought up front — and wrong for anything a customer
 * is told they get "per month", because an annual subscriber would receive twelve
 * months' allowance on day one and nothing after it ran out.
 *
 * `month` measures the same allowance over the calendar month whatever the
 * billing interval, which is what "1 000 per seat per month, billed annually"
 * actually means. It is the only way to say that: the pack size cannot express it,
 * since the size is a number and the period is the window.
 */
export type CapWindow = "cycle" | "month";

/**
 * WHO an included window covers.
 *
 * `all` (the default, and the historical behaviour) means every caller draws it,
 * agents included. `users` restricts it to people: a machine caller (an API key,
 * an agent — `caller.kind: "api"`, or a `shared` seat) gets NO included
 * allowance and is funded by the prepaid wallet from its first call.
 *
 * That is a different statement from `onExhausted`, which only says what happens
 * once a window is spent — a machine caller already overflows to the wallet there.
 * This says the window was never theirs, which is what "API usage is
 * pay-as-you-go, 0 credits included" means: the two are ordinarily sold as
 * different things, and a plan whose seat pack is a person's monthly allowance
 * should not hand the same allowance to a script that can spend it in a minute.
 */
export type CapCovers = "all" | "users";

export type Cap =
  /**
   * No entitlement window: the prepaid wallet is the only gate. This is exactly
   * what the old `allowanceMode: "global"` did, which is why that value
   * normalises to here and NOT to a pool.
   */
  | { kind: "wallet" }
  /** Each caller is capped to its seat type's pack for the window. */
  | { kind: "per_seat"; window?: CapWindow; covers?: CapCovers; onExhausted?: Exhausted }
  /**
   * ONE org-wide window: all usage in the cycle counts against `credits`,
   * whoever spends it. "We don't care about seats."
   */
  | {
      kind: "pool";
      /** The package size, set in config. */
      credits?: Money;
      /**
       * Unused allowance survives into the next cycle.
       *
       * Not a sweep — it widens the window to the subscription's start instead
       * of the cycle's. Which is the whole reason a window beats a credit: with
       * no rollover there is nothing to expire.
       */
      rollover?: boolean;
      /** Optional per-caller ceiling inside the pool, so one member cannot burn
       *  an annual package. Same filtered read, so it costs nothing extra. */
      perCallerMax?: Money;
      /** Mutually exclusive with `rollover`, which widens the window instead. */
      window?: CapWindow;
      covers?: CapCovers;
      onExhausted?: Exhausted;
    };

// ── Axis 4: how MORE allowance is obtained ──────────────────────────────────
//
// A record of optional capabilities, not a union: these three are independently
// switchable, and a union would need a `purchase_or_request` member the moment
// two are on.

export interface Replenish {
  /** Self-serve credit purchase. */
  purchase?: { packs?: readonly Money[] };
  /**
   * Threshold-triggered card charge. These are the DEFAULTS the plan offers;
   * the live per-customer settings stay on the Stripe customer, because a
   * customer's threshold and card are theirs, not the plan's.
   */
  autoReload?: { threshold: Money; reloadTo: Money; enabledByDefault?: boolean };
  /** Member asks, owner approves (see topup.ts). Raises that member's pack for
   *  the cycle; never credits the wallet. */
  request?: { maxPerCycle?: Money };
}

// ── Axis 5: whether it can be bought ────────────────────────────────────────

export type Sale =
  /** No money. The plan a workspace lands on. */
  | "free"
  /** Self-serve checkout. */
  | "self_serve"
  /** Sales-assisted: the CTA contacts a human, and no checkout path accepts it. */
  | "quote"
  /** Kept for existing subscribers, offered to nobody new. */
  | "legacy";

// ── Rate limits: the same allowance question, asked at more than one timescale ─
//
// `cap` answers "how much is included in the plan", measured over the billing
// cycle. That is a commercial ceiling, and it is the wrong tool for "no more than
// 300 in a week": a month's worth of allowance spent in one afternoon is inside
// the cap and still not what was sold. So a limit is its own axis, and a plan can
// declare as many as it likes — an hour, a day, a week, the month — which are
// checked TOGETHER. A call has to fit inside every one of them.
//
// Windows are FIXED and aligned (top of the hour, UTC midnight, Monday, the 1st),
// not rolling. A rolling window needs every event's timestamp and cannot be
// answered by one summed read, which is what both the hot path and a usage screen
// get to do here — and a fixed window is the only kind that can honestly say when
// it resets.

/** How often a limit's window restarts. `cycle` is the subscription period. */
export type Every = "hour" | "day" | "week" | "month" | "cycle";

export interface RateLimit {
  every: Every;
  /**
   * The ceiling, in the unit the ledger counts: credit cost. With a rate card of
   * 1 credit per action that IS a request count, which is how these read on a
   * usage screen ("300 requests per week").
   */
  credits: Money;
  /**
   * Whose usage counts against it. `org` sums the whole workspace; `caller`
   * gives each member (and the shared API seat) a window of their own. Default
   * `org`, because a limit with no scope is a limit on the product.
   */
  scope?: "org" | "caller";
  /** Restrict to callers of one seat type. Only meaningful with `scope: caller`. */
  seatType?: string;
  /**
   * Restrict to people (`user`) or to machines (`api`).
   *
   * The pace a person can sustain and the pace a script can are different
   * problems, so they are usually different limits — "500 a week each" for members
   * and "600 an hour" for agents. Before this, the only way to separate them was a
   * dedicated `shared` seat TYPE to hang `seatType` off; a plan that funds API
   * usage from the wallet has no such seat, and both limits then landed on every
   * caller, where the tighter one made the other unreachable.
   */
  callerKind?: "user" | "api";
  /** Label for a usage screen. Defaults to the window name. */
  label?: string;
}

export interface PlanLimits {
  /** Max members in the workspace. null = unlimited. */
  members?: number | null;
  /**
   * Usage ceilings per window, all enforced at once. Independent of `cap`: these
   * never fund anything and never fall through to the wallet, because a rate
   * limit that a top-up could lift would not be a rate limit.
   */
  rate?: readonly RateLimit[];
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface PlanSpec {
  sells: Sells;
  /**
   * Default `none`, for every `sells` — including seats.
   *
   * Crediting an invoiced plan's own included credits discounts its own renewal
   * (a Stripe credit balance auto-applies to the next invoice; measured at ~48%
   * off a seat). An included allowance belongs in `cap`, which is counted rather
   * than credited, so a plan that says nothing gets the safe answer instead of
   * the one `checkPlansConfig` immediately flags as an error. A LEGACY config
   * still maps to `purchased_seats` — that was its behaviour, and changing it
   * would silently stop grants a live customer already receives.
   */
  grant?: Grant;
  /** Default: `seats` → per_seat, otherwise wallet. A POOL IS NEVER INFERRED —
   *  its size is a commercial decision, so it has to be written down. */
  cap?: Cap;
  replenish?: Replenish;
  /**
   * REQUIRED, and deliberately not inferable.
   *
   * Inferring "sellable" from `price > 0` is what let an agent buy a quote-only
   * Enterprise plan at its placeholder price. You cannot express "quote-only"
   * by accident.
   */
  sale: Sale;
  limits?: PlanLimits;
  display?: PlanDisplay;
}

// ── The legacy shape, unchanged ─────────────────────────────────────────────
//
// Both consumer apps declare `export const PLANS: PlansConfig = {…}` and then
// read `PLANS[k].price.monthly`. Turning `PlanDef` into a union would stop those
// reads compiling, so it keeps its exact fields and the normaliser maps it.

/** One seat type within a plan. @deprecated Prefer {@link SeatTypeSpec}. */
export interface SeatTypeDef {
  /** Per-seat recurring price (cents). 0 = free (no Stripe price). */
  price: IntervalPrice;
  /** Included credits granted per seat of THIS type, per billing cycle. */
  includedCredits: number;
  /** Optional cap on seats of this type (null/undefined = unlimited). */
  seats?: number | null;
  /** Optional display label. */
  label?: string;
}

export interface PlanDef {
  /** Max members per workspace. null = unlimited. */
  seats: number | null;
  /**
   * Included credits granted per seat, per billing cycle (flat model).
   * @deprecated Never reached the cap logic — it only ever sized a GRANT. Use
   * `grant: { kind: "per_member", credits }`, or `cap: { kind: "pool" }` if what
   * you meant was an included allowance.
   */
  creditsPerSeat: number;
  /** Recurring price in minor units. 0 = free (no Stripe price). */
  price: IntervalPrice;
  /** Per-seat-type prices + packs. */
  seatTypes?: Record<string, SeatTypeDef>;
  /**
   * @deprecated Use `cap`. `"per_seat"` is `cap: { kind: "per_seat" }`;
   * `"global"` is `cap: { kind: "wallet" }`.
   *
   * `"global"` never created an org-level pool — it only skipped the per-seat
   * cap, leaving the wallet as the sole gate. For an actual pool, say
   * `cap: { kind: "pool", credits: N }`.
   */
  allowanceMode?: "per_seat" | "global";
}

/** The all-legacy catalogue. Kept so `PLANS: PlansConfig` still type-checks. */
export type PlansConfig = Record<string, PlanDef>;

/** What library functions accept: a supertype, so a `PlansConfig` passes as-is. */
export type PlanCatalog = Record<string, PlanDef | PlanSpec>;

export const isLegacyPlan = (d: PlanDef | PlanSpec): d is PlanDef => !("sells" in d);

/**
 * Identity helper for a plans config.
 *
 * Annotating with `PlanCatalog` widens the keys to `string` and loses `display`
 * autocomplete; this keeps the literal types while still checking the shape.
 */
export function definePlans<T extends Record<string, PlanDef | PlanSpec>>(plans: T): T {
  return plans;
}

// ── The normalised form ─────────────────────────────────────────────────────

export interface NormalSeatType {
  key: string;
  price: IntervalPrice;
  includedCredits: number;
  min: number;
  max: number | null;
  shared: boolean;
  display: SeatTypeDisplay | null;
}

export interface PlanModel {
  key: string;
  sells: Sells;
  grant: Grant;
  cap: Cap;
  replenish: Replenish;
  sale: Sale;
  limits: { members: number | null; rate: readonly RateLimit[] };
  display: PlanDisplay | null;
  /** Intervals actually sold. Empty for `sells: nothing`; an annual-only
   *  commitment is `["yearly"]` and no monthly price is ever minted. */
  intervals: readonly BillingInterval[];
  /** Empty for flat and free plans. Config order. */
  seatTypes: readonly NormalSeatType[];
  /** Flat-plan price, or null. */
  price: IntervalPrice | null;
  /** True when the config used the pre-0.54 shape, so the doctor can say so. */
  legacy: boolean;
}

const hasPrice = (p: IntervalPrice): boolean => p.monthly > 0 || p.yearly > 0;

function normalizeSeatTypes(
  seatTypes: Record<string, SeatTypeSpec | SeatTypeDef>,
): NormalSeatType[] {
  return Object.entries(seatTypes).map(([key, s]) => {
    const legacy = s as SeatTypeDef;
    const spec = s as SeatTypeSpec;
    return {
      key,
      price: s.price,
      includedCredits: s.includedCredits ?? 0,
      min: spec.min ?? 0,
      // `seats` was the legacy name for a per-type cap.
      max: spec.max ?? legacy.seats ?? null,
      shared: spec.shared ?? false,
      display: spec.display ?? (legacy.label ? { label: legacy.label } : null),
    };
  });
}

/** Intervals a price actually exists for, so a plan can't advertise an interval
 *  Stripe has no price for. */
function soldIntervals(
  declared: readonly BillingInterval[] | undefined,
  price: IntervalPrice | null,
  seatTypes: readonly NormalSeatType[],
): readonly BillingInterval[] {
  if (declared) return declared;
  const has = (i: BillingInterval) =>
    (price ? price[i] > 0 : false) || seatTypes.some((s) => s.price[i] > 0);
  return INTERVALS.filter(has);
}

export function normalizePlan(key: string, spec: PlanDef | PlanSpec): PlanModel {
  if (!isLegacyPlan(spec)) {
    const seatTypes =
      spec.sells.kind === "seats" ? normalizeSeatTypes(spec.sells.seatTypes) : [];
    const price = spec.sells.kind === "flat" ? spec.sells.price : null;
    const declared = spec.sells.kind === "nothing" ? [] : spec.sells.intervals;
    return {
      key,
      sells: spec.sells,
      grant: spec.grant ?? { kind: "none" },
      cap: spec.cap ?? { kind: spec.sells.kind === "seats" ? "per_seat" : "wallet" },
      replenish: spec.replenish ?? {},
      sale: spec.sale,
      limits: { members: spec.limits?.members ?? null, rate: spec.limits?.rate ?? [] },
      display: spec.display ?? null,
      intervals: soldIntervals(declared, price, seatTypes),
      seatTypes,
      price,
      legacy: false,
    };
  }

  // Legacy. Every mapping here is behaviour-preserving; the property to hold is
  // that no legacy config can produce `cap: "pool"`, so the new entitlement
  // path stays dead until a config opts in.
  const seatTypes = spec.seatTypes ? normalizeSeatTypes(spec.seatTypes) : [];
  const sells: Sells = spec.seatTypes
    ? { kind: "seats", seatTypes: spec.seatTypes }
    : hasPrice(spec.price)
      ? { kind: "flat", price: spec.price }
      : { kind: "nothing" };
  const grant: Grant = spec.seatTypes
    ? { kind: "purchased_seats" }
    : hasPrice(spec.price)
      ? { kind: "per_member", credits: spec.creditsPerSeat }
      : { kind: "none" };
  return {
    key,
    sells,
    grant,
    // "global" meant "no cap", full stop.
    cap:
      spec.allowanceMode === "global"
        ? { kind: "wallet" }
        : { kind: "per_seat", onExhausted: "block" },
    replenish: {},
    // Not knowable from the legacy shape, so it is guessed from whether ANY
    // price exists — note a seat-typed plan whose every seat is 0 mints no
    // Stripe price and therefore cannot be bought, which the old `price > 0`
    // test on the plan-level amount got wrong in both directions. The doctor
    // warns either way, because guessing this is what sold a quote-only plan.
    sale: soldIntervals(undefined, sells.kind === "flat" ? spec.price : null, seatTypes).length === 0
      ? "free"
      : "self_serve",
    // The legacy shape cannot express a rate limit, so a legacy plan has none.
    limits: { members: spec.seats, rate: [] },
    display: null,
    intervals: soldIntervals(undefined, sells.kind === "flat" ? spec.price : null, seatTypes),
    seatTypes,
    price: sells.kind === "flat" ? spec.price : null,
    legacy: true,
  };
}

export function normalizePlans(plans: PlanCatalog): readonly PlanModel[] {
  return Object.entries(plans).map(([key, spec]) => normalizePlan(key, spec));
}

export function planModel(plans: PlanCatalog, key: string | null | undefined): PlanModel | null {
  if (!key) return null;
  const spec = plans[key];
  return spec ? normalizePlan(key, spec) : null;
}

/** Plan keys matching a predicate, e.g. `plansWhere(PLANS, p => p.sale === "self_serve")`.
 *  Replaces the several hand-maintained lists of "which plans can be bought". */
export function plansWhere(
  plans: PlanCatalog,
  predicate: (model: PlanModel) => boolean,
): string[] {
  return normalizePlans(plans)
    .filter(predicate)
    .map((m) => m.key);
}

/** Plans a customer can buy without talking to anyone. */
export const selfServePlans = (plans: PlanCatalog): string[] =>
  plansWhere(plans, (p) => p.sale === "self_serve" && p.sells.kind !== "nothing");

// ── Baskets ─────────────────────────────────────────────────────────────────

export type Quantities = Record<string, number>;

/** Where a seat stepper starts: each type's `min`, with the plan's `minSeats`
 *  absorbed by the first non-shared type so the default basket is already valid. */
export function defaultBasket(model: PlanModel): Quantities {
  const basket: Quantities = {};
  for (const s of model.seatTypes) basket[s.key] = s.min;
  if (model.sells.kind !== "seats") return basket;
  const min = model.sells.minSeats ?? 0;
  const total = Object.values(basket).reduce((a, b) => a + b, 0);
  if (total < min) {
    const first = model.seatTypes.find((s) => !s.shared) ?? model.seatTypes[0];
    if (first) basket[first.key] = (basket[first.key] ?? 0) + (min - total);
  }
  return basket;
}

export type BasketProblem =
  | { code: "unknown_plan" }
  | { code: "not_purchasable"; sale: Sale }
  | { code: "unknown_seat_type"; seatType: string }
  | { code: "below_minimum"; min: number; got: number }
  | { code: "seat_limit"; max: number; got: number }
  | { code: "seat_type_limit"; seatType: string; max: number; got: number }
  | { code: "member_limit"; max: number; got: number }
  | { code: "interval_unavailable"; interval: BillingInterval };

/**
 * Everything wrong with a basket, as data.
 *
 * Pure and network-free, so it can run in a stepper and at the checkout
 * boundary from one implementation. `seats` and the per-type caps were declared
 * for a long time and enforced nowhere: a crafted request could buy any
 * quantity of any seat type, including fifty of a seat meant to be unique.
 */
export function validateBasket(
  plans: PlanCatalog,
  opts: {
    plan: string;
    interval?: BillingInterval;
    seats?: Quantities;
    /** "purchase" also enforces `sale`. Use "display" to price a basket for a
     *  plan nobody may buy. */
    for?: "purchase" | "display";
  },
): BasketProblem[] {
  const model = planModel(plans, opts.plan);
  if (!model) return [{ code: "unknown_plan" }];

  const problems: BasketProblem[] = [];
  const purchasing = (opts.for ?? "purchase") === "purchase";
  if (purchasing && model.sale !== "self_serve") {
    problems.push({ code: "not_purchasable", sale: model.sale });
  }
  if (opts.interval && model.intervals.length && !model.intervals.includes(opts.interval)) {
    problems.push({ code: "interval_unavailable", interval: opts.interval });
  }
  if (model.sells.kind !== "seats") return problems;

  const seats = opts.seats ?? {};
  const known = new Map(model.seatTypes.map((s) => [s.key, s]));
  let total = 0;
  for (const [key, qty] of Object.entries(seats)) {
    if (qty <= 0) continue;
    const type = known.get(key);
    if (!type) {
      problems.push({ code: "unknown_seat_type", seatType: key });
      continue;
    }
    total += qty;
    if (type.max !== null && qty > type.max) {
      problems.push({ code: "seat_type_limit", seatType: key, max: type.max, got: qty });
    }
  }
  const min = model.sells.minSeats ?? 0;
  if (total < min) problems.push({ code: "below_minimum", min, got: total });
  const max = model.sells.maxSeats ?? null;
  if (max !== null && total > max) problems.push({ code: "seat_limit", max, got: total });
  const members = model.limits.members;
  if (members !== null && total > members) {
    problems.push({ code: "member_limit", max: members, got: total });
  }
  return problems;
}

/**
 * One-line summary of a basket problem, for an error a customer may read.
 *
 * English unless a `messages` bundle says otherwise — the same bundle the pricing
 * derivations take, so an app translates these once.
 */
export function describeBasketProblem(
  problem: BasketProblem,
  messages?: PartialMessages,
): string {
  const m = resolveMessages(messages);
  switch (problem.code) {
    case "unknown_plan":
      return m.unknownPlan;
    case "not_purchasable":
      return formatMessage(m.notPurchasable, { sale: problem.sale });
    case "unknown_seat_type":
      return formatMessage(m.unknownSeatType, { seatType: problem.seatType });
    case "below_minimum":
      return formatMessage(m.seatMinimum, { min: problem.min, got: problem.got });
    case "seat_limit":
      return formatMessage(m.seatMaximum, { max: problem.max, got: problem.got });
    case "seat_type_limit":
      return formatMessage(m.seatTypeMaximum, {
        max: problem.max,
        seatType: problem.seatType,
        got: problem.got,
      });
    case "member_limit":
      return formatMessage(m.memberMaximum, { max: problem.max, got: problem.got });
    case "interval_unavailable":
      return formatMessage(m.intervalUnavailable, { interval: problem.interval });
  }
}

// ── Allowance sizing ────────────────────────────────────────────────────────

/** Credits to GRANT for a paid cycle. Zero for `grant: none`, which is now the
 *  default for anything whose allowance is an entitlement. */
export function grantFor(
  model: PlanModel | null,
  ctx: { seatCounts?: Quantities; memberCount?: number },
): number {
  if (!model) return 0;
  switch (model.grant.kind) {
    case "none":
      return 0;
    case "fixed":
      return model.grant.credits;
    case "per_member":
      // The old flat path floored the count at 1 — a subscription with no
      // recorded members still granted one seat's worth.
      return model.grant.credits * Math.max(1, ctx.memberCount ?? 0);
    case "purchased_seats": {
      const counts = ctx.seatCounts ?? {};
      let sum = 0;
      for (const s of model.seatTypes) sum += s.includedCredits * (counts[s.key] ?? 0);
      return sum;
    }
  }
}

/** The org-wide entitlement for a cycle, or null when the plan has no pool.
 *  Falls back to the grant size when a plan both pools and credits. */
export function poolSizeOf(model: PlanModel | null): number | null {
  if (!model || model.cap.kind !== "pool") return null;
  if (model.cap.credits != null) return model.cap.credits;
  return model.grant.kind === "fixed" ? model.grant.credits : 0;
}

/** The pack a caller is entitled to for the cycle, or null when uncapped. */
export function packSizeOf(model: PlanModel | null, seatType: string | undefined): number | null {
  if (!model || model.cap.kind !== "per_seat" || !seatType) return null;
  const type = model.seatTypes.find((s) => s.key === seatType);
  return type ? type.includedCredits : null;
}

/**
 * What to do when a window is used up.
 *
 * An agent's usage overflows into the wallet; a person's blocks. That was
 * previously a hardcoded `caller.kind === "user"` test in the meter, so the
 * caller kind is still honoured — a legacy config has no way to mark a seat type
 * as shared, and changing behaviour for it silently is not on. A config that
 * DOES declare `shared: true` gets the same answer without depending on how the
 * call arrived.
 */
export function exhaustedPolicy(
  model: PlanModel | null,
  caller?: { seatType?: string; kind?: "user" | "api" },
): Exhausted {
  if (!model) return "wallet";
  if (caller?.kind === "api") return "wallet";
  const type = caller?.seatType
    ? model.seatTypes.find((s) => s.key === caller.seatType)
    : undefined;
  if (type?.shared) return "wallet";
  if (model.cap.kind === "pool") return model.cap.onExhausted ?? "block";
  if (model.cap.kind === "per_seat") return model.cap.onExhausted ?? "block";
  return "wallet";
}

/**
 * Whether this caller draws the plan's included window at all.
 *
 * False only for a machine caller on a plan whose cap declares `covers: "users"`.
 * A `shared` seat counts as a machine caller for the same reason it does in
 * `exhaustedPolicy`: the seat exists to be drawn by agents.
 */
export function capCovers(
  model: PlanModel | null,
  caller?: { seatType?: string; kind?: "user" | "api" },
): boolean {
  if (!model) return true;
  const covers =
    model.cap.kind === "per_seat" || model.cap.kind === "pool" ? (model.cap.covers ?? "all") : "all";
  if (covers === "all") return true;
  if (caller?.kind === "api") return false;
  const type = caller?.seatType
    ? model.seatTypes.find((s) => s.key === caller.seatType)
    : undefined;
  return !type?.shared;
}

// ── Cycle windows ───────────────────────────────────────────────────────────

export interface CycleWindow {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. Null when open-ended (no subscription period known). */
  end: number | null;
  /** Stable identity, for per-cycle records like top-up grants. */
  key: string;
}

const startOfMonthUTC = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/**
 * The window usage is measured over.
 *
 * The SUBSCRIPTION period, when one is known — an annual pool measured over
 * calendar months would reset twelve times a year, handing out twelve times the
 * package. The calendar month remains the fallback for an org with no
 * subscription (a free plan, or a pure wallet), which is what this library did
 * unconditionally before.
 *
 * `rollover` widens the window to the subscription's start instead, which is all
 * "unused allowance carries over" has to mean.
 */
/**
 * The aligned window a rate limit is measured over, and when it resets.
 *
 * Aligned to UTC so the answer is the same everywhere and a reset time can be
 * stated: top of the hour, midnight, MONDAY midnight, the 1st. `cycle` defers to
 * the subscription period (`cycleWindowFor`), which is the only window whose
 * boundaries belong to the customer rather than the calendar.
 *
 * `end` is always known here — that is the point of a fixed window, and what
 * lets a usage screen count down to the reset.
 */
export function rateWindowFor(
  every: Every,
  now: number = Date.now(),
  cycle?: CycleWindow,
): CycleWindow {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const iso = (ms: number) => new Date(ms).toISOString();
  switch (every) {
    case "hour": {
      const start = Date.UTC(y, mo, day, d.getUTCHours());
      return { start, end: start + 3_600_000, key: `h:${iso(start).slice(0, 13)}` };
    }
    case "day": {
      const start = Date.UTC(y, mo, day);
      return { start, end: start + 86_400_000, key: `d:${iso(start).slice(0, 10)}` };
    }
    case "week": {
      // getUTCDay is 0 for Sunday, so shift to a Monday-based week.
      const back = (d.getUTCDay() + 6) % 7;
      const start = Date.UTC(y, mo, day - back);
      return { start, end: start + 7 * 86_400_000, key: `w:${iso(start).slice(0, 10)}` };
    }
    case "month": {
      const start = Date.UTC(y, mo, 1);
      return { start, end: Date.UTC(y, mo + 1, 1), key: `m:${iso(start).slice(0, 7)}` };
    }
    case "cycle":
      return cycle ?? { start: Date.UTC(y, mo, 1), end: Date.UTC(y, mo + 1, 1), key: `m:${iso(Date.UTC(y, mo, 1)).slice(0, 7)}` };
  }
}

/**
 * The limits that apply to this caller, in declaration order.
 *
 * A limit with a `seatType` applies only to callers holding it, so a plan can cap
 * an agent's burst rate without capping a person's. A limit with no caller at all
 * (an org-level read, or a usage screen with no member selected) keeps only the
 * org-scoped ones — a caller window means nothing without a caller.
 */
export function rateLimitsOf(
  model: PlanModel | null,
  caller?: { seatType?: string; kind?: "user" | "api" } | null,
): readonly RateLimit[] {
  if (!model) return [];
  return model.limits.rate.filter((l) => {
    const scope = l.scope ?? "org";
    if (scope === "caller" && !caller) return false;
    if (l.seatType && caller?.seatType !== l.seatType) return false;
    // A limit for machines does not apply to a person, and vice versa. An
    // org-scoped limit with no `callerKind` still applies to everyone.
    if (l.callerKind && caller?.kind && l.callerKind !== caller.kind) return false;
    if (l.callerKind && !caller?.kind) return false;
    return true;
  });
}

export function cycleWindowFor(
  model: PlanModel | null,
  period: { start?: string | number | null; end?: string | number | null } | null,
  now: number = Date.now(),
): CycleWindow {
  const ms = (v: string | number | null | undefined): number | null =>
    v == null ? null : typeof v === "number" ? v : Date.parse(v) || null;
  const start = ms(period?.start);
  const end = ms(period?.end);
  const rollover = model?.cap.kind === "pool" && model.cap.rollover === true;
  // A cap declared per MONTH ignores the subscription period and takes the
  // calendar-month branch below. It is handled HERE rather than at the read sites
  // because this function is the one definition of the cycle: the meter, the usage
  // screens and `grantExtraAllowance` all key on what it returns, and a window
  // that disagreed with the key is exactly the defect that made approved top-ups
  // grant nothing (see AGENTS.md, "Cycles — one definition").
  const monthly =
    (model?.cap.kind === "per_seat" || model?.cap.kind === "pool") &&
    model.cap.window === "month";

  if (start && !monthly && (rollover || start <= now)) {
    const from = start;
    const until = rollover ? null : end;
    return { start: from, end: until, key: new Date(from).toISOString().slice(0, 10) };
  }
  // The calendar-month fallback DOES know when it ends, so it says so: a usage
  // screen showing an included window with no reset time is the one row that
  // cannot answer "when do I get more", and on a free plan (no subscription, so
  // always this branch) that is every row that matters.
  const d = new Date(now);
  const month = startOfMonthUTC(now);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start: month, end: nextMonth, key: new Date(month).toISOString().slice(0, 7) };
}
