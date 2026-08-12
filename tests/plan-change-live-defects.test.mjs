// Four defects `scripts/e2e-live.mjs` found in `changePlan`, pinned offline.
//
// Every one of them needed a REAL Stripe request to surface, and every one is invisible to a
// fake that accepts any params — which is exactly why they survived 350 offline tests:
//
//   1. tax was carried from the subscription ITEMS only, so a subscription that had been
//      through a schedule (which can only hold rates at the subscription level) invoiced the
//      next added line at 0%.
//   2. `pending_if_incomplete` supports no tax parameter at all, so an `invoice_now` upgrade
//      on any self-calculating account was a hard 400 rather than a charge.
//   3. the idempotency key named the TARGET, not the mutation, so upgrade → downgrade →
//      upgrade back inside 24h was refused with an idempotency error.
//   4. a schedule owns the cancellation behaviour, so `cancelPlan` after a scheduled
//      downgrade was refused outright — the one sequence a downgrade makes likely.
//
// These assert on the PARAMS SENT, because that is where each bug lived. Nothing here can
// replace the live run; it stops the fixes regressing.

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { __setPlanPricesForTests } from "../dist/plans.js";
import { cancelPlan, changePlan } from "../dist/subscription.js";

const PLANS = {
  free: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 100 }, sale: "free" },
  starter: {
    sells: { kind: "flat", price: { monthly: 1800, yearly: 18000 } },
    cap: { kind: "pool", credits: 1000 },
    sale: "self_serve",
  },
  pro: {
    sells: { kind: "flat", price: { monthly: 9000, yearly: 90000 } },
    cap: { kind: "pool", credits: 5000 },
    sale: "self_serve",
  },
};

const PERIOD_END = Math.floor(Date.parse("2026-09-17T00:00:00.000Z") / 1000);

const adapter = {
  async getBillingCustomerId() {
    return "cus_1";
  },
  async validateApiKey() {
    return { orgId: "org_1" };
  },
};

/**
 * A subscription whose tax rates sit where the caller says, and a recorder for every
 * `subscriptions.update` and its idempotency key.
 *
 * `itemRates` is where Checkout writes them; `defaultRates` is the only place a subscription
 * SCHEDULE can. The distinction is the whole of defect 1.
 */
function fakeStripe({
  itemRates = [],
  defaultRates = [],
  currentPlan = "starter",
  currentPrice = "price_starter",
  itemId = "si_1",
  schedule = null,
  pendingUpdate = null,
  cancelAtPeriodEnd = false,
} = {}) {
  const updates = [];
  const released = [];
  const scheduleUpdates = [];
  return {
    updates,
    released,
    scheduleUpdates,
    subscriptions: {
      async *list() {
        yield {
          id: "sub_1",
          status: "active",
          metadata: { plan: currentPlan },
          schedule,
          cancel_at_period_end: cancelAtPeriodEnd,
          default_tax_rates: defaultRates.map((id) => ({ id })),
          items: {
            data: [
              {
                id: itemId,
                quantity: 1,
                price: { id: currentPrice },
                tax_rates: itemRates.map((id) => ({ id })),
                current_period_end: PERIOD_END,
              },
            ],
          },
        };
      },
      async update(id, params, options) {
        updates.push({ params, idempotencyKey: options?.idempotencyKey ?? null });
        return {
          id,
          status: "active",
          metadata: params.metadata ?? {},
          // A declined `invoice_now` upgrade comes back like this: active, items UNCHANGED,
          // `pending_update` set, and an open invoice.
          ...(pendingUpdate ? { pending_update: pendingUpdate, latest_invoice: "in_pending" } : {}),
          items: {
            data: [
              {
                id: itemId,
                quantity: 1,
                price: { id: pendingUpdate ? currentPrice : "price_pro" },
                current_period_end: PERIOD_END,
              },
            ],
          },
        };
      },
    },
    subscriptionSchedules: {
      async release(id) {
        released.push(id);
        return { id, status: "released" };
      },
      async retrieve(id) {
        return {
          id,
          phases: [{ start_date: 1, end_date: PERIOD_END, items: [{ price: currentPrice, quantity: 1 }] }],
        };
      },
      async create() {
        return {
          id: "sub_sched_new",
          phases: [{ start_date: 1, end_date: PERIOD_END, items: [{ price: currentPrice, quantity: 1 }] }],
        };
      },
      async update(id, params) {
        scheduleUpdates.push({ id, params });
        return { id, ...params };
      },
    },
    prices: {
      async *list() {},
    },
  };
}

beforeEach(() => {
  __setPlanPricesForTests(
    new Map([
      ["starter_monthly", "price_starter"],
      ["pro_monthly", "price_pro"],
    ]),
  );
});

const upgrade = (stripe, opts = {}) => {
  __setStripeForTests(stripe);
  return changePlan(adapter, "org_1", {
    plans: PLANS,
    to: { plan: "pro", interval: "monthly" },
    currency: "eur",
    record: false,
    ...opts,
  });
};

// ── 1. tax carried from BOTH places ──────────────────────────────────────────

test("an added line carries the rates the subscription ITEMS hold", async () => {
  const stripe = fakeStripe({ itemRates: ["txr_it22"] });
  await upgrade(stripe);

  const added = stripe.updates[0].params.items.find((i) => i.price === "price_pro");
  assert.deepEqual(added.tax_rates, ["txr_it22"]);
});

test("and the rates only the SUBSCRIPTION holds, which a released schedule leaves behind", async () => {
  // The defect: a schedule can carry tax only at the subscription level, so after a
  // scheduled downgrade released, the items were bare and the next upgrade's added line went
  // out untaxed — on any subscription that had ever been downgraded.
  const stripe = fakeStripe({ itemRates: [], defaultRates: ["txr_it22"] });
  await upgrade(stripe);

  const added = stripe.updates[0].params.items.find((i) => i.price === "price_pro");
  assert.deepEqual(added.tax_rates, ["txr_it22"], "a bare item must not mean an untaxed line");
});

test("an explicit taxRates argument still wins over both", async () => {
  const stripe = fakeStripe({ itemRates: ["txr_old"], defaultRates: ["txr_older"] });
  await upgrade(stripe, { taxRates: ["txr_chosen"] });

  const added = stripe.updates[0].params.items.find((i) => i.price === "price_pro");
  assert.deepEqual(added.tax_rates, ["txr_chosen"]);
});

// ── 2. the pending-update param set ──────────────────────────────────────────

test("invoice_now sends NO tax parameter, because pending updates support none", async () => {
  // Measured against Stripe: both `items[].tax_rates` and `default_tax_rates` are refused
  // with a 400 when `payment_behavior: pending_if_incomplete` is set. Passing either meant an
  // `invoice_now` upgrade could not run at all on a self-calculating account.
  const stripe = fakeStripe({ itemRates: ["txr_it22"] });
  await upgrade(stripe, { proration: "invoice_now" });

  const gated = stripe.updates.at(-1).params;
  assert.equal(gated.payment_behavior, "pending_if_incomplete");
  assert.equal(gated.default_tax_rates, undefined, "not supported alongside a pending update");
  for (const item of gated.items) {
    assert.equal(item.tax_rates, undefined, "not supported either — Stripe 400s, it does not ignore");
  }
});

test("so the rates are set FIRST, in a separate update that raises no invoice", async () => {
  const stripe = fakeStripe({ itemRates: ["txr_it22"] });
  await upgrade(stripe, { proration: "invoice_now" });

  assert.equal(stripe.updates.length, 2, "one tax-config update, then the gated item change");
  const [tax, gated] = stripe.updates;
  // Tax is a configuration change: Stripe applies it immediately and it generates no
  // invoice, so moving it out of the gated update costs nothing and keeps the protection
  // `pending_if_incomplete` exists for.
  assert.deepEqual(tax.params, { default_tax_rates: ["txr_it22"] });
  assert.equal(tax.params.items, undefined, "no items, so no proration and no invoice");
  assert.equal(gated.params.payment_behavior, "pending_if_incomplete");
});

test("and not at all when the subscription already carries them", async () => {
  const stripe = fakeStripe({ defaultRates: ["txr_it22"] });
  await upgrade(stripe, { proration: "invoice_now" });

  assert.equal(stripe.updates.length, 1, "nothing to change, so no extra request");
});

test("the deferred default needs none of that", async () => {
  const stripe = fakeStripe({ itemRates: ["txr_it22"] });
  await upgrade(stripe);

  assert.equal(stripe.updates.length, 1);
  assert.equal(stripe.updates[0].params.payment_behavior, undefined);
});

// ── 3. the idempotency key names the mutation ────────────────────────────────

test("a repeated identical change reuses the key, so a double-click dedupes", async () => {
  const a = fakeStripe({ itemRates: ["txr_it22"] });
  const b = fakeStripe({ itemRates: ["txr_it22"] });
  await upgrade(a);
  await upgrade(b);

  assert.equal(a.updates[0].idempotencyKey, b.updates[0].idempotencyKey);
});

test("but the same target from a different item set gets a different key", async () => {
  // The defect: upgrade → downgrade → upgrade back returns to the same prices and
  // quantities, while the request does not — a released schedule replaces the items, so the
  // diff deletes a different `si_…`. Stripe answered the reused key with a 400 naming a key
  // the caller had never seen.
  const first = fakeStripe({ itemRates: ["txr_it22"], itemId: "si_before" });
  const afterSchedule = fakeStripe({ itemRates: ["txr_it22"], itemId: "si_after_release" });
  await upgrade(first);
  await upgrade(afterSchedule);

  assert.notEqual(first.updates[0].idempotencyKey, afterSchedule.updates[0].idempotencyKey);
});

test("and a tax change alone is a different request too", async () => {
  const a = fakeStripe({ itemRates: ["txr_it22"] });
  const b = fakeStripe({ itemRates: ["txr_gb20"] });
  await upgrade(a);
  await upgrade(b);

  assert.notEqual(a.updates[0].idempotencyKey, b.updates[0].idempotencyKey);
});

test("the key stays inside Stripe's 255-character limit", async () => {
  const stripe = fakeStripe({ itemRates: ["txr_it22", "txr_gb20", "txr_de19"] });
  await upgrade(stripe);

  assert.ok(stripe.updates[0].idempotencyKey.length <= 255, stripe.updates[0].idempotencyKey.length);
});

test("resuming a pending cancellation UNFILES pendingPlan", async () => {
  // The cancelling branch records { pendingPlan } so a UI can say what is
  // scheduled. Calling the cancellation off (changePlan back to the same plan)
  // unset cancel_at_period_end on Stripe and left the record behind — measured
  // in a browser: every surface kept reporting the scheduled downgrade of a
  // subscription Stripe said was healthy, with nothing left that could clear it.
  const written = [];
  const recording = {
    ...adapter,
    async setSubscription(orgId, patch) {
      written.push(patch);
    },
    async setOrgMetadata(orgId, patch) {
      written.push(patch);
    },
  };
  const stripe = fakeStripe({ currentPlan: "pro", cancelAtPeriodEnd: true });
  __setStripeForTests(stripe);
  const res = await changePlan(recording, "org_1", {
    plans: PLANS,
    to: { plan: "pro", interval: "monthly" },
    currency: "eur",
    record: true,
  });

  assert.equal(res.kind, "resumed");
  assert.equal(stripe.updates[0].params.cancel_at_period_end, false);
  assert.deepEqual(
    written.find((p) => "pendingPlan" in p),
    { pendingPlan: null, pendingPlanAt: null },
    "the record the cancel filed is cleared by the resume",
  );
});

// ── 4. cancelling a scheduled subscription ───────────────────────────────────

test("cancelling releases an attached schedule first", async () => {
  // A schedule OWNS the cancellation behaviour: Stripe refuses `cancel_at_period_end`
  // outright while one is attached, so a customer who had scheduled a downgrade could not
  // cancel at all.
  const stripe = fakeStripe({ currentPlan: "pro", schedule: "sub_sched_1" });
  __setStripeForTests(stripe);
  const res = await cancelPlan(adapter, "org_1", { plans: PLANS, currency: "eur", record: false });

  assert.deepEqual(stripe.released, ["sub_sched_1"], "released before the cancel is written");
  assert.equal(stripe.updates.at(-1).params.cancel_at_period_end, true);
  assert.equal(res.kind, "canceling");
});

test("an expanded schedule object is released by its id, not stringified", async () => {
  const stripe = fakeStripe({ currentPlan: "pro", schedule: { id: "sub_sched_2" } });
  __setStripeForTests(stripe);
  await cancelPlan(adapter, "org_1", { plans: PLANS, currency: "eur", record: false });

  assert.deepEqual(stripe.released, ["sub_sched_2"]);
});

test("and nothing is released when no schedule is attached", async () => {
  const stripe = fakeStripe({ currentPlan: "pro", schedule: null });
  __setStripeForTests(stripe);
  await cancelPlan(adapter, "org_1", { plans: PLANS, currency: "eur", record: false });

  assert.deepEqual(stripe.released, []);
  assert.equal(stripe.updates.at(-1).params.cancel_at_period_end, true);
});

// ── 5. an immediate change must release a pending schedule ───────────────────

test("an immediate change releases a schedule, or the schedule wins later", async () => {
  // The defect: a customer downgraded, changed their mind, PAID to go back up, and was
  // dropped to the lower tier at the period end — the pending phase replaced the items they
  // had just bought. Measured live: the renewal billed €18 Starter after an upgrade to Pro.
  const stripe = fakeStripe({ currentPlan: "starter", schedule: "sub_sched_9" });
  await upgrade(stripe);

  assert.deepEqual(stripe.released, ["sub_sched_9"], "released before the items are updated");
});

test("but a SCHEDULED change keeps its schedule, which is what carries it", async () => {
  // Downgrading to a lower rank with the default timing takes the period-end path, which
  // needs the schedule. Releasing there would delete the mechanism.
  const stripe = fakeStripe({ currentPlan: "pro", currentPrice: "price_pro", schedule: "sub_sched_9" });
  __setStripeForTests(stripe);
  const res = await changePlan(adapter, "org_1", {
    plans: PLANS,
    to: { plan: "starter", interval: "monthly" },
    currency: "eur",
    record: false,
  });

  assert.equal(res.kind, "scheduled");
  assert.deepEqual(stripe.released, [], "the schedule is the mechanism here, not litter");
});

// ── 6. a held change is not an applied change ────────────────────────────────

test("a pending update is reported as pending, not as updated", async () => {
  // Stripe answers a declined `invoice_now` upgrade with `status: "active"`, the items
  // UNCHANGED, and `pending_update` set. Reporting that as `updated` told a UI to show the new
  // tier to a customer whose card had been declined.
  const stripe = fakeStripe({ currentPlan: "starter", pendingUpdate: { expires_at: 1_800_000_000 } });
  const res = await upgrade(stripe, { proration: "invoice_now" });

  assert.equal(res.kind, "pending");
  assert.equal(res.plan, "starter", "the plan in force is still the old one");
  assert.equal(res.pendingUntil, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(res.invoiceId, "in_pending");
});

test("and it does NOT record the unpaid plan on the org", async () => {
  // The worst of it: the mirror granted the tier, so the meter resolved the new plan's pool
  // and every entitlement check passed for an upgrade nobody had paid for.
  const written = [];
  const recording = {
    ...adapter,
    async setSubscription(orgId, patch) {
      written.push(patch);
    },
    async setOrgMetadata(orgId, patch) {
      written.push(patch);
    },
  };
  const stripe = fakeStripe({ currentPlan: "starter", pendingUpdate: { expires_at: 1_800_000_000 } });
  __setStripeForTests(stripe);
  await changePlan(recording, "org_1", {
    plans: PLANS,
    to: { plan: "pro", interval: "monthly" },
    currency: "eur",
    proration: "invoice_now",
    record: true,
  });

  assert.equal(
    written.some((p) => p.plan === "pro"),
    false,
    "no setSubscription({ plan: 'pro' }) — that is the unpaid entitlement",
  );
  assert.deepEqual(
    written.find((p) => "pendingPlan" in p),
    { pendingPlan: "pro", pendingPlanAt: new Date(1_800_000_000 * 1000).toISOString() },
    "filed as pending instead, like a scheduled downgrade",
  );
});

test("a paid change still records normally", async () => {
  const written = [];
  const recording = {
    ...adapter,
    async setSubscription(orgId, patch) {
      written.push(patch);
    },
    async setOrgMetadata() {},
  };
  const stripe = fakeStripe({ currentPlan: "starter" });
  __setStripeForTests(stripe);
  const res = await changePlan(recording, "org_1", {
    plans: PLANS,
    to: { plan: "pro", interval: "monthly" },
    currency: "eur",
    proration: "invoice_now",
    record: true,
  });

  assert.equal(res.kind, "updated");
  assert.equal(written[0].plan, "pro");
});

// ── 7. a double-clicked Confirm ──────────────────────────────────────────────

test("a concurrent duplicate is retried, not surfaced as an idempotency error", async () => {
  // An idempotency key dedupes a SEQUENTIAL repeat. Two requests carrying it at once make
  // Stripe reject the second outright, and the caller saw "There is currently another
  // in-progress request using this Idempotent Key" — which is what a double-clicked button
  // sends. The loser waits and re-sends; the key then replays the winner's response.
  let attempts = 0;
  const stripe = fakeStripe({ currentPlan: "starter" });
  const realUpdate = stripe.subscriptions.update;
  stripe.subscriptions.update = async (id, params, options) => {
    if (++attempts === 1) {
      throw Object.assign(
        new Error(
          "There is currently another in-progress request using this Idempotent Key (that probably means you submitted twice, and the other request is still going through): plan:sub_1",
        ),
        { type: "idempotency_error" },
      );
    }
    return realUpdate.call(stripe.subscriptions, id, params, options);
  };

  const res = await upgrade(stripe);
  assert.equal(attempts, 2, "retried once");
  assert.equal(res.kind, "updated");
});

test("an idempotency key reused with DIFFERENT params is not retried away", async () => {
  // Retrying that one would burn the attempts and hide a real bug: the key must name the
  // mutation, and if it does not, the caller has to hear about it.
  let attempts = 0;
  const stripe = fakeStripe({ currentPlan: "starter" });
  stripe.subscriptions.update = async () => {
    attempts++;
    throw Object.assign(
      new Error("Keys for idempotent requests can only be used with the same parameters they were first used with."),
      { type: "idempotency_error" },
    );
  };

  await assert.rejects(() => upgrade(stripe), /same parameters/);
  assert.equal(attempts, 1, "surfaced on the first try");
});
