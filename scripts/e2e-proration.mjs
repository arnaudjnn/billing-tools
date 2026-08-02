// What each proration policy ACTUALLY does to a customer's bill, measured.
//
// The question this answers: a customer pays €18 for Pro on the 1st and moves
// to €90 Premium on the 16th. What should they be charged, and when? Opinions
// about "fairness" are cheap; this prints the four possible answers in euros so
// the default can be chosen from evidence.
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/e2e-proration.mjs
//
// Raw Stripe against scratch products, never `ensurePlans` — that reconciles the
// WHOLE catalogue and archives anything not in the config passed to it, which is
// how a partial config once archived every real price in the test account.

import Stripe from "stripe";

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY?.startsWith("sk_test")) {
  console.error("Needs a TEST-mode STRIPE_SECRET_KEY.");
  process.exit(1);
}

const stripe = new Stripe(KEY);
const CUR = "eur";
const eur = (n) => `${n < 0 ? "-" : ""}€${Math.abs(n / 100).toFixed(2)}`;
const created = { customers: [], clocks: [], products: [] };

async function settle(clockId, to) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 90; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === "ready") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("clock stuck");
}

/** A customer on Pro, half a month into the period, with a card. */
async function halfwayThroughPro(prices, label) {
  const start = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start });
  created.clocks.push(clock.id);
  const customer = await stripe.customers.create({
    name: label,
    test_clock: clock.id,
    address: { line1: "Via Test 1", city: "Savona", postal_code: "17100", country: "IT" },
  });
  created.customers.push(customer.id);
  const card = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } });
  await stripe.paymentMethods.attach(card.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: card.id },
  });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: prices.pro, quantity: 1 }],
    metadata: { plan: "pro" },
  });
  // Halfway: the interesting case, where the unused remainder is worth exactly
  // half of what they paid.
  await settle(clock.id, start + 15 * 86400);
  return { customer, clock, sub: await stripe.subscriptions.retrieve(sub.id) };
}

/** Everything the customer is billed from here on, as one list. */
async function billed(customerId) {
  const out = [];
  for await (const inv of stripe.invoices.list({ customer: customerId, limit: 20 })) {
    out.push(inv);
  }
  return out.reverse();
}

async function report(title, { customer, sub }, mutate, prices) {
  console.log(`\n── ${title} ──`);
  const before = (await billed(customer.id)).at(-1);
  console.log(`  paid so far: ${eur(before.total)} for a month of Pro, 15 days used`);

  await mutate(sub);

  const after = await billed(customer.id);
  const raisedNow = after.filter((i) => !before || i.id !== before.id);
  if (raisedNow.length === 0) {
    console.log("  charged today: nothing");
  }
  for (const inv of raisedNow) {
    console.log(`  charged today: ${eur(inv.total)}  (${inv.billing_reason})`);
    for (const l of inv.lines.data) console.log(`      ${eur(l.amount)}  ${l.description}`);
  }

  // What the NEXT scheduled invoice will be, including anything left pending.
  const upcoming = await stripe.invoices
    .createPreview({ customer: customer.id, subscription: sub.id })
    .catch(() => null);
  if (upcoming) {
    console.log(`  next invoice: ${eur(upcoming.total)}`);
    for (const l of upcoming.lines.data) console.log(`      ${eur(l.amount)}  ${l.description}`);
  }
}

async function main() {
  const product = await stripe.products.create({ name: "proration probe" });
  created.products.push(product.id);
  const mk = (amount) =>
    stripe.prices.create({
      product: product.id,
      currency: CUR,
      unit_amount: amount,
      recurring: { interval: "month" },
      tax_behavior: "exclusive",
    });
  const prices = { pro: (await mk(1800)).id, premium: (await mk(9000)).id };
  console.log("Pro €18.00/mo · Premium €90.00/mo · change made on day 15 of 30");

  // ── Upgrade, deferred (the library's default: create_prorations) ───────────
  const a = await halfwayThroughPro(prices, "A upgrade deferred");
  await report(
    "A. UPGRADE, proration deferred to the next invoice  [changePlan default]",
    a,
    (sub) =>
      stripe.subscriptions.update(sub.id, {
        items: [
          { id: sub.items.data[0].id, deleted: true },
          { price: prices.premium, quantity: 1 },
        ],
        proration_behavior: "create_prorations",
      }),
    prices,
  );

  // ── Upgrade, billed immediately ───────────────────────────────────────────
  const b = await halfwayThroughPro(prices, "B upgrade immediate");
  await report(
    "B. UPGRADE, billed immediately  [proration: invoice_now]",
    b,
    (sub) =>
      stripe.subscriptions.update(sub.id, {
        items: [
          { id: sub.items.data[0].id, deleted: true },
          { price: prices.premium, quantity: 1 },
        ],
        proration_behavior: "always_invoice",
      }),
    prices,
  );

  // ── Downgrade at the period end (the library's default for a downgrade) ───
  const c = await halfwayThroughPro(prices, "C downgrade at period end");
  await stripe.subscriptions.update(c.sub.id, {
    items: [{ id: c.sub.items.data[0].id, price: prices.premium }],
    proration_behavior: "none",
    metadata: { plan: "premium" },
  });
  const cSub = await stripe.subscriptions.retrieve(c.sub.id);
  await report(
    "C. DOWNGRADE Premium→Pro at the period end  [changePlan default]",
    { ...c, sub: cSub },
    async (sub) => {
      const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
      const phase = schedule.phases[schedule.phases.length - 1];
      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            items: phase.items.map((i) => ({
              price: typeof i.price === "string" ? i.price : i.price.id,
              quantity: i.quantity ?? 1,
            })),
            start_date: phase.start_date,
            end_date: phase.end_date,
          },
          { items: [{ price: prices.pro, quantity: 1 }] },
        ],
      });
    },
    prices,
  );

  // ── Downgrade immediately, with a credit ──────────────────────────────────
  const d = await halfwayThroughPro(prices, "D downgrade immediate");
  await stripe.subscriptions.update(d.sub.id, {
    items: [{ id: d.sub.items.data[0].id, price: prices.premium }],
    proration_behavior: "none",
    metadata: { plan: "premium" },
  });
  const dSub = await stripe.subscriptions.retrieve(d.sub.id);
  await report(
    "D. DOWNGRADE Premium→Pro immediately  [timing: now]",
    { ...d, sub: dSub },
    (sub) =>
      stripe.subscriptions.update(sub.id, {
        items: [
          { id: sub.items.data[0].id, deleted: true },
          { price: prices.pro, quantity: 1 },
        ],
        proration_behavior: "create_prorations",
      }),
    prices,
  );
}

async function cleanup() {
  console.log("\nCleanup");
  for (const id of created.customers) await stripe.customers.del(id).catch(() => {});
  for (const id of created.clocks) await stripe.testHelpers.testClocks.del(id).catch(() => {});
  for (const id of created.products) {
    for await (const p of stripe.prices.list({ product: id, limit: 100 })) {
      await stripe.prices.update(p.id, { active: false }).catch(() => {});
    }
    await stripe.products.update(id, { active: false }).catch(() => {});
  }
  console.log(`  removed ${created.customers.length} customers, ${created.clocks.length} clocks`);
}

try {
  await main();
} catch (e) {
  console.error("\nFAILED:", e?.message ?? e);
} finally {
  await cleanup();
}
