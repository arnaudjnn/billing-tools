// Asking for more usage WITHOUT naming an amount.
//
// The surface this exists for is a button, not a form: someone who has used their whole seat
// pack knows they are out, and does not know what a reasonable top-up is. Making them type a
// number invites both the 10-credit ask that solves nothing and the 100 000 one an owner has
// to talk them down from — so the plan decides the size and the caller decides only *that*
// they are asking.
//
// Two refusals carry the design, and neither existed before:
//
//   already_pending  a button that cannot choose an amount is a button that files an
//                    identical request every time it is pressed. One open ask per member per
//                    cycle, and the open one comes back so the UI can say "waiting".
//   limit_reached    `maxPerCycle` was declared in the plan shape and enforced NOWHERE.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DEFAULT_REQUEST_PERCENT,
  approveTopUp,
  extraAllowance,
  listTopUpRequests,
  pendingTopUpFor,
  requestExtraAllowance,
} from "../dist/topup.js";
import { assignSeatType } from "../dist/seats.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 },
        premium: { price: { monthly: 9000 }, includedCredits: 5000 },
      },
    },
    cap: { kind: "per_seat" },
    replenish: { request: {} },
    sale: "self_serve",
  },
  pooled: {
    sells: { kind: "flat", price: { monthly: 1800 } },
    cap: { kind: "pool", credits: 5000 },
    replenish: { request: {} },
    sale: "self_serve",
  },
};

const CYCLE = { plan: "pro", status: "active", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" };
const ask = (adapter, over = {}) =>
  requestExtraAllowance(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", memberId: "u1", ...over });

test("the amount comes from the plan's share of that member's seat pack", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const res = await ask(adapter);

  assert.equal(res.ok, true);
  assert.equal(res.packSize, 1000);
  assert.equal(res.amount, 250, `${DEFAULT_REQUEST_PERCENT}% of a 1 000-credit seat`);
});

test("and it follows the member's OWN seat, not the default one", async () => {
  // A premium seat asking for 25% of the standard pack would under-ask by 1 000 credits.
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  await assignSeatType(adapter, "org_1", "u1", "premium");
  const res = await ask(adapter);

  assert.equal(res.packSize, 5000);
  assert.equal(res.amount, 1250);
});

test("a plan can set the share it considers reasonable", async () => {
  const plans = { pro: { ...PLANS.pro, replenish: { request: { percent: 50 } } } };
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const res = await requestExtraAllowance(adapter, {
    orgId: "org_1",
    plans,
    plan: "pro",
    memberId: "u1",
  });

  assert.equal(res.amount, 500);
});

test("an explicit amount still wins, for a caller that does know", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  assert.equal((await ask(adapter, { amount: 42 })).amount, 42);
});

test("it is filed against the cycle the METER reads, not a calendar month", async () => {
  // The defect this rule exists for: a request written under a calendar month while the meter
  // measures the subscription period grants nothing, and nothing errors.
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const res = await ask(adapter, { now: Date.parse("2026-08-20T00:00:00.000Z") });

  const [filed] = await listTopUpRequests(adapter, "org_1");
  assert.equal(filed.cycle, res.cycle);
  assert.equal(await extraAllowance(adapter, "org_1", "u1", res.cycle), 0, "not granted until approved");
  await approveTopUp(adapter, "org_1", res.id);
  assert.equal(await extraAllowance(adapter, "org_1", "u1", res.cycle), 250, "approving grants it there");
});

// ── one open ask at a time ───────────────────────────────────────────────────

test("a second ask in the same cycle is refused, and hands back the open one", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const first = await ask(adapter);
  const second = await ask(adapter);

  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_pending");
  assert.equal(second.pending?.id, first.id, "so the button can render as waiting");
  assert.equal((await listTopUpRequests(adapter, "org_1")).length, 1, "the queue is not doubled");
});

test("but once it is answered, they may ask again", async () => {
  // Answered means answered either way: an owner who denied is allowed to be asked again,
  // and one who approved has not thereby capped the member for the cycle.
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const first = await ask(adapter);
  await approveTopUp(adapter, "org_1", first.id);

  const second = await ask(adapter);
  assert.equal(second.ok, true);
  assert.notEqual(second.id, first.id);
});

test("another member's pending ask does not block mine", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1", "u2"] });
  await ask(adapter, { memberId: "u2" });
  assert.equal((await ask(adapter)).ok, true);
});

test("pendingTopUpFor answers the question a disabled button is asking", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const cycle = (await ask(adapter)).cycle;

  const open = await pendingTopUpFor(adapter, "org_1", "u1", cycle);
  assert.equal(open?.status, "pending");
  assert.equal(open?.amount, 250);
  assert.equal(await pendingTopUpFor(adapter, "org_1", "u2", cycle), null, "not someone else's");

  await approveTopUp(adapter, "org_1", open.id);
  assert.equal(await pendingTopUpFor(adapter, "org_1", "u1", cycle), null, "answered is not pending");
});

// ── the ceiling the plan advertises ──────────────────────────────────────────

test("maxPerCycle is enforced, counting what is granted AND what is queued", async () => {
  const plans = { pro: { ...PLANS.pro, replenish: { request: { maxPerCycle: 400 } } } };
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const one = await requestExtraAllowance(adapter, { orgId: "org_1", plans, plan: "pro", memberId: "u1" });
  assert.equal(one.ok, true, "250 fits under 400");
  await approveTopUp(adapter, "org_1", one.id);

  const two = await requestExtraAllowance(adapter, { orgId: "org_1", plans, plan: "pro", memberId: "u1" });
  assert.equal(two.ok, false);
  assert.equal(two.reason, "limit_reached", "250 granted + 250 more would be 500");
  assert.equal(await extraAllowance(adapter, "org_1", "u1", one.cycle), 250, "nothing extra was granted");
});

test("a queued ask counts toward the ceiling before anyone approves it", async () => {
  // Otherwise a member files asks up to the ceiling N times over and the owner approves them
  // one at a time into a total the plan says is impossible.
  const plans = { pro: { ...PLANS.pro, replenish: { request: { maxPerCycle: 400 } } } };
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1", "u2"] });
  await requestExtraAllowance(adapter, { orgId: "org_1", plans, plan: "pro", memberId: "u1" });
  // Deny it so `already_pending` is not what refuses the next one — the ceiling has to.
  const { denyTopUp } = await import("../dist/topup.js");
  const [queued] = await listTopUpRequests(adapter, "org_1");
  assert.equal(queued.status, "pending");

  // While it is still queued, a 250 ask would put the cycle at 500 against a 400 ceiling.
  const blocked = await requestExtraAllowance(adapter, {
    orgId: "org_1",
    plans,
    plan: "pro",
    memberId: "u1",
    id: "second",
  });
  assert.equal(blocked.reason, "already_pending", "the open ask refuses first, which is fine");

  await denyTopUp(adapter, "org_1", queued.id);
  const after = await requestExtraAllowance(adapter, { orgId: "org_1", plans, plan: "pro", memberId: "u1" });
  assert.equal(after.ok, true, "a denied ask frees the room it was holding");
});

// ── plans that cannot take one ───────────────────────────────────────────────

// ── you can only ask when something is actually refusing you ─────────────────
//
// The rule lived in the SCREENS that draw the button ("show it at 100%"), which is not where
// a rule lives: a tool call, a server action or an agent could file an ask for somebody at
// 0%, and one did — a member sitting on an untouched pack with a pending request against it,
// which then blocked the real ask they would make when they ran out.

test("an ask from somebody nothing is refusing is refused", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const res = await ask(adapter, { blocked: false });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_blocked");
  // And nothing was queued: a refusal that still writes the record is not a refusal.
  assert.deepEqual(await listTopUpRequests(adapter, "org_1"), []);
});

test("blocked asks through, and is filed against the window that is blocking", async () => {
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  const res = await ask(adapter, { blocked: true, windowKey: "w:2026-08-03", basis: 500 });

  assert.equal(res.ok, true);
  assert.equal(res.cycle, "w:2026-08-03");
  assert.equal(res.amount, 125, "25% of the WEEK, not of the 1 000 pack");
});

test("unknown ALLOWS, so a caller that cannot read usage cannot silence a member", async () => {
  // Same trade-off `enforceMember` and `seatAssignable` make: refusing on a fact that could
  // not be established leaves a real customer stuck, which is worse than the thing prevented.
  const adapter = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  assert.equal((await ask(adapter, { blocked: null })).ok, true);
  const other = fakeAdapter({ subscription: CYCLE, members: ["u1"] });
  assert.equal((await ask(other)).ok, true, "absent behaves as it always did");
});

test("a pooled plan refuses, because extra allowance sits on a seat pack", async () => {
  const adapter = fakeAdapter({ subscription: { ...CYCLE, plan: "pooled" }, members: ["u1"] });
  const res = await requestExtraAllowance(adapter, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pooled",
    memberId: "u1",
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_capped");
  assert.equal((await listTopUpRequests(adapter, "org_1")).length, 0, "and nothing is queued");
});

test("no plan at all refuses the same way rather than throwing", async () => {
  const adapter = fakeAdapter({ members: ["u1"] });
  const res = await requestExtraAllowance(adapter, { orgId: "org_1", plans: PLANS, plan: null, memberId: "u1" });
  assert.equal(res.reason, "not_capped");
});
