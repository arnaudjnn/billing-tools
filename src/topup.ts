import type { BillingAdapter } from "./types.js";
import { cycleWindowFor, packSizeOf, planModel, type PlanCatalog } from "./plan-model.js";
import { getSeatType } from "./seats.js";

// Top-up requests, stored entirely in the org's metadata via the adapter (no new
// database): a user-seat over its cap requests extra credits → an owner approves →
// a per-member EXTRA ALLOWANCE for the current cycle that the meter adds on top of
// the seat pack. Actions are ORG-SCOPED (the caller already holds an org key /
// authenticated session); a consumer that wants a per-user admin gate on approval
// checks adapter.isAdmin(orgId, userId) itself before calling. Auto-top-up for the
// shared reserve is just `setAutoReloadSettings` (the set_auto_reload tool).

// ── Where each record lives, and why they are not in the same place ─────────
//
// Both of these used to be one JSON blob in the ORG's metadata, bounded by a
// guessed record count. Measured against the real limit (WorkOS: 10 keys per
// org, 600 chars per VALUE, ASCII only):
//
//   topUpRequests   175 chars per request → the 4th request overflows the value,
//                   222 with `grantedBy`     or the 3rd for an admin grant
//                                           (the cap said 50 — over 20x too many)
//   topUpGrants      53 chars per member  → the 12th member overflows it, and no
//                                           cycle was ever pruned, so a single
//                                           member's grants also grew forever
//
// An overflow is not a local failure. `setOrgMetadata` and `setSubscription`
// both re-write the WHOLE metadata object, so ONE oversized value makes every
// metadata write for that org fail — including the subscription status sync. A
// long enough top-up history stopped `past_due` from ever being recorded.
//
// So each record now lives where its shape says it should:
//
//   a GRANT is per-member, and is what the meter READS  → stored on the member
//     (`adapter.setUserMetadata`), so every member has their own budget and
//     there is no member ceiling at all. Pruned to the cycle being written,
//     because `extraAllowance` only ever asks for the current one.
//
//   a REQUEST is a shared queue an owner works through  → stays on the org, but
//     trimmed to what FITS rather than to a count, evicting SETTLED records
//     first so a member's unanswered ask is never what gets dropped.
//
// The asymmetry is deliberate: losing a request loses history, losing a grant
// loses allowance the customer was promised.

const REQUESTS_KEY = "topUpRequests"; // org metadata → JSON TopUpRequest[]
const GRANTS_KEY = "topUpGrants"; // org metadata → JSON { [memberId]: { [cycle]: credits } }
const MEMBER_GRANTS_KEY = "btTopUpGrants"; // user metadata → JSON { [orgId]: { [cycle]: credits } }

/**
 * Chars available in one metadata value.
 *
 * WorkOS is the tightest store this library targets (600 per value, 10 keys per
 * org, ASCII), and it is what the shipped adapter writes to. Anything packed
 * into a value is measured against this rather than against a record count —
 * a count cannot be checked against the thing that actually rejects the write,
 * which is exactly how a cap of 50 shipped for a value that holds 2.
 */
export const METADATA_VALUE_LIMIT = 600;

export interface TopUpRequest {
  id: string;
  memberId: string; // requester (WorkOS user id)
  amount: number; // credits requested (e.g. +25% of the seat pack)
  cycle: string; // cycle key the grant applies to (consumer-defined, e.g. "2026-07")
  status: "pending" | "approved" | "denied";
  createdAt: string;
  /** Set when an admin granted it outright rather than approving a request. */
  grantedBy?: string;
}

async function readJson<T>(adapter: BillingAdapter, orgId: string, key: string, fallback: T): Promise<T> {
  const md = (await adapter.getOrgMetadata?.(orgId)) ?? {};
  const raw = md[key];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(adapter: BillingAdapter, orgId: string, key: string, value: unknown): Promise<void> {
  await adapter.setOrgMetadata?.(orgId, { [key]: JSON.stringify(value) });
}

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** org metadata (legacy + fallback): member → cycle → credits. */
type Grants = Record<string, Record<string, number>>;
/** user metadata: org → cycle → credits. Scoped by org because a WorkOS user can
 *  belong to several, and a grant is only good in the one that gave it. */
type MemberGrants = Record<string, Record<string, number>>;

/**
 * Keep the newest requests that FIT, giving up settled records before pending ones.
 *
 * The previous bound was a count (50) on a value that holds 2, which is why this
 * failed in production and never in a test — a count cannot be validated against
 * the thing that rejects the write. Bounding by the same unit the store limits
 * (characters) is the only version that cannot drift from it.
 *
 * A settled record is history; a pending one is a member waiting for an answer.
 * So settled records go first, oldest-first, and pending ones are only dropped
 * when nothing settled is left to give up — at which point the oldest goes,
 * since a request nobody answered for a whole cycle is stale anyway.
 */
export function trimRequestsToBudget(
  list: TopUpRequest[],
  limit = METADATA_VALUE_LIMIT,
): TopUpRequest[] {
  const fits = (l: TopUpRequest[]) => JSON.stringify(l).length <= limit;
  const out = [...list];
  while (!fits(out)) {
    const settled = out.findIndex((r) => r.status !== "pending");
    if (settled >= 0) out.splice(settled, 1);
    else if (out.length > 0) out.shift();
    else break; // an empty array is "[]" — always fits; guards a limit below 2
  }
  return out;
}

/** A member's grant for one cycle, from wherever this adapter can store it. */
async function readGrant(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  cycle: string,
): Promise<number> {
  if (adapter.getUserMetadata) {
    const md = await adapter.getUserMetadata(memberId).catch((): Record<string, string> => ({}));
    const mine = parse<MemberGrants>(md[MEMBER_GRANTS_KEY], {});
    const own = mine[orgId]?.[cycle];
    if (own != null) return own;
    // Fall through rather than returning 0: a grant approved before this version
    // is still in the org blob, and this cycle's allowance must not vanish the
    // moment the library is upgraded.
  }
  const blob = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
  return blob[memberId]?.[cycle] ?? 0;
}

/**
 * How many windows one member may hold a grant on, per org.
 *
 * Three is a cycle plus the two tightest windows a plan realistically declares, and the
 * value has to stay inside WorkOS's 600 characters — the ceiling this whole file is written
 * against.
 */
const KEYS_PER_ORG = 3;

/** Add to a member's grant for one window key, and return the new total. */
async function addGrant(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  cycle: string,
  amount: number,
): Promise<number> {
  const base = await readGrant(adapter, orgId, memberId, cycle);
  const total = base + amount;

  if (adapter.getUserMetadata && adapter.setUserMetadata) {
    const md = await adapter.getUserMetadata(memberId).catch((): Record<string, string> => ({}));
    const mine = parse<MemberGrants>(md[MEMBER_GRANTS_KEY], {});
    // Bounded, but no longer to ONE key. A member can hold a grant on the billing
    // cycle (their seat pack) and another on the window that is actually refusing them
    // right now — a week, say — and keeping only the key being written silently deleted
    // whichever they were not topping up at that moment.
    //
    // `KEYS_PER_ORG` is what bounds the value instead. Insertion order is preserved by
    // JSON objects, so dropping from the front drops the oldest, and a window key stops
    // being readable the moment its window rolls anyway (the key contains the window).
    const existing = mine[orgId] ?? {};
    const merged: Record<string, number> = { ...existing, [cycle]: total };
    const keys = Object.keys(merged);
    mine[orgId] = Object.fromEntries(
      keys.slice(Math.max(0, keys.length - KEYS_PER_ORG)).map((k) => [k, merged[k]]),
    );
    await adapter.setUserMetadata(memberId, { [MEMBER_GRANTS_KEY]: JSON.stringify(mine) });
    return total;
  }

  // No per-member store. The org blob, pruned to this cycle so that at least it
  // stops growing without bound; the ~12-member ceiling stays, which is what
  // implementing getUserMetadata/setUserMetadata buys an adapter.
  const blob = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
  const pruned: Grants = {};
  for (const [m, byCycle] of Object.entries(blob)) {
    if (byCycle?.[cycle] != null) pruned[m] = { [cycle]: byCycle[cycle] };
  }
  // Bounded like the per-member store, and more strictly needed here: this value is shared
  // by every member of the org, so one member's history is everyone's budget.
  const mineNow: Record<string, number> = { ...(blob[memberId] ?? {}), [cycle]: total };
  const mineKeys = Object.keys(mineNow);
  pruned[memberId] = Object.fromEntries(
    mineKeys.slice(Math.max(0, mineKeys.length - KEYS_PER_ORG)).map((k) => [k, mineNow[k]]),
  );
  await writeJson(adapter, orgId, GRANTS_KEY, pruned);
  return total;
}

/** A user requests extra credits for the current cycle (owner must approve). */
export async function requestTopUp(
  adapter: BillingAdapter,
  orgId: string,
  req: { id: string; memberId: string; amount: number; cycle: string; createdAt: string },
): Promise<void> {
  const list = await readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
  list.push({ ...req, status: "pending" });
  await writeJson(adapter, orgId, REQUESTS_KEY, trimRequestsToBudget(list));
}

export async function listTopUpRequests(adapter: BillingAdapter, orgId: string): Promise<TopUpRequest[]> {
  return readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
}

/** Approve a request → adds its amount to the member's cycle grant. Org-scoped;
 *  gate on adapter.isAdmin(orgId, userId) upstream if you need a per-user check. */
export async function approveTopUp(
  adapter: BillingAdapter,
  orgId: string,
  requestId: string,
): Promise<{ ok: boolean; reason?: "not_found" }> {
  const list = await readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
  const req = list.find((r) => r.id === requestId);
  if (!req || req.status !== "pending") return { ok: false, reason: "not_found" };
  req.status = "approved";
  // The grant first: it is the part the meter reads, so if the history write is
  // what fails, the member still has the allowance they were promised.
  await addGrant(adapter, orgId, req.memberId, req.cycle, req.amount);
  // Trimmed on the way out even though nothing was added — an org whose list is
  // already over the limit from a previous version would otherwise be unable to
  // record ANY approval, and this repairs it on the first one.
  await writeJson(adapter, orgId, REQUESTS_KEY, trimRequestsToBudget(list));
  return { ok: true };
}

/**
 * Grant extra allowance to a member DIRECTLY, with no request to approve.
 *
 * The request→approve flow assumed the member notices the wall and asks. An admin
 * looking at a usage screen has already noticed, and had no way to act: every path
 * into a grant needed a `TopUpRequest` that only the member could create. This is
 * that missing half.
 *
 * The grant is also recorded as an already-approved request, so it appears in the
 * same history as the ones that were asked for. A grant that existed only as a
 * number in `topUpGrants` would leave an allowance nobody could explain.
 *
 * `id` makes it idempotent: a double-clicked button grants once.
 */
export async function grantTopUp(
  adapter: BillingAdapter,
  orgId: string,
  input: {
    memberId: string;
    amount: number;
    /** MUST be the key the meter measures with — see `grantExtraAllowance`. */
    cycle: string;
    /** Who granted it, for the history. */
    grantedBy?: string;
    id?: string;
    createdAt?: string;
  },
): Promise<{ ok: boolean; total: number; reason?: "invalid_amount" | "duplicate" }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, total: 0, reason: "invalid_amount" };
  }
  const list = await readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
  if (input.id && list.some((r) => r.id === input.id)) {
    const total = await readGrant(adapter, orgId, input.memberId, input.cycle);
    return { ok: true, total, reason: "duplicate" };
  }

  // The grant before the history, for the reason in `approveTopUp`.
  const total = await addGrant(adapter, orgId, input.memberId, input.cycle, input.amount);

  list.push({
    // A RANDOM id, not `grant_<member>_<cycle>_<amount>`.
    //
    // That default was deterministic, so two identical grants — the same member, cycle and
    // amount, which is exactly what "+25% again" produces — wrote two records sharing one id.
    // It bought no idempotency either, because the dedupe above only fires when the CALLER
    // supplies `id`: the grant applied twice and left two records nothing could tell apart.
    // Every per-record operation then resolves the first match, so denying the second of two
    // identical grants acted on the first, and a UI listing them had duplicate React keys.
    //
    // `id` is how a caller opts INTO idempotency (a double-clicked button passes a stable
    // one). Absent, each grant is its own record, which is what it is.
    id: input.id ?? crypto.randomUUID(),
    memberId: input.memberId,
    amount: input.amount,
    cycle: input.cycle,
    status: "approved",
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
  });

  await writeJson(adapter, orgId, REQUESTS_KEY, trimRequestsToBudget(list));
  return { ok: true, total };
}

/**
 * The same grant, with the cycle resolved the way the METER resolves it.
 *
 * This is the part a caller must not be trusted with. A grant is stored under a
 * cycle key and `resolveAllowance` looks it up under the key that
 * `cycleWindowFor(model, subscriptionPeriod)` produces — the SUBSCRIPTION period
 * when there is one, the calendar month otherwise. A caller passing a plausible
 * "2026-08" for an org whose period starts on the 12th writes a grant that is
 * never read, and nothing anywhere reports an error: the admin sees "granted",
 * the member stays blocked. So the resolution lives here, once, and both the tool
 * and any UI go through it.
 *
 * Returns `not_capped` for a plan that caps nothing per seat (a pool, or a pure
 * wallet). There a grant is not merely useless, it is unreadable: the meter only
 * adds extra allowance on top of a seat PACK, so it would be silently ignored.
 */
export async function grantExtraAllowance(
  adapter: BillingAdapter,
  input: {
    orgId: string;
    plans: PlanCatalog;
    plan?: string | null;
    memberId: string;
    /**
     * Extra as a PERCENTAGE of the member's own seat pack (25 = +25%).
     *
     * The natural unit for this decision: "a quarter more than their seat" means
     * the same thing on a 1 000-credit seat and a 5 000-credit one, where a fixed
     * +250 is a rounding error on one and a third of the other. The pack is
     * resolved here from the member's seat type, so no caller has to know it.
     */
    percent?: number;
    /** An absolute number of credits instead. Exactly one of the two. */
    amount?: number;
    grantedBy?: string;
    id?: string;
    now?: number;
    /**
     * Raise THIS window instead of the billing cycle — `topUpTargetOf` names it.
     *
     * The grant is filed under the window's own key, so it lasts exactly as long as the
     * window does: when the week rolls the key no longer matches and the member is back on
     * the plan's pace, with nothing to expire or clean up.
     */
    windowKey?: string;
    /** What `percent` is a percentage OF, when raising a window rather than a seat pack. */
    basis?: number;
  },
): Promise<{
  ok: boolean;
  /** The member's grand total for the cycle, after this grant. */
  total?: number;
  /** What this call actually added, in credits. */
  granted?: number;
  /** The pack the percentage was taken from. */
  packSize?: number;
  cycle?: string;
  reason?: "invalid_amount" | "not_capped" | "duplicate";
}> {
  const model = planModel(input.plans, input.plan ?? null);
  if (!model || model.cap.kind !== "per_seat") return { ok: false, reason: "not_capped" };

  // A percentage is meaningless without the pack it is a percentage OF, and the
  // pack depends on the member's seat type, so resolve the seat the same way the
  // meter does rather than assuming the default seat.
  const seatType = (await getSeatType(adapter, input.orgId, input.memberId)) || "standard";
  const packSize = packSizeOf(model, seatType);
  if (packSize == null) return { ok: false, reason: "not_capped" };

  // The basis is the window being raised, not always the seat pack: "25% more this week" is
  // a quarter of the week's allowance, and taking a quarter of a monthly pack instead would
  // hand out several weeks' worth under a weekly heading.
  const basis = input.basis ?? packSize;
  const amount =
    input.amount ?? (input.percent != null ? Math.round((basis * input.percent) / 100) : NaN);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "invalid_amount", packSize };
  }

  let period: { start?: string | null; end?: string | null } | null = null;
  try {
    const sub = await adapter.getSubscription?.(input.orgId);
    period = sub ? { start: sub.periodStart ?? null, end: sub.periodEnd ?? null } : null;
  } catch {
    period = null;
  }
  // The window key IS the cycle key unless a tighter window was named.
  const key = input.windowKey ?? cycleWindowFor(model, period, input.now ?? Date.now()).key;

  const res = await grantTopUp(adapter, input.orgId, {
    memberId: input.memberId,
    amount,
    cycle: key,
    grantedBy: input.grantedBy,
    id: input.id,
  });
  return { ...res, granted: amount, packSize, cycle: key };
}

/** What one ask is worth when the plan does not say — the same default `grantExtraAllowance`
 *  applies, so asking for a top-up and being granted one unasked are the same size. */
export const DEFAULT_REQUEST_PERCENT = 25;

/** The member's own request still waiting on an answer, for `cycle`. */
export async function pendingTopUpFor(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  cycle: string,
): Promise<TopUpRequest | null> {
  const list = await readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
  return list.find((r) => r.memberId === memberId && r.cycle === cycle && r.status === "pending") ?? null;
}

/**
 * File a request WITHOUT naming an amount — the mirror of `grantExtraAllowance`.
 *
 * The person asking knows they are out of allowance; they do not know what a reasonable
 * top-up is, and making them type a number invites both the 10-credit ask that solves
 * nothing and the 100 000 one an owner has to talk them down from. So the size comes from
 * the plan (`replenish.request.percent`, default 25%) applied to that member's own seat
 * pack, resolved here the way the meter resolves it.
 *
 * Two refusals matter and neither existed before:
 *
 *   `already_pending`  — one open ask per member per cycle. Without it a button that cannot
 *                        choose an amount is a button that queues an identical request every
 *                        time it is pressed, and the owner answers the same question N times.
 *                        The pending request comes back with the refusal, so a UI can say
 *                        "waiting" instead of failing.
 *   `limit_reached`    — `maxPerCycle` was declared and enforced NOWHERE, so the ceiling a
 *                        plan advertised admitted any number of asks. Counted against what is
 *                        already GRANTED plus what is already QUEUED, because approving the
 *                        queue is what makes it real.
 */
export async function requestExtraAllowance(
  adapter: BillingAdapter,
  input: {
    orgId: string;
    plans: PlanCatalog;
    plan?: string | null;
    memberId: string;
    /** Override the plan's share. Absolute credits win over it, as in `grantExtraAllowance`. */
    percent?: number;
    amount?: number;
    id?: string;
    now?: number;
    /** Ask against THIS window rather than the billing cycle — see `grantExtraAllowance`. */
    windowKey?: string;
    /** What `percent` is a percentage of, when the window is not the seat pack. */
    basis?: number;
  },
): Promise<{
  ok: boolean;
  id?: string;
  /** What was asked for, in credits. */
  amount?: number;
  /** The pack the percentage was taken from. */
  packSize?: number;
  cycle?: string;
  /** The ask already open, when that is why this was refused. */
  pending?: TopUpRequest;
  reason?: "invalid_amount" | "not_capped" | "already_pending" | "limit_reached";
}> {
  const model = planModel(input.plans, input.plan ?? null);
  if (!model || model.cap.kind !== "per_seat") return { ok: false, reason: "not_capped" };

  const seatType = (await getSeatType(adapter, input.orgId, input.memberId)) || "standard";
  const packSize = packSizeOf(model, seatType);
  if (packSize == null) return { ok: false, reason: "not_capped" };

  const percent = input.percent ?? model.replenish.request?.percent ?? DEFAULT_REQUEST_PERCENT;
  const basis = input.basis ?? packSize;
  const amount = input.amount ?? Math.round((basis * percent) / 100);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount", packSize };

  let period: { start?: string | null; end?: string | null } | null = null;
  try {
    const sub = await adapter.getSubscription?.(input.orgId);
    period = sub ? { start: sub.periodStart ?? null, end: sub.periodEnd ?? null } : null;
  } catch {
    period = null;
  }
  const cycleWindow = cycleWindowFor(model, period, input.now ?? Date.now());
  // Asking against the window that is actually refusing them, so an approval lands where it
  // unblocks — and lapses when that window rolls.
  const cycle = { key: input.windowKey ?? cycleWindow.key };

  const open = await pendingTopUpFor(adapter, input.orgId, input.memberId, cycle.key);
  if (open) return { ok: false, reason: "already_pending", pending: open, amount, packSize, cycle: cycle.key };

  const max = model.replenish.request?.maxPerCycle;
  if (max != null) {
    const granted = await readGrant(adapter, input.orgId, input.memberId, cycle.key);
    const queued = (await listTopUpRequests(adapter, input.orgId))
      .filter((r) => r.memberId === input.memberId && r.cycle === cycle.key && r.status === "pending")
      .reduce((sum, r) => sum + r.amount, 0);
    if (granted + queued + amount > max) {
      return { ok: false, reason: "limit_reached", amount, packSize, cycle: cycle.key };
    }
  }

  const id = input.id ?? crypto.randomUUID();
  await requestTopUp(adapter, input.orgId, {
    id,
    memberId: input.memberId,
    amount,
    cycle: cycle.key,
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
  });
  return { ok: true, id, amount, packSize, cycle: cycle.key };
}

export async function denyTopUp(
  adapter: BillingAdapter,
  orgId: string,
  requestId: string,
): Promise<{ ok: boolean; reason?: "not_found" }> {
  const list = await readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
  const req = list.find((r) => r.id === requestId);
  if (!req || req.status !== "pending") return { ok: false, reason: "not_found" };
  req.status = "denied";
  await writeJson(adapter, orgId, REQUESTS_KEY, trimRequestsToBudget(list));
  return { ok: true };
}

/** A member's approved extra allowance for a cycle. `resolveAllowance` reads this
 *  on the hot path and adds it to the seat pack. Reads the member's own store when
 *  the adapter has one, falling back to the org blob so a grant written by an
 *  earlier version is still honoured. */
export async function extraAllowance(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  cycle: string,
): Promise<number> {
  return readGrant(adapter, orgId, memberId, cycle);
}
