// The same defect as test/topup-overflow.test.mjs, in the sibling file.
//
// `seatAssignments` packed `{ [memberId]: seatType }` into ONE org metadata value.
// Measured with real WorkOS ids that is ~43 chars per member, so it overflowed at
// about the 13th — on `cap: per_seat`, the one plan shape whose premise is that a
// workspace has many seats. And because setOrgMetadata re-writes the whole metadata
// object, the overflow failed every metadata write for that org, not just this one.
//
// A seat decides which credit pack a member's usage draws, so losing one is not
// cosmetic: the member silently falls back to the default seat's allowance.

import assert from "node:assert/strict";
import { test } from "vitest";

import { assignSeatType, getSeatType, listSeatAssignments } from "../dist/seats.js";
import { fakeAdapter, WORKOS_MAX_VALUE } from "./helpers.mjs";

const member = (n) => `user_01JQ8Z${String(n).padStart(2, "0")}KX9M4WTVB3YCNRHDEF`;
const ALL = Array.from({ length: 40 }, (_, n) => member(n));

test("one member costs ~43 chars, so a shared value holds about 13", () => {
  // The premise, pinned. A test with short ids would never reach the limit.
  const map = {};
  let n = 0;
  while (JSON.stringify({ ...map, [member(n)]: "premium" }).length <= WORKOS_MAX_VALUE) {
    map[member(n)] = "premium";
    n++;
  }
  assert.ok(n >= 12 && n <= 14, `expected ~13 members to fit, got ${n}`);
});

test("forty members can each hold a seat", async () => {
  // The 13th used to fail this outright.
  const adapter = fakeAdapter({ members: ALL });
  for (const [i, id] of ALL.entries()) {
    await assignSeatType(adapter, "org_1", id, i % 2 ? "premium" : "standard");
  }
  assert.equal(await getSeatType(adapter, "org_1", member(0)), "standard");
  assert.equal(await getSeatType(adapter, "org_1", member(13)), "premium");
  assert.equal(await getSeatType(adapter, "org_1", member(39)), "premium");
  // And nothing went into the shared org value.
  assert.equal(adapter.store.seatAssignments, undefined);

  const all = await listSeatAssignments(adapter, "org_1");
  assert.equal(Object.keys(all).length, 40);
});

test("a seat is scoped to the org that assigned it", async () => {
  // Member metadata is global to the WorkOS user, so without the org key a premium
  // seat in one workspace would draw a premium pack in another.
  const adapter = fakeAdapter({ members: [member(1)] });
  await assignSeatType(adapter, "org_1", member(1), "premium");
  await assignSeatType(adapter, "org_2", member(1), "standard");

  assert.equal(await getSeatType(adapter, "org_1", member(1)), "premium");
  assert.equal(await getSeatType(adapter, "org_2", member(1)), "standard");
});

test("an assignment made by an earlier version still resolves", async () => {
  // The upgrade path: a member must not silently lose their pack.
  const adapter = fakeAdapter({
    members: [member(1)],
    metadata: { seatAssignments: JSON.stringify({ [member(1)]: "premium" }) },
  });
  assert.equal(await getSeatType(adapter, "org_1", member(1)), "premium");
  assert.equal((await listSeatAssignments(adapter, "org_1"))[member(1)], "premium");
});

test("a new assignment overrides a legacy one", async () => {
  const adapter = fakeAdapter({
    members: [member(1)],
    metadata: { seatAssignments: JSON.stringify({ [member(1)]: "premium" }) },
  });
  await assignSeatType(adapter, "org_1", member(1), "standard");

  assert.equal(await getSeatType(adapter, "org_1", member(1)), "standard");
  assert.equal((await listSeatAssignments(adapter, "org_1"))[member(1)], "standard");
});

test("clearing a legacy assignment does not resurrect it", async () => {
  // The reason a cleared seat writes a tombstone instead of deleting: the legacy
  // org map is still read as a fallback, so a plain delete would read back as the
  // OLD seat — a cleared premium member would keep drawing the premium pack.
  const adapter = fakeAdapter({
    members: [member(1)],
    metadata: { seatAssignments: JSON.stringify({ [member(1)]: "premium" }) },
  });
  await assignSeatType(adapter, "org_1", member(1), null);

  assert.equal(await getSeatType(adapter, "org_1", member(1)), null);
  assert.equal(member(1) in (await listSeatAssignments(adapter, "org_1")), false);
});

test("an org already over the limit can still be assigned into", async () => {
  // A workspace upgraded from a version that packed 20 members has an oversized
  // value already, and no org metadata write can succeed until it shrinks. Seats
  // are not trimmable — dropping one downgrades a member — so the new path must
  // avoid writing there at all rather than repairing it.
  const legacy = Object.fromEntries(ALL.slice(0, 20).map((id) => [id, "premium"]));
  const adapter = fakeAdapter({
    members: ALL.slice(0, 21),
    metadata: { seatAssignments: JSON.stringify(legacy) },
  });
  assert.ok(adapter.store.seatAssignments.length > WORKOS_MAX_VALUE);

  await assignSeatType(adapter, "org_1", member(20), "standard");
  assert.equal(await getSeatType(adapter, "org_1", member(20)), "standard");
  // Every legacy seat still resolves — none was dropped to make room.
  assert.equal(await getSeatType(adapter, "org_1", member(0)), "premium");
  assert.equal(Object.keys(await listSeatAssignments(adapter, "org_1")).length, 21);
});

test("an adapter with no per-member store keeps working", async () => {
  // The fallback, unchanged behaviour and unchanged ceiling.
  const adapter = fakeAdapter({ userMetadata: false });
  await assignSeatType(adapter, "org_1", member(1), "premium");

  assert.equal(await getSeatType(adapter, "org_1", member(1)), "premium");
  assert.deepEqual(await listSeatAssignments(adapter, "org_1"), { [member(1)]: "premium" });

  await assignSeatType(adapter, "org_1", member(1), null);
  assert.equal(await getSeatType(adapter, "org_1", member(1)), null);
});
