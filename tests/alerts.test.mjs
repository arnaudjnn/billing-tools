// "You are nearly out" — and, much more importantly, said ONCE.
//
// An alert that fires on every call past 80% is not an alert, it is a mailing list. So the
// assertions worth having are about restraint: one email per threshold per cycle, the top
// threshold rather than every threshold below it, a new cycle starting the count again, and
// a store that stays inside the metadata budget when one person belongs to many workspaces.
//
// The other half is what is deliberately NOT alerted on: rate limits, which reset within
// days and which the customer cannot do anything about.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { claimCrossings, crossings, DEFAULT_ALERT_THRESHOLDS } from "../dist/alerts.js";
import { fakeAdapter, WORKOS_MAX_VALUE } from "./helpers.mjs";

const state = (over = {}) => ({ pack: null, pool: null, limits: [], ...over });

// ── What counts as news ──────────────────────────────────────────────────────

test("the HIGHEST threshold reached, not every one below it", () => {
  // 80 and 100 in the same call is one piece of news — "you are out" — and telling somebody
  // twice about the same moment is how people learn to filter the sender.
  const at = crossings(state({ pack: { size: 1000, used: 1000 } }));
  assert.equal(at.length, 1);
  assert.equal(at[0].threshold, 100);
  assert.equal(at[0].key, "pack");
  assert.equal(at[0].scope, "member", "a seat pack is one person's wall");
});

test("below the lowest threshold is not news", () => {
  assert.deepEqual(crossings(state({ pack: { size: 1000, used: 700 } })), []);
  assert.equal(crossings(state({ pack: { size: 1000, used: 800 } })).length, 1);
  // The percentage is ROUNDED, the same way `usage.ts` rounds the one a screen shows —
  // 79.9% reads as 80 there, and an alert that disagreed with the number in front of the
  // customer would be the confusing one.
  assert.equal(crossings(state({ pack: { size: 1000, used: 799 } })).length, 1);
});

test("a pooled workspace's wall belongs to the workspace, not to whoever hit it", () => {
  const at = crossings(state({ pool: { size: 4000, used: 3600 } }));
  assert.equal(at[0].key, "pool");
  assert.equal(at[0].scope, "org", "the admins can act on it; the member who tripped it cannot");
  assert.equal(at[0].percent, 90);
  assert.equal(at[0].threshold, 80);
});

test("the deployment picks the levels", () => {
  assert.deepEqual([...DEFAULT_ALERT_THRESHOLDS], [80, 100]);
  const at = crossings(state({ pack: { size: 100, used: 50 } }), [25, 50, 75]);
  assert.equal(at[0].threshold, 50);
});

test("a rate limit is never alerted on", () => {
  // It resets on Monday and the customer cannot raise it. An email about it asks somebody
  // to act on a decision that is not theirs and will have expired by the time they read it.
  const at = crossings(
    state({
      limits: [{ every: "week", scope: "org", label: "settimana", size: 1000, used: 990, remaining: 10, window: {} }],
    }),
  );
  assert.deepEqual(at, []);
});

test("the SPEND alert is the customer's own figure, in credits", () => {
  // They typed "warn me at 10 000". A percentage of their ceiling would be a number they
  // never chose, and the ceiling is theirs to move.
  const at = crossings(
    state({
      limits: [
        {
          every: "month",
          scope: "org",
          kind: "spend",
          label: null,
          size: 20_000,
          used: 12_000,
          remaining: 8_000,
          window: {},
          alertsAt: [10_000, 18_000],
        },
      ],
    }),
  );
  assert.equal(at[0].key, "spend");
  assert.equal(at[0].unit, "credits");
  assert.equal(at[0].threshold, 10_000, "the highest one actually reached");
  assert.equal(at[0].scope, "org");
});

test("a spend ceiling with no alert figures says nothing", () => {
  // The ceiling still refuses at 100%; being told about it is a separate thing the customer
  // opts into. This is the setting a billing page has been collecting and nothing read.
  const at = crossings(
    state({
      limits: [
        { every: "month", scope: "org", kind: "spend", label: null, size: 20_000, used: 19_999, remaining: 1, window: {} },
      ],
    }),
  );
  assert.deepEqual(at, []);
});

// ── Saying it once ───────────────────────────────────────────────────────────

const CROSS_80 = {
  key: "pack",
  scope: "member",
  threshold: 80,
  unit: "percent",
  every: "cycle",
  label: null,
  used: 800,
  limit: 1000,
  percent: 80,
};
const CROSS_100 = { ...CROSS_80, threshold: 100, used: 1000, percent: 100 };
const POOL_80 = { ...CROSS_80, key: "pool", scope: "org" };

test("the same threshold, twice in a cycle, is claimed once", async () => {
  const a = fakeAdapter({ members: ["u_1"] });
  const first = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_80] });
  const second = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_80] });

  assert.equal(first.length, 1);
  assert.deepEqual(second, [], "every call past 80% would otherwise be an email");
});

test("but 100 after 80 IS news, and 80 after 100 is not", async () => {
  const a = fakeAdapter({ members: ["u_1"] });
  await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_80] });
  const worse = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_100] });
  assert.equal(worse[0].threshold, 100, "running out is a different fact from nearly running out");

  // A refund, a grant, anything that drops them back to 85% must not re-announce 80.
  const back = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_80] });
  assert.deepEqual(back, []);
});

test("a new cycle starts the count again", async () => {
  const a = fakeAdapter({ members: ["u_1"] });
  await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_100] });
  const next = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-09", crossings: [CROSS_80] });
  assert.equal(next.length, 1, "the allowance reset, so the warning applies again");
});

test("an org-scoped crossing is remembered on the ORG, not on whoever tripped it", async () => {
  const a = fakeAdapter({ members: ["u_1", "u_2"] });
  const first = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [POOL_80] });
  // A different member's call finds the same pool at the same level. The workspace has
  // already been told; telling every admin once per member would be N emails for one fact.
  const second = await claimCrossings(a, { orgId: "org_1", memberId: "u_2", cycleKey: "2026-08", crossings: [POOL_80] });

  assert.equal(first.length, 1);
  assert.deepEqual(second, []);
});

test("a member of many workspaces cannot overflow the value all of them write to", async () => {
  const a = fakeAdapter({ members: ["u_1"] });
  for (const org of ["org_1", "org_2", "org_3", "org_4", "org_5"]) {
    await claimCrossings(a, { orgId: org, memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_100] });
  }
  const raw = a.userStore["u_1"].btAlerts;
  assert.ok(raw.length < WORKOS_MAX_VALUE, `the record is ${raw.length} chars`);
  const kept = Object.keys(JSON.parse(raw));
  assert.equal(kept.length, 3, "oldest workspaces shed first, as the grants store does");
  assert.deepEqual(kept, ["org_3", "org_4", "org_5"]);
});

test("an adapter with no per-member store says nothing rather than saying it every call", async () => {
  // Repeating an alert on every metered call is worse than not sending it.
  const a = fakeAdapter({ members: ["u_1"], userMetadata: false });
  const out = await claimCrossings(a, { orgId: "org_1", memberId: "u_1", cycleKey: "2026-08", crossings: [CROSS_80] });
  assert.deepEqual(out, []);
});
