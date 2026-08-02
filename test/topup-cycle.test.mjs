// The defect this suite exists for: an approved top-up granted nothing.
//
// `request_top_up` filed the grant under a calendar month ("2026-08") while the
// meter read it back under the subscription period ("2026-08-14"). The keys
// never matched for any org with a subscription — i.e. for every paying
// customer, the only ones who can hit a seat cap. Nothing errored: the approval
// succeeded and the member stayed blocked.

import assert from "node:assert/strict";
import { test } from "vitest";

import { currentCycle, legacyCycleKey } from "../dist/allowance.js";
import { approveTopUp, extraAllowance, requestTopUp } from "../dist/topup.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedTokens: 1000 } },
    },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
};

// A subscription that started mid-month — the ordinary case, and the one the
// calendar-month key could never represent.
const MID_MONTH = {
  plan: "pro",
  status: "active",
  periodStart: "2026-08-14T09:00:00.000Z",
  periodEnd: "2026-09-14T09:00:00.000Z",
};
const NOW = Date.parse("2026-08-20T12:00:00.000Z");

test("the cycle key comes from the subscription period, not the calendar", async () => {
  const adapter = fakeAdapter({ subscription: MID_MONTH });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", now: NOW });

  assert.equal(cycle.key, "2026-08-14");
  // The exact disagreement that lost the grant.
  assert.notEqual(cycle.key, legacyCycleKey(NOW));
  assert.equal(legacyCycleKey(NOW), "2026-08");
});

test("a grant approved this cycle is readable by the meter", async () => {
  const adapter = fakeAdapter({ subscription: MID_MONTH });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", now: NOW });

  await requestTopUp(adapter, "org_1", {
    id: "req_1",
    memberId: "user_1",
    amount: 250,
    cycle: cycle.key,
    createdAt: new Date(NOW).toISOString(),
  });
  const approved = await approveTopUp(adapter, "org_1", "req_1");
  assert.equal(approved.ok, true);

  // Read back exactly as resolveAllowance does.
  const extra = await extraAllowance(adapter, "org_1", "user_1", cycle.key, legacyCycleKey(NOW));
  assert.equal(extra, 250);
});

test("a grant filed under the OLD calendar key still applies", async () => {
  // Migration case: approved before writer and reader agreed. It must not
  // vanish, or fixing the bug would silently revoke live grants.
  const adapter = fakeAdapter({
    subscription: MID_MONTH,
    metadata: { topUpGrants: JSON.stringify({ user_1: { "2026-08": 400 } }) },
  });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", now: NOW });

  assert.equal(await extraAllowance(adapter, "org_1", "user_1", cycle.key, legacyCycleKey(NOW)), 400);
});

test("a grant present under both keys is not counted twice", async () => {
  const adapter = fakeAdapter({
    subscription: MID_MONTH,
    metadata: {
      topUpGrants: JSON.stringify({ user_1: { "2026-08": 400, "2026-08-14": 250 } }),
    },
  });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", now: NOW });

  assert.equal(await extraAllowance(adapter, "org_1", "user_1", cycle.key, legacyCycleKey(NOW)), 250);
});

test("an explicit zero grant is honoured, not treated as absent", async () => {
  // `?? 0` on a lookup would fall through to the legacy key here and resurrect
  // an old grant the current cycle deliberately set to zero.
  const adapter = fakeAdapter({
    subscription: MID_MONTH,
    metadata: { topUpGrants: JSON.stringify({ user_1: { "2026-08": 400, "2026-08-14": 0 } }) },
  });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", now: NOW });

  assert.equal(await extraAllowance(adapter, "org_1", "user_1", cycle.key, legacyCycleKey(NOW)), 0);
});

test("with no subscription the cycle falls back to the calendar month", async () => {
  // A free plan has no subscription, and this is the branch it always takes.
  const adapter = fakeAdapter({ subscription: null });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "hobby", now: NOW });

  assert.equal(cycle.key, "2026-08");
  assert.equal(cycle.key, legacyCycleKey(NOW));
});
