// Two properties that only matter once there is more than one process, or more
// than one attempt.
//
//  1. WRITES SURVIVE A BLIP. A dropped meter event is usage that can never be
//     counted — unlike a failed read, which the next call simply re-issues. Every
//     event carries an `identifier`, which is Stripe's own dedup key, so retrying
//     is safe by construction rather than by hope.
//
//  2. TWO INSTANCES CANNOT SPLIT ONE MEMBER'S USAGE. Scope customers are resolved
//     per process, so a deploy with N instances resolves the same scope N times.
//     If two of them created two customers for one member, that member's usage
//     would be split across both and every window under-reported — silently, and
//     permanently. What prevents it is that the create carries an idempotency key
//     DERIVED from the scope, so Stripe returns the same customer to both. That is
//     verified against the live API elsewhere; this pins the property CI can check,
//     which is that two independent instances derive the identical key.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { invalidateMeters } from "../dist/usage-ledger.js";
import { stripeScopeUsageLedger, invalidateUsageScopes } from "../dist/usage-scopes.js";
import { onUsageFault, resetUsageFaults } from "../dist/usage-faults.js";

const EVENT = {
  orgId: "org_1",
  customerId: "cus_org",
  action: "search",
  cost: 5,
  funded: "pack",
  caller: { kind: "user", id: "u1" },
};

/** A Stripe whose meter-event stream fails the first `failures` attempts. */
function flakyStream({ failures = 0, status = 429 } = {}) {
  const calls = { streamAttempts: 0, identifiers: [], creates: [] };
  __setStripeForTests({
    customers: {
      async search() { return { data: [] }; },
      async create(params, opts) {
        calls.creates.push({ scope: params.metadata.bt_usage_scope, key: opts?.idempotencyKey });
        return { id: `cus_${calls.creates.length}` };
      },
    },
    billing: {
      meters: {
        list() {
          return { [Symbol.asyncIterator]: async function* () { yield { id: "mtr_scope", event_name: "billing_tools_scope_usage" }; } };
        },
      },
    },
    v2: {
      billing: {
        meterEventSession: { async create() { return { authentication_token: "t", expires_at: new Date(Date.now() + 1e6).toISOString() }; } },
        meterEventStream: {
          async create({ events }) {
            calls.streamAttempts++;
            if (calls.streamAttempts <= failures) {
              const e = new Error("transient");
              e.statusCode = status;
              throw e;
            }
            calls.identifiers.push(...events.map((x) => x.identifier));
          },
        },
      },
    },
  });
  return calls;
}

beforeEach(() => {
  invalidateMeters();
  invalidateUsageScopes();
  resetUsageFaults();
});

// ── 1. Write durability ────────────────────────────────────────────────────

test("a transient write failure is retried and the usage survives", async () => {
  const calls = flakyStream({ failures: 2 });
  const faults = [];
  onUsageFault((f) => faults.push(f));

  await stripeScopeUsageLedger().record(EVENT);

  assert.equal(calls.streamAttempts, 3, "two failures, then the delivery");
  assert.ok(calls.identifiers.length > 0, "the event was counted in the end");
  assert.deepEqual(faults, [], "nothing was lost, so nothing to report");
});

test("a retried event reuses its identifier, so a delivered one is not double counted", async () => {
  // Stripe dedupes on `identifier`. If a retry minted a fresh one, an attempt that
  // actually landed before the error would be counted twice — worse than the loss
  // the retry exists to prevent.
  const calls = flakyStream({ failures: 1 });
  await stripeScopeUsageLedger().record({ ...EVENT, idempotencyKey: "exec_42" });
  assert.ok(
    calls.identifiers.every((id) => id.startsWith("exec_42-")),
    `identifiers must derive from the execution key, got ${JSON.stringify(calls.identifiers)}`,
  );
});

test("a permanent failure is NOT retried — it would only cost latency", async () => {
  const calls = flakyStream({ failures: 99, status: 400 });
  const faults = [];
  onUsageFault((f) => faults.push(f));
  await stripeScopeUsageLedger().record(EVENT);
  assert.equal(calls.streamAttempts, 1, "a 400 will not succeed on a second try");
  assert.equal(faults.at(-1)?.outcome, "dropped");
});

test("usage that is genuinely lost is reported as dropped, not swallowed", async () => {
  const calls = flakyStream({ failures: 99 });
  const faults = [];
  onUsageFault((f) => faults.push(f));
  // Still does not throw: a metered call must not die counting itself.
  await stripeScopeUsageLedger().record(EVENT);
  assert.equal(calls.streamAttempts, 3, "bounded — it does not grind through an outage");
  assert.equal(faults.at(-1)?.operation, "write");
  assert.equal(faults.at(-1)?.outcome, "dropped");
});

// ── 2. Multi-instance scope resolution ────────────────────────────────────

test("two independent instances derive the SAME idempotency key for a scope", async () => {
  const calls = flakyStream();
  // Two ledgers with no shared memo — the deploy-with-N-instances case, where both
  // miss the eventually-consistent customer search and both create.
  const a = stripeScopeUsageLedger();
  invalidateUsageScopes(); // wipe the process memo: instance B knows nothing
  const b = stripeScopeUsageLedger();

  await a.record(EVENT);
  invalidateUsageScopes();
  await b.record(EVENT);

  const byScope = new Map();
  for (const c of calls.creates) {
    const seen = byScope.get(c.scope);
    if (seen) {
      // Identical key means Stripe returns the SAME customer to both, so the
      // member's usage lands in one place. A differing key is a split counter and a
      // permanently under-reported window.
      assert.equal(c.key, seen, `two instances derived different keys for ${c.scope}`);
    } else byScope.set(c.scope, c.key);
  }
  assert.ok(byScope.size >= 2, "both the kind and the member scope were resolved");
  for (const [scope, key] of byScope) {
    assert.equal(key, `bt-usage-scope-${scope}`, "the key is derived from the scope, not generated");
  }
});

test("the key is stable across processes because it holds no local state", async () => {
  // No timestamp, no random, no pid — otherwise two instances would never agree
  // and the idempotency window would protect nothing.
  const calls = flakyStream();
  await stripeScopeUsageLedger().record(EVENT);
  for (const c of calls.creates) {
    assert.match(c.key, /^bt-usage-scope-org_1\|(k:user|u:u1)$/);
  }
});
