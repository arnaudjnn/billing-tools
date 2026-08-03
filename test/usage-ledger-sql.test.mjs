// The SQL ledger: the third store, for the one thing Stripe cannot count.
//
// Stripe's two ledgers each fail one half of the same requirement. Balance
// transactions can attribute per caller but cannot see INCLUDED usage (an included
// call moves no money, so it writes nothing). Billing Meters see included usage but
// discard the caller filter, so a per-member question returns the whole org. No
// metadata store closes the gap either: 50 keys on a Stripe customer, 10 on a
// WorkOS organization, and neither has an atomic increment, so counting races.
//
// Hence a row. These tests assert the SQL, because that is the whole contract — the
// driver is duck-typed, so a fake client is a complete substitute.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ensureUsageLedgerTable,
  postgresUsageLedger,
  USAGE_EVENTS,
} from "../dist/usage-ledger.js";

/** Anything with `query(sql, params) → { rows }`. `pg`'s Pool already is one. */
function fakeClient(rows = [{ total: 0 }]) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("record is one INSERT: no read, no transaction", async () => {
  // It runs on the hot path of every metered execution, so anything more than one
  // statement is a latency budget nobody agreed to.
  const client = fakeClient();
  const ledger = postgresUsageLedger(client);
  await ledger.record({
    orgId: "org_1",
    customerId: "cus_1",
    action: "search",
    cost: 5,
    funded: "pool",
    caller: { kind: "user", id: "u_1" },
    at: 1_700_000_000_000,
  });

  assert.equal(client.calls.length, 1);
  const { sql, params } = client.calls[0];
  assert.match(sql, /^\s*INSERT INTO usage_events/);
  assert.deepEqual(params, [
    "org_1",
    "cus_1",
    "search",
    5,
    "pool",
    "user",
    "u_1",
    null,
    1_700_000_000_000,
  ]);
});

test("a retry is a no-op, and the partial index is inferable", async () => {
  // `idempotency_key` is nullable and only non-null keys are unique, so the index
  // is PARTIAL — and Postgres refuses to infer a partial index for ON CONFLICT
  // unless the predicate is repeated at the insert. Omitting it fails EVERY insert
  // with 42P10, which is how this was found the first time.
  const client = fakeClient();
  await postgresUsageLedger(client).record({
    orgId: "org_1",
    customerId: "cus_1",
    action: "search",
    cost: 1,
    funded: "wallet",
    idempotencyKey: "evt_1",
  });
  const { sql, params } = client.calls[0];
  assert.match(sql, /ON CONFLICT \(idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/);
  assert.equal(params[7], "evt_1");
});

test("total sums cost over a HALF-OPEN window", async () => {
  // [start, end): an event on a boundary belongs to exactly one window, never to
  // both. Every window in this library is defined that way.
  const client = fakeClient([{ total: 42 }]);
  const used = await postgresUsageLedger(client).total({
    orgId: "org_1",
    customerId: "cus_1",
    start: 1_000,
    end: 2_000,
  });
  assert.equal(used, 42);
  const { sql, params } = client.calls[0];
  assert.match(sql, /SUM\(cost\)/);
  assert.match(sql, /at >= to_timestamp\(\$2 \/ 1000\.0\)/);
  assert.match(sql, /at < to_timestamp\(\$3 \/ 1000\.0\)/);
  assert.deepEqual(params, ["org_1", 1_000, 2_000]);
});

test("an open-ended window omits the upper bound rather than guessing now()", async () => {
  const client = fakeClient([{ total: 7 }]);
  await postgresUsageLedger(client).total({ orgId: "org_1", customerId: "cus_1", start: 1_000 });
  const { sql, params } = client.calls[0];
  assert.equal(/at </.test(sql), false);
  assert.deepEqual(params, ["org_1", 1_000]);
});

test("a caller kind with no id means every caller of that kind", async () => {
  // How a shared API seat is measured: one window across every key in the org.
  const client = fakeClient([{ total: 3 }]);
  await postgresUsageLedger(client).total({
    orgId: "org_1",
    customerId: "cus_1",
    start: 1_000,
    filter: { callerKind: "api" },
  });
  const { sql, params } = client.calls[0];
  assert.match(sql, /caller_kind = \$3/);
  assert.equal(/caller_id/.test(sql), false);
  assert.deepEqual(params, ["org_1", 1_000, "api"]);
});

test("a caller id narrows to one member — the figure Stripe cannot give", async () => {
  const client = fakeClient([{ total: 9 }]);
  await postgresUsageLedger(client).total({
    orgId: "org_1",
    customerId: "cus_1",
    start: 1_000,
    end: 2_000,
    filter: { callerKind: "user", callerId: "u_1" },
  });
  const { sql, params } = client.calls[0];
  assert.match(sql, /caller_kind = \$4/);
  assert.match(sql, /caller_id = \$5/);
  assert.deepEqual(params, ["org_1", 1_000, 2_000, "user", "u_1"]);
});

test("an empty table reads 0, not undefined", async () => {
  assert.equal(
    await postgresUsageLedger(fakeClient([])).total({
      orgId: "org_1",
      customerId: "cus_1",
      start: 0,
    }),
    0,
  );
});

test("the shipped DDL is idempotent and carries the partial unique index", async () => {
  // Safe to run from a migration on every deploy, and it ships rather than being
  // described so no consumer rediscovers the partial-index trap.
  const client = fakeClient();
  await ensureUsageLedgerTable(client);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].sql, USAGE_EVENTS);
  assert.match(USAGE_EVENTS, /CREATE TABLE IF NOT EXISTS usage_events/);
  assert.match(
    USAGE_EVENTS,
    /CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_idx\s+ON usage_events \(idempotency_key\) WHERE idempotency_key IS NOT NULL/,
  );
  // The two indexes the two queries above actually use.
  assert.match(USAGE_EVENTS, /usage_events \(org_id, at DESC\)/);
  assert.match(USAGE_EVENTS, /usage_events \(org_id, caller_kind, caller_id, at DESC\)/);
});

// ── The wiring: choosing a ledger should not be a decision ──────────────────

import { createBilling } from "../dist/create-billing.js";
import { checkPlansConfig } from "../dist/doctor.js";

/** A plan that INCLUDES usage, so a ledger is required to count it. */
const POOLED = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1000, yearly: 10000 } } } },
    cap: { kind: "pool", credits: 1000 },
    sale: "self_serve",
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

// A window that is both INCLUDED and PER-MEMBER — the pair no Stripe primitive can
// count, and now the only thing that needs a store.
const PER_MEMBER = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1000, yearly: 10000 }, includedCredits: 1000 } },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat" },
    sale: "self_serve",
  },
};

test("meter.db wires the SQL ledger, and silences the boot warning", async () => {
  // The point of `db`: a project that already has Postgres for its user↔customer
  // sync should not have to make a ledger decision at all.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const client = fakeClient();
    const billing = createBilling({
      adapter,
      config: { currency: "eur", baseUrl: "https://t.local" },
      // A per-member window, i.e. one that genuinely needs the store — with a
      // pooled plan this would pass whether `db` were wired or not.
      plans: PER_MEMBER,
      meter: { rateCard: { search: 1 }, db: client },
    });
    assert.ok(billing.meter, "a meter was built");
    assert.deepEqual(warnings, [], "nothing to warn about: a ledger is wired");
  } finally {
    console.warn = realWarn;
  }
});

test("an ORG-wide pool no longer needs a store at all", async () => {
  // The composite counts it on a Stripe meter — included usage included, one
  // request at any window width. Warning here would send someone to stand up a
  // database they do not need.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    createBilling({
      adapter,
      config: { currency: "eur", baseUrl: "https://t.local" },
      plans: POOLED,
      meter: { rateCard: { search: 1 } },
    });
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = realWarn;
  }
});

test("a PER-MEMBER included window with no store still warns, naming the plans", async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    createBilling({
      adapter,
      config: { currency: "eur", baseUrl: "https://t.local" },
      plans: PER_MEMBER,
      meter: { rateCard: { search: 1 } },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pro/);
    assert.match(warnings[0], /meter\.db/);
    // And it names the alternative that needs no store at all.
    assert.match(warnings[0], /perSeat/);
  } finally {
    console.warn = realWarn;
  }
});

test("a caller-scoped rate limit counts as per-member too", async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    createBilling({
      adapter,
      config: { currency: "eur", baseUrl: "https://t.local" },
      plans: {
        pro: {
          ...POOLED.pro,
          limits: { rate: [{ every: "week", credits: 500, scope: "caller" }] },
        },
      },
      meter: { rateCard: { search: 1 } },
    });
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = realWarn;
  }
});

test("the plan check makes it an ERROR, not a warning", async () => {
  // A warning in a deploy log is missable and unenforced caps are not recoverable
  // after the fact, so the setup check fails outright. It must agree with the boot
  // warning about WHICH plans need a store, or it sends someone to fix a config
  // that was already right.
  const bad = checkPlansConfig(PER_MEMBER, { hasCheckout: true, usageLedger: false });
  const c = bad.checks.find((x) => x.title === "Usage ledger");
  assert.equal(c.level, "error");
  assert.match(c.fix, /meter\.db/);
  assert.equal(bad.healthy, false);

  const good = checkPlansConfig(PER_MEMBER, { hasCheckout: true, usageLedger: true });
  assert.equal(good.checks.find((x) => x.title === "Usage ledger").level, "ok");

  // And a pooled catalogue is not failed for missing a store it does not need.
  const pooled = checkPlansConfig(POOLED, { hasCheckout: true, usageLedger: false });
  assert.equal(pooled.checks.find((x) => x.title === "Usage ledger").level, "ok");
});

test("a wallet-only catalog needs no ledger, and is not nagged", async () => {
  // Every metered call moves money, so the Stripe default sees all of it.
  const walletOnly = {
    pro: {
      sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1000, yearly: 10000 } } } },
      cap: { kind: "wallet" },
      sale: "self_serve",
    },
  };
  const r = checkPlansConfig(walletOnly, { hasCheckout: true, usageLedger: false });
  assert.equal(r.checks.find((x) => x.title === "Usage ledger").level, "ok");
});
