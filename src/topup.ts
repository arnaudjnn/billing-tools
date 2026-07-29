import { getBillingCustomerId, setAutoReloadSettings } from "./billing.js";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

// Top-up + admin helpers, stored entirely in the org's WorkOS metadata via the
// adapter (no new database). Two things live here:
//   • User-seat top-up requests → owner/admin approval → a per-member EXTRA
//     ALLOWANCE for the current cycle that the meter adds on top of the seat pack.
//   • Admin-gated auto-top-up (auto-reload) for the shared reserve.

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

/** Owner/admin approves a request → adds its amount to the member's cycle grant. */
export async function approveTopUp(
  adapter: BillingAdapter,
  orgId: string,
  actingUserId: string,
  requestId: string,
): Promise<{ ok: boolean; reason?: "forbidden" | "not_found" }> {
  if (!(await adapter.isAdmin?.(orgId, actingUserId))) return { ok: false, reason: "forbidden" };
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
  actingUserId: string,
  requestId: string,
): Promise<{ ok: boolean; reason?: "forbidden" | "not_found" }> {
  if (!(await adapter.isAdmin?.(orgId, actingUserId))) return { ok: false, reason: "forbidden" };
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
): Promise<number> {
  const grants = await readJson<Grants>(adapter, orgId, GRANTS_KEY, {});
  return grants[memberId]?.[cycle] ?? 0;
}

/** Enable/disable auto-top-up (auto-reload) for the shared reserve — admin only.
 *  The card itself is added via the Stripe billing portal / a saved payment
 *  method; this just sets the reload threshold + target. */
export async function setAutoTopUp(
  adapter: BillingAdapter,
  _config: ResolvedConfig,
  orgId: string,
  actingUserId: string,
  opts: { threshold: number; reloadTo: number; enabled: boolean },
): Promise<{ ok: boolean; reason?: "forbidden" | "no_billing" }> {
  if (!(await adapter.isAdmin?.(orgId, actingUserId))) return { ok: false, reason: "forbidden" };
  const customerId = await getBillingCustomerId(adapter, orgId);
  if (!customerId) return { ok: false, reason: "no_billing" };
  await setAutoReloadSettings(customerId, opts.threshold, opts.reloadTo, opts.enabled);
  return { ok: true };
}
