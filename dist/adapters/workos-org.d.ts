import type { BillingAdapter, BillingUser, ApiKeyInfo } from "../types.js";
/** Bidirectional id map between the app's `orgId` and the WorkOS org id. */
export interface WorkOSOrgMap {
    /** app orgId → WorkOS org id (create/reconcile-on-read as needed). */
    toWorkosOrgId(orgId: string): Promise<string>;
    /** WorkOS org id → app orgId, or null if it maps to nothing. */
    toOrgId(workosOrgId: string): Promise<string | null>;
}
export interface WorkOSOrgAdapterOptions {
    apiKey?: string;
    clientId?: string;
    /** Key name for new keys. Default "API Key". */
    keyName?: string;
    /** DB-mirror id map. Omit for a WorkOS-only app (identity mapping). */
    map?: WorkOSOrgMap;
    /** Override org creation (e.g. also insert the mirror workspace row +
     *  membership). Omit to use the default (company-domain org + verified
     *  domain + membership). */
    ensureOrg?: (user: BillingUser) => Promise<{
        orgId: string;
    }>;
}
export declare class WorkOSOrgAdapter implements BillingAdapter {
    private apiKey?;
    private clientId?;
    private map?;
    private ensureOrg?;
    constructor(opts?: WorkOSOrgAdapterOptions);
    private get workos();
    /** app orgId → WorkOS org id (identity when no map is configured). */
    private wid;
    validateApiKey(token: string): Promise<{
        orgId: string;
    } | null>;
    getOrgDomains(orgId: string): Promise<string[]>;
    getBillingCustomerId(orgId: string): Promise<string | null>;
    setBillingCustomerId(orgId: string, customerId: string): Promise<void>;
    ensureOrgForUser(user: BillingUser): Promise<{
        orgId: string;
    }>;
    mintApiKey(orgId: string, name: string, _createdBy?: string): Promise<{
        id: string;
        value: string;
    }>;
    listApiKeys(orgId: string): Promise<ApiKeyInfo[]>;
    revokeApiKey(orgId: string, id: string): Promise<{
        id: string;
        name: string;
    } | null>;
    /** Active-member count for the org (per-seat token grants + seat limits).
     *  Auto-paginates so orgs with >100 members aren't undercounted. */
    memberCount(orgId: string): Promise<number>;
    getSubscription(orgId: string): Promise<{
        plan: string | null;
        status: string | null;
        subscriptionId: string | null;
        periodEnd: string | null;
    }>;
    /** Write subscription state onto the org metadata. `plan: undefined` leaves
     *  the plan as-is; `null` clears it (back to the default plan). */
    setSubscription(orgId: string, sub: {
        plan?: string | null;
        status: string | null;
        subscriptionId: string | null;
        periodEnd: string | null;
    }): Promise<void>;
}
//# sourceMappingURL=workos-org.d.ts.map