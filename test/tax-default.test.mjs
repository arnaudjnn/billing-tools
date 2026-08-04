// The tax DEFAULT, which changed in 4.x: configuring nothing now means
// `"local"` — this library's own eu-vat-rates-data + VIES calculation, applied as
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
import { stripeList } from "./helpers.mjs";

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

// ── Where tax is due but no rate exists, the charge is REFUSED ───────────────
//
// The rate dataset is European-only, so there is no US figure here to fall back to —
// and a state-level one would be wrong anyway: US sales tax is destination-based
// across 13 000+ jurisdictions, with counties, cities and districts stacking on the
// state rate, and SaaS taxable in some states and not others. Illinois reads 6.25%
// where a Chicago buyer owes ~10.25%.
//
// So nothing is silently applied. Under-collection is the one direction that is not
// recoverable — the customer is gone and the difference is yours, with interest —
// while a charge that fails with a reason can be fixed.

import {
  ApproximateTaxError,
  __setVatValidatorForTests,
  invalidateVatNumbers,
  resolveTax,
  taxRatesFor,
} from "../dist/tax.js";

// Reverse charge needs a VALID VAT number, and "valid" is a live VIES answer about a
// real company. These tests used to ask the European Commission, which broke the
// suite's offline contract (vitest.config.ts) and went red whenever a member state's
// node was down — the exact outage the charge-rather-than-exempt fallback exists for.
//
// The bare reset installs a validator that REFUSES (see `__setVatValidatorForTests`),
// so a test written with a `taxNumber` and no stub fails deterministically instead of
// quietly re-arming the network. The local format check is not stubbed and still runs.
//
// Clearing the verified-number cache is not optional: a positive is remembered for a
// day, so without this a number confirmed by one test would still be confirmed in the
// next, and `viesSays(false)` would pass for the wrong reason.
__setVatValidatorForTests();
afterEach(() => {
  __setVatValidatorForTests();
  invalidateVatNumbers();
});
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

test("a SMALL-BUSINESS EXEMPTION charges nothing, including to EU consumers", async () => {
  // France's franchise en base (art. 293 B CGI) and its equivalents: below the
  // threshold you are not VAT-registered, so you charge 0% — and `registrations: []`
  // is how that is said. Domestic already worked; the EU cross-border B2C leg did
  // NOT, because it read `oss` and bypassed registrations, so a French
  // micro-entreprise invoiced 20% TVA to every EU consumer. That is VAT it is not
  // registered to collect and cannot remit.
  const franchise = { registrations: [], oss: false };

  const domestic = await resolveTax({ originCountry: "FR", country: "FR", ...franchise });
  assert.equal(domestic.percent, 0, "no VAT at home");
  assert.equal(domestic.outOfScope, true);

  const euConsumer = await resolveTax({ originCountry: "FR", country: "DE", ...franchise });
  assert.equal(euConsumer.percent, 0, "and none to an EU consumer either");
  assert.equal(euConsumer.outOfScope, true);

  // Non-EU is unchanged, and an EU BUSINESS still reverse-charges — the exemption is
  // about whether WE charge, not about who accounts for the tax.
  assert.equal((await resolveTax({ originCountry: "FR", country: "US", ...franchise })).percent, 0);
  viesSays(true);
  const b2b = await resolveTax({
    originCountry: "FR",
    country: "DE",
    taxNumber: "DE143454214",
    ...franchise,
  });
  assert.equal(b2b.reverseCharge, true);

  // Crossing €10 000 means registering for OSS, and then the CUSTOMER's rate applies
  // even though domestic sales stay exempt. `oss: true` is that switch.
  const overThreshold = await resolveTax({
    originCountry: "FR",
    country: "DE",
    registrations: [],
    oss: true,
  });
  assert.equal(overThreshold.percent, 19, "OSS-registered: the customer's rate");
});

test("an EXEMPT sale carries its mandatory wording onto the invoice", async () => {
  // An untaxed sale normally carries no tax line — nothing to show. But France fines
  // €15 per invoice missing "TVA non applicable, art. 293 B du CGI", so a regime that
  // requires the mention needs a line to put it on. Supplying `notes.exempt` mints a
  // 0% rate carrying it; supplying nothing keeps today's behaviour exactly.
  const minted = [];
  __setStripeForTests({
    taxRates: {
      list: () => stripeList([]),
      async create(params) {
        minted.push(params);
        return { id: `txr_${minted.length}`, ...params };
      },
    },
  });

  const franchise = { originCountry: "FR", country: "FR", registrations: [], oss: false };

  // Without wording: no rate, no line — unchanged for every existing deployment.
  const bare = await taxRatesFor(franchise);
  assert.equal(bare.rateIds.length, 0);
  assert.equal(minted.length, 0, "an untaxed sale must not invent a tax line unasked");

  // With wording: a 0% rate carrying the mention.
  const noted = await taxRatesFor({
    ...franchise,
    notes: { exempt: "TVA non applicable, art. 293 B du CGI" },
  });
  assert.equal(noted.rateIds.length, 1);
  assert.equal(minted.length, 1);
  assert.equal(minted[0].percentage, 0, "the mention must not add tax");
  assert.equal(minted[0].display_name, "TVA non applicable, art. 293 B du CGI");
  assert.ok(
    minted[0].display_name.length <= 50,
    "Stripe caps a TaxRate display name at 50 chars",
  );

  // And reverse charge takes its own wording — "Reverse charge" is not the mention a
  // French seller must print.
  viesSays(true);
  const rc = await taxRatesFor({
    originCountry: "FR",
    country: "DE",
    taxNumber: "DE143454214",
    registrations: [],
    notes: { exempt: "unused here", reverseCharge: "Autoliquidation, art. 196" },
  });
  assert.equal(rc.decision.reverseCharge, true);
  assert.equal(minted.at(-1).display_name, "Autoliquidation, art. 196");
  assert.equal(minted.at(-1).percentage, 0);
});

test("declaring a registration AT ORIGIN still charges your own rate", async () => {
  // The other half: a VAT-registered French seller that is not OSS-registered charges
  // its own 20% on a cross-border EU B2C sale, which is the sub-€10 000 regime.
  const registered = await resolveTax({
    originCountry: "FR",
    country: "DE",
    registrations: [{ country: "FR" }],
    oss: false,
  });
  assert.equal(registered.percent, 20);

  // And omitting registrations entirely is unchanged for every existing deployment.
  const undeclared = await resolveTax({ originCountry: "FR", country: "DE", oss: false });
  assert.equal(undeclared.percent, 20);
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
  const junk = await resolveTax({ originCountry: "IT", country: "DE", taxNumber: "DE-not-a-number" });
  assert.equal(junk.reverseCharge, false);
  assert.equal(junk.percent, 19);
});

test("a confirmed VAT number is remembered; a refusal is NOT", async () => {
  // The asymmetry is the design. A registration VIES confirmed does not stop being
  // real, so re-asking costs a request and can only change the answer for the worse —
  // VIES going down would turn a verified B2B customer back into a taxed one.
  let asked = 0;
  __setVatValidatorForTests(async () => {
    asked++;
    return true;
  });
  const charge = () => resolveTax({ originCountry: "IT", country: "DE", taxNumber: "DE143454214" });
  assert.equal((await charge()).reverseCharge, true);
  assert.equal((await charge()).reverseCharge, true);
  assert.equal(asked, 1, "a confirmed number must not be re-validated on every charge");

  // A NEGATIVE is never cached. "Not valid" conflates "no such number" with "that
  // member state is unreachable", and the second is temporary — storing it would
  // extend one outage's over-charging for the whole TTL, long past the outage.
  invalidateVatNumbers();
  let refusals = 0;
  __setVatValidatorForTests(async () => {
    refusals++;
    return false;
  });
  assert.equal((await charge()).reverseCharge, false);
  assert.equal((await charge()).reverseCharge, false);
  assert.equal(refusals, 2, "a refusal must be retried, since it may have been an outage");
});

test("the VAT id must belong to the country the customer is IN", async () => {
  // Self-serve VAT avoidance, until now. Reverse charge is for a taxable person
  // established in ANOTHER member state and the VAT number is the evidence of where,
  // so a German address presenting an Italian id is a contradiction, not a German
  // business. An Italian company typing a German address alongside its own real
  // Italian number was zero-rated by a seller who owed 22% on the sale.
  viesSays(true); // even a number VIES fully confirms must not do this
  const mismatch = await resolveTax({
    originCountry: "IT",
    country: "DE",
    taxNumber: "IT12345678901",
  });
  assert.equal(mismatch.reverseCharge, false, "an Italian id is not evidence of a German business");
  assert.equal(mismatch.percent, 19, "so the sale is taxed, which is the recoverable direction");

  // The matching case is untouched.
  const ok = await resolveTax({ originCountry: "IT", country: "DE", taxNumber: "DE143454214" });
  assert.equal(ok.reverseCharge, true);
});

test("GREECE reverse-charges, despite filing under EL and being keyed GR", async () => {
  // The dataset keys Greece as GR but writes its pattern as `^EL\\d{9}$` — the only
  // entry carrying the prefix the others omit — so its own `validateFormat` rejects
  // every spelling of a Greek number. Unhandled, that silently withdrew reverse charge
  // from one member state: every Greek business charged VAT it should not have paid.
  viesSays(true);
  for (const taxNumber of ["EL123456789", "GR123456789", "el 123 456 789"]) {
    const d = await resolveTax({ originCountry: "IT", country: "GR", taxNumber });
    assert.equal(d.reverseCharge, true, `${taxNumber} should reverse charge`);
    assert.equal(d.percent, 0);
  }

  // VIES is routed on EL, whichever spelling arrived — it has no member state "GR".
  // Cleared first: the loop above already confirmed this number, and a confirmed one
  // is not asked about again.
  invalidateVatNumbers();
  const asked = [];
  __setVatValidatorForTests(async (vat) => {
    asked.push(vat);
    return true;
  });
  await resolveTax({ originCountry: "IT", country: "GR", taxNumber: "GR123456789" });
  assert.deepEqual(asked, ["EL123456789"]);

  // And a Greek number of the wrong LENGTH is still refused locally.
  __setVatValidatorForTests(async () => {
    throw new Error("VIES must not be asked about rubbish");
  });
  const short = await resolveTax({ originCountry: "IT", country: "GR", taxNumber: "EL12345" });
  assert.equal(short.reverseCharge, false);
  assert.equal(short.percent, 24, "the Greek standard rate is charged instead");
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

test("the refusal has NO override flag — you say where you are registered instead", async () => {
  // Nothing suppresses it, because a flag that did could only ever under-collect
  // silently. The honest way through, for a seller with no US nexus, is to say so.
  await assert.doesNotReject(() =>
    taxRatesFor({ originCountry: "US", country: "US", state: "IL", registrations: [] }),
  );
  // And declaring nexus there does NOT buy a pass — there is still no US rate.
  await assert.rejects(
    () =>
      taxRatesFor({
        originCountry: "US",
        country: "US",
        state: "IL",
        registrations: [{ country: "US", state: "IL" }],
      }),
    ApproximateTaxError,
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
