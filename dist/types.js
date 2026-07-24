// The storage seam. `orgId` is an opaque string — a WorkOS org id, a Postgres
// workspace id ("ws_…"), whatever the host uses. Implement this and the rest of
// billing-tools (auth flow, metering, all Stripe math, tool/route/CLI surfaces)
// works unchanged.
export function resolveConfig(c) {
    return {
        freeTokens: c.freeTokens ?? 100,
        currency: c.currency ?? "usd",
        baseUrl: c.baseUrl,
        internalDomains: c.internalDomains ?? [],
    };
}
//# sourceMappingURL=types.js.map