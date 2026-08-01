import { getBillingCustomerId, getTokenBalance } from "./billing.js";
import { formatMessage, resolveMessages, type PartialMessages } from "./i18n.js";
import {
  cycleWindowFor,
  exhaustedPolicy,
  packSizeOf,
  planModel,
  poolSizeOf,
  rateLimitsOf,
  rateWindowFor,
  type CycleWindow,
  type Every,
  type PlanCatalog,
  type PlanModel,
} from "./plan-model.js";
import { extraAllowance } from "./topup.js";
import type { BillingAdapter, ResolvedConfig } from "./types.js";
import { stripeBalanceUsageLedger, type FundingSource, type UsageLedger } from "./usage-ledger.js";

// What an org is allowed to spend right now, and which allowance pays for the
// next call.
//
// Split out of the meter for two reasons. It is the same question a usage screen
// asks ("how much of my plan have I used?"), which previously had no answer to
// read — remaining allowance was only ever implicit in a failed call. And the
// decision itself is pure arithmetic, so pulling it out of the Stripe round trips
// makes it testable, which the meter was not.

/** One declared rate limit, with the window it is being measured over. */
export interface LimitState {
  every: Every;
  scope: "org" | "caller";
  /** From the config; null when the plan didn't label it. */
  label: string | null;
  size: number;
  used: number;
  remaining: number;
  /** The aligned window. `end` is always known, so a UI can count down to it. */
  window: CycleWindow;
}

export interface AllowanceState {
  plan: string | null;
  cycle: CycleWindow;
  /**
   * Every rate limit that applies right now, in config order. A call must fit
   * inside ALL of them; unlike pool/pack/wallet these fund nothing, they only
   * refuse.
   */
  limits: LimitState[];
  /** The org-wide included window, when the plan has one. */
  pool: { size: number; used: number; remaining: number } | null;
  /** The caller's seat pack, when the plan caps per seat and the caller has one. */
  pack: {
    seatType: string;
    size: number;
    used: number;
    /** Owner-approved top-up for this member, this cycle. */
    extra: number;
    remaining: number;
  } | null;
  /** Prepaid balance, in the configured currency. Clamped at 0 for display. */
  wallet: number;
}

export interface AllowanceInput {
  orgId: string;
  plans: PlanCatalog;
  /** Resolved plan key, or null for an org with no plan (a pure wallet). */
  plan?: string | null;
  caller?: { kind: "user" | "api"; id?: string; seatType?: string };
  /** Defaults to the customer on the adapter. */
  customerId?: string;
  /** Overrides the window derived from the subscription period. */
  cycle?: CycleWindow;
  ledger?: UsageLedger;
  /** Skip the wallet read — for a caller that only needs the entitlement. */
  skipWallet?: boolean;
  /** Pin the clock. Every rate window is derived from it, so a test can place
   *  itself inside a window instead of waiting for one. Defaults to now. */
  now?: number;
}

/**
 * Everything needed to decide whether a call is allowed, read in as few round
 * trips as the shape requires.
 *
 * The window comes from the SUBSCRIPTION period when one is known, not the
 * calendar month: an annual package measured monthly would reset twelve times and
 * hand out twelve packages. The calendar month remains the fallback for an org
 * with no subscription, which is what this library always did.
 */
/**
 * The cycle the meter is measuring right now — the ONE definition of "this
 * cycle" in the library.
 *
 * It is exported because anything that files something against a cycle has to
 * agree with the thing that reads it back. A top-up grant stored under a key the
 * meter never looks up is not a smaller grant, it is no grant at all, and it
 * fails silently: the approval succeeds, the balance never moves. That is
 * exactly what happened while `request_top_up` computed its own calendar month
 * and the meter used the subscription period.
 */
export async function currentCycle(
  adapter: BillingAdapter,
  input: { orgId: string; plans?: PlanCatalog; plan?: string | null; now?: number },
): Promise<CycleWindow> {
  const model = planModel(input.plans ?? {}, input.plan ?? null);
  const now = input.now ?? Date.now();
  return cycleWindowFor(model, await subscriptionPeriod(adapter, input.orgId, model), now);
}

/** The calendar-month key this library used before the window came from the
 *  subscription. Read-only fallback, so grants filed under it still apply. */
export function legacyCycleKey(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function resolveAllowance(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: AllowanceInput,
): Promise<AllowanceState> {
  const model = planModel(input.plans, input.plan ?? null);
  const now = input.now ?? Date.now();
  const customerId = input.customerId ?? (await getBillingCustomerId(adapter, input.orgId));
  const period = await subscriptionPeriod(adapter, input.orgId, model);
  const cycle = input.cycle ?? cycleWindowFor(model, period, now);
  const ledger = input.ledger ?? stripeBalanceUsageLedger();

  if (!customerId) {
    return { plan: model?.key ?? null, cycle, limits: [], pool: null, pack: null, wallet: 0 };
  }

  const poolSize = poolSizeOf(model);
  const packSize = packSizeOf(model, input.caller?.seatType);

  // Each applicable limit is one more summed read over its own window. They go
  // in the same round of parallel reads as the pool and the pack, so a plan with
  // an hourly + weekly + monthly limit costs the meter latency, not four times it.
  const rateLimits = rateLimitsOf(model, input.caller);
  const limitReads = rateLimits.map((limit) => {
    const scope = limit.scope ?? "org";
    const window = rateWindowFor(limit.every, now, cycle);
    return ledger
      .total({
        orgId: input.orgId,
        customerId,
        start: window.start,
        end: window.end ?? undefined,
        filter:
          scope === "caller"
            ? input.caller?.kind === "api"
              ? { callerKind: "api" }
              : { callerKind: "user", callerId: input.caller?.id }
            : undefined,
      })
      .then((used) => ({
        every: limit.every,
        scope,
        label: limit.label ?? null,
        size: limit.tokens,
        used,
        remaining: Math.max(0, limit.tokens - used),
        window,
      }));
  });

  const [wallet, poolUsed, packUsed, extra, limits] = await Promise.all([
    input.skipWallet ? Promise.resolve(0) : getTokenBalance(customerId, config.currency),
    poolSize == null
      ? Promise.resolve(0)
      : ledger.total({ orgId: input.orgId, customerId, start: cycle.start, end: cycle.end ?? undefined }),
    packSize == null
      ? Promise.resolve(0)
      : ledger.total({
          orgId: input.orgId,
          customerId,
          start: cycle.start,
          end: cycle.end ?? undefined,
          // A pack belongs to a caller, so it is measured per caller. An api
          // caller's usage is summed across the org — there is one shared seat.
          filter:
            input.caller?.kind === "api"
              ? { callerKind: "api" }
              : { callerKind: "user", callerId: input.caller?.id },
        }),
    // Top-up grants raise a member's pack for the cycle, keyed by the cycle
    // identity `currentCycle` produces — the same one the approving tool writes,
    // which is now guaranteed by both going through that function. The legacy
    // calendar key is read as a fallback so grants approved before the two
    // agreed still apply instead of vanishing.
    packSize == null || input.caller?.kind !== "user" || !input.caller.id
      ? Promise.resolve(0)
      : extraAllowance(adapter, input.orgId, input.caller.id, cycle.key, legacyCycleKey(now)),
    Promise.all(limitReads),
  ]);

  return {
    plan: model?.key ?? null,
    cycle,
    limits,
    pool:
      poolSize == null
        ? null
        : { size: poolSize, used: poolUsed, remaining: Math.max(0, poolSize - poolUsed) },
    pack:
      packSize == null || !input.caller?.seatType
        ? null
        : {
            seatType: input.caller.seatType,
            size: packSize,
            used: packUsed,
            extra,
            remaining: Math.max(0, packSize + extra - packUsed),
          },
    wallet: Math.max(0, wallet),
  };
}

/** The subscription's current period, when the adapter can tell us and the plan
 *  actually needs it (only a window does). */
async function subscriptionPeriod(
  adapter: BillingAdapter,
  orgId: string,
  model: PlanModel | null,
): Promise<{ start?: string | null; end?: string | null } | null> {
  if (!model) return null;
  // A `cycle` rate limit needs the period just as much as a cap does; without
  // this it would silently fall back to the calendar month.
  const needsPeriod =
    model.cap.kind !== "wallet" || model.limits.rate.some((l) => l.every === "cycle");
  if (!needsPeriod) return null;
  if (!adapter.getSubscription) return null;
  try {
    const sub = await adapter.getSubscription(orgId);
    return { start: sub.periodStart ?? null, end: sub.periodEnd ?? null };
  } catch {
    return null;
  }
}

export type DenialReason =
  | "rate_limit_reached"
  | "pool_exhausted"
  | "seat_allowance_reached"
  | "insufficient_balance";

export interface FundingDecision {
  ok: boolean;
  source: FundingSource | null;
  reason?: DenialReason;
  /** Which limit refused, when the reason is `rate_limit_reached`. */
  limit?: LimitState;
}

/**
 * Which allowance pays for `cost` — or why nothing does.
 *
 * PURE: no Stripe, no adapter, no clock. The order is the point:
 *
 *  1. the org's included window, if the plan has one;
 *  2. the caller's seat pack, if the plan caps per seat;
 *  3. the prepaid wallet.
 *
 * An exhausted window either blocks or falls through to the wallet, per the
 * plan's `onExhausted`. Blocking even when the wallet could pay is the right
 * default for a committed package (its overage is a renegotiation, not a silent
 * charge) and for a free plan; falling through is right where top-ups are the
 * product. Checking the wallet LAST is also what stops a pooled org being told
 * "insufficient balance" when the truth is "your package is used up".
 */
export function fundingFor(
  state: AllowanceState,
  model: PlanModel | null,
  cost: number,
  caller?: { kind: "user" | "api"; seatType?: string },
): FundingDecision {
  if (cost <= 0) return { ok: true, source: null };

  // Rate limits come FIRST and are absolute. They are not a funding source and
  // nothing overrides them: no wallet fallthrough (a limit a top-up could lift is
  // not a limit) and no exemption for a shared seat, because the thing being
  // protected is the product, not the customer's money. The tightest window that
  // refuses is the one reported, so the message names a week rather than a month
  // when the week is what ran out.
  for (const limit of state.limits ?? []) {
    if (limit.remaining < cost) {
      return { ok: false, source: null, reason: "rate_limit_reached", limit };
    }
  }

  if (state.pool) {
    if (state.pool.remaining >= cost) return { ok: true, source: "pool" };
    if (exhaustedPolicy(model, caller) === "block") {
      return { ok: false, source: null, reason: "pool_exhausted" };
    }
  }

  if (state.pack) {
    if (state.pack.remaining >= cost) return { ok: true, source: "pack" };
    if (exhaustedPolicy(model, caller) === "block") {
      return { ok: false, source: null, reason: "seat_allowance_reached" };
    }
  }

  if (state.wallet >= cost) return { ok: true, source: "wallet" };
  return { ok: false, source: null, reason: "insufficient_balance" };
}

/** Window names for the library's own English messages. A UI localises from
 *  `every` (or the plan's `label`) instead of parsing these. */
const WINDOW_NAMES: Record<Every, string> = {
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
  cycle: "billing cycle",
};

/** Human-readable, for a 402 body or a tool result. */
export function describeDenial(
  reason: DenialReason,
  state: AllowanceState,
  limit?: LimitState,
): string {
  switch (reason) {
    case "rate_limit_reached": {
      const l = limit ?? (state.limits ?? []).find((x) => x.remaining <= 0);
      const name = l?.label ?? (l ? WINDOW_NAMES[l.every] : "window");
      const resets = l?.window.end ? ` Resets ${new Date(l.window.end).toISOString()}.` : "";
      return `Usage limit reached for this ${name} (${l?.size ?? 0}).${resets}`;
    }
    case "pool_exhausted":
      return `Plan allowance used up for this cycle (${state.pool?.size ?? 0} tokens). Contact us to extend the package.`;
    case "seat_allowance_reached":
      return "Seat token allowance reached for this cycle. Ask an owner for a top-up, or buy tokens.";
    case "insufficient_balance":
      return `Insufficient tokens (balance ${state.wallet}). Buy tokens to continue.`;
  }
}
