// Shared fakes for the suite. Everything here is in-memory: these tests assert
// the library's ARITHMETIC and its storage contracts, and must run with no
// Stripe key, no WorkOS key and no network. The paths that genuinely need
// Stripe are covered by the test-clock script, not by unit tests.

/**
 * A BillingAdapter backed by a plain object, with the org-metadata store the
 * top-up and seat features require.
 */
export function fakeAdapter({ orgId = "org_1", metadata = {}, subscription = null } = {}) {
  const store = { ...metadata };
  const calls = { setOrgMetadata: 0 };
  return {
    orgId,
    calls,
    store,
    async validateApiKey() {
      return { orgId };
    },
    async getOrgDomains() {
      return [];
    },
    async getBillingCustomerId() {
      return "cus_test";
    },
    async setBillingCustomerId() {},
    async ensureOrgForUser() {
      return { orgId };
    },
    async mintApiKey() {
      return { id: "key_1", value: "sk_test" };
    },
    async listApiKeys() {
      return [];
    },
    async revokeApiKey() {
      return null;
    },
    async getOrgMetadata() {
      return { ...store };
    },
    async setOrgMetadata(_org, patch) {
      calls.setOrgMetadata++;
      // WorkOS replaces the whole object; the library merges before writing, so
      // the fake merges too — a fake that replaced would hide that contract.
      Object.assign(store, patch);
    },
    async getSubscription() {
      if (!subscription) throw new Error("no subscription");
      return subscription;
    },
  };
}

/** A minimal ResolvedConfig. */
export const testConfig = {
  freeCredits: 100,
  currency: "eur",
  baseUrl: "https://example.test",
  internalDomains: [],
};
