import type { BillingUser } from "./types.js";
import type { WorkOSOrgMap } from "./adapters/workos-org.js";
export interface InvitationEmailContext {
    /** WorkOS invitation id (use it in your accept link). */
    id: string;
    email: string;
    roleSlug: string;
    /** App orgId (post-map). */
    orgId: string;
    /** WorkOS organization id. */
    organizationId: string;
    /** `${baseUrl}${acceptPath}/${id}` — ready-made link for a custom email. */
    acceptUrl: string;
    inviterUserId?: string;
}
export interface InvitationHooks {
    /** Send a branded email. Omit → rely on WorkOS's default invitation email. */
    sendEmail?(ctx: InvitationEmailContext): Promise<void>;
    /** Decide whether `user` may accept an invite addressed to `invitedEmail`.
     *  Omit → case-insensitive match against the user's WorkOS primary email.
     *  Return false for a generic rejection, or throw for a custom message. */
    canAccept?(invitedEmail: string, user: BillingUser): Promise<boolean>;
}
export interface Invitation {
    id: string;
    email: string;
    roleSlug: string;
    /** App orgId (post-map), or "" if it can't be resolved. */
    orgId: string;
    organizationId: string;
    state: "pending" | "accepted" | "expired" | "revoked";
    createdAt: string;
    expiresAt: string;
}
export interface WorkOSInvitationsOptions {
    apiKey?: string;
    clientId?: string;
    /** ws↔org id map (share the adapter's). Omit → orgId IS the WorkOS org id. */
    map?: WorkOSOrgMap;
    /** Base URL for the custom-email accept link. */
    baseUrl?: string;
    /** Accept-link path prefix. Default "/invita". */
    acceptPath?: string;
    hooks?: InvitationHooks;
}
export interface InvitationService {
    send(orgId: string, email: string, roleSlug: string, inviterUserId?: string): Promise<Invitation>;
    list(orgId: string): Promise<Invitation[]>;
    get(invitationId: string): Promise<Invitation | null>;
    accept(invitationId: string, user: BillingUser): Promise<{
        orgId: string;
    }>;
    revoke(orgId: string, invitationId: string): Promise<void>;
}
export declare function createWorkOSInvitations(opts?: WorkOSInvitationsOptions): InvitationService;
//# sourceMappingURL=invitations.d.ts.map