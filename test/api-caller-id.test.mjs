// Which KEY made the call.
//
// `MeterCaller.id` is documented as "API key id (api) — for per-caller
// attribution", and for every consumer it was the ORG id. `validateApiKey`
// returned only `{ orgId }`, so `createApiMeterGuard` had nothing else to pass:
// every metered API call recorded a caller_id that claimed to name a key and named
// a workspace, and the counter written under it looked like a member whose id
// happened to be a workspace id.
//
// Nothing was mis-charged — an `api` caller's windows are summed by KIND across the
// org, deliberately, so no gate ever read the value. What was lost is the question
// "which key burned the quota", which no consumer could answer.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { createApiMeterGuard } from "../dist/metering.js";
import { scopesFor } from "../dist/usage-counters.js";

/** Captures what the guard hands the meter. */
function spyMeter() {
  const calls = [];
  return {
    calls,
    meter: async (orgId, action, opts) => {
      calls.push({ orgId, action, opts });
      return { ok: true };
    },
  };
}

const request = () => new Request("https://x.test/api/v0/search", { headers: { authorization: "Bearer sk_live_x" } });

test("the guard passes the KEY id, not the org id", async () => {
  const { calls, meter } = spyMeter();
  const adapter = { async validateApiKey() { return { orgId: "ws_1", keyId: "key_abc" }; } };
  const guard = createApiMeterGuard(adapter, meter);

  assert.equal(await guard(request(), "search"), null, "allowed");
  assert.deepEqual(calls[0].opts.caller, { kind: "api", id: "key_abc" });
  // The bug, stated as an assertion: the org id must not appear as a caller.
  assert.notEqual(calls[0].opts.caller.id, "ws_1");
});

test("an adapter that cannot name the key records NO caller id", async () => {
  // Honest beats plausible. A wrong id is worse than a missing one: it is
  // indistinguishable from a real member id downstream.
  const { calls, meter } = spyMeter();
  const adapter = { async validateApiKey() { return { orgId: "ws_1" }; } };
  const guard = createApiMeterGuard(adapter, meter);

  await guard(request(), "search");
  assert.deepEqual(calls[0].opts.caller, { kind: "api" });
  assert.equal("id" in calls[0].opts.caller, false);
});

test("so no counter claims to be a member the workspace does not have", () => {
  // What the two cases write. Before, the api arm produced `u:ws_…` — the member
  // namespace, holding a workspace id.
  const base = { orgId: "ws_1", customerId: "cus_1", action: "search", cost: 1, funded: "wallet" };

  assert.deepEqual(scopesFor({ ...base, caller: { kind: "api", id: "key_abc" } }), [
    "org",
    "k:api",
    "u:key_abc",
  ]);
  assert.deepEqual(scopesFor({ ...base, caller: { kind: "api" } }), ["org", "k:api"]);
  // A member is unchanged, and is what the `u:` namespace is for.
  assert.deepEqual(scopesFor({ ...base, caller: { kind: "user", id: "user_1" } }), [
    "org",
    "k:user",
    "u:user_1",
  ]);
});

test("an invalid key is still refused before anything is metered", async () => {
  const { calls, meter } = spyMeter();
  const adapter = { async validateApiKey() { return null; } };
  const guard = createApiMeterGuard(adapter, meter);

  const res = await guard(request(), "search");
  assert.equal(res?.status, 401);
  assert.equal(calls.length, 0, "nothing metered for a key that does not resolve");
});

test("memberUsage narrows an api member to its own key", async () => {
  // Summed by kind, a list of five keys returned the org total five times — a table
  // that looks per-key and is not. The GATE still sums by kind (one shared agent
  // window); this is the read an admin screen makes.
  const { memberUsage } = await import("../dist/usage.js");
  const { __setStripeForTests } = await import("../dist/billing.js");
  // The wallet and spend-ceiling reads inside usageSummary go to Stripe; neither is
  // what this asserts. The customer carries no metadata and no balance.
  __setStripeForTests({
    customers: {
      async retrieve() {
        return { id: "cus_1", metadata: {}, currency: "eur" };
      },
      listBalanceTransactions() {
        return { async *[Symbol.asyncIterator]() {} };
      },
    },
  });
  const seen = [];
  const ledger = {
    covers: { orgIncluded: true, callerIncluded: true },
    async record() {},
    async total(q) {
      seen.push(q.filter);
      return q.filter?.callerId === "key_a" ? 40 : q.filter?.callerId === "key_b" ? 2 : 100;
    },
  };
  const adapter = {
    async getBillingCustomerId() {
      return "cus_1";
    },
    async getOrgMetadata() {
      return {};
    },
  };
  const rows = await memberUsage(
    adapter,
    { freeCredits: 0, currency: "eur", baseUrl: "https://x", internalDomains: [] },
    {
      orgId: "ws_1",
      plans: {},
      plan: null,
      members: [
        { id: "key_a", kind: "api" },
        { id: "key_b", kind: "api" },
      ],
      ledger,
    },
  );

  assert.deepEqual(
    rows.map((r) => [r.id, r.usedInCycle]),
    [
      ["key_a", 40],
      ["key_b", 2],
    ],
    "each key reports its own usage",
  );
  // And the filter carried the key, which is what makes that possible.
  assert.ok(seen.some((f) => f?.callerKind === "api" && f?.callerId === "key_a"));
});
