// A credit sale is paid in CASH — never out of the wallet it is topping up.
//
// Stripe applies a customer's credit balance to every invoice it finalizes, and the wallet
// IS that balance. Measured in Stripe TEST before 25.8.7: a 10 000-credit quote at €70 on a
// wallet of 2 999 charged the card €40.01, and an auto-reload of 1 902 on a wallet of 12 998
// charged €0 and was granted twice. Every earlier section asserted the WALLET delta, which
// was right in both cases — so this one asserts the cash:
//
//   amount_paid === total, starting_balance === 0, and no `applied_to_invoice` transaction.
//
//   15a  a negotiated quote (`sellCredits`, card on file) on a funded wallet
//   15b  a `saved_card` purchase on a funded wallet
//   15c  an auto-reload, which by definition fires while the wallet still holds credits
//
// Each grant is then delivered AGAIN through the event handler, as `invoice.paid` would be:
// one invoice, one grant, whichever path runs second.
//
// Its own customer, off the clock: this section moves a wallet by tens of thousands of
// credits, which would change what every other section measures.

import { createStripeEventHandler } from "../../dist/sync.js";
import {
  getCreditBalance,
  grantCredits,
  purchaseCredits,
  sellCredits,
  setAutoReloadSettings,
  tryAutoReload,
} from "../../dist/billing.js";
import { eur, ignoreMissing, defer, note, ok } from "../lib/harness.mjs";
import { RUN, attachTestCard } from "../lib/scratch-stripe.mjs";

export async function run(ctx) {
  const { stripe, config, orgId, plans, adapter } = ctx;
  const customer = await stripe.customers.create({
    name: `Cash (${RUN})`,
    email: `${RUN}-cash@example.test`,
    address: { line1: "3 Via Test", city: "Torino", postal_code: "10100", country: "IT" },
    metadata: { bt_scratch: RUN, org_id: orgId },
  });
  defer(`cash customer ${customer.id}`, () => stripe.customers.del(customer.id).catch(ignoreMissing));
  await attachTestCard(stripe, customer.id);
  const cid = customer.id;
  const wallet = () => getCreditBalance(cid, "eur");
  const handle = createStripeEventHandler({ adapter, plans, currency: "eur" });
  const deliverPaid = async (invoiceId) => {
    const inv = await stripe.invoices.retrieve(invoiceId);
    await handle({ id: `evt_${RUN}_${invoiceId}`, type: "invoice.paid", data: { object: inv } });
  };

  /** The three cash assertions, on the invoice as Stripe now holds it. */
  async function paidInCash(label, invoiceId) {
    const inv = await stripe.invoices.retrieve(invoiceId);
    ok(`${label}: paid`, inv.status === "paid", inv.status);
    ok(`${label}: the card paid the WHOLE total`, inv.amount_paid === inv.total, `${eur(inv.amount_paid)} of ${eur(inv.total)}`);
    ok(`${label}: no wallet credit applied`, inv.starting_balance === 0, `starting_balance ${inv.starting_balance}`);
    const applied = [];
    for await (const t of stripe.customers.listBalanceTransactions(cid, { limit: 100 })) {
      if (t.type === "applied_to_invoice" && t.invoice === invoiceId) applied.push(t.id);
    }
    ok(`${label}: no applied_to_invoice transaction`, applied.length === 0, applied.join(", "));
    return inv;
  }

  // ── 15a — the negotiated quote ──────────────────────────────────────────────
  await grantCredits(cid, 2_999, "Seed wallet", "eur", `${RUN}:seed`);
  ok("15a: the wallet holds 2 999 before the sale", (await wallet()) === 2_999);

  const sale = await sellCredits(cid, orgId, config, {
    credits: 10_000,
    amountMinor: 7_000,
    method: "saved_card",
    idempotencyKey: `${RUN}:quote`,
  });
  ok("15a: charged to the card on file", sale.status === "charged", sale.status);
  if (sale.status === "charged") {
    await paidInCash("15a", sale.invoiceId);
    ok("15a: the wallet is UNCHANGED until the invoice is paid out", (await wallet()) === 2_999, String(await wallet()));
    await deliverPaid(sale.invoiceId);
    await deliverPaid(sale.invoiceId);
    ok("15a: granted what was sold, once", (await wallet()) === 12_999, String(await wallet()));
  }

  // ── 15b — saved_card purchase ───────────────────────────────────────────────
  const before = await wallet();
  const bought = await purchaseCredits(cid, orgId, 20, config, { method: "saved_card" });
  ok("15b: charged", bought.status === "charged", bought.status);
  if (bought.status === "charged") {
    await paidInCash("15b", bought.invoiceId);
    ok("15b: +2 000 credits", (await wallet()) === before + 2_000, String(await wallet()));
    await deliverPaid(bought.invoiceId);
    ok("15b: the event is a no-op after the synchronous grant", (await wallet()) === before + 2_000);
  }

  // ── 15c — auto-reload on a funded wallet ────────────────────────────────────
  const held = await wallet();
  const reloadTo = held + 1_902;
  await setAutoReloadSettings(cid, held + 2, reloadTo, true);
  await tryAutoReload(cid, "eur", { taxRates: [] });
  const reloads = [];
  for await (const inv of stripe.invoices.list({ customer: cid, limit: 10 })) {
    if (inv.metadata?.auto_reload === "true") reloads.push(inv);
  }
  ok("15c: exactly one reload invoice", reloads.length === 1, String(reloads.length));
  if (reloads[0]) {
    ok("15c: for the DELTA, not the target", reloads[0].metadata.credits === "1902", reloads[0].metadata.credits);
    await paidInCash("15c", reloads[0].id);
    ok("15c: topped up TO reload_to", (await wallet()) === reloadTo, `${await wallet()} vs ${reloadTo}`);
    await deliverPaid(reloads[0].id);
    ok("15c: not granted a second time by the event", (await wallet()) === reloadTo, String(await wallet()));
  }
  await setAutoReloadSettings(cid, 0, 0, false);

  // Nothing set aside may be left behind: every aside has its restore.
  const asides = new Set();
  const restores = new Set();
  for await (const t of stripe.customers.listBalanceTransactions(cid, { limit: 100 })) {
    if (t.metadata?.set_aside_for) asides.add(t.metadata.set_aside_for);
    if (t.metadata?.restored_for) restores.add(t.metadata.restored_for);
  }
  ok("every wallet set-aside was restored", [...asides].every((i) => restores.has(i)), `${asides.size} set aside`);
  note(`cash customer ${cid}: final wallet ${await wallet()}`);
}
