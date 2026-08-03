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
import { afterEach, test } from "vitest";

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

import {
  ApproximateTaxError,
  __setVatValidatorForTests,
  resolveTax,
  taxRatesFor,
} from "../dist/tax.js";

// Reverse charge needs a VALID VAT number, and "valid" is a live VIES answer about a
// real company. These tests used to ask the European Commission — so they broke the
// suite's offline contract (vitest.config.ts) and went red whenever a member state's
// node was down, which is the exact outage the fallback below exists for. The lookup
// is stubbed per test; the local format check is not stubbed and still runs.
// Reset to a validator that REFUSES rather than to the real one. Restoring the
// real lookup re-arms the network between tests, so the next test written with a
// `taxNumber` and no stub silently starts calling VIES — and fails months later,
// intermittently, when a member state's node is down. That is how this file came
// to be flaky in the first place. Failing deterministically with a message that
// says what to do is strictly better than a test that usually passes.
const unstubbed = async () => {
  throw new Error(
    "VIES was called without a stub. Tests must not depend on a third-party " +
      "service being up: call viesSays(true|false) first.",
  );
};
afterEach(() => __setVatValidatorForTests(unstubbed));
__setVatValidatorForTests(unstubbed);
const viesSays = (isValid) => __setVatValidatorForTests(async () => isValid);

test("a European seller exporting outside the EU is OUT OF SCOPE, not approximate", async () => {
  // The distinction this gets wrong at its peril. A French seller supplying a
  // digital service to a US or Canadian customer has a place of supply outside the
  // EU, so no EU VAT arises: 0% is correct and COMPLETE. An earlier version marked
  // every non-European destination `approximate` regardless of origin, which would
  // have refused every export a French business made.
  for (const country of ["US", "CA", "AU", "JP"]) {
    const d = await resolveTax({ originCountry: "FR", country });
    assert.equal(d.percent, 0, `${country} should attract no EU VAT`);
    assert.equal(d.outOfScope, true, `${country} should be out of scope`);
    assert.equal(d.approximate, undefined, `${country} must NOT be refused`);
  }

  // And it can be charged — the guard does not fire on a complete answer.
  await assert.doesNotReject(() => taxRatesFor({ originCountry: "FR", country: "US" }));
});

test("a non-EU EUROPEAN destination is out of scope, not its own domestic rate", async () => {
  // The bug this pins. GB, CH, NO, TR and IS are all in the rate dataset — it covers
  // 45 European countries, only 27 of them in the EU — so they passed the coverage
  // gate, fell through every EU branch and were charged their own standard rate: an
  // Italian seller invoiced 20% "VAT" to a UK customer, 25% to a Norwegian one.
  //
  // Neither is collectable. It is not EU VAT (the place of supply is outside the EU,
  // so none arises) and it is not UK or Norwegian VAT unless you are registered
  // there. It collected a fifth of the invoice with nowhere to pay it over — the same
  // fault `oss: false` exists to prevent, one border further out.
  for (const country of ["GB", "CH", "NO", "TR", "IS"]) {
    const d = await resolveTax({ originCountry: "IT", country });
    assert.equal(d.percent, 0, `${country}: no EU VAT arises on an export`);
    assert.equal(d.outOfScope, true, `${country} should be out of scope`);
    assert.equal(d.approximate, undefined, `${country} is a complete answer, not a refusal`);
    assert.equal(d.type, "none");
  }

  // Nothing moved for the covered EU cases, and DOMESTIC sales in those same
  // countries are unaffected — a UK seller still charges UK VAT to a UK customer.
  const gbDomestic = await resolveTax({ originCountry: "GB", country: "GB" });
  assert.equal(gbDomestic.percent, 20);
  const chDomestic = await resolveTax({ originCountry: "CH", country: "CH" });
  assert.equal(chDomestic.percent, 8.1);
});

test("a registration is what puts a non-EU rate back on", async () => {
  // The corrected rule needs a way to say "I do collect there", or an Italian seller
  // with a genuine UK VAT registration could never charge UK VAT.
  const registered = await resolveTax({
    originCountry: "IT",
    country: "GB",
    registrations: [{ country: "IT" }, { country: "GB" }],
  });
  assert.equal(registered.percent, 20, "registered in GB: GB VAT applies");
  assert.equal(registered.outOfScope, undefined);

  // And a registration elsewhere does not leak onto an unrelated destination.
  const norway = await resolveTax({
    originCountry: "IT",
    country: "NO",
    registrations: [{ country: "IT" }, { country: "GB" }],
  });
  assert.equal(norway.outOfScope, true);
  assert.equal(norway.percent, 0);
});

test("declaring registrations governs DOMESTIC sales too; omitting them does not", async () => {
  // Undefined is "the caller did not say", never "registered nowhere" — inventing an
  // empty list would stop a working deployment charging its own domestic VAT.
  assert.equal((await resolveTax({ originCountry: "IT", country: "IT" })).percent, 22);

  // Declared, there is ONE rule for everywhere, domestic included. That is the only
  // model the US has, and it is also honest for a below-threshold European seller.
  const declared = await resolveTax({
    originCountry: "IT",
    country: "IT",
    registrations: [{ country: "GB" }],
  });
  assert.equal(declared.percent, 0, "not registered at home: nothing to collect");
  assert.equal(declared.outOfScope, true);

  // So `[]` says something that omitting it cannot.
  const none = await resolveTax({ originCountry: "IT", country: "IT", registrations: [] });
  assert.equal(none.percent, 0);
  assert.equal(none.outOfScope, true);
});

test("US nexus is per STATE, which is why `state` is finally read", async () => {
  // It was accepted, threaded from the customer's Stripe address, and never used.
  const regs = [{ country: "US", state: "CA" }];

  // Registered in the state the customer is in: tax IS due, and we have no rate for
  // it — an incomplete answer, so it is flagged rather than charged as 0%.
  const ca = await resolveTax({ originCountry: "US", country: "US", state: "CA", registrations: regs });
  assert.equal(ca.approximate, true);
  assert.equal(ca.outOfScope, undefined);

  // A state with no nexus: 0% is COMPLETE. Post-Wayfair you must not collect there.
  const tx = await resolveTax({ originCountry: "US", country: "US", state: "TX", registrations: regs });
  assert.equal(tx.outOfScope, true);
  assert.equal(tx.approximate, undefined);
  // Which means it can be charged — no refusal, no `allowApproximate` needed.
  await assert.doesNotReject(() =>
    taxRatesFor({ originCountry: "US", country: "US", state: "TX", registrations: regs }),
  );

  // An address too vague to place inside a state registration is not evidence that it
  // falls inside one.
  const noState = await resolveTax({ originCountry: "US", country: "US", registrations: regs });
  assert.equal(noState.outOfScope, true);

  // A country-wide entry covers every state in it.
  const wide = await resolveTax({
    originCountry: "US",
    country: "US",
    state: "TX",
    registrations: [{ country: "US" }],
  });
  assert.equal(wide.approximate, true);
});

test("a non-EU seller reverse-charges an EU business, and does not bill it VAT", async () => {
  // Reverse charge required BOTH parties in the EU, so a US supplier invoiced a
  // German business 19% MwSt — tax it has no obligation to collect and no way to
  // remit. The customer self-accounts under Art. 44/196 whoever the supplier is.
  viesSays(true);
  const d = await resolveTax({
    originCountry: "US",
    country: "DE",
    taxNumber: "DE143454214",
  });
  assert.equal(d.reverseCharge, true);
  assert.equal(d.percent, 0);

  // Without a valid id the sale is B2C, and destination VAT is due with no threshold
  // to sit under (non-Union OSS) — so this one is NOT registration-gated: an empty
  // list cannot wish away an obligation that never had a threshold.
  for (const registrations of [undefined, []]) {
    const b2c = await resolveTax({ originCountry: "US", country: "DE", registrations });
    assert.equal(b2c.percent, 19, "an EU consumer is charged their own rate");
    assert.equal(b2c.displayName, "MwSt");
  }
});

test("an unverifiable VAT number is CHARGED, not exempted", async () => {
  // The most important direction in the file, and it could not be asserted while the
  // test itself was the outage. VIES has regular per-member-state downtime
  // (`MS_UNAVAILABLE`), and treating unreachable as valid would zero-rate a sale on
  // the strength of a service being down. Wrongly charging is recoverable; wrongly
  // exempting leaves you owing the VAT.
  viesSays(false);
  const d = await resolveTax({
    originCountry: "IT",
    country: "DE",
    taxNumber: "DE143454214",
  });
  assert.equal(d.reverseCharge, false, "unverified is not exempt");
  assert.equal(d.percent, 19, "so the customer's rate is charged (OSS default)");

  // And a malformed number never reaches VIES at all — the local format gate is not
  // part of the seam, so this holds whatever the stub would have said.
  __setVatValidatorForTests(async () => {
    throw new Error("VIES must not be asked about rubbish");
  });
  const junk = await resolveTax({ originCountry: "IT", country: "DE", taxNumber: "not-a-vat-id" });
  assert.equal(junk.reverseCharge, false);
  assert.equal(junk.percent, 19);
});

test("a seller we have no regime for IS approximate", async () => {
  // A US-established seller: we cannot compute their domestic rate either, so 0%
  // would be a guess rather than a rule. That is the case the refusal is for.
  const us = await resolveTax({ originCountry: "US", country: "US", state: "IL" });
  assert.equal(us.approximate, true);
  assert.equal(us.outOfScope, undefined);
  // No rate AT ALL, which is stronger than the previous behaviour: the old source
  // returned Illinois' 6.25% and relied on the flag to say "incomplete". Now there
  // is no number to leak past the flag if a caller forgets to check it.
  assert.equal(us.percent, 0);
  assert.equal(us.type, "none");

  const it = await resolveTax({ originCountry: "FR", country: "IT" });
  assert.equal(it.approximate, undefined, "EU VAT is one published rate per country");
  assert.equal(it.percent, 22);
  // The country's own word for it, from the dataset rather than an app-side map.
  assert.equal(it.displayName, "IVA");
  assert.equal((await resolveTax({ originCountry: "IT", country: "FR" })).displayName, "TVA");
});

test("minting a rate from an approximate decision throws, and says what to do", async () => {
  await assert.rejects(
    () => taxRatesFor({ originCountry: "US", country: "US", state: "IL" }),
    (e) => {
      assert.ok(e instanceof ApproximateTaxError, "should be the typed error");
      // The message has to carry the numbers: "approximate" alone does not convey
      // that the gap is four percentage points.
      assert.match(e.message, /Chicago/);
      // Both ways out, because a refusal that names no alternative is just a wall.
      assert.match(e.message, /mode: "stripe"/);
      assert.match(e.message, /registrations/);
      return true;
    },
  );
});

test("the refusal has NO override flag, and that is deliberate", async () => {
  // `allowApproximate` was removed rather than kept. It only ever fired where tax IS
  // due and no rate exists, and by then it had exactly two effects: where you are not
  // registered, `registrations` already answers 0% completely and needs no flag; where
  // you ARE registered, suppressing this invoices 0% on tax you owe — the one
  // unrecoverable direction. A flag whose only remaining use is silent under-collection
  // is a footgun, so the escape hatches are the two that assert something.
  await assert.rejects(
    () => taxRatesFor({ originCountry: "US", country: "US", state: "IL", allowApproximate: true }),
    ApproximateTaxError,
    "a stale allowApproximate must not still suppress the refusal",
  );

  // And the honest way through, for a seller with no US nexus: say so.
  await assert.doesNotReject(() =>
    taxRatesFor({ originCountry: "US", country: "US", state: "IL", registrations: [] }),
  );
});

// ── OSS: whose rate a cross-border EU sale carries without a VAT id ──────────
//
// Reverse charge needs a VALID VAT number. Without one the sale is not
// reverse-chargeable and has to be taxed somewhere, and which somewhere depends on
// a registration this library cannot see:
//
//   OSS-registered      → the CUSTOMER's rate (the rule above €10 000)
//   not registered      → YOUR OWN rate (what the sub-threshold regime allows, and
//                         the only rate you can actually remit)
//
// Charging the customer's rate while unregistered collects VAT with nowhere to pay
// it over — the mirror of under-collecting, awkward in a different way. It is a real
// case for a B2B seller: a customer below its own registration threshold, a typo, or
// VIES unreachable, where this library charges rather than exempts.

test("without a valid VAT id, oss decides whose rate applies", async () => {
  const registered = await resolveTax({ originCountry: "IT", country: "DE" });
  assert.equal(registered.percent, 19, "OSS-registered: the customer's rate");
  assert.equal(registered.displayName, "MwSt");

  const not = await resolveTax({ originCountry: "IT", country: "DE", oss: false });
  assert.equal(not.percent, 22, "not registered: your own rate");
  // The NAME has to follow the rate, or the invoice says MwSt above an Italian figure.
  assert.equal(not.displayName, "IVA");
});

test("oss defaults to registered, because that is the rule once you are over", async () => {
  const [dflt, explicit] = await Promise.all([
    resolveTax({ originCountry: "IT", country: "DE" }),
    resolveTax({ originCountry: "IT", country: "DE", oss: true }),
  ]);
  assert.equal(dflt.percent, explicit.percent);
});

test("oss: false moves nothing else", async () => {
  // Domestic is domestic, a valid id still reverse charges, and outside the EU is
  // still out of scope. If any of those moved, the option would be doing too much.
  const domestic = await resolveTax({ originCountry: "IT", country: "IT", oss: false });
  assert.equal(domestic.percent, 22);
  assert.equal(domestic.reverseCharge, false);

  viesSays(true);
  const reverse = await resolveTax({
    originCountry: "IT",
    country: "DE",
    taxNumber: "DE143454214",
    oss: false,
  });
  assert.equal(reverse.reverseCharge, true);
  assert.equal(reverse.percent, 0);

  const export_ = await resolveTax({ originCountry: "IT", country: "US", oss: false });
  assert.equal(export_.outOfScope, true);
  assert.equal(export_.percent, 0);
});
