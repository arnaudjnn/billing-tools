// The tax DEFAULT, which changed in 4.x: configuring nothing now means
// `"local"` — this library's own `sales-tax` + VIES calculation, applied as
// explicit Stripe TaxRates — where it used to mean `"none"`.
//
// The old default was the expensive direction. Silence meant no tax on anything the
// library charged, so a deployment that never thought about VAT shipped charging
// none of it. Over-charging is recoverable; under-collecting means owing it
// yourself, with interest, in every jurisdiction you sold into. "I did not configure
// tax" is not a statement that the sale is untaxed.
//
// The reason it could not default before was `origin`: the mode needs to know where
// you are established, and no rate can be worked out without it. `originFor` removes
// that by falling back to the Stripe account's country — the country you gave Stripe
// when you signed up. So the default needs no config at all.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { taxModeOf, originFor, invalidateTaxOrigin } from "../dist/tax.js";
import { __setStripeForTests } from "../dist/billing.js";

test("configuring nothing means local, not none", () => {
  assert.equal(taxModeOf(undefined), "local");
  assert.equal(taxModeOf({}), "local");
});

test('"none" is now an explicit opt-out, which is the point', () => {
  // Correct for an account that genuinely charges no tax — and something you have
  // to write down rather than arrive at by omission.
  assert.equal(taxModeOf({ mode: "none" }), "none");
});

test("automatic still means Stripe Tax, and an explicit mode always wins", () => {
  assert.equal(taxModeOf({ automatic: true }), "stripe");
  assert.equal(taxModeOf({ mode: "stripe" }), "stripe");
  // Explicit beats inferred, both ways.
  assert.equal(taxModeOf({ automatic: true, mode: "none" }), "none");
  assert.equal(taxModeOf({ origin: "FR", mode: "stripe" }), "stripe");
});

test("origin comes from config when set — explicit always wins", async () => {
  invalidateTaxOrigin();
  // No Stripe call should be needed at all here.
  __setStripeForTests({
    accounts: {
      retrieve: async () => {
        throw new Error("must not be called when origin is declared");
      },
    },
  });
  assert.equal(await originFor({ origin: "FR" }), "FR");
});

test("and falls back to the Stripe account's country when it is not", async () => {
  invalidateTaxOrigin();
  let calls = 0;
  __setStripeForTests({
    accounts: {
      retrieve: async () => {
        calls++;
        return { id: "acct_1", country: "FR" };
      },
    },
  });
  assert.equal(await originFor(undefined), "FR");
  // Memoised: an account does not change country, and this sits behind `taxFor` on
  // the hot path of every metered call.
  assert.equal(await originFor(undefined), "FR");
  assert.equal(calls, 1, "the account should be read once per process");
});

test("a Stripe failure yields no origin rather than throwing, and is retried", async () => {
  // `taxFor` runs on a charge path — the auto-reload invoice is raised from the
  // meter — so a Stripe blip must cost a tax rate, never the charge.
  invalidateTaxOrigin();
  let attempts = 0;
  __setStripeForTests({
    accounts: {
      retrieve: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network");
        return { id: "acct_1", country: "IT" };
      },
    },
  });
  assert.equal(await originFor(undefined), null, "a failure must not throw");
  // NOT cached as null: a transient error should be retried, whereas a genuine
  // "no country on the account" is settled and worth remembering.
  assert.equal(await originFor(undefined), "IT");
});

test("an account with no country reports none, and is not re-read", async () => {
  invalidateTaxOrigin();
  let calls = 0;
  __setStripeForTests({
    accounts: {
      retrieve: async () => {
        calls++;
        return { id: "acct_1" };
      },
    },
  });
  assert.equal(await originFor(undefined), null);
  assert.equal(await originFor(undefined), null);
  assert.equal(calls, 1, "a settled answer should be remembered");
});

// ── US destinations are refused, not approximated ────────────────────────────
//
// `sales-tax` carries ONE rate per US state. US sales tax is destination-based
// across 13 000+ jurisdictions — counties, cities and special districts stack on
// the state rate — and SaaS is taxable in some states and not others. Illinois
// reads 6.25% where a Chicago buyer owes ~10.25%.
//
// Verified against npm while deciding this: no package ships accurate US local
// rates. `taxjar` is a client for a paid API, `washington-state-sales-tax` covers
// one state, `eu-vat-rates-data` is EU-only. The data is a licensed product, so
// this is not a gap a dependency can close.
//
// So the rate is not silently applied. Under-collection is the one direction that
// is not recoverable: the customer is gone and the difference is yours, with
// interest. A charge that fails with a reason can be fixed.

import { ApproximateTaxError, resolveTax, taxRatesFor } from "../dist/tax.js";

test("a US destination is flagged approximate; the EU is not", async () => {
  const us = await resolveTax({ originCountry: "US", country: "US", state: "IL" });
  assert.equal(us.approximate, true);
  // The state rate itself is still reported — the flag says "incomplete", not "wrong".
  assert.ok(us.percent > 0);

  const it = await resolveTax({ originCountry: "FR", country: "IT" });
  assert.equal(it.approximate, undefined, "EU VAT is one published rate per country");
  assert.equal(it.percent, 22);
});

test("minting a rate from an approximate decision throws, and says what to do", async () => {
  await assert.rejects(
    () => taxRatesFor({ originCountry: "US", country: "US", state: "IL" }),
    (e) => {
      assert.ok(e instanceof ApproximateTaxError, "should be the typed error");
      // The message has to carry the numbers: "approximate" alone does not convey
      // that the gap is four percentage points.
      assert.match(e.message, /Chicago/);
      assert.match(e.message, /mode: "stripe"/);
      return true;
    },
  );
});

test("allowApproximate is the explicit way to accept it", async () => {
  // Not asserting Stripe behaviour — asserting the refusal is opt-outable, so a
  // caller who has decided the state rate is close enough is not blocked.
  await assert.doesNotReject(async () => {
    try {
      await taxRatesFor({
        originCountry: "US",
        country: "US",
        state: "IL",
        allowApproximate: true,
      });
    } catch (e) {
      // Anything but the approximation guard is fine here (no real Stripe key).
      if (e instanceof ApproximateTaxError) throw e;
    }
  });
});
