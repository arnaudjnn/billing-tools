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
/** Build the `internalDomains` allowlist from the environment: an optional
 *  deployment root domain (whatever your host exposes — pass it if you want the
 *  deployment's own domain treated as internal) plus a comma-separated env var
 *  (default `INTERNAL_ORG_DOMAINS`). Orgs with a verified WorkOS domain matching
 *  any entry get unmetered access (see enforceTokens → isInternalOrg). Result is
 *  lowercased + de-duplicated. Host-agnostic: the caller supplies the root
 *  domain (or nothing); the env var is generic. */
export function internalDomainsFromEnv(rootDomain, envVar = "INTERNAL_ORG_DOMAINS") {
    const extras = (process.env[envVar] ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    const root = rootDomain?.trim().toLowerCase();
    return Array.from(new Set([...(root ? [root] : []), ...extras]));
}
//# sourceMappingURL=types.js.map