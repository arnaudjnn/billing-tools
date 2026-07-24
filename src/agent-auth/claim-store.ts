import { createHash, randomBytes } from "node:crypto";

// State for the auth.md verified-email claim ceremony, behind a pluggable
// interface so multi-instance deployments can swap the default in-memory store
// for Redis/DB. The default suits a single long-lived process (the common case).
//
// Lifecycle:
//   1. POST /agent/identity {type:'identity_assertion', assertion_type:'verified_email', assertion:'<email>'}
//      → sendMagicAuth + create a `pending` entry, return claim_token to the agent.
//   2. POST /agent/identity/claim {claim_token, user_code}
//      → verifyMagicAuth, mint an API key, transition the entry to `ready`.
//   3. POST /oauth/token grant_type=urn:workos:agent-auth:grant-type:claim
//      → `authorization_pending` while `pending`, then a one-shot `ready` delivery.

export type ClaimStatus = "pending" | "ready" | "error";

export type ClaimReadResult =
  | { status: "not_found" }
  | { status: "pending"; email: string }
  | { status: "ready"; email: string; apiKey: string; organizationId: string }
  | { status: "error"; email: string; error: string };

/** Persistence for the claim ceremony. claim_token is hashed at rest by the
 *  default store (SHA-256) per the auth.md spec; a custom store should do the
 *  same and never persist the plaintext token. */
export interface ClaimStore {
  create(email: string): Promise<{ claimToken: string; expiresIn: number }>;
  get(claimToken: string): Promise<ClaimReadResult>;
  markReady(claimToken: string, data: { apiKey: string; organizationId: string }): Promise<boolean>;
  markError(claimToken: string, error: string): Promise<boolean>;
  /** One-shot: return the entry and delete it once ready/error. */
  consume(claimToken: string): Promise<ClaimReadResult>;
}

interface ClaimEntry {
  email: string;
  status: ClaimStatus;
  apiKey?: string;
  organizationId?: string;
  error?: string;
  expiresAt: number;
}

/** Default single-process claim store. sha256(claim_token) is the map key;
 *  10-minute TTL; pruned every minute + lazily on read. */
export function inMemoryClaimStore(ttlMs = 10 * 60 * 1000): ClaimStore {
  const claims = new Map<string, ClaimEntry>();
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  const prune = () => {
    const now = Date.now();
    for (const [k, v] of claims) if (now > v.expiresAt) claims.delete(k);
  };
  const g = globalThis as Record<string, unknown>;
  if (typeof globalThis !== "undefined" && !g.__billing_claim_cleanup) {
    g.__billing_claim_cleanup = setInterval(prune, 60 * 1000);
    (g.__billing_claim_cleanup as { unref?: () => void }).unref?.();
  }

  const read = (claimToken: string): ClaimReadResult => {
    prune();
    const e = claims.get(hash(claimToken));
    if (!e) return { status: "not_found" };
    if (e.status === "pending") return { status: "pending", email: e.email };
    if (e.status === "error") return { status: "error", email: e.email, error: e.error ?? "unknown" };
    return { status: "ready", email: e.email, apiKey: e.apiKey!, organizationId: e.organizationId! };
  };

  return {
    async create(email) {
      prune();
      const claimToken = `clm_${randomBytes(32).toString("base64url")}`;
      claims.set(hash(claimToken), { email, status: "pending", expiresAt: Date.now() + ttlMs });
      return { claimToken, expiresIn: Math.floor(ttlMs / 1000) };
    },
    async get(claimToken) {
      return read(claimToken);
    },
    async markReady(claimToken, data) {
      const e = claims.get(hash(claimToken));
      if (!e) return false;
      e.status = "ready";
      e.apiKey = data.apiKey;
      e.organizationId = data.organizationId;
      return true;
    },
    async markError(claimToken, error) {
      const e = claims.get(hash(claimToken));
      if (!e) return false;
      e.status = "error";
      e.error = error;
      return true;
    },
    async consume(claimToken) {
      const result = read(claimToken);
      if (result.status === "ready" || result.status === "error") claims.delete(hash(claimToken));
      return result;
    },
  };
}
