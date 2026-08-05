// Shared machinery for the live harnesses.
//
// Extracted because the four scripts beside it each re-declared the same four things —
// an `ok()` with a failure counter, `eur()`, the test-clock settle poll (60 tries in one,
// 90 in another, for no reason), and a bespoke `created = {…}` bag with a hand-written
// cleanup. Two of them have no `try/finally` at all, so a mid-run throw leaks a test
// clock and a customer that then count against the account forever.
//
// The teardown registry is the part worth having: with ~10 kinds of object created across
// six sections, "remember to delete it at the bottom" is not a strategy.

import { readFileSync } from "node:fs";

// ── env ──────────────────────────────────────────────────────────────────────

/** Parse a dotenv file by hand. No dependency, and it must not overwrite a variable the
 *  caller set deliberately on the command line. */
export function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Refuse to run against anything but test keys, then put them in `process.env`.
 *
 * The env write is not a convenience: `stripeConfigured()` reads `process.env.STRIPE_SECRET_KEY`
 * directly (src/billing.ts), so without it every billing tool returns "not configured"
 * even after `__setStripeForTests` handed the library a working client — a failure that
 * looks like a broken tool rather than a missing variable.
 */
export function requireTestKeys(env, { stripe = true, workos = true } = {}) {
  const out = {};
  if (stripe) {
    const key = env.STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
    if (!key?.startsWith("sk_test")) {
      console.error("Refusing to run: STRIPE_SECRET_KEY is not a test-mode key.");
      process.exit(2);
    }
    process.env.STRIPE_SECRET_KEY = key;
    out.stripeKey = key;
  }
  if (workos) {
    const key = env.WORKOS_API_KEY ?? process.env.WORKOS_API_KEY;
    if (!key) {
      console.error("Refusing to run: WORKOS_API_KEY is unset — the role sections need a real org.");
      process.exit(2);
    }
    // A newer `sk_<key id>` names no environment, so this cannot be a prefix check. The
    // mismatch guard in the doctor exists for the same reason; here the org is scratch and
    // deleted, so the risk is creating litter in production rather than charging anyone.
    process.env.WORKOS_API_KEY = key;
    process.env.WORKOS_CLIENT_ID = env.WORKOS_CLIENT_ID ?? process.env.WORKOS_CLIENT_ID ?? "";
    out.workosKey = key;
  }
  return out;
}

// ── reporting: one counter for the whole run ─────────────────────────────────

let failed = 0;
let passed = 0;
let skipped = 0;

export function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 68 - title.length))}`);
}

export function ok(label, cond, extra = "") {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  return Boolean(cond);
}

/** Not a failure. For a claim that needs something the run does not have — a real VAT
 *  number, a reachable VIES — where failing would punish the environment, not the code. */
export function skip(label, why) {
  skipped++;
  console.log(`  ⊘ ${label} — skipped: ${why}`);
}

export function note(...args) {
  console.log("   ", ...args);
}

export function failures() {
  return failed;
}

/**
 * A section died — count it, because a crashed section is not a pass.
 *
 * `ok()` counts assertions, so a THROW incremented nothing: a run that lost a whole section
 * to an exception printed `✗ the run threw: …` and then `ALL PASS`, and exited **0**. Both
 * statements were on screen at once and the machine-readable one was the wrong one. Anything
 * reading the exit code — CI, a shell `&&` — was told the run succeeded.
 */
export function fatal(what, e) {
  failed++;
  fatals.push(`${what}: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  console.error(`\n✗ ${what} threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
}

const fatals = [];

export function finish() {
  const summary =
    failed === 0
      ? "ALL PASS"
      : `${failed} FAILURE(S)${fatals.length ? `, ${fatals.length} of them fatal` : ""}`;
  console.log(`\n${summary} — ${passed} passed` + (skipped ? `, ${skipped} skipped` : ""));
  for (const f of fatals) console.log(`  ✗ ${f.split("\n")[0]}`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── formatting ───────────────────────────────────────────────────────────────

export const eur = (minor) => `€${((minor ?? 0) / 100).toFixed(2)}`;
export const money = (minor, currency = "eur") =>
  `${currency.toUpperCase()} ${((minor ?? 0) / 100).toFixed(2)}`;

// ── Stripe test clock ────────────────────────────────────────────────────────

/**
 * Advance a test clock and wait for it to settle.
 *
 * Everything scheduled on the clock — a renewal invoice, a subscription schedule phase —
 * happens during `status: "advancing"`, so reading before `ready` sees the state you were
 * trying to move past. The two existing scripts poll 60 and 90 times for the same reason;
 * this is that loop, once.
 */
export async function advanceClock(stripe, clockId, toUnixSeconds, { tries = 90, delayMs = 1000 } = {}) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toUnixSeconds });
  for (let i = 0; i < tries; i++) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return clock;
    if (clock.status === "internal_failure") throw new Error(`test clock ${clockId} failed internally`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`test clock ${clockId} did not settle after ${tries}s`);
}

export async function retry(fn, { tries = 10, delayMs = 1000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

// ── teardown ─────────────────────────────────────────────────────────────────

const deferred = [];

/** Register a teardown at the moment the thing is created, not at the bottom of the file.
 *  LIFO, because a subscription has to go before its customer and a schedule before its
 *  subscription. */
export function defer(label, fn) {
  deferred.push({ label, fn });
}

/**
 * "It was already gone", the ONE teardown error that is not a leak.
 *
 * Deleting a test clock deletes its customers, so the customer's own teardown legitimately
 * 404s afterwards. Use this instead of `.catch(() => {})` — a blanket catch turns a real
 * failure into a `✓`, and a run that reports a clean teardown while leaving six active
 * prices and a test clock behind is worse than one that leaks loudly. That happened, and
 * the state it left took a while to explain.
 */
export function ignoreMissing(e) {
  const message = e instanceof Error ? e.message : String(e);
  const code = e?.code ?? e?.raw?.code;
  const missing =
    // Stripe
    code === "resource_missing" ||
    e?.statusCode === 404 ||
    e?.status === 404 ||
    /No such |already been deleted/i.test(message) ||
    // WorkOS words it differently and throws its own class — the first version of this only
    // knew Stripe's phrasing, so three already-deleted objects were reported as LEAKED.
    e?.constructor?.name === "NotFoundException" ||
    /\bnot found\b/i.test(message);
  if (missing) return null;
  throw e;
}

/**
 * Run every teardown, newest first. Never throws — one stranded object must not strand the
 * twenty behind it — but a failure IS counted, so a leak fails the run rather than being a
 * line nobody reads.
 */
export async function runDeferred() {
  section("teardown");
  for (const { label, fn } of [...deferred].reverse()) {
    try {
      await fn();
      console.log(`  ✓ removed ${label}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ LEAKED ${label}: ${e instanceof Error ? e.message : e}`);
    }
  }
  deferred.length = 0;
}
