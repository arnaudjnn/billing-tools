// Internal orgs are unmetered: an org with a domain in `config.internalDomains` runs every
// paid tool without touching the wallet, the usage ledger, the rate limits or the alerts.
//
// It is the one switch that turns billing OFF for an org, so both directions matter. Too
// narrow and the operator's own workspace is billed (scartoffie runs its test workspace on
// it); too wide and a customer is. The wide failures are the ones this file pins: a domain
// that is merely CLAIMED (pending, failed) is not ownership, and an org with no domains at
// all — an anonymous auth.md registration — must never match anything.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { OrganizationDomainState } from "@workos-inc/node";

import { enforceCredits, isInternalOrg } from "../dist/auth.js";
import { __setStripeForTests } from "../dist/billing.js";
import { meterUsage } from "../dist/metering.js";
import { internalDomainsFromEnv, resolveConfig } from "../dist/types.js";
import { __setWorkOSForTests } from "../dist/workos.js";
import { WorkOSOrgAdapter } from "../dist/adapters/workos-org.js";
import { fakeAdapter, testConfig } from "./helpers.mjs";

/** A Stripe that fails the test on ANY use: an internal org must not reach it. */
function untouchableStripe() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        throw new Error(`Stripe touched (${String(prop)}) for an internal org`);
      },
    },
  );
}

/** An adapter whose org reports `domains`, and which records every billing read. */
function adapterWithDomains(domains) {
  const a = fakeAdapter();
  a.reads = { customer: 0, domains: 0 };
  a.getOrgDomains = async () => {
    a.reads.domains++;
    return domains;
  };
  a.getBillingCustomerId = async () => {
    a.reads.customer++;
    return "cus_test";
  };
  return a;
}

const ENV = "INTERNAL_ORG_DOMAINS";
let savedEnv;
beforeEach(() => {
  savedEnv = process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  __setStripeForTests(undefined);
  __setWorkOSForTests(null);
});

// ── isInternalOrg ────────────────────────────────────────────────────────────

test("a matching domain is internal, compared without case", async () => {
  assert.equal(await isInternalOrg(adapterWithDomains(["Scartoffie.IT"]), "org_1", ["scartoffie.it"]), true);
  assert.equal(await isInternalOrg(adapterWithDomains(["scartoffie.it"]), "org_1", ["SCARTOFFIE.it"]), true);
});

test("any one of several configured domains is enough", async () => {
  const list = ["acme.com", "scartoffie.it", "example.org"];
  assert.equal(await isInternalOrg(adapterWithDomains(["example.org"]), "org_1", list), true);
  assert.equal(await isInternalOrg(adapterWithDomains(["customer.io"]), "org_1", list), false);
});

test("a domain is matched exactly — a subdomain or a lookalike is a different org", async () => {
  const list = ["scartoffie.it"];
  for (const d of ["app.scartoffie.it", "scartoffie.it.evil.com", "notscartoffie.it"]) {
    assert.equal(await isInternalOrg(adapterWithDomains([d]), "org_1", list), false, d);
  }
});

test("no configured domains: nothing is internal, and the adapter is not even asked", async () => {
  const a = adapterWithDomains(["scartoffie.it"]);
  assert.equal(await isInternalOrg(a, "org_1", []), false);
  assert.equal(a.reads.domains, 0);
});

test("a config list handed in raw is normalised the way the env list is", async () => {
  // REGRESSION: `internalDomainsFromEnv` trims, but `config.internalDomains` was compared
  // as given — so " scartoffie.it" (a hand-built list) matched nothing.
  assert.equal(await isInternalOrg(adapterWithDomains(["scartoffie.it"]), "org_1", [" Scartoffie.it "]), true);
});

test("an org with no domains — an anonymous or accountless one — is never internal", async () => {
  assert.equal(await isInternalOrg(adapterWithDomains([]), "org_anon", ["scartoffie.it"]), false);
  // REGRESSION: an empty entry in a hand-built list (a trailing comma, split by the app
  // itself) used to sit in the set as "", so an org reporting an empty domain matched it.
  assert.equal(await isInternalOrg(adapterWithDomains([""]), "org_anon", ["", " "]), false);
  assert.equal(await isInternalOrg(adapterWithDomains([""]), "org_anon", ["scartoffie.it", ""]), false);
});

// ── internalDomainsFromEnv ───────────────────────────────────────────────────

test("the env list is split on commas, trimmed, lowercased, de-duplicated", () => {
  process.env[ENV] = " Scartoffie.it, acme.com ,,ACME.com,  ";
  assert.deepEqual(internalDomainsFromEnv(), ["scartoffie.it", "acme.com"]);
});

test("the root domain leads, and is not repeated when the env names it too", () => {
  process.env[ENV] = "acme.com,Example.org";
  assert.deepEqual(internalDomainsFromEnv(" Example.ORG "), ["example.org", "acme.com"]);
});

test("unset or empty env is an empty list — never a list holding an empty string", () => {
  delete process.env[ENV];
  assert.deepEqual(internalDomainsFromEnv(), []);
  process.env[ENV] = "";
  assert.deepEqual(internalDomainsFromEnv(), []);
  process.env[ENV] = " , ,";
  assert.deepEqual(internalDomainsFromEnv(null), []);
});

test("a custom env var name is read instead of the default", () => {
  process.env[ENV] = "wrong.com";
  process.env.MY_INTERNAL = "right.com";
  try {
    assert.deepEqual(internalDomainsFromEnv(undefined, "MY_INTERNAL"), ["right.com"]);
  } finally {
    delete process.env.MY_INTERNAL;
  }
});

test("resolveConfig carries the list through, and defaults it to empty", () => {
  assert.deepEqual(resolveConfig({}).internalDomains, []);
  assert.deepEqual(resolveConfig({ internalDomains: ["acme.com"] }).internalDomains, ["acme.com"]);
});

// ── WorkOSOrgAdapter: only a VERIFIED domain is ownership ────────────────────

function workosWithDomains(domains) {
  return {
    organizations: {
      async getOrganization(id) {
        return { id, domains, metadata: {} };
      },
    },
  };
}

test("a verified domain unlocks the internal path; pending and failed do not", async () => {
  __setWorkOSForTests(
    workosWithDomains([
      { domain: "pending.scartoffie.it", state: OrganizationDomainState.Pending },
      { domain: "failed.scartoffie.it", state: OrganizationDomainState.Failed },
      { domain: "scartoffie.it", state: OrganizationDomainState.Verified },
    ]),
  );
  const adapter = new WorkOSOrgAdapter();
  assert.deepEqual(await adapter.getOrgDomains("org_1"), ["scartoffie.it"]);
  assert.equal(await isInternalOrg(adapter, "org_1", ["scartoffie.it"]), true);
  assert.equal(await isInternalOrg(adapter, "org_1", ["pending.scartoffie.it"]), false);
  assert.equal(await isInternalOrg(adapter, "org_1", ["failed.scartoffie.it"]), false);
});

test("an org that merely CLAIMS the domain is metered — anyone can add a pending domain", async () => {
  __setWorkOSForTests(
    workosWithDomains([{ domain: "scartoffie.it", state: OrganizationDomainState.Pending }]),
  );
  assert.equal(await isInternalOrg(new WorkOSOrgAdapter(), "org_1", ["scartoffie.it"]), false);
});

// ── enforceCredits: the early return has no side effects ─────────────────────

test("enforceCredits lets an internal org through without reading or writing billing", async () => {
  __setStripeForTests(untouchableStripe());
  const a = adapterWithDomains(["scartoffie.it"]);
  const config = { ...testConfig, internalDomains: ["scartoffie.it"] };

  assert.equal(await enforceCredits(a, config, "org_1", "search", 50), null);
  assert.equal(a.reads.customer, 0, "no billing customer lookup");
});

test("enforceCredits meters the same org once its domain is not on the list", async () => {
  // The control for the test above: same adapter, same Stripe fake, a different list —
  // proving it is the domain that skipped the charge and not something else.
  __setStripeForTests(untouchableStripe());
  const a = adapterWithDomains(["scartoffie.it"]);
  await assert.rejects(
    enforceCredits(a, { ...testConfig, internalDomains: ["other.com"] }, "org_1", "search", 50),
    /Stripe touched/,
  );
  assert.equal(a.reads.customer, 1);
});

// ── meterUsage: no ledger, no wallet, no rate limit, no alert ────────────────

const PLANS = {
  team: {
    sells: { kind: "flat", price: { monthly: 1000 } },
    cap: { kind: "pool", credits: 10 },
    limits: { rate: [{ window: "minute", max: 1 }] },
  },
};

function recordingLedger() {
  const records = [];
  return {
    records,
    async record(r) {
      records.push(r);
    },
    async usage() {
      throw new Error("ledger read for an internal org");
    },
  };
}

test("meterUsage: an internal org is funded by nobody and recorded nowhere", async () => {
  __setStripeForTests(untouchableStripe());
  const a = adapterWithDomains(["scartoffie.it"]);
  const ledger = recordingLedger();
  const notified = [];
  const config = { ...testConfig, internalDomains: ["scartoffie.it"] };

  // Far beyond the pool (10) and the rate limit (1 per minute), many times over.
  for (let i = 0; i < 5; i++) {
    const r = await meterUsage(a, config, {
      orgId: "org_1",
      action: "search",
      cost: 1_000,
      plans: PLANS,
      plan: "team",
      ledger,
      caller: { kind: "api", id: "key_1" },
      notify: async (n) => notified.push(n),
      alertThresholds: [1],
    });
    assert.deepEqual(r, { ok: true, funded: null });
  }
  assert.equal(ledger.records.length, 0, "nothing recorded in the usage ledger");
  assert.equal(notified.length, 0, "no alert sent");
  assert.equal(a.reads.customer, 0, "no billing customer lookup");
  assert.equal(a.calls.setOrgMetadata, 0, "no metadata write");
});

test("meterUsage meters a non-internal org with the same inputs", async () => {
  __setStripeForTests(untouchableStripe());
  const a = adapterWithDomains(["customer.io"]);
  const r = meterUsage(a, { ...testConfig, internalDomains: ["scartoffie.it"] }, {
    orgId: "org_1",
    action: "search",
    cost: 1,
    plans: PLANS,
    plan: "team",
    ledger: recordingLedger(),
  });
  // It gets as far as billing — which is the point; the fakes refuse to go further.
  await assert.rejects(r);
  assert.equal(a.reads.customer, 1);
});
