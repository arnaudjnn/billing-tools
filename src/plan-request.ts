import { planActions, planRank } from "./subscription.js";
import { normalizePlans, planModel, type PlanCatalog, type PlanModel } from "./plan-model.js";
import type { BillingAdapter } from "./types.js";

// "Can we move up a plan?" — the ask a member makes when extra allowance is not the answer.
//
// ── Why this is not a top-up ────────────────────────────────────────────────
//
// `requestExtraAllowance` raises ONE window for ONE member until it resets. It cannot help
// where there is nothing per-member to raise: a pooled plan's windows belong to the
// workspace, and `grantExtraAllowance` refuses them outright (`not_capped`). On such a plan
// a member who is out of usage has exactly one route — somebody buys more product — and the
// screen that told them to ask for a top-up was offering a door that does not open.
//
// So this queues the other ask. It is deliberately NOT a purchase: approving does not change
// a plan, take a payment, or touch Stripe. Moving a workspace up a tier is money, and money
// stays behind the checkout an owner completes themselves (`change_plan`). What this does is
// carry the request to whoever can do that, and get out of the way once they have.
//
// ── It answers itself ───────────────────────────────────────────────────────
//
// A request is SATISFIED the moment the workspace is on that plan or better, however it got
// there — the owner may have upgraded before ever reading it. Nothing has to be clicked for
// that to be true, so `pendingPlanRequest` compares plan ranks rather than trusting the
// stored status. A queue that shows a want somebody already granted is worse than no queue.

const REQUESTS_KEY = "btPlanRequests";
/** WorkOS metadata values are 600 chars; the queue is trimmed to fit, oldest settled first. */
const VALUE_LIMIT = 600;

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
   * "people who need more". Absent means `plan`, so records written before seats existed
   * still read.
   */
  kind?: "plan" | "seat";
  /** The plan, or the seat type, they are asking to move to. */
  plan: string;
  status: "pending" | "done" | "denied";
  createdAt: string;
  /** Free text from the asker, trimmed hard — this shares one metadata value. */
  note?: string;
}

async function read(adapter: BillingAdapter, orgId: string): Promise<PlanRequest[]> {
  const md = (await adapter.getOrgMetadata?.(orgId)) ?? {};
  try {
    const parsed = JSON.parse(md[REQUESTS_KEY] ?? "[]") as PlanRequest[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fit the queue into one metadata value, shedding in order of what costs least to lose.
 *
 *   1. NOTES on settled records — decoration on something already answered.
 *   2. settled records themselves — history; losing one costs a UI a row.
 *   3. notes on pending records — the ask survives, its sentence does not.
 *
 * And then it stops. A pending ask is never dropped: somebody is waiting for an answer, and
 * silently deleting the question means they wait for ever. The first version dropped the
 * oldest pending record once nothing else was left, which a test caught by watching an open
 * request disappear — so past that point the WRITE fails instead, and the caller refuses the
 * new request with `queue_full` rather than quietly losing an old one.
 */
function pack(list: PlanRequest[]): { kept: PlanRequest[]; fits: boolean } {
  const byPendingFirst = [...list].sort(
    (a, b) => Number(a.status !== "pending") - Number(b.status !== "pending"),
  );
  const size = (l: PlanRequest[]) => JSON.stringify(l).length;
  let kept = byPendingFirst;
  if (size(kept) <= VALUE_LIMIT) return { kept, fits: true };

  const strip = (r: PlanRequest) => {
    const { note: _note, ...rest } = r;
    return rest as PlanRequest;
  };
  kept = kept.map((r) => (r.status === "pending" ? r : strip(r)));
  while (size(kept) > VALUE_LIMIT) {
    const settledAt = kept.map((r) => r.status !== "pending").lastIndexOf(true);
    if (settledAt === -1) break;
    kept = kept.filter((_, i) => i !== settledAt);
  }
  if (size(kept) > VALUE_LIMIT) kept = kept.map(strip);
  return { kept, fits: size(kept) <= VALUE_LIMIT };
}

async function write(adapter: BillingAdapter, orgId: string, list: PlanRequest[]): Promise<boolean> {
  const { kept, fits } = pack(list);
  if (!fits) return false;
  await adapter.setOrgMetadata?.(orgId, { [REQUESTS_KEY]: JSON.stringify(kept) });
  return true;
}

/** Every request, newest first. */
export async function listPlanRequests(adapter: BillingAdapter, orgId: string): Promise<PlanRequest[]> {
  return (await read(adapter, orgId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * That member's open ask, or null — where "open" means still UNMET.
 *
 * A request whose plan the workspace has since reached is satisfied whether or not anybody
 * marked it so, which is what stops a stale want sitting in an owner's list forever.
 */
export async function pendingPlanRequest(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  opts: { plans: PlanCatalog; currentPlan?: string | null; currentSeatType?: string | null },
): Promise<PlanRequest | null> {
  const open = (await read(adapter, orgId)).find((r) => r.memberId === memberId && r.status === "pending");
  if (!open) return null;
  return isSatisfied(open, opts.plans, opts.currentPlan ?? null, opts.currentSeatType ?? null) ? null : open;
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
 * The seat a member holds when nobody has assigned them one: the cheapest non-shared type.
 *
 * An UNASSIGNED member is not on "no seat" — they draw the plan's entry-level pack, which is
 * what the meter measures them against and what their badge says. Treating absent as zero
 * made the ladder offer a Standard member the Standard seat they were already effectively on,
 * which is how this was caught: the button read "Assegna Posto Standard".
 */
export function defaultSeatOf(model: PlanModel): string | null {
  const ladder = [...model.seatTypes]
    .filter((s) => !s.shared)
    .sort((a, b) => a.price.monthly - b.price.monthly);
  return ladder[0]?.key ?? null;
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
  const ladder = [...model.seatTypes]
    .filter((s) => !s.shared)
    .sort((a, b) => a.price.monthly - b.price.monthly);
  const above = ladder.filter((s) => s.price.monthly > seatRank(model, seatType));
  return above[0]?.key ?? null;
}

/**
 * Ask to move up a SEAT — the answer when a better seat exists.
 *
 * This is the ask a Standard-seat member should be offered, not a top-up: their pack is what
 * their seat includes, and the way to have more of it permanently is a bigger seat. A top-up
 * is the answer only once they are on the best seat there is, where nothing else remains.
 * Same queue, same one-open-ask rule, same "answers itself" behaviour.
 */
export async function requestSeatChange(
  adapter: BillingAdapter,
  orgId: string,
  input: {
    memberId: string;
    plans: PlanCatalog;
    currentPlan?: string | null;
    currentSeatType?: string | null;
    /** Defaults to the next seat up. */
    seatType?: string;
    note?: string;
    id?: string;
    now?: number;
  },
): Promise<{
  ok: boolean;
  id?: string;
  seatType?: string;
  pending?: PlanRequest;
  reason?: "no_upgrade" | "unknown_plan" | "already_pending" | "already_on_it" | "queue_full";
}> {
  const model = input.currentPlan ? planModel(input.plans, input.currentPlan) : null;
  if (!model || model.sells.kind !== "seats") return { ok: false, reason: "no_upgrade" };

  const target = input.seatType ?? nextSeatUp(model, input.currentSeatType ?? null);
  if (!target) return { ok: false, reason: "no_upgrade" };
  if (!model.seatTypes.some((s) => s.key === target)) return { ok: false, reason: "unknown_plan" };
  if (seatRank(model, input.currentSeatType ?? null) >= seatRank(model, target)) {
    return { ok: false, reason: "already_on_it", seatType: target };
  }

  const list = await read(adapter, orgId);
  const open = list.find((r) => r.memberId === input.memberId && r.status === "pending");
  if (open) return { ok: false, reason: "already_pending", pending: open, seatType: open.plan };

  const request: PlanRequest = {
    id: input.id ?? crypto.randomUUID(),
    memberId: input.memberId,
    kind: "seat",
    plan: target,
    status: "pending",
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
    ...(input.note ? { note: input.note.slice(0, 140) } : {}),
  };
  if (!(await write(adapter, orgId, [...list, request]))) {
    return { ok: false, reason: "queue_full" };
  }
  return { ok: true, id: request.id, seatType: target };
}

/**
 * Ask to move up a tier.
 *
 * `plan` defaults to the next one up (`planActions().upgradeTo`) — the member is saying "I
 * need more", not choosing a SKU, and making them pick from a catalogue they may not be able
 * to price is the same mistake as making them name a credit amount.
 */
export async function requestPlanChange(
  adapter: BillingAdapter,
  orgId: string,
  input: {
    memberId: string;
    plans: PlanCatalog;
    currentPlan?: string | null;
    /** Defaults to the next plan up. */
    plan?: string;
    note?: string;
    id?: string;
    now?: number;
  },
): Promise<{
  ok: boolean;
  id?: string;
  plan?: string;
  pending?: PlanRequest;
  reason?: "no_upgrade" | "unknown_plan" | "already_pending" | "already_on_it" | "queue_full";
}> {
  const currentPlan = input.currentPlan ?? null;
  const target = input.plan ?? planActions(input.plans, currentPlan).upgradeTo;
  // Nothing above them: a top tier, or a catalogue whose only other plans are quote-only or
  // hidden. Saying so beats queueing a want nobody can grant.
  if (!target) return { ok: false, reason: "no_upgrade" };
  if (!normalizePlans(input.plans).some((m) => m.key === target)) return { ok: false, reason: "unknown_plan" };

  const stub: PlanRequest = {
    id: "",
    memberId: input.memberId,
    plan: target,
    status: "pending",
    createdAt: "",
  };
  if (isSatisfied(stub, input.plans, currentPlan)) return { ok: false, reason: "already_on_it", plan: target };

  const list = await read(adapter, orgId);
  // One open ask per member, for the same reason the top-up has one: the button that files it
  // cannot choose anything, so pressing it twice would queue the same sentence twice.
  const open = list.find((r) => r.memberId === input.memberId && r.status === "pending");
  if (open && !isSatisfied(open, input.plans, currentPlan)) {
    return { ok: false, reason: "already_pending", pending: open, plan: open.plan };
  }

  const request: PlanRequest = {
    id: input.id ?? crypto.randomUUID(),
    memberId: input.memberId,
    kind: "plan",
    plan: target,
    status: "pending",
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
    ...(input.note ? { note: input.note.slice(0, 140) } : {}),
  };
  if (!(await write(adapter, orgId, [...list.filter((r) => r.id !== request.id), request]))) {
    return { ok: false, reason: "queue_full" };
  }
  return { ok: true, id: request.id, plan: target };
}

/**
 * Mark an ask handled.
 *
 * `done` records that somebody acted on it; it does NOT move the plan, and nothing here
 * touches Stripe. The upgrade itself is `change_plan`, which takes a payment — an approval
 * that silently charged a workspace because a member asked would be the worst possible
 * reading of "approve".
 */
export async function resolvePlanRequest(
  adapter: BillingAdapter,
  orgId: string,
  requestId: string,
  status: "done" | "denied",
): Promise<PlanRequest | null> {
  const list = await read(adapter, orgId);
  const found = list.find((r) => r.id === requestId && r.status === "pending");
  if (!found) return null;
  const updated = { ...found, status };
  await write(
    adapter,
    orgId,
    list.map((r) => (r.id === requestId ? updated : r)),
  );
  return updated;
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
 *   2. extra USAGE on the blocked window — the answer once they are on the best seat there
 *      is, where nothing else remains but more of what they already have.
 *   3. a PLAN change — for a plan with no per-member allowance at all. A pooled plan's
 *      windows belong to the workspace, so there is nothing personal to raise and
 *      `grant_top_up` refuses it outright.
 *
 * Returns null when nothing is blocked, which is when nothing should be offered — a control
 * permanently on screen asks a question nobody at 40% can answer.
 */
export function nextUsageAsk(
  model: PlanModel | null,
  input: {
    /** From `topUpTargetOf` — what, if anything, is refusing them. */
    blocked: { kind: "rate" | "pack" } | null;
    seatType?: string | null;
    plans: PlanCatalog;
    currentPlan?: string | null;
  },
): { ask: "seat"; to: string } | { ask: "usage" } | { ask: "plan"; to: string } | null {
  if (!input.blocked) return null;

  if (model?.sells.kind === "seats") {
    const better = nextSeatUp(model, input.seatType ?? null);
    if (better) return { ask: "seat", to: better };
    // On the best seat: more of the same is all that is left.
    return { ask: "usage" };
  }

  // No seats, so nothing per-member to raise. The only route is the workspace buying more
  // product — and if there is nothing above them, there is nothing to offer at all.
  const up = planActions(input.plans, input.currentPlan ?? null).upgradeTo;
  return up ? { ask: "plan", to: up } : null;
}
