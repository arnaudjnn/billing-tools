// The SUPPLIER's own VAT number — the one Art. 226(3) requires on every invoice.
//
// This had no test, and it did not work — in TWO ways, both measured against a real account.
// It sent `owner: { type: "account" }`, which Stripe refuses ("Must provide `account` if you
// provide `type=account`"); supplying your own account id there is refused as well ("No such
// account"), because `account` means a CONNECTED account. The shape for your own account is
// `owner: { type: "self" }`. So the single call the doctor tells you to run to fix a defective
// invoice 400'd every time it was made, and a fake accepts any params, which is exactly why
// nothing offline noticed and a live section did.
//
// So these assert the params SENT, the same shape as `tests/plan-change-live-defects.test.mjs`:
// what Stripe is asked for, not what a stub agrees to.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { ensureAccountTaxId, accountTaxIds } from "../dist/tax-setup.js";

/** Records every call, and answers the way Stripe does. */
function fakeStripe({ existing = [], ownAccount = false } = {}) {
  const sent = { created: null, updated: null, retrieved: 0 };
  return {
    sent,
    accounts: {
      async retrieve() {
        sent.retrieved++;
        return { id: "acct_live_1", country: "IT" };
      },
      async update(id, params) {
        sent.updated = { id, params };
        if (ownAccount) {
          // What Stripe really says for your OWN account. The default is a Dashboard setting.
          throw new Error("You cannot use this method on your own account: you may only use it on connected accounts.");
        }
        return { id };
      },
    },
    taxIds: {
      async list() {
        return { data: existing };
      },
      async create(params) {
        // BOTH of the real API's refusals, so a regression to either fails here rather than in
        // production. This is the whole reason the file exists.
        if (params.owner?.type === "account" && !params.owner.account) {
          throw new Error("Must provide `account` if you provide `type=account`");
        }
        if (params.owner?.type === "account") {
          throw new Error(`No such account: '${params.owner.account}'`);
        }
        sent.created = params;
        return { id: "atxi_1", ...params };
      },
    },
  };
}

test("the owner is `self`, which is the only shape your own account accepts", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  const res = await ensureAccountTaxId({ type: "eu_vat", value: "IT12345678901" });

  assert.deepEqual(stripe.sent.created.owner, { type: "self" });
  assert.equal(stripe.sent.created.type, "eu_vat");
  assert.equal(stripe.sent.created.value, "IT12345678901");
  assert.equal(res.created, true);
});

test("a PLATFORM can make it the default on a connected account", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  const res = await ensureAccountTaxId({ type: "eu_vat", value: "IT12345678901" });

  assert.equal(stripe.sent.updated.id, "acct_live_1", "the UPDATE does need the id, unlike the create");
  assert.deepEqual(stripe.sent.updated.params.settings.invoices.default_account_tax_ids, ["atxi_1"]);
  assert.equal(res.isDefault, true);
});

test("but on your OWN account it is a Dashboard setting, and that is REPORTED, not thrown", async () => {
  // `accounts.update` is refused outright there. The id was still created, which is the part
  // no Dashboard visit can do for you — so throwing would lose the work and tell you nothing.
  const stripe = fakeStripe({ ownAccount: true });
  __setStripeForTests(stripe);

  const res = await ensureAccountTaxId({ type: "eu_vat", value: "IT12345678901" });

  assert.equal(res.id, "atxi_1", "the tax id exists");
  assert.equal(res.created, true);
  assert.equal(res.isDefault, false, "and it says so, so the doctor can name the Dashboard step");
});

test("makeDefault: false creates it and leaves the account alone", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);

  const res = await ensureAccountTaxId({ type: "eu_vat", value: "IT12345678901", makeDefault: false });

  assert.ok(stripe.sent.created);
  assert.equal(stripe.sent.updated, null);
  assert.equal(res.isDefault, false);
});

test("idempotent BY VALUE — a second id with the same number would make Stripe choose", async () => {
  // Whitespace and case are not a different number.
  const stripe = fakeStripe({ existing: [{ id: "atxi_old", type: "eu_vat", value: "it 1234 5678 901" }] });
  __setStripeForTests(stripe);

  const res = await ensureAccountTaxId({ type: "eu_vat", value: "IT12345678901" });

  assert.equal(stripe.sent.created, null, "nothing is created");
  assert.equal(res.id, "atxi_old");
  assert.equal(res.created, false);
  // Still made the default: an existing id that prints on nothing is the other half of the bug.
  assert.deepEqual(stripe.sent.updated.params.settings.invoices.default_account_tax_ids, ["atxi_old"]);
});

test("listing them is a plain read", async () => {
  __setStripeForTests(fakeStripe({ existing: [{ id: "atxi_1", type: "eu_vat", value: "IT1" }] }));
  assert.deepEqual(await accountTaxIds(), [{ id: "atxi_1", type: "eu_vat", value: "IT1" }]);
});
