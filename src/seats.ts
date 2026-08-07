import { defaultSeatOf } from "./ladder.js";
import type { BillingAdapter } from "./types.js";
import type { PlanModel } from "./plan-model.js";

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

/**
 * Drop a workspace's entries from each member's own metadata, and report how many were.
 *
 * Called when a workspace closes. Both per-member stores are keyed by org
 * (`{ [orgId]: … }`) precisely so one workspace cannot read or overwrite another's — the same
 * keying means a closed workspace's entries would otherwise sit in every ex-member's record
 * for ever, spending a budget measured in characters (10 keys, 600 chars per value) that their
 * REMAINING workspaces still need. A person who has passed through a few dead workspaces would
 * eventually be unable to be assigned a seat anywhere.
 *
 * A `""` tombstone is NOT written here, unlike a cleared seat: there is no legacy org map left
 * to fall back to, because the org is going away with it.
 */
export async function clearMemberRecords(
  adapter: BillingAdapter,
  orgId: string,
  memberIds: readonly string[],
): Promise<number> {
  if (!adapter.getUserMetadata || !adapter.setUserMetadata) return 0;
  let cleared = 0;
  for (const memberId of memberIds) {
    const meta = await adapter.getUserMetadata(memberId).catch(() => null);
    if (!meta) continue;
    const patch: Record<string, string | null> = {};
    for (const key of [MEMBER_KEY, MEMBER_GRANTS_KEY_FOR_CLEANUP]) {
      const raw = meta[key];
      if (!raw) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!(orgId in parsed)) continue;
      delete parsed[orgId];
      // An empty object is written as null (delete the key) rather than "{}", so the budget is
      // actually returned rather than merely reduced.
      patch[key] = Object.keys(parsed).length ? JSON.stringify(parsed) : null;
    }
    if (Object.keys(patch).length) {
      await adapter.setUserMetadata(memberId, patch);
      cleared++;
    }
  }
  return cleared;
}

/** Kept beside `MEMBER_KEY` so one cleanup knows both stores. Mirrors topup.ts. */
const MEMBER_GRANTS_KEY_FOR_CLEANUP = "btTopUpGrants";

/**
 * Whether this member can be put on `seatType` — the guardrail that stops a seat being
 * given away.
 *
 * `assignSeatType` is a metadata write: it changes which pack a person draws and touches the
 * subscription not at all. So an owner could move everybody onto the most expensive seat and
 * the invoice would never notice — and since a member can now ASK for a bigger seat and an
 * owner can grant it in one click, that is one click from handing out a €105/month seat for
 * nothing. Two ceilings answer it:
 *
 *   PURCHASED — `getSubscription().seatCounts[seatType]`, what the workspace is paying for.
 *     Assigning more of a type than were bought is selling at zero.
 *   MAX — the plan's own `seatTypes[t].max`, a product rule ("one shared agent seat").
 *
 * The DEFAULT seat counts unassigned members too, because they draw it whether or not
 * anybody said so — counting only explicit assignments would let a workspace with one
 * purchased Standard seat quietly seat ten people on it.
 *
 * Unknown means ALLOW, deliberately, and there is a lot of unknown: no subscription record,
 * no `seatCounts` (a plan that sells no seats, a free plan, a record written before seat
 * counts existed), no `listMemberIds`. Refusing on a number the library cannot read would
 * break every deployment whose adapter does not report one, and the failure would be an
 * owner unable to seat their own team — worse than the giveaway being prevented.
 */
export async function seatAssignable(
  adapter: BillingAdapter,
  orgId: string,
  model: PlanModel | null,
  memberId: string,
  seatType: string | null,
): Promise<{ ok: true } | { ok: false; reason: "not_purchased" | "at_max"; purchased?: number; assigned: number }> {
  // Clearing a seat frees capacity; it can never exceed anything.
  if (!seatType || !model || model.sells.kind !== "seats") return { ok: true };

  const spec = model.seatTypes.find((s) => s.key === seatType);
  if (!spec) return { ok: true }; // unknown type — the caller validates that separately

  const { assigned, purchased } = await occupancy(adapter, orgId, model, seatType, memberId);

  if (spec.max != null && assigned + 1 > spec.max) {
    return { ok: false, reason: "at_max", assigned };
  }
  if (purchased != null && assigned + 1 > purchased) {
    return { ok: false, reason: "not_purchased", purchased, assigned };
  }
  return { ok: true };
}

/** How many hold this seat, and how many were bought — the two numbers both the guard and
 *  the capacity read are counting. `exclude` leaves one member out, which is what makes the
 *  guard ask "is there room for THEM" rather than "is there room for one more". */
async function occupancy(
  adapter: BillingAdapter,
  orgId: string,
  model: PlanModel,
  seatType: string,
  exclude?: string,
): Promise<{ assigned: number; purchased: number | null }> {
  const assignments = await listSeatAssignments(adapter, orgId);
  const already = Object.entries(assignments).filter(([id, t]) => t === seatType && id !== exclude).length;

  // Unassigned members draw the default seat, so they occupy it.
  let implicit = 0;
  if (defaultSeatOf(model) === seatType && adapter.listMemberIds) {
    const members = await adapter.listMemberIds(orgId).catch((): string[] => []);
    implicit = members.filter((id) => id !== exclude && !assignments[id]).length;
  }
  const purchased = (await adapter.getSubscription?.(orgId).catch(() => null))?.seatCounts?.[seatType];
  return { assigned: already + implicit, purchased: purchased ?? null };
}

/**
 * How much room is left on a seat type — the same counting `seatAssignable` does, as a READ.
 *
 * The guard answers "may I put THIS member here", one candidate at a time, and returns a
 * reason when the answer is no. That is the wrong shape for the two things a caller actually
 * wants before it offers a control: how many are left, and whether to grey the option out at
 * all. Asking the guard N times to draw one picker is N × (assignments + members +
 * subscription) reads, so consumers stopped asking and offered every seat — which is how a
 * picker comes to show a Premium seat that the write then refuses.
 *
 * `remaining: null` means UNKNOWN, not zero, and it is the common case: no subscription
 * record, no `seatCounts`, no `max`. Unknown allows, exactly as the guard does — a UI must
 * render an unknown as available, never as full.
 */
export async function seatCapacity(
  adapter: BillingAdapter,
  orgId: string,
  model: PlanModel | null,
  seatType: string,
): Promise<{ seatType: string; assigned: number; purchased: number | null; max: number | null; remaining: number | null }> {
  const spec = model?.seatTypes.find((s) => s.key === seatType);
  if (!model || !spec || model.sells.kind !== "seats") {
    return { seatType, assigned: 0, purchased: null, max: null, remaining: null };
  }
  const { assigned, purchased } = await occupancy(adapter, orgId, model, seatType);
  const max = spec.max ?? null;
  const ceilings = [max, purchased].filter((n): n is number => n != null);
  return {
    seatType,
    assigned,
    purchased,
    max,
    remaining: ceilings.length ? Math.max(0, Math.min(...ceilings) - assigned) : null,
  };
}
