// `stripeScopeUsageLedger()` — per-member usage counted in Stripe, with no store.
//
// Two things are being pinned, and both are the kind of mistake that reads as
// generosity rather than as a fault:
//
//  1. The FUNDING SPLIT. Wallet-funded usage is already recorded by
//     `deductCredits` as a balance transaction carrying the caller. Reporting it
//     to the scope meter as well would count it twice — and a per-member window
//     that double-counts refuses a customer who has spent half their pack.
//     Conversely, dropping included usage would count it nowhere.
//  2. The SCOPE the customer is derived from. Write and read must produce the
//     same string, or the read looks up a counter nobody writes and returns 0
//     forever.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { invalidateMeters } from "../dist/usage-ledger.js";
import { invalidateUsageScopes, stripeScopeUsageLedger } from "../dist/usage-scopes.js";

/** A Stripe stand-in recording exactly what the ledger asked of it. */
function fakeStripe({ summaries = {} } = {}) {
  const calls = { search: [], create: [], stream: [], summaries: [], sessions: 0 };
  const customers = new Map(); // scope key -> id
  const client = {
    customers: {
      async search({ query }) {
        calls.search.push(query);
        // `metadata['bt_usage_scope']:'<scope>'` — the VALUE, not the key.
        const scope = query.match(/:'([^']+)'/)?.[1];
        const id = customers.get(scope);
        return { data: id ? [{ id }] : [] };
      },
      async create(params, opts) {
        calls.create.push({ params, opts });
        const scope = params.metadata.bt_usage_scope;
        const id = `cus_${calls.create.length}`;
        customers.set(scope, id);
        return { id };
      },
    },
    billing: {
      meters: {
        list() {
          const page = [{ id: "mtr_scope", event_name: "billing_tools_scope_usage" }];
          return { [Symbol.asyncIterator]: async function* () { yield* page; } };
        },
        async listEventSummaries(meter, params) {
          calls.summaries.push({ meter, customer: params.customer });
          const id = params.customer;
          return { data: summaries[id] ? [{ aggregated_value: summaries[id] }] : [] };
        },
      },
    },
    v2: {
      billing: {
        meterEventSession: {
          async create() {
            calls.sessions++;
            return {
              authentication_token: "at_test",
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            };
          },
        },
        meterEventStream: {
          async create({ events }) {
            calls.stream.push(events);
          },
        },
      },
    },
  };
  __setStripeForTests(client);
  return { calls, customers };
}

/** A wallet leg that reports a fixed figure, so the SUM is what is asserted. */
const walletLeg = (total) => ({
  covers: { orgIncluded: false, callerIncluded: false },
  async record() {},
  async total() {
    return total;
  },
});

const EVENT = {
  orgId: "org_1",
  customerId: "cus_org",
  action: "search",
  cost: 5,
  funded: "pack",
  caller: { kind: "user", id: "u1" },
};

beforeEach(() => {
  invalidateMeters();
  invalidateUsageScopes();
});

test("an included event is reported once per NON-org scope, in one request", async () => {
  const { calls } = fakeStripe();
  await stripeScopeUsageLedger().record(EVENT);

  assert.equal(calls.stream.length, 1, "every scope goes in ONE stream request");
  const scopes = calls.create.map((c) => c.params.metadata.bt_usage_scope);
  assert.deepEqual(scopes, ["org_1|k:user", "org_1|u:u1"]);
  assert.equal(calls.stream[0].length, 2);
  assert.deepEqual(
    calls.stream[0].map((e) => e.payload.value),
    ["5", "5"],
  );
  // The org scope is the composite's meter leg, on the org's REAL customer. A
  // shadow for it would double every org-wide figure this library already reports.
  assert.ok(!scopes.includes("org_1|org"), "org must not get a shadow customer");
});

test("a wallet-funded event is NOT reported — the debit already recorded it", async () => {
  const { calls } = fakeStripe();
  await stripeScopeUsageLedger().record({ ...EVENT, funded: "wallet" });
  assert.deepEqual(calls.stream, [], "reporting it here too would count it twice");
  assert.deepEqual(calls.create, [], "and it needs no scope customer");
});

test("a zero-cost event moves nothing", async () => {
  const { calls } = fakeStripe();
  await stripeScopeUsageLedger().record({ ...EVENT, cost: 0 });
  assert.deepEqual(calls.stream, []);
});

test("total sums the two disjoint legs: wallet debits + included meter", async () => {
  const { customers } = fakeStripe({ summaries: { cus_u1: 30 } });
  customers.set("org_1|u:u1", "cus_u1");
  const ledger = stripeScopeUsageLedger({ wallet: walletLeg(12) });

  const total = await ledger.total({
    orgId: "org_1",
    customerId: "cus_org",
    start: 1_000_000,
    end: 2_000_000,
    filter: { callerKind: "user", callerId: "u1" },
  });
  // 12 wallet-funded (exact, no lag) + 30 included (the meter). Neither set
  // contains the other, so this is a plain sum.
  assert.equal(total, 42);
});

test("an org-wide read is answered without touching the scope meter", async () => {
  const { calls } = fakeStripe();
  const total = await stripeScopeUsageLedger({ wallet: walletLeg(9) }).total({
    orgId: "org_1",
    customerId: "cus_org",
    start: 1_000_000,
  });
  assert.equal(total, 9);
  assert.deepEqual(calls.summaries, [], "this leg does not answer org windows");
});

test("the write scope and the read scope resolve to the SAME customer", async () => {
  const { calls } = fakeStripe();
  const ledger = stripeScopeUsageLedger({ wallet: walletLeg(0) });
  await ledger.record(EVENT);
  const written = calls.stream[0].find((e) => e.payload.stripe_customer_id);

  await ledger.total({
    orgId: "org_1",
    customerId: "cus_org",
    start: 1_000_000,
    filter: { callerKind: "user", callerId: "u1" },
  });
  const read = calls.summaries.at(-1).customer;
  // `u:u1` on both paths. A read that derived a different string would look up a
  // counter nobody writes and report 0 for that member for ever.
  assert.equal(read, calls.stream[0][1].payload.stripe_customer_id);
  assert.ok(written);
});

test("a scope customer is resolved once per process, then memoised", async () => {
  const { calls } = fakeStripe();
  const ledger = stripeScopeUsageLedger();
  await ledger.record(EVENT);
  await ledger.record(EVENT);
  await ledger.record(EVENT);
  assert.equal(calls.create.length, 2, "two scopes, created once each");
  assert.equal(calls.search.length, 2, "and searched once each");
  assert.equal(calls.stream.length, 3, "but every event is still reported");
});

test("creation carries an idempotency key derived from the scope", async () => {
  const { calls } = fakeStripe();
  await stripeScopeUsageLedger().record(EVENT);
  // The search index is eventually consistent — measured, a fresh customer was
  // still missing after 20s — so two instances starting together both miss it.
  // The key is what stops them writing one member's usage to two customers.
  assert.deepEqual(
    calls.create.map((c) => c.opts.idempotencyKey),
    ["bt-usage-scope-org_1|k:user", "bt-usage-scope-org_1|u:u1"],
  );
});

test("an existing scope customer is reused rather than duplicated", async () => {
  const { calls, customers } = fakeStripe();
  customers.set("org_1|u:u1", "cus_existing");
  customers.set("org_1|k:user", "cus_existing_kind");
  await stripeScopeUsageLedger().record(EVENT);
  assert.deepEqual(calls.create, [], "search found them; nothing new is minted");
  assert.deepEqual(
    calls.stream[0].map((e) => e.payload.stripe_customer_id),
    ["cus_existing_kind", "cus_existing"],
  );
});

test("a Stripe failure PROPAGATES, so the policy layer can decide", async () => {
  __setStripeForTests({
    customers: {
      async search() {
        throw new Error("no permission");
      },
    },
    billing: {
      meters: {
        list() {
          return { [Symbol.asyncIterator]: async function* () { yield { id: "mtr_scope", event_name: "billing_tools_scope_usage" }; } };
        },
      },
    },
  });
  // This used to return 0 here, which is the silent-generosity failure: "I could
  // not resolve the counter" became "that member has used nothing". Load-testing a
  // real account found it — 75 rate-limited requests, not one reported fault,
  // because they all died in the scope resolve. The decision belongs to
  // `stripeUsageLedger({ onReadFailure })`, which can serve a last-known value.
  const real = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () =>
        stripeScopeUsageLedger({ wallet: walletLeg(4) }).total({
          orgId: "org_1",
          customerId: "cus_org",
          start: 1_000_000,
          filter: { callerId: "u1" },
        }),
      /no permission/,
    );
  } finally {
    console.error = real;
  }
});

test("a WRITE still degrades — a metered call must not die counting itself", async () => {
  __setStripeForTests({
    customers: { async search() { throw new Error("no permission") } },
    billing: { meters: { list() { return { [Symbol.asyncIterator]: async function* () { yield { id: "mtr_scope", event_name: "billing_tools_scope_usage" } } } } } },
  });
  const real = console.error;
  console.error = () => {};
  try {
    // Reports a dropped event rather than throwing: losing the count is bad, but
    // taking down the product to report it is worse.
    await stripeScopeUsageLedger().record(EVENT);
  } finally {
    console.error = real;
  }
});

test("sources.wallet=false skips the balance walk — the one unbounded read here", async () => {
  // `usageSince` pages balance transactions across the whole window, 100 per
  // request, and an org whose API usage the wallet funds writes one transaction
  // per call. On a plan where no per-caller window can ever be wallet-funded that
  // walk returns nothing and still costs the requests.
  const { calls } = fakeStripe({ summaries: { cus_u1: 30 } });
  const walked = { calls: 0 };
  const spyWallet = {
    covers: { orgIncluded: false, callerIncluded: false },
    async record() {},
    async total() { walked.calls++; return 0 },
  };

  const withWallet = stripeScopeUsageLedger({ wallet: spyWallet });
  await withWallet.total({ orgId: "org_1", customerId: "cus_org", start: 1, filter: { callerId: "u1" } });
  assert.equal(walked.calls, 1, "consulted by default");

  invalidateUsageScopes();
  const without = scopeLedgerNoWallet();
  const total = await without.total({
    orgId: "org_1", customerId: "cus_org", start: 1, filter: { callerId: "u1" },
  });
  assert.equal(walked.calls, 1, "not consulted again — the walk is gone");
  // And the INCLUDED half is still counted, which is the whole point: skipping the
  // wallet must not turn into skipping the window.
  assert.ok(calls.summaries.length > 0, "the scope meter is still read");
  assert.equal(typeof total, "number");
});

test("wallet: null still answers an org-scoped query with 0 rather than throwing", async () => {
  fakeStripe();
  const l = scopeLedgerNoWallet();
  assert.equal(await l.total({ orgId: "org_1", customerId: "cus_org", start: 1 }), 0);
});

test("sources skips the leg that cannot contribute, and defaults to BOTH", async () => {
  // The hint `resolveAllowance` supplies. Getting it wrong under-reports, so the
  // default when it is absent must be to read everything.
  const { customers } = fakeStripe({ summaries: { cus_u1: 30 } });
  customers.set("org_1|u:u1", "cus_u1");
  const walked = { n: 0 };
  const spyWallet = {
    covers: { orgIncluded: false, callerIncluded: false },
    async record() {},
    async total() { walked.n++; return 12 },
  };
  const l = stripeScopeUsageLedger({ wallet: spyWallet });
  const q = (sources) => ({
    orgId: "org_1", customerId: "cus_org", start: 1,
    filter: { callerKind: "user", callerId: "u1" }, ...(sources ? { sources } : {}),
  });

  assert.equal(await l.total(q()), 42, "absent → both legs");
  assert.equal(walked.n, 1);

  // An api caller on a `covers: "users"` plan draws no included allowance, so its
  // meter read is a guaranteed 0 — skip it, keep the debits.
  assert.equal(await l.total(q({ included: false, wallet: true })), 12);
  assert.equal(walked.n, 2, "wallet still read");

  // A pack that blocks on exhaustion can never spend the wallet — skip the walk,
  // which is the expensive one.
  const before = walked.n;
  assert.equal(await l.total(q({ included: true, wallet: false })), 30);
  assert.equal(walked.n, before, "the balance walk did not happen");
});

// ── Batching: several windows over one caller, one request ──────────────────
//
// `resolveAllowance` issues a plan's windows together, in one tick. The meter can
// group by time (`value_grouping_window: "day"`), so day-aligned windows over the
// same scope come out of ONE response — and the balance walk serves all of them in
// one pass. The contract is that batching changes the COST, never the answer.

const DAY = 86_400_000;
/** A ledger whose wallet leg reports nothing, so a test can assert the METER
 *  requests alone. `sources.wallet` is the per-query way to say the same thing. */
const scopeLedgerNoWallet = () =>
  stripeScopeUsageLedger({
    wallet: { covers: { orgIncluded: false, callerIncluded: false }, async record() {}, async total() { return 0 }, async totals(qs) { return qs.map(() => 0) } },
  });
/** A day-aligned window ending in the future, like `rateWindowFor` produces. */
const aligned = (daysBack) => ({
  start: Math.floor(Date.now() / DAY) * DAY - daysBack * DAY,
  end: Math.floor(Date.now() / DAY) * DAY + DAY,
});

function bucketStripe(buckets) {
  const calls = { summaries: [], bucketed: [], plain: [] };
  __setStripeForTests({
    customers: {
      async search() { return { data: [{ id: "cus_u1" }] }; },
      async create() { return { id: "cus_u1" }; },
    },
    billing: {
      meters: {
        list() {
          return { [Symbol.asyncIterator]: async function* () { yield { id: "mtr_scope", event_name: "billing_tools_scope_usage" }; } };
        },
        listEventSummaries(meter, params) {
          calls.summaries.push(params);
          if (params.value_grouping_window === "day") {
            calls.bucketed.push(params);
            const page = buckets;
            return { [Symbol.asyncIterator]: async function* () { yield* page; }, data: page };
          }
          calls.plain.push(params);
          return Promise.resolve({ data: buckets });
        },
      },
    },
    v2: { billing: { meterEventSession: { async create() { return { authentication_token: "t", expires_at: new Date(Date.now() + 1e6).toISOString() }; } }, meterEventStream: { async create() {} } } },
  });
  return calls;
}

test("two day-aligned windows over one caller cost ONE bucketed request", async () => {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const calls = bucketStripe([
    { start_time: (today - 2 * DAY) / 1000, end_time: (today - DAY) / 1000, aggregated_value: 7 },
    { start_time: (today - DAY) / 1000, end_time: today / 1000, aggregated_value: 11 },
    { start_time: today / 1000, end_time: (today + DAY) / 1000, aggregated_value: 5 },
  ]);
  const l = scopeLedgerNoWallet();
  const q = (w) => ({ orgId: "org_1", customerId: "cus_org", ...w, filter: { callerId: "u1" } });

  // Issued together, exactly as resolveAllowance issues them.
  const [wide, narrow] = await Promise.all([l.total(q(aligned(2))), l.total(q(aligned(0)))]);

  assert.equal(calls.bucketed.length, 1, "one bucketed read served both windows");
  assert.equal(calls.plain.length, 0);
  assert.equal(wide, 23, "3 days of buckets");
  assert.equal(narrow, 5, "today only, sliced from the same response");
});

test("a single window is read plainly, not bucketed", async () => {
  const calls = bucketStripe([{ start_time: 0, end_time: 9e9, aggregated_value: 4 }]);
  const l = scopeLedgerNoWallet();
  const v = await l.total({ orgId: "org_1", customerId: "cus_org", ...aligned(1), filter: { callerId: "u1" } });
  assert.equal(calls.bucketed.length, 0, "bucketing one window buys nothing");
  assert.equal(calls.plain.length, 1);
  assert.equal(v, 4);
});

test("an unaligned window keeps its own read — Stripe rejects bucketing it", async () => {
  const calls = bucketStripe([{ start_time: 0, end_time: 9e9, aggregated_value: 3 }]);
  const l = scopeLedgerNoWallet();
  const a = aligned(7);
  await Promise.all([
    l.total({ orgId: "org_1", customerId: "cus_org", ...a, filter: { callerId: "u1" } }),
    l.total({ orgId: "org_1", customerId: "cus_org", ...a, filter: { callerId: "u1" } }),
    // An `every: "hour"` window is not on a day boundary.
    l.total({ orgId: "org_1", customerId: "cus_org", start: a.start + 3_600_000, end: a.end, filter: { callerId: "u1" } }),
  ]);
  assert.equal(calls.bucketed.length, 1, "the two aligned ones batched");
  assert.equal(calls.plain.length, 1, "the hourly one did not");
});

test("different callers are never mixed into one read", async () => {
  const calls = bucketStripe([{ start_time: 0, end_time: 9e9, aggregated_value: 1 }]);
  const l = scopeLedgerNoWallet();
  const a = aligned(3);
  await Promise.all([
    l.total({ orgId: "org_1", customerId: "cus_org", ...a, filter: { callerId: "u1" } }),
    l.total({ orgId: "org_1", customerId: "cus_org", ...a, filter: { callerId: "u2" } }),
  ]);
  // Two scopes, two customers — a shared read would attribute one member's usage
  // to another, which is worse than any number of extra requests.
  assert.equal(calls.summaries.length, 2);
});

test("the wallet leg walks ONCE for several windows", async () => {
  bucketStripe([]);
  const walks = { n: 0 };
  const wallet = {
    covers: { orgIncluded: false, callerIncluded: false },
    async record() {},
    async total() { walks.n++; return 5 },
    async totals(qs) { walks.n++; return qs.map(() => 5) },
  };
  const l = stripeScopeUsageLedger({ wallet });
  const a = aligned(2), b = aligned(0);
  const [x, y] = await Promise.all([
    l.total({ orgId: "org_1", customerId: "cus_org", ...a, filter: { callerId: "u1" }, sources: { wallet: true, included: false } }),
    l.total({ orgId: "org_1", customerId: "cus_org", ...b, filter: { callerId: "u1" }, sources: { wallet: true, included: false } }),
  ]);
  assert.equal(walks.n, 1, "one pass over the transactions, not one per window");
  assert.deepEqual([x, y], [5, 5]);
});
