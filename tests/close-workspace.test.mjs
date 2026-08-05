// Closing a workspace, and the order that makes it safe.
//
// The old way was one call — delete the WorkOS org — and it left the Stripe subscription
// billing a card every month for a workspace that no longer existed. Worse, the org holds
// `stripeCustomerId`, so the deletion destroyed the only mapping from that charge back to
// anything: unattributable, indefinite, silent.
//
// So these tests are almost all about ORDER and about what is deliberately NOT deleted.

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { closeWorkspace, findOrphanedSubscriptions } from "../dist/close-workspace.js";

function fakeStripe({ subs = [{ id: "sub_1", status: "active" }], cancelThrows = false } = {}) {
  const calls = { cancelled: [], updated: [], customerUpdates: [], released: [] };
  return {
    calls,
    subscriptions: {
      async *list() {
        for (const s of subs) yield { schedule: null, items: { data: [] }, ...s };
      },
      async cancel(id) {
        if (cancelThrows) throw new Error("card processor unavailable");
        calls.cancelled.push(id);
        return { id, status: "canceled", canceled_at: 1_700_000_000 };
      },
      async update(id, params) {
        calls.updated.push({ id, params });
        return { id, status: "active", items: { data: [{ current_period_end: 1_800_000_000 }] } };
      },
    },
    subscriptionSchedules: {
      async release(id) {
        calls.released.push(id);
        return { id };
      },
    },
    invoices: {
      async list() {
        return { data: [{ id: "in_1" }, { id: "in_2" }] };
      },
    },
    customers: {
      async update(id, params) {
        calls.customerUpdates.push({ id, params });
        return { id };
      },
      // Present so a mistaken `customers.del` would be visible rather than a TypeError.
      async del(id) {
        calls.deleted = id;
        return { id, deleted: true };
      },
    },
  };
}

const baseAdapter = (over = {}) => ({
  async getBillingCustomerId() {
    return "cus_1";
  },
  async getOrgDomains() {
    return [];
  },
  async validateApiKey() {
    return { orgId: "org_1" };
  },
  ...over,
});

test("it stops the billing, keeps the invoices, and deletes the org last", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const order = [];
  const adapter = baseAdapter({
    async deleteOrg() {
      order.push("deleteOrg");
    },
  });
  const res = await closeWorkspace(adapter, "org_1");

  assert.deepEqual(res.cancelled, ["sub_1"]);
  assert.equal(res.orgDeleted, true);
  assert.equal(res.invoicesKept, 2);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(order, ["deleteOrg"]);
});

test("the Stripe customer is NEVER deleted — its invoices are the legal record", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  await closeWorkspace(baseAdapter({ async deleteOrg() {} }), "org_1");

  assert.equal(stripe.calls.deleted, undefined, "deleting the customer would delete its invoices");
});

test("and it is annotated, so a kept record explains itself", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  await closeWorkspace(baseAdapter({ async deleteOrg() {} }), "org_1", { reason: "customer left" });

  const { params } = stripe.calls.customerUpdates[0];
  assert.equal(params.metadata.bt_closed_org, "org_1");
  assert.equal(params.metadata.bt_closed_reason, "customer left");
  assert.ok(params.metadata.bt_closed_at, "a date, so an audit can tell closed from lost");
});

test("a subscription that cannot be cancelled leaves the org IN PLACE", async () => {
  // The invariant the whole function exists for: deleting the org is what makes the recurring
  // charge unattributable, so it must not happen while the charge is still running.
  const stripe = fakeStripe({ cancelThrows: true });
  __setStripeForTests(stripe);
  let deleted = false;
  const res = await closeWorkspace(
    baseAdapter({
      async deleteOrg() {
        deleted = true;
      },
    }),
    "org_1",
  );

  assert.equal(deleted, false, "never delete an org whose billing is still live");
  assert.equal(res.orgDeleted, false);
  assert.ok(res.warnings.some((w) => w.includes("could not stop subscription")));
  assert.ok(res.warnings.some((w) => w.includes("org NOT deleted")));
});

test("period_end + deleteOrg is refused before anything happens", async () => {
  // That combination IS the orphan — a live subscription whose org is gone. Refused up front,
  // because the half of a half-done deletion is a deletion.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const res = await closeWorkspace(baseAdapter({ async deleteOrg() {} }), "org_1", {
    cancelAt: "period_end",
    deleteOrg: true,
  });

  assert.deepEqual(res.cancelled, []);
  assert.equal(res.orgDeleted, false);
  assert.deepEqual(stripe.calls.cancelled, [], "nothing was touched");
  assert.deepEqual(stripe.calls.updated, []);
  assert.ok(res.warnings[0].includes("would leave a live subscription"));
});

test("period_end WITHOUT deleting is allowed: the customer keeps what they paid for", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const res = await closeWorkspace(baseAdapter(), "org_1", { cancelAt: "period_end", deleteOrg: false });

  assert.deepEqual(res.cancelled, ["sub_1"]);
  assert.equal(stripe.calls.updated[0].params.cancel_at_period_end, true);
  assert.equal(res.endsAt.sub_1, new Date(1_800_000_000 * 1000).toISOString());
  assert.deepEqual(stripe.calls.cancelled, [], "not cancelled outright");
});

test("a schedule is released first, because it refuses cancellation otherwise", async () => {
  const stripe = fakeStripe({ subs: [{ id: "sub_1", status: "active", schedule: "sub_sched_1" }] });
  __setStripeForTests(stripe);
  await closeWorkspace(baseAdapter({ async deleteOrg() {} }), "org_1");

  assert.deepEqual(stripe.calls.released, ["sub_sched_1"]);
  assert.deepEqual(stripe.calls.cancelled, ["sub_1"]);
});

test("every live status is stopped, and a dead one is left alone", async () => {
  const stripe = fakeStripe({
    subs: [
      { id: "sub_active", status: "active" },
      { id: "sub_past_due", status: "past_due" },
      { id: "sub_trialing", status: "trialing" },
      { id: "sub_paused", status: "paused" },
      { id: "sub_unpaid", status: "unpaid" },
      { id: "sub_incomplete", status: "incomplete" },
      { id: "sub_canceled", status: "canceled" },
    ],
  });
  __setStripeForTests(stripe);
  const res = await closeWorkspace(baseAdapter({ async deleteOrg() {} }), "org_1");

  // `past_due` and `unpaid` matter most: those are the ones a customer is arguing about, and
  // leaving them live keeps the dunning emails coming after they have left.
  assert.deepEqual(res.cancelled, [
    "sub_active",
    "sub_past_due",
    "sub_trialing",
    "sub_paused",
    "sub_unpaid",
    "sub_incomplete",
  ]);
});

test("an org with no Stripe customer closes cleanly", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const res = await closeWorkspace(
    baseAdapter({ async getBillingCustomerId() { return null; }, async deleteOrg() {} }),
    "org_1",
  );

  assert.deepEqual(res.cancelled, []);
  assert.equal(res.orgDeleted, true, "nothing to stop, so nothing blocks the delete");
  assert.deepEqual(res.warnings, []);
});

test("an adapter with no deleteOrg says so rather than pretending", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const res = await closeWorkspace(baseAdapter(), "org_1");

  assert.equal(res.orgDeleted, false);
  assert.ok(res.warnings.some((w) => w.includes("no deleteOrg")));
  assert.deepEqual(res.cancelled, ["sub_1"], "the billing still stopped, which is the urgent half");
});

test("each member's entry for this workspace is cleared, and their others are not", async () => {
  // Both per-member stores are keyed by org, so a closed workspace's entries would otherwise
  // sit in every ex-member's record for ever — spending a 600-char budget their REMAINING
  // workspaces still need.
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const written = {};
  const adapter = baseAdapter({
    async deleteOrg() {},
    async listMemberIds() {
      return ["user_1", "user_2"];
    },
    async getUserMetadata(userId) {
      return userId === "user_1"
        ? {
            btSeatType: JSON.stringify({ org_1: "premium", org_other: "standard" }),
            btTopUpGrants: JSON.stringify({ org_1: { "2026-08": 500 } }),
          }
        : { btSeatType: JSON.stringify({ org_other: "standard" }) };
    },
    async setUserMetadata(userId, patch) {
      written[userId] = patch;
    },
  });
  const res = await closeWorkspace(adapter, "org_1");

  assert.equal(res.membersCleared, 1, "only the member who had entries here");
  assert.deepEqual(JSON.parse(written.user_1.btSeatType), { org_other: "standard" });
  // Emptied entirely → the KEY goes, not `"{}"`: the budget is returned rather than reduced.
  assert.equal(written.user_1.btTopUpGrants, null);
  assert.equal(written.user_2, undefined, "untouched — nothing of theirs was here");
});

test("clearMembers: false leaves the member records alone", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  let touched = false;
  const adapter = baseAdapter({
    async deleteOrg() {},
    async listMemberIds() {
      return ["user_1"];
    },
    async getUserMetadata() {
      return { btSeatType: JSON.stringify({ org_1: "premium" }) };
    },
    async setUserMetadata() {
      touched = true;
    },
  });
  await closeWorkspace(adapter, "org_1", { clearMembers: false });

  assert.equal(touched, false);
});

// ── detection for the ones already lost ──────────────────────────────────────

test("findOrphanedSubscriptions names live subscriptions whose org is gone", async () => {
  const stripe = {
    subscriptions: {
      async *list() {
        yield {
          id: "sub_orphan",
          customer: "cus_9",
          metadata: { org_id: "org_deleted" },
          items: { data: [{ price: { unit_amount: 1800 }, quantity: 2 }] },
        };
        yield {
          id: "sub_fine",
          customer: "cus_1",
          metadata: { org_id: "org_1" },
          items: { data: [{ price: { unit_amount: 1800 }, quantity: 1 }] },
        };
      },
    },
  };
  __setStripeForTests(stripe);
  const adapter = baseAdapter({
    async getOrgDomains(orgId) {
      if (orgId === "org_deleted") throw new Error("Organization not found");
      return [];
    },
  });

  const orphans = await findOrphanedSubscriptions(adapter);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].subscriptionId, "sub_orphan");
  // What is being charged, because that is the number that makes the report actionable.
  assert.equal(orphans[0].amount, 3600);
});

test("a subscription with no org_id is not called an orphan", async () => {
  // One created outside this library never had an org id, and reporting it would cry wolf.
  const stripe = {
    subscriptions: {
      async *list() {
        yield { id: "sub_foreign", customer: "cus_2", metadata: {}, items: { data: [] } };
      },
    },
  };
  __setStripeForTests(stripe);
  assert.deepEqual(await findOrphanedSubscriptions(baseAdapter()), []);
});

test("the scan is bounded by what it EXAMINED, not by what it found", async () => {
  let yielded = 0;
  const stripe = {
    subscriptions: {
      async *list() {
        while (yielded < 500) {
          yielded++;
          yield { id: `sub_${yielded}`, customer: "cus", metadata: { org_id: "org_1" }, items: { data: [] } };
        }
      },
    },
  };
  __setStripeForTests(stripe);
  await findOrphanedSubscriptions(baseAdapter(), { examine: 25 });

  assert.ok(yielded <= 26, `stopped after ${yielded}, not 500`);
});
