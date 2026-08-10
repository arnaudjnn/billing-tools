// Telling somebody: the transport, and the promise that telling can never break the thing
// it is about.
//
// Every event here describes something that ALREADY happened — the invitation exists, the
// credit is granted, the call was metered. So the interesting assertions are not "was it
// sent": they are that a failed send changes nothing, that a hung endpoint holds nothing
// open, that a refusal is not retried for ever, and that the id is stable enough for a
// receiver to dedupe on. Those are the four ways a notification channel takes down the
// product it is bolted to.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import {
  signNotification,
  verifyNotification,
  webhookNotifier,
} from "../dist/notifications/index.js";
import { createEmitter } from "../dist/notifications/emit.js";

const event = (over = {}) => ({
  id: "topup-requested:req_1",
  type: "topup.requested",
  orgId: "org_1",
  to: [],
  data: { requestId: "req_1", member: { id: "u_1", email: null }, credits: 250, window: null },
  ...over,
});

// ── The signature ────────────────────────────────────────────────────────────

test("a signature is verifiable, and only inside its replay window", () => {
  const now = 1_700_000_000_000;
  const body = JSON.stringify({ hello: "world" });
  const sig = signNotification("shh", "evt_1", now, body);

  const headers = { id: "evt_1", timestamp: String(now), signature: sig };
  assert.equal(verifyNotification("shh", headers, body, { now }), true);

  // A valid signature is valid FOR EVER without a window, which is the whole reason the
  // timestamp is signed alongside the body.
  assert.equal(verifyNotification("shh", headers, body, { now: now + 301_000 }), false);
  assert.equal(verifyNotification("shh", headers, body, { now: now + 299_000 }), true);
});

test("a tampered body, id or secret fails", () => {
  const now = 1_700_000_000_000;
  const body = JSON.stringify({ credits: 250 });
  const sig = signNotification("shh", "evt_1", now, body);
  const h = { id: "evt_1", timestamp: String(now), signature: sig };

  assert.equal(verifyNotification("shh", h, JSON.stringify({ credits: 25_000 }), { now }), false);
  assert.equal(verifyNotification("shh", { ...h, id: "evt_2" }, body, { now }), false);
  assert.equal(verifyNotification("other", h, body, { now }), false);
  // A receiver with a missing header must refuse rather than throw — an unsigned POST from
  // anywhere on the internet reaches this function.
  assert.equal(verifyNotification("shh", {}, body, { now }), false);
  assert.equal(verifyNotification("shh", { ...h, timestamp: "soon" }, body, { now }), false);
});

// ── The transport ────────────────────────────────────────────────────────────

test("the POST carries the id, the timestamp and a signature the receiver can check", async () => {
  let seen = null;
  const notifier = webhookNotifier({
    endpoint: "https://app.test/api/notify",
    secret: "shh",
    fetchImpl: async (url, init) => ((seen = { url, init }), new Response("", { status: 200 })),
  });

  const at = 1_700_000_000_000;
  await notifier.deliver({ ...event(), at });

  assert.equal(seen.url, "https://app.test/api/notify");
  assert.equal(seen.init.headers["billing-notification-id"], "topup-requested:req_1");
  assert.equal(seen.init.headers["billing-notification-timestamp"], String(at));
  assert.equal(
    verifyNotification(
      "shh",
      {
        id: seen.init.headers["billing-notification-id"],
        timestamp: seen.init.headers["billing-notification-timestamp"],
        signature: seen.init.headers["billing-notification-signature"],
      },
      seen.init.body,
      { now: at },
    ),
    true,
    "signed over the body actually sent, not over a re-serialisation of it",
  );
});

test("a 5xx is retried and a 4xx is not — the second one already answered", async () => {
  let calls = 0;
  const flaky = webhookNotifier({
    endpoint: "https://app.test/n",
    retries: 2,
    fetchImpl: async () => (++calls < 3 ? new Response("", { status: 503 }) : new Response("", { status: 200 })),
  });
  await flaky.deliver({ ...event(), at: 1 });
  assert.equal(calls, 3);

  calls = 0;
  const refused = webhookNotifier({
    endpoint: "https://app.test/n",
    retries: 2,
    fetchImpl: async () => (calls++, new Response("nope", { status: 400 })),
  });
  // Understood and refused. Repeating it just doubles the refusals.
  await refused.deliver({ ...event(), at: 1 });
  assert.equal(calls, 1);
});

test("it gives up rather than retrying for ever", async () => {
  let calls = 0;
  const dead = webhookNotifier({
    endpoint: "https://app.test/n",
    retries: 1,
    fetchImpl: async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => dead.deliver({ ...event(), at: 1 }));
  assert.equal(calls, 2, "the first attempt plus one retry");
});

// ── Emission ─────────────────────────────────────────────────────────────────

const adapterWith = (members) => ({
  async validateApiKey() {
    return { orgId: "org_1" };
  },
  async listMembers() {
    return members;
  },
});

const MEMBERS = [
  { userId: "u_admin", email: "boss@acme.test", name: "Boss", roleSlug: "admin", status: "active" },
  { userId: "u_1", email: "dev@acme.test", name: "Dev", roleSlug: "member", status: "active" },
  { userId: "u_2", email: null, name: "No Address", roleSlug: "admin", status: "active" },
];

/** The emitter is fire-and-forget, so a test has to wait for the microtask it spawned. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("`admins` resolves to the admins, and a member with no address is not a recipient", async () => {
  const sent = [];
  const notify = createEmitter(adapterWith(MEMBERS), { deliver: async (n) => void sent.push(n) });

  notify({ ...event(), audience: { kind: "admins" } });
  await settle();

  assert.deepEqual(sent[0].to, ["boss@acme.test"]);
  // The event names a member the caller could not address; the same lookup answers it.
  assert.equal(sent[0].data.member.email, "dev@acme.test");
});

test("`member` resolves to the one person, and `email` to a literal address", async () => {
  const sent = [];
  const notify = createEmitter(adapterWith(MEMBERS), { deliver: async (n) => void sent.push(n) });

  notify({ ...event({ type: "topup.resolved" }), audience: { kind: "member", memberId: "u_1" } });
  notify({
    ...event({ type: "invitation.created", id: "invite:inv_9" }),
    audience: { kind: "email", email: "new@acme.test" },
  });
  await settle();

  // Found by type rather than by index, because delivery is NOT ordered: an `email`
  // audience needs no lookup and overtakes a `member` one that is waiting on the adapter.
  // Nothing here depends on the order, and a test that pretended otherwise would be the
  // only thing that did.
  const byType = (t) => sent.find((n) => n.type === t);
  assert.deepEqual(byType("topup.resolved").to, ["dev@acme.test"]);
  // An invitee is not a member yet, so no lookup can find them.
  assert.deepEqual(byType("invitation.created").to, ["new@acme.test"]);
});

test("nobody to tell is not a delivery", async () => {
  const sent = [];
  const notify = createEmitter(adapterWith([]), { deliver: async (n) => void sent.push(n) });
  notify({ ...event(), audience: { kind: "admins" } });
  await settle();
  assert.deepEqual(sent, [], "a POST to nobody is a round trip for nothing");
});

test("an UNADDRESSED event is still delivered — an empty `to` is its shape, not a failed lookup", async () => {
  const sent = [];
  const notify = createEmitter(adapterWith(MEMBERS), { deliver: async (n) => void sent.push(n) });

  // `quote.requested` is the one event whose audience is on our side of the transaction: it
  // names the deployment's OPERATORS, whom the consumer routes (an ops inbox, a Slack
  // channel, a CRM), so it carries no `audience` and an empty `to`. Testing it on the same
  // "nobody to tell" guard as an admins lookup that found nobody meant the one event the
  // operators exist to receive was the one event never sent, and a workspace asking for a
  // price reached nobody at all.
  notify({
    id: "quote-requested:q_1",
    type: "quote.requested",
    orgId: "org_1",
    to: [],
    data: { quoteId: "q_1", member: { id: "u_1", email: null }, quote: {} },
  });
  await settle();

  assert.equal(sent.length, 1, "the operator ask must reach the transport");
  assert.deepEqual(sent[0].to, [], "and it is the consumer that decides where it goes");
});

test("a broken notifier cannot break the thing it is describing", async () => {
  const errors = [];
  const notify = createEmitter(
    adapterWith(MEMBERS),
    {
      deliver: async () => {
        throw new Error("the email service is down");
      },
    },
    (e) => errors.push(e),
  );

  // The call itself must not throw and must not be awaited: the top-up was already granted
  // when this ran, and an exception here would surface as a failed grant.
  assert.equal(notify({ ...event(), audience: { kind: "admins" } }), undefined);
  await settle();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /email service is down/);
});

test("an adapter that cannot list members tells nobody, rather than throwing", async () => {
  const errors = [];
  const notify = createEmitter(
    {
      async validateApiKey() {
        return { orgId: "org_1" };
      },
      async listMembers() {
        throw new Error("WorkOS is down");
      },
    },
    { deliver: async () => {} },
    (e) => errors.push(e),
  );
  notify({ ...event(), audience: { kind: "admins" } });
  await settle();
  assert.deepEqual(errors, [], "an unreadable membership is the same outcome as no notifier");
});

test("no notifier is no emitter at all — a deployment that wants none pays nothing", () => {
  assert.equal(createEmitter(adapterWith(MEMBERS), undefined), undefined);
});

// ── The flows actually fire ──────────────────────────────────────────────────
//
// The transport being right is worth nothing if no call site reaches it. These drive the
// real functions — the ask, the answer, the unprompted grant — through `fakeAdapter`, which
// is what would catch the emission being wired into the tool and not into the bound API, or
// into one of the two paths that file a top-up.

import { fakeAdapter } from "./helpers.mjs";
import { approveTopUp, denyTopUp, grantTopUp, requestTopUp } from "../dist/topup.js";

function collector() {
  const sent = [];
  return { sent, notify: createEmitter(memberAdapter(), { deliver: async (n) => void sent.push(n) }) };
}

const memberAdapter = () =>
  Object.assign(fakeAdapter({ members: ["u_admin", "u_1"] }), {
    async listMembers() {
      return MEMBERS;
    },
  });

test("asking for a top-up tells the ADMINS, and the answer goes back to the member", async () => {
  const store = fakeAdapter({ members: ["u_admin", "u_1"] });
  const { sent, notify } = collector();
  const req = {
    id: "req_7",
    memberId: "u_1",
    amount: 250,
    cycle: "2026-08",
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  await requestTopUp(store, "org_1", req, notify);
  await approveTopUp(store, "org_1", "req_7", notify);
  await settle();

  const asked = sent.find((n) => n.type === "topup.requested");
  assert.deepEqual(asked.to, ["boss@acme.test"], "the people who can answer it");
  assert.equal(asked.data.credits, 250);
  // The request id, so a redelivery is one email and not two.
  assert.equal(asked.id, "topup-requested:req_7");

  const answered = sent.find((n) => n.type === "topup.resolved");
  assert.deepEqual(answered.to, ["dev@acme.test"], "the person who asked");
  assert.equal(answered.data.outcome, "approved");
  assert.equal(answered.id, "topup-approved:req_7");
});

test("a denial is a different event from an approval of the same request", async () => {
  const store = fakeAdapter({ members: ["u_admin", "u_1"] });
  const { sent, notify } = collector();
  await requestTopUp(
    store,
    "org_1",
    { id: "req_8", memberId: "u_1", amount: 100, cycle: "2026-08", createdAt: "2026-08-01T00:00:00.000Z" },
    notify,
  );
  await denyTopUp(store, "org_1", "req_8", notify);
  await settle();

  const answered = sent.find((n) => n.type === "topup.resolved");
  assert.equal(answered.data.outcome, "denied");
  // Not `topup-approved:req_8` — a receiver deduping on the id must not swallow the second
  // decision as a repeat of the first.
  assert.equal(answered.id, "topup-denied:req_8");
});

test("an unprompted grant is announced too — nobody asked, so nobody is expecting it", async () => {
  const store = fakeAdapter({ members: ["u_admin", "u_1"] });
  const { sent, notify } = collector();
  await grantTopUp(store, "org_1", { memberId: "u_1", amount: 500, cycle: "2026-08", id: "g_1" }, notify);
  await settle();

  const granted = sent.find((n) => n.type === "topup.resolved");
  assert.equal(granted.data.outcome, "granted");
  assert.deepEqual(granted.to, ["dev@acme.test"]);
});
