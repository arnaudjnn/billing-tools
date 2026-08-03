// Does `resolveAllowance` still issue its per-caller reads in ONE tick?
//
// This guards a property that is invisible in the source and that nothing else
// would catch. `stripeScopeUsageLedger` batches whatever arrives in a microtask, so
// a plan's monthly pack and its weekly caller limit collapse into one bucketed
// meter read and one balance walk. Put an `await` between those two reads and they
// land in two ticks, two flushes, and twice the Stripe requests — with every number
// still correct, every test still green, and the rate-limit headroom quietly halved.
//
// That is not hypothetical: it happened here. Sharing one `customers.retrieve`
// between the wallet balance and the spend ceiling was added as an `await` in front
// of the pack read, and it undid the batching completely. The load test caught it;
// nothing else did.
//
// So this asserts the REQUEST COUNT, not the answer — the answers are pinned
// elsewhere and were never wrong.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { resolveAllowance } from "../dist/allowance.js";
import { stripeUsageLedger, invalidateMeters } from "../dist/usage-ledger.js";
import { stripeScopeUsageLedger, invalidateUsageScopes } from "../dist/usage-scopes.js";

/** Counts what the ledger asks Stripe for. */
function fakeStripe() {
  const calls = { summaries: [], bucketed: 0, plain: 0, balanceWalks: 0, retrieves: 0 };
  __setStripeForTests({
    customers: {
      async retrieve() {
        calls.retrieves++;
        return { id: "cus_org", balance: 0, currency: "eur", metadata: {} };
      },
      async search() { return { data: [{ id: "cus_scope" }] }; },
      async create() { return { id: "cus_scope" }; },
      listBalanceTransactions() {
        calls.balanceWalks++;
        return { [Symbol.asyncIterator]: async function* () { /* no debits */ } };
      },
    },
    billing: {
      meters: {
        list() {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { id: "mtr_org", event_name: "billing_tools_usage" };
              yield { id: "mtr_scope", event_name: "billing_tools_scope_usage" };
            },
          };
        },
        listEventSummaries(meter, params) {
          calls.summaries.push({ meter, bucketed: params.value_grouping_window === "day" });
          if (params.value_grouping_window === "day") {
            calls.bucketed++;
            return { [Symbol.asyncIterator]: async function* () {}, data: [] };
          }
          calls.plain++;
          return Promise.resolve({ data: [] });
        },
      },
    },
    v2: { billing: { meterEventSession: { async create() { return { authentication_token: "t", expires_at: new Date(Date.now() + 1e6).toISOString() }; } }, meterEventStream: { async create() {} } } },
  });
  return calls;
}

// A monthly seat pack plus a weekly caller-scoped limit: two per-caller windows
// over one member, both UTC day-aligned, which is the shape that must batch.
const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000, min: 1 } },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat", window: "month", covers: "users", onExhausted: "wallet" },
    replenish: { purchase: {} },
    limits: { members: 100, rate: [{ every: "week", credits: 500, scope: "caller", callerKind: "user" }] },
    sale: "self_serve",
  },
};

const adapter = {
  async getBillingCustomerId() { return "cus_org"; },
  async getOrgMetadata() { return {}; },
  async setOrgMetadata() {},
  async getSubscription() {
    return { plan: "pro", status: "active", subscriptionId: null, seats: 5, periodStart: null, periodEnd: null };
  },
  async getUserMetadata() { return {}; },
  async setUserMetadata() {},
  async listMemberIds() { return ["usr_1"]; },
};
const config = { freeCredits: 0, currency: "eur", baseUrl: "http://x", internalDomains: [], defaultLocale: "en" };

const run = (calls) =>
  resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: PLANS,
    plan: "pro",
    caller: { kind: "user", id: "usr_1", seatType: "standard" },
    customerId: "cus_org",
    ledger: stripeUsageLedger({ perCaller: stripeScopeUsageLedger() }),
  });

beforeEach(() => {
  invalidateMeters();
  invalidateUsageScopes();
});

test("a member's two per-caller windows cost ONE bucketed meter read", async () => {
  const calls = fakeStripe();
  await run(calls);
  // The pack (month) and the weekly limit are both day-aligned over the same
  // scope. Two reads here means an `await` crept in between them.
  assert.equal(
    calls.bucketed,
    1,
    `expected one bucketed read; got ${calls.bucketed} bucketed + ${calls.plain} plain — ` +
      "an await between the per-caller reads splits the tick and undoes the batching",
  );
});

test("and ONE balance-transaction walk, not one per window", async () => {
  const calls = fakeStripe();
  await run(calls);
  // The walk is the unbounded read: it pages the whole window, so doing it twice
  // is the most expensive way to lose the batching.
  assert.equal(calls.balanceWalks, 1, `expected one walk, got ${calls.balanceWalks}`);
});

test("and ONE customer retrieve for the wallet balance and the spend ceiling", async () => {
  const calls = fakeStripe();
  await run(calls);
  // These both read the same object. Two retrieves was the largest single
  // consumer of the request budget under load.
  assert.equal(calls.retrieves, 1, `expected one retrieve, got ${calls.retrieves}`);
});

test("the whole metered call stays within its measured request budget", async () => {
  const calls = fakeStripe();
  await run(calls);
  const total = calls.summaries.length + calls.balanceWalks + calls.retrieves;
  // Measured against a real account at 3.95 requests per metered call for this
  // shape. A ceiling rather than an equality, so an unrelated saving does not
  // fail the build — but a regression does.
  assert.ok(total <= 4, `a metered call now costs ${total} Stripe reads (budget 4)`);
});
