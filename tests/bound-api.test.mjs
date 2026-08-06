// The bound API: every org-scoped function with adapter/config/plans/ledger and
// the plan resolver already applied.
//
// It replaces ~40 hand-written pass-throughs per consumer — measured on the first
// two apps, where 39 of 54 runtime exports bound nothing but the adapter. Volume is
// the visible reason. The one that matters is that a hand-written wrapper is a place
// to put logic, and the logic that lands there is exactly what must not be
// duplicated: which cycle a grant is filed against, which plan the meter thinks the
// org is on, which ledger a usage read goes to.
//
// `topup-cycle.test.mjs` records what that costs when it goes wrong — a grant filed
// under a calendar month that the meter reads as a subscription period grants
// nothing, and nothing errors. So the assertions below are mostly about the bound
// calls resolving the SAME cycle and the SAME plan the meter would.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { createBoundApi } from "../dist/bound-api.js";
import { currentCycle } from "../dist/allowance.js";
import { extraAllowance } from "../dist/topup.js";
import { fakeAdapter } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000 } },
    },
    cap: { kind: "per_seat" },
    replenish: { request: {} },
    sale: "self_serve",
  },
};

// Mid-month, so a calendar-month key and the real cycle key are visibly different.
const MID_MONTH = {
  plan: "pro",
  status: "active",
  periodStart: "2026-08-14T09:00:00.000Z",
  periodEnd: "2026-09-14T09:00:00.000Z",
};

const config = {
  freeCredits: 100,
  currency: "eur",
  baseUrl: "https://test.local",
  internalDomains: [],
  defaultLocale: "en",
};

const ledger = { async record() {}, async total() { return 0 } };

function api(overrides = {}) {
  // `members` is declared, not defaulted: the bound top-up and seat calls refuse a member id
  // that is not in the workspace, so a fixture with an empty roster refuses its own member —
  // which is the check working, and a test that papered over it would be asserting nothing.
  const adapter = fakeAdapter({ subscription: MID_MONTH, members: ["u1", "u2"] });
  return {
    adapter,
    api: createBoundApi({ adapter, config, plans: PLANS, ledger, ...overrides }),
  };
}

test("a filed top-up lands on the cycle the meter reads", async () => {
  // The whole point of binding. The caller names a member and an amount; it cannot
  // name the wrong cycle, because it does not name one at all.
  const { adapter, api: a } = api();
  const { id, cycle } = await a.topUps.request("org_1", { memberId: "u1", amount: 250 });

  // The invariant, stated without depending on today's date: whatever window the
  // meter is in, the bound call filed against THAT one. Asserting a specific key
  // shape here would only test the fixture — `topup-cycle.test.mjs` pins the
  // subscription-period-vs-calendar-month distinction with a frozen `now`.
  const meterCycle = await currentCycle(adapter, { orgId: "org_1", plans: PLANS, plan: "pro" });
  assert.equal(cycle, meterCycle.key);

  // And approving it is readable back under that same key.
  const ok = await a.topUps.approve("org_1", id);
  assert.equal(ok.ok, true);
  assert.equal(await extraAllowance(adapter, "org_1", "u1", meterCycle.key), 250);
});

test("the plan resolver is used, not the adapter's subscription, when given", async () => {
  // An app that keeps the plan in its own metadata passes `resolvePlan`; the bound
  // API must honour it, or a usage screen reads one plan while the meter enforces
  // another.
  const calls = [];
  const { api: a } = api({
    resolvePlan: async (orgId) => {
      calls.push(orgId);
      return "pro";
    },
  });
  assert.equal(await a.plan("org_9"), "pro");
  assert.deepEqual(calls, ["org_9"]);
});

test("with no resolver it falls back to the adapter, like the tools do", async () => {
  const { api: a } = api({ resolvePlan: undefined });
  assert.equal(await a.plan("org_1"), "pro");
});

test("usage reads carry the bound ledger and plan", async () => {
  let asked = 0;
  const counting = { async record() {}, async total() { asked++; return 400 } };
  const { api: a } = api({ ledger: counting });

  // `allowance` rather than `summary`: the wallet and the spend ceiling both live in
  // Stripe, and neither is what this asserts. Skipping them keeps the test offline
  // — the same reason scartoffie's pricing-conformance suite skips them.
  const state = await a.usage.allowance("org_1", {
    caller: { kind: "user", id: "u1", seatType: "standard" },
    skipWallet: true,
    skipSpendLimit: true,
  });

  assert.ok(asked > 0, "the bound ledger was not consulted");
  // A 1000-credit Standard pack, 400 reported used — so both the bound PLAN (which
  // decides the pack exists) and the bound LEDGER (which reports the usage) landed.
  assert.equal(state.pack?.size, 1000);
  assert.equal(state.pack?.used, 400);
  assert.equal(state.pack?.remaining, 600);
});

test("allowance resolves the caller's SEAT, like every other read of the same fact", async () => {
  // The failure this pins is a DISAGREEMENT, not an exception. A caller carrying only an id
  // matches no seat-typed window, so the window that was refusing them was filtered out of
  // `state.limits` and `topUpTargetOf` answered "nothing is blocked" — while the ladder,
  // which resolves the seat, said the same member was capped. Measured on a Premium member
  // at 100% of their week: the screen offered a plan upgrade nobody needed, because the two
  // reads were about different people.
  const { adapter, api: a } = api({
    plans: {
      pro: {
        ...PLANS.pro,
        limits: { rate: [{ every: "week", credits: 500, scope: "caller", seatType: "premium" }] },
        sells: {
          kind: "seats",
          seatTypes: {
            standard: { price: { monthly: 1800 }, includedCredits: 1000, min: 1 },
            premium: { price: { monthly: 9000 }, includedCredits: 5000 },
          },
        },
      },
    },
    ledger: { async record() {}, async total() { return 600 } },
  });
  await a.seats.assign("org_1", "u1", "premium");

  // No `seatType` — exactly what a server action holding a user id can pass.
  const state = await a.usage.allowance("org_1", {
    caller: { kind: "user", id: "u1" },
    skipWallet: true,
    skipSpendLimit: true,
  });

  const weekly = state.limits.find((l) => l.every === "week");
  assert.ok(weekly, "the seat-typed window was filtered out — the seat did not resolve");
  assert.equal(weekly.remaining, 0);
  const { topUpTargetOf } = await import("../dist/allowance.js");
  assert.equal(topUpTargetOf(state)?.every, "week", "and so nothing could be granted");
  void adapter;
});

test("subscription.change binds plans, config and currency", async () => {
  // Not asserting Stripe behaviour — asserting the caller does not have to restate
  // what createBilling already knows. A missing `currency` here silently priced a
  // change in the account default rather than the configured one.
  const { api: a } = api();
  await assert.rejects(
    () => a.subscription.change("org_1", { plan: "nope" }),
    /Unknown plan/,
    "the bound catalogue was not passed through",
  );
});

test("every adapter-first function is wired into the bound API", async () => {
  // Completeness, in the spirit of the tool-surface test: a library function taking
  // the adapter first and NOT wired here is one every consumer wraps by hand again.
  //
  // It checks that bound-api.ts REFERENCES the function, not that some bound name
  // matches it — the bound shape groups and renames (`usageSummary` becomes
  // `usage.summary`), so a name-matching version of this test needed an exemption
  // for nearly every entry, which made it pass while asserting nothing.
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = new URL("../src", import.meta.url).pathname;

  const adapterFirst = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(
      /export (?:async )?function (\w+)\(\s*\n?\s*adapter\s*:\s*BillingAdapter/g,
    )) {
      adapterFirst.set(m[1], f);
    }
  }
  assert.ok(adapterFirst.size >= 35, `expected ~37 adapter-first fns, found ${adapterFirst.size}`);

  // Comments stripped. bound-api.ts explains itself with a sample wrapper that
  // NAMES `listSeatAssignments`, so an unstripped match let a genuinely unwired
  // function pass — verified by deleting the binding and watching this stay green.
  // Same trap conventions.test.mjs documents for its own source scans.
  const bound = readFileSync(join(dir, "bound-api.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // `meterUsage` is the one exception: consumers get the richer BOUND meter from
  // `createBilling({ meter })` (`billing.meter` / `billing.meterRequest`), which also
  // owns the rate card, so duplicating it here would give two ways to meter a call.
  const EXEMPT = new Set(["meterUsage"]);

  const unwired = [...adapterFirst.keys()]
    .filter((n) => !EXEMPT.has(n))
    .filter((n) => !new RegExp(`\\b${n}\\b`).test(bound))
    .sort();

  assert.deepEqual(
    unwired,
    [],
    `adapter-first and unwired — bind it in bound-api.ts or exempt it with a reason: ${unwired.join(", ")}`,
  );
});
