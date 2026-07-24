import { WorkOS, DomainDataState } from "@workos-inc/node";
import { lookupCompany } from "../util/clearout.js";
export class WorkOSOrgAdapter {
    _workos = null;
    apiKey;
    clientId;
    map;
    ensureOrg;
    constructor(opts = {}) {
        this.apiKey = opts.apiKey;
        this.clientId = opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "";
        this.map = opts.map;
        this.ensureOrg = opts.ensureOrg;
    }
    // Lazy: constructing WorkOS eagerly would throw when WORKOS_API_KEY is unset,
    // which must not break app boot (the adapter is created at module load). The
    // client is built on first actual use instead.
    get workos() {
        return (this._workos ??= new WorkOS(this.apiKey ?? process.env.WORKOS_API_KEY, {
            clientId: this.clientId,
        }));
    }
    /** app orgId → WorkOS org id (identity when no map is configured). */
    wid(orgId) {
        return this.map ? this.map.toWorkosOrgId(orgId) : Promise.resolve(orgId);
    }
    async validateApiKey(token) {
        try {
            const { apiKey } = await this.workos.apiKeys.createValidation({ value: token });
            if (!apiKey)
                return null;
            const workosOrgId = apiKey.owner.id;
            const orgId = this.map ? await this.map.toOrgId(workosOrgId) : workosOrgId;
            return orgId ? { orgId } : null;
        }
        catch {
            return null;
        }
    }
    async getOrgDomains(orgId) {
        const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
        return org.domains.map((d) => d.domain);
    }
    async getBillingCustomerId(orgId) {
        const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
        // Native field first (v10); fall back to the legacy metadata pointer so
        // apps that stored it in metadata under v8 don't orphan their customer.
        return (org.stripeCustomerId ||
            org.metadata?.stripeCustomerId ||
            null);
    }
    async setBillingCustomerId(orgId, customerId) {
        await this.workos.organizations.updateOrganization({
            organization: await this.wid(orgId),
            stripeCustomerId: customerId,
        });
    }
    async ensureOrgForUser(user) {
        if (this.ensureOrg)
            return this.ensureOrg(user);
        const memberships = await this.workos.userManagement.listOrganizationMemberships({ userId: user.id });
        if (memberships.data.length > 0)
            return { orgId: memberships.data[0].organizationId };
        const domain = user.email.split("@")[1];
        const company = await lookupCompany(domain);
        const org = await this.workos.organizations.createOrganization({
            name: company?.name || domain,
            domainData: [{ domain, state: DomainDataState.Verified }],
            metadata: company?.logoUrl ? { logoUrl: company.logoUrl } : undefined,
        });
        await this.workos.userManagement.createOrganizationMembership({
            organizationId: org.id,
            userId: user.id,
        });
        return { orgId: org.id };
    }
    async mintApiKey(orgId, name, _createdBy) {
        const key = await this.workos.apiKeys.createOrganizationApiKey({
            organizationId: await this.wid(orgId),
            name,
        });
        return { id: key.id, value: key.value };
    }
    async listApiKeys(orgId) {
        const keys = await this.workos.apiKeys.listOrganizationApiKeys({
            organizationId: await this.wid(orgId),
        });
        return keys.data.map((k) => ({
            id: k.id,
            name: k.name,
            obfuscatedValue: k.obfuscatedValue,
        }));
    }
    async revokeApiKey(orgId, id) {
        const keys = await this.workos.apiKeys.listOrganizationApiKeys({
            organizationId: await this.wid(orgId),
        });
        const target = keys.data.find((k) => k.id === id);
        if (!target)
            return null;
        await this.workos.apiKeys.deleteApiKey(id);
        return { id: target.id, name: target.name };
    }
}
//# sourceMappingURL=workos-org.js.map