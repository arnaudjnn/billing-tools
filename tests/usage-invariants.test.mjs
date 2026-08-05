// The two invariants the Stripe-only usage counting rests on.
//
// Both are currently true "by construction", which is what the request batching
// was until an `await` quietly broke it. Neither has a type protecting it and
// neither fails loudly when violated — they fail as a number that is silently
// wrong, in the direction nobody reports.
//
//  1. THE SCOPE CONTRACT. `scopesFor` decides which counters an event is written
//     to; `scopeOf` decides which counter a query reads. If the read derives a
//     string the write never produces, it looks up a customer nobody writes to and
//     returns 0 — for ever, for that member. The dangerous change is not renaming a
//     prefix (that breaks everything at once and is obvious) but adding a
//     DIMENSION to the read filter that the write does not know about.
//
//  2. THE FUNDING SPLIT. A per-caller total is `wallet debits + scope meter`, and
//     the sum is only right because the two sets are disjoint: `deductCredits`
//     runs only for wallet-funded calls, and the scope meter is written only for
//     the others. Break that and every wallet-funded call counts twice — which
//     refuses a customer at half their pack, the one direction that generates
//     support tickets rather than silence.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { resolveAllowance } from "../dist/allowance.js";
import { meterUsage } from "../dist/metering.js";
import { stripeUsageLedger, invalidateMeters } from "../dist/usage-ledger.js";
import {
  scopeOf,
  scopesFor,
  stripeScopeUsageLedger,
  invalidateUsageScopes,
} from "../dist/usage-scopes.js";

const adapter = {
  async getBillingCustomerId() { return "cus_org"; },
  async getOrgDomains() { return []; },
  async getOrgMetadata() { return {}; },
  async setOrgMetadata() {},
  async getSubscription() {
    return { plan: "p", status: "active", subscriptionId: null, seats: 4, periodStart: null, periodEnd: null };
  },
  async getUserMetadata() { return {}; },
  async setUserMetadata() {},
  async listMemberIds() { return ["u1"]; },
};
const config = { freeCredits: 0, currency: "eur", baseUrl: "http://x", internalDomains: [], defaultLocale: "en" };

beforeEach(() => {
  invalidateMeters();
  invalidateUsageScopes();
});

// ── 1. The scope contract ───────────────────────────────────────────────────

const SEAT = {
  kind: "seats",
  seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 }, includedCredits: 1000, min: 1 } },
};

/** Every filter `resolveAllowance` actually issues, for a given caller. Captured
 *  from the real code path rather than hand-listed — a hand-listed set would go
 *  stale exactly when a new filter dimension is added, i.e. when it matters. */
async function filtersFor(caller, plans) {
  const seen = [];
  await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans,
    plan: "p",
    caller,
    customerId: "cus_org",
    skipWallet: true,
    skipSpendLimit: true,
    ledger: {
      covers: { orgIncluded: true, callerIncluded: true },
      async record() {},
      async total(q) { seen.push(q.filter ?? null); return 0; },
    },
  });
  return seen;
}

const PLANS = {
  p: {
    sells: SEAT,
    grant: { kind: "none" },
    cap: { kind: "per_seat", window: "month", onExhausted: "wallet" },
    replenish: { purchase: {} },
    limits: {
      rate: [
        { every: "week", credits: 500, scope: "caller", callerKind: "user" },
        { every: "hour", credits: 600, scope: "caller", callerKind: "api" },
        { every: "month", credits: 9999 },
      ],
    },
    sale: "self_serve",
  },
};

test("every filter a read issues names a scope some write produces", async () => {
  for (const caller of [
    { kind: "user", id: "u1", seatType: "standard" },
    { kind: "api", id: "key_1" },
    { kind: "api" },
  ]) {
    const written = new Set(scopesFor({ caller: { kind: caller.kind, id: caller.id } }));
    for (const filter of await filtersFor(caller, PLANS)) {
      const read = scopeOf(filter ?? undefined);
      assert.ok(
        written.has(read),
        `caller ${JSON.stringify(caller)} reads scope "${read}" (from filter ` +
          `${JSON.stringify(filter)}) but writes only [${[...written].join(", ")}] — ` +
          "that window would read 0 for ever",
      );
    }
  }
});

test("a read filter carrying a dimension the write ignores is caught", () => {
  // The failure this guards: someone narrows a window further on the read side
  // (by seat type, by action, by anything) without teaching `scopesFor` to write
  // a counter for it. `scopeOf` ignores what it does not know, so the read
  // silently lands on a BROADER counter and over-counts — or, if the prefix were
  // changed instead, on nothing at all.
  const written = new Set(scopesFor({ caller: { kind: "user", id: "u1" } }));
  assert.deepEqual([...written], ["org", "k:user", "u:u1"]);
  // Every shape the reader can express today resolves into that set.
  assert.equal(scopeOf(undefined), "org");
  assert.equal(scopeOf({ callerKind: "user" }), "k:user");
  assert.equal(scopeOf({ callerKind: "user", callerId: "u1" }), "u:u1");
  // The id wins over the kind on BOTH sides, or a per-member read would land on
  // the per-kind counter and report the whole workspace as one member's usage.
  assert.equal(scopeOf({ callerId: "u1" }), "u:u1");
});

test("an event with no caller is org-only, and an org read finds it", () => {
  assert.deepEqual(scopesFor({}), ["org"]);
  assert.equal(scopeOf(undefined), "org");
});

// ── 2. The funding split ────────────────────────────────────────────────────

function fundingStripe() {
  const calls = { debits: [], scopeEvents: 0, orgEvents: 0 };
  __setStripeForTests({
    customers: {
      async retrieve() { return { id: "cus_org", balance: -1_000_000, currency: "eur", metadata: {} }; },
      async search() { return { data: [{ id: "cus_scope" }] }; },
      async create() { return { id: "cus_scope" }; },
      async createBalanceTransaction(id, params) { calls.debits.push(params.amount); return { id: "cbt" }; },
      listBalanceTransactions() {
        return { [Symbol.asyncIterator]: async function* () {} };
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
        listEventSummaries() { return Promise.resolve({ data: [] }); },
      },
      meterEvents: { async create() { calls.orgEvents++; } },
    },
    v2: {
      billing: {
        meterEventSession: { async create() { return { authentication_token: "t", expires_at: new Date(Date.now() + 1e6).toISOString() }; } },
        meterEventStream: { async create({ events }) { calls.scopeEvents += events.length; } },
      },
    },
  });
  return calls;
}

const capPlan = (cap) => ({
  p: { sells: SEAT, grant: { kind: "none" }, cap, replenish: { purchase: {} }, sale: "self_serve" },
});

/** Which funding source a plan shape produces, and what each wrote. */
async function meterOnce(cap) {
  const calls = fundingStripe();
  const r = await meterUsage(adapter, config, {
    orgId: "org_1",
    action: "search",
    cost: 5,
    plans: capPlan(cap),
    plan: "p",
    caller: { kind: "user", id: "u1", seatType: "standard" },
    ledger: stripeUsageLedger({ perCaller: stripeScopeUsageLedger() }),
  });
  return { r, calls };
}

test("a wallet-funded call writes a DEBIT and no per-caller meter event", async () => {
  const { r, calls } = await meterOnce({ kind: "wallet" });
  assert.equal(r.ok, true);
  assert.equal(r.funded, "wallet");
  assert.deepEqual(calls.debits, [5], "the wallet is what paid, so money moved");
  // Reporting it to the scope meter as well would make `total` count it twice:
  // once from the debit, once from the meter.
  assert.equal(calls.scopeEvents, 0, "wallet-funded usage must not reach the scope meter");
});

test("an INCLUDED call writes a per-caller meter event and no debit", async () => {
  const { r, calls } = await meterOnce({ kind: "per_seat", window: "month", onExhausted: "wallet" });
  assert.equal(r.ok, true);
  assert.equal(r.funded, "pack");
  // Debiting included usage charges twice for one call — the subscription already
  // paid for it.
  assert.deepEqual(calls.debits, [], "included usage must move no money");
  assert.ok(calls.scopeEvents > 0, "but it must still be counted, or its cap cannot apply");
});

test("the two sets never overlap, whichever allowance pays", async () => {
  for (const cap of [
    { kind: "wallet" },
    { kind: "per_seat", window: "month", onExhausted: "wallet" },
    { kind: "pool", credits: 100_000, onExhausted: "wallet" },
  ]) {
    const { r, calls } = await meterOnce(cap);
    const moved = calls.debits.length > 0;
    const counted = calls.scopeEvents > 0;
    // Exactly one of the two, every time. Both is a double count; neither is usage
    // counted by nothing.
    assert.notEqual(
      moved,
      counted,
      `cap ${cap.kind} funded="${r.funded}" wrote debits=${calls.debits.length} ` +
        `scopeEvents=${calls.scopeEvents} — the split must be disjoint and total`,
    );
  }
});

test("the ORG meter sees every call, whatever funded it", async () => {
  // The org-wide leg is deliberately NOT split: a pool and the spend limit must
  // count included and wallet-funded usage alike. Only the per-caller leg splits.
  for (const cap of [{ kind: "wallet" }, { kind: "per_seat", window: "month", onExhausted: "wallet" }]) {
    const { calls } = await meterOnce(cap);
    assert.equal(calls.orgEvents, 1, `cap ${cap.kind}: the org meter must see it`);
  }
});
