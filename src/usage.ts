import { getBillingCustomerId } from "./billing.js";
import { resolveAllowance, type AllowanceState, type LimitState } from "./allowance.js";
import { getSeatType } from "./seats.js";
import type { CycleWindow, Every, PlanCatalog } from "./plan-model.js";
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
  let caller = input.caller;
  if (caller && !caller.seatType) {
    const seatType =
      caller.kind === "api"
        ? "api"
        : ((caller.id && (await getSeatType(adapter, input.orgId, caller.id))) || "standard");
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
        seatType: summary.pack?.seatType ?? (kind === "api" ? "api" : "standard"),
        pack: summary.pack ? { ...summary.pack, extra: summary.pack.extra } : null,
        windows: summary.windows.filter((w) => w.scope === "caller"),
        usedInCycle,
      };
    }),
  );
}

/** Re-exported so a consumer can type a state it passes around. */
export type { AllowanceState, LimitState };
