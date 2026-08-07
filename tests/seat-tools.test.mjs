// The seat tools answer about the WORKSPACE'S plan, not about the catalogue.
//
// `assign_seat_type` used to validate a seat key against the union of every seat type in
// every plan. On a two-plan catalogue that reads as "premium is a known seat type", so a
// workspace on a plan that sells only Standard could be assigned Premium: the write is
// metadata, `seatAssignable` fails open on a spec it cannot find (deliberately — see
// seat-capacity.test.mjs), and the member then drew a pack nobody bought. Nothing in the
// chain was checking the one thing that mattered.
//
// `list_seats` had the mirror problem: it advertised the catalogue's seat types, so the
// picker built from its answer offered the very seat the write refuses.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { runWithResolvedOrg } from "../dist/auth.js";
import { createDispatcher } from "../dist/dispatch.js";
import { registerBillingTools } from "../dist/tools/register.js";
import { assignSeatType } from "../dist/seats.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  // Sells ONE seat type.
  starter: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2104 }, includedCredits: 1000 } } },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
  // Sells two, one of which the plan above has never heard of.
  scale: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 2104 }, includedCredits: 1000 },
        premium: { price: { monthly: 10523 }, includedCredits: 5000 },
      },
    },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
};

const config = { baseUrl: "https://example.test", currency: "eur" };

function tools(adapter) {
  return createDispatcher((server) => {
    registerBillingTools(server, {
      adapter,
      config,
      plans: PLANS,
      installLogging: false,
      resolvePlan: async () => (await adapter.getSubscription("org_1"))?.plan ?? null,
    });
  });
}

const onStarter = (members = ["u1", "u2"]) =>
  fakeAdapter({ members, subscription: { plan: "starter", status: "active", seatCounts: { standard: 5 } } });

// The org is pre-resolved, so no API key round trip — and no principal, which is an org key
// acting as the org itself: owner-level, which is what `enforceAdmin` lets through.
const call = (adapter, tool, args = {}) =>
  runWithResolvedOrg("Bearer sk_test", "org_1", () => tools(adapter).dispatchTool(tool, args));

test("a seat another plan sells is not a seat THIS workspace has", async () => {
  const adapter = onStarter();
  await assert.rejects(
    () => call(adapter, "assign_seat_type", { member_id: "u1", seat_type: "premium" }),
    /plan \(starter\) does not sell a "premium" seat.*It sells: standard/s,
  );
});

test("and the seat it does sell still goes through", async () => {
  const adapter = onStarter();
  assert.deepEqual(await call(adapter, "assign_seat_type", { member_id: "u1", seat_type: "standard" }), {
    status: "ok",
    member_id: "u1",
    seat_type: "standard",
  });
});

test("list_seats advertises the plan's rungs, its default, and the room left", async () => {
  const adapter = fakeAdapter({
    members: ["u1", "u2", "u3"],
    subscription: { plan: "scale", status: "active", seatCounts: { standard: 3, premium: 1 } },
  });
  await assignSeatType(adapter, "org_1", "u1", "premium");

  const out = await call(adapter, "list_seats");

  assert.deepEqual(out.seat_types, ["standard", "premium"]);
  assert.deepEqual(out.ladder, ["standard", "premium"]);
  assert.equal(out.default_seat, "standard");

  // What u1 holds, and that there is nothing above it.
  assert.deepEqual(out.members, [{ member_id: "u1", seat_type: "premium", is_top: true }]);

  // The one purchased Premium is taken; the two unassigned members occupy Standard.
  const byType = Object.fromEntries(out.capacity.map((c) => [c.seatType, c]));
  assert.equal(byType.premium.remaining, 0);
  assert.equal(byType.standard.assigned, 2);
  assert.equal(byType.standard.remaining, 1);
});
