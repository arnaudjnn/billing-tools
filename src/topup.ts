import type { BillingAdapter } from "./types.js";

// Top-up requests, stored entirely in the org's metadata via the adapter (no new
// database): a user-seat over its cap requests extra tokens → an owner approves →
// a per-member EXTRA ALLOWANCE for the current cycle that the meter adds on top of
// the seat pack. Actions are ORG-SCOPED (the caller already holds an org key /
// authenticated session); a consumer that wants a per-user admin gate on approval
// checks adapter.isAdmin(orgId, userId) itself before calling. Auto-top-up for the
// shared reserve is just `setAutoReloadSettings` (the set_auto_reload tool).

const REQUESTS_KEY = "topUpRequests"; // org metadata → JSON TopUpRequest[]
const GRANTS_KEY = "topUpGrants"; // org metadata → JSON { [memberId]: { [cycle]: tokens } }
const MAX_STORED_REQUESTS = 50;

export interface TopUpRequest {
  id: string;
  memberId: string; // requester (WorkOS user id)
  amount: number; // tokens requested (e.g. +25% of the seat pack)
  cycle: string; // cycle key the grant applies to (consumer-defined, e.g. "2026-07")
  status: "pending" | "approved" | "denied";
  createdAt: string;
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

/** A user requests extra tokens for the current cycle (owner must approve). */
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
