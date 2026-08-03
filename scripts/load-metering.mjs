// How many metered calls a second can this survive, and what does the cache buy?
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/load-metering.mjs
//
// Measures the REAL read path — `resolveAllowance` over a per-seat catalogue, the
// composite ledger with `stripeScopeUsageLedger` as its per-caller leg — against a
// real Stripe account, and counts every HTTP request the SDK actually makes via
// `stripe.on("response")`. That matters because the cost is not one request per
// read: `usageSince` paginates, so a busy window is several.
//
// ── Read this before believing the throughput number ───────────────────────
//
// TEST MODE IS THE SLOWER ENVIRONMENT. Stripe allows 25 req/s in test and 100
// req/s live, with a 25 req/s per-endpoint cap in both. So the request counts here
// transfer directly, and the throughput does not: live has ~4x the global budget,
// while `listEventSummaries` — the endpoint every window read goes through — is
// capped the same in both and is what actually binds.
//
// The honest output is therefore REQUESTS PER METERED CALL. Divide 25 by that for
// the per-endpoint ceiling, which is the number that holds in production too.

import Stripe from "stripe";

import { __setStripeForTests, getStripe } from "../dist/billing.js";
import { resolveAllowance } from "../dist/allowance.js";
import { stripeUsageLedger } from "../dist/usage-ledger.js";
import { stripeScopeUsageLedger, USAGE_SCOPE_KIND } from "../dist/usage-scopes.js";
import { cachedUsageLedger } from "../dist/usage-cache.js";

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY?.startsWith("sk_test")) {
  console.error("Needs a TEST-mode STRIPE_SECRET_KEY.");
  process.exit(1);
}

const stripe = new Stripe(KEY, { maxNetworkRetries: 0 });
__setStripeForTests(stripe);

// Every HTTP request the SDK makes, including pagination and retries.
const http = { requests: 0, byPath: new Map(), rateLimited: 0, errors: 0 };
stripe.on("response", (r) => {
  http.requests++;
  const path = String(r.path ?? "?").split("?")[0].replace(/\/(cus|mtr)_[A-Za-z0-9_]+/g, "/:id");
  http.byPath.set(path, (http.byPath.get(path) ?? 0) + 1);
  if (r.status === 429) http.rateLimited++;
  else if (r.status >= 400) http.errors++;
});
const snapshot = () => ({ ...http, byPath: new Map(http.byPath) });
const since = (s) => ({
  requests: http.requests - s.requests,
  rateLimited: http.rateLimited - s.rateLimited,
  errors: http.errors - s.errors,
});

// A per-seat catalogue with a caller-scoped limit — the shape that needs the
// per-caller axis, i.e. the expensive one. Mirrors a real Pro plan.
const PLANS = {
  pro: {
    sells: {
      kind: "seats",
      seatTypes: { standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000, min: 1 } },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat", window: "month", covers: "users", onExhausted: "wallet" },
    replenish: { purchase: {} },
    limits: {
      members: 100,
      rate: [
        { every: "week", credits: 500, scope: "caller", callerKind: "user" },
        { every: "hour", credits: 600, scope: "caller", callerKind: "api" },
      ],
    },
    sale: "self_serve",
  },
};

const ORG = `load_${Math.floor(Date.now() / 1000)}`;
const MEMBERS = Number(process.env.MEMBERS ?? 20);
const members = Array.from({ length: MEMBERS }, (_, i) => `usr_load_${i}`);

const adapter = {
  async getBillingCustomerId() { return customerId; },
  async getOrgMetadata() { return {}; },
  async setOrgMetadata() {},
  async getSubscription() {
    return { plan: "pro", status: "active", subscriptionId: null, seats: MEMBERS, periodStart: null, periodEnd: null };
  },
  async getUserMetadata() { return {}; },
  async setUserMetadata() {},
  async listMemberIds() { return members; },
};
const config = { freeCredits: 0, currency: "eur", baseUrl: "http://x", internalDomains: [], defaultLocale: "en" };

// A real customer: `getCreditBalance` and the wallet leg both read it, and both
// are part of the per-call cost being measured.
const customer = await getStripe().customers.create({
  name: `load test ${ORG}`,
  metadata: { bt_probe: "load" },
});
const customerId = customer.id;
console.log(`org ${ORG} · customer ${customerId} · ${MEMBERS} members\n`);

/** One metered call's worth of reads, for a random member. */
const KINDS = (process.env.CALLER ?? "user").split(",");
const oneCall = (ledger, i) =>
  resolveAllowance(adapter, config, {
    orgId: ORG,
    plans: PLANS,
    plan: "pro",
    caller:
      KINDS[i % KINDS.length] === "api"
        ? { kind: "api", id: `key_${i % members.length}` }
        : { kind: "user", id: members[i % members.length], seatType: "standard" },
    customerId,
    ledger,
  });

async function measure(label, ledger, { calls, concurrency }) {
  // Warm: resolve the meter + scope customers once, so the steady-state figure is
  // not dominated by one-off provisioning.
  await oneCall(ledger, 0).catch(() => {});
  const before = snapshot();
  const latencies = [];
  const started = Date.now();

  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= calls) return;
      const t = Date.now();
      try { await oneCall(ledger, i); } catch { /* counted via the response hook */ }
      latencies.push(Date.now() - t);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const secs = (Date.now() - started) / 1000;
  const d = since(before);
  latencies.sort((a, b) => a - b);
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  const perCall = d.requests / calls;
  console.log(`── ${label}`);
  console.log(`   ${calls} metered calls, concurrency ${concurrency}, ${secs.toFixed(1)}s`);
  console.log(`   throughput      ${(calls / secs).toFixed(1)} calls/s   (test mode: 25 req/s global)`);
  console.log(`   Stripe requests ${d.requests}  →  ${perCall.toFixed(2)} per metered call`);
  console.log(`   latency         p50 ${p(0.5)}ms · p95 ${p(0.95)}ms · max ${latencies.at(-1)}ms`);
  console.log(`   429s ${d.rateLimited} · other 4xx/5xx ${d.errors}`);
  console.log(`   → per-endpoint ceiling ≈ ${(25 / Math.max(perCall, 0.01)).toFixed(0)} calls/s if every request hit one endpoint\n`);
  return { perCall, throughput: calls / secs, rateLimited: d.rateLimited };
}

const CALLS = Number(process.env.CALLS ?? 60);
const CONC = Number(process.env.CONCURRENCY ?? 10);

const uncached = stripeUsageLedger({ perCaller: stripeScopeUsageLedger() });
const cached = cachedUsageLedger(uncached, { ttlMs: 2_000 });

const a = await measure("UNCACHED — one read per window per call", uncached, { calls: CALLS, concurrency: CONC });
const b = await measure("CACHED (2s) — the shipped wiring", cached, { calls: CALLS, concurrency: CONC });

console.log("── verdict");
console.log(`   requests per metered call: ${a.perCall.toFixed(2)} → ${b.perCall.toFixed(2)}  (${(a.perCall / Math.max(b.perCall, 0.01)).toFixed(1)}× fewer)`);
console.log(`   throughput:                ${a.throughput.toFixed(1)} → ${b.throughput.toFixed(1)} calls/s`);
console.log(`   429s:                      ${a.rateLimited} → ${b.rateLimited}`);
console.log("\n   Requests-per-call transfers to live; throughput does not (live is 100 req/s");
console.log("   global vs 25 here, but listEventSummaries is capped at 25 req/s in both).");

console.log("\n── where the requests went (whole run)");
for (const [path, n] of [...http.byPath.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
  console.log(`   ${String(n).padStart(5)}  ${path}`);
}

// cleanup
await getStripe().customers.del(customerId).catch(() => {});
let deleted = 0;
for await (const c of getStripe().customers.list({ limit: 100 })) {
  if (c.metadata?.bt_kind === USAGE_SCOPE_KIND && c.metadata?.bt_usage_scope?.startsWith(ORG)) {
    await getStripe().customers.del(c.id).catch(() => {});
    deleted++;
  }
}
console.log(`\n   cleaned up ${deleted} scope customers + 1 org customer`);
