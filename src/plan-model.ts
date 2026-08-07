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
// One flat shape can only really express one product. Fold the axes together and
// an org-level package — "we don't care about seats, here are N tool requests" —
// becomes unrepresentable. What varies between products is five independent things:
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
  /**
   * Short form for a badge or a chip: "Standard", where `label` is "Standard
   * seat". A pricing card has room for the noun; the pill on a usage screen that
   * says which seat you hold does not, and truncating `label` there is the app
   * guessing at where the word ends.
   */
  badge?: Localized;
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

/** The seat type a member is assumed to hold when nothing says otherwise. */
export const DEFAULT_SEAT_TYPE = "standard";

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
       * The package size PER SEAT instead of a flat number: the pool is
       * `perSeat × seats`, shared across the workspace.
       *
       * This is the rung between a flat pool and `per_seat`, and it exists because
       * a promise and an enforcement are different things. "1 000 credits per seat
       * per month" is what a pricing page says; `per_seat` additionally *enforces*
       * it member by member, which is a stricter product than most teams sell and
       * the only shape that needs a per-member counter to gate. Pooled, the same
       * promise is one org-wide window — countable by a single Stripe meter
       * summary at any volume, with no per-member store anywhere.
       *
       * The trade is fairness: one member can draw the team's share. Say
       * `per_seat` when that matters.
       *
       * **`"included"` sums each seat TYPE's own `includedCredits` × its purchased
       * quantity**, which is the only form that can express a plan with more than
       * one tier. A number cannot: 3 Standard (1 000 each) + 1 Premium (5 000)
       * should pool 8 000, and `perSeat: 1_000` gives 4 000 while `perSeat: 5_000`
       * gives 20 000 — one under-delivers against the pricing page and the other
       * hands Standard seats five times what they paid for. Use a number only when
       * every tier includes the same amount, or there is one tier.
       *
       * Seats are the PURCHASED quantity when the adapter reports one
       * (`getSubscription().seatCounts` / `.seats`), falling back to the active
       * member count, then to 1. Purchased rather than active on purpose: a
       * workspace that bought ten seats and filled six paid for ten.
       *
       * Mutually exclusive with `credits`.
       */
      perSeat?: Money | "included";
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
  /**
   * Self-serve credit purchase.
   *
   * `min`/`max` are what ONE purchase may be, in currency units — the bounds `buy_credits`
   * and `preview_credit_purchase` enforce. They were literals in the tool schema (5 and
   * 200 000) and again in every consumer's buy form, which is two places for one rule and
   * exactly the kind that drifts silently: a UI that lets someone type 3 gets a 400 from a
   * tool whose own description promised 5.
   */
  purchase?: { packs?: readonly Money[]; min?: Money; max?: Money };
  /**
   * Threshold-triggered card charge. These are the DEFAULTS the plan offers;
   * the live per-customer settings stay on the Stripe customer, because a
   * customer's threshold and card are theirs, not the plan's.
   */
  autoReload?: { threshold: Money; reloadTo: Money; enabledByDefault?: boolean };
  /**
   * Member asks, owner approves (see topup.ts). Raises that member's pack for the cycle;
   * never credits the wallet.
   *
   * `percent` is what ONE ask is worth, as a share of that member's own seat pack — the
   * same unit `grantExtraAllowance` uses, and for the same reason: "a quarter more" means
   * the same thing on a 1 000-credit seat and a 5 000-credit one. It exists because the
   * person asking should not have to name a number: they know they are out, not what a
   * reasonable top-up is. Default 25.
   *
   * `maxPerCycle` caps what one member may accumulate in a cycle, counting what is already
   * granted AND what is already queued.
   */
  request?: {
    percent?: number;
    maxPerCycle?: Money;
    /**
     * The most one grant may be worth, as a share of the member's pack. Default 500.
     *
     * A ceiling exists because this is a number an owner types: `percent: 2500` is a typo
     * that hands out 25× a seat, silently and for free. The consuming app clamped it in its
     * own server action and again in its number input, and the tool accepted 1000 — three
     * answers, and the one an agent hit was the loosest.
     */
    maxPercent?: number;
    /** The percentages a UI offers as one-tap choices. Default `[25, 50, 100]`. */
    presets?: readonly number[];
    /** Step for a custom percentage input. Default 25. */
    step?: number;
  };
}

/** What one credit purchase may be, for this plan: the bounds the tools enforce and the
 *  ones a buy form must not contradict. Currency units, not credits. */
export function purchaseBounds(model: PlanModel | null): { min: number; max: number } {
  return {
    min: model?.replenish.purchase?.min ?? DEFAULT_PURCHASE_MIN,
    max: model?.replenish.purchase?.max ?? DEFAULT_PURCHASE_MAX,
  };
}

/** What one grant/ask may be worth, for this plan, plus what a UI should offer. */
export function requestBounds(model: PlanModel | null): {
  percent: number;
  maxPercent: number;
  presets: readonly number[];
  step: number;
} {
  const r = model?.replenish.request;
  return {
    percent: r?.percent ?? DEFAULT_REQUEST_PERCENT,
    maxPercent: r?.maxPercent ?? DEFAULT_MAX_PERCENT,
    presets: r?.presets ?? DEFAULT_PERCENT_PRESETS,
    step: r?.step ?? DEFAULT_PERCENT_STEP,
  };
}

/** One purchase, in currency units. Stripe's own floor is well below this; 5 is the point
 *  where the processing fee stops eating the purchase. */
export const DEFAULT_PURCHASE_MIN = 5;
export const DEFAULT_PURCHASE_MAX = 200_000;
/** What one ask is worth when the plan does not say: a quarter of the member's pack. */
export const DEFAULT_REQUEST_PERCENT = 25;
/** And the most any single grant may be, so a mistyped 2500 cannot hand out 25× a seat. */
export const DEFAULT_MAX_PERCENT = 500;
export const DEFAULT_PERCENT_PRESETS: readonly number[] = [25, 50, 100];
export const DEFAULT_PERCENT_STEP = 25;

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
  /**
   * WHAT the window governs. Default `all` — today's behaviour, unchanged.
   *
   * `all` is a pace cap on the PRODUCT: nothing lifts it, not a wallet and not a top-up,
   * and the caller waits. Right for "600 an hour" against an agent, where the thing being
   * protected is the infrastructure.
   *
   * `included` is a pace cap on the ALLOWANCE: it governs what the plan gives away, and
   * paid usage carries on past it. Right for "500 a week each" on a plan whose card says
   * pay-as-you-go — because under `all` a workspace with credits already bought sits
   * refused for three days, which is not what pay-as-you-go means. It is the shape Claude's
   * own weekly limit has: included usage stops, usage credits continue.
   *
   * The distinction is not cosmetic to the reads either: an `included` window counts only
   * included usage, so wallet-funded calls neither fill it nor are refused by it.
   */
  covers?: "all" | "included";
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
   * the one `checkPlansConfig` immediately flags as an error.
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
  /**
   * The seat a member occupies on a plan that does NOT sell seats.
   *
   * A free or flat plan still seats people — they just aren't line items — and a
   * screen that badges "which seat do I hold" had nothing to show for them, while
   * the meter quietly filed them under `standard` (a seat type such a plan does
   * not even declare). Naming it here makes that seat sayable: `{ key: "solo",
   * display: { badge: "Solo" } }`.
   *
   * Ignored when `sells.kind === "seats"` — there the SOLD seat types are the
   * seat types, and a second answer would be a second source of truth.
   */
  seat?: { key?: string; display?: SeatTypeDisplay };
}

/** What library functions accept. Was a supertype of the pre-0.54 `PlanDef` too,
 *  until 4.0.0 removed it — see the note on `definePlans`. */
export type PlanCatalog = Record<string, PlanSpec>;

/**
 * Identity helper for a plans config.
 *
 * Annotating with `PlanCatalog` widens the keys to `string` and loses `display`
 * autocomplete; this keeps the literal types while still checking the shape.
 */
export function definePlans<T extends Record<string, PlanSpec>>(plans: T): T {
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
  /**
   * The implicit seat of a plan that sells none, normalised. Null when the plan
   * sells seats (they are in `seatTypes`) or when the config didn't name one.
   */
  seat: { key: string; display: SeatTypeDisplay | null } | null;
  /** Flat-plan price, or null. */
  price: IntervalPrice | null;
}

function normalizeSeatTypes(seatTypes: Record<string, SeatTypeSpec>): NormalSeatType[] {
  return Object.entries(seatTypes).map(([key, spec]) => ({
    key,
    price: spec.price,
    includedCredits: spec.includedCredits ?? 0,
    min: spec.min ?? 0,
    max: spec.max ?? null,
    shared: spec.shared ?? false,
    display: spec.display ?? null,
  }));
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

export function normalizePlan(key: string, spec: PlanSpec): PlanModel {
  const seatTypes = spec.sells.kind === "seats" ? normalizeSeatTypes(spec.sells.seatTypes) : [];
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
    seat:
      spec.sells.kind === "seats" || !spec.seat
        ? null
        : { key: spec.seat.key ?? DEFAULT_SEAT_TYPE, display: spec.seat.display ?? null },
    price,
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

// ── What the catalogue implies about the TOOL surface ───────────────────────

/**
 * Which groups of billing tools a catalogue can actually satisfy.
 *
 * Every precondition here is already declared on the plan, so registration can
 * read it instead of taking a boolean per group. The failure this closes: an app
 * whose plans sell no seats and accept no top-up REQUESTS still registered
 * `list_seats`, `assign_seat_type` and the five top-up tools — seven tools that
 * answered `seat_types: []`, refused with "(none configured)", or queued a grant
 * against an allowance the plan does not have. An agent cannot tell a tool that
 * will always fail from one it is holding wrong, so a dead tool is not merely
 * wasted context; it is a false advertisement of what the product does.
 *
 * The union across plans is deliberate: a tool must exist for a caller on ANY
 * plan to discover it, and the per-call decision still belongs to the engine
 * (`enforceAccess`, then that org's own plan). This says what the catalogue can
 * ever need, not what today's caller may do.
 */
export interface ToolCapabilities {
  /** `buy_credits`, `preview_credit_purchase` — any plan sells top-ups. */
  purchase: boolean;
  /** `set_auto_reload` — any plan offers threshold-triggered reloading. */
  autoReload: boolean;
  /** The five top-up tools — any plan lets a member ask and an owner approve. */
  request: boolean;
  /** `list_seats`, `assign_seat_type` — any plan sells seats to assign. */
  seats: boolean;
  /** `change_plan` and friends — any plan can be bought without a salesperson. */
  lifecycle: boolean;
  /** `get_usage`, `get_usage_limits` — any plan includes or paces usage. */
  usage: boolean;
}

/** Every group on. What a consumer that passes no catalogue keeps getting. */
export const ALL_TOOL_CAPABILITIES: ToolCapabilities = {
  purchase: true,
  autoReload: true,
  request: true,
  seats: true,
  lifecycle: true,
  usage: true,
};

export function toolCapabilities(plans: PlanCatalog): ToolCapabilities {
  const models = normalizePlans(plans);
  const any = (predicate: (m: PlanModel) => boolean) => models.some(predicate);
  return {
    purchase: any((m) => Boolean(m.replenish.purchase)),
    autoReload: any((m) => Boolean(m.replenish.autoReload)),
    request: any((m) => Boolean(m.replenish.request)),
    seats: any((m) => m.sells.kind === "seats"),
    lifecycle: any((m) => m.sale === "self_serve"),
    // A `wallet` cap includes nothing and so has no window to report — but a rate
    // limit is a window too, and it is the one refusal a caller can wait out, so
    // a plan that paces an uncapped wallet still needs the usage tools to say
    // when. Enterprise (`cap: wallet` + a weekly limit) is exactly that shape.
    usage: any((m) => m.cap.kind !== "wallet" || m.limits.rate.length > 0),
  };
}

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

/**
 * The org-wide entitlement for a cycle, or null when the plan has no pool.
 * Falls back to the grant size when a plan both pools and credits.
 *
 * `seats` is only read by a `perSeat` pool, and takes either form:
 *
 *   a NUMBER  — total purchased seats. All `perSeat: <number>` needs.
 *   a RECORD  — seat type → purchased quantity. What `perSeat: "included"`
 *               needs, since it multiplies each tier by its OWN allowance.
 *
 * It defaults to one seat rather than throwing, so a pricing surface with no org
 * in hand still gets a per-seat unit to display, and a caller that forgets it
 * under-reports the pool rather than over-granting it. Given a total where the mix
 * is needed, the SMALLEST tier is assumed for the same reason — a wrong number
 * that refuses too early is recoverable; one that hands out allowance nobody paid
 * for is not. `resolveAllowance` resolves the real counts; see `seatsFor`.
 */
export function poolSizeOf(
  model: PlanModel | null,
  seats?: number | Record<string, number>,
): number | null {
  if (!model || model.cap.kind !== "pool") return null;
  const { perSeat } = model.cap;

  if (perSeat === "included") {
    const counts = typeof seats === "object" && seats ? seats : null;
    if (counts) {
      let sum = 0;
      for (const s of model.seatTypes) sum += s.includedCredits * (counts[s.key] ?? 0);
      // A count that matches no declared seat type sums to 0, which would refuse
      // every call. Fall through to the floor below rather than to nothing.
      if (sum > 0) return sum;
    }
    const total = typeof seats === "number" ? Math.max(1, seats) : 1;
    const smallest = model.seatTypes.reduce(
      (min, s) => Math.min(min, s.includedCredits),
      Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(smallest) ? smallest * total : 0;
  }

  if (perSeat != null) {
    const total =
      typeof seats === "object" && seats
        ? Object.values(seats).reduce((a, b) => a + b, 0)
        : (seats ?? 1);
    return perSeat * Math.max(1, total);
  }
  if (model.cap.credits != null) return model.cap.credits;
  return model.grant.kind === "fixed" ? model.grant.credits : 0;
}

/** Whether this plan's pool is sized by seat count — i.e. whether a caller has to
 *  resolve one before `poolSizeOf` means anything. */
export function poolIsPerSeat(model: PlanModel | null): boolean {
  return model?.cap.kind === "pool" && model.cap.perSeat != null;
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

// ── What a ledger has to be able to count ───────────────────────────────────
//
// The rule that decides whether a config can be metered lived in three places —
// `createBilling`'s boot warning, `checkPlansConfig`, and a paragraph of
// AGENTS.md — and the three had already drifted: two of them asked only about
// per-MEMBER windows, so a pooled plan on a wallet-only ledger passed every check
// while counting nothing. It is one question asked twice, so it is written once
// here, in the module that has no Stripe dependency, and every caller reads it.
//
// The question is not "is a store wired". It is which of two windows the ledger
// can see, because an INCLUDED call moves no money and a ledger built on money
// cannot see it at all.

/** What a `UsageLedger` implementation can count. Declared by the ledger itself
 *  (`covers`), so a config check needs no knowledge of which one is in use. */
export type LedgerCoverage = {
  /** Can count an ORG-wide window including usage the wallet didn't fund
   *  (`cap: pool`, `scope: "org"` limits, the spend limit). */
  orgIncluded: boolean;
  /** Can count a PER-CALLER window including usage the wallet didn't fund
   *  (`cap: per_seat`, `scope: "caller"` limits). */
  callerIncluded: boolean;
};

/**
 * Every window a ledger must be able to count for this plan to be enforceable.
 * A `cap: wallet` plan needs neither: nothing is included, so every call moves
 * money and the debits are their own record.
 *
 * The `callerIncluded` half asks TWO questions, because it used to ask one and
 * was wrong in both directions against the reads `resolveAllowance` actually
 * issues (`allowance.ts`):
 *
 *   1. is the read CALLER-FILTERED? `scope: "caller"` is not the only way — an
 *      org-scoped limit carrying `callerKind` is summed across the workspace but
 *      still filtered to that kind, so it is issued as `{callerKind}` and routed
 *      to the per-caller leg. Asking only about `scope` filed it under
 *      `orgIncluded`, so it passed every check and then read 0 forever: a limit
 *      that never applies, which looks like generosity rather than a fault.
 *
 *   2. can the usage behind it be INCLUDED? A caller-filtered read over usage the
 *      wallet always funds is answered exactly, and with no lag, by the debits —
 *      no store required. That is the case for every `cap: wallet` plan, and for
 *      an `api` caller under `cap.covers: "users"`, which excludes machines from
 *      the included window and funds them from the wallet on their first call.
 *      Asking only about `scope` rejected those configs, demanding a store for a
 *      question Stripe already answers.
 */
export function coverageNeededBy(model: PlanModel): LedgerCoverage {
  const included = (kind: "user" | "api" | undefined): boolean => {
    if (model.cap.kind === "wallet") return false;
    // `covers: "users"` skips the window entirely for a machine caller, so its
    // usage is wallet-funded from the first call. With no `callerKind` the limit
    // reaches people too, and theirs is included.
    if (kind === "api" && !capCovers(model, { kind: "api" })) return false;
    return true;
  };
  return {
    orgIncluded:
      model.cap.kind === "pool" || model.limits.rate.some((l) => (l.scope ?? "org") === "org"),
    callerIncluded:
      model.cap.kind === "per_seat" ||
      model.limits.rate.some(
        (l) => ((l.scope ?? "org") === "caller" || l.callerKind != null) && included(l.callerKind),
      ),
  };
}

/**
 * The plans whose included windows `covers` cannot count, split by cause.
 *
 * Both causes are the same silent failure — the window reads 0, so it never
 * applies and nothing is ever refused, which looks exactly like generosity — but
 * they have different fixes, which is why they are reported apart: an org-wide gap
 * is closed by a Stripe meter (no store), a per-caller one needs a store.
 */
export function ledgerGaps(
  models: readonly PlanModel[],
  covers: LedgerCoverage,
): { org: PlanModel[]; caller: PlanModel[] } {
  const org: PlanModel[] = [];
  const caller: PlanModel[] = [];
  for (const m of models) {
    const needs = coverageNeededBy(m);
    if (needs.orgIncluded && !covers.orgIncluded) org.push(m);
    if (needs.callerIncluded && !covers.callerIncluded) caller.push(m);
  }
  return { org, caller };
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
