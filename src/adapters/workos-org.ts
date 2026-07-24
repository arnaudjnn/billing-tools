import { WorkOS, DomainDataState } from "@workos-inc/node";
import type { BillingAdapter, BillingUser, ApiKeyInfo } from "../types.js";
import { lookupCompany } from "../util/clearout.js";

// Built-in adapter: WorkOS is the source of truth. Workspace = WorkOS
// Organization, API keys = WorkOS Organization API Keys, Stripe customer id =
// the native org.stripeCustomerId. Targets @workos-inc/node v10 (org api-key
// methods live on `apiKeys.*`; `apiKeys.createValidation` replaces v8's
// `validateApiKey`).
//
// Two patterns, one class:
//  - Pattern A (WorkOS-only): no `map`. The adapter's `orgId` IS the WorkOS org
//    id. Zero extra storage.
//  - Pattern B (WorkOS + DB mirror): pass `map`. The adapter's `orgId` is the
//    app's own id (e.g. a "ws_…" workspace); the map resolves it to a WorkOS
//    org for every call, so the DB row and WorkOS stay 1:1. Pass `ensureOrg` to
//    own org creation (create the mirror row + membership) since that step is
//    app-specific.

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
  ensureOrg?: (user: BillingUser) => Promise<{ orgId: string }>;
}

export class WorkOSOrgAdapter implements BillingAdapter {
  private _workos: WorkOS | null = null;
  private apiKey?: string;
  private clientId: string;
  private map?: WorkOSOrgMap;
  private ensureOrg?: (user: BillingUser) => Promise<{ orgId: string }>;

  constructor(opts: WorkOSOrgAdapterOptions = {}) {
    this.apiKey = opts.apiKey;
    this.clientId = opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "";
    this.map = opts.map;
    this.ensureOrg = opts.ensureOrg;
  }

  // Lazy: constructing WorkOS eagerly would throw when WORKOS_API_KEY is unset,
  // which must not break app boot (the adapter is created at module load). The
  // client is built on first actual use instead.
  private get workos(): WorkOS {
    return (this._workos ??= new WorkOS(this.apiKey ?? process.env.WORKOS_API_KEY, {
      clientId: this.clientId,
    }));
  }

  /** app orgId → WorkOS org id (identity when no map is configured). */
  private wid(orgId: string): Promise<string> {
    return this.map ? this.map.toWorkosOrgId(orgId) : Promise.resolve(orgId);
  }

  async validateApiKey(token: string): Promise<{ orgId: string } | null> {
    try {
      const { apiKey } = await this.workos.apiKeys.createValidation({ value: token });
      if (!apiKey) return null;
      const workosOrgId = apiKey.owner.id;
      const orgId = this.map ? await this.map.toOrgId(workosOrgId) : workosOrgId;
      return orgId ? { orgId } : null;
    } catch {
      return null;
    }
  }

  async getOrgDomains(orgId: string): Promise<string[]> {
    const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
    return org.domains.map((d) => d.domain);
  }

  async getBillingCustomerId(orgId: string): Promise<string | null> {
    const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
    // Native field first (v10); fall back to the legacy metadata pointer so
    // apps that stored it in metadata under v8 don't orphan their customer.
    return (
      org.stripeCustomerId ||
      (org.metadata as Record<string, string> | undefined)?.stripeCustomerId ||
      null
    );
  }

  async setBillingCustomerId(orgId: string, customerId: string): Promise<void> {
    await this.workos.organizations.updateOrganization({
      organization: await this.wid(orgId),
      stripeCustomerId: customerId,
    });
  }

  async ensureOrgForUser(user: BillingUser): Promise<{ orgId: string }> {
    if (this.ensureOrg) return this.ensureOrg(user);
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

  async mintApiKey(orgId: string, name: string, _createdBy?: string): Promise<{ id: string; value: string }> {
    const key = await this.workos.apiKeys.createOrganizationApiKey({
      organizationId: await this.wid(orgId),
      name,
    });
    return { id: key.id, value: key.value };
  }

  async listApiKeys(orgId: string): Promise<ApiKeyInfo[]> {
    const keys = await this.workos.apiKeys.listOrganizationApiKeys({
      organizationId: await this.wid(orgId),
    });
    return keys.data.map((k) => ({
      id: k.id,
      name: k.name,
      obfuscatedValue: k.obfuscatedValue,
    }));
  }

  async revokeApiKey(orgId: string, id: string): Promise<{ id: string; name: string } | null> {
    const keys = await this.workos.apiKeys.listOrganizationApiKeys({
      organizationId: await this.wid(orgId),
    });
    const target = keys.data.find((k) => k.id === id);
    if (!target) return null;
    await this.workos.apiKeys.deleteApiKey(id);
    return { id: target.id, name: target.name };
  }
}
