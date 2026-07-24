import type { BillingAdapter, BillingUser, ApiKeyInfo } from "../types.js";
export interface WorkOSOrgAdapterOptions {
    apiKey?: string;
    clientId?: string;
    /** Key name for new keys. Default "API Key". */
    keyName?: string;
}
export declare class WorkOSOrgAdapter implements BillingAdapter {
    private workos;
    private clientId;
    constructor(opts?: WorkOSOrgAdapterOptions);
    validateApiKey(token: string): Promise<{
        orgId: string;
    } | null>;
    getOrgDomains(orgId: string): Promise<string[]>;
    getBillingCustomerId(orgId: string): Promise<string | null>;
    setBillingCustomerId(orgId: string, customerId: string): Promise<void>;
    ensureOrgForUser(user: BillingUser): Promise<{
        orgId: string;
    }>;
    mintApiKey(orgId: string, name: string): Promise<{
        id: string;
        value: string;
    }>;
    listApiKeys(orgId: string): Promise<ApiKeyInfo[]>;
    revokeApiKey(orgId: string, id: string): Promise<{
        id: string;
        name: string;
    } | null>;
}
//# sourceMappingURL=workos-org.d.ts.map