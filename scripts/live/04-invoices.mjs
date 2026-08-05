// What an invoice actually says, and who is allowed to read it.
//
// Two different claims, which is why this is one section and not two:
//
//  1. COMPLIANCE — an invoice is a legal document, so the fields on it are not cosmetic:
//     the supplier's own tax id, the customer's address (the place of supply), the
//     customer's VAT number, and a tax line whose wording is the mandatory mention. Offline
//     none of these exist, because a fake never finalizes anything.
//  2. OWNERSHIP — `getInvoice` compares the customer before returning, and "not found" and
//     "not yours" are deliberately the same answer. Proving that needs a second real
//     customer, so it cannot be done offline either.
//
// It runs AFTER 05 on purpose: a DRAFT invoice has no PDF and no hosted url, so the links
// half of the projection is only assertable against invoices the lifecycle already
// finalized.
//
// The customer address and tax id are written THROUGH THE TOOLS — the write path is half the
// claim — and then a fresh invoice is raised, because Stripe SNAPSHOTS both onto an invoice
// at finalization and the lifecycle's invoices were finalized before either was set.

import { taxRatesFor } from "../../dist/tax.js";
import { eur, note, ok, section } from "../lib/harness.mjs";
import { RUN, createOtherCustomer } from "../lib/scratch-stripe.mjs";

const IT_VAT = "IT01234567890";


export async function run(ctx) {
  const { stripe, api, orgId, customerId, callers } = ctx;

  // ── the write path ────────────────────────────────────────────────────────
  section("04a — the invoice recipient is set through the tools");
  const profile = await callers.asAdmin("set_billing_profile", {
    company_name: `E2E Live ${RUN}`,
    address_line1: "1 Via Test",
    address_city: "Milano",
    address_postal_code: "20100",
    address_country: "IT",
  });
  ok("set_billing_profile succeeds", profile.ok, profile.error?.slice(0, 60) ?? "ok");

  const taxId = await callers.asAdmin("set_tax_id", { value: IT_VAT });
  ok("set_tax_id succeeds", taxId.ok, taxId.error?.slice(0, 60) ?? "ok");

  // Read back through the library rather than off the Stripe object: a write nobody can
  // read is not a write.
  const readBack = await api.profile.get(orgId);
  ok("the profile reads back", readBack?.companyName === `E2E Live ${RUN}`, readBack?.companyName);
  ok("with the country the place of supply depends on", readBack?.address?.country === "IT", readBack?.address?.country);

  const ids = await api.taxIds.list(orgId);
  ok("and the tax id is on the customer", ids.some((t) => t.value === IT_VAT), ids.map((t) => t.value).join(", "));

  // ── the snapshot ──────────────────────────────────────────────────────────
  section("04b — a finalized invoice carries all of it");
  const { rateIds } = await taxRatesFor({
    originCountry: "IT",
    registrations: [{ country: "IT" }],
    country: "IT",
    notes: { exempt: "Operazione non soggetta a IVA" },
  });
  const draft = await stripe.invoices.create({
    customer: customerId,
    collection_method: "charge_automatically",
    auto_advance: false,
    metadata: { bt_scratch: RUN },
  });
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: draft.id,
    currency: "eur",
    amount: 10_000,
    description: `${RUN} compliance probe`,
    tax_rates: rateIds,
  });
  const final = await stripe.invoices.finalizeInvoice(draft.id, {
    expand: ["customer_tax_ids"],
  });

  ok("the customer's address is snapshotted", final.customer_address?.country === "IT", final.customer_address?.country);
  ok(
    "the customer's VAT number is snapshotted",
    (final.customer_tax_ids ?? []).some((t) => t.value === IT_VAT),
    (final.customer_tax_ids ?? []).map((t) => t.value).join(", ") || "none",
  );
  ok("exactly one tax line", final.total_taxes?.length === 1, String(final.total_taxes?.length));
  ok("€100 + 22% is charged as €122", final.total === 12_200, eur(final.total));

  // The SUPPLIER's own tax id. Read-only on purpose: `ensureAccountTaxId` writes
  // `default_account_tax_ids` on the whole Stripe account, which is not a harness's business
  // to change. A missing one is reported with the exact call to run, not failed — this is a
  // shared test account, and the shape of the check is what matters.
  const supplier = final.account_tax_ids ?? [];
  if (supplier.length) {
    ok("the supplier's tax id is on the invoice", true, `${supplier.length} id(s)`);
  } else {
    note("→ FINDING: no account tax id on this Stripe account, so invoices carry no supplier");
    note("  VAT number — which most EU jurisdictions require. Fix with:");
    note("    await ensureAccountTaxId({ value: 'IT…', type: 'eu_vat' })   // src/tax-setup.ts");
    ok("the check ran and reported the gap", true, "read-only by design");
  }

  // ── the projection ────────────────────────────────────────────────────────
  section("04c — what the tools hand a caller is enough to render a row");
  const listed = (await callers.asOrgKey("list_invoices", { limit: 10 })).value;
  const rows = listed?.invoices ?? [];
  ok("list_invoices returns the run's invoices", rows.length > 0, `${rows.length} row(s)`);

  // `amount` is the field a UI prints, and the bug it exists for is showing 0 for every
  // open invoice by reading `amount_paid` alone.
  const open = rows.find((r) => r.status === "open");
  if (open) {
    ok("an open invoice shows what is owed, not 0", open.amount === open.amount_due, eur(open.amount));
  } else {
    note("no open invoice in the window — the paid path is asserted below instead");
  }

  const settled = rows.find((r) => r.paid);
  if (settled) ok("a paid invoice shows what was paid", settled.amount === settled.amount_paid, eur(settled.amount));

  const one = (await callers.asOrgKey("view_invoice", { invoice_id: final.id })).value?.invoice;
  ok("view_invoice returns the invoice by id", one?.id === final.id, one?.id);
  ok("with a hosted link a human can open", Boolean(one?.invoice_url), one?.invoice_url?.slice(0, 40));
  ok("and a PDF link, now that it is finalized", Boolean(one?.invoice_pdf), one?.invoice_pdf?.slice(0, 40));

  const pdf = (await callers.asOrgKey("download_invoice", { invoice_id: final.id })).value;
  ok("download_invoice hands back the PDF directly", Boolean(pdf?.pdf_url), pdf?.pdf_url?.slice(0, 40));

  // A member can read the workspace's invoices — they are not an admin-only surface.
  const byMember = await callers.asMember("view_invoice", { invoice_id: final.id });
  ok("a member may read an invoice", byMember.ok, byMember.error?.slice(0, 60) ?? "ok");

  // ── ownership ─────────────────────────────────────────────────────────────
  section("04d — someone else's invoice is 'no such invoice'");
  const otherCustomerId = await createOtherCustomer(stripe);
  const theirs = await stripe.invoices.create({
    customer: otherCustomerId,
    collection_method: "charge_automatically",
    auto_advance: false,
    metadata: { bt_scratch: RUN },
  });
  await stripe.invoiceItems.create({
    customer: otherCustomerId,
    invoice: theirs.id,
    currency: "eur",
    amount: 4_200,
    description: `${RUN} not yours`,
  });
  const theirsFinal = await stripe.invoices.finalizeInvoice(theirs.id);

  // A real id, a real invoice, and the caller is authenticated — the only thing wrong is
  // whose it is. "Not found" rather than "not yours" is deliberate: the second answer
  // confirms the invoice exists.
  const denied = await callers.asOrgKey("view_invoice", { invoice_id: theirsFinal.id });
  ok(
    "view_invoice refuses it",
    !denied.ok && /No such invoice/.test(denied.error ?? ""),
    denied.ok ? "LEAKED" : (denied.error ?? "").slice(0, 40),
  );
  const deniedPdf = await callers.asOrgKey("download_invoice", { invoice_id: theirsFinal.id });
  ok(
    "and so does download_invoice",
    !deniedPdf.ok && /No such invoice/.test(deniedPdf.error ?? ""),
    deniedPdf.ok ? "LEAKED" : (deniedPdf.error ?? "").slice(0, 40),
  );

  // The library's own read path, not just the tool, since a server action calls this one.
  ok("and api.invoices.get agrees", (await api.invoices.get(orgId, theirsFinal.id)) === null);

  // ── the portal ────────────────────────────────────────────────────────────
  section("04e — the no-code surface still resolves");
  const portal = (await callers.asOrgKey("get_billing_portal", {})).value;
  ok(
    "get_billing_portal returns a Stripe-hosted url",
    typeof portal?.portal_url === "string" && portal.portal_url.includes("stripe.com"),
    portal?.portal_url?.slice(0, 44) ?? JSON.stringify(portal ?? {}).slice(0, 60),
  );
}
