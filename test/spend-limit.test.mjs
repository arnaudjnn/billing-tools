// The customer's OWN monthly ceiling, enforced by the meter.
//
// It is not a second gate. A spend limit funds nothing and only refuses, which is
// exactly what `state.limits` already models, so it rides the same path as every
// declared rate limit: one more `LimitState`, checked in the same loop, reported
// through the same `describeDenial`. The only thing that had to be new is the
// REASON — a rate limit is the product's and the customer must wait, while this one
// is theirs and they can raise it, and telling them to wait would be wrong.
//
// The window is the CALENDAR month even for an annual subscriber, because
// "monthly" is what the customer set.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  __setStripeForTests,
  getSpendControls,
  setSpendControls,
  spendControlsOf,
} from "../dist/billing.js";
import { resolveAllowance, fundingFor, describeDenial } from "../dist/allowance.js";

const config = { currency: "eur", baseUrl: "https://test.local", internalDomains: [] };

/** Stripe with a spend limit on the customer's metadata and nothing else. */
function fakeStripe({ limit = "", alerts = "", updates = [] } = {}) {
  return {
    updates,
    customers: {
      async retrieve() {
        return {
          deleted: false,
          balance: -1_000_000, // a wallet big enough that only the cap can refuse
          currency: "eur",
          metadata: { spend_limit_credits: limit, spend_alert_credits: alerts },
        };
      },
      async update(_id, params) {
        updates.push(params);
        return { id: _id };
      },
    },
  };
}

/** An adapter with a customer and no subscription: the plan cycle is the month. */
const adapter = {
  async getBillingCustomerId() {
    return "cus_1";
  },
  async getOrgMetadata() {
    return {};
  },
};

/** A ledger that reports a fixed month-to-date total, and records what it was asked. */
function fakeLedger(used, queries = []) {
  return {
    queries,
    async record() {},
    async total(q) {
      queries.push(q);
      return used;
    },
  };
}

test("no ceiling set → no limit, and nothing to refuse", async () => {
  __setStripeForTests(fakeStripe({ limit: "" }));
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: {},
    ledger: fakeLedger(0),
  });
  assert.equal(state.limits.length, 0);
  assert.equal(fundingFor(state, null, 10).ok, true);
});

test("under the ceiling funds from the wallet as usual", async () => {
  __setStripeForTests(fakeStripe({ limit: "20000" }));
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: {},
    ledger: fakeLedger(5_000),
  });
  const spend = state.limits.find((l) => l.kind === "spend");
  assert.equal(spend.size, 20_000);
  assert.equal(spend.used, 5_000);
  assert.equal(spend.remaining, 15_000);
  const funding = fundingFor(state, null, 100);
  assert.equal(funding.ok, true);
  assert.equal(funding.source, "wallet");
});

test("at the ceiling the meter refuses, and says the customer can raise it", async () => {
  __setStripeForTests(fakeStripe({ limit: "20000" }));
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: {},
    ledger: fakeLedger(20_000),
  });
  const funding = fundingFor(state, null, 1);
  assert.equal(funding.ok, false);
  // NOT rate_limit_reached: this one is the customer's own, and the advice differs.
  assert.equal(funding.reason, "spend_limit_reached");
  const message = describeDenial(funding.reason, state, funding.limit);
  assert.match(message, /Monthly spend limit reached/);
  assert.match(message, /Raise the limit/);
});

test("a call that would CROSS the ceiling is refused, not partly allowed", async () => {
  // 19_950 used of 20_000 with a cost of 100: remaining < cost, so it refuses
  // rather than letting the month end 50 credits over.
  __setStripeForTests(fakeStripe({ limit: "20000" }));
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: {},
    ledger: fakeLedger(19_950),
  });
  assert.equal(fundingFor(state, null, 100).reason, "spend_limit_reached");
  assert.equal(fundingFor(state, null, 50).ok, true, "exactly reaching it is allowed");
});

test("the ceiling is measured over the CALENDAR month", async () => {
  const queries = [];
  __setStripeForTests(fakeStripe({ limit: "20000" }));
  await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: {},
    ledger: fakeLedger(0, queries),
    now: Date.UTC(2026, 7, 20, 12, 0, 0), // 20 Aug 2026
  });
  const q = queries.at(-1);
  const start = new Date(q.start);
  assert.equal(start.getDate(), 1, "starts on the 1st");
  assert.equal(start.getMonth(), 7, "of the same month");
});

test("a plan limit is reported before the customer's own", async () => {
  // Both refuse. The plan's is the more useful message, because the customer
  // cannot lift that one by changing a setting.
  __setStripeForTests(fakeStripe({ limit: "20000" }));
  const plans = {
    pro: {
      sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1000, yearly: 10000 } } } },
      cap: { kind: "wallet" },
      limits: { rate: [{ every: "day", credits: 10, label: "daily" }] },
      sale: "self_serve",
    },
  };
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans,
    plan: "pro",
    ledger: fakeLedger(20_000),
  });
  assert.equal(fundingFor(state, null, 1).reason, "rate_limit_reached");
});

test("skipSpendLimit leaves the ceiling out entirely", async () => {
  // For a read that only wants plan entitlement — it must not report a limit the
  // caller did not ask about, and must not pay for the read either.
  __setStripeForTests(fakeStripe({ limit: "20000" }));
  const state = await resolveAllowance(adapter, config, {
    orgId: "org_1",
    plans: {},
    ledger: fakeLedger(999_999),
    skipSpendLimit: true,
  });
  assert.equal(
    state.limits.find((l) => l.kind === "spend"),
    undefined,
  );
});

test("controls round-trip, and a cleared limit is not a limit of zero", async () => {
  const updates = [];
  __setStripeForTests(fakeStripe({ limit: "20000", alerts: "10000,15000", updates }));
  assert.deepEqual(await getSpendControls("cus_1"), {
    limitCredits: 20_000,
    alertCredits: [10_000, 15_000],
  });

  await setSpendControls("cus_1", { limitCredits: null, alertCredits: [] });
  // "" is what CLEARS a Stripe metadata key. "0" would read back as a ceiling of
  // zero and refuse every call in the workspace.
  assert.equal(updates.at(-1).metadata.spend_limit_credits, "");
  assert.equal(updates.at(-1).metadata.spend_alert_credits, "");

  await setSpendControls("cus_1", { alertCredits: [900, 100] });
  // Ascending, and the limit is untouched because it was not passed.
  assert.equal(updates.at(-1).metadata.spend_alert_credits, "100,900");
  assert.equal("spend_limit_credits" in updates.at(-1).metadata, false);
});

test("junk metadata never blocks a workspace", () => {
  // A human editing the dashboard, or an old bad write. Anything that is not a
  // positive integer means "no ceiling", never "refuse everything".
  for (const bad of ["", "0", "-5", "abc", undefined]) {
    assert.equal(spendControlsOf({ spend_limit_credits: bad }).limitCredits, null, `bad: ${bad}`);
  }
  assert.equal(spendControlsOf(undefined).limitCredits, null);
  assert.deepEqual(spendControlsOf({ spend_alert_credits: "5, x, 1" }).alertCredits, [1, 5]);
});
