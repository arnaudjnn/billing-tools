// WHO calculates: `local`, `stripe`, `external`, `none` — and the two properties that
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
import { numeralTax } from "../dist/tax-numeral.js";
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
      assert.match(e.message, /numeralTax/);
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
  assert.doesNotThrow(() =>
    resolveConfig({ ...base, tax: { mode: "external", origin: "US", calculate: () => null } }),
  );
  // And a covered origin on local is untouched.
  assert.doesNotThrow(() => resolveConfig({ ...base, tax: { origin: "FR" } }));
  assert.doesNotThrow(() => resolveConfig({ ...base, tax: undefined }));
});

test("`external` applies the provider's answer as a Stripe TaxRate", async () => {
  invalidateTaxOrigin();
  invalidateTaxRates();
  const minted = [];
  __setStripeForTests({
    accounts: { retrieve: async () => ({ id: "acct", country: "US" }) },
    customers: {
      retrieve: async () => ({
        deleted: false,
        address: { country: "US", state: "NY", postal_code: "10001" },
        tax_ids: { data: [] },
      }),
    },
    taxRates: {
      list: () => stripeList([]),
      create: async (p) => {
        minted.push(p);
        return { id: `txr_${minted.length}`, ...p };
      },
    },
  });

  const seen = [];
  const out = await taxFor("cus_1", {
    mode: "external",
    origin: "US",
    calculate: (input) => {
      seen.push(input);
      return { percent: 8.875, displayName: "New York City", country: "US" };
    },
  });

  assert.deepEqual(out, { taxRates: ["txr_1"] });
  assert.equal(minted[0].percentage, 8.875);
  assert.equal(minted[0].display_name, "New York City");
  // The postal code is threaded through, because US tax is destination-based below the
  // state and a provider given only "NY" cannot answer for a city surcharge.
  assert.equal(seen[0].postalCode, "10001");
  assert.equal(seen[0].state, "NY");
  assert.equal(seen[0].customerId, "cus_1");
});

test("a provider that throws REFUSES the charge rather than untaxing it", async () => {
  invalidateTaxOrigin();
  __setStripeForTests({
    accounts: { retrieve: async () => ({ id: "acct", country: "US" }) },
    customers: {
      retrieve: async () => ({ deleted: false, address: { country: "US" }, tax_ids: { data: [] } }),
    },
    taxRates: { list: () => stripeList([]), create: async (p) => ({ id: "txr_x", ...p }) },
  });
  await assert.rejects(
    () =>
      taxFor("cus_1", {
        mode: "external",
        calculate: () => {
          throw new Error("provider down");
        },
      }),
    /provider down/,
    "a 0% invoice is the failure nobody notices; the exception is the point",
  );
});

test("numeralTax refuses on a bad response instead of assuming 0%", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ tax_rate: 6.25, jurisdiction: "Texas" }) };
  };
  const calc = numeralTax({ apiKey: "key_123", fetch: fetchStub });
  const ok = await calc({ customerId: "cus_1", country: "US", state: "TX", postalCode: "78701" });
  assert.equal(ok.percent, 6.25);
  assert.equal(ok.displayName, "Texas");
  assert.equal(calls[0].auth, "Bearer key_123");
  assert.equal(calls[0].body.address.postal_code, "78701");

  // A 500 must not read as untaxed.
  const failing = numeralTax({
    apiKey: "k",
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(() => failing({ customerId: "c", country: "US" }), /503/);

  // Neither must a 200 with no rate in it — the shape changing is not a 0% sale.
  const empty = numeralTax({
    apiKey: "k",
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  await assert.rejects(() => empty({ customerId: "c", country: "US" }), /Refusing rather than/);

  // And no address is refused before the network is touched at all.
  const unreached = numeralTax({
    apiKey: "k",
    fetch: async () => {
      throw new Error("must not be called without a destination");
    },
  });
  await assert.rejects(() => unreached({ customerId: "c" }), /no address on file/);
});
