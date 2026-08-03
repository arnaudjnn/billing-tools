// Which windows a ledger can COUNT, and the two ways that went wrong silently.
//
// The failure this pins produces no error and looks like generosity: a window the
// wired ledger cannot see reads 0, so it never applies and no call is ever
// refused. It shipped twice.
//
//  1. A POOLED plan metered by the balance ledger. An included call moves no
//     money, so it writes no balance transaction — the pool read 0% forever. The
//     boot warning and the doctor both missed it because both asked only about
//     PER-MEMBER windows, and `createMeter` defaulted to that ledger while
//     `createBilling` defaulted to the composite: same decision, two answers.
//  2. A PER-MEMBER included window with no store, which no Stripe primitive can
//     count. Already caught; kept here so the two stay symmetrical.
//
// So a ledger now declares what it covers, and ONE rule (`ledgerGaps`) is read by
// the boot warning and the doctor alike.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import {
  defaultUsageLedger,
  invalidateMeters,
  stripeBalanceUsageLedger,
  stripeMeterUsageLedger,
  stripeUsageLedger,
} from "../dist/usage-ledger.js";
import { coverageNeededBy, ledgerGaps, normalizePlans } from "../dist/plan-model.js";
import { checkPlansConfig } from "../dist/doctor.js";
import { stripeScopeUsageLedger } from "../dist/usage-scopes.js";
import { createMeter } from "../dist/metering.js";

const POOLED = {
  pro: {
    sells: { kind: "flat", price: { monthly: 5000, yearly: 50000 } },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 1000, onExhausted: "wallet" },
    sale: "self_serve",
  },
};

const PER_MEMBER = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 } } } },
    grant: { kind: "none" },
    cap: { kind: "per_seat", credits: 500 },
    sale: "self_serve",
  },
};

const WALLET = {
  starter: {
    sells: { kind: "nothing" },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    replenish: { purchase: true },
    sale: "free",
  },
};

const adapter = {
  async validateApiKey() {
    return null;
  },
  async getOrgDomains() {
    return [];
  },
  async getBillingCustomerId() {
    return null;
  },
  async setBillingCustomerId() {},
  async ensureOrgForUser() {
    return { orgId: "org_1" };
  },
  async mintApiKey() {
    return { id: "k", value: "sk_x" };
  },
  async listApiKeys() {
    return [];
  },
  async revokeApiKey() {
    return null;
  },
};

const capture = (fn) => {
  const lines = [];
  const real = console.warn;
  console.warn = (m) => lines.push(String(m));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return lines;
};

// ── What each shipped ledger says it can do ─────────────────────────────────

test("the balance ledger admits it cannot see included usage, on either axis", () => {
  // It IS per-caller (a debit carries the caller on its metadata) but only where
  // money moved, which is precisely why a pool metered by it reads 0.
  assert.deepEqual(stripeBalanceUsageLedger().covers, {
    orgIncluded: false,
    callerIncluded: false,
  });
});

test("the meter covers org-wide included usage and nothing per caller", () => {
  assert.deepEqual(stripeMeterUsageLedger().covers, {
    orgIncluded: true,
    callerIncluded: false,
  });
});

test("the composite inherits each axis from the leg that answers it", () => {
  // The scope ledger is the per-caller leg that closes the second axis — and it
  // does it in Stripe, which is why no store ships here any more.
  assert.deepEqual(stripeScopeUsageLedger().covers, {
    orgIncluded: false,
    callerIncluded: true,
  });
  assert.deepEqual(stripeUsageLedger().covers, { orgIncluded: true, callerIncluded: false });
  assert.deepEqual(stripeUsageLedger({ perCaller: stripeScopeUsageLedger() }).covers, {
    orgIncluded: true,
    callerIncluded: true,
  });
});

test("a leg that declares nothing makes the composite silent rather than guessing", () => {
  // An invented `false` would fail a consumer's perfectly-wired custom ledger.
  const custom = { async record() {}, async total() { return 0; } };
  assert.equal(stripeUsageLedger({ perCaller: custom }).covers, undefined);
  assert.equal(stripeUsageLedger({ orgWide: custom }).covers, undefined);
});

// ── The rule, once ──────────────────────────────────────────────────────────

test("a wallet cap needs no coverage at all: every call moves money", () => {
  const [model] = normalizePlans(WALLET);
  assert.deepEqual(coverageNeededBy(model), { orgIncluded: false, callerIncluded: false });
  const gaps = ledgerGaps(normalizePlans(WALLET), stripeBalanceUsageLedger().covers);
  assert.deepEqual([gaps.org, gaps.caller], [[], []]);
});

test("a pool needs the ORG axis; a seat pack needs the CALLER axis", () => {
  const pooled = ledgerGaps(normalizePlans(POOLED), stripeBalanceUsageLedger().covers);
  assert.deepEqual(pooled.org.map((m) => m.key), ["pro"]);
  assert.deepEqual(pooled.caller, []);

  const perMember = ledgerGaps(normalizePlans(PER_MEMBER), stripeUsageLedger().covers);
  assert.deepEqual(perMember.caller.map((m) => m.key), ["pro"]);
  assert.deepEqual(perMember.org, []);
});

// ── The doctor, reading the same rule ───────────────────────────────────────

test("the doctor fails a pooled plan whose ledger cannot see included usage", () => {
  // The regression: this configuration passed every check while counting nothing.
  const r = checkPlansConfig(POOLED, {
    hasCheckout: true,
    usageLedger: stripeBalanceUsageLedger().covers,
  });
  const c = r.checks.find((x) => x.title === "Usage ledger");
  assert.equal(c.level, "error");
  assert.match(c.detail, /pro/);
  assert.match(c.detail, /ORG-WIDE/);
  assert.equal(r.healthy, false);
});

test("the same config on the default ledger is fine, and needs no store", () => {
  const r = checkPlansConfig(POOLED, {
    hasCheckout: true,
    usageLedger: defaultUsageLedger().covers,
  });
  assert.equal(r.checks.find((x) => x.title === "Usage ledger").level, "ok");
});

test("omitting the ledger still asserts nothing", () => {
  const r = checkPlansConfig(POOLED, { hasCheckout: true });
  assert.equal(r.checks.find((x) => x.title === "Usage ledger"), undefined);
});

test("the boolean shorthand keeps meaning `a per-member store is wired`", () => {
  const bad = checkPlansConfig(PER_MEMBER, { hasCheckout: true, usageLedger: false });
  assert.equal(bad.checks.find((x) => x.title === "Usage ledger").level, "error");
  const good = checkPlansConfig(PER_MEMBER, { hasCheckout: true, usageLedger: true });
  assert.equal(good.checks.find((x) => x.title === "Usage ledger").level, "ok");
});

// ── One default, so the entry point can't change the answer ─────────────────

test("createMeter defaults to the composite, so a pooled plan is counted and silent", () => {
  const lines = capture(() =>
    createMeter(adapter, { currency: "eur", internalDomains: [], freeCredits: 0 }, {
      plans: POOLED,
      rateCard: { search: 1 },
      resolvePlan: async () => "pro",
    }),
  );
  assert.deepEqual(lines, []);
});

test("createMeter warns when an explicit ledger cannot see the pool", () => {
  const lines = capture(() =>
    createMeter(adapter, { currency: "eur", internalDomains: [], freeCredits: 0 }, {
      plans: POOLED,
      rateCard: { search: 1 },
      resolvePlan: async () => "pro",
      ledger: stripeBalanceUsageLedger(),
    }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pro/);
  assert.match(lines[0], /stripeUsageLedger/);
});

// ── The meter provisions itself, like plan prices ───────────────────────────

test("the first record creates the meter, then reports to it; the second reuses it", async () => {
  invalidateMeters();
  const created = [];
  const events = [];
  let meters = [];
  __setStripeForTests({
    billing: {
      meters: {
        list() {
          const page = [...meters];
          return { [Symbol.asyncIterator]: async function* () { yield* page; } };
        },
        async create(params) {
          created.push(params);
          const m = { id: `mtr_${created.length}`, event_name: params.event_name };
          meters.push(m);
          return m;
        },
      },
      meterEvents: {
        async create(params) {
          events.push(params);
          return {};
        },
      },
    },
  });

  const ledger = stripeMeterUsageLedger();
  const event = { orgId: "org_1", customerId: "cus_1", action: "search", cost: 5, funded: "pool" };
  await ledger.record(event);
  await ledger.record(event);

  assert.equal(created.length, 1, "created once, not per call");
  assert.equal(created[0].default_aggregation.formula, "sum");
  assert.equal(events.length, 2, "both calls were counted");
  assert.equal(events[0].payload.stripe_customer_id, "cus_1");
  invalidateMeters();
});

test("a meter that cannot be created degrades to 0 and says so once, instead of throwing", async () => {
  // Reached from `record` on the hot path of every metered call, so a key without
  // permission must not take the product down — but the silence would otherwise be
  // indistinguishable from no usage, hence the line.
  invalidateMeters();
  __setStripeForTests({
    billing: {
      meters: {
        list() {
          return { [Symbol.asyncIterator]: async function* () {} };
        },
        async create() {
          throw new Error("permission denied");
        },
      },
      meterEvents: {
        async create() {
          throw new Error("no such meter");
        },
      },
    },
  });

  const errors = [];
  const real = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const ledger = stripeMeterUsageLedger();
    await ledger.record({
      orgId: "org_1",
      customerId: "cus_1",
      action: "search",
      cost: 5,
      funded: "pool",
    });
    assert.equal(
      await ledger.total({ orgId: "org_1", customerId: "cus_1", start: 0 }),
      0,
      "windows read 0 rather than blowing up",
    );
  } finally {
    console.error = real;
    invalidateMeters();
  }
  assert.equal(errors.length, 1, "one line per process, not one per call");
  assert.match(errors[0], /ensureMeters/);
});

test("a failed resolve backs off instead of re-listing on every metered call", async () => {
  // Without the back-off, a broken key puts a list AND a create attempt on the hot
  // path of every metered call for as long as it stays broken.
  invalidateMeters();
  let lists = 0;
  __setStripeForTests({
    billing: {
      meters: {
        list() {
          lists++;
          return { [Symbol.asyncIterator]: async function* () {} };
        },
        async create() {
          throw new Error("permission denied");
        },
      },
      meterEvents: { async create() {} },
    },
  });

  const real = console.error;
  console.error = () => {};
  try {
    const ledger = stripeMeterUsageLedger();
    const event = { orgId: "o", customerId: "c", action: "search", cost: 1, funded: "pool" };
    await ledger.record(event);
    await ledger.record(event);
    await ledger.record(event);
  } finally {
    console.error = real;
    invalidateMeters();
  }
  assert.equal(lists, 1, "one attempt, then back off");
});

// ── The rule vs the reads it is supposed to describe ────────────────────────
//
// `coverageNeededBy` used to ask one question — is any limit `scope: "caller"` —
// and the reads `resolveAllowance` issues answer a different one. It was wrong in
// BOTH directions, which is why these are pinned together: one rejected a config
// that needs no store, the other accepted one that cannot be counted at all.

test("an org-scoped limit narrowed by callerKind still needs per-caller counting", () => {
  // `scope` defaults to "org", so the old rule filed this under orgIncluded. But
  // allowance.ts issues `{callerKind:"user"}` for it — a per-caller read — and the
  // usage behind it is POOL-funded, so the balance leg returns 0 for ever. The
  // limit silently never applies, which looks like generosity rather than a fault.
  const model = normalizePlans({
    p: {
      sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } },
      grant: { kind: "none" },
      cap: { kind: "pool", credits: 1000, onExhausted: "wallet" },
      limits: { rate: [{ every: "hour", credits: 600, callerKind: "user" }] },
      sale: "self_serve",
    },
  })[0];
  assert.equal(coverageNeededBy(model).callerIncluded, true);
  assert.deepEqual(
    ledgerGaps([model], stripeUsageLedger().covers).caller.map((m) => m.key),
    ["p"],
  );
});

test("a caller-scoped limit over wallet-only usage needs NO store", () => {
  // `covers: "users"` excludes a machine caller from the included window, so every
  // API credit moves money and the debit records it per caller, exactly and with
  // no lag. Demanding a store here rejected a config Stripe already answers.
  const model = normalizePlans({
    p: {
      sells: {
        kind: "seats",
        seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 }, includedCredits: 1000 } },
      },
      grant: { kind: "none" },
      cap: { kind: "pool", perSeat: "included", covers: "users", onExhausted: "wallet" },
      replenish: { purchase: {} },
      limits: { rate: [{ every: "hour", credits: 600, scope: "caller", callerKind: "api" }] },
      sale: "self_serve",
    },
  })[0];
  assert.equal(coverageNeededBy(model).callerIncluded, false);
  assert.deepEqual(ledgerGaps([model], stripeUsageLedger().covers).caller, []);
});

test("a per-seat cap still needs it, and the scope ledger provides it", () => {
  const model = normalizePlans(PER_MEMBER)[0];
  assert.equal(coverageNeededBy(model).callerIncluded, true);
  // The composite with the Stripe-backed per-caller leg closes the gap with no
  // database anywhere.
  const covers = stripeUsageLedger({ perCaller: stripeScopeUsageLedger() }).covers;
  assert.deepEqual(covers, { orgIncluded: true, callerIncluded: true });
  assert.deepEqual(ledgerGaps([model], covers).caller, []);
});
