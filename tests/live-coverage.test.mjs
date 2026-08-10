// WHICH library functions have ever run against a real account — as a list, not a judgement.
//
// `pnpm test` proves rules against fakes; `pnpm e2e:live` proves 13 sections against real
// Stripe and WorkOS. The gap between them was invisible, and every expensive defect in this
// package has lived in it: `invoice.subscription` no longer existing, the untaxed negotiated
// invoice, the operator event nobody received, `pending_if_incomplete` rejecting a tax
// parameter. Each passed the offline suite, because a fake accepts any params.
//
// "One instance of an event is not coverage" is already a rule here — sections 07 and 08 exist
// because a single measured upgrade was reported as "upgrades are covered". This is the same
// rule applied to the whole surface: a static call graph over `src/`, rooted at what the live
// suite actually reaches, answering one question. Which functions that TOUCH Stripe or WorkOS
// have never been executed against either?
//
// ONE PREMISE, AND IT IS NOT FREE: this credits what the live suite NAMES, not what it
// successfully EXECUTES. A section that throws halfway still names everything below the throw,
// so these numbers are only true while `pnpm e2e:live` is GREEN. That is not hypothetical
// either — the first full run after this file was written had four sections failing on stale
// harness code (a `not_blocked` guard, a changed return shape, a seat a plan no longer sells),
// every one of them silently inflating the coverage counted here. Run the live suite before
// trusting this file, and treat a red section as coverage withdrawn.
//
// The answer is a number this file pins, and a registry that has to give a reason for every
// name in it. That is the point: an uncovered function is allowed, a SILENTLY uncovered one is
// not. Writing this found four dead exports (the `default_incomplete` subscription trio and
// the hook that drove it — deleted, not registered) and three consumer-facing functions on the
// money path that no live section had ever called. One of those three, the retax handoff, is
// now covered by section 03d — and this file is what said it was not.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function walk(dir, match, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (paths) => paths.map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
const SRC = read(walk(join(ROOT, "src"), /\.tsx?$/));
// The whole live corpus: the sections, the runner that WIRES them (a service handed to
// `createBilling` there really does run against WorkOS), and the harness helpers, which make
// real calls of their own.
const LIVE = read([
  ...walk(join(ROOT, "scripts", "live"), /\.mjs$/),
  ...walk(join(ROOT, "scripts", "lib"), /\.mjs$/),
  ...readdirSync(join(ROOT, "scripts"))
    .filter((f) => /^e2e-.*\.mjs$/.test(f))
    .map((f) => join(ROOT, "scripts", f)),
]);

/** CODE only. A comment naming a function is not a call to it, and this package's comments
 *  name a great many — matching prose would report everything as covered. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

// ── every function in the library, with its body and whether it reaches an SDK ──
const FNS = new Map();
for (const { path, text } of SRC) {
  const src = strip(text);
  const touchesSdk = /getStripe|getWorkOS/.test(src);
  const decls = [
    ...src.matchAll(/(export )?(?:async )?function (\w+)\s*[(<]/g),
    ...src.matchAll(/(export )?const (\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g),
  ];
  for (const m of decls) {
    const name = m[2];
    // Body = to the next top-level `export`, or the end. Crude ON PURPOSE: over-inclusion
    // makes coverage look BETTER, so anything this still reports as uncovered really is.
    const rest = src.slice(m.index + 1);
    const next = rest.search(/\nexport /);
    const body = next === -1 ? rest : rest.slice(0, next);
    if (!FNS.has(name)) {
      FNS.set(name, { body, path: path.slice(ROOT.length + 1), exported: Boolean(m[1]), touchesSdk });
    } else {
      FNS.get(name).body += `\n${body}`;
    }
  }
}

// ── roots ────────────────────────────────────────────────────────────────────
const liveText = LIVE.map((l) => strip(l.text)).join("\n");
const roots = [...FNS.keys()].filter((n) => new RegExp(`\\b${n}\\b`).test(liveText));

// Tools are rooted at the FILE, not the individual handler. Extracting each handler's body by
// regex under-matched (31 of 49), and an under-matched root reports functions as uncovered
// that a live section really does reach — a guard that cries wolf is one people scroll past.
// File-level over-approximates in the safe direction.
const toolBodies = SRC.filter(({ path }) => /src\/tools\//.test(path))
  .map(({ text }) => strip(text))
  .filter((src) =>
    [...src.matchAll(/server\.tool\(\s*["'`](\w+)["'`]/g)].some((m) =>
      new RegExp(`["'\`]${m[1]}["'\`]`).test(liveText),
    ),
  );

// ── transitive closure ───────────────────────────────────────────────────────
const reached = new Set();
const queue = [...roots];
const callsIn = (body) =>
  [...FNS.keys()].filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));
for (const body of toolBodies) queue.push(...callsIn(body));
while (queue.length) {
  const cur = queue.pop();
  if (reached.has(cur)) continue;
  reached.add(cur);
  const fn = FNS.get(cur);
  if (fn) queue.push(...callsIn(fn.body).filter((n) => !reached.has(n)));
}

const sdkExports = [...FNS.entries()].filter(([, f]) => f.exported && f.touchesSdk).map(([n]) => n);
const uncovered = sdkExports.filter((n) => !reached.has(n)).sort();

/**
 * Every SDK-touching export no live section reaches, and WHY that is acceptable.
 *
 * Three kinds, and only the third is a gap:
 *
 *   • a test seam or a memo clear — live is the case it exists to avoid, or there is no
 *     observable behaviour to prove against a real account
 *   • a pure read over something already provisioned live — the provisioning is covered, and
 *     the lookup adds no request
 *   • GENUINELY UNPROVEN against a real account, and used by a consumer. Named as such,
 *     because the honest version of "we have not tested this" is a list.
 */
const OFFLINE_ONLY = {
  // ── seams ──
  __setVatValidatorForTests: "a test seam; the bare reset installs a validator that REFUSES, so live is exactly what it prevents",
  __setWorkOSForTests: "a test seam — replacing the memoised client is the opposite of running against a real one",

  // ── memo clears: no observable behaviour at an account ──
  invalidateCreditQuotes: "clears a process memo — nothing at Stripe changes and there is no state a live assertion could read back",
  invalidatePaymentMethodConfigs: "clears the per-process memo of payment-method configurations; the CONFIG it caches is provisioned live by `ensurePaymentMethodConfig`",
  invalidateTaxOrigin: "clears the memoised account country; `originFor` reading it from a real account IS covered, in section 03",
  invalidateUsageScopes: "clears the scope-customer memo; the scope customers themselves are provisioned live by scripts/e2e-scope-ledger.mjs",
  invalidateVatNumbers: "clears the confirmed-VAT cache; the cache POLICY is asserted offline and a live run would only slow VIES down",

  // ── pure reads over state a live section already provisioned ──
  includedCreditsByType: "reads the resolved catalogue; `resolvePlanPrices` is what talks to Stripe and section 05 covers it",
  planPriceId: "a lookup in the price map the live harness installs deliberately (see scratch-stripe.mjs)",
  planSale: "reads the plan object in the catalogue and issues no request; it is in this list only because its module also reaches Stripe",
  seatTypeForPriceId: "reverse lookup in the same installed price map",
  seatTypeLimit: "reads the seat type in the catalogue and issues no request; same as `planSale` — the MODULE reaches Stripe, this function does not",
  invoicePdfUrl: "builds a URL from an invoice already retrieved; `orgInvoicePdfUrl` IS covered, in section 04",

  // ── superseded by the catalogue, reachable only without `plans` ──
  listSubscriptionPrices: "the pre-catalogue price resolution, for a one-plan account with no `plans` — every path this library takes goes through `resolvePlanPrices` instead",
  resolveSubscriptionPrice: "same: the no-catalogue path, kept for an app that resolves one price by lookup key",

  // ── the CLI runner: covered offline with injected exit/log ──
  runBillingDoctor: "tests/doctor-runner.test.mjs asserts it with `exit` and `log` injected, which is the only way to assert an exit code; `checkBillingSetup` underneath IS live-covered",
  webhookUrlFromArgv: "parses argv and reads BILLING_WEBHOOK_URL; no request, and tests/doctor-runner.test.mjs pins the parsing both consumers had drifted on",

  // ── GENUINELY UNPROVEN, and used by a consumer ──
  savedCardFromCheckoutSession:
    "GAP: reads the PaymentMethod off a completed setup session. Used twice in scartoffie; completing a session needs a browser, which is why no section reaches it — the same reason 05a subscribes directly.",
  createBillingSync:
    "GAP: the sync route factory, used three times in scartoffie and reached by no section. It polls Stripe and WorkOS events, so a fake proves only the shape of the handler.",
  createSyncRoute: "GAP: the route wrapper around `createBillingSync`, same reason",
  createWorkOSOrgMirror:
    "GAP: Pattern B — the DB-mirror pointer. The live harness is Pattern A (orgId IS the WorkOS org id), so the mirror's reconcile-on-read and idempotent externalId create are proven only by scartoffie's own suite and by production. Covering it here needs a Postgres the harness does not have.",
};

test("the live coverage ledger accounts for every uncovered function", () => {
  const unlisted = uncovered.filter((n) => !(n in OFFLINE_ONLY));
  assert.deepEqual(
    unlisted,
    [],
    `These touch Stripe or WorkOS and no live section reaches them:\n  ${unlisted.join("\n  ")}\n` +
      `Either add a live assertion, or list it in OFFLINE_ONLY with a reason. An uncovered ` +
      `function is fine; a silently uncovered one is how every defect in this package's history got in.`,
  );
});

test("no stale entries — an excuse for a function that is now covered is worse than none", () => {
  // It reads as considered while hiding the next real gap, exactly like a stale exemption in
  // the consumers' surface tests.
  const stale = Object.keys(OFFLINE_ONLY).filter((n) => !uncovered.includes(n));
  assert.deepEqual(stale, [], `now covered (or gone) — drop them: ${stale.join(", ")}`);
});

test("every reason is a reason", () => {
  for (const [name, why] of Object.entries(OFFLINE_ONLY)) {
    assert.ok(why.length > 30, `${name}: "${why}" does not say why`);
  }
});

test("the ledger is measuring something", () => {
  // If the parser stops matching, `reached` empties, everything looks uncovered and the first
  // test fails loudly — but if it matched EVERYTHING, every test above would pass vacuously.
  assert.ok(sdkExports.length > 100, `only ${sdkExports.length} SDK-touching exports found`);
  assert.ok(reached.size > 300, `only ${reached.size} functions reached`);
  assert.ok(toolBodies.length >= 6, `only ${toolBodies.length} tool files reached live`);
});

test("the GAPS are named, and there are four of them", () => {
  // Pinned so closing one is a deliberate edit here, and opening one cannot pass unnoticed.
  const gaps = Object.entries(OFFLINE_ONLY)
    .filter(([, why]) => why.startsWith("GAP:"))
    .map(([n]) => n)
    .sort();
  assert.deepEqual(gaps, [
    "createBillingSync",
    "createSyncRoute",
    "createWorkOSOrgMirror",
    "savedCardFromCheckoutSession",
  ]);
  // `updateCheckoutSessionTaxRates` was the fifth and is closed: section 03d re-taxes a real
  // OPEN session and reads the rate ID back off it. `expireCheckoutSession` left the list at
  // the same time, as that section's teardown — which is the shape a gap should close in,
  // something the suite genuinely does rather than an entry somebody deleted.
  assert.equal(gaps.length, 4);
});
