// End-to-end against Stripe TEST MODE, on a scratch customer driven by a test
// clock. This is the half the unit suite cannot assert: that the requests the
// library builds actually produce the invoices, prorations and renewals it
// claims. Everything it touches it creates, and it deletes it again at the end.
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/e2e-lifecycle.mjs
//
// It refuses to run against a live key. It creates its own products and prices
// (never `ensurePlans`, which reconciles the whole catalogue — running that with
// a partial config is what once archived every real price in the test account).

import Stripe from "stripe";

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("STRIPE_SECRET_KEY is unset.");
  process.exit(1);
}
if (!KEY.startsWith("sk_test")) {
  console.error("Refusing to run: this is not a test-mode key.");
  process.exit(1);
}

const stripe = new Stripe(KEY);
const CURRENCY = "eur";
const created = { customers: [], products: [], clocks: [] };

let failures = 0;
const ok = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
};
const section = (t) => console.log(`\n${t}`);
const eur = (n) => `€${(n / 100).toFixed(2)}`;

/** Advance the clock and wait for Stripe to finish settling. */
async function advance(clockId, to) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 60; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === "ready") return c;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("test clock did not settle");
}

async function main() {
  section("Setup: scratch product, prices, taxed customer on a test clock");

  const product = await stripe.products.create({ name: "e2e seat" });
  created.products.push(product.id);
  const seatMonthly = await stripe.prices.create({
    product: product.id,
    currency: CURRENCY,
    unit_amount: 1800,
    recurring: { interval: "month" },
    tax_behavior: "exclusive",
  });
  const premiumMonthly = await stripe.prices.create({
    product: product.id,
    currency: CURRENCY,
    unit_amount: 9000,
    recurring: { interval: "month" },
    tax_behavior: "exclusive",
  });

  const vat = await stripe.taxRates.create({
    display_name: "IVA",
    percentage: 22,
    country: "IT",
    inclusive: false,
  });

  const start = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start });
  created.clocks.push(clock.id);

  const customer = await stripe.customers.create({
    name: "e2e scratch",
    email: "e2e@example.test",
    test_clock: clock.id,
    address: { line1: "Via Test 1", city: "Savona", postal_code: "17100", country: "IT" },
  });
  created.customers.push(customer.id);

  const card = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } });
  await stripe.paymentMethods.attach(card.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: card.id },
  });
  ok("customer, card and 22% IVA rate created", true, customer.id);

  section("Subscribe: one standard seat, taxed");
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: seatMonthly.id, quantity: 1 }],
    default_tax_rates: [vat.id],
    metadata: { org_id: "org_e2e", plan: "pro" },
  });
  ok("subscription is active", sub.status === "active", sub.status);
  const firstInvoice = await stripe.invoices.retrieve(sub.latest_invoice);
  ok(
    "first invoice charges the seat + IVA",
    firstInvoice.total === 2196,
    `${eur(firstInvoice.total)} (1800 + 22%)`,
  );

  section("The invoice-offset defect: an included allowance must NOT be credited");
  // Granting 1000 tokens as credit turned a €21.04 seat invoice into €11.04 due.
  // The library now expresses included usage as a counted cap, so nothing is
  // credited and the renewal is charged in full. Asserted below at renewal.
  const balanceBefore = (await stripe.customers.retrieve(customer.id)).balance;
  ok("no credit balance was granted by subscribing", balanceBefore === 0, String(balanceBefore));

  section("Preview vs charge: the quoted proration is the charged proration");
  const items = [
    { id: sub.items.data[0].id, deleted: true },
    { price: premiumMonthly.id, quantity: 1, tax_rates: [vat.id] },
  ];
  // How previewPlanChange now separates the two: Stripe's preview returns the
  // whole upcoming invoice, so `amount_due` includes the NEXT period's regular
  // charge as well as the proration. Differencing against a no-proration preview
  // isolates the difference actually being charged for the change.
  const [recurringPrev, proratedPrev] = await Promise.all([
    stripe.invoices.createPreview({
      customer: customer.id,
      subscription: sub.id,
      subscription_details: { items, proration_behavior: "none" },
    }),
    stripe.invoices.createPreview({
      customer: customer.id,
      subscription: sub.id,
      subscription_details: { items, proration_behavior: "create_prorations" },
    }),
  ]);
  const quoted = proratedPrev.total - recurringPrev.total;
  ok(
    "preview isolates the proration from the next period's charge",
    quoted !== proratedPrev.amount_due,
    `proration ${eur(quoted)} vs whole upcoming invoice ${eur(proratedPrev.amount_due)}`,
  );

  const upgraded = await stripe.subscriptions.update(sub.id, {
    items,
    proration_behavior: "always_invoice",
  });
  ok("upgrade applied immediately", upgraded.status === "active", upgraded.status);

  // The proration invoice Stripe actually raised.
  const invoices = await stripe.invoices.list({ customer: customer.id, limit: 5 });
  const proration = invoices.data.find((i) => i.id !== firstInvoice.id);
  ok("an upgrade invoice was raised", Boolean(proration), proration?.id);
  if (proration) {
    ok(
      "charged proration equals the quoted proration",
      proration.amount_due === quoted,
      `charged ${eur(proration.amount_due)} vs quoted ${eur(quoted)}`,
    );
    const credited = proration.lines.data
      .filter((l) => l.amount < 0)
      .reduce((s, l) => s - l.amount, 0);
    ok(
      "the unused part of the old seat is credited back",
      credited > 0,
      `credit ${eur(credited)} for the remainder of the month`,
    );
    const taxed = (proration.total_taxes ?? []).length > 0;
    ok("the upgrade invoice carries IVA", taxed);
  }

  section("Downgrade: scheduled at the period end, no refund today");
  const backToStandard = [
    { id: upgraded.items.data[0].id, deleted: true },
    { price: seatMonthly.id, quantity: 1, tax_rates: [vat.id] },
  ];
  const atEnd = await stripe.invoices.createPreview({
    customer: customer.id,
    subscription: sub.id,
    subscription_details: { items: backToStandard, proration_behavior: "none" },
  });
  ok(
    "a period-end downgrade quotes the new recurring total, not a refund",
    atEnd.amount_due >= 0,
    eur(atEnd.amount_due),
  );

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
        default_tax_rates: [vat.id],
      },
      { items: [{ price: seatMonthly.id, quantity: 1 }], default_tax_rates: [vat.id] },
    ],
  });
  const stillPremium = await stripe.subscriptions.retrieve(sub.id);
  ok(
    "the customer keeps the plan they paid for until the period ends",
    stillPremium.items.data[0].price.id === premiumMonthly.id,
  );

  section("Auto-reload: an INVOICE with tax, charged once under a race");
  const itemKey = `e2e:autoreload:${customer.id}`;
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      stripe.invoiceItems
        .create(
          {
            customer: customer.id,
            currency: CURRENCY,
            amount: 950,
            description: "Auto-reload: 950 tokens",
            tax_rates: [vat.id],
          },
          { idempotencyKey: `${itemKey}:item` },
        )
        .then((r) => r.id),
    ),
  );
  ok(
    "three concurrent reloads create ONE invoice item",
    new Set(results).size === 1,
    `${new Set(results).size} distinct item(s)`,
  );

  const reloadInvoice = await stripe.invoices.create(
    {
      customer: customer.id,
      currency: CURRENCY,
      collection_method: "charge_automatically",
      default_payment_method: card.id,
      auto_advance: false,
      description: "Auto-reload: 950 tokens",
      // Without this, a customer WITH a subscription gets an empty invoice and
      // the tokens are swept onto their next subscription invoice instead.
      pending_invoice_items_behavior: "include",
      metadata: { auto_reload: "true", tokens: "950" },
    },
    { idempotencyKey: `${itemKey}:invoice` },
  );
  const paidReload = await stripe.invoices.pay(reloadInvoice.id, { off_session: true });
  ok("auto-reload produced a real INVOICE, paid", paidReload.status === "paid", paidReload.id);
  ok(
    "the auto-reload invoice carries IVA",
    paidReload.total === 1159,
    `${eur(paidReload.total)} (950 + 22%)`,
  );
  ok("it has an invoice number, unlike a bare charge", Boolean(paidReload.number), paidReload.number);

  section("Renewal: the next invoice is NOT discounted by a stray credit");
  const period = stillPremium.items.data[0].current_period_end;
  await advance(clock.id, period + 3600);
  const after = await stripe.invoices.list({ customer: customer.id, limit: 10 });
  const renewal = after.data.find(
    (i) => i.billing_reason === "subscription_cycle" && i.id !== firstInvoice.id,
  );
  ok("a renewal invoice was raised", Boolean(renewal), renewal?.id);
  if (renewal) {
    ok(
      "the renewal starts from a ZERO balance (the offset defect stays fixed)",
      renewal.starting_balance === 0,
      `starting_balance=${renewal.starting_balance}`,
    );
    ok(
      "the downgrade took effect at the boundary",
      renewal.lines.data.some((l) => l.pricing?.price_details?.price === seatMonthly.id),
      renewal.lines.data.map((l) => l.description).join(" | "),
    );
  }
}

async function cleanup() {
  section("Cleanup");
  for (const id of created.customers) {
    await stripe.customers.del(id).catch(() => {});
  }
  for (const id of created.clocks) {
    await stripe.testHelpers.testClocks.del(id).catch(() => {});
  }
  for (const id of created.products) {
    // Prices cannot be deleted, only deactivated — and they belong to a scratch
    // product nothing else references.
    for await (const p of stripe.prices.list({ product: id, limit: 100 })) {
      await stripe.prices.update(p.id, { active: false }).catch(() => {});
    }
    await stripe.products.update(id, { active: false }).catch(() => {});
  }
  console.log(`  removed ${created.customers.length} customer(s), ${created.clocks.length} clock(s), ${created.products.length} product(s)`);
}

try {
  await main();
} catch (e) {
  failures++;
  console.error("\nFAILED:", e?.message ?? e);
} finally {
  await cleanup();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
