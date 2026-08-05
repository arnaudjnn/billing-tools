// One customer, one clock, one subscription, parked wherever a scenario needs it.
//
// WHY EACH SCENARIO GETS ITS OWN. The first pass at this shared a single customer and clock
// across every case, and it was wrong twice over: a test clock cannot be wound BACKWARDS, so
// the second scenario could not start mid-cycle once the first had advanced past a boundary;
// and a subscription left live by one case makes `changePlan` refuse the next with "2 live
// subscriptions" — correctly, since picking one would move the wrong plan. Sharing state also
// means a failure in case 3 can be caused by case 1, which is the property a matrix exists to
// avoid.
//
// The cost is real (one clock + one customer per case, a few seconds each) and worth it: each
// row is then an independent measurement of one thing a customer can do.

import { advanceClock, defer, ignoreMissing } from "./harness.mjs";
import { attachTestCard, createClockCustomer } from "./scratch-stripe.mjs";

/**
 * A customer sitting `at` through their paid period, on `plan`.
 *
 * @param at  0 = the moment they subscribed, 0.5 = halfway, 1 = the boundary.
 * @param card `"ok"` (a payable Visa) or `"fail"` (attaches, then declines every charge —
 *             which is the only way to exercise `pending_if_incomplete`).
 */
export async function midCycle(
  ctx,
  { plan, priceKey, seats = 1, items: itemSpec, at = 0.5, card = "ok", taxRates = [], label = "scenario" },
) {
  const { stripe, adapter, orgId, prices } = ctx;

  const { clockId, customerId } = await createClockCustomer(stripe, { orgId, name: label });
  await attachTestCard(stripe, customerId, { card });
  const previous = await adapter.getBillingCustomerId(orgId);
  await adapter.setBillingCustomerId(orgId, customerId);
  // Restored at teardown rather than at the end of the scenario, so a THROWN scenario cannot
  // leave the org pointing at a customer that is about to be deleted.
  defer(`billing pointer → ${previous ?? "none"}`, async () => {
    if (previous) await adapter.setBillingCustomerId(orgId, previous);
  });

  // `items` for a basket the customer already holds — needed to change ONE thing. Removing a
  // seat from a single-item subscription looked like a €32.94 CHARGE until this existed,
  // because the only way to express it also added a €90 seat type: two changes, one number,
  // and the library was blamed for the fixture.
  const wanted = itemSpec ?? [{ priceKey, quantity: seats }];
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: wanted.map((i) => ({
      price: prices.get(i.priceKey),
      quantity: i.quantity,
      ...(taxRates.length ? { tax_rates: taxRates } : {}),
    })),
    metadata: { org_id: orgId, plan },
    proration_behavior: "none",
  });
  defer(`subscription ${sub.id}`, () => stripe.subscriptions.cancel(sub.id).catch(ignoreMissing));

  // The org's MIRROR has to match the subscription this scenario just created, because the
  // scenarios share one org: without this, `api.plan(orgId)` still reported whatever the
  // previous case moved it to, and an assertion about the mirror measured the wrong scenario.
  await adapter.setSubscription?.(orgId, {
    plan,
    status: sub.status,
    subscriptionId: sub.id,
    periodEnd: new Date(sub.items.data[0].current_period_end * 1000).toISOString(),
  });
  await adapter.setOrgMetadata?.(orgId, { pendingPlan: null, pendingPlanAt: null });

  const item = sub.items.data[0];
  const start = item.current_period_start;
  const end = item.current_period_end;
  if (at > 0) await advanceClock(stripe, clockId, start + Math.floor((end - start) * at));

  return {
    customerId,
    clockId,
    subscriptionId: sub.id,
    periodStart: start,
    periodEnd: end,
    /** Invoices newest-first, lines expanded — what the customer would be looking at. */
    invoices: async (limit = 5) =>
      (await stripe.invoices.list({ customer: customerId, limit, expand: ["data.lines"] })).data,
    newest: async () =>
      (await stripe.invoices.list({ customer: customerId, limit: 1, expand: ["data.lines"] })).data[0],
    count: async () => (await stripe.invoices.list({ customer: customerId, limit: 100 })).data.length,
    /** The upcoming invoice, which is where a DEFERRED change has to show up. */
    upcoming: async () =>
      stripe.invoices.createPreview({ customer: customerId, subscription: sub.id, expand: ["lines"] }),
    live: () => stripe.subscriptions.retrieve(sub.id),
    toBoundary: (offset = 3600) => advanceClock(stripe, clockId, end + offset),
  };
}

/** Every line, formatted for a `note()` — the transcript is the evidence, so print it. */
export function lines(invoice, eur) {
  return (invoice?.lines?.data ?? []).map((l) => `${eur(l.amount).padStart(10)}  ${l.description}`);
}

/** Proration lines split by sign: what came back, what was charged. */
export function split(invoice) {
  const all = invoice?.lines?.data ?? [];
  return {
    all,
    credits: all.filter((l) => l.amount < 0),
    charges: all.filter((l) => l.amount > 0),
    net: all.reduce((sum, l) => sum + l.amount, 0),
  };
}
