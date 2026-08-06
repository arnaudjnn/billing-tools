// Asking to move up a plan — the ask that is NOT a top-up.
//
// `requestExtraAllowance` raises one window for one member. It cannot help where there is
// nothing per-member to raise: a pooled plan's windows belong to the workspace, and
// `grantExtraAllowance` refuses them outright. On such a plan a member who is out of usage
// has exactly one route — somebody buys more product — and a screen offering them a top-up
// is offering a door that does not open.
//
// Two properties carry the design, and both are about NOT overreaching:
//
//   • resolving is not upgrading. Nothing here touches Stripe, and `done` records that
//     somebody acted, never that a plan moved. An "approve" that charged a workspace because
//     a member asked would be the worst possible reading of the word.
//   • a request answers itself. The moment the workspace is on that plan or better — however
//     it got there — the ask is satisfied, without anyone clicking anything.

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isSatisfied,
  listPlanRequests,
  pendingPlanRequest,
  requestPlanChange,
  resolvePlanRequest,
} from "../dist/plan-request.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 500 }, sale: "free", display: { order: 1 } },
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 } } },
    cap: { kind: "per_seat" },
    sale: "self_serve",
    display: { order: 2 },
  },
  scale: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 9000 }, includedCredits: 5000, min: 1 } } },
    cap: { kind: "per_seat" },
    sale: "self_serve",
    display: { order: 3 },
  },
};

const ask = (adapter, over = {}) =>
  requestPlanChange(adapter, "org_1", { memberId: "u1", plans: PLANS, currentPlan: "hobby", ...over });

test("the plan defaults to the next one up, so nobody picks a SKU", async () => {
  // The member is saying "I need more", not choosing from a catalogue they may not be able
  // to price — the same reason a top-up does not ask them for a credit amount.
  const adapter = fakeAdapter();
  const res = await ask(adapter);

  assert.equal(res.ok, true);
  assert.equal(res.plan, "pro");
});

test("and can be named when they do know", async () => {
  const adapter = fakeAdapter();
  assert.equal((await ask(adapter, { plan: "scale" })).plan, "scale");
});

test("an unknown plan is refused rather than queued", async () => {
  const adapter = fakeAdapter();
  const res = await ask(adapter, { plan: "enterprise_platinum" });
  assert.equal(res.reason, "unknown_plan");
  assert.deepEqual(await listPlanRequests(adapter, "org_1"), []);
});

test("the top plan has nothing to ask for", async () => {
  const adapter = fakeAdapter();
  const res = await ask(adapter, { currentPlan: "scale" });
  assert.equal(res.reason, "no_upgrade");
});

test("asking for a plan you already have is refused, not filed", async () => {
  const adapter = fakeAdapter();
  const res = await ask(adapter, { currentPlan: "scale", plan: "pro" });
  assert.equal(res.reason, "already_on_it");
});

// ── one open ask ─────────────────────────────────────────────────────────────

test("a second ask is refused and hands back the first", async () => {
  const adapter = fakeAdapter();
  const first = await ask(adapter);
  const second = await ask(adapter);

  assert.equal(second.reason, "already_pending");
  assert.equal(second.pending?.id, first.id);
  assert.equal((await listPlanRequests(adapter, "org_1")).length, 1);
});

test("another member may still ask", async () => {
  const adapter = fakeAdapter();
  await ask(adapter);
  assert.equal((await ask(adapter, { memberId: "u2" })).ok, true);
});

// ── it answers itself ────────────────────────────────────────────────────────

test("the ask is satisfied once the workspace reaches that plan, with nobody clicking", async () => {
  // The owner may simply have upgraded. A queue that still shows a want somebody already
  // granted is worse than no queue.
  const adapter = fakeAdapter();
  const res = await ask(adapter);
  assert.ok(await pendingPlanRequest(adapter, "org_1", "u1", { plans: PLANS, currentPlan: "hobby" }));

  assert.equal(
    await pendingPlanRequest(adapter, "org_1", "u1", { plans: PLANS, currentPlan: "pro" }),
    null,
    "on the plan they asked for",
  );
  assert.equal(
    await pendingPlanRequest(adapter, "org_1", "u1", { plans: PLANS, currentPlan: "scale" }),
    null,
    "or better",
  );
  // The record is still there — history, not a lie about the present.
  assert.equal((await listPlanRequests(adapter, "org_1"))[0].id, res.id);
});

test("and a satisfied ask does not block a new one", async () => {
  // They asked for Pro, got Pro, and are now out of Pro. Asking for Scale must work.
  const adapter = fakeAdapter();
  await ask(adapter);
  const next = await ask(adapter, { currentPlan: "pro" });

  assert.equal(next.ok, true);
  assert.equal(next.plan, "scale");
});

test("isSatisfied compares RANK, not plan keys", async () => {
  const req = { id: "r", memberId: "u1", plan: "pro", status: "pending", createdAt: "" };
  assert.equal(isSatisfied(req, PLANS, "hobby"), false);
  assert.equal(isSatisfied(req, PLANS, "pro"), true);
  assert.equal(isSatisfied(req, PLANS, "scale"), true, "a higher tier satisfies it too");
  assert.equal(isSatisfied(req, PLANS, null), false, "no plan satisfies nothing");
});

// ── resolving is not upgrading ───────────────────────────────────────────────

test("resolving records a decision and moves no plan", async () => {
  const adapter = fakeAdapter({ subscription: { plan: "hobby", status: "active" } });
  const res = await ask(adapter);
  const done = await resolvePlanRequest(adapter, "org_1", res.id, "done");

  assert.equal(done.status, "done");
  // The subscription is UNTOUCHED. An upgrade is `change_plan`, which takes a payment, and
  // nothing a member asks for may charge an owner as a side effect of being answered.
  assert.equal((await adapter.getSubscription("org_1")).plan, "hobby");
  assert.equal(await pendingPlanRequest(adapter, "org_1", "u1", { plans: PLANS, currentPlan: "hobby" }), null);
});

test("denying frees them to ask again", async () => {
  const adapter = fakeAdapter();
  const res = await ask(adapter);
  await resolvePlanRequest(adapter, "org_1", res.id, "denied");

  assert.equal((await ask(adapter)).ok, true);
});

test("an unknown or already-settled id resolves to null rather than throwing", async () => {
  const adapter = fakeAdapter();
  const res = await ask(adapter);
  await resolvePlanRequest(adapter, "org_1", res.id, "done");

  assert.equal(await resolvePlanRequest(adapter, "org_1", res.id, "denied"), null, "already settled");
  assert.equal(await resolvePlanRequest(adapter, "org_1", "nope", "done"), null);
});

// ── the metadata budget ──────────────────────────────────────────────────────

test("the queue is trimmed by CHARACTERS, and never drops a pending ask", async () => {
  // Same rule as the top-up queue, for the same reason: one oversized value fails EVERY
  // metadata write for the org, and losing an open ask loses the ask.
  const adapter = fakeAdapter();
  for (let i = 0; i < 25; i++) {
    const r = await requestPlanChange(adapter, "org_1", {
      memberId: `user_${i}`,
      plans: PLANS,
      currentPlan: "hobby",
      note: "per favore, siamo bloccati sul limite settimanale",
    });
    // Settle most of them, leaving the last few open.
    if (i < 22) await resolvePlanRequest(adapter, "org_1", r.id, "done");
  }

  const raw = adapter.store.btPlanRequests;
  assert.ok(raw.length <= 600, `value is ${raw.length} chars`);
  const kept = await listPlanRequests(adapter, "org_1");
  const stillOpen = kept.filter((r) => r.status === "pending").map((r) => r.memberId).sort();
  assert.deepEqual(stillOpen, ["user_22", "user_23", "user_24"], "every open ask survived");
});

test("a queue too full for one more ask REFUSES it rather than dropping an old one", async () => {
  // The line the trimming will not cross. Somebody is waiting for an answer on every pending
  // record, so deleting the question means they wait for ever — and the person who caused the
  // overflow is the one who should hear about it, not a stranger whose ask vanishes.
  const adapter = fakeAdapter();
  const asks = [];
  for (let i = 0; i < 40; i++) {
    asks.push(
      await requestPlanChange(adapter, "org_1", {
        memberId: `user_${String(i).padStart(3, "0")}`,
        plans: PLANS,
        currentPlan: "hobby",
        note: "siamo bloccati e ci serve piu utilizzo per finire il lavoro",
      }),
    );
  }

  const refused = asks.filter((r) => r.reason === "queue_full");
  assert.ok(refused.length > 0, "the queue does fill up");
  const open = (await listPlanRequests(adapter, "org_1")).filter((r) => r.status === "pending");
  assert.equal(open.length, asks.filter((r) => r.ok).length, "everyone who was ACCEPTED is still queued");
  assert.ok(adapter.store.btPlanRequests.length <= 600);
});

// ── which ask to offer ───────────────────────────────────────────────────────

test("a Standard member is offered a bigger SEAT, never a top-up", async () => {
  // The rule that prompted this. Their pack is what their seat includes, so a top-up buys
  // them a few days and leaves them in the same place next week — the seat is the answer.
  const { nextUsageAsk } = await import("../dist/plan-request.js");
  const { planModel } = await import("../dist/plan-model.js");
  const PAID = {
    pro: {
      sells: {
        kind: "seats",
        seatTypes: {
          standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 1 },
          premium: { price: { monthly: 10523 }, includedCredits: 5000 },
        },
      },
      cap: { kind: "per_seat" },
      sale: "self_serve",
    },
  };

  const ask = nextUsageAsk(planModel(PAID, "pro"), {
    blocked: { kind: "rate" },
    seatType: "standard",
    plans: PAID,
    currentPlan: "pro",
  });
  assert.deepEqual(ask, { ask: "seat", to: "premium" });
});

test("on the BEST seat there is nothing above, so it becomes a usage top-up", async () => {
  const { nextUsageAsk } = await import("../dist/plan-request.js");
  const { planModel } = await import("../dist/plan-model.js");
  const PAID = {
    pro: {
      sells: {
        kind: "seats",
        seatTypes: {
          standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 1 },
          premium: { price: { monthly: 10523 }, includedCredits: 5000 },
        },
      },
      cap: { kind: "per_seat" },
      sale: "self_serve",
    },
  };

  assert.deepEqual(
    nextUsageAsk(planModel(PAID, "pro"), {
      blocked: { kind: "rate" },
      seatType: "premium",
      plans: PAID,
      currentPlan: "pro",
    }),
    { ask: "usage" },
  );
});

test("a plan with no seats offers the PLAN, because nothing personal can be raised", async () => {
  const { nextUsageAsk } = await import("../dist/plan-request.js");
  const { planModel } = await import("../dist/plan-model.js");
  assert.deepEqual(
    nextUsageAsk(planModel(PLANS, "hobby"), {
      blocked: { kind: "pack" },
      seatType: null,
      plans: PLANS,
      currentPlan: "hobby",
    }),
    { ask: "plan", to: "pro" },
  );
});

test("nothing blocked offers nothing at all", async () => {
  const { nextUsageAsk } = await import("../dist/plan-request.js");
  const { planModel } = await import("../dist/plan-model.js");
  assert.equal(
    nextUsageAsk(planModel(PLANS, "hobby"), { blocked: null, plans: PLANS, currentPlan: "hobby" }),
    null,
  );
});

test("the top plan with no seats has nothing to offer either", async () => {
  const { nextUsageAsk } = await import("../dist/plan-request.js");
  const POOLED = { solo: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 100 }, sale: "free" } };
  const { planModel } = await import("../dist/plan-model.js");
  assert.equal(
    nextUsageAsk(planModel(POOLED, "solo"), {
      blocked: { kind: "pack" },
      plans: POOLED,
      currentPlan: "solo",
    }),
    null,
  );
});

// ── a seat request answers itself too ────────────────────────────────────────

test("a seat request is satisfied once they hold that seat, or better", async () => {
  const { requestSeatChange, pendingPlanRequest } = await import("../dist/plan-request.js");
  const PAID = {
    pro: {
      sells: {
        kind: "seats",
        seatTypes: {
          standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 1 },
          premium: { price: { monthly: 10523 }, includedCredits: 5000 },
        },
      },
      cap: { kind: "per_seat" },
      sale: "self_serve",
    },
  };
  const adapter = fakeAdapter();
  const res = await requestSeatChange(adapter, "org_1", {
    memberId: "u1",
    plans: PAID,
    currentPlan: "pro",
    currentSeatType: "standard",
  });
  assert.equal(res.seatType, "premium");

  const args = { plans: PAID, currentPlan: "pro" };
  assert.ok(await pendingPlanRequest(adapter, "org_1", "u1", { ...args, currentSeatType: "standard" }));
  assert.equal(
    await pendingPlanRequest(adapter, "org_1", "u1", { ...args, currentSeatType: "premium" }),
    null,
    "the owner assigned the seat; nothing left to answer",
  );
});

test("an UNASSIGNED member is on the default seat, not on none", async () => {
  // They draw the plan's entry-level pack whether or not anybody assigned it, so the ladder
  // must offer the seat ABOVE that. Treating absent as zero offered them the Standard seat
  // they were already effectively on — the button read "Assegna Posto Standard".
  const { nextSeatUp, seatRank, defaultSeatOf } = await import("../dist/plan-request.js");
  const { planModel } = await import("../dist/plan-model.js");
  const PAID = {
    pro: {
      sells: {
        kind: "seats",
        seatTypes: {
          standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 1 },
          premium: { price: { monthly: 10523 }, includedCredits: 5000 },
        },
      },
      cap: { kind: "per_seat" },
      sale: "self_serve",
    },
  };
  const model = planModel(PAID, "pro");

  assert.equal(defaultSeatOf(model), "standard", "the cheapest non-shared type");
  assert.equal(seatRank(model, null), 2104, "absent means the default, not zero");
  assert.equal(nextSeatUp(model, null), "premium", "so the ask is the seat ABOVE it");
  assert.equal(nextSeatUp(model, "premium"), null, "and the best seat has nothing above");
});
