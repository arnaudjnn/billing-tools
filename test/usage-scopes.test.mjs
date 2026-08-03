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

test("a Stripe failure degrades to uncounted rather than throwing", async () => {
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
  // On the hot path of every metered call: a key that cannot read customers must
  // not take the product down. It says so once, loudly — silenced here because
  // the complaint IS the expected behaviour.
  const real = console.error;
  console.error = () => {};
  let total;
  try {
    await stripeScopeUsageLedger().record(EVENT);
    total = await stripeScopeUsageLedger({ wallet: walletLeg(4) }).total({
      orgId: "org_1",
      customerId: "cus_org",
      start: 1_000_000,
      filter: { callerId: "u1" },
    });
  } finally {
    console.error = real;
  }
  assert.equal(total, 4, "the wallet figure still stands");
});
