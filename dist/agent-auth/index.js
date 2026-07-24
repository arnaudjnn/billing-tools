import { sendMagicAuth, verifyMagicAuth } from "../magic-auth.js";
import { ensureStripeCustomer } from "../billing.js";
import { inMemoryClaimStore } from "./claim-store.js";
// auth.md — the WorkOS agent-registration protocol (https://workos.com/auth-md),
// as reusable framework-agnostic handlers. An autonomous agent can self-register
// and obtain an API key with no human signup. Everything flows through the
// BillingAdapter + magic-auth (no direct WorkOS calls here), so any Stripe+WorkOS
// app mounts these by re-exporting them from its route files.
//
// Identity types (advertised + enabled via `identityTypes`):
//   - "anonymous": mint a fresh org + key immediately (needs adapter.createAnonymousOrg).
//   - "verified_email": email OTP ceremony → key bound to the user's workspace.
// ID-JAG is deferred (returns issuer_not_enabled) until agent providers ship it.
export const CLAIM_GRANT_TYPE = "urn:workos:agent-auth:grant-type:claim";
const YEAR = 365 * 24 * 60 * 60;
function jsonError(error, description, status = 400) {
    return Response.json({ error, error_description: description }, { status });
}
function baseUrlFromRequest(request) {
    const h = request.headers;
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
    if (host)
        return `${proto}://${host}`;
    return new URL(request.url).origin;
}
async function readBody(request) {
    const ct = request.headers.get("content-type") ?? "";
    try {
        if (ct.includes("application/x-www-form-urlencoded")) {
            const form = await request.formData();
            const out = {};
            form.forEach((v, k) => {
                out[k] = String(v);
            });
            return out;
        }
        return (await request.json());
    }
    catch {
        return null;
    }
}
export function createAgentAuth(opts) {
    const { adapter, config, branding } = opts;
    const store = opts.claimStore ?? inMemoryClaimStore();
    const types = new Set(opts.identityTypes ?? ["anonymous", "verified_email"]);
    const p = {
        mcp: "/mcp",
        rest: "/api/v0",
        authMd: "/auth.md",
        protectedResource: "/.well-known/oauth-protected-resource",
        authServer: "/.well-known/oauth-authorization-server",
        identity: "/agent/identity",
        claim: "/agent/identity/claim",
        token: "/oauth/token",
        revoke: "/oauth/revoke",
        ...opts.paths,
    };
    const policy = opts.policy ?? {};
    const ttl = policy.accessTokenTtl ?? YEAR;
    const scopes = policy.scopes ?? ["openid", "profile", "email"];
    const baseUrlOf = (request) => typeof opts.baseUrl === "function"
        ? opts.baseUrl(request)
        : (opts.baseUrl ?? baseUrlFromRequest(request));
    // ── Discovery ────────────────────────────────────────────────────────────
    function protectedResource(request) {
        const b = baseUrlOf(request);
        return Response.json({
            resource: `${b}${p.mcp}`,
            resource_name: branding.productName,
            ...(branding.logoUri ? { resource_logo_uri: branding.logoUri } : {}),
            authorization_servers: [b],
            scopes_supported: scopes,
            bearer_methods_supported: ["header"],
        }, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
    function authorizationServer(request) {
        const b = baseUrlOf(request);
        const assertionTypes = types.has("verified_email") ? ["verified_email"] : [];
        const identityTypesSupported = [
            ...(types.has("anonymous") ? ["anonymous"] : []),
            ...(types.has("verified_email") ? ["identity_assertion"] : []),
        ];
        return Response.json({
            issuer: b,
            authorization_endpoint: `${b}/oauth/authorize`,
            token_endpoint: `${b}${p.token}`,
            revocation_endpoint: `${b}${p.revoke}`,
            response_types_supported: ["code"],
            grant_types_supported: [...(policy.extraGrantTypes ?? []), CLAIM_GRANT_TYPE],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256", "plain"],
            scopes_supported: scopes,
            agent_auth: {
                skill: `${b}${p.authMd}`,
                identity_endpoint: `${b}${p.identity}`,
                claim_endpoint: `${b}${p.claim}`,
                identity_types_supported: identityTypesSupported,
                ...(assertionTypes.length
                    ? { identity_assertion: { assertion_types_supported: assertionTypes } }
                    : {}),
            },
        }, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
    function authMd(request) {
        return new Response(renderAuthMd(baseUrlOf(request), branding.productName, p, types, ttl), {
            headers: {
                "content-type": "text/markdown; charset=utf-8",
                "cache-control": "public, max-age=3600",
            },
        });
    }
    // ── Registration ──────────────────────────────────────────────────────────
    async function handleAnonymous() {
        if (!types.has("anonymous") || !adapter.createAnonymousOrg) {
            return jsonError("anonymous_not_enabled", "Anonymous registration is not enabled", 400);
        }
        const stub = `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const { orgId } = await adapter.createAnonymousOrg({
            name: `Anonymous agent (${stub})`,
            metadata: { authMd: "anonymous" },
        });
        const domain = policy.anonymousEmailDomain ?? "example.invalid";
        await ensureStripeCustomer(adapter, orgId, `anonymous+${stub}@${domain}`, config);
        const key = await adapter.mintApiKey(orgId, `auth.md anonymous (${today()})`);
        return Response.json({
            access_token: key.value,
            token_type: "bearer",
            expires_in: ttl,
            scope: "api",
            organization_id: orgId,
        });
    }
    async function handleVerifiedEmail(email) {
        try {
            await sendMagicAuth(email);
        }
        catch (e) {
            return jsonError("server_error", `Failed to send verification code: ${msg(e)}`, 500);
        }
        const { claimToken, expiresIn } = await store.create(email);
        return Response.json({
            claim_token: claimToken,
            expires_in: expiresIn,
            interval: policy.interval ?? 2,
            verification_uri: `${p.claim}`,
            user_code_length: policy.userCodeLength ?? 6,
        });
    }
    async function identity(request) {
        const body = await readBody(request);
        if (!body)
            return jsonError("invalid_request", "Body must be JSON");
        const type = body.type;
        if (type === "anonymous") {
            try {
                return await handleAnonymous();
            }
            catch (e) {
                return jsonError("server_error", msg(e), 500);
            }
        }
        if (type === "identity_assertion") {
            const at = body.assertion_type;
            const assertion = body.assertion;
            if (typeof at !== "string")
                return jsonError("invalid_request", "assertion_type is required");
            if (at === "urn:ietf:params:oauth:token-type:id-jag") {
                return jsonError("issuer_not_enabled", "ID-JAG assertions are not yet accepted");
            }
            if (at !== "verified_email" || !types.has("verified_email")) {
                return jsonError("invalid_request", `Unsupported assertion_type: ${at}`);
            }
            if (typeof assertion !== "string" || !assertion.includes("@")) {
                return jsonError("invalid_request", "assertion must be a valid email for verified_email");
            }
            return handleVerifiedEmail(assertion);
        }
        return jsonError("invalid_request", "type must be one of: anonymous, identity_assertion");
    }
    async function claim(request) {
        const body = await readBody(request);
        if (!body)
            return jsonError("invalid_request", "Body must be JSON");
        const claimToken = body.claim_token;
        const userCode = body.user_code;
        if (typeof claimToken !== "string" || typeof userCode !== "string") {
            return jsonError("invalid_request", "claim_token and user_code are required");
        }
        const entry = await store.get(claimToken);
        if (entry.status === "not_found")
            return jsonError("invalid_claim_token", "Unknown or expired claim_token");
        if (entry.status === "ready")
            return Response.json({ status: "ready" });
        if (entry.status === "error")
            return jsonError("invalid_grant", entry.error);
        try {
            const user = await verifyMagicAuth(entry.email, userCode);
            const { orgId } = await adapter.ensureOrgForUser(user);
            await ensureStripeCustomer(adapter, orgId, entry.email, config);
            const key = await adapter.mintApiKey(orgId, `auth.md (${today()})`);
            await store.markReady(claimToken, { apiKey: key.value, organizationId: orgId });
            return Response.json({ status: "ready" });
        }
        catch (e) {
            await store.markError(claimToken, msg(e));
            return jsonError("invalid_grant", msg(e));
        }
    }
    // ── Token (claim polling grant) ─────────────────────────────────────────────
    /** Handle the claim polling grant. Call from an app's existing /oauth/token
     *  route when grant_type === CLAIM_GRANT_TYPE, or use the `token` handler. */
    async function handleClaimGrant(params) {
        const claimToken = params.claim_token;
        if (!claimToken)
            return jsonError("invalid_request", "claim_token is required");
        const peek = await store.get(claimToken);
        if (peek.status === "not_found")
            return jsonError("invalid_grant", "Unknown or expired claim_token");
        if (peek.status === "pending") {
            return jsonError("authorization_pending", "Waiting for the user to confirm the code");
        }
        const consumed = await store.consume(claimToken);
        if (consumed.status === "ready") {
            return Response.json({
                access_token: consumed.apiKey,
                token_type: "bearer",
                expires_in: ttl,
                scope: "api",
                organization_id: consumed.organizationId,
            });
        }
        if (consumed.status === "error")
            return jsonError("invalid_grant", consumed.error);
        return jsonError("authorization_pending", "Retry");
    }
    async function token(request) {
        const params = await readBody(request);
        if (!params)
            return jsonError("invalid_request", "Invalid request body");
        if (params.grant_type !== CLAIM_GRANT_TYPE) {
            return jsonError("unsupported_grant_type", `Supported grant type: ${CLAIM_GRANT_TYPE}`);
        }
        return handleClaimGrant(params);
    }
    // ── Revocation (RFC 7009) ────────────────────────────────────────────────
    async function revoke(request) {
        const params = await readBody(request);
        const t = params?.token;
        // Per RFC 7009, always 200 (never leak token existence). Best-effort revoke.
        if (t && adapter.revokeApiKeyByToken) {
            try {
                await adapter.revokeApiKeyByToken(t);
            }
            catch {
                /* swallow — spec mandates 200 regardless */
            }
        }
        return new Response(null, { status: 200 });
    }
    return {
        protectedResource,
        authorizationServer,
        authMd,
        identity,
        claim,
        token,
        handleClaimGrant,
        revoke,
        /** `WWW-Authenticate` value advertising the PRM discovery doc on a 401. */
        wwwAuthenticate: (request) => `Bearer resource_metadata="${baseUrlOf(request)}${p.protectedResource}"`,
    };
}
function today() {
    // Callers pass a name only for display; avoid Date in a way that's fine here.
    return new Date().toISOString().slice(0, 10);
}
function msg(e) {
    return e instanceof Error ? e.message : String(e);
}
function renderAuthMd(baseUrl, product, p, types, ttl) {
    const rows = [];
    if (types.has("anonymous")) {
        rows.push(`| \`anonymous\` | — | You have no user context. You get a working API key immediately. |`);
    }
    if (types.has("verified_email")) {
        rows.push(`| \`identity_assertion\` | \`verified_email\` | You know the user's email. They confirm a 6-digit code; you get a key bound to their workspace. |`);
    }
    return `# ${product} — auth.md

This service implements the [auth.md](https://workos.com/auth-md) agent-registration protocol.
You (an autonomous agent) can register and obtain an API key without a human filling out a form.

## Step 1 — Discover

\`\`\`http
GET ${baseUrl}${p.authServer}
\`\`\`

The response includes an \`agent_auth\` block with the endpoints below.

## Step 2 — Pick a method

| \`type\` | \`assertion_type\` | When to use |
|---|---|---|
${rows.join("\n")}

## Step 3 — Register

\`\`\`http
POST ${baseUrl}${p.identity}
Content-Type: application/json
\`\`\`
${types.has("anonymous")
        ? `
**Anonymous:** \`{ "type": "anonymous" }\` → \`{ "access_token": "sk_…", "token_type": "bearer", "expires_in": ${ttl}, "scope": "api" }\`. Use the key directly in \`Authorization: Bearer …\` against \`${baseUrl}${p.mcp}\` or \`${baseUrl}${p.rest}/{tool_name}\`.
`
        : ""}${types.has("verified_email")
        ? `
**Verified email:** \`{ "type": "identity_assertion", "assertion_type": "verified_email", "assertion": "user@example.com" }\` → the service emails the user a 6-digit code and returns \`{ "claim_token": "clm_…", "interval": 2, "user_code_length": 6 }\`. Continue to Step 4.

## Step 4 — Claim ceremony

The user reads back the code; submit it:

\`\`\`http
POST ${baseUrl}${p.claim}
Content-Type: application/json

{ "claim_token": "clm_…", "user_code": "123456" }
\`\`\`

## Step 5 — Exchange the claim for an access token

\`\`\`http
POST ${baseUrl}${p.token}
Content-Type: application/x-www-form-urlencoded

grant_type=${CLAIM_GRANT_TYPE}&claim_token=clm_…
\`\`\`

Returns \`{ "error": "authorization_pending" }\` until the code is entered, then \`{ "access_token": "sk_…", "token_type": "bearer", "expires_in": ${ttl}, "scope": "api" }\`.
`
        : ""}
## Use the access token

All MCP (\`${baseUrl}${p.mcp}\`) and REST (\`${baseUrl}${p.rest}/{tool_name}\`) endpoints accept the same key. Free tools work immediately; paid tools require a token balance.

## Revocation

\`\`\`http
POST ${baseUrl}${p.revoke}
Content-Type: application/x-www-form-urlencoded

token=sk_…&token_type_hint=access_token
\`\`\`

Returns 200 (per RFC 7009; same response whether or not the token existed).
`;
}
//# sourceMappingURL=index.js.map