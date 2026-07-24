export type ClaimStatus = "pending" | "ready" | "error";
export type ClaimReadResult = {
    status: "not_found";
} | {
    status: "pending";
    email: string;
} | {
    status: "ready";
    email: string;
    apiKey: string;
    organizationId: string;
} | {
    status: "error";
    email: string;
    error: string;
};
/** Persistence for the claim ceremony. claim_token is hashed at rest by the
 *  default store (SHA-256) per the auth.md spec; a custom store should do the
 *  same and never persist the plaintext token. */
export interface ClaimStore {
    create(email: string): Promise<{
        claimToken: string;
        expiresIn: number;
    }>;
    get(claimToken: string): Promise<ClaimReadResult>;
    markReady(claimToken: string, data: {
        apiKey: string;
        organizationId: string;
    }): Promise<boolean>;
    markError(claimToken: string, error: string): Promise<boolean>;
    /** One-shot: return the entry and delete it once ready/error. */
    consume(claimToken: string): Promise<ClaimReadResult>;
}
/** Default single-process claim store. sha256(claim_token) is the map key;
 *  10-minute TTL; pruned every minute + lazily on read. */
export declare function inMemoryClaimStore(ttlMs?: number): ClaimStore;
//# sourceMappingURL=claim-store.d.ts.map