// One event must not wedge the sweep.
//
// `pollStripeEvents` advances its cursor per event, and a throw used to leave the
// caller's stored cursor untouched "so the page is retried rather than
// half-skipped". That is right for a TRANSIENT failure and fatal for a permanent
// one — and permanent is the common case, because the Stripe account is shared
// across environments and an event carrying an `org_id` this deployment does not
// have can never succeed.
//
// Measured in production before this: the cursor sat on one such event for TWELVE
// DAYS. Nothing mirrored for any org in that time — no `past_due`, no plan change,
// no cancellation — because state mirroring is deliberately the poller's job and
// not the webhook's, so there was no second path. The only signal was a log line.
//
// These assert the CURSOR, because the cursor is the bug. A test that only checked
// "the handler was called" passes on the broken version.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { pollStripeEvents } from "../dist/events.js";

afterEach(() => __setStripeForTests(undefined));

/** Three events, oldest first, served the way Stripe serves them: newest-first
 *  pages, `ending_before` walking forward from the cursor. */
function fakeStripe(ids = ["evt_1", "evt_2", "evt_3"]) {
  const all = ids.map((id) => ({ id, type: "customer.subscription.updated" }));
  return {
    events: {
      async list({ ending_before, limit }) {
        if (!ending_before) return { data: [all[all.length - 1]] };
        const from = all.findIndex((e) => e.id === ending_before);
        // Newer than the cursor, newest first, capped like the real API.
        return { data: all.slice(from + 1).reverse().slice(0, limit ?? 100) };
      },
    },
  };
}

test("an event that can never succeed is skipped, and the cursor moves PAST it", async () => {
  __setStripeForTests(fakeStripe());
  const seen = [];

  const r = await pollStripeEvents({
    after: "evt_1",
    onEvent: async (e) => {
      seen.push(e.id);
      if (e.id === "evt_2") throw new Error("Workspace ws_probe not found");
    },
  });

  // THE ASSERTION THAT MATTERS: the cursor is past the poison, so the next sweep
  // does not re-read it for ever.
  assert.equal(r.cursor, "evt_3");
  assert.equal(r.count, 2);
  assert.deepEqual(
    r.skipped.map((s) => s.id),
    ["evt_2"],
    "it is REPORTED — skipping silently is the same failure wearing a different hat",
  );
  // And the event after it was still processed, which is the whole point.
  assert.ok(seen.includes("evt_3"));
});

test("it is retried before being given up on, so a blip does not lose it", async () => {
  __setStripeForTests(fakeStripe());
  let attempts = 0;

  const r = await pollStripeEvents({
    after: "evt_1",
    onEvent: async (e) => {
      if (e.id !== "evt_2") return;
      attempts++;
      if (attempts < 2) throw new Error("ECONNRESET");
    },
  });

  assert.equal(attempts, 2, "retried within the sweep");
  assert.equal(r.cursor, "evt_3");
  assert.equal(
    r.skipped,
    undefined,
    "a transient failure that then succeeded is not a fault and must not be reported",
  );
});

test("every event failing still advances — an outage must not pin the cursor either", async () => {
  __setStripeForTests(fakeStripe());

  const r = await pollStripeEvents({
    after: "evt_1",
    onEvent: async () => {
      throw new Error("the database is down");
    },
  });

  // Deliberate: the alternative is the wedge. The next sweep starts from evt_3,
  // and the mirror self-heals on the next event for each subscription — where a
  // pinned cursor heals never.
  assert.equal(r.cursor, "evt_3");
  assert.equal(r.skipped.length, 2);
});

test("a clean sweep reports nothing", async () => {
  __setStripeForTests(fakeStripe());
  const r = await pollStripeEvents({ after: "evt_1", onEvent: async () => {} });
  assert.equal(r.cursor, "evt_3");
  assert.equal(r.count, 2);
  assert.equal(r.skipped, undefined);
});

test("a LIST failure still throws — it is the sweep failing, not one event", async () => {
  // The distinction the two paths turn on: an event nobody can handle is skipped,
  // while an API that cannot be reached is a real failure the caller must see and
  // retry. Swallowing this one would baseline the cursor over unread history.
  __setStripeForTests({
    events: {
      async list() {
        throw new Error("Stripe is unreachable");
      },
    },
  });

  await assert.rejects(
    () => pollStripeEvents({ after: "evt_1", onEvent: async () => {} }),
    /Stripe is unreachable/,
  );
});
