import { DomainDataState, OrganizationDomainState } from "@workos-inc/node";
import { getWorkOS } from "../workos.js";
import { lookupCompany } from "../util/clearout.js";
export class WorkOSOrgAdapter {
    apiKey;
    clientId;
    map;
    ensureOrg;
    constructor(opts = {}) {
        this.apiKey = opts.apiKey;
        this.clientId = opts.clientId;
        this.map = opts.map;
        this.ensureOrg = opts.ensureOrg;
    }
    // The shared, lazily-memoized client (see workos.ts). With no explicit creds
    // this is the process-wide singleton; explicit creds get their own client.
    get workos() {
        return getWorkOS({ apiKey: this.apiKey, clientId: this.clientId });
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
        // Only VERIFIED domains count — a pending/failed domain must not unlock the
        // internal-org unmetered path (see auth.ts isInternalOrg).
        return org.domains
            .filter((d) => d.state === OrganizationDomainState.Verified)
            .map((d) => d.domain);
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
        const paginatable = await this.workos.apiKeys.listOrganizationApiKeys({
            organizationId: await this.wid(orgId),
        });
        const keys = await paginatable.autoPagination();
        return keys.map((k) => ({
            id: k.id,
            name: k.name,
            obfuscatedValue: k.obfuscatedValue,
        }));
    }
    async revokeApiKey(orgId, id) {
        // Full-list scope check (all pages) so a key on a later page isn't mistaken
        // for "not found"; the SDK delete needs only the id.
        const paginatable = await this.workos.apiKeys.listOrganizationApiKeys({
            organizationId: await this.wid(orgId),
        });
        const keys = await paginatable.autoPagination();
        const target = keys.find((k) => k.id === id);
        if (!target)
            return null;
        await this.workos.apiKeys.deleteApiKey(id);
        return { id: target.id, name: target.name };
    }
    // ── Subscription state + seats (org metadata; used by the billing-sync) ────
    /** Active-member count for the org (per-seat token grants + seat limits).
     *  Auto-paginates so orgs with >100 members aren't undercounted. */
    async memberCount(orgId) {
        const paginatable = await this.workos.userManagement.listOrganizationMemberships({
            organizationId: await this.wid(orgId),
            statuses: ["active"],
        });
        const members = await paginatable.autoPagination();
        return members.length;
    }
    async getSubscription(orgId) {
        const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
        const m = (org.metadata ?? {});
        return {
            plan: m.plan ?? null,
            status: m.subscriptionStatus ?? null,
            subscriptionId: m.stripeSubscriptionId ?? null,
            periodEnd: m.subscriptionPeriodEnd ?? null,
        };
    }
    /** Write subscription state onto the org metadata. `plan: undefined` leaves
     *  the plan as-is; `null` clears it (back to the default plan). */
    async setSubscription(orgId, sub) {
        const wid = await this.wid(orgId);
        const org = await this.workos.organizations.getOrganization(wid);
        const metadata = { ...(org.metadata ?? {}) };
        const set = (k, v) => {
            if (v === undefined)
                return;
            if (v === null || v === "")
                delete metadata[k];
            else
                metadata[k] = v;
        };
        set("subscriptionStatus", sub.status);
        set("stripeSubscriptionId", sub.subscriptionId);
        set("subscriptionPeriodEnd", sub.periodEnd);
        set("plan", sub.plan);
        await this.workos.organizations.updateOrganization({ organization: wid, metadata });
    }
}
//# sourceMappingURL=workos-org.js.map