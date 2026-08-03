// Per-member usage counted in Stripe, with no database — measured end to end.
//
// The claim under test is the one that decides whether a deployment needs a
// store at all: a window that is both INCLUDED and PER-MEMBER can be counted by
// Stripe, exactly, for every scope the library asks about.
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/e2e-scope-ledger.mjs
//
// Uses the REAL `stripeScopeUsageLedger` from dist, not a hand-rolled copy, so
// what passes here is what ships. Run `npm run build` first.
//
// Two things it also puts a number on, both of which shape the design:
//
//   • the write costs less than the org write already does (one v2 stream request
//     carries every scope);
//   • a meter summary lags aggregation by roughly a minute, which is why
//     WALLET-funded usage deliberately does NOT go through this path — the debits
//     answer that half exactly and with no lag.

import Stripe from "stripe";

import { __setStripeForTests } from "../dist/billing.js";
import { invalidateMeters } from "../dist/usage-ledger.js";
import { stripeScopeUsageLedger, USAGE_SCOPE_KIND } from "../dist/usage-scopes.js";

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY?.startsWith("sk_test")) {
  console.error("Needs a TEST-mode STRIPE_SECRET_KEY.");
  process.exit(1);
}
const stripe = new Stripe(KEY);
__setStripeForTests(stripe);
invalidateMeters();

const ORG = `org_e2e_${Math.floor(Date.now() / 1000)}`;
const log = (...a) => console.log(...a);

// Wallet-funded usage is the OTHER leg's job (balance transactions). Stubbed to
// zero here so the figures below are purely what the scope meter counted.
const ledger = stripeScopeUsageLedger({
  wallet: { covers: { orgIncluded: false, callerIncluded: false }, async record() {}, async total() { return 0; } },
});

// Two people and two API keys in one workspace — the shape a seat pack plus a
// per-key rate limit actually has.
const CALLS = [
  { caller: { kind: "user", id: "usr_alice" }, cost: 10 },
  { caller: { kind: "user", id: "usr_alice" }, cost: 5 },
  { caller: { kind: "user", id: "usr_bob" }, cost: 7 },
  { caller: { kind: "api", id: "key_1" }, cost: 3 },
  { caller: { kind: "api", id: "key_2" }, cost: 4 },
];

log(`org ${ORG}`);
const cold = Date.now();
await ledger.record({ orgId: ORG, customerId: "cus_org", action: "search", funded: "pack", ...CALLS[0] });
log(`  first record (cold: resolves the meter + 2 scope customers) ${Date.now() - cold}ms`);

const warm = Date.now();
for (const c of CALLS.slice(1)) {
  await ledger.record({ orgId: ORG, customerId: "cus_org", action: "search", funded: "pack", ...c });
}
log(`  ${CALLS.length - 1} warm records ${Date.now() - warm}ms (${Math.round((Date.now() - warm) / (CALLS.length - 1))}ms each)`);

// `org` is deliberately absent: the composite's meter leg owns it, on the org's
// real customer, and this leg never writes there.
const EXPECT = {
  "k:user": [{ callerKind: "user" }, 22],
  "k:api": [{ callerKind: "api" }, 7],
  "u:usr_alice": [{ callerId: "usr_alice" }, 15],
  "u:usr_bob": [{ callerId: "usr_bob" }, 7],
  "u:key_1": [{ callerId: "key_1" }, 3],
  "u:key_2": [{ callerId: "key_2" }, 4],
};

const start = Date.now() - 10 * 60_000;
const began = Date.now();
let ok = false;
for (let i = 0; i < 40 && !ok; i++) {
  const got = {};
  await Promise.all(
    Object.entries(EXPECT).map(async ([k, [filter]]) => {
      got[k] = await ledger.total({ orgId: ORG, customerId: "cus_org", start, filter });
    }),
  );
  ok = Object.entries(EXPECT).every(([k, [, v]]) => got[k] === v);
  log(`  t+${((Date.now() - began) / 1000).toFixed(0)}s ${JSON.stringify(got)}${ok ? "  ✅ EXACT ON EVERY SCOPE" : ""}`);
  if (!ok) await new Promise((r) => setTimeout(r, 5000));
}
if (!ok) {
  console.error("\n❌ scopes never reconciled — the meter summary never caught up");
  process.exitCode = 1;
}

// The read that matters for a usage screen: one member, a cycle-wide window.
const rt = Date.now();
await ledger.total({ orgId: ORG, customerId: "cus_org", start: Date.now() - 31 * 86_400_000, filter: { callerId: "usr_alice" } });
log(`  one 31-day per-member read: ${Date.now() - rt}ms (flat — a summary is one request at any width)`);

// ── cleanup: the scopes are marked, so nothing real is touched ─────────────
let deleted = 0;
for await (const c of stripe.customers.list({ limit: 100 })) {
  if (c.metadata?.bt_kind === USAGE_SCOPE_KIND && c.metadata?.bt_usage_scope?.startsWith(ORG)) {
    await stripe.customers.del(c.id);
    deleted++;
  }
}
log(`  cleaned up ${deleted} scope customers (the meter is kept — it is account-level and reused)`);
