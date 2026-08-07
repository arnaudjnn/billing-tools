import {
  defaultBasket,
  exhaustedPolicy,
  normalizePlans,
  planModel,
  type PlanCatalog,
  type PlanModel,
} from "./plan-model.js";

// The RUNGS: what "a better seat" and "a better plan" mean, and which one to offer a
// member who is blocked.
//
// ── Why this is its own module ──────────────────────────────────────────────
//
// All of it is arithmetic over the catalogue — a plain object in, a key out, no adapter,
// no Stripe, no WorkOS. It used to live half in `subscription.ts` (which imports Stripe to
// move a subscription) and half in `plan-request.ts` (which needs an adapter to queue an
// ask), so a pricing page, a seat picker or a config file could not reach a single rung
// without loading the engine. Neither module could put it on the `/plans` leaf, and the
// leaf is asserted pure — so the ordering rule got re-implemented in consumer UIs instead,
// once per screen, which is how a seat picker and the meter can disagree about which seat
// somebody is on.
//
// Both former homes re-export from here, so nothing internal moved.

// ── Seats ───────────────────────────────────────────────────────────────────

/**
 * The seat types a member can BE on, cheapest first.
 *
 * `shared` types are excluded: they are the pool an API caller or a guest draws from, not a
 * rung a person climbs, and including them made "the next seat up" point at something no
 * human can be assigned.
 *
 * This ordering — non-shared, by monthly price — is the definition of "better seat" used by
 * every function below. It is exported because a UI that renders the ladder has to sort it
 * the same way, and the only alternative to publishing the rule is each caller guessing it.
 */
export function seatLadder(model: PlanModel): PlanModel["seatTypes"] {
  return [...model.seatTypes]
    .filter((s) => !s.shared)
    .sort((a, b) => a.price.monthly - b.price.monthly);
}

/**
 * The seat a member holds when nobody has assigned them one: the cheapest non-shared type.
 *
 * An UNASSIGNED member is not on "no seat" — they draw the plan's entry-level pack, which is
 * what the meter measures them against and what their badge says. Treating absent as zero
 * made the ladder offer a Standard member the Standard seat they were already effectively on,
 * which is how this was caught: the button read "Assegna Posto Standard".
 */
export function defaultSeatOf(model: PlanModel): string | null {
  return seatLadder(model)[0]?.key ?? null;
}

/** What a seat costs per month — the ordering "a better seat" means. An absent assignment
 *  resolves to the default seat, not to nothing. */
export function seatRank(model: PlanModel, seatType: string | null): number {
  const key = seatType ?? defaultSeatOf(model);
  if (!key) return 0;
  return model.seatTypes.find((s) => s.key === key)?.price.monthly ?? 0;
}

/** The next seat type up, or null when they are already on the best one. */
export function nextSeatUp(model: PlanModel, seatType: string | null): string | null {
  const above = seatLadder(model).filter((s) => s.price.monthly > seatRank(model, seatType));
  return above[0]?.key ?? null;
}

/**
 * Is this the best seat the plan sells?
 *
 * `nextSeatUp(...) === null` already answered it, but only to a reader who knows that is what
 * null means there. A screen deciding whether to offer an upgrade, and an agent asking the
 * same question over the API, should not both have to know.
 */
export function isTopSeat(model: PlanModel, seatType: string | null): boolean {
  return seatLadder(model).length > 0 && nextSeatUp(model, seatType) === null;
}

/**
 * Does THIS plan sell that seat type?
 *
 * Against the org's own model, which is the check that was missing: the `assign_seat_type`
 * tool validated against the union of seat keys across every plan in the catalogue, so a
 * Premium key was "valid" for a workspace on a plan that does not sell it, and the write
 * went through to a seat the meter then could not price.
 *
 * `shared` types count — an API caller genuinely holds one — so this is a wider question
 * than `seatLadder`.
 */
export function seatTypeExists(model: PlanModel, seatType: string): boolean {
  return model.seatTypes.some((s) => s.key === seatType);
}

// ── Plans ───────────────────────────────────────────────────────────────────

/** What a plan costs a month at its default basket — the ordering "a better plan" means.
 *  A quote-only plan ranks above everything priced, because nothing self-serve exceeds it. */
export function planRank(model: PlanModel): number {
  if (model.sale === "quote") return Number.MAX_SAFE_INTEGER;
  if (model.sells.kind === "flat") return model.sells.price.monthly;
  const basket = defaultBasket(model);
  const priced = model.seatTypes.reduce((sum, s) => sum + (basket[s.key] ?? 0) * s.price.monthly, 0);
  // A seat plan whose types declare no `min` has an EMPTY default basket, which priced the
  // plan at zero — so it tied with the free tier and `planActions` reported no upgrade
  // above it. "There is nothing better than free" is not something a catalogue should be
  // able to say by omission, so an empty basket falls back to one seat at the entry price.
  if (priced > 0) return priced;
  return seatLadder(model)[0]?.price.monthly ?? 0;
}

export interface PlanActions {
  /** The next plan up, or null when already at the top. */
  upgradeTo: string | null;
  /** The next plan down, or null when already at the bottom. */
  downgradeTo: string | null;
  /** Whether there is a paid subscription to end. False on a free plan — there
   *  is nothing to cancel, so the action shouldn't be offered. */
  canCancel: boolean;
  /** The plan a cancellation lands on. */
  cancelTo: string | null;
}

/**
 * Which of upgrade / downgrade / cancel apply to an org on `currentPlan`.
 *
 * Pure, so a UI can hide what doesn't apply instead of offering an action that
 * will be refused: no "upgrade" on the top plan, no "cancel" on a free one.
 */
export function planActions(plans: PlanCatalog, currentPlan: string | null): PlanActions {
  const models = normalizePlans(plans)
    .filter((m) => m.sale !== "legacy" && !m.display?.hidden)
    .sort((a, b) => planRank(a) - planRank(b));
  const free = models.find((m) => m.sale === "free") ?? null;
  const current = currentPlan ? models.find((m) => m.key === currentPlan) : null;
  // No recorded plan behaves as the free tier: nothing is being billed.
  const rank = current ? planRank(current) : (free ? planRank(free) : 0);
  const above = models.filter((m) => planRank(m) > rank);
  const below = models.filter((m) => planRank(m) < rank);
  const isPaid = current ? current.sells.kind !== "nothing" && current.sale !== "free" : false;
  return {
    upgradeTo: above[0]?.key ?? null,
    downgradeTo: below[below.length - 1]?.key ?? null,
    canCancel: isPaid,
    cancelTo: free?.key ?? null,
  };
}

// ── The queued ask ──────────────────────────────────────────────────────────

export interface PlanRequest {
  id: string;
  /** WorkOS user id of whoever asked. */
  memberId: string;
  /**
   * WHAT they are asking to move: the workspace's plan, or their own seat.
   *
   * They are different asks with different prices and different approvers' reasoning — a
   * seat upgrade costs one seat's difference and affects one person, a plan change moves
   * everybody — but they queue in the same place, because to an owner they are one list of
   * people waiting.
   *
   * Absent means "plan": the field was added after the queue existed, and a stored record
   * without it is a plan request.
   */
  kind?: "plan" | "seat";
  /** The target — a plan key, or a seat-type key when `kind` is "seat". */
  plan: string;
  status: "pending" | "done" | "denied";
  createdAt: string;
  /** Why they are asking, in their words. Optional, capped at 140 chars by the caller. */
  note?: string;
}

/** Has the workspace already reached (or passed) what this request asked for? */
export function isSatisfied(
  request: PlanRequest,
  plans: PlanCatalog,
  currentPlan: string | null,
  /** The asker's seat type now — needed only for a seat request. */
  currentSeatType?: string | null,
): boolean {
  if (request.kind === "seat") {
    const model = currentPlan ? planModel(plans, currentPlan) : null;
    if (!model) return false;
    return seatRank(model, currentSeatType ?? null) >= seatRank(model, request.plan);
  }
  const want = planModel(plans, request.plan);
  const have = currentPlan ? planModel(plans, currentPlan) : null;
  if (!want || !have) return false;
  return planRank(have) >= planRank(want);
}

/**
 * WHICH ask to offer someone who is out of usage. One decision, in one place.
 *
 * The ladder climbs the cheapest, most targeted rung first, and each rung exists because the
 * one below it cannot help:
 *
 *   1. a better SEAT — their pack is what their seat includes, so the way to have more of it
 *      is a bigger seat. A Standard member should be offered this, never a top-up: topping
 *      up buys them a few days and leaves them in the same place next week.
 *   2. CREDITS, where money can actually lift the wall: a `covers: "included"` window paces
 *      only what the plan gives away, and a pack whose plan overflows to the wallet is the
 *      same statement. Paying works, permanently and without anybody's permission, so
 *      asking an owner for a free exception would be the worse of two available answers.
 *   3. extra USAGE on the blocked window — the answer where money CANNOT help: a
 *      `covers: "all"` window is the product's own pace and no purchase touches it, so an
 *      exception somebody grants is the only door.
 *   4. a PLAN change — for a plan with no per-member allowance at all. A pooled plan's
 *      windows belong to the workspace, so there is nothing personal to raise and
 *      `grant_top_up` refuses it outright.
 *
 * Rungs 2 and 3 were ONE rung, and it was wrong in whichever direction the deployment went.
 * A plan whose card says pay-as-you-go sent a blocked member to ask an owner for something
 * they could have bought in a click; a plan pacing the product offered credits that lift
 * nothing, taking money for a wall that would still be there. Which of the two applies is
 * not a preference — it is what `covers` says, so it is read rather than configured again.
 *
 * Returns null when nothing is blocked, which is when nothing should be offered — a control
 * permanently on screen asks a question nobody at 40% can answer.
 */
export function nextUsageAsk(
  model: PlanModel | null,
  input: {
    /** From `topUpTargetOf` — what, if anything, is refusing them, and whether paying lifts it. */
    blocked: { kind: "rate" | "pack"; covers?: "all" | "included" } | null;
    seatType?: string | null;
    plans: PlanCatalog;
    currentPlan?: string | null;
  },
): { ask: "seat"; to: string } | { ask: "credits" } | { ask: "usage" } | { ask: "plan"; to: string } | null {
  if (!input.blocked) return null;

  // Can the customer pay their own way past this? Two conditions, and both are necessary:
  // the plan has to SELL credits, and the wall has to be one credits reach. A pack is
  // reachable when the plan overflows to the wallet; a rate window only when it covers the
  // included allowance alone.
  const sellsCredits = Boolean(model?.replenish?.purchase || model?.replenish?.autoReload);
  const payable =
    sellsCredits &&
    (input.blocked.kind === "pack"
      // Through `exhaustedPolicy`, not `cap.onExhausted`: an agent and a shared seat always
      // overflow to the wallet whatever the cap declares, and a `cap: wallet` plan has no
      // `onExhausted` field at all.
      ? exhaustedPolicy(model, { seatType: input.seatType ?? undefined }) === "wallet"
      : input.blocked.covers === "included");

  if (model?.sells.kind === "seats") {
    const better = nextSeatUp(model, input.seatType ?? null);
    // The seat still comes first, even when credits would work: it raises the pack AND the
    // pace every cycle, where credits are this week's answer bought again next week.
    if (better) return { ask: "seat", to: better };
    // On the best seat: buy more if that is possible, otherwise ask for an exception.
    return payable ? { ask: "credits" } : { ask: "usage" };
  }

  // A pooled plan has nothing personal to raise — but if it sells credits and the pool
  // overflows to the wallet, paying is still a real answer and a better one than asking
  // the workspace to change plan.
  if (payable) return { ask: "credits" };

  // No seats, so nothing per-member to raise. The only route is the workspace buying more
  // product — and if there is nothing above them, there is nothing to offer at all.
  const up = planActions(input.plans, input.currentPlan ?? null).upgradeTo;
  return up ? { ask: "plan", to: up } : null;
}

/** Which tool carries out (or asks for) a rung. Tool names, deliberately: the answer to
 *  "I am blocked, now what" should name the next call, not a UI concept a headless caller
 *  has to translate. */
export type UsageActionTool =
  | "assign_seat_type"
  | "buy_credits"
  | "grant_top_up"
  | "change_plan"
  | "request_seat_change"
  | "request_top_up"
  | "request_plan_change";

export interface UsageAction {
  /** The rung, from `nextUsageAsk`. */
  rung: "seat" | "credits" | "usage" | "plan";
  /** What the rung points at: a seat type, or a plan key. Absent for `credits`/`usage`. */
  to?: string;
  /** Whether the person looking at this can carry it out, or has to ask an admin. */
  actor: "self" | "admin";
  /** The call that does it — the action itself when `actor` is "self", the request when not. */
  action: UsageActionTool;
}

/**
 * The rung, and WHO may act on it. `nextUsageAsk` answers the first half; this answers both.
 *
 * The second half used to be the consumer's, and the note here said so. It came back as a
 * gap: every act on a rung is an owner action — `change_plan`, `assign_seat_type` (a seat is
 * a price), `grant_top_up` — so a member's only route is a request, and each app worked that
 * out again in a React component. Scartoffie's lived in the component that renders the
 * button, which meant an agent hitting the same wall through the API got the rung and no
 * idea that buying was not its call.
 *
 * `purchase` is the one part that is genuinely a deployment's choice (`config.roles.purchase`),
 * because a product whose members hold their own cards is a real arrangement. Everything else
 * follows from gates this library already enforces, so it is read rather than configured
 * twice — and `buy_credits` enforces the same value, which is what makes this answer true
 * rather than advisory.
 */
export function usageAction(
  model: PlanModel | null,
  input: {
    blocked: { kind: "rate" | "pack"; covers?: "all" | "included" } | null;
    seatType?: string | null;
    plans: PlanCatalog;
    currentPlan?: string | null;
    /** The person asking. An org API key with no principal behind it IS the org, so it is
     *  owner-level — the same reading `enforceAdmin` applies. */
    actor?: { isAdmin?: boolean };
    /** `config.roles.purchase`. Defaults to the config default, not to permissive. */
    purchase?: "admin" | "member";
  },
): UsageAction | null {
  const ask = nextUsageAsk(model, input);
  if (!ask) return null;

  const isAdmin = input.actor?.isAdmin ?? true;
  const mayBuy = isAdmin || (input.purchase ?? "admin") === "member";

  switch (ask.ask) {
    case "seat":
      return isAdmin
        ? { rung: "seat", to: ask.to, actor: "admin", action: "assign_seat_type" }
        : { rung: "seat", to: ask.to, actor: "self", action: "request_seat_change" };
    case "credits":
      // The one rung where the answer is money rather than permission, so it is the one
      // rung `roles.purchase` can move.
      return mayBuy
        ? { rung: "credits", actor: "admin", action: "buy_credits" }
        : { rung: "credits", actor: "self", action: "request_top_up" };
    case "usage":
      // Nothing to buy: this window is the product's own pace, and only an exception lifts
      // it. The member asks, an admin grants.
      return isAdmin
        ? { rung: "usage", actor: "admin", action: "grant_top_up" }
        : { rung: "usage", actor: "self", action: "request_top_up" };
    case "plan":
      return isAdmin
        ? { rung: "plan", to: ask.to, actor: "admin", action: "change_plan" }
        : { rung: "plan", to: ask.to, actor: "self", action: "request_plan_change" };
  }
}
