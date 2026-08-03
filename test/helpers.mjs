// Shared fakes for the suite. Everything here is in-memory: these tests assert
// the library's ARITHMETIC and its storage contracts, and must run with no
// Stripe key, no WorkOS key and no network. The paths that genuinely need
// Stripe are covered by the test-clock script, not by unit tests.

// WorkOS's real metadata limits. The fake ENFORCES them, because a fake that
// accepts anything is how a value bounded at 50 records shipped for a store that
// holds 2: every test passed, and the write failed only in production — where it
// failed the whole org metadata update, subscription sync included.
export const WORKOS_MAX_KEYS = 10;
export const WORKOS_MAX_VALUE = 600;

function assertWithinLimits(where, store) {
  const keys = Object.keys(store);
  if (keys.length > WORKOS_MAX_KEYS) {
    throw new Error(`${where}: ${keys.length} keys exceeds the WorkOS limit of ${WORKOS_MAX_KEYS}`);
  }
  for (const [k, v] of Object.entries(store)) {
    if (typeof v === "string" && v.length > WORKOS_MAX_VALUE) {
      throw new Error(
        `${where}: value "${k}" is ${v.length} chars, over the WorkOS limit of ${WORKOS_MAX_VALUE}`,
      );
    }
  }
}

/**
 * A BillingAdapter backed by a plain object, with the org-metadata store the
 * top-up and seat features require.
 *
 * `userMetadata` mirrors the shipped WorkOSOrgAdapter, which has a per-member
 * store. Pass `false` for the fallback path an adapter without one takes.
 */
export function fakeAdapter({
  orgId = "org_1",
  metadata = {},
  subscription = null,
  userMetadata = true,
  users = {},
} = {}) {
  const store = { ...metadata };
  const userStore = Object.fromEntries(Object.entries(users).map(([u, md]) => [u, { ...md }]));
  const calls = { setOrgMetadata: 0, setUserMetadata: 0 };
  const perUser = userMetadata
    ? {
        async getUserMetadata(userId) {
          return { ...(userStore[userId] ?? {}) };
        },
        async setUserMetadata(userId, patch) {
          calls.setUserMetadata++;
          const md = (userStore[userId] ??= {});
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") delete md[k];
            else md[k] = v;
          }
          assertWithinLimits(`user ${userId} metadata`, md);
        },
      }
    : {};
  return {
    orgId,
    userStore,
    ...perUser,
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
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") delete store[k];
        else store[k] = v;
      }
      assertWithinLimits("org metadata", store);
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
