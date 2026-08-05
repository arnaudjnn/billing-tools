// What a seller charges, at each stage a European small business actually goes through.
//
// The engine could already express all of this — `registrations` plus `oss` do it —
// but reaching the right state meant knowing that omitting your own country from
// `registrations` is how you say the domestic supply is exempt, and that `oss` unions
// the member states in independently of that list. `sellerRegime` maps the three facts
// a seller knows onto the same object, and this pins the OUTCOME of each, because a
// helper that produced a plausible-looking config would be worse than none.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { sellerRegime } from "../dist/tax-regime.js";
import { resolveTax, __setVatValidatorForTests } from "../dist/tax.js";

/** A properly formatted id per country — a malformed one is correctly read as a
 *  CONSUMER, so using e.g. "IT123" would silently test the wrong branch. */
const B2B = { IT: "IT12345678901", DE: "DE123456789", FR: "FR12345678901" };

async function charged(regime, who) {
  __setVatValidatorForTests(async () => true);
  const tax = sellerRegime(regime);
  const d = await resolveTax({
    originCountry: tax.origin,
    registrations: tax.registrations,
    oss: tax.oss,
    ...who,
  });
  return { percent: d.percent, rc: d.reverseCharge === true, approx: d.approximate === true };
}

// ── Stage 1: franchise en base, registered nowhere ───────────────────────────
test("a small business registered nowhere charges nobody, anywhere", async () => {
  const FR_MICRO = { country: "FR", vatRegistered: false };

  for (const who of [{ country: "FR" }, { country: "IT" }, { country: "DE" }, { country: "GB" }, { country: "US", state: "CA" }]) {
    const r = await charged(FR_MICRO, who);
    assert.equal(r.percent, 0, `${who.country} should be 0% under the franchise`);
    // Nothing is "approximate": the config asserts there is no obligation anywhere, so
    // the engine has nothing to refuse. That is the trade — see the docs.
    assert.equal(r.approx, false);
  }

  // An EU business with a valid id is still reverse-charged, which is what puts the
  // mandatory "art. 196" mention on the invoice. Reverse charge does NOT require the
  // seller to be VAT-registered — the customer self-accounts.
  const b2b = await charged(FR_MICRO, { country: "IT", taxNumber: B2B.IT });
  assert.equal(b2b.percent, 0);
  assert.equal(b2b.rc, true, "an EU B2B sale must be reverse-charged, franchise or not");
});

// ── Stage 2: past €10 000 of EU B2C → OSS, still exempt at home ──────────────
test("OSS charges destination rates abroad while the domestic supply stays exempt", async () => {
  const FR_MICRO_OSS = { country: "FR", vatRegistered: false, oss: true };

  // The state that was supposedly inexpressible: exempt at home, destination abroad.
  assert.equal((await charged(FR_MICRO_OSS, { country: "FR" })).percent, 0, "the franchise still applies at home");
  assert.equal((await charged(FR_MICRO_OSS, { country: "IT" })).percent, 22);
  assert.equal((await charged(FR_MICRO_OSS, { country: "DE" })).percent, 19);

  // B2B is unaffected — place of supply is the customer either way.
  const b2b = await charged(FR_MICRO_OSS, { country: "DE", taxNumber: B2B.DE });
  assert.equal(b2b.rc, true);
  assert.equal(b2b.percent, 0);

  // And OSS covers the EU only: a UK consumer is still nothing until the UK is declared.
  assert.equal((await charged(FR_MICRO_OSS, { country: "GB" })).percent, 0);
});

// ── Stage 3: UK-registered, which has no threshold for a non-established seller ──
test("a UK registration charges UK consumers 20% from the first sale", async () => {
  const WITH_UK = { country: "FR", vatRegistered: false, oss: true, alsoCollectIn: [{ country: "GB" }] };

  assert.equal((await charged(WITH_UK, { country: "GB" })).percent, 20, "UK B2C must be 20% once registered");
  // Everything else is unchanged by adding a UK registration.
  assert.equal((await charged(WITH_UK, { country: "FR" })).percent, 0);
  assert.equal((await charged(WITH_UK, { country: "IT" })).percent, 22);
  assert.equal((await charged(WITH_UK, { country: "US", state: "CA" })).percent, 0);
});

// ── Stage 4: fully VAT-registered at home ───────────────────────────────────
test("registering at home turns the domestic rate on, and nothing else", async () => {
  const exempt = { country: "FR", vatRegistered: false, oss: true };
  const registered = { country: "FR", vatRegistered: true, oss: true };

  assert.equal((await charged(exempt, { country: "FR" })).percent, 0);
  assert.equal((await charged(registered, { country: "FR" })).percent, 20, "France's standard rate");
  // The cross-border answers are identical: `vatRegistered` is a DOMESTIC fact.
  for (const who of [{ country: "IT" }, { country: "DE" }, { country: "GB" }]) {
    assert.equal(
      (await charged(exempt, who)).percent,
      (await charged(registered, who)).percent,
      `${who.country} must not depend on the domestic registration`,
    );
  }
});

// ── The mapping itself ──────────────────────────────────────────────────────
test("the config it produces is the one you would have written by hand", async () => {
  // Exempt at home: the domestic country is ABSENT from `registrations`. That is the
  // whole trick, and the reason a helper is worth having.
  assert.deepEqual(sellerRegime({ country: "FR", vatRegistered: false }), {
    mode: "local",
    origin: "FR",
    registrations: [],
    oss: false,
  });

  // Registered at home: present.
  assert.deepEqual(sellerRegime({ country: "IT", vatRegistered: true, oss: true }), {
    mode: "local",
    origin: "IT",
    registrations: [{ country: "IT" }],
    oss: true,
  });

  // `alsoCollectIn` is appended, and a US nexus keeps its state.
  const us = sellerRegime({
    country: "FR",
    vatRegistered: false,
    alsoCollectIn: [{ country: "GB" }, { country: "US", state: "CA" }],
    notes: { exempt: "TVA non applicable, art. 293 B du CGI" },
  });
  assert.deepEqual(us.registrations, [{ country: "GB" }, { country: "US", state: "CA" }]);
  assert.equal(us.notes.exempt, "TVA non applicable, art. 293 B du CGI");
});
