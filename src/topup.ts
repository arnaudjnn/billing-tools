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

const REQUESTS_KEY = "topUpRequests"; // org metadata → JSON TopUpRequest[]
const GRANTS_KEY = "topUpGrants"; // org metadata → JSON { [memberId]: { [cycle]: credits } }
const MAX_STORED_REQUESTS = 50;

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

type Grants = Record<string, Record<string, number>>;

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

/** A user requests extra credits for the current cycle (owner must approve). */
export async function requestTopUp(
  adapter: BillingAdapter,
  orgId: string,
  req: { id: string; memberId: string; amount: number; cycle: string; createdAt: string },
): Promise<void> {
  const list = await readJson<TopUpRequest[]>(adapter, orgId, REQUESTS_KEY, []);
  list.push({ ...req, status: "pending" });
  await writeJson(adapter, orgId, REQUESTS_KEY, list.slice(-MAX_STORED_REQUESTS));
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
  const grants = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
  grants[req.memberId] = grants[req.memberId] ?? {};
  grants[req.memberId][req.cycle] = (grants[req.memberId][req.cycle] ?? 0) + req.amount;
  await writeJson(adapter, orgId, REQUESTS_KEY, list);
  await writeJson(adapter, orgId, GRANTS_KEY, grants);
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
    const grants = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
    return { ok: true, total: grants[input.memberId]?.[input.cycle] ?? 0, reason: "duplicate" };
  }

  const grants = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
  grants[input.memberId] = grants[input.memberId] ?? {};
  const total = (grants[input.memberId][input.cycle] ?? 0) + input.amount;
  grants[input.memberId][input.cycle] = total;

  list.push({
    id: input.id ?? `grant_${input.memberId}_${input.cycle}_${input.amount}`,
    memberId: input.memberId,
    amount: input.amount,
    cycle: input.cycle,
    status: "approved",
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
  });

  await writeJson(adapter, orgId, REQUESTS_KEY, list.slice(-MAX_STORED_REQUESTS));
  await writeJson(adapter, orgId, GRANTS_KEY, grants);
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

  const amount =
    input.amount ??
    (input.percent != null ? Math.round((packSize * input.percent) / 100) : NaN);
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
  const cycle = cycleWindowFor(model, period, input.now ?? Date.now());

  const res = await grantTopUp(adapter, input.orgId, {
    memberId: input.memberId,
    amount,
    cycle: cycle.key,
    grantedBy: input.grantedBy,
    id: input.id,
  });
  return { ...res, granted: amount, packSize, cycle: cycle.key };
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
  await writeJson(adapter, orgId, REQUESTS_KEY, list);
  return { ok: true };
}

/** A member's approved extra allowance for a cycle. The consumer reads this and
 *  passes it into `meterUsage` as `extraAllowance` so the meter adds it to the
 *  seat pack. */
export async function extraAllowance(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  cycle: string,
  /** Key this library used before the cycle came from the subscription period.
   *  Consulted only when the current key has no entry, so a grant approved under
   *  the old scheme still applies and one approved under both is not counted
   *  twice. Removable once no live org has a pre-migration grant. */
  legacyCycle?: string,
): Promise<number> {
  const grants = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
  const forMember = grants[memberId];
  if (!forMember) return 0;
  const current = forMember[cycle];
  if (current !== undefined) return current;
  if (legacyCycle && forMember[legacyCycle] !== undefined) return forMember[legacyCycle];
  return 0;
}
