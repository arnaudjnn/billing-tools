import { WorkOS, DomainDataState } from "@workos-inc/node";
import type { BillingAdapter, BillingUser, ApiKeyInfo } from "../types.js";
import { lookupCompany } from "../util/clearout.js";

// Built-in adapter: stores everything in WorkOS. Workspace = WorkOS
// Organization, API keys = WorkOS Organization API Keys, and the Stripe
// customer-id pointer lives in org metadata. Zero extra storage — ideal for a
// WorkOS-only app with no database.

export interface WorkOSOrgAdapterOptions {
  apiKey?: string;
  clientId?: string;
  /** Key name for new keys. Default "API Key". */
  keyName?: string;
}

export class WorkOSOrgAdapter implements BillingAdapter {
  private workos: WorkOS;
  private clientId: string;

  constructor(opts: WorkOSOrgAdapterOptions = {}) {
    this.clientId = opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "";
    this.workos = new WorkOS(opts.apiKey ?? process.env.WORKOS_API_KEY, {
      clientId: this.clientId,
    });
  }

  async validateApiKey(token: string): Promise<{ orgId: string } | null> {
    try {
      const { apiKey } = await this.workos.apiKeys.validateApiKey({ value: token });
      if (!apiKey) return null;
      return { orgId: apiKey.owner.id };
    } catch {
      return null;
    }
  }

  async getOrgDomains(orgId: string): Promise<string[]> {
    const org = await this.workos.organizations.getOrganization(orgId);
    return org.domains.map((d) => d.domain);
  }

  async getBillingCustomerId(orgId: string): Promise<string | null> {
    const org = await this.workos.organizations.getOrganization(orgId);
    return (org.metadata as Record<string, string> | undefined)?.stripeCustomerId || null;
  }

  async setBillingCustomerId(orgId: string, customerId: string): Promise<void> {
    const org = await this.workos.organizations.getOrganization(orgId);
    await this.workos.organizations.updateOrganization({
      organization: orgId,
      metadata: { ...(org.metadata as Record<string, string> | undefined), stripeCustomerId: customerId },
    });
  }

  async ensureOrgForUser(user: BillingUser): Promise<{ orgId: string }> {
    const memberships = await this.workos.userManagement.listOrganizationMemberships({ userId: user.id });
    if (memberships.data.length > 0) return { orgId: memberships.data[0].organizationId };

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

  async mintApiKey(orgId: string, name: string): Promise<{ id: string; value: string }> {
    const key = await this.workos.organizations.createOrganizationApiKey({
      organizationId: orgId,
      name,
    });
    return { id: key.id, value: key.value };
  }

  async listApiKeys(orgId: string): Promise<ApiKeyInfo[]> {
    const keys = await this.workos.organizations.listOrganizationApiKeys({ organizationId: orgId });
    return keys.data.map((k: { id: string; name: string; obfuscatedValue: string }) => ({
      id: k.id,
      name: k.name,
      obfuscatedValue: k.obfuscatedValue,
    }));
  }

  async revokeApiKey(orgId: string, id: string): Promise<{ id: string; name: string } | null> {
    const keys = await this.workos.organizations.listOrganizationApiKeys({ organizationId: orgId });
    const target = keys.data.find((k: { id: string }) => k.id === id);
    if (!target) return null;
    await this.workos.apiKeys.deleteApiKey(id);
    return { id: target.id, name: target.name };
  }
}
