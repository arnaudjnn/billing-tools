import type { BillingAdapter } from "./types.js";

// Per-member seat-type assignments: a member's seat type decides which per-cycle
// credit pack their usage draws (see createMeter). Absent an assignment, the meter
// falls back to the default user seat. Org-scoped writes — a consumer that wants a
// per-user admin gate checks adapter.isAdmin(orgId, userId) before calling.
//
// ── Why this is stored on the MEMBER ────────────────────────────────────────
//
// It used to be one JSON map in an org metadata value, `{ [memberId]: seatType }`.
// Measured against the real limit (WorkOS: values ≤600 chars), that is ~43 chars
// per member, so it overflowed at about the 13th — on the one plan shape whose
// premise is that a workspace has many seats. And the failure is not local:
// setOrgMetadata re-writes the WHOLE metadata object, so a single oversized value
// fails every metadata write for that org, subscription sync included. The same
// defect as the top-up grants next door; see the note at the top of `topup.ts`.
//
// So an assignment lives on the member (`adapter.setUserMetadata`), keyed by org
// because WorkOS user metadata is global to the user and a seat is only good in the
// workspace that assigned it. Each member has their own budget, which removes the
// ceiling rather than raising it.
//
// The legacy org map is still READ as a fallback, so an assignment made by an
// earlier version keeps resolving. It is never written again: an org whose value is
// already over the limit cannot be written at all, and repairing it by dropping
// entries would silently downgrade a member's pack. A cleared seat therefore
// records an explicit tombstone instead of deleting, or the fallback would
// resurrect the old value.

const KEY = "seatAssignments"; // org metadata → JSON { [memberId]: seatType } (legacy)
const MEMBER_KEY = "btSeatType"; // user metadata → JSON { [orgId]: seatType | "" }

type Assignments = Record<string, string>;
/** "" is a tombstone: assigned once, then explicitly cleared. */
type MemberSeats = Record<string, string>;

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The legacy org-wide map. Read-only now — see the note above. */
async function readOrgMap(adapter: BillingAdapter, orgId: string): Promise<Assignments> {
  const md = (await adapter.getOrgMetadata?.(orgId)) ?? {};
  return parse<Assignments>(md[KEY], {});
}

async function readMemberSeats(adapter: BillingAdapter, memberId: string): Promise<MemberSeats> {
  const md = await adapter.getUserMetadata!(memberId).catch((): Record<string, string> => ({}));
  return parse<MemberSeats>(md[MEMBER_KEY], {});
}

/** Assign a member to a seat type (pass null/"" to clear → default seat). */
export async function assignSeatType(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  seatType: string | null,
): Promise<void> {
  if (adapter.getUserMetadata && adapter.setUserMetadata) {
    const mine = await readMemberSeats(adapter, memberId);
    // A tombstone rather than a delete: the legacy org map is still a fallback, so
    // "no entry" would read back as the old seat instead of the default one.
    mine[orgId] = seatType == null ? "" : seatType;
    await adapter.setUserMetadata(memberId, { [MEMBER_KEY]: JSON.stringify(mine) });
    return;
  }

  // No per-member store: the org map, with its ~13-member ceiling. Lifting that
  // ceiling is what implementing getUserMetadata/setUserMetadata buys an adapter.
  const map = await readOrgMap(adapter, orgId);
  if (seatType == null || seatType === "") delete map[memberId];
  else map[memberId] = seatType;
  await adapter.setOrgMetadata?.(orgId, { [KEY]: JSON.stringify(map) });
}

/**
 * The full member → seat-type map for the org.
 *
 * A per-member store can be asked about a member but not who the members are, so
 * enumerating needs `adapter.listMemberIds`. Without it this returns what the
 * legacy org map holds — which is everything an adapter with no per-member store
 * has anyway. N reads for N members: an admin screen, not the hot path, and the
 * same shape `memberUsage` already documents.
 */
export async function listSeatAssignments(
  adapter: BillingAdapter,
  orgId: string,
): Promise<Assignments> {
  const out: Assignments = await readOrgMap(adapter, orgId);
  if (!adapter.getUserMetadata || !adapter.listMemberIds) return out;

  const memberIds = await adapter.listMemberIds(orgId).catch((): string[] => []);
  const seats = await Promise.all(
    memberIds.map((id) => readMemberSeats(adapter, id).then((m) => [id, m[orgId]] as const)),
  );
  for (const [id, seat] of seats) {
    if (seat === undefined) continue; // never assigned here — keep any legacy entry
    else if (seat === "") delete out[id]; // explicitly cleared: the default seat
    else out[id] = seat; // the member's own record wins over a legacy one
  }
  return out;
}

/** A single member's assigned seat type, or null if unassigned. */
export async function getSeatType(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
): Promise<string | null> {
  if (adapter.getUserMetadata) {
    const own = (await readMemberSeats(adapter, memberId))[orgId];
    if (own === "") return null; // cleared, and the legacy map must not override it
    if (own) return own;
    // Otherwise fall through: an assignment made before this version is still in
    // the org map, and a member must not silently lose their pack on upgrade.
  }
  return (await readOrgMap(adapter, orgId))[memberId] ?? null;
}
