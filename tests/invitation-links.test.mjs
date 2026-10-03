// The accept link in an invitation email must be ABSOLUTE.
//
// `createWorkOSInvitations` defaulted `baseUrl` to "", so a service built without one
// recorded `acceptUrl: "/invita/<id>"`. `createBilling` fell back to `config.baseUrl` only
// when the value was MISSING, and a relative string is not missing — so a deployment that
// let the library send its invitations emailed a link nobody could click. Seen in
// production (scartoffie builds the service with a map and `canAccept`, and no baseUrl).

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { createBilling } from "../dist/create-billing.js";
import { createWorkOSInvitations } from "../dist/invitations.js";
import { __setWorkOSForTests } from "../dist/workos.js";

afterEach(() => __setWorkOSForTests(null));

function fakeWorkOS() {
  let seq = 0;
  return {
    userManagement: {
      async sendInvitation({ email, organizationId, roleSlug }) {
        return {
          id: `invitation_${++seq}`,
          email,
          organizationId,
          roleSlug,
          state: "pending",
          createdAt: "2026-10-03T00:00:00.000Z",
          expiresAt: "2026-10-10T00:00:00.000Z",
        };
      },
      async listUsers() {
        return { data: [{ id: "user_new" }] };
      },
      async listInvitations() {
        return { data: [], autoPagination: async () => [] };
      },
    },
  };
}

const adapter = {
  async validateApiKey() {
    return { orgId: "org_1" };
  },
  async getOrgDomains() {
    return [];
  },
  async getBillingCustomerId() {
    return null;
  },
  async setBillingCustomerId() {},
  async ensureOrgForUser() {
    return { orgId: "org_1" };
  },
  async mintApiKey() {
    return { id: "k", value: "sk" };
  },
  async listApiKeys() {
    return [];
  },
  async revokeApiKey() {
    return null;
  },
  async listMemberIds() {
    return ["user_admin"];
  },
  async memberCount() {
    return 1;
  },
};

const settle = () => new Promise((r) => setTimeout(r, 20));

function billingWith(invitations, baseUrl = "https://app.test") {
  const sent = [];
  const billing = createBilling({
    adapter,
    config: { baseUrl, currency: "eur" },
    members: { invitations },
    notifications: { deliver: async (n) => void sent.push(n) },
  });
  return { billing, sent };
}

test("a service with no baseUrl: the emailed link is resolved against config.baseUrl", async () => {
  // REGRESSION: this was "/invita/invitation_1".
  __setWorkOSForTests(fakeWorkOS());
  const { billing, sent } = billingWith(createWorkOSInvitations());
  await billing.api.members.invite("org_1", { email: "new@acme.test", roleSlug: "member" });
  await settle();
  const event = sent.find((n) => n.type === "invitation.created");
  assert.equal(event.data.acceptUrl, "https://app.test/invita/invitation_1");
});

test("a custom acceptPath survives, and so does a base URL served under a path", async () => {
  __setWorkOSForTests(fakeWorkOS());
  const { billing, sent } = billingWith(
    createWorkOSInvitations({ acceptPath: "/join" }),
    "https://acme.test/app/",
  );
  await billing.api.members.invite("org_1", { email: "new@acme.test" });
  await settle();
  assert.equal(sent.find((n) => n.type === "invitation.created").data.acceptUrl, "https://acme.test/app/join/invitation_1");
});

test("a service's own absolute link is kept as it is", async () => {
  __setWorkOSForTests(fakeWorkOS());
  const { billing, sent } = billingWith(createWorkOSInvitations({ baseUrl: "https://invites.acme.test/" }));
  await billing.api.members.invite("org_1", { email: "new@acme.test" });
  await settle();
  assert.equal(
    sent.find((n) => n.type === "invitation.created").data.acceptUrl,
    "https://invites.acme.test/invita/invitation_1",
    "no double slash from the trailing one",
  );
});

test("a custom service that records no link gets the default one, absolute", async () => {
  const service = {
    async send(orgId, email, roleSlug) {
      return { id: "inv_x", email, roleSlug, orgId, organizationId: "org_w", state: "pending", createdAt: "", expiresAt: "" };
    },
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async accept() {
      return { orgId: "org_1" };
    },
    async revoke() {},
  };
  const { billing, sent } = billingWith(service);
  await billing.api.members.invite("org_1", { email: "x@acme.test" });
  await settle();
  assert.equal(sent.find((n) => n.type === "invitation.created").data.acceptUrl, "https://app.test/invita/inv_x");
});

test("createBilling refuses to send invitations with a relative config.baseUrl", () => {
  assert.throws(() => billingWith(createWorkOSInvitations(), ""), /config\.baseUrl must be an absolute URL/);
  assert.throws(() => billingWith(createWorkOSInvitations(), "app.test"), /absolute URL/);
  // Without a notifier the library sends nothing, so there is nothing to refuse.
  assert.doesNotThrow(() =>
    createBilling({ adapter, config: { baseUrl: "", currency: "eur" }, members: { invitations: createWorkOSInvitations() } }),
  );
});

test("createWorkOSInvitations refuses a baseUrl that is not absolute", () => {
  for (const bad of ["", "app.test", "/app", "ftp://app.test"]) {
    assert.throws(() => createWorkOSInvitations({ baseUrl: bad }), /absolute URL/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => createWorkOSInvitations({ baseUrl: "http://localhost:3000" }));
});

test("a sendEmail hook without baseUrl is refused — it would email a relative link", () => {
  assert.throws(
    () => createWorkOSInvitations({ hooks: { sendEmail: async () => {} } }),
    /sendEmail needs baseUrl/,
  );
});

test("the sendEmail hook is handed an absolute link", async () => {
  __setWorkOSForTests(fakeWorkOS());
  const links = [];
  const service = createWorkOSInvitations({
    baseUrl: "https://app.test/",
    hooks: { sendEmail: async (ctx) => void links.push(ctx.acceptUrl) },
  });
  const inv = await service.send("org_1", "New@Acme.test", "member");
  assert.deepEqual(links, ["https://app.test/invita/invitation_1"]);
  assert.equal(inv.acceptUrl, links[0]);
});
