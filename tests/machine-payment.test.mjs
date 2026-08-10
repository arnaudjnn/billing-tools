// MPP — the 402 challenge, the retry, and what a paid request is actually WORTH.
//
// The module implemented the protocol correctly and then stopped: settlement is injected,
// nothing mounted it, and `onPaid` was a callback the consumer had to write — so a request
// that was genuinely challenged, paid and verified granted the payer nothing. It also had
// no tests at all, which is why the shape below is asserted header by header: the challenge
// is a wire format other people's clients parse, and "we changed the quoting" is not
// something a type checker can notice.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { createMachinePaymentHandler, createPaymentMd } from "../dist/machine-payment/index.js";

const opts = { amount: 500, currency: "eur", networkId: "profile_123" };
const plain = () => new Request("https://api.test/thing");

test("no credential is a 402 that TELLS the client how to pay", async () => {
  const { requirePayment } = createMachinePaymentHandler(opts);
  const res = await requirePayment(plain());

  assert.equal(res.status, 402);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  // Never cached: a challenge id is single-use, and a cached 402 would replay a dead one.
  assert.equal(res.headers.get("cache-control"), "no-store");

  const challenge = res.headers.get("www-authenticate");
  assert.match(challenge, /^Payment /);
  assert.match(challenge, /method="stripe"/);
  assert.match(challenge, /intent="charge"/);
  assert.match(challenge, /amount="500"/);
  assert.match(challenge, /currency="eur"/);
  assert.match(challenge, /payTo="profile_123"/);

  const body = await res.json();
  assert.equal(body.status, 402);
  assert.equal(body.type, "https://paymentauth.org/problems/payment-required");
  assert.deepEqual(body.accepts, [
    { method: "stripe", amount: 500, currency: "eur", payTo: "profile_123" },
  ]);
  assert.ok(body.challengeId, "the client quotes this back on the retry");
});

test("without a settler it stays a 402 and says why — never a 500", async () => {
  // Settlement needs a machine-payments-eligible Stripe account. Until then the honest
  // answer is "not enabled", in the protocol's own shape, so a client can read it.
  const { requirePayment } = createMachinePaymentHandler(opts);
  const res = await requirePayment(
    new Request("https://api.test/thing", { headers: { authorization: "Payment cred_1" } }),
  );
  assert.equal(res.status, 402);
  assert.match((await res.json()).detail, /settlement is not enabled/i);
});

test("a settled retry pays, and the credential is read from either header", async () => {
  const seen = [];
  const handler = createMachinePaymentHandler({
    ...opts,
    settle: async (credential) => (seen.push(credential), { receipt: "rcpt_1" }),
  });

  const viaAuth = await handler.requirePayment(
    new Request("https://api.test/thing", { headers: { authorization: "Payment cred_a" } }),
  );
  assert.equal(viaAuth.paid, true);
  assert.equal(viaAuth.receipt, "rcpt_1");

  // X-Payment is the other header MPP clients use in the wild.
  const viaX = await handler.requirePayment(
    new Request("https://api.test/thing", { headers: { "x-payment": "cred_b" } }),
  );
  assert.equal(viaX.paid, true);
  assert.deepEqual(seen, ["cred_a", "cred_b"]);
});

test("a rejected credential is a 402 again, not an error", async () => {
  const handler = createMachinePaymentHandler({ ...opts, settle: async () => null });
  const res = await handler.requirePayment(
    new Request("https://api.test/thing", { headers: { authorization: "Payment bad" } }),
  );
  assert.equal(res.status, 402);
  assert.match((await res.json()).detail, /declined/i);
});

test("onPaid is handed the challenge, which is what a wallet credit keys on", async () => {
  const paid = [];
  const handler = createMachinePaymentHandler({
    ...opts,
    settle: async () => ({ receipt: "rcpt_2" }),
    onPaid: (challenge, receipt) => void paid.push({ id: challenge.id, amount: challenge.amount, receipt }),
  });
  await handler.requirePayment(
    new Request("https://api.test/thing", { headers: { authorization: "Payment cred" } }),
  );
  assert.equal(paid.length, 1);
  assert.equal(paid[0].amount, 500);
  assert.equal(paid[0].receipt, "rcpt_2");
  assert.ok(paid[0].id, "server-issued and single-use — the idempotency key for the credit");
});

test("payment.md describes the same price the challenge quotes", async () => {
  const res = await createPaymentMd({ productName: "Acme", amount: 500, currency: "eur" })(plain());
  const text = await res.text();
  assert.match(res.headers.get("content-type"), /text\/markdown/);
  assert.match(text, /Acme/);
});

// ── The 402 that becomes an offer, on the surfaces that WRITE the 402 ─────────
//
// Both consumers had hand-written this: dispatch, look for a 402, call requirePayment,
// dispatch again. It is ten lines, twice, in the one place where getting the retry wrong
// means either charging twice or serving for free — so it belongs where the 402 is
// written. These pin the two halves that a wrapper kept getting to decide: that the retry
// re-runs the CALL (paying funds the meter, it does not skip it), and that only the money
// refusal is offered a payment.

import { createToolDispatchHandler } from "../dist/routes/rest.js";

const ctx = (tool) => ({ params: Promise.resolve({ tool }) });
const post = (body = {}) =>
  new Request("https://api.test/api/v0/do_thing", { method: "POST", body: JSON.stringify(body) });

function dispatcherRefusing(times) {
  let calls = 0;
  return {
    calls: () => calls,
    args: [],
    getToolNames: () => ["do_thing"],
    async dispatchTool(_name, args) {
      this.args.push(args);
      calls++;
      if (calls <= times) throw new Error("Insufficient credits. Buy more to continue.");
      return { status: "ok" };
    },
  };
}

test("an empty wallet is answered with a challenge, not a dead end", async () => {
  const dispatcher = dispatcherRefusing(Infinity);
  const handler = createToolDispatchHandler({
    dispatcher,
    payment: createMachinePaymentHandler({ amount: 30, currency: "usd" }),
  });

  const res = await handler(post({ q: 1 }), ctx("do_thing"));
  assert.equal(res.status, 402);
  assert.match(res.headers.get("www-authenticate"), /^Payment .*amount="30"/);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.equal(dispatcher.calls(), 1, "not dispatched again — nothing was paid");
});

test("a settled payment re-runs the CALL, with the same arguments", async () => {
  // The retry is a second real dispatch: the wallet was credited, so the call is metered
  // like any other. Waving it through would serve a request nobody was charged for.
  const dispatcher = dispatcherRefusing(1);
  const handler = createToolDispatchHandler({
    dispatcher,
    payment: createMachinePaymentHandler({
      amount: 30,
      currency: "usd",
      settle: async () => ({ receipt: "rcpt" }),
    }),
  });

  const res = await handler(
    new Request("https://api.test/api/v0/do_thing", {
      method: "POST",
      body: JSON.stringify({ q: 7 }),
      headers: { authorization: "Payment cred" },
    }),
    ctx("do_thing"),
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
  assert.equal(dispatcher.calls(), 2);
  // A Request body reads once, which is why the handler parses it up front rather than
  // cloning: the retry has to carry the SAME arguments, not an empty object.
  assert.deepEqual(dispatcher.args, [{ q: 7 }, { q: 7 }]);
});

test("no payment configured leaves the 402 exactly as it was", async () => {
  const dispatcher = dispatcherRefusing(Infinity);
  const res = await createToolDispatchHandler({ dispatcher })(post(), ctx("do_thing"));
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("a rate limit is never offered a payment — no payment lifts it", async () => {
  // 429, and the challenge must not appear: a caller that pays for a rate limit has been
  // charged for nothing.
  const dispatcher = {
    getToolNames: () => ["do_thing"],
    dispatchTool: async () => ({ status: "try_again_later", retry_after_seconds: 42 }),
  };
  const res = await createToolDispatchHandler({
    dispatcher,
    payment: createMachinePaymentHandler({ amount: 30, currency: "usd" }),
  })(post(), ctx("do_thing"));

  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  assert.equal(res.headers.get("www-authenticate"), null);
});
