import {
  getBillingCustomerId,
  getCreditBalance,
  getSpendControls,
  retrieveBillingCustomer,
} from "./billing.js";
import { formatMessage, resolveMessages, type PartialMessages } from "./i18n.js";
import {
  capCovers,
  cycleWindowFor,
  exhaustedPolicy,
  packSizeOf,
  planModel,
  poolIsPerSeat,
  poolSizeOf,
  rateLimitsOf,
  rateWindowFor,
  type CycleWindow,
  type Every,
  type PlanCatalog,
  type PlanModel,
} from "./plan-model.js";
import { extraAllowance } from "./topup.js";
import { reportUsageFault } from "./usage-faults.js";
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

/** One limit, with the window it is being measured over. */
export interface LimitState {
  every: Every;
  scope: "org" | "caller";
  /** Extra granted to THIS caller on THIS window, already included in `size`. Always 0 for
   *  an org-scoped window, which is nobody's to raise. */
  extra?: number;
  /** `all` refuses outright; `included` only stops the allowance, and paid usage continues. */
  covers?: "all" | "included";
  /** From the config; null when the plan didn't label it. */
  label: string | null;
  size: number;
  used: number;
  remaining: number;
  /** The aligned window. `end` is always known, so a UI can count down to it. */
  window: CycleWindow;
  /**
   * WHOSE limit this is. Absent means `rate` — every limit predates this field.
   *
   * `rate` is the product's, declared in the plan: the customer cannot lift it,
   * so the refusal tells them to wait. `spend` is the customer's OWN monthly
   * ceiling (`setSpendControls`): they can raise it, so the refusal says so
   * instead. Same mechanism, same arithmetic — only the advice differs, which is
   * why this is a field on one shape rather than a second kind of limit.
   */
  kind?: "rate" | "spend";
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
  /** Skip the customer's monthly spend ceiling. For a read that only wants plan
   *  entitlement, or a surface that must never be refused by it. */
  skipSpendLimit?: boolean;
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
  const { period } = await subscriptionState(adapter, input.orgId, model);
  return cycleWindowFor(model, period, now);
}

export async function resolveAllowance(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: AllowanceInput,
): Promise<AllowanceState> {
  const model = planModel(input.plans, input.plan ?? null);
  const now = input.now ?? Date.now();
  const customerId = input.customerId ?? (await getBillingCustomerId(adapter, input.orgId));
  const { period, seats: purchasedSeats } = await subscriptionState(adapter, input.orgId, model);
  const cycle = input.cycle ?? cycleWindowFor(model, period, now);
  const ledger = input.ledger ?? stripeBalanceUsageLedger();

  if (!customerId) {
    return { plan: model?.key ?? null, cycle, limits: [], pool: null, pack: null, wallet: 0 };
  }

  // WHICH funding sources a per-caller window can hold, worked out once from the
  // plan and handed to every per-caller read. It is what makes the expensive leg
  // skippable without any consumer having to declare it — and declaring it by hand
  // was a footgun, because getting it wrong under-reports and an under-reported
  // window refuses no one.
  //
  //   included — `capCovers` is false for an `api` caller on a `covers: "users"`
  //     plan: it draws no included allowance, so its meter read is a guaranteed 0.
  //   wallet   — `exhaustedPolicy` already answers this for every shape: "wallet"
  //     for an api/shared caller, for a `cap: wallet` plan, and for a pack that
  //     overflows; "block" exactly when the caller can never spend the wallet.
  const sources = {
    included: model ? model.cap.kind !== "wallet" && capCovers(model, input.caller) : true,
    wallet: exhaustedPolicy(model, input.caller) === "wallet",
  };

  const poolSize = poolSizeOf(
    model,
    await seatsFor(adapter, input.orgId, model, purchasedSeats),
  );
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
            : // An org-wide limit declared for one KIND of caller still sums the
              // whole workspace, but only that kind's usage — "600 an hour across
              // every agent" is not the same window as one agent's.
              (limit.callerKind ? { callerKind: limit.callerKind } : undefined),
        // An `included` window governs only what the plan gives away, so wallet-funded
        // calls must not fill it — otherwise paying to continue would consume the very
        // window that was supposed to stop governing you once you paid.
        ...(limit.covers === "included"
          ? { sources: { included: sources.included, wallet: false } }
          : scope === "caller" || limit.callerKind
            ? { sources }
            : {}),
      })
      .then(async (used) => {
        // A per-member EXCEPTION on this window, if an owner granted one.
        //
        // Filed under the window's own key, which is what makes it expire correctly: come
        // Monday the key is a different string, the read returns 0, and the member is back
        // to the plan's pace with nothing to clean up. Only a CALLER-scoped window can
        // carry one — an org-wide limit is the product's pace, not a person's, and raising
        // it for one member would raise it for everyone.
        const extra =
          scope === "caller" && input.caller?.kind === "user" && input.caller.id
            ? await extraAllowance(adapter, input.orgId, input.caller.id, window.key).catch(() => 0)
            : 0;
        const size = limit.credits + extra;
        return {
          every: limit.every,
          scope,
          covers: limit.covers ?? "all",
          label: limit.label ?? null,
          size,
          used,
          remaining: Math.max(0, size - used),
          window,
          extra,
        };
      });
  });

  // The customer's own monthly ceiling, if they set one. Read from the customer
  // metadata — the SAME object `getCreditBalance` retrieves below, so a caller
  // that needs both pays one round trip, and it joins the parallel round with
  // every other limit rather than adding a step to the meter's hot path.
  // ONE retrieve for the two reads that both want this object. Measured under
  // load, `/v1/customers/:id` was the largest single consumer of the account's
  // request budget because the wallet balance and the spend ceiling each fetched
  // it — and unlike the ledger reads they are not cacheable, since money must not
  // be served stale. Shared here rather than memoised anywhere, so the freshness
  // is unchanged and only the duplicate goes.
  const needsCustomer = !input.skipWallet || !input.skipSpendLimit;
  // Started, NOT awaited. Awaiting here would yield the tick, and the per-caller
  // reads are batched by the scope ledger on a microtask — so an await between the
  // rate-limit reads above and the pack read below splits them into two flushes
  // and two Stripe requests. Measured: it silently undid the batching entirely.
  const customerPromise = needsCustomer
    ? retrieveBillingCustomer(customerId).catch((error: unknown) => {
        // The wallet balance and the spend ceiling both come off this object, and
        // unlike a usage window it is MONEY — a stale balance would let a customer
        // spend what they do not have, so this stays fail-closed and rethrows.
        //
        // What it did not do was say so. Load-testing a real account past its rate
        // limit put every 429 here: 69 metered calls rejected outright, and not one
        // fault reported, because this read sits outside the ledger's
        // `onReadFailure` policy. Failing closed is a choice; failing closed
        // silently is not.
        reportUsageFault({
          operation: "read",
          outcome: "refused",
          error,
          orgId: input.orgId,
          scope: "customer",
        });
        throw error;
      })
    : Promise.resolve(null);

  const spendReads: Promise<LimitState[]> = input.skipSpendLimit
    ? Promise.resolve([])
    : customerPromise
        .then((c) => getSpendControls(customerId, c))
        .then(({ limitCredits }) => {
        if (!limitCredits) return [];
        // A CALENDAR month, deliberately, and not the plan cycle: the customer set
        // a "monthly" ceiling, and an annual subscriber's cycle would make that one
        // window a year wide.
        const window = rateWindowFor("month", now, cycle);
        return ledger
          .total({
            orgId: input.orgId,
            customerId,
            start: window.start,
            end: window.end ?? undefined,
          })
          .then((used) => [
            {
              every: "month" as Every,
              scope: "org" as const,
              label: null,
              size: limitCredits,
              used,
              remaining: Math.max(0, limitCredits - used),
              window,
              kind: "spend" as const,
            },
          ]);
      });

  const [wallet, poolUsed, packUsed, extra, limits, spendLimits] = await Promise.all([
    input.skipWallet
      ? Promise.resolve(0)
      : customerPromise.then((c) => getCreditBalance(customerId, config.currency, c)),
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
          sources,
        }),
    // Top-up grants raise a member's pack for the cycle, keyed by the cycle
    // identity `currentCycle` produces — the same one the approving tool writes,
    // which is guaranteed by both going through that function.
    packSize == null || input.caller?.kind !== "user" || !input.caller.id
      ? Promise.resolve(0)
      : extraAllowance(adapter, input.orgId, input.caller.id, cycle.key),
    Promise.all(limitReads),
    spendReads,
  ]);

  return {
    plan: model?.key ?? null,
    cycle,
    // Plan limits first: when both refuse, the one the customer cannot lift is
    // the more useful thing to be told.
    limits: [...limits, ...spendLimits],
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
async function subscriptionState(
  adapter: BillingAdapter,
  orgId: string,
  model: PlanModel | null,
): Promise<{
  period: { start?: string | null; end?: string | null } | null;
  seats: number | Record<string, number> | null;
}> {
  const none = { period: null, seats: null };
  if (!model) return none;
  // A `cycle` rate limit needs the period just as much as a cap does; without
  // this it would silently fall back to the calendar month.
  const needsPeriod =
    model.cap.kind !== "wallet" || model.limits.rate.some((l) => l.every === "cycle");
  if (!needsPeriod && !poolIsPerSeat(model)) return none;
  if (!adapter.getSubscription) return none;
  try {
    const sub = await adapter.getSubscription(orgId);
    return {
      period: needsPeriod ? { start: sub.periodStart ?? null, end: sub.periodEnd ?? null } : null,
      // The breakdown when the adapter has it: `perSeat: "included"` multiplies each
      // tier by its own allowance, which a total cannot express.
      seats: sub.seatCounts ?? sub.seats ?? null,
    };
  } catch {
    return none;
  }
}

/**
 * How many seats a `perSeat` pool is sized by.
 *
 * Purchased quantity first, then the active member count, then 1. The member count
 * is a fallback rather than the definition because a workspace that bought ten
 * seats and filled six paid for ten — sizing on members would quietly hand them a
 * smaller package than the pricing page promised.
 *
 * Only read for a `perSeat` pool, so no other plan shape pays for the extra call.
 */
async function seatsFor(
  adapter: BillingAdapter,
  orgId: string,
  model: PlanModel | null,
  purchased: number | Record<string, number> | null,
): Promise<number | Record<string, number> | undefined> {
  if (!poolIsPerSeat(model)) return undefined;
  if (typeof purchased === "object" && purchased && Object.keys(purchased).length) return purchased;
  if (typeof purchased === "number" && purchased > 0) return purchased;
  if (!adapter.memberCount) return 1;
  try {
    return (await adapter.memberCount(orgId)) || 1;
  } catch {
    return 1;
  }
}

export type DenialReason =
  | "rate_limit_reached"
  /** The customer's OWN monthly ceiling. Distinct from `rate_limit_reached`
   *  because they can raise it themselves, and the message must say so. */
  | "spend_limit_reached"
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
/**
 * WHICH window a top-up should raise for this caller: the tightest one refusing them now.
 *
 * "More usage" is not one thing. A member can be inside their monthly seat pack and still
 * blocked by a weekly window, which is what pacing is for — and raising the pack there buys
 * them nothing, because `fundingFor` checks the rate windows FIRST and absolutely. Asking
 * this question before granting is what keeps the answer honest.
 *
 * A rate window wins over the pack when both are exhausted, and the SMALLEST window wins
 * among rate windows: it is the one that will refuse the next call. And because a rate
 * grant is filed under the window's own key, it lasts exactly as long as that window — come
 * the reset the key no longer matches and the member is back to the plan's pace.
 *
 * Only caller-scoped windows are offered. An org-wide limit protects the product from the
 * whole workspace; lifting it for one person is not an exception, it is a different plan.
 */
export function topUpTargetOf(
  state: AllowanceState,
):
  | { kind: "rate"; windowKey: string; basis: number; extra: number; every: Every; resetsAt: number | null }
  | { kind: "pack"; basis: number; extra: number }
  | null {
  const ORDER: Every[] = ["hour", "day", "week", "month", "cycle"];
  const blocked = state.limits
    .filter((l) => l.scope === "caller" && l.remaining <= 0)
    .sort((a, b) => ORDER.indexOf(a.every) - ORDER.indexOf(b.every));

  const tightest = blocked[0];
  if (tightest) {
    return {
      kind: "rate",
      windowKey: tightest.window.key,
      // The percentage applies to THIS window, not to the seat pack: "25% more this week"
      // means a quarter of the week's allowance, and a pack-sized share of a weekly window
      // would be a different — usually much larger — number.
      //
      // `basis` EXCLUDES what has already been granted, because that is what the grant is
      // computed from; `extra` is reported beside it so a screen can show the window's real
      // current size (`basis + extra`) without having to add a second read to find it. A
      // caller left to guess it quotes the first grant twice — measured: a second 25% offered
      // "+313 crediti" and applied 250.
      basis: tightest.size - (tightest.extra ?? 0),
      extra: tightest.extra ?? 0,
      every: tightest.every,
      resetsAt: tightest.window.end,
    };
  }
  if (state.pack && state.pack.remaining <= 0) {
    // NO subtraction here, and the asymmetry is real rather than an oversight: a rate
    // window's `size` INCLUDES what has been granted onto it, while the pack's `size` is
    // the bare pack with its `extra` reported alongside. So `basis` is the bare figure in
    // both cases — which is what `grantExtraAllowance` takes its percentage of — and
    // `basis + extra` is the current ceiling in both cases too. Subtracting twice here
    // undercut every grant after the first by the size of the last one.
    return { kind: "pack", basis: state.pack.size, extra: state.pack.extra ?? 0 };
  }
  return null;
}

export function fundingFor(
  state: AllowanceState,
  model: PlanModel | null,
  cost: number,
  caller?: { kind: "user" | "api"; seatType?: string },
): FundingDecision {
  if (cost <= 0) return { ok: true, source: null };

  // Rate limits come FIRST, and a `covers: "all"` one is absolute. It is not a funding
  // source and nothing overrides it: no wallet fallthrough (a limit a top-up could lift is
  // not a limit) and no exemption for a shared seat, because the thing being protected is
  // the product, not the customer's money. The tightest window that refuses is the one
  // reported, so the message names a week rather than a month when the week is what ran out.
  //
  // A `covers: "included"` window is a different statement: it paces what the plan GIVES
  // AWAY, not what the customer may buy. Exhausted, it stops the allowance and falls
  // through to the wallet like any other included window — a workspace that has already
  // bought credits sitting refused for three days is not what a pay-as-you-go card promises.
  // It is only skipped when something can actually pay; with no wallet behind it, it still
  // refuses, and says so as a rate limit rather than as an empty wallet.
  const payable = exhaustedPolicy(model, caller) === "wallet" && state.wallet >= cost;
  // Set when an `included` window is spent and the wallet can carry the call. It does NOT
  // mean "ignore the window": the window's whole job is to pace the giveaway, so the
  // included sources below are barred and only the wallet may pay. Letting the pack fund it
  // instead would make a weekly cap on included usage do precisely nothing.
  let includedBarred = false;
  for (const limit of state.limits ?? []) {
    if (limit.remaining < cost) {
      if (limit.covers === "included" && payable) {
        includedBarred = true;
        continue;
      }
      return {
        ok: false,
        source: null,
        // The customer's own ceiling refuses exactly like a rate limit; only the
        // advice differs, so the reason carries the distinction and nothing else
        // in this function has to know about it.
        reason: limit.kind === "spend" ? "spend_limit_reached" : "rate_limit_reached",
        limit,
      };
    }
  }

  // A window the caller is not covered by is not theirs to spend — it is skipped
  // entirely rather than treated as exhausted, so no `onExhausted: "block"` can
  // refuse a machine caller over an allowance that was never included for it.
  const covered = capCovers(model, caller);

  if (covered && !includedBarred && state.pool) {
    if (state.pool.remaining >= cost) return { ok: true, source: "pool" };
    if (exhaustedPolicy(model, caller) === "block") {
      return { ok: false, source: null, reason: "pool_exhausted" };
    }
  }

  if (covered && !includedBarred && state.pack) {
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
    case "spend_limit_reached": {
      const l = limit ?? (state.limits ?? []).find((x) => x.kind === "spend");
      const resets = l?.window.end ? ` Resets ${new Date(l.window.end).toISOString()}.` : "";
      // Names the customer's own action, because this is the one limit they can
      // lift without asking anyone.
      return `Monthly spend limit reached (${l?.size ?? 0} credits). Raise the limit to continue.${resets}`;
    }
    case "pool_exhausted":
      return `Plan allowance used up for this cycle (${state.pool?.size ?? 0} credits). Contact us to extend the package.`;
    case "seat_allowance_reached":
      return "Seat credit allowance reached for this cycle. Ask an owner for a top-up, or buy credits.";
    case "insufficient_balance":
      return `Insufficient credits (balance ${state.wallet}). Buy credits to continue.`;
  }
}
