import {
  defaultSeatOf,
  isSatisfied,
  nextSeatUp,
  planActions,
  seatRank,
  type PlanRequest,
} from "./ladder.js";
import { normalizePlans, planModel, type PlanCatalog } from "./plan-model.js";
import type { BillingAdapter } from "./types.js";

// The rungs themselves are pure arithmetic and live in `ladder.ts`, which a pricing page or
// a seat picker can import without this module's adapter. Re-exported here so every existing
// import path keeps working.
export {
  defaultSeatOf,
  isSatisfied,
  isTopSeat,
  nextSeatUp,
  nextUsageAsk,
  seatLadder,
  seatRank,
  seatTypeExists,
  usageAction,
  type PlanRequest,
  type UsageAction,
} from "./ladder.js";

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
