// The WORKSPACE reading: every member against whatever caps them, and who is at the wall.
//
// `memberUsage` answers per member and stops, so every consumer wrote the same three lines
// after it — which limit applies, are they over it, what does the team look like together.
// That arithmetic decides what an owner is told about money, and it lived in a page, where
// no API, CLI or MCP caller could reach it.
//
// The average is the part worth asserting. A summed 96% is the workspace's totals expressed
// as a fraction NOBODY can spend: two members, one blocked at 100% and one who has not
// started, read as "almost out" while half the team is idle and the other half is stuck.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { orgUsage } from "../dist/usage.js";
import { assignSeatType } from "../dist/seats.js";
import { fakeAdapter, stripeList } from "./helpers.mjs";

const PLANS = {
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

const config = { currency: "eur", baseUrl: "https://test.local", internalDomains: [] };

/** A wallet with room, so only the packs can refuse. */
function stripe() {
  return {
    customers: {
      async retrieve() {
        return { deleted: false, balance: -1_000_000, currency: "eur", metadata: {} };
      },
      list() {
        return stripeList([]);
      },
    },
    subscriptions: { list: () => stripeList([]) },
  };
}

/** Per-caller totals, so each member can be given their own spend. */
function ledgerFor(byMember) {
  return {
    async record() {},
    async total(q) {
      const id = q.filter?.callerId;
      return id ? (byMember[id] ?? 0) : Object.values(byMember).reduce((a, b) => a + b, 0);
    },
  };
}

const adapter = () =>
  fakeAdapter({
    members: ["u_full", "u_idle"],
    subscription: { plan: "pro", status: "active", seatCounts: { standard: 1, premium: 1 } },
  });

test("each member is measured against their OWN pack, and the average is of those", async () => {
  __setStripeForTests(stripe());
  const a = adapter();
  await assignSeatType(a, "org_1", "u_full", "premium"); // 5 000
  // u_idle stays on the default Standard seat — 1 000, and drawn without an assignment.

  const out = await orgUsage(a, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pro",
    members: [{ id: "u_full" }, { id: "u_idle" }],
    ledger: ledgerFor({ u_full: 5_000, u_idle: 0 }),
  });

  const full = out.members.find((m) => m.id === "u_full");
  const idle = out.members.find((m) => m.id === "u_idle");
  assert.equal(full.limit, 5_000);
  assert.equal(full.percent, 100);
  assert.equal(full.overage, true, "at the cap IS the wall — refused until it resets");
  assert.equal(idle.limit, 1_000);
  assert.equal(idle.percent, 0);
  assert.equal(idle.overage, false);

  // The mean of 100 and 0. The SUM would be 5 000/6 000 = 83%, which describes an
  // allowance no single person can reach and hides that one of them is stuck.
  assert.equal(out.aggregate.percent, 50);
  assert.equal(out.aggregate.used, 5_000);
  assert.equal(out.aggregate.limit, 6_000);
  assert.equal(out.aggregate.seats, 2);
  assert.equal(out.aggregate.overage, 1, "who is at the wall, counted");
});

test("overage never pulls the average past what anyone can spend", async () => {
  __setStripeForTests(stripe());
  const a = adapter();
  await assignSeatType(a, "org_1", "u_full", "premium");

  const out = await orgUsage(a, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pro",
    members: [{ id: "u_full" }, { id: "u_idle" }],
    // 20% past the pack, funded by the wallet.
    ledger: ledgerFor({ u_full: 6_000, u_idle: 0 }),
  });

  assert.equal(out.members.find((m) => m.id === "u_full").percent, 100, "capped at 100");
  assert.equal(out.aggregate.percent, 50, "not 60 — 120% is not a share of an allowance");
});
