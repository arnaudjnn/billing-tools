import { createHash, randomBytes } from "node:crypto";
/** Default single-process claim store. sha256(claim_token) is the map key;
 *  10-minute TTL; pruned every minute + lazily on read. */
export function inMemoryClaimStore(ttlMs = 10 * 60 * 1000) {
    const claims = new Map();
    const hash = (t) => createHash("sha256").update(t).digest("hex");
    const prune = () => {
        const now = Date.now();
        for (const [k, v] of claims)
            if (now > v.expiresAt)
                claims.delete(k);
    };
    const g = globalThis;
    if (typeof globalThis !== "undefined" && !g.__billing_claim_cleanup) {
        g.__billing_claim_cleanup = setInterval(prune, 60 * 1000);
        g.__billing_claim_cleanup.unref?.();
    }
    const read = (claimToken) => {
        prune();
        const e = claims.get(hash(claimToken));
        if (!e)
            return { status: "not_found" };
        if (e.status === "pending")
            return { status: "pending", email: e.email };
        if (e.status === "error")
            return { status: "error", email: e.email, error: e.error ?? "unknown" };
        return { status: "ready", email: e.email, apiKey: e.apiKey, organizationId: e.organizationId };
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
            if (!e)
                return false;
            e.status = "ready";
            e.apiKey = data.apiKey;
            e.organizationId = data.organizationId;
            return true;
        },
        async markError(claimToken, error) {
            const e = claims.get(hash(claimToken));
            if (!e)
                return false;
            e.status = "error";
            e.error = error;
            return true;
        },
        async consume(claimToken) {
            const result = read(claimToken);
            if (result.status === "ready" || result.status === "error")
                claims.delete(hash(claimToken));
            return result;
        },
    };
}
//# sourceMappingURL=claim-store.js.map