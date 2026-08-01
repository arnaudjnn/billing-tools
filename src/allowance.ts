import { getBillingCustomerId, getTokenBalance } from "./billing.js";
import {
  cycleWindowFor,
  exhaustedPolicy,
  packSizeOf,
  planModel,
  poolSizeOf,
  type CycleWindow,
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

export interface AllowanceState {
  plan: string | null;
  cycle: CycleWindow;
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
export async function resolveAllowance(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: AllowanceInput,
): Promise<AllowanceState> {
  const model = planModel(input.plans, input.plan ?? null);
  const customerId = input.customerId ?? (await getBillingCustomerId(adapter, input.orgId));
  const period = await subscriptionPeriod(adapter, input.orgId, model);
  const cycle = input.cycle ?? cycleWindowFor(model, period);
  const ledger = input.ledger ?? stripeBalanceUsageLedger();

  if (!customerId) {
    return { plan: model?.key ?? null, cycle, pool: null, pack: null, wallet: 0 };
  }

  const poolSize = poolSizeOf(model);
  const packSize = packSizeOf(model, input.caller?.seatType);

  const [wallet, poolUsed, packUsed, extra] = await Promise.all([
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
    // Top-up grants raise a member's pack for the cycle, and are keyed by the
    // same cycle identity the window produces, so the two can't drift.
    packSize == null || input.caller?.kind !== "user" || !input.caller.id
      ? Promise.resolve(0)
      : extraAllowance(adapter, input.orgId, input.caller.id, cycle.key),
  ]);

  return {
    plan: model?.key ?? null,
    cycle,
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
  if (!model || model.cap.kind === "wallet") return null;
  if (!adapter.getSubscription) return null;
  try {
    const sub = await adapter.getSubscription(orgId);
    return { start: sub.periodStart ?? null, end: sub.periodEnd ?? null };
  } catch {
    return null;
  }
}

export type DenialReason =
  | "pool_exhausted"
  | "seat_allowance_reached"
  | "insufficient_balance";

export interface FundingDecision {
  ok: boolean;
  source: FundingSource | null;
  reason?: DenialReason;
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

/** Human-readable, for a 402 body or a tool result. */
export function describeDenial(reason: DenialReason, state: AllowanceState): string {
  switch (reason) {
    case "pool_exhausted":
      return `Plan allowance used up for this cycle (${state.pool?.size ?? 0} tokens). Contact us to extend the package.`;
    case "seat_allowance_reached":
      return "Seat token allowance reached for this cycle. Ask an owner for a top-up, or buy tokens.";
    case "insufficient_balance":
      return `Insufficient tokens (balance ${state.wallet}). Buy tokens to continue.`;
  }
}
