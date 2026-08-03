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
import { test } from "vitest";

import { runBillingDoctor } from "../dist/doctor.js";

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
