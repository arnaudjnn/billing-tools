import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { type ClaimStore } from "./claim-store.js";
export declare const CLAIM_GRANT_TYPE = "urn:workos:agent-auth:grant-type:claim";
export type AgentIdentityType = "anonymous" | "verified_email";
export interface AgentAuthBranding {
    /** Human-facing resource name (RFC 9728 resource_name, auth.md title). */
    productName: string;
    /** Absolute logo URL (RFC 9728 resource_logo_uri). Optional. */
    logoUri?: string;
}
export interface AgentAuthPaths {
    mcp?: string;
    rest?: string;
    authMd?: string;
    protectedResource?: string;
    authServer?: string;
    identity?: string;
    claim?: string;
    token?: string;
    revoke?: string;
}
export interface AgentAuthPolicy {
    accessTokenTtl?: number;
    interval?: number;
    userCodeLength?: number;
    scopes?: string[];
    /** Domain for the synthetic anonymous email (anonymous+<stub>@<domain>). */
    anonymousEmailDomain?: string;
    /** Extra grant types to advertise in AS metadata (e.g. an app's MCP OAuth
     *  proxy adds "authorization_code"/"refresh_token"). */
    extraGrantTypes?: string[];
}
export interface AgentAuthOptions {
    adapter: BillingAdapter;
    config: ResolvedConfig;
    branding: AgentAuthBranding;
    paths?: AgentAuthPaths;
    /** Which identity types are enabled + advertised. Default both. "anonymous"
     *  additionally requires adapter.createAnonymousOrg. */
    identityTypes?: AgentIdentityType[];
    /** Base URL for absolute links. String, per-request resolver, or omitted to
     *  derive from the request's forwarded host/proto headers. */
    baseUrl?: string | ((request: Request) => string);
    claimStore?: ClaimStore;
    policy?: AgentAuthPolicy;
}
export declare function createAgentAuth(opts: AgentAuthOptions): {
    protectedResource: (request: Request) => Response;
    authorizationServer: (request: Request) => Response;
    authMd: (request: Request) => Response;
    identity: (request: Request) => Promise<Response>;
    claim: (request: Request) => Promise<Response>;
    token: (request: Request) => Promise<Response>;
    handleClaimGrant: (params: Record<string, string>) => Promise<Response>;
    revoke: (request: Request) => Promise<Response>;
    /** `WWW-Authenticate` value advertising the PRM discovery doc on a 401. */
    wwwAuthenticate: (request: Request) => string;
};
//# sourceMappingURL=index.d.ts.map