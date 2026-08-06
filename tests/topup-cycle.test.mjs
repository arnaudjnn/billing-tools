// The defect this suite exists for: an approved top-up granted nothing.
//
// `request_top_up` filed the grant under a calendar month ("2026-08") while the
// meter read it back under the subscription period ("2026-08-14"). The keys
// never matched for any org with a subscription — i.e. for every paying
// customer, the only ones who can hit a seat cap. Nothing errored: the approval
// succeeded and the member stayed blocked.

import assert from "node:assert/strict";
import { test } from "vitest";

import { currentCycle } from "../dist/allowance.js";
import { approveTopUp, extraAllowance, grantTopUp, listTopUpRequests, requestTopUp } from "../dist/topup.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000 } },
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
  // The exact disagreement that lost the grant: the calendar month this used
  // to be keyed by is a different string for the same instant.
  assert.notEqual(cycle.key, "2026-08");
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
  const extra = await extraAllowance(adapter, "org_1", "user_1", cycle.key);
  assert.equal(extra, 250);
});

test("a grant filed under a cycle the meter is not in is not readable", async () => {
  // The calendar key this library once used. Nothing reads it any more: a grant
  // is only ever visible under the cycle `currentCycle` produces.
  const adapter = fakeAdapter({
    subscription: MID_MONTH,
    metadata: { topUpGrants: JSON.stringify({ user_1: { "2026-08": 400 } }) },
  });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro", now: NOW });

  assert.equal(await extraAllowance(adapter, "org_1", "user_1", cycle.key), 0);
});

test("with no subscription the cycle falls back to the calendar month", async () => {
  // A free plan has no subscription, and this is the branch it always takes.
  const adapter = fakeAdapter({ subscription: null });
  const cycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "hobby", now: NOW });

  assert.equal(cycle.key, "2026-08");
});

test("two identical grants are two records, each with its own id", async () => {
  // The default id was `grant_<member>_<cycle>_<amount>` — deterministic, so granting the
  // same member the same amount twice in a cycle (what "+25% again" produces) wrote two
  // records sharing one id. It bought no idempotency either: the dedupe only fires when the
  // CALLER passes `id`, so the grant applied twice and left two records nothing could tell
  // apart. `approveTopUp`/`denyTopUp` resolve by id and would act on the first match, and a
  // UI listing them had duplicate React keys — which is how this was found.
  const adapter = fakeAdapter({ members: ["u1"] });
  await grantTopUp(adapter, "org_1", { memberId: "u1", amount: 250, cycle: "2026-08" });
  await grantTopUp(adapter, "org_1", { memberId: "u1", amount: 250, cycle: "2026-08" });

  const list = await listTopUpRequests(adapter, "org_1");
  assert.equal(list.length, 2, "both grants are recorded");
  assert.notEqual(list[0].id, list[1].id, "and are individually addressable");
  assert.equal(await extraAllowance(adapter, "org_1", "u1", "2026-08"), 500, "both applied");
});

test("but a caller-supplied id still dedupes — that is what it is for", async () => {
  const adapter = fakeAdapter({ members: ["u1"] });
  await grantTopUp(adapter, "org_1", { memberId: "u1", amount: 250, cycle: "2026-08", id: "click-1" });
  const second = await grantTopUp(adapter, "org_1", { memberId: "u1", amount: 250, cycle: "2026-08", id: "click-1" });

  assert.equal(second.reason, "duplicate");
  assert.equal((await listTopUpRequests(adapter, "org_1")).length, 1);
  assert.equal(await extraAllowance(adapter, "org_1", "u1", "2026-08"), 250, "granted once");
});
