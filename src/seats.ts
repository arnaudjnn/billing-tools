import type { BillingAdapter } from "./types.js";

// Per-member seat-type assignments, stored in the org's metadata via the adapter
// (no new database). A member's seat type decides which per-cycle credit pack their
// usage draws (see createMeter). Absent an assignment, the meter falls back to the
// default user seat. Org-scoped writes — a consumer that wants a per-user admin
// gate checks adapter.isAdmin(orgId, userId) before calling.

const KEY = "seatAssignments"; // org metadata → JSON { [memberId]: seatType }

type Assignments = Record<string, string>;

async function read(adapter: BillingAdapter, orgId: string): Promise<Assignments> {
  const md = (await adapter.getOrgMetadata?.(orgId)) ?? {};
  const raw = md[KEY];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Assignments;
  } catch {
    return {};
  }
}

/** Assign a member to a seat type (pass null/"" to clear → default seat). */
export async function assignSeatType(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  seatType: string | null,
): Promise<void> {
  const map = await read(adapter, orgId);
  if (seatType == null || seatType === "") delete map[memberId];
  else map[memberId] = seatType;
  await adapter.setOrgMetadata?.(orgId, { [KEY]: JSON.stringify(map) });
}

/** The full member → seat-type map for the org. */
export async function listSeatAssignments(
  adapter: BillingAdapter,
  orgId: string,
): Promise<Assignments> {
  return read(adapter, orgId);
}

/** A single member's assigned seat type, or null if unassigned. */
export async function getSeatType(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
): Promise<string | null> {
  return (await read(adapter, orgId))[memberId] ?? null;
}
