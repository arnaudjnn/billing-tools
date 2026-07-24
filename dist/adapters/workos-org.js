import { WorkOS, DomainDataState } from "@workos-inc/node";
import { lookupCompany } from "../util/clearout.js";
export class WorkOSOrgAdapter {
    workos;
    clientId;
    constructor(opts = {}) {
        this.clientId = opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "";
        this.workos = new WorkOS(opts.apiKey ?? process.env.WORKOS_API_KEY, {
            clientId: this.clientId,
        });
    }
    async validateApiKey(token) {
        try {
            const { apiKey } = await this.workos.apiKeys.validateApiKey({ value: token });
            if (!apiKey)
                return null;
            return { orgId: apiKey.owner.id };
        }
        catch {
            return null;
        }
    }
    async getOrgDomains(orgId) {
        const org = await this.workos.organizations.getOrganization(orgId);
        return org.domains.map((d) => d.domain);
    }
    async getBillingCustomerId(orgId) {
        const org = await this.workos.organizations.getOrganization(orgId);
        return org.metadata?.stripeCustomerId || null;
    }
    async setBillingCustomerId(orgId, customerId) {
        const org = await this.workos.organizations.getOrganization(orgId);
        await this.workos.organizations.updateOrganization({
            organization: orgId,
            metadata: { ...org.metadata, stripeCustomerId: customerId },
        });
    }
    async ensureOrgForUser(user) {
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
        const key = await this.workos.organizations.createOrganizationApiKey({
            organizationId: orgId,
            name,
        });
        return { id: key.id, value: key.value };
    }
    async listApiKeys(orgId) {
        const keys = await this.workos.organizations.listOrganizationApiKeys({ organizationId: orgId });
        return keys.data.map((k) => ({
            id: k.id,
            name: k.name,
            obfuscatedValue: k.obfuscatedValue,
        }));
    }
    async revokeApiKey(orgId, id) {
        const keys = await this.workos.organizations.listOrganizationApiKeys({ organizationId: orgId });
        const target = keys.data.find((k) => k.id === id);
        if (!target)
            return null;
        await this.workos.apiKeys.deleteApiKey(id);
        return { id: target.id, name: target.name };
    }
}
//# sourceMappingURL=workos-org.js.map