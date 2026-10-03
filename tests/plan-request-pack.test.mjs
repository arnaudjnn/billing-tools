// A QUOTED ask is open, and the queue's packing must treat it so.
//
// The plan-request queue lives in ONE WorkOS metadata value (600 chars), and `pack` sheds
// what costs least to lose when it overflows. It shed by `status !== "pending"`, so a
// `quoted` record — the price an operator just set, waiting on the customer — counted as
// settled history and was the FIRST thing dropped. `quote_plan_change` answered "quoted",
// the write fitted because the quote was gone, and `accept_plan_quote` could never run.
//
// Reproduced by testmode in Stripe TEST + WorkOS staging with exactly the records below: a
// member's pending seat ask beside an Enterprise ask carrying an ordinary-length email.
// The fake adapter enforces the 600-char limit, so a pack that does not fit fails here as
// it does in WorkOS.

import assert from "node:assert/strict";
import { test } from "vitest";

import { listPlanRequests, markPlanQuoteAccepted, quotePlanRequest } from "../dist/plan-request.js";
import { fakeAdapter, WORKOS_MAX_VALUE } from "./helpers.mjs";

const seatAsk = {
  id: "0f6c2b1e-5d3a-4c8e-9b7a-1e2d3c4b5a60",
  memberId: "user_01K6MEMBER0000000000000001",
  kind: "seat",
  plan: "premium",
  status: "pending",
  createdAt: "2026-10-03T08:00:00.000Z",
};
const enterpriseAsk = {
  id: "7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71",
  memberId: "user_01K6ADMIN00000000000000002",
  kind: "plan",
  plan: "enterprise",
  status: "pending",
  createdAt: "2026-10-03T08:01:00.000Z",
  metadata: { totalEstimatedSeats: 12 },
  contact: { firstName: "", lastName: "", email: "e2e.admin.1759478400@scartoffie.test" },
};

const adapterWith = (records) => fakeAdapter({ metadata: { btPlanRequests: JSON.stringify(records) } });
const QUOTE = { requestId: "7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71", credits: 10_000, unitPriceMinor: 0.7, note: "e2e quote", now: Date.parse("2026-10-03T09:00:00Z") };

test("the measured case: quoting the Enterprise ask beside a pending seat ask keeps BOTH", async () => {
  const adapter = adapterWith([seatAsk, enterpriseAsk]);
  assert.ok(adapter.store.btPlanRequests.length > 400, "the precondition: a queue already near the limit");

  const res = await quotePlanRequest(adapter, "org_1", QUOTE);
  assert.equal(res.ok, true);

  // REGRESSION: the stored queue held only the seat ask afterwards.
  const stored = await listPlanRequests(adapter, "org_1");
  const quoted = stored.find((r) => r.id === "7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71");
  assert.ok(quoted, "the quoted request is still there");
  assert.equal(quoted.status, "quoted");
  assert.deepEqual(
    { credits: quoted.quote.credits, unitPriceMinor: quoted.quote.unitPriceMinor, totalMinor: quoted.quote.totalMinor },
    { credits: 10_000, unitPriceMinor: 0.7, totalMinor: 7_000 },
  );
  assert.ok(stored.find((r) => r.id === "0f6c2b1e-5d3a-4c8e-9b7a-1e2d3c4b5a60"), "and the pending seat ask too");
  assert.ok(adapter.store.btPlanRequests.length <= WORKOS_MAX_VALUE);
});

test("what IS shed to make room is lossless or decoration: empty contact fields, then notes", async () => {
  const adapter = adapterWith([seatAsk, enterpriseAsk]);
  await quotePlanRequest(adapter, "org_1", QUOTE);
  const quoted = (await listPlanRequests(adapter, "org_1")).find((r) => r.id === "7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71");
  // The contact reads back whole: the empty fields are restored on read.
  assert.deepEqual(quoted.contact, enterpriseAsk.contact);
  assert.deepEqual(quoted.metadata, enterpriseAsk.metadata);
});

test("a quote that cannot fit is REFUSED, never written by dropping an open ask", async () => {
  // Two open asks that leave no room for any quote at all.
  const long = (id, i) => ({
    ...enterpriseAsk,
    id,
    memberId: `user_${String(i).repeat(26)}`,
    contact: { firstName: "Ada", lastName: "Rossi", email: `ada.rossi.${i}@scartoffie.test` },
  });
  const adapter = adapterWith([long("pr_a", 1), long("pr_b", 2)]);
  const before = adapter.store.btPlanRequests;
  assert.ok(before.length <= WORKOS_MAX_VALUE && before.length > WORKOS_MAX_VALUE - 60, `precondition: ${before.length}`);

  const res = await quotePlanRequest(adapter, "org_1", { ...QUOTE, requestId: "pr_b" });
  assert.deepEqual(res, { ok: false, reason: "queue_full" });
  assert.equal(adapter.store.btPlanRequests, before, "nothing was written");
});

test("a settled record is still shed before a quoted one", async () => {
  const done = { ...seatAsk, id: "pr_done", status: "done", note: "x".repeat(120) };
  const denied = { ...seatAsk, id: "pr_denied", status: "denied", note: "y".repeat(120) };
  const adapter = adapterWith([done, denied, enterpriseAsk]);
  const res = await quotePlanRequest(adapter, "org_1", QUOTE);
  assert.equal(res.ok, true);
  const ids = (await listPlanRequests(adapter, "org_1")).map((r) => r.id);
  assert.ok(ids.includes("7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71"), "the quote survives");
});

test("re-quoting an already-quoted ask keeps it open", async () => {
  const adapter = adapterWith([seatAsk, enterpriseAsk]);
  await quotePlanRequest(adapter, "org_1", QUOTE);
  const again = await quotePlanRequest(adapter, "org_1", { ...QUOTE, unitPriceMinor: 0.65, note: undefined });
  assert.equal(again.ok, true);
  const quoted = (await listPlanRequests(adapter, "org_1")).find((r) => r.id === "7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71");
  assert.equal(quoted.quote.unitPriceMinor, 0.65);
});

test("the quote it stored is one accept can find", async () => {
  const adapter = adapterWith([seatAsk, enterpriseAsk]);
  await quotePlanRequest(adapter, "org_1", QUOTE);
  const accepted = await markPlanQuoteAccepted(adapter, "org_1", {
    requestId: "7a9e4d2c-1b3f-4e6a-8c5d-2f1e0d9c8b71",
    accepted: { at: "2026-10-03T10:00:00.000Z", invoiceId: "in_1" },
  });
  assert.ok(accepted, "accept_plan_quote's lookup succeeds");
  assert.equal(accepted.status, "done");
});
