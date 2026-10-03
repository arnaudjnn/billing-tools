// The WorkOS leg of the billing sync: organization/user events onto the app's mirror rows,
// and the poller underneath it.
//
// `sync-faults.test.mjs` pins the Stripe leg's cursor. This is the other half, and it has a
// shape of its own: WorkOS lists events ASCENDING from an `after` cursor and returns a
// plain List, so the poller walks pages by hand — the place an off-by-one loses or replays
// an event.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { pollWorkOSEvents } from "../dist/events.js";
import { createBillingSync } from "../dist/sync.js";
import { __setWorkOSForTests } from "../dist/workos.js";

afterEach(() => {
  __setWorkOSForTests(null);
  __setStripeForTests(undefined);
});

/** `n` WorkOS events, served the way WorkOS serves them: ascending after a cursor,
 *  filtered by name, capped at `limit`. */
function fakeWorkOS(all) {
  const calls = [];
  return {
    calls,
    events: {
      async listEvents({ events, order, limit, after }) {
        calls.push({ events, order, limit, after });
        assert.equal(order, "asc");
        assert.ok(events?.length, "WorkOS requires the event-name filter");
        const wanted = all.filter((e) => events.includes(e.event));
        const from = after ? wanted.findIndex((e) => e.id === after) + 1 : 0;
        return { data: wanted.slice(from, from + (limit ?? 10)) };
      },
    },
  };
}

const evt = (i, event = "user.updated", data = { id: `user_${i}` }) => ({ id: `event_${String(i).padStart(4, "0")}`, event, data });
const many = (n, event) => Array.from({ length: n }, (_, i) => evt(i + 1, event));

// ── pollWorkOSEvents ─────────────────────────────────────────────────────────

test("no cursor: baselines to the NEWEST event across pages, processing nothing", async () => {
  const wos = fakeWorkOS(many(250));
  __setWorkOSForTests(wos);
  const seen = [];
  const r = await pollWorkOSEvents({ events: ["user.updated"], onEvent: async (e) => seen.push(e.id) });
  assert.equal(r.cursor, "event_0250");
  assert.equal(r.count, 0);
  assert.equal(seen.length, 0, "history is not replayed on first run");
  assert.equal(wos.calls.length, 3);
});

test("no cursor and no events: the cursor stays null", async () => {
  __setWorkOSForTests(fakeWorkOS([]));
  const r = await pollWorkOSEvents({ events: ["user.updated"], onEvent: async () => {} });
  assert.deepEqual(r, { cursor: null, count: 0 });
});

test("from a cursor: every newer event, oldest first, across page boundaries", async () => {
  __setWorkOSForTests(fakeWorkOS(many(230)));
  const seen = [];
  const r = await pollWorkOSEvents({
    after: "event_0010",
    events: ["user.updated"],
    onEvent: async (e) => seen.push(e.id),
  });
  assert.equal(seen.length, 220);
  assert.equal(seen[0], "event_0011");
  assert.equal(seen.at(-1), "event_0230");
  assert.deepEqual([...seen].sort(), seen, "in order");
  assert.equal(r.cursor, "event_0230");
  assert.equal(r.count, 220);
});

test("an exactly-full last page ends on the empty page after it", async () => {
  __setWorkOSForTests(fakeWorkOS(many(200)));
  const r = await pollWorkOSEvents({ after: "event_0100", events: ["user.updated"], onEvent: async () => {} });
  assert.equal(r.count, 100);
  assert.equal(r.cursor, "event_0200");
});

test("maxPerPoll caps the sweep and the cursor stops at the last event HANDLED", async () => {
  __setWorkOSForTests(fakeWorkOS(many(300)));
  const seen = [];
  const first = await pollWorkOSEvents({
    after: "event_0000",
    events: ["user.updated"],
    maxPerPoll: 150,
    onEvent: async (e) => seen.push(e.id),
  });
  assert.equal(first.count, 150);
  assert.equal(first.cursor, "event_0150");
  // The next sweep picks up exactly where the last stopped: nothing skipped, nothing twice.
  const second = await pollWorkOSEvents({
    after: first.cursor,
    events: ["user.updated"],
    onEvent: async (e) => seen.push(e.id),
  });
  assert.equal(second.cursor, "event_0300");
  assert.equal(new Set(seen).size, 300);
});

test("only the named event types are requested and handled", async () => {
  const all = [evt(1, "user.updated"), evt(2, "user.created"), evt(3, "organization.deleted", { id: "org_1" })];
  const wos = fakeWorkOS(all);
  __setWorkOSForTests(wos);
  const seen = [];
  await pollWorkOSEvents({
    after: "event_0000",
    events: ["user.updated", "organization.deleted"],
    onEvent: async (e) => seen.push(e.event),
  });
  assert.deepEqual(seen, ["user.updated", "organization.deleted"]);
});

test("a handler that keeps failing is retried, skipped, reported — and the cursor moves on", async () => {
  __setWorkOSForTests(fakeWorkOS(many(3)));
  let attempts = 0;
  const r = await pollWorkOSEvents({
    after: "event_0000",
    events: ["user.updated"],
    onEvent: async (e) => {
      if (e.id === "event_0002") {
        attempts++;
        throw new Error("user from another environment");
      }
    },
  });
  assert.equal(attempts, 3);
  assert.equal(r.cursor, "event_0003");
  assert.deepEqual(r.skipped.map((s) => s.id), ["event_0002"]);
});

test("a LIST failure throws: the sweep failed, not one event", async () => {
  __setWorkOSForTests({
    events: {
      async listEvents() {
        throw new Error("401 Unauthorized");
      },
    },
  });
  await assert.rejects(
    pollWorkOSEvents({ after: "event_0001", events: ["user.updated"], onEvent: async () => {} }),
    /401/,
  );
});

// ── createBillingSync: the WorkOS branches ───────────────────────────────────

function recordingMirror() {
  const ops = [];
  return {
    ops,
    async syncResource(id, resource) {
      ops.push(["sync", id, resource.name ?? resource.email ?? null]);
    },
    async remove(id) {
      ops.push(["remove", id]);
    },
  };
}

function memoryCursor(initial = {}) {
  const store = { ...initial };
  return {
    store,
    async get(source) {
      return store[source] ?? null;
    },
    async set(source, value) {
      if (value !== null) store[source] = value;
    },
  };
}

/** A Stripe whose event log is empty: the Stripe leg baselines and does nothing. */
function quietStripe() {
  return { events: { list: async () => ({ data: [] }) } };
}

function syncWith(events, extra = {}) {
  __setStripeForTests(quietStripe());
  __setWorkOSForTests(fakeWorkOS(events));
  const orgMirror = recordingMirror();
  const userMirror = recordingMirror();
  const deleted = [];
  const cursor = memoryCursor({ workos: "event_0000" });
  const sync = createBillingSync({
    adapter: {},
    plans: {},
    query: async () => {
      throw new Error("the default cursor table must not be used when `cursor` is given");
    },
    cursor,
    orgMirror,
    userMirror,
    hooks: { onUserDeleted: async (id) => deleted.push(id) },
    ...extra,
  });
  return { sync, orgMirror, userMirror, deleted, cursor };
}

test("organization.updated syncs the org row; organization.deleted removes it", async () => {
  const { sync, orgMirror, userMirror } = syncWith([
    evt(1, "organization.updated", { id: "org_1", name: "Acme" }),
    evt(2, "organization.deleted", { id: "org_2" }),
  ]);
  const r = await sync.runOnce();
  assert.deepEqual(orgMirror.ops, [
    ["sync", "org_1", "Acme"],
    ["remove", "org_2"],
  ]);
  assert.equal(userMirror.ops.length, 0);
  assert.deepEqual(r, { stripe: 0, workos: 2 });
});

test("user.updated syncs the user row; user.deleted removes it, then runs the app's hook", async () => {
  const { sync, orgMirror, userMirror, deleted } = syncWith([
    evt(1, "user.updated", { id: "user_1", email: "a@acme.com" }),
    evt(2, "user.deleted", { id: "user_2" }),
  ]);
  await sync.runOnce();
  assert.deepEqual(userMirror.ops, [
    ["sync", "user_1", "a@acme.com"],
    ["remove", "user_2"],
  ]);
  assert.deepEqual(deleted, ["user_2"]);
  assert.equal(orgMirror.ops.length, 0);
});

test("the cursor is persisted, so the next run handles only what is new", async () => {
  const events = [evt(1, "organization.updated", { id: "org_1", name: "A" })];
  const { sync, orgMirror, cursor } = syncWith(events);
  await sync.runOnce();
  assert.equal(cursor.store.workos, "event_0001");
  events.push(evt(2, "organization.updated", { id: "org_1", name: "B" }));
  const r = await sync.runOnce();
  assert.equal(r.workos, 1);
  assert.deepEqual(orgMirror.ops.map((o) => o[2]), ["A", "B"]);
});

test("an event with no id, or a type not mirrored, is ignored", async () => {
  const { sync, orgMirror, userMirror } = syncWith([
    evt(1, "organization.updated", {}),
    evt(2, "user.created", { id: "user_9" }), // not requested at all
  ]);
  const r = await sync.runOnce();
  assert.equal(orgMirror.ops.length + userMirror.ops.length, 0);
  assert.equal(r.workos, 1, "the id-less event still advances the cursor");
});

test("no mirrors configured: events are consumed without error", async () => {
  __setStripeForTests(quietStripe());
  __setWorkOSForTests(fakeWorkOS([evt(1, "user.deleted", { id: "user_1" })]));
  const sync = createBillingSync({ adapter: {}, plans: {}, query: async () => ({ rows: [], rowCount: 0 }), cursor: memoryCursor({ workos: "event_0000" }) });
  assert.deepEqual(await sync.runOnce(), { stripe: 0, workos: 1 });
});

test("a mirror that throws on one event is reported and passed, not wedged on", async () => {
  const faults = [];
  const { sync, orgMirror, cursor } = syncWith(
    [
      evt(1, "organization.updated", { id: "org_bad", name: "Bad" }),
      evt(2, "organization.updated", { id: "org_ok", name: "Ok" }),
    ],
    { onEventFault: (source, f) => faults.push([source, f.id]) },
  );
  const real = orgMirror.syncResource;
  orgMirror.syncResource = async (id, r) => {
    if (id === "org_bad") throw new Error("no such row");
    return real(id, r);
  };
  await sync.runOnce();
  assert.deepEqual(faults, [["workos", "event_0001"]]);
  assert.deepEqual(orgMirror.ops, [["sync", "org_ok", "Ok"]]);
  assert.equal(cursor.store.workos, "event_0002");
});

test("a Stripe leg that cannot poll does not stop the WorkOS leg", async () => {
  const { sync, orgMirror, cursor } = syncWith([evt(1, "organization.deleted", { id: "org_1" })]);
  __setStripeForTests({
    events: {
      list: async () => {
        throw new Error("stripe down");
      },
    },
  });
  await assert.rejects(sync.runOnce(), /stripe down/, "still surfaced");
  assert.deepEqual(orgMirror.ops, [["remove", "org_1"]]);
  assert.equal(cursor.store.workos, "event_0001");
});
