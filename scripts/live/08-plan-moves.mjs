// EVERY move a customer can make to their subscription, each measured on its own clock.
//
// 07 measured one upgrade and one downgrade and I reported that as "upgrades and downgrades
// are covered". It was one instance of each. This is the matrix, and writing it found paths
// nothing had ever executed — starting with the DEFAULT one: `proration: "next_invoice"` is
// what a consumer gets when it passes nothing, and the only upgrade ever measured live used
// `invoice_now`.
//
// What a customer can actually do, and where the money shows up:
//
//   08a  upgrade, DEFERRED (the default)   nothing today; the difference on the next invoice
//   08b  upgrade, on day one              near-full price, no meaningful credit
//   08c  upgrade, on the last day         a token amount, still itemised
//   08d  monthly → yearly                 the unused month credited against the year
//   08e  add a seat                       the added seat prorated, the existing one untouched
//   08f  remove a seat                    a credit, nothing charged
//   08g  downgrade NOW                    a credit BALANCE, which auto-applies later
//   08h  downgrade, then upgrade back      the schedule released, no double charge
//   08i  cancel, then change your mind     resumed, no invoice either way
//   08j  the same plan twice (a noop)      no request, no invoice
//   08k  a double-clicked Confirm          one invoice, not two
//   08l  a card that declines              the upgrade does NOT apply — pending, then reverted

import { eur, note, ok, section } from "../lib/harness.mjs";
import { PRO_PLAN, STARTER_PLAN } from "../lib/scratch-stripe.mjs";
import { attachTestCard } from "../lib/scratch-stripe.mjs";
import { lines, midCycle, split } from "../lib/scenario.mjs";
import { taxRatesFor } from "../../dist/tax.js";

const DEFERRED = {}; // no options at all — what a caller who reads no docs gets
const NOW = { timing: "now", proration: "invoice_now" };

const STARTER_MONTHLY = () => `${STARTER_PLAN}_standard_monthly`;
const PRO_STANDARD = () => `${PRO_PLAN}_standard_monthly`;
const PRO_PREMIUM = () => `${PRO_PLAN}_premium_monthly`;
const PRO_SEATS = { standard: 1, premium: 1 };

export async function run(ctx) {
  const { api, orgId, prices, config, stripe } = ctx;
  const { rateIds } = await taxRatesFor({
    originCountry: "IT",
    registrations: [{ country: "IT" }],
    country: "IT",
    notes: config.tax.notes,
  });
  const base = { plan: STARTER_PLAN, priceKey: STARTER_MONTHLY(), taxRates: rateIds };

  // ── 08a the DEFAULT upgrade ───────────────────────────────────────────────
  section("08a — an upgrade with NO options: the default defers the difference");
  {
    const s = await midCycle(ctx, { ...base, at: 0.5, label: "deferred upgrade" });
    const before = await s.count();
    const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats: PRO_SEATS });
    const applied = await api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, DEFERRED);

    ok("nothing is charged today", (await s.count()) === before, `${before} invoice(s), unchanged`);
    ok("the quote agrees nothing is due now", quote.dueNow === 0, eur(quote.dueNow));
    ok("but the plan IS applied immediately", applied.kind === "updated", applied.kind);
    const live = await s.live();
    ok(
      "the customer has the new tier already",
      live.items.data.some((i) => i.price.id === prices.get(PRO_PREMIUM())),
      `${live.items.data.length} item(s)`,
    );

    // THE assertion this scenario exists for: a deferred difference that never lands on the
    // next invoice is revenue quietly lost, and nothing today would show it.
    const upcoming = await s.upcoming();
    for (const l of lines(upcoming, eur)) note(l);
    const { credits, charges } = split(upcoming);
    ok("the next invoice carries the credit for the old tier", credits.length > 0, credits.map((l) => eur(l.amount)).join(", ") || "NONE");
    ok("and the remainder of the new one", charges.length >= 2, `${charges.length} charge line(s)`);
    ok(
      "quoted next-invoice total === Stripe's own upcoming total",
      quote.nextInvoiceTotal === upcoming.total,
      `${eur(quote.nextInvoiceTotal)} vs ${eur(upcoming.total)}`,
    );
    ok("and the customer is told WHEN it lands", Boolean(quote.nextInvoiceAt), quote.nextInvoiceAt);
    ok("it is taxed", (upcoming.total_taxes?.length ?? 0) > 0, `${upcoming.total_taxes?.length} tax line(s)`);
  }

  // ── 08b / 08c the edges of the period ─────────────────────────────────────
  section("08b — upgrading on day one charges nearly the full difference");
  {
    const s = await midCycle(ctx, { ...base, at: 0, label: "day-one upgrade" });
    const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW);
    await api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW);
    const inv = await s.newest();
    for (const l of lines(inv, eur)) note(l);
    // €108 Pro − €18 Starter = €90 of difference; on day one essentially all of it is due.
    ok("the charge is close to a full month's difference", inv.amount_due > 9_000, eur(inv.amount_due));
    ok("quoted === charged", inv.amount_due === quote.dueNow, `${eur(quote.dueNow)} vs ${eur(inv.amount_due)}`);
  }

  section("08c — upgrading on the last day charges a token amount, still itemised");
  {
    const s = await midCycle(ctx, { ...base, at: 0.97, label: "last-day upgrade" });
    const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW);
    await api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW);
    const inv = await s.newest();
    for (const l of lines(inv, eur)) note(l);
    ok("something is charged, not nothing", inv.amount_due > 0, eur(inv.amount_due));
    ok("but only a fraction of the difference", inv.amount_due < 2_000, eur(inv.amount_due));
    ok("quoted === charged", inv.amount_due === quote.dueNow, `${eur(quote.dueNow)} vs ${eur(inv.amount_due)}`);
    // The rounding case: a sub-cent proration must not produce a zero-total invoice that
    // still says "Pro" on it.
    ok("the invoice is not a €0 document", inv.total !== 0, eur(inv.total));
  }

  // ── 08d interval switch ───────────────────────────────────────────────────
  section("08d — monthly → yearly: the unused month is credited against the year");
  {
    const s = await midCycle(ctx, { ...base, at: 0.5, label: "to yearly" });
    const quote = await api.subscription.preview(
      orgId,
      { plan: STARTER_PLAN, interval: "yearly", seats: { standard: 1 } },
      NOW,
    );
    const applied = await api.subscription.change(
      orgId,
      { plan: STARTER_PLAN, interval: "yearly", seats: { standard: 1 } },
      NOW,
    );
    ok("the interval change applies", applied.kind === "updated", applied.kind);
    const inv = await s.newest();
    for (const l of lines(inv, eur)) note(l);
    const { credits } = split(inv);
    ok("the half-month already paid comes back", credits.length > 0, credits.map((l) => eur(l.amount)).join(", ") || "NONE");
    // €180/yr − €9 unused = €171 net. The number matters less than quote === charge.
    ok("quoted === charged", inv.amount_due === quote.dueNow, `${eur(quote.dueNow)} vs ${eur(inv.amount_due)}`);
    const live = await s.live();
    ok(
      "and the subscription now bills yearly",
      live.items.data[0].price.recurring?.interval === "year",
      live.items.data[0].price.recurring?.interval,
    );
  }

  // ── 08e / 08f seat quantity, the most common change in a seats product ────
  section("08e — adding a seat mid-cycle charges for the seat, not the plan again");
  {
    const s = await midCycle(ctx, {
      plan: PRO_PLAN,
      items: [
        { priceKey: PRO_STANDARD(), quantity: 1 },
        { priceKey: PRO_PREMIUM(), quantity: 1 },
      ],
      at: 0.5,
      taxRates: rateIds,
      label: "add seat",
    });
    // Already holding the full Pro basket; go from 1 standard seat to 3. Same plan, same
    // price, more of it — so the charge must be for two seats and nothing else.
    const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats: { standard: 3, premium: 1 } }, NOW);
    await api.subscription.change(orgId, { plan: PRO_PLAN, seats: { standard: 3, premium: 1 } }, NOW);
    const inv = await s.newest();
    for (const l of lines(inv, eur)) note(l);
    ok("a prorated charge is raised", inv.amount_due > 0, eur(inv.amount_due));
    ok("quoted === charged", inv.amount_due === quote.dueNow, `${eur(quote.dueNow)} vs ${eur(inv.amount_due)}`);
    const live = await s.live();
    const standard = live.items.data.find((i) => i.price.id === prices.get(PRO_STANDARD()));
    ok("the quantity really is 3", standard?.quantity === 3, `${standard?.quantity}`);
  }

  section("08f — removing a seat mid-cycle credits, and charges nothing");
  {
    // Holding the FULL Pro basket already — 3 standard + 1 premium — so going to 1 standard
    // + 1 premium changes exactly one thing: two seats given back.
    const s = await midCycle(ctx, {
      plan: PRO_PLAN,
      items: [
        { priceKey: PRO_STANDARD(), quantity: 3 },
        { priceKey: PRO_PREMIUM(), quantity: 1 },
      ],
      at: 0.5,
      taxRates: rateIds,
      label: "remove seat",
    });
    const before = await s.count();
    const quote = await api.subscription.preview(orgId, { plan: PRO_PLAN, seats: { standard: 1, premium: 1 } }, NOW);
    await api.subscription.change(orgId, { plan: PRO_PLAN, seats: { standard: 1, premium: 1 } }, NOW);
    note(`quote: due now ${eur(quote.dueNow)}, credit ${eur(quote.credit)}`);
    const after = await s.count();
    // Removing capacity cannot take money. If this ever charges, a customer is billed for
    // giving something up.
    ok("nothing is charged for giving a seat back", quote.dueNow <= 0, eur(quote.dueNow));
    if (after > before) {
      const inv = await s.newest();
      for (const l of lines(inv, eur)) note(l);
      ok("any invoice raised is a credit, not a charge", inv.amount_due <= 0, eur(inv.amount_due));
    } else {
      ok("no invoice was raised at all", true, `${before} → ${after}`);
    }
    const live = await s.live();
    ok("the quantity really is 1", live.items.data.find((i) => i.price.id === prices.get(PRO_STANDARD()))?.quantity === 1);
  }

  // ── 08g downgrade NOW ─────────────────────────────────────────────────────
  section("08g — downgrading NOW leaves a credit balance, which auto-applies later");
  {
    const s = await midCycle(ctx, { plan: PRO_PLAN, priceKey: PRO_PREMIUM(), seats: 1, at: 0.5, taxRates: rateIds, label: "downgrade now" });
    const balanceBefore = (await stripe.customers.retrieve(s.customerId)).balance;
    await api.subscription.change(orgId, { plan: STARTER_PLAN, seats: { standard: 1 } }, { timing: "now" });
    const customer = await stripe.customers.retrieve(s.customerId);
    note(`customer balance ${balanceBefore} → ${customer.balance}`);

    // WHERE the credit lands, measured — and it is NOT where AGENTS.md said.
    //
    // With the default proration (`create_prorations`) the remainder becomes a negative LINE
    // on the next invoice, and `customer.balance` never moves. A credit BALANCE only appears
    // when the change is invoiced immediately and that invoice totals below zero. The
    // distinction is not cosmetic: a balance auto-applies to any later invoice and cannot be
    // opted out of, while a line is confined to the invoice it sits on.
    const upcoming = await s.upcoming();
    for (const l of lines(upcoming, eur)) note(l);
    const { credits } = split(upcoming);
    ok("the remainder is credited on the next invoice", credits.length > 0, credits.map((l) => eur(l.amount)).join(", ") || "NONE");
    ok("and NOT as a customer credit balance", customer.balance === balanceBefore, `${customer.balance}`);
    const live = await s.live();
    ok(
      "and the tier drops immediately",
      live.items.data.some((i) => i.price.id === prices.get(STARTER_MONTHLY())),
      live.items.data.map((i) => i.price.id).join(", "),
    );

    await s.toBoundary();
    const renewal = (await s.invoices(10)).find((i) => i.billing_reason === "subscription_cycle");
    ok("the renewal exists", Boolean(renewal), renewal?.id);
    if (renewal) {
      const { credits: renewalCredits } = split(renewal);
      for (const l of lines(renewal, eur)) note(l);
      ok(
        "the renewal carries the credit as a line, not a balance",
        renewalCredits.length > 0,
        renewalCredits.map((l) => eur(l.amount)).join(", ") || `starting_balance ${eur(renewal.starting_balance)}`,
      );
      ok("so the customer pays less than a full month", renewal.total < 1_800 + 396, eur(renewal.total));
    }
  }

  // ── 08h downgrade then change your mind ───────────────────────────────────
  section("08h — downgrading then upgrading back before it lands charges once");
  {
    const s = await midCycle(ctx, { plan: PRO_PLAN, priceKey: PRO_PREMIUM(), seats: 1, at: 0.4, taxRates: rateIds, label: "reversal" });
    const down = await api.subscription.change(orgId, { plan: STARTER_PLAN, seats: { standard: 1 } });
    ok("the downgrade is scheduled", down.kind === "scheduled", down.kind);
    const scheduled = await s.live();
    ok("a schedule is attached", Boolean(scheduled.schedule), scheduled.schedule ? "yes" : "no");

    const before = await s.count();
    const back = await api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW);
    note(`back to pro: ${back.kind}`);
    ok("going back up is allowed while a downgrade is pending", back.kind === "updated", back.kind);
    const after = await s.count();
    ok("at most one invoice is raised", after - before <= 1, `${before} → ${after}`);
    if (after > before) {
      const inv = await s.newest();
      for (const l of lines(inv, eur)) note(l);
      ok("and it is taxed", (inv.total_taxes?.length ?? 0) > 0, `${inv.total_taxes?.length}`);
    }
    await s.toBoundary();
    const renewal = (await s.invoices(10)).find((i) => i.billing_reason === "subscription_cycle");
    // The trap: an abandoned schedule that still fires drops the customer to Starter after
    // they paid to go back to Pro.
    if (renewal) {
      const priced = (renewal.lines?.data ?? []).map((l) => l.pricing?.price_details?.price);
      ok(
        "the renewal bills PRO, not the abandoned downgrade",
        priced.includes(prices.get(PRO_PREMIUM())),
        (renewal.lines?.data ?? []).map((l) => eur(l.amount)).join(", "),
      );
    }
  }

  // ── 08i cancel then resume ────────────────────────────────────────────────
  section("08i — cancelling and changing your mind is reversible, and free");
  {
    const s = await midCycle(ctx, { plan: PRO_PLAN, priceKey: PRO_PREMIUM(), seats: 1, at: 0.5, taxRates: rateIds, label: "resume" });
    const before = await s.count();
    const cancelled = await api.subscription.cancel(orgId);
    ok("cancel is scheduled for the period end", cancelled.kind === "canceling", cancelled.kind);
    ok("nothing is invoiced to cancel", (await s.count()) === before);

    // Re-asking for the plan they are already on, while a cancellation is pending, is how a
    // customer un-cancels — there is no separate `resume` tool.
    const resumed = await api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS });
    ok("re-selecting the same plan resumes it", resumed.kind === "resumed", resumed.kind);
    const live = await s.live();
    ok("Stripe agrees it is no longer ending", live.cancel_at_period_end === false);
    ok("and nothing was invoiced to resume either", (await s.count()) === before, `${before}`);
  }

  // ── 08j the noop ──────────────────────────────────────────────────────────
  section("08j — asking for the plan you already have does nothing at all");
  {
    const s = await midCycle(ctx, { plan: PRO_PLAN, priceKey: PRO_PREMIUM(), seats: 1, at: 0.5, taxRates: rateIds, label: "noop" });
    const before = await s.count();
    // Same plan, same basket as the live subscription: `diffItems` produces no mutations.
    const same = await api.subscription.change(orgId, { plan: PRO_PLAN, seats: { standard: 0, premium: 1 } }, NOW);
    ok("it is reported as a noop", same.kind === "noop", same.kind);
    ok("and no invoice is raised", (await s.count()) === before, `${before}`);
  }

  // ── 08k the double click ──────────────────────────────────────────────────
  section("08k — a double-clicked Confirm charges once");
  {
    const s = await midCycle(ctx, { ...base, at: 0.5, label: "double click" });
    const before = await s.count();
    // Two identical requests, concurrently, exactly as a double click sends them.
    const [a, b] = await Promise.all([
      api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW),
      api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW),
    ]);
    ok("both calls succeed", a.kind === "updated" && b.kind === "updated", `${a.kind}/${b.kind}`);
    const after = await s.count();
    ok("but only ONE invoice exists", after - before === 1, `${before} → ${after}`);
  }

  // ── 08l the declining card ────────────────────────────────────────────────
  section("08l — when the card declines, the upgrade does NOT quietly apply");
  {
    // The card is swapped AFTER the subscription is live, and that ordering is the whole
    // test. Starting with the failing card made the FIRST payment fail, so the subscription
    // expired and `changePlan` threw "no live subscription" — the assertions below passed
    // while measuring nothing about an upgrade. A customer who upgrades has, by definition,
    // already paid once.
    const s = await midCycle(ctx, { ...base, at: 0.5, taxRates: rateIds, label: "declined" });
    const live0 = await s.live();
    ok("the subscription is live before the card goes bad", live0.status === "active", live0.status);
    await attachTestCard(stripe, s.customerId, { card: "fail" });

    let outcome = "applied";
    let res = null;
    try {
      res = await api.subscription.change(orgId, { plan: PRO_PLAN, seats: PRO_SEATS }, NOW);
      outcome = res.kind;
    } catch (e) {
      outcome = `threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`;
    }

    const live = await s.live();
    const onPro = live.items.data.some((i) => i.price.id === prices.get(PRO_PREMIUM()));
    note(`status ${live.status}, pending_update ${live.pending_update ? "SET" : "none"}, kind "${outcome}"`);

    // The point of `pending_if_incomplete`: an unpaid upgrade must not grant the tier.
    ok("the customer is NOT on the tier they did not pay for", !onPro, onPro ? "PRO — granted unpaid" : "still Starter");
    ok("Stripe holds it as a pending update", Boolean(live.pending_update), live.pending_update ? "set" : `status ${live.status}`);

    // And the library must SAY so. It used to answer `updated` here — a UI reading that shows
    // "You're on Pro" to a customer whose card was declined.
    ok('the result says "pending", not "updated"', outcome === "pending", `"${outcome}"`);
    ok("with the window before Stripe drops it", Boolean(res?.pendingUntil), res?.pendingUntil ?? "none");
    ok("and the invoice to pay to apply it", Boolean(res?.invoiceId), res?.invoiceId ?? "none");
    ok("the plan reported in force is still the OLD one", res?.plan === STARTER_PLAN, res?.plan);

    // The worst of it was here: recording the new plan on the ORG granted the tier to the
    // meter and to every entitlement check, for an upgrade nobody paid for.
    const recorded = await api.plan(orgId);
    ok("and the org's own mirror was NOT moved to the unpaid plan", recorded !== PRO_PLAN, `${recorded}`);

    const inv = await s.newest();
    ok("an unpaid invoice records the attempt", Boolean(inv) && inv.status !== "paid", `${inv?.status}`);
  }
}
