// The defect this suite exists for: a top-up write that overflowed the store.
//
// Both top-up records lived in ONE org metadata value each, bounded by a guessed
// record count. Measured against WorkOS's real limit (10 keys per org, 600 chars
// per value):
//
//   topUpRequests  175 chars per request → the 4th overflowed, or the 3rd for an
//                  222 with `grantedBy`    admin grant (MAX_STORED_REQUESTS: 50)
//   topUpGrants     53 chars per member  → the 12th member overflowed, and no
//                                          cycle was ever pruned
//
// The blast radius is what makes it serious rather than cosmetic: setOrgMetadata
// and setSubscription both re-write the WHOLE metadata object, so one oversized
// value fails EVERY metadata write for that org — subscription status included.
//
// The fake enforces those limits now (see helpers.mjs), so an overflow fails the
// test the same way it fails production.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  approveTopUp,
  extraAllowance,
  grantTopUp,
  listTopUpRequests,
  requestTopUp,
  trimRequestsToBudget,
  METADATA_VALUE_LIMIT,
} from "../dist/topup.js";
import { fakeAdapter, WORKOS_MAX_VALUE } from "./helpers.mjs";

const CYCLE = "2026-08-14";
// Real WorkOS shapes: the ids are what make these records big, so a test with
// short ids would not reach the limit and would prove nothing.
const member = (n) => `user_01JQ8Z${String(n).padStart(2, "0")}KX9M4WTVB3YCNRHDEF`;
const request = (n) => ({
  id: `req_01JQ8Z${String(n).padStart(2, "0")}KX9M4WTVB3YCNRH`,
  memberId: member(n),
  amount: 250,
  cycle: CYCLE,
  createdAt: "2026-08-03T10:22:31.123Z",
});

test("the limits are what the library thinks they are", () => {
  // Guards the constant against drift from the store it describes.
  assert.equal(METADATA_VALUE_LIMIT, WORKOS_MAX_VALUE);
  // And pins the premise: a single record eats a THIRD of the whole budget, so
  // the old cap of 50 was never reachable. WorkOS ids are what make it that big,
  // which is why these fixtures use real ones.
  const one = [{ ...request(1), status: "pending" }];
  assert.equal(JSON.stringify(one).length, 175);
  const four = Array.from({ length: 4 }, (_, n) => ({ ...request(n), status: "pending" }));
  assert.ok(JSON.stringify(four).length > METADATA_VALUE_LIMIT, "4 requests must not fit");
});

test("a hundred members can each hold a grant", async () => {
  // The headline case. The 12th member used to fail this outright.
  const adapter = fakeAdapter();
  for (let n = 0; n < 100; n++) {
    const res = await grantTopUp(adapter, "org_1", {
      memberId: member(n),
      amount: 250,
      cycle: CYCLE,
      id: `g_${n}`,
    });
    assert.equal(res.ok, true, `member ${n} could not be granted`);
  }
  // Every one is readable by the meter, not just the last.
  for (const n of [0, 11, 12, 50, 99]) {
    assert.equal(await extraAllowance(adapter, "org_1", member(n), CYCLE), 250);
  }
  // And none of it went into the shared org value.
  assert.equal(adapter.store.topUpGrants, undefined);
});

test("grants accumulate for the same member and cycle", async () => {
  const adapter = fakeAdapter();
  await grantTopUp(adapter, "org_1", { memberId: member(1), amount: 250, cycle: CYCLE, id: "a" });
  const res = await grantTopUp(adapter, "org_1", {
    memberId: member(1),
    amount: 100,
    cycle: CYCLE,
    id: "b",
  });
  assert.equal(res.total, 350);
  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 350);
});

test("old keys are dropped rather than kept forever", async () => {
  // The store grew without bound until the value overflowed on its own, so it is pruned —
  // but no longer to ONE key. A member can hold a grant on their billing cycle AND on the
  // tighter window that is actually refusing them (a week), and keeping only the key last
  // written silently deleted whichever they were not topping up at that moment. The bound
  // is now a small number of keys, which is what the 600-char budget actually needs.
  const adapter = fakeAdapter();
  for (const [i, cycle] of ["2026-03-14", "2026-04-14", "2026-05-14", "2026-06-14", "2026-07-14", CYCLE].entries()) {
    await grantTopUp(adapter, "org_1", { memberId: member(1), amount: 250, cycle, id: `g${i}` });
  }

  const stored = JSON.parse(adapter.userStore[member(1)].btTopUpGrants);
  const keys = Object.keys(stored.org_1);
  assert.ok(keys.length <= 3, `bounded, got ${keys.length}`);
  assert.ok(keys.includes(CYCLE), "the one being written survives");
  assert.equal(keys.includes("2026-03-14"), false, "the oldest is gone");
  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 250);
});

test("a cycle grant and a tighter WINDOW grant coexist", async () => {
  // The point of keeping more than one key. A weekly exception must not delete the pack
  // top-up the same member is holding, and vice versa — they raise different windows.
  const adapter = fakeAdapter();
  await grantTopUp(adapter, "org_1", { memberId: member(1), amount: 250, cycle: CYCLE, id: "pack" });
  await grantTopUp(adapter, "org_1", { memberId: member(1), amount: 125, cycle: "w:2026-08-03", id: "week" });

  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 250);
  assert.equal(await extraAllowance(adapter, "org_1", member(1), "w:2026-08-03"), 125);
  // And the week's expires by being unreadable: next week is a different key.
  assert.equal(await extraAllowance(adapter, "org_1", member(1), "w:2026-08-10"), 0);
});

test("a grant is scoped to the org that gave it", async () => {
  // Member metadata is global to the WorkOS user, so without the org key a grant
  // in one workspace would be spendable in another.
  const adapter = fakeAdapter();
  await grantTopUp(adapter, "org_1", { memberId: member(1), amount: 250, cycle: CYCLE, id: "a" });
  await grantTopUp(adapter, "org_2", { memberId: member(1), amount: 900, cycle: CYCLE, id: "b" });

  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 250);
  assert.equal(await extraAllowance(adapter, "org_2", member(1), CYCLE), 900);
});

test("a grant written by an earlier version is still honoured", async () => {
  // The upgrade path: an in-flight cycle's allowance must not disappear because
  // the library started reading somewhere else.
  const adapter = fakeAdapter({
    metadata: { topUpGrants: JSON.stringify({ [member(1)]: { [CYCLE]: 400 } }) },
  });
  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 400);

  // And a further grant adds to it rather than resetting it.
  const res = await grantTopUp(adapter, "org_1", {
    memberId: member(1),
    amount: 100,
    cycle: CYCLE,
    id: "a",
  });
  assert.equal(res.total, 500);
  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 500);
});

test("an adapter with no per-member store still works, and stays bounded", async () => {
  // The fallback for a custom adapter. The member ceiling remains — that is what
  // implementing getUserMetadata buys — but growth over windows does not. Bounded more
  // strictly here than on the per-member store, because this value is shared by every
  // member of the org: one member's history is everyone's budget.
  const adapter = fakeAdapter({ userMetadata: false });
  for (const [i, cycle] of ["2026-05-14", "2026-06-14", "2026-07-14", CYCLE].entries()) {
    await grantTopUp(adapter, "org_1", { memberId: member(1), amount: 250, cycle, id: `g${i}` });
  }

  assert.equal(await extraAllowance(adapter, "org_1", member(1), CYCLE), 250);
  const keys = Object.keys(JSON.parse(adapter.store.topUpGrants)[member(1)]);
  assert.ok(keys.length <= 3, `bounded, got ${keys.length}`);
  assert.ok(keys.includes(CYCLE));
  assert.equal(keys.includes("2026-05-14"), false, "the oldest is gone");
});

test("many requests never overflow the value", async () => {
  // The 3rd request used to fail. Requests are a queue, so the list is trimmed
  // to what fits instead of to a count that the store never agreed to.
  const adapter = fakeAdapter();
  for (let n = 0; n < 30; n++) {
    await requestTopUp(adapter, "org_1", request(n));
  }
  assert.ok(adapter.store.topUpRequests.length <= METADATA_VALUE_LIMIT);
  const kept = await listTopUpRequests(adapter, "org_1");
  assert.ok(kept.length >= 1, "the queue cannot be emptied by trimming");
  // Newest survive: an owner works through what just came in.
  assert.equal(kept.at(-1).id, request(29).id);
});

test("a settled record is given up before a pending one", () => {
  // Losing history is a cost; losing a member's unanswered ask is a defect.
  const settled = (n) => ({ ...request(n), status: "approved", grantedBy: member(99) });
  const pending = (n) => ({ ...request(n), status: "pending" });
  const kept = trimRequestsToBudget([settled(1), pending(2), settled(3), pending(4)]);

  // Both asks survive; the history is what paid for the room.
  assert.deepEqual(
    kept.filter((r) => r.status === "pending").map((r) => r.id),
    [request(2).id, request(4).id],
  );
  assert.ok(kept.length < 4, "something had to go");
  assert.ok(
    kept.filter((r) => r.status !== "pending").length < 2,
    "a settled record is what goes first",
  );
  // And no more is given up than the budget demands.
  assert.ok(JSON.stringify(kept).length <= METADATA_VALUE_LIMIT);
});

test("an org already over the limit is repaired, not bricked", async () => {
  // A workspace upgraded from a version that wrote 50 records has an oversized
  // value already. Approving must fix it rather than fail forever — and until it
  // is fixed, nothing else can write org metadata either.
  const oversized = Array.from({ length: 50 }, (_, n) => ({ ...request(n), status: "approved" }));
  oversized.push({ ...request(90), status: "pending" });
  const adapter = fakeAdapter({ metadata: { topUpRequests: JSON.stringify(oversized) } });
  assert.ok(adapter.store.topUpRequests.length > METADATA_VALUE_LIMIT);

  const res = await approveTopUp(adapter, "org_1", request(90).id);
  assert.equal(res.ok, true);
  assert.ok(adapter.store.topUpRequests.length <= METADATA_VALUE_LIMIT);
  // The approval it was asked for actually landed.
  assert.equal(await extraAllowance(adapter, "org_1", member(90), CYCLE), 250);
});
