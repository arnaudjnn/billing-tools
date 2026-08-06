// The doctor runner: the CLI both consumers hand-wrote, once.
//
// Two scripts, 64 and 75 lines, 87 of them differing, doing the same thing — the
// same `--url` / `--no-webhook` parsing, the same order, the same exit arithmetic.
// The second was written by copying the first, which is how the flags could have
// drifted apart without either app noticing.
//
// `exit` and `log` are injectable for exactly this file: a runner that could only
// be tested by ending the process is a runner nobody tests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  environmentMismatch,
  runBillingDoctor,
  webhookUrlFromArgv,
  workosEnvironmentOf,
} from "../dist/doctor.js";
import { runBillingCli } from "../dist/setup.js";

const PLANS = {
  pro: {
    sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } },
    cap: { kind: "pool", credits: 1000 },
    replenish: { purchase: {} },
    sale: "self_serve",
  },
};

/** Captures instead of exiting, so the whole run is observable. */
function harness(argv = []) {
  const out = [];
  let code = null;
  return {
    out,
    get code() {
      return code;
    },
    opts: {
      argv,
      log: (line) => out.push(line),
      exit: (c) => {
        code = c;
        // The real `exit` never returns; this must not either, or the runner would
        // carry on past a refusal it just reported.
        throw { __exit: c };
      },
    },
  };
}

async function run(opts) {
  try {
    await runBillingDoctor(opts);
  } catch (e) {
    if (!e || typeof e !== "object" || !("__exit" in e)) throw e;
  }
}

test("no STRIPE_SECRET_KEY exits 2, before any network call", async () => {
  // 2, not 1: the key decides WHICH environment is checked, so an unset one is a
  // different failure from a check that ran and found something wrong. A doctor run
  // against the wrong account is worse than no run.
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const h = harness();
  try {
    await run({ ...h.opts, plans: PLANS });
    assert.equal(h.code, 2);
    assert.deepEqual(h.out, [], "nothing should be printed before the key is checked");
  } finally {
    if (key !== undefined) process.env.STRIPE_SECRET_KEY = key;
  }
});

test("the plan config is reported even when Stripe is unreachable", async () => {
  // The config half needs no network and explains most account-level symptoms, so it
  // has to run and print FIRST. A fake key makes the account half fail, which is the
  // case that used to hide the config output entirely.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  const h = harness(["--no-webhook"]);
  await run({ ...h.opts, plans: PLANS, hasCheckout: true, usageLedger: true });

  assert.ok(h.out.length >= 1, "the plan-config report was not printed");
  assert.match(h.out[0], /Usage ledger|plan|Plan/, `unexpected first report: ${h.out[0]}`);
});

test("--no-webhook and --url are parsed the same way for every app", async () => {
  // The flags are the part that was duplicated, so they are the part pinned here.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  for (const argv of [["--no-webhook"], ["--url", "https://other.example/hook"], []]) {
    const h = harness(argv);
    await run({ ...h.opts, plans: PLANS, webhookUrl: "https://deployed.example/hook" });
    // Whatever Stripe says, the runner must reach an exit rather than throw.
    assert.equal(typeof h.code, "number", `argv ${JSON.stringify(argv)} produced no exit code`);
  }
});

test("a broken catalogue fails the run even if the account is fine", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  // `sale: self_serve` with nothing sold, and a cap that can never be replenished:
  // checkPlansConfig errors on this, and that must decide the exit code — a good
  // account with a broken catalogue is still broken, and it is the half that never
  // shows up in Stripe.
  const BAD = { ghost: { sells: { kind: "nothing" }, cap: { kind: "wallet" }, sale: "self_serve" } };
  const h = harness(["--no-webhook"]);
  await run({ ...h.opts, plans: BAD, hasCheckout: false });
  assert.notEqual(h.code, 0, "a catalogue error must not exit 0");
});

// ── The two keys, disagreeing about which environment this is ────────────────
//
// Both halves of the report state their own environment plainly, so a mixed pair
// printed "LIVE MODE" above "test/staging key" and passed. Pure and separate from
// the WorkOS network call precisely so this can be asserted offline.
test("a live Stripe key beside a staging WorkOS key is an error", () => {
  const mixed = environmentMismatch("sk_test_123", true);
  assert.equal(mixed?.level, "error");
  assert.match(mixed.detail, /LIVE key and WORKOS_API_KEY is a test/);

  // And the other way round, which is the likelier accident: a laptop with test
  // Stripe keys and the production WorkOS key pasted in.
  assert.equal(environmentMismatch("sk_live_123", false)?.level, "error");

  // Matching pairs say nothing at all — local dev and prod are both a matched pair.
  assert.equal(environmentMismatch("sk_test_123", false), null);
  assert.equal(environmentMismatch("sk_live_123", true), null);
});

test("a key that does not name its environment is not accused of anything", () => {
  // WorkOS's newer keys are `sk_<base64 key id>` — decoding to `key_01…`, with no
  // environment marker. Reading "not sk_test, therefore production" reported one of
  // those as production and then flagged a correctly matched local setup as mixed.
  // Caught on the first real run of this check, which is the argument for it being
  // silent here: a doctor whose errors are sometimes fiction gets scrolled past.
  const newFormat = "sk_a2V5XzAxSzYyM";
  assert.equal(workosEnvironmentOf(newFormat), "unknown");
  assert.equal(environmentMismatch(newFormat, true), null);
  assert.equal(environmentMismatch(newFormat, false), null);

  assert.equal(workosEnvironmentOf("sk_test_123"), "test");
  assert.equal(workosEnvironmentOf("sk_live_123"), "live");
});

// ── One runner, two verbs ────────────────────────────────────────────────────

test("the flags parse the same for both verbs", () => {
  // One parser, because both verbs take both flags and the two hand-written copies
  // of this had already drifted.
  const saved = process.env.BILLING_WEBHOOK_URL;
  delete process.env.BILLING_WEBHOOK_URL;
  try {
    assert.equal(webhookUrlFromArgv(["--no-webhook"], "https://deployed.example/hook"), undefined);
    assert.equal(webhookUrlFromArgv(["--url", "https://other.example/hook"]), "https://other.example/hook");
    assert.equal(webhookUrlFromArgv([], "https://deployed.example/hook"), "https://deployed.example/hook");
    // A flag must not be read as the verb, or `billing --no-webhook` would provision.
    assert.equal(webhookUrlFromArgv(["setup", "--no-webhook"], "https://x/y"), undefined);
  } finally {
    if (saved !== undefined) process.env.BILLING_WEBHOOK_URL = saved;
  }
});

test("BILLING_WEBHOOK_URL beats the code fallback, and --no-webhook beats both", () => {
  // Where a deployment lives is an environment fact. Both consumers had their
  // production URL hardcoded in an ops script, each with a comment warning that
  // running it from a laptop would register the production endpoint against a test
  // key — a hazard the env var removes rather than documents.
  const saved = process.env.BILLING_WEBHOOK_URL;
  process.env.BILLING_WEBHOOK_URL = "https://from-env.example/hook";
  try {
    assert.equal(webhookUrlFromArgv([], "https://in-source.example/hook"), "https://from-env.example/hook");
    // An explicit flag still wins — it is the most local statement of intent.
    assert.equal(webhookUrlFromArgv(["--url", "https://flag.example/hook"]), "https://flag.example/hook");
    // And "there is no endpoint" must beat a stale env var, or a local run checks prod.
    assert.equal(webhookUrlFromArgv(["--no-webhook"]), undefined);
    // Empty is not a URL: an unset-but-present var must fall through, not check "".
    process.env.BILLING_WEBHOOK_URL = "";
    assert.equal(webhookUrlFromArgv([], "https://in-source.example/hook"), "https://in-source.example/hook");
  } finally {
    if (saved === undefined) delete process.env.BILLING_WEBHOOK_URL;
    else process.env.BILLING_WEBHOOK_URL = saved;
  }
});

async function cli(opts) {
  try {
    await runBillingCli(opts);
  } catch (e) {
    if (!e || typeof e !== "object" || !("__exit" in e)) throw e;
  }
}

test("the default verb is the one that cannot change anything", async () => {
  // A bare `pnpm billing` on a laptop holding live keys must read the account, never
  // provision it — so `doctor` is the default and `setup` has to be typed.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  const h = harness(["--no-webhook"]);
  await cli({ ...h.opts, config: { currency: "eur", baseUrl: "https://x.example" }, plans: PLANS });
  assert.equal(typeof h.code, "number");
  // The doctor's own output, not a setup report: nothing was provisioned.
  assert.ok(
    h.out.join("\n").length > 0 && !h.out.join("\n").includes("Provisioned:"),
    "the default verb provisioned something",
  );
});

test("an unknown verb exits 2 rather than defaulting to either half", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  const h = harness(["privision"]);
  await cli({ ...h.opts, config: { currency: "eur", baseUrl: "https://x.example" } });
  assert.equal(h.code, 2, "a typo must not fall through to setup OR doctor");
});

test("setup with no STRIPE_SECRET_KEY exits 2, before writing anything", async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const h = harness(["setup"]);
  try {
    await cli({ ...h.opts, config: { currency: "eur", baseUrl: "https://x.example" }, plans: PLANS });
    assert.equal(h.code, 2);
    assert.deepEqual(h.out, [], "nothing should be printed before the key is checked");
  } finally {
    if (key !== undefined) process.env.STRIPE_SECRET_KEY = key;
  }
});

test("runBillingCli forwards accountTaxId, so the supplier VAT number is reachable", async () => {
  // It was not forwarded, and `runBillingCli` is the only entry point either consuming app
  // calls — so the option existed on `setupBilling` and could not be reached from the
  // documented path. Every invoice the account issued carried no supplier VAT number, which
  // Art. 226(3) requires, and the doctor could only report the gap it had no way to close.
  const source = readFileSync(new URL("../src/setup.ts", import.meta.url), "utf8");
  const runner = source.slice(source.indexOf("export async function runBillingCli"));
  assert.match(runner, /accountTaxId: opts\.accountTaxId/, "setup must pass it through");
});
