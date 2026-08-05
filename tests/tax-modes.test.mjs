// WHO calculates: `local`, `stripe`, `none` — and the two properties that
// make the choice safe.
//
// 1. A `local` origin the engine has no rates for is impossible to configure. The type
//    union catches it where it is written down; `resolveConfig` catches it where it is
//    inferred or cast, which the type system cannot see.
// 2. A provider that cannot answer REFUSES the charge. A tax provider returning 0%
//    because it was down is the failure nobody notices until an audit.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { resolveConfig } from "../dist/types.js";
import { LOCAL_TAX_ORIGINS, isLocalTaxOrigin } from "../dist/tax-origins.js";
import { taxFor, invalidateTaxOrigin, invalidateTaxRates } from "../dist/tax.js";
import { __setStripeForTests } from "../dist/billing.js";
import { stripeList } from "./helpers.mjs";

const base = { currency: "eur", baseUrl: "https://x.test" };

test("the local engine's origin list matches the rate dataset", async () => {
  // Hand-typed lists drift, and this one drifting is expensive in both directions: a
  // country missing here is rejected for no reason, one added here typechecks and then
  // throws on the first charge.
  const { isKnownCountry } = await import("eu-vat-rates-data");
  for (const c of LOCAL_TAX_ORIGINS) {
    assert.ok(isKnownCountry(c), `${c} is listed as a local origin but has no rates`);
  }
  assert.equal(LOCAL_TAX_ORIGINS.length, 45);
  // The ones that matter for the ban.
  for (const c of ["US", "CA", "AU", "NZ", "JP", "SG", "IN", "BR", "MX"]) {
    assert.equal(isLocalTaxOrigin(c), false, `${c} must not be a local origin`);
  }
});

test("`local` with an origin it cannot compute throws AT BOOT", () => {
  // The type union rejects `{ mode: "local", origin: "US" }` outright. This is the way
  // in the types cannot close: a cast, or a config assembled from env strings.
  assert.throws(
    () => resolveConfig({ ...base, tax: { origin: "US" } }),
    (e) => {
      assert.match(e.message, /cannot be used with mode "local"/);
      // A refusal that names no alternative is just a wall.
      assert.match(e.message, /mode: "stripe"/);
      // And it must not offer `external`, which was removed: an alternative that does
      // not exist is worse than none, because someone would go looking for it.
      assert.doesNotMatch(e.message, /mode: "external"/);
      // And it must not point at anything that does not exist — the message named a
      // `numeralTax` adapter that has since been removed for not working.
      assert.doesNotMatch(e.message, /numeralTax/);
      return true;
    },
  );
  // Not only the US — every establishment the dataset omits.
  for (const origin of ["AU", "JP", "BR"]) {
    assert.throws(() => resolveConfig({ ...base, tax: { origin } }), /mode "local"/);
  }
});

test("but the same origin is fine under every other mode", () => {
  for (const mode of ["stripe", "none"]) {
    assert.doesNotThrow(() => resolveConfig({ ...base, tax: { mode, origin: "US" } }));
  }
  // And a covered origin on local is untouched.
  assert.doesNotThrow(() => resolveConfig({ ...base, tax: { origin: "FR" } }));
  assert.doesNotThrow(() => resolveConfig({ ...base, tax: undefined }));
});
