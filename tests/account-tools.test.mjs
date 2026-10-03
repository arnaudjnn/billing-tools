// download_invoice and set_tax_id, as tools.
//
// Both act on one customer's records by an id or a value the CALLER supplies, so what
// matters is what they refuse: an invoice of another customer must read as "no such
// invoice" (not as "forbidden", which would confirm it exists), and a tax id Stripe
// refuses must leave the one already on file — that number is what reverse-charges every
// B2B invoice, and an invoice issued without it cannot be corrected afterwards.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import Stripe from "stripe";

import { runWithAuth, runWithPrincipal } from "../dist/auth.js";
import { __setStripeForTests } from "../dist/billing.js";
import { createDispatcher } from "../dist/dispatch.js";
import { registerBillingTools } from "../dist/tools/register.js";
import { fakeAdapter } from "./helpers.mjs";

afterEach(() => __setStripeForTests(undefined));

const CONFIG = { currency: "eur", baseUrl: "https://t.local", internalDomains: [] };

function surface(adapter = fakeAdapter()) {
  const d = createDispatcher((server) =>
    registerBillingTools(server, { adapter, config: CONFIG, installLogging: false }),
  );
  return {
    call: (tool, args = {}) => runWithAuth("Bearer sk_x", () => d.dispatchTool(tool, args)),
    as: (userId) => (tool, args = {}) =>
      runWithPrincipal({ authHeader: "Bearer sk_x", principal: { userId } }, () => d.dispatchTool(tool, args)),
  };
}

const noSuch = (what) =>
  new Stripe.errors.StripeInvalidRequestError({ message: `No such ${what}`, type: "invalid_request_error" });

// ── download_invoice ─────────────────────────────────────────────────────────

function invoiceStripe(invoices = {}, charges = {}) {
  return {
    invoices: {
      async retrieve(id) {
        if (!invoices[id]) throw noSuch(`invoice: '${id}'`);
        return invoices[id];
      },
    },
    charges: {
      async retrieve(id) {
        if (!charges[id]) throw noSuch(`charge: '${id}'`);
        return charges[id];
      },
    },
  };
}

const inv = (over = {}) => ({
  id: "in_1",
  customer: "cus_test",
  number: "ACME-0001",
  status: "paid",
  amount_paid: 1220,
  amount_due: 1220,
  currency: "eur",
  created: 1_790_000_000,
  due_date: null,
  hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
  invoice_pdf: "https://pay.stripe.com/invoice/in_1/pdf",
  lines: { data: [] },
  ...over,
});

test("download_invoice returns the PDF link of the caller's own invoice", async () => {
  __setStripeForTests(invoiceStripe({ in_1: inv() }));
  const r = await surface().call("download_invoice", { invoice_id: "in_1" });
  assert.deepEqual(r, {
    status: "ok",
    invoice_id: "in_1",
    number: "ACME-0001",
    pdf_url: "https://pay.stripe.com/invoice/in_1/pdf",
  });
});

test("another customer's invoice reads exactly like a missing one", async () => {
  __setStripeForTests(invoiceStripe({ in_theirs: inv({ id: "in_theirs", customer: "cus_other" }) }));
  const { call } = surface();
  const theirs = await call("download_invoice", { invoice_id: "in_theirs" }).catch((e) => e.message);
  const missing = await call("download_invoice", { invoice_id: "in_nope" }).catch((e) => e.message);
  assert.equal(theirs, "No such invoice.");
  assert.equal(missing, theirs, "indistinguishable — the id reveals nothing");
});

test("an expanded customer object is matched like a bare id", async () => {
  __setStripeForTests(invoiceStripe({ in_1: inv({ customer: { id: "cus_test" } }) }));
  const r = await surface().call("download_invoice", { invoice_id: "in_1" });
  assert.equal(r.status, "ok");
});

test("a draft has no PDF yet, and the error says where to look instead", async () => {
  __setStripeForTests(invoiceStripe({ in_d: inv({ id: "in_d", status: "draft", invoice_pdf: null }) }));
  const err = await surface().call("download_invoice", { invoice_id: "in_d" }).catch((e) => JSON.parse(e.message));
  assert.equal(err.status, "no_pdf");
  assert.equal(err.invoice_url, "https://invoice.stripe.com/i/in_1");
  assert.match(err.message, /draft/);
});

test("an auto-reload charge has a receipt, not a PDF", async () => {
  __setStripeForTests(
    invoiceStripe(
      {},
      {
        ch_1: {
          id: "ch_1",
          customer: "cus_test",
          amount: 500,
          currency: "eur",
          status: "succeeded",
          created: 1_790_000_000,
          receipt_url: "https://pay.stripe.com/receipts/ch_1",
          description: "Auto-reload",
        },
      },
    ),
  );
  const err = await surface().call("download_invoice", { invoice_id: "ch_1" }).catch((e) => JSON.parse(e.message));
  assert.equal(err.status, "no_pdf");
  assert.equal(err.invoice_url, "https://pay.stripe.com/receipts/ch_1");
  assert.match(err.message, /receipt/);
});

test("a charge of another customer is not found either", async () => {
  __setStripeForTests(invoiceStripe({}, { ch_x: { id: "ch_x", customer: "cus_other", status: "succeeded" } }));
  await assert.rejects(surface().call("download_invoice", { invoice_id: "ch_x" }), /^Error: No such invoice\.$/);
});

test("a Stripe failure that is not 'no such' is not reported as not-found", async () => {
  __setStripeForTests({
    invoices: {
      async retrieve() {
        throw new Stripe.errors.StripeAPIError({ message: "Stripe is having a bad day" });
      },
    },
  });
  await assert.rejects(surface().call("download_invoice", { invoice_id: "in_1" }), /bad day/);
});

test("download_invoice without a key is a 401, before Stripe is asked", async () => {
  __setStripeForTests(new Proxy({}, { get: () => assert.fail("Stripe reached") }));
  const d = createDispatcher((server) =>
    registerBillingTools(server, { adapter: fakeAdapter(), config: CONFIG, installLogging: false }),
  );
  await assert.rejects(runWithAuth(null, () => d.dispatchTool("download_invoice", { invoice_id: "in_1" })), /401/);
});

// ── set_tax_id ───────────────────────────────────────────────────────────────

/** A customer's tax ids, with the refusals Stripe really makes. */
function taxStripe({ country = "IT", ids = [] } = {}) {
  const store = ids.map((t) => ({ ...t }));
  const log = [];
  let seq = 0;
  return {
    store,
    log,
    customers: {
      async retrieve(id) {
        return { id, email: null, name: null, address: country ? { line1: "Via Roma 1", city: "Milano", country } : null, preferred_locales: [] };
      },
      async listTaxIds() {
        return { data: store.map((t) => ({ ...t })) };
      },
      async createTaxId(_cus, { type, value }) {
        log.push(["create", type, value]);
        if (type === "eu_vat" && !/^[A-Z]{2}[0-9A-Z]{8,12}$/.test(value)) {
          throw new Stripe.errors.StripeInvalidRequestError({ message: `Invalid value for eu_vat.` });
        }
        if (store.some((t) => t.type === type && t.value === value)) {
          throw new Stripe.errors.StripeInvalidRequestError({ message: "Tax ID already exists" });
        }
        const t = { id: `txi_${++seq}`, type, value, verification: { status: "pending", verified_name: null } };
        store.push(t);
        return t;
      },
      async deleteTaxId(_cus, id) {
        log.push(["delete", id]);
        const i = store.findIndex((t) => t.id === id);
        if (i < 0) throw new Stripe.errors.StripeInvalidRequestError({ message: "No such tax id" });
        store.splice(i, 1);
        return { id, deleted: true };
      },
    },
  };
}

const ON_FILE = { id: "txi_old", type: "eu_vat", value: "IT01234567890" };

test("a new tax id replaces the old one", async () => {
  const stripe = taxStripe({ ids: [ON_FILE] });
  __setStripeForTests(stripe);
  const r = await surface().call("set_tax_id", { value: "FR12345678901", type: "eu_vat" });
  assert.equal(r.status, "ok");
  assert.equal(r.tax_ids.value, "FR12345678901");
  assert.deepEqual(stripe.store.map((t) => t.value), ["FR12345678901"]);
});

test("a value Stripe REFUSES leaves the one on file in place", async () => {
  // REGRESSION: every existing id was deleted BEFORE the create was attempted, so a typo
  // left the customer with no VAT number at all — and the next invoice without its
  // reverse-charge basis.
  const stripe = taxStripe({ ids: [ON_FILE] });
  __setStripeForTests(stripe);
  await assert.rejects(surface().call("set_tax_id", { value: "IT-not-a-vat", type: "eu_vat" }), /Invalid value/);
  assert.deepEqual(stripe.store, [ON_FILE]);
  assert.ok(!stripe.log.some(([op]) => op === "delete"), "nothing deleted");
});

test("re-saving the id already on file changes nothing", async () => {
  // Stripe refuses a duplicate of the same type and value, so this is either a no-op or an
  // error — and it must be the no-op.
  const stripe = taxStripe({ ids: [ON_FILE] });
  __setStripeForTests(stripe);
  const r = await surface().call("set_tax_id", { value: " IT01234567890 ", type: "eu_vat" });
  assert.equal(r.tax_ids.id, "txi_old");
  assert.deepEqual(stripe.log, []);
});

test("re-saving it alongside a stray second id keeps it and removes the stray", async () => {
  const stray = { id: "txi_stray", type: "gb_vat", value: "GB123456789" };
  const stripe = taxStripe({ ids: [ON_FILE, stray] });
  __setStripeForTests(stripe);
  await surface().call("set_tax_id", { value: "IT01234567890", type: "eu_vat" });
  assert.deepEqual(stripe.store.map((t) => t.id), ["txi_old"]);
});

test("an empty value removes every tax id", async () => {
  const stripe = taxStripe({ ids: [ON_FILE] });
  __setStripeForTests(stripe);
  const r = await surface().call("set_tax_id", { value: "" });
  assert.deepEqual(r, { status: "ok", tax_ids: null });
  assert.deepEqual(stripe.store, []);
});

test("a whitespace value is removal too, not a request to infer a type", async () => {
  // REGRESSION: "  " was truthy, so the tool tried to infer a type for it and — on a
  // customer with no EU address — refused, instead of doing the documented removal.
  const stripe = taxStripe({ country: "US", ids: [ON_FILE] });
  __setStripeForTests(stripe);
  const r = await surface().call("set_tax_id", { value: "   " });
  assert.equal(r.tax_ids, null);
  assert.deepEqual(stripe.store, []);
});

test("the type is inferred as eu_vat from an EU billing address", async () => {
  const stripe = taxStripe({ country: "IT" });
  __setStripeForTests(stripe);
  const r = await surface().call("set_tax_id", { value: "IT01234567890" });
  assert.equal(r.tax_ids.type, "eu_vat");
});

test("outside the EU the type must be named, and nothing is touched until it is", async () => {
  const stripe = taxStripe({ country: "US", ids: [ON_FILE] });
  __setStripeForTests(stripe);
  await assert.rejects(surface().call("set_tax_id", { value: "12-3456789" }), /pass `type`/);
  assert.deepEqual(stripe.store, [ON_FILE]);
  assert.deepEqual(stripe.log, []);
});

test("set_tax_id is admin-only when the caller is a known member", async () => {
  const stripe = taxStripe({ ids: [ON_FILE] });
  __setStripeForTests(stripe);
  const adapter = Object.assign(fakeAdapter(), { isAdmin: async (_org, userId) => userId === "owner" });
  const { as } = surface(adapter);
  await assert.rejects(as("member")("set_tax_id", { value: "" }), /Forbidden \(403\)/);
  assert.deepEqual(stripe.store, [ON_FILE]);
  const r = await as("owner")("set_tax_id", { value: "" });
  assert.equal(r.status, "ok");
});

test("a workspace with no billing customer is told so", async () => {
  __setStripeForTests(taxStripe());
  const adapter = Object.assign(fakeAdapter(), { getBillingCustomerId: async () => null });
  await assert.rejects(surface(adapter).call("set_tax_id", { value: "IT01234567890", type: "eu_vat" }), /No billing customer/);
});
