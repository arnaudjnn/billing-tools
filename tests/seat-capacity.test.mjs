// The guardrail on a seat, which is a PRICE.
//
// `assignSeatType` is a metadata write: it changes which pack a person draws and touches the
// subscription not at all. So an owner could move everybody onto the most expensive seat and
// the invoice would never notice — and since a member can now ask for a bigger seat and an
// owner can grant it in one click, that was one click from handing out a €105/month seat for
// free. This is the check that stops it.
//
// Two ceilings, and one policy about not knowing:
//
//   PURCHASED  `getSubscription().seatCounts[type]` — what the workspace pays for.
//   MAX        the plan's own `seatTypes[t].max` — a product rule.
//   UNKNOWN    allow. A library that refused on a number it cannot read would leave owners
//              unable to seat their own team on every adapter that reports none, which is a
//              worse failure than the giveaway.

import assert from "node:assert/strict";
import { test } from "vitest";

import { assignSeatType, listSeatAssignments, seatAssignable, seatCapacity } from "../dist/seats.js";
import { planModel } from "../dist/plan-model.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 2104 }, includedCredits: 1000, min: 1 },
        premium: { price: { monthly: 10523 }, includedCredits: 5000 },
        agent: { price: { monthly: 0 }, includedCredits: 0, shared: true, max: 1 },
      },
    },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
};
const model = planModel(PLANS, "pro");

const withSeats = (seatCounts, members = ["u1", "u2", "u3"]) =>
  fakeAdapter({ members, subscription: { plan: "pro", status: "active", seatCounts } });

// ── purchased ────────────────────────────────────────────────────────────────

test("a seat nobody bought is refused", async () => {
  // The whole point: one Premium purchased, one already taken, so the second is a giveaway.
  const adapter = withSeats({ standard: 3, premium: 1 });
  await assignSeatType(adapter, "org_1", "u1", "premium");

  const res = await seatAssignable(adapter, "org_1", model, "u2", "premium");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_purchased");
  assert.equal(res.purchased, 1);
  assert.equal(res.assigned, 1);
});

test("and one that was bought is allowed", async () => {
  const adapter = withSeats({ standard: 3, premium: 1 });
  assert.deepEqual(await seatAssignable(adapter, "org_1", model, "u1", "premium"), { ok: true });
});

test("re-assigning the SAME member to the seat they hold is not a second seat", async () => {
  // Otherwise a no-op write refuses, and a UI that re-submits the current value breaks.
  const adapter = withSeats({ standard: 3, premium: 1 });
  await assignSeatType(adapter, "org_1", "u1", "premium");
  assert.deepEqual(await seatAssignable(adapter, "org_1", model, "u1", "premium"), { ok: true });
});

test("UNASSIGNED members occupy the default seat, because they draw it", async () => {
  // Counting only explicit assignments let a workspace with one purchased Standard seat put
  // ten people on it — nobody had "assigned" them, and every one of them drew the pack.
  const adapter = withSeats({ standard: 1 }, ["u1", "u2", "u3"]);
  const res = await seatAssignable(adapter, "org_1", model, "u1", "standard");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_purchased");
  assert.equal(res.assigned, 2, "u2 and u3 draw it without an assignment");
});

// ── the plan's own ceiling ───────────────────────────────────────────────────

test("a seat type's max is enforced even when purchasing says nothing", async () => {
  // `max: 1` on the shared agent seat is a product rule, not a price — "there is one".
  const adapter = withSeats({ standard: 3, agent: 99 });
  await assignSeatType(adapter, "org_1", "u1", "agent");

  const res = await seatAssignable(adapter, "org_1", model, "u2", "agent");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "at_max");
});

// ── clearing, and not knowing ────────────────────────────────────────────────

test("clearing a seat is always allowed — it frees capacity", async () => {
  const adapter = withSeats({ standard: 1 });
  assert.deepEqual(await seatAssignable(adapter, "org_1", model, "u1", null), { ok: true });
});

test("no seatCounts means unknown, which means ALLOW", async () => {
  // Every adapter that does not report purchased quantities, and every free or pooled plan.
  // Refusing here would leave an owner unable to seat their own team.
  const adapter = fakeAdapter({ members: ["u1", "u2"], subscription: { plan: "pro", status: "active" } });
  assert.deepEqual(await seatAssignable(adapter, "org_1", model, "u1", "premium"), { ok: true });
});

test("no subscription at all is allowed too, rather than throwing", async () => {
  const adapter = fakeAdapter({ members: ["u1"] });
  assert.deepEqual(await seatAssignable(adapter, "org_1", model, "u1", "premium"), { ok: true });
});

test("a plan that sells no seats has nothing to police", async () => {
  const POOLED = { solo: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 100 }, sale: "free" } };
  const adapter = withSeats({ standard: 0 });
  assert.deepEqual(
    await seatAssignable(adapter, "org_1", planModel(POOLED, "solo"), "u1", "premium"),
    { ok: true },
  );
});

test("an unknown seat type is left to the caller's own validation", async () => {
  // `assign_seat_type` already names the known types in its refusal; a second, vaguer
  // refusal here would just be a worse message for the same mistake.
  const adapter = withSeats({ standard: 3 });
  assert.deepEqual(await seatAssignable(adapter, "org_1", model, "u1", "platinum"), { ok: true });
});

// ── the guard is on the WRITE, not just available ────────────────────────────

test("api.seats.assign refuses a seat that was not purchased", async () => {
  const { createBoundApi } = await import("../dist/bound-api.js");
  const adapter = withSeats({ standard: 3, premium: 1 });
  await assignSeatType(adapter, "org_1", "u1", "premium");
  const api = createBoundApi({
    adapter,
    config: { freeCredits: 0, currency: "eur", baseUrl: "https://x.test", internalDomains: [] },
    plans: PLANS,
  });

  await assert.rejects(() => api.seats.assign("org_1", "u2", "premium"), /Not enough premium seats/);
  // And nothing was written: the refusal has to come BEFORE the store, or the seat is given
  // away and merely reported as refused.
  assert.equal((await listSeatAssignments(adapter, "org_1")).u2, undefined);
});

test("assignUnchecked stays the deliberate way past it", async () => {
  // For seating an invitee before their membership is active, or a migration.
  const { createBoundApi } = await import("../dist/bound-api.js");
  const adapter = withSeats({ standard: 3, premium: 1 });
  await assignSeatType(adapter, "org_1", "u1", "premium");
  const api = createBoundApi({
    adapter,
    config: { freeCredits: 0, currency: "eur", baseUrl: "https://x.test", internalDomains: [] },
    plans: PLANS,
  });

  await api.seats.assignUnchecked("org_1", "u2", "premium");
  assert.equal((await listSeatAssignments(adapter, "org_1")).u2, "premium");
});

// ── the same counting, as a READ ─────────────────────────────────────────────
//
// `seatAssignable` answers for ONE candidate and explains a refusal. A picker needs the
// number before it offers anything, and asking the guard once per seat type costs
// N × (assignments + members + subscription) reads — so consumers stopped asking and
// offered every seat, which is how a UI comes to show an option the write refuses.

test("capacity reports what is left, from the tighter of the two ceilings", async () => {
  const adapter = withSeats({ standard: 3, premium: 2 });
  await assignSeatType(adapter, "org_1", "u1", "premium");

  const premium = await seatCapacity(adapter, "org_1", model, "premium");
  assert.deepEqual(premium, {
    seatType: "premium",
    assigned: 1,
    purchased: 2,
    max: null,
    remaining: 1,
  });

  // Standard is the default seat, so the two members nobody assigned occupy it.
  const standard = await seatCapacity(adapter, "org_1", model, "standard");
  assert.equal(standard.assigned, 2);
  assert.equal(standard.remaining, 1);
});

test("the plan's own max wins when it is tighter than what was purchased", async () => {
  // `agent` is capped at 1 by the product rule whatever the subscription says.
  const adapter = withSeats({ standard: 3, agent: 9 });
  const agent = await seatCapacity(adapter, "org_1", model, "agent");
  assert.equal(agent.max, 1);
  assert.equal(agent.remaining, 1);
});

test("unknown is null, never zero — and a UI must read it as available", async () => {
  // No subscription record at all: nothing declares a ceiling, so nothing is full. Zero
  // here would grey out every seat on every adapter that reports no counts, which is the
  // failure the guard's fail-open exists to avoid.
  const adapter = fakeAdapter({ members: ["u1", "u2"] });
  const res = await seatCapacity(adapter, "org_1", model, "premium");
  assert.equal(res.purchased, null);
  assert.equal(res.max, null);
  assert.equal(res.remaining, null);
});

test("a plan that sells no seats has no capacity to report", async () => {
  const free = planModel({ hobby: { sells: { kind: "nothing" }, sale: "free" } }, "hobby");
  const res = await seatCapacity(fakeAdapter({ members: ["u1"] }), "org_1", free, "standard");
  assert.equal(res.remaining, null);
  assert.equal(res.assigned, 0);
});
