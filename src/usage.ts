import { getBillingCustomerId } from "./billing.js";
import { resolveAllowance, type AllowanceState, type LimitState } from "./allowance.js";
import { resolveLocalized, type LocaleOptions } from "./i18n.js";
import { getSeatType } from "./seats.js";
import {
  DEFAULT_SEAT_TYPE,
  planModel,
  type CycleWindow,
  type Every,
  type PlanCatalog,
  type PlanModel,
} from "./plan-model.js";
import { stripeBalanceUsageLedger, type UsageLedger } from "./usage-ledger.js";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

// The READ side of metering: what a usage screen needs, in one call.
//
// `resolveAllowance` already computes all of it — it has to, to decide whether the
// next call is allowed. What a screen needs on top is only presentation-adjacent
// arithmetic (a percentage, a reset time, the caller's seat) plus the per-member
// breakdown an admin view asks for. None of that belongs in the hot path, and all
// of it was previously unavailable: an app could learn its remaining allowance
// only by making a call and having it refused.
//
// No strings. Every label is either the app's own (from the plan config) or
// derivable from `every`, because this library ships no i18n and the two consumers
// speak different languages.

/** One window with progress. `resetsAt` is null only for an open-ended cycle. */
export interface UsageWindow extends LimitState {
  /** 0-100, clamped, rounded. `size` 0 reads as 100 — nothing is allowed. */
  percent: number;
  resetsAt: number | null;
}

/** Which seat the caller holds, and the plan's own word for it. */
export interface UsageSeat {
  /** Seat type key: a sold seat type, the plan's implicit seat, or `api`. */
  type: string;
  /**
   * `display.badge`, else `display.label`, resolved for the requested locale —
   * null when the config gave that seat no display at all. The badge form wins
   * because this is the pill on a usage screen, not a pricing card.
   */
  label: string | null;
}

export interface UsageSummary {
  plan: string | null;
  /** The billing cycle the cap is measured over. */
  cycle: CycleWindow;
  /** Declared rate limits, tightest-first is NOT imposed: config order. */
  windows: UsageWindow[];
  /** The plan's included window, as its own progress row when there is one. */
  pool: UsageWindow | null;
  /** The caller's seat pack, when the plan caps per seat and a caller was given. */
  pack: (UsageWindow & { seatType: string; extra: number }) | null;
  /**
   * The caller's seat, when a caller was given. Present even on a plan that caps
   * nothing per seat — you hold a seat on a free plan too, and `pack` is about
   * an allowance, not about who you are.
   */
  seat: UsageSeat | null;
  /** Prepaid balance, in the configured currency. */
  wallet: number;
  /** Epoch ms this was read. What a "last updated" line shows. */
  at: number;
}

const pct = (used: number, size: number): number =>
  size <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((used / size) * 100)));

function toWindow(l: LimitState): UsageWindow {
  return { ...l, percent: pct(l.used, l.size), resetsAt: l.window.end };
}

/** The cap's own window, so a screen can render pool/pack with the same row as a
 *  rate limit rather than special-casing three shapes. */
function capWindow(
  every: Every,
  label: string | null,
  size: number,
  used: number,
  cycle: CycleWindow,
): UsageWindow {
  return {
    every,
    scope: "org",
    label,
    size,
    used,
    remaining: Math.max(0, size - used),
    window: cycle,
    percent: pct(used, size),
    resetsAt: cycle.end,
  };
}

export interface UsageSummaryInput {
  orgId: string;
  plans: PlanCatalog;
  plan?: string | null;
  /**
   * Whose usage. Omit for the workspace as a whole — caller-scoped limits and the
   * seat pack are then left out, because neither means anything without a caller.
   * `seatType` is resolved from the adapter when not supplied.
   */
  caller?: { kind: "user" | "api"; id?: string; seatType?: string };
  ledger?: UsageLedger;
  now?: number;
  /** Which language to resolve `seat.label` in. The only string this returns. */
  locale?: LocaleOptions;
}

/**
 * How a plan presents one seat type: a sold seat type first, then the implicit
 * seat of a plan that sells none. Exported because a members list wants the same
 * pill as a usage screen, and reimplementing this lookup is how the two drift.
 */
export function resolveSeat(
  model: PlanModel | null,
  type: string,
  locale?: LocaleOptions,
): UsageSeat {
  const display =
    model?.seatTypes.find((s) => s.key === type)?.display ??
    (model?.seat?.key === type ? model.seat.display : null);
  return {
    type,
    label: display ? (resolveLocalized(display.badge ?? display.label, locale) ?? null) : null,
  };
}

/**
 * Everything a usage screen shows for one subject (a workspace, or one member).
 *
 * One `resolveAllowance` underneath, so the numbers a screen shows and the numbers
 * the meter enforces are the same numbers, read the same way. A screen that
 * computed its own would eventually disagree with the gate — and the disagreement
 * would be invisible until a customer was refused at 60%.
 */
export async function usageSummary(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: UsageSummaryInput,
): Promise<UsageSummary> {
  const at = input.now ?? Date.now();

  // A member's seat decides which pack and which seat-scoped limits apply, so
  // resolve it here rather than making every page do it.
  const model = planModel(input.plans, input.plan ?? null);
  let caller = input.caller;
  if (caller && !caller.seatType) {
    // Nobody assigned them one: the plan's own implicit seat if it named one,
    // else the historical default. A plan that SELLS seats has no implicit seat
    // (`model.seat` is null there), because an unassigned member is a data gap
    // and guessing at a sold seat type would hand out an allowance.
    const assigned = caller.id ? await getSeatType(adapter, input.orgId, caller.id) : null;
    const seatType =
      caller.kind === "api" ? "api" : assigned || model?.seat?.key || DEFAULT_SEAT_TYPE;
    caller = { ...caller, seatType };
  }

  const state = await resolveAllowance(adapter, config, {
    orgId: input.orgId,
    plans: input.plans,
    plan: input.plan,
    caller,
    ledger: input.ledger ?? stripeBalanceUsageLedger(),
    now: at,
  });

  return {
    plan: state.plan,
    cycle: state.cycle,
    windows: state.limits.map(toWindow),
    // No label for the cap's own rows. The plan's `display` strings are localized
    // (a Record of locale → text), and picking one here would be this library
    // choosing a language; the app labels these two rows itself.
    pool: state.pool
      ? capWindow("cycle", null, state.pool.size, state.pool.used, state.cycle)
      : null,
    pack: state.pack
      ? {
          ...capWindow("cycle", null, state.pack.size + state.pack.extra, state.pack.used, state.cycle),
          seatType: state.pack.seatType,
          extra: state.pack.extra,
        }
      : null,
    seat: caller?.seatType ? resolveSeat(model, caller.seatType, input.locale) : null,
    wallet: state.wallet,
    at,
  };
}

export interface MemberUsage {
  /** WorkOS member id, or the API-key marker for the shared seat. */
  id: string;
  kind: "user" | "api";
  seatType: string;
  /** The member's pack, when the plan caps per seat. */
  pack: (UsageWindow & { extra: number }) | null;
  /** Caller-scoped rate limits, measured for this member. */
  windows: UsageWindow[];
  /**
   * What this member spent in the billing cycle, read from the ledger directly.
   *
   * Meaningful on EVERY plan shape, which is why it is not taken from the pack: a
   * pooled plan has no pack, and reporting 0 for every member of a pooled plan
   * was hiding an answer the ledger already had.
   */
  usedInCycle: number;
}

/**
 * Per-member usage for an admin view.
 *
 * One summary per member, run in parallel: the ledger has no group-by, and adding
 * one to the seam would mean either a Stripe meter dimension per member (there is
 * no such thing) or paging every transaction in the window and bucketing it here.
 * A workspace is tens of members, not thousands, and this is a page, not the hot
 * path — but it IS N round trips, so a caller that renders it on every request
 * should cache it.
 */
export async function memberUsage(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: {
    orgId: string;
    plans: PlanCatalog;
    plan?: string | null;
    /** The members to report on, in the order they should appear. */
    members: readonly { id: string; kind?: "user" | "api" }[];
    ledger?: UsageLedger;
    now?: number;
  },
): Promise<MemberUsage[]> {
  const at = input.now ?? Date.now();
  const customerId = await getBillingCustomerId(adapter, input.orgId);
  if (!customerId) return [];
  const ledger = input.ledger ?? stripeBalanceUsageLedger();

  // The org's own reading, once: it fixes the cycle window every member is
  // measured over, so twenty members cannot end up with twenty slightly
  // different windows as the clock moves through the loop.
  const org = await usageSummary(adapter, config, {
    orgId: input.orgId,
    plans: input.plans,
    plan: input.plan,
    ledger,
    now: at,
  });

  return Promise.all(
    input.members.map(async (m) => {
      const kind = m.kind ?? "user";
      const [summary, usedInCycle] = await Promise.all([
        usageSummary(adapter, config, {
          orgId: input.orgId,
          plans: input.plans,
          plan: input.plan,
          caller: { kind, id: m.id },
          ledger,
          now: at,
        }),
        // Asked of the ledger directly rather than taken from the pack, because a
        // POOLED plan has no pack and would otherwise report 0 for everyone. The
        // pool is shared, but who spent it is recorded, so "your share of the
        // package" is answerable and is what an admin is looking for.
        ledger.total({
          orgId: input.orgId,
          customerId,
          start: org.cycle.start,
          end: org.cycle.end ?? undefined,
          filter:
            kind === "api"
              ? { callerKind: "api" }
              : { callerKind: "user", callerId: m.id },
        }),
      ]);
      return {
        id: m.id,
        kind,
        // From the resolved seat, not from the pack: a POOLED plan has no pack
        // and reported every member as `standard`, a seat type such a plan does
        // not even declare.
        seatType: summary.seat?.type ?? (kind === "api" ? "api" : DEFAULT_SEAT_TYPE),
        pack: summary.pack ? { ...summary.pack, extra: summary.pack.extra } : null,
        windows: summary.windows.filter((w) => w.scope === "caller"),
        usedInCycle,
      };
    }),
  );
}

/** Re-exported so a consumer can type a state it passes around. */
export type { AllowanceState, LimitState };
