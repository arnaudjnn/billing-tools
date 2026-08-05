// Before this, every tool call resolved to an ORG and nothing else, so a member
// holding a workspace API key could approve their own top-up or move themselves
// onto a premium seat — while the app's own UI refused them. The frontend was
// safer than the API, which is backwards for a library whose pitch is that the
// frontend is just an API request.
//
// The rule being asserted: an org key (no principal) keeps working exactly as it
// did, because that credential means "the org" and always has. A caller that
// names a user gets checked.

import assert from "node:assert/strict";
import { test } from "vitest";

import { enforceAdmin, runWithAuth, runWithPrincipal } from "../dist/auth.js";

function adapter({ admins = [], withIsAdmin = true } = {}) {
  const base = {
    async validateApiKey(token) {
      return token === "sk_good" ? { orgId: "org_1" } : null;
    },
  };
  if (!withIsAdmin) return base;
  return {
    ...base,
    async isAdmin(_orgId, userId) {
      return admins.includes(userId);
    },
  };
}

const bearer = "Bearer sk_good";

test("an org key with no principal keeps full access", async () => {
  // The compatibility guarantee: gtm-tools and every existing agent call.
  const r = await runWithAuth(bearer, () => enforceAdmin(adapter(), "approve_top_up"));
  assert.equal(r.authorized, true);
  assert.equal(r.orgId, "org_1");
  assert.equal(r.principal, null);
});

test("an admin principal is allowed", async () => {
  const r = await runWithPrincipal(
    { authHeader: bearer, principal: { userId: "user_owner" } },
    () => enforceAdmin(adapter({ admins: ["user_owner"] }), "approve_top_up"),
  );
  assert.equal(r.authorized, true);
});

test("a member principal is refused", async () => {
  const r = await runWithPrincipal(
    { authHeader: bearer, principal: { userId: "user_member" } },
    () => enforceAdmin(adapter({ admins: ["user_owner"] }), "approve_top_up"),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Forbidden \(403\)/);
  assert.match(r.content[0].text, /approve_top_up/);
});

test("a pre-resolved role skips the adapter lookup", async () => {
  let looked = 0;
  const a = {
    async validateApiKey() {
      return { orgId: "org_1" };
    },
    async isAdmin() {
      looked++;
      return false;
    },
  };
  const r = await runWithPrincipal(
    { authHeader: bearer, principal: { userId: "user_owner", isAdmin: true } },
    () => enforceAdmin(a, "assign_seat_type"),
  );
  assert.equal(r.authorized, true);
  assert.equal(looked, 0);
});

test("an adapter that cannot answer allows rather than locks everyone out", async () => {
  // Refusing here would silently disable every management tool for any adapter
  // without a role concept — a worse failure than the one being prevented.
  const r = await runWithPrincipal(
    { authHeader: bearer, principal: { userId: "user_member" } },
    () => enforceAdmin(adapter({ withIsAdmin: false }), "approve_top_up"),
  );
  assert.equal(r.authorized, true);
});

test("a bad key is still a 401, not a 403", async () => {
  const r = await runWithPrincipal(
    { authHeader: "Bearer sk_bad", principal: { userId: "user_owner" } },
    () => enforceAdmin(adapter({ admins: ["user_owner"] }), "approve_top_up"),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Unauthorized \(401\)/);
});

// ── get_plan is a READ ───────────────────────────────────────────────────────
//
// It called `enforceAdmin`, copied from the three tools that CHANGE a plan beside it, so
// a plain member could not answer "what is my workspace paying for". Every other read in
// the library — list_invoices, get_credit_balance, get_usage — is member-visible; this
// one was the outlier, and nothing about a read needs an owner.
test("a member can read which plan the workspace is on", async () => {
  const { createDispatcher } = await import("../dist/dispatch.js");
  const { registerBillingTools } = await import("../dist/tools/register.js");
  const { runWithPrincipal } = await import("../dist/auth.js");
  const { __setStripeForTests } = await import("../dist/billing.js");

  __setStripeForTests({
    subscriptions: { list: async () => ({ data: [] }) },
    customers: { async retrieve() { return { id: "cus_1", metadata: {} }; } },
  });

  const adapter = {
    async validateApiKey() { return { orgId: "org_1" }; },
    async getOrgDomains() { return []; },
    async getBillingCustomerId() { return "cus_1"; },
    async setBillingCustomerId() {},
    async getOrgMetadata() { return {}; },
    async setOrgMetadata() {},
    async getSubscription() { return { plan: "pro", status: "active", subscriptionId: null, periodEnd: null }; },
    // The member is NOT an admin — the whole point.
    async isAdmin() { return false; },
  };

  const PLANS = {
    pro: {
      sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } },
      cap: { kind: "pool", credits: 1000 },
      replenish: { purchase: {} },
      sale: "self_serve",
    },
  };

  const { dispatchTool } = createDispatcher((server) =>
    registerBillingTools(server, {
      adapter,
      config: { currency: "eur", baseUrl: "https://t.local", internalDomains: [] },
      plans: PLANS,
    }),
  );

  const asMember = (tool) =>
    runWithPrincipal({ authHeader: "Bearer sk_x", principal: { userId: "usr_member" } }, () =>
      dispatchTool(tool, {}),
    );

  // The read goes through.
  const plan = await asMember("get_plan");
  assert.ok(plan, "a member must be able to read get_plan");

  // And the WRITES beside it still refuse, which is what makes the change a narrowing of
  // one tool rather than a hole in the gate.
  await assert.rejects(() => asMember("cancel_plan"), /Forbidden \(403\)/);
});
