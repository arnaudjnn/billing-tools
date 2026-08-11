import { getBillingCustomerId } from "./billing.js";
import { resolveAllowance, type AllowanceState, type LimitState } from "./allowance.js";
import { resolveLocalized, type LocaleOptions } from "./i18n.js";
// A seat's NAMES are pure resolution over the catalogue and live on the pure module, so a seat
// picker or a pricing card can read them without pulling Stripe in. Re-exported here because
// every consumer already imports them from this module.
export { resolveSeat, type UsageSeat } from "./plan-model.js";
import { resolveSeat, type UsageSeat } from "./plan-model.js";
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

/**
 * The windows one scope's card should SHOW, with the duplicates of the included package
 * dropped.
 *
 * A monthly rate limit and a monthly package are the same period read twice with different
 * denominators, so a card that listed both showed "Mese 40%", "Questo mese 62%" and
 * "Pacchetto incluso 62%" — three rows that read as a mistake rather than as three genuinely
 * different caps. Shorter windows stay: a week says something the package cannot.
 *
 * It lives here rather than in a consumer because it is a rule about the plan model, not about
 * anybody's language — and it was written twice already, once per usage screen, which is
 * exactly how two pages come to disagree about what a plan sells.
 *
 * `append: false` is for the screen whose duplicate-maker is rendered ELSEWHERE — an admin
 * table already showing each member's seat pack as its own row needs the org rows that pack
 * duplicates dropped without the pack re-added here. One consumer hand-filtered
 * `every !== "month" && every !== "cycle"` for exactly this, which is the same rule spelled
 * a second time.
 */
export function visibleWindows(
  windows: readonly UsageWindow[],
  scope: "org" | "caller",
  included: UsageWindow | null,
  opts?: { append?: boolean },
): UsageWindow[] {
  const rows = windows.filter(
    (w) => w.scope === scope && !(included && (w.every === "month" || w.every === "cycle")),
  );
  return included && (opts?.append ?? true) ? [...rows, included] : rows;
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
 * Everything a usage screen shows for one subject (a workspace, or one member).
 *
 * One `resolveAllowance` underneath, so the numbers a screen shows and the numbers
 * the meter enforces are the same numbers, read the same way. A screen that
 * computed its own would eventually disagree with the gate — and the disagreement
 * would be invisible until a customer was refused at 60%.
 */
/**
 * Fill in a caller's seat type when nobody passed one.
 *
 * A member's seat decides which pack applies AND which seat-scoped rate limits do, so a
 * caller without one is not "any seat" — `rateLimitsOf` drops every seat-typed window, and
 * `packSizeOf` returns null. Resolved here rather than in every page.
 *
 * It lives in ONE place because it did not: `usageSummary` resolved the seat and
 * `resolveAllowance` did not, so a screen reading the summary saw a member's weekly window
 * while the bound helpers asking "what is blocking them" saw no windows at all — and the
 * control that should have offered an upgrade silently disappeared. Anything that resolves
 * allowance for a NAMED member goes through this.
 */
export async function callerWithSeat<C extends { kind: "user" | "api"; id?: string; seatType?: string }>(
  adapter: BillingAdapter,
  input: { orgId: string; model: PlanModel | null; caller?: C },
): Promise<C | undefined> {
  const caller = input.caller;
  if (!caller || caller.seatType) return caller;
  // Nobody assigned them one: the plan's own implicit seat if it named one, else the
  // historical default. A plan that SELLS seats has no implicit seat (`model.seat` is null
  // there), so the default is what an unassigned member actually draws.
  const assigned = caller.id ? await getSeatType(adapter, input.orgId, caller.id) : null;
  const seatType =
    caller.kind === "api" ? "api" : assigned || input.model?.seat?.key || DEFAULT_SEAT_TYPE;
  return { ...caller, seatType };
}

export async function usageSummary(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: UsageSummaryInput,
): Promise<UsageSummary> {
  const at = input.now ?? Date.now();

  const model = planModel(input.plans, input.plan ?? null);
  const caller = await callerWithSeat(adapter, {
    orgId: input.orgId,
    model,
    caller: input.caller,
  });

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
          // An api member is narrowed to its own KEY when one is named. The gate
          // deliberately sums api usage by kind — there is one shared agent window,
          // and no top-up buys a second — but this is a READ, and "which key spent
          // it" is the question an admin screen is asking. Summed by kind here, a
          // list of five keys returned the org total five times: a table that looks
          // per-key and is not.
          filter:
            kind === "api"
              ? m.id
                ? { callerKind: "api", callerId: m.id }
                : { callerKind: "api" }
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

/** One member, measured against whatever actually caps them. */
export interface OrgUsageMember extends MemberUsage {
  /** What caps this member: their seat pack, else the shared pool. 0 when nothing does,
   *  which is how a plan with no included allowance reports. */
  limit: number;
  /**
   * Whether that limit is theirs or the WORKSPACE'S.
   *
   * On a pooled plan every member is capped by the same pool, so `limit` is the same
   * number on every row and it is not a number any one of them owns. Without this a
   * renderer says "800 of 4 000" beside each of five people and invites the reader to add
   * them up — and the aggregate did exactly that, reporting five times the credits the
   * workspace has.
   */
  shared: boolean;
  /** Against that limit — the pack's own usage where there is one, else what the ledger
   *  says they spent in the cycle. */
  used: number;
  /** Capped at 100. Somebody 20% into wallet-funded overage is not at 120% of an
   *  allowance, and letting that through pulls an average up past what anyone can spend. */
  percent: number;
  /** At or over their cap: refused until the window resets, or until somebody grants
   *  extra. This is what an "in overage" list is. */
  overage: boolean;
}

export interface OrgUsage {
  members: OrgUsageMember[];
  /**
   * The workspace reading, and it is an AVERAGE of the members' own percentages, not the
   * total over the total.
   *
   * Nothing here is a ceiling: each member is capped by their OWN seat, so a summed 96%
   * was the workspace's totals expressed as a fraction nobody can spend — two members, one
   * blocked at 100% and one who has not started, read as "almost out" when half the team is
   * idle and the other half is stuck. Neither fact is the one that number implied.
   *
   * `used` and `limit` are still the honest totals for anything that wants them; they are
   * simply not the denominator of `percent`.
   */
  aggregate: {
    /**
     * PER-SEAT: the mean of the members' own percentages, each capped at 100 (see above).
     * POOLED: the pool's own usage, because there is one number and every member shares
     * it — a mean of identical fractions is that same fraction dressed as an average.
     */
    percent: number;
    used: number;
    /**
     * PER-SEAT: the packs summed, which is what the workspace bought.
     * POOLED: the pool, ONCE. It used to be summed per member, so a two-person workspace
     * reported twice the credits it has and a ten-person one ten times.
     */
    limit: number;
    /** The shared pool, when the plan has one — so a caller never has to work out whether
     *  `limit` above is a sum or a single ceiling. Null on a per-seat plan. */
    pool: { size: number; used: number; remaining: number } | null;
    /** How many members the average is over — a caption needs it ("media di 3 posti"),
     *  and a mean without its N is not a statement. Zero on a pooled plan: the percentage
     *  there is the pool's, not an average of anything. */
    seats: number;
    /** How many are at or over their cap right now. The answer to "who is at the wall",
     *  which nothing could ask before: `memberUsage` reports one member at a time and
     *  flags nothing. */
    overage: number;
    /**
     * The same average, per WINDOW — the seats' week beside the seats' package, rather
     * than one number for the cap alone.
     *
     * A per-seat plan has no org-scoped week and no pool, so a workspace screen that only
     * had `percent` above could show a rate limit for the workspace at all only by
     * flattening every member's week itself. Which is what a consumer did: the same capped
     * mean, the same summed totals, the same "every seat resets together" shortcut,
     * written a second time in a page where no API caller could reach it.
     *
     * Empty on a pooled plan — `pool` is the workspace's own window there, and averaging
     * a shared ceiling across the people sharing it says nothing.
     */
    windows: OrgUsageWindow[];
  };
}

/** One window kind, averaged across the seats that have it. */
export interface OrgUsageWindow {
  every: UsageWindow["every"];
  /** The mean of the seats' own percentages, each capped at 100 — same rule as
   *  `aggregate.percent`, for the same reason. */
  percent: number;
  /** The team's totals. Honest for anything that wants them, and NOT the denominator of
   *  `percent` — a caption is what keeps the two apart on screen. */
  used: number;
  limit: number;
  /** How many seats this average is over. A mean without its N is not a statement. */
  seats: number;
  /** Every seat's window resets at the same instant, so the first one speaks for all. */
  resetsAt: number | null;
}

/**
 * The whole workspace's usage, as an admin screen needs it.
 *
 * `memberUsage` answers per member and stops there, so every consumer wrote the same three
 * lines after it: which limit applies to this person, are they over it, and what does the
 * team look like taken together. That arithmetic decides what an owner is shown about money
 * — and it lived in a page, where no API, CLI or MCP caller could reach it. "Who is blocked
 * right now" was a question the library could not answer at all.
 *
 * Members with no limit AND no usage are dropped: on a plan that caps nothing they are rows
 * of zeroes, and a list of them says nothing about anybody.
 */
export async function orgUsage(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: Parameters<typeof memberUsage>[2],
): Promise<OrgUsage> {
  const org = await usageSummary(adapter, config, {
    orgId: input.orgId,
    plans: input.plans,
    plan: input.plan,
    ledger: input.ledger,
    now: input.now,
  });
  const rows = await memberUsage(adapter, config, input);

  const members: OrgUsageMember[] = rows.map((m) => {
    // Their own pack where the plan gives them one; otherwise the pool, which caps them
    // just as hard and belongs to everybody.
    const shared = !m.pack && Boolean(org.pool);
    const limit = m.pack?.size ?? org.pool?.size ?? 0;
    const used = m.pack?.used ?? m.usedInCycle;
    return {
      ...m,
      limit,
      shared,
      used,
      percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0,
      overage: limit > 0 && used >= limit,
    };
  });

  const measured = members.filter((m) => m.limit > 0);
  const pool = org.pool
    ? { size: org.pool.size, used: org.pool.used, remaining: org.pool.remaining }
    : null;

  // The seats' windows, averaged one kind at a time. Members' caller-scoped windows plus
  // their pack (which is a cycle window by another name — it is the one an "included"
  // row shows), grouped by `every` in first-seen order so a renderer gets them in the
  // order the plan declares them.
  const byEvery = new Map<UsageWindow["every"], (UsageWindow & { size: number })[]>();
  if (!pool) {
    for (const m of rows) {
      for (const w of [...m.windows, ...(m.pack ? [m.pack] : [])]) {
        if (w.size <= 0) continue;
        const bucket = byEvery.get(w.every);
        if (bucket) bucket.push(w);
        else byEvery.set(w.every, [w]);
      }
    }
  }
  const windows: OrgUsageWindow[] = [...byEvery].map(([every, ws]) => ({
    every,
    percent: Math.round(ws.reduce((n, w) => n + Math.min(100, (w.used / w.size) * 100), 0) / ws.length),
    used: ws.reduce((n, w) => n + w.used, 0),
    limit: ws.reduce((n, w) => n + w.size, 0),
    seats: ws.length,
    resetsAt: ws.find((w) => w.resetsAt)?.resetsAt ?? null,
  }));
  return {
    members: members.filter((m) => m.limit > 0 || m.used > 0),
    aggregate: pool
      ? {
          // ONE pool, read once. Summing a shared ceiling per member is the arithmetic
          // that made a two-person workspace look like it had twice the credits — and the
          // more people a customer added, the further from true it got.
          percent: pool.size ? Math.min(100, Math.round((pool.used / pool.size) * 100)) : 0,
          used: pool.used,
          limit: pool.size,
          pool,
          // Not a mean of anything, so there is no N to report.
          seats: 0,
          overage: members.filter((m) => m.overage).length,
          windows,
        }
      : {
          percent: measured.length
            ? Math.round(measured.reduce((n, m) => n + m.percent, 0) / measured.length)
            : 0,
          used: measured.reduce((n, m) => n + m.used, 0),
          limit: measured.reduce((n, m) => n + m.limit, 0),
          pool: null,
          seats: measured.length,
          overage: members.filter((m) => m.overage).length,
          windows,
        },
  };
}
