import { DomainDataState, OrganizationDomainState, type WorkOS } from "@workos-inc/node";
import type { BillingAdapter, BillingUser, ApiKeyInfo, OrgMember } from "../types.js";
import { getWorkOS } from "../workos.js";
import { ADMIN_ROLE_SLUG } from "../workos-setup.js";

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
  /**
   * Optional company enrichment for an auto-created org's name and logo, from the
   * new user's email domain.
   *
   * **Off by default, and that default is the point.** This used to call
   * api.clearout.io unconditionally, which meant every deployment using this
   * adapter sent its customers' email domains to an unrelated third party — on the
   * critical path of creating a workspace, with no env var to notice it by, no way
   * to switch it off, and nothing in the docs saying it happened. A nicer org name
   * is not worth doing that silently on someone else's behalf.
   *
   * Opt in with the shipped helper, which is the same call made explicit:
   *
   *     new WorkOSOrgAdapter({ enrichOrg: lookupCompany })
   *
   * Or pass your own, resolving from records you already hold. Without it the org
   * is named after the domain — "acme.com" rather than "Acme".
   */
  enrichOrg?: (domain: string) => Promise<{ name?: string; logoUrl?: string } | null>;
}

// Two lookups this adapter repeats on nearly every call, both settled for the
// life of an org: the app-id → WorkOS-org-id mapping (a workspace's org never
// changes) and the Stripe customer pointer (an org gets one, once). Left
// uncached they are a WorkOS round trip — and, under Pattern B, a DB query too —
// on the critical path of every page that touches billing. Measured on a
// checkout page: ~670ms of the server render, spent re-reading a string.
//
// Per process, so a fresh instance simply repeats the read once. Only POSITIVE
// results are stored: "this org has no customer yet" is the one answer that
// changes, and caching it would hide the customer created a moment later.
// `setBillingCustomerId` writes through, and `forget` exists for the rest.
const CACHE_MAX = 2_000;

function remember(cache: Map<string, string>, key: string, value: string): string {
  // A plain FIFO cap. An LRU would be better and is not worth a dependency for
  // a map of id strings that is only unbounded in theory.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

export class WorkOSOrgAdapter implements BillingAdapter {
  private apiKey?: string;
  private clientId?: string;
  private map?: WorkOSOrgMap;
  private ensureOrg?: (user: BillingUser) => Promise<{ orgId: string }>;
  private enrichOrg?: (domain: string) => Promise<{ name?: string; logoUrl?: string } | null>;
  private widCache = new Map<string, string>();
  private customerCache = new Map<string, string>();

  constructor(opts: WorkOSOrgAdapterOptions = {}) {
    this.apiKey = opts.apiKey;
    this.clientId = opts.clientId;
    this.map = opts.map;
    this.ensureOrg = opts.ensureOrg;
    this.enrichOrg = opts.enrichOrg;
  }

  // The shared, lazily-memoized client (see workos.ts). With no explicit creds
  // this is the process-wide singleton; explicit creds get their own client.
  private get workos(): WorkOS {
    return getWorkOS({ apiKey: this.apiKey, clientId: this.clientId });
  }

  /** app orgId → WorkOS org id (identity when no map is configured). */
  private async wid(orgId: string): Promise<string> {
    if (!this.map) return orgId;
    const hit = this.widCache.get(orgId);
    if (hit) return hit;
    return remember(this.widCache, orgId, await this.map.toWorkosOrgId(orgId));
  }

  /** Drop what's cached for an org (its WorkOS org id and Stripe customer
   *  pointer) — or for every org when called with no argument. Needed only if
   *  an org is re-pointed at a different WorkOS org or Stripe customer, which
   *  the normal writes here already handle. */
  forget(orgId?: string): void {
    if (orgId === undefined) {
      this.widCache.clear();
      this.customerCache.clear();
      return;
    }
    this.widCache.delete(orgId);
    this.customerCache.delete(orgId);
  }

  async validateApiKey(token: string): Promise<{ orgId: string; keyId?: string } | null> {
    try {
      const { apiKey } = await this.workos.apiKeys.createValidation({ value: token });
      if (!apiKey) return null;
      const workosOrgId = apiKey.owner.id;
      const orgId = this.map ? await this.map.toOrgId(workosOrgId) : workosOrgId;
      // The validation already tells us WHICH key this was, and passing it on is
      // what makes per-key attribution possible at all — see `validateApiKey` on
      // the seam. It was being thrown away one line before the meter needed it.
      return orgId ? { orgId, keyId: apiKey.id } : null;
    } catch {
      return null;
    }
  }

  async getOrgDomains(orgId: string): Promise<string[]> {
    const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
    // Only VERIFIED domains count — a pending/failed domain must not unlock the
    // internal-org unmetered path (see auth.ts isInternalOrg).
    return org.domains
      .filter((d) => d.state === OrganizationDomainState.Verified)
      .map((d) => d.domain);
  }

  async getBillingCustomerId(orgId: string): Promise<string | null> {
    const hit = this.customerCache.get(orgId);
    if (hit) return hit;
    const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
    // Native field first (v10); fall back to the legacy metadata pointer so
    // apps that stored it in metadata under v8 don't orphan their customer.
    const customerId =
      org.stripeCustomerId ||
      (org.metadata as Record<string, string> | undefined)?.stripeCustomerId ||
      null;
    return customerId ? remember(this.customerCache, orgId, customerId) : null;
  }

  async setBillingCustomerId(orgId: string, customerId: string): Promise<void> {
    await this.workos.organizations.updateOrganization({
      organization: await this.wid(orgId),
      stripeCustomerId: customerId,
    });
    remember(this.customerCache, orgId, customerId);
  }

  async ensureOrgForUser(user: BillingUser): Promise<{ orgId: string }> {
    if (this.ensureOrg) return this.ensureOrg(user);
    const memberships = await this.workos.userManagement.listOrganizationMemberships({ userId: user.id });
    if (memberships.data.length > 0) return { orgId: memberships.data[0].organizationId };

    const domain = user.email.split("@")[1];
    // No enricher configured means no outbound call: the domain is the name.
    const company = this.enrichOrg ? await this.enrichOrg(domain) : null;
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
    const paginatable = await this.workos.apiKeys.listOrganizationApiKeys({
      organizationId: await this.wid(orgId),
    });
    const keys = await paginatable.autoPagination();
    // WorkOS returns createdAt/lastUsedAt/permissions on every key; pass them
    // through so a management UI can show "created"/"last used"/scope columns
    // without a second round trip.
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      obfuscatedValue: k.obfuscatedValue,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
      permissions: k.permissions ?? [],
    }));
  }

  /** Revoke by raw token value (RFC 7009): validate → key id → hard delete. */
  async revokeApiKeyByToken(token: string): Promise<boolean> {
    try {
      const { apiKey } = await this.workos.apiKeys.createValidation({ value: token });
      if (!apiKey) return false;
      await this.workos.apiKeys.deleteApiKey(apiKey.id);
      return true;
    } catch {
      return false;
    }
  }

  /** Create an org with no user (auth.md anonymous). No verified domain, so it
   *  never satisfies the internal-org unmetered check. Returns the WorkOS org id
   *  as `orgId` (Pattern A). With a `map` configured there's no mirror row, so
   *  prefer disabling anonymous for mirror apps (identityTypes without it). */
  async createAnonymousOrg(opts: { name: string; metadata?: Record<string, string> }): Promise<{ orgId: string }> {
    const org = await this.workos.organizations.createOrganization({
      name: opts.name,
      metadata: opts.metadata,
    });
    const orgId = this.map ? (await this.map.toOrgId(org.id)) ?? org.id : org.id;
    return { orgId };
  }

  async revokeApiKey(orgId: string, id: string): Promise<{ id: string; name: string } | null> {
    // Full-list scope check (all pages) so a key on a later page isn't mistaken
    // for "not found"; the SDK delete needs only the id.
    const paginatable = await this.workos.apiKeys.listOrganizationApiKeys({
      organizationId: await this.wid(orgId),
    });
    const keys = await paginatable.autoPagination();
    const target = keys.find((k) => k.id === id);
    if (!target) return null;
    await this.workos.apiKeys.deleteApiKey(id);
    return { id: target.id, name: target.name };
  }

  // ── Subscription state + seats (org metadata; used by the billing-sync) ────

  /** Active-member count for the org (per-seat credit grants + seat limits).
   *  Auto-paginates so orgs with >100 members aren't undercounted. */
  async memberCount(orgId: string): Promise<number> {
    return (await this.listMemberIds(orgId)).length;
  }

  /** Active member ids. What a read has to enumerate over once a per-member record
   *  lives on the member rather than in one org value — see `seats.ts`. */
  async listMemberIds(orgId: string): Promise<string[]> {
    const paginatable = await this.workos.userManagement.listOrganizationMemberships({
      organizationId: await this.wid(orgId),
      statuses: ["active"],
    });
    const members = await paginatable.autoPagination();
    return members.map((m) => m.userId);
  }

  /**
   * Members WITH their roles, in two paginated reads rather than N+1.
   *
   * `listOrganizationMemberships` carries the role and nothing else about the person;
   * `listUsers({ organizationId })` carries the email and the name and nothing about the
   * role. So both, joined on the user id — a `getUser` per member would be one HTTP request
   * per person on a screen that exists to show all of them.
   *
   * Every status, not just active: an invited-but-not-accepted membership is a seat already
   * promised, and a members list that hides them makes an owner wonder where the invitation
   * went. `status` is on each row so a caller can tell them apart.
   */
  async listMembers(orgId: string): Promise<OrgMember[]> {
    const wid = await this.wid(orgId);
    const [memberships, users] = await Promise.all([
      this.workos.userManagement
        .listOrganizationMemberships({ organizationId: wid })
        .then((p) => p.autoPagination()),
      this.workos.userManagement
        .listUsers({ organizationId: wid })
        .then((p) => p.autoPagination())
        .catch((): never[] => []), // a members list is still useful without the emails
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    return memberships.map((m) => {
      const u = byId.get(m.userId);
      const name = [u?.firstName, u?.lastName].filter(Boolean).join(" ");
      return {
        userId: m.userId,
        email: u?.email ?? null,
        name: name || null,
        roleSlug: m.role?.slug ?? null,
        status: m.status as OrgMember["status"],
        createdAt: m.createdAt,
      };
    });
  }

  /** Move a member between roles. The last-admin rule is NOT here — it is in `members.ts`,
   *  so a consumer's own screen and a tool refuse identically. */
  async setMemberRole(orgId: string, userId: string, roleSlug: string): Promise<void> {
    const id = await this.membershipId(orgId, userId);
    if (!id) throw new Error(`${userId} is not a member of ${orgId}`);
    await this.workos.userManagement.updateOrganizationMembership(id, { roleSlug });
  }

  /** Drop a membership. The USER survives — they may belong to other workspaces, and
   *  deleting a person because they left one team is not this call's business. */
  async removeMember(orgId: string, userId: string): Promise<void> {
    const id = await this.membershipId(orgId, userId);
    // Already gone is the outcome the caller asked for.
    if (id) await this.workos.userManagement.deleteOrganizationMembership(id);
  }

  /** The membership row id, which is what WorkOS's role/delete calls take. */
  private async membershipId(orgId: string, userId: string): Promise<string | null> {
    const r = await this.workos.userManagement.listOrganizationMemberships({
      organizationId: await this.wid(orgId),
      userId,
      limit: 1,
    });
    return r.data[0]?.id ?? null;
  }

  async getSubscription(orgId: string): Promise<{
    plan: string | null;
    status: string | null;
    subscriptionId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    seats: number | null;
    seatCounts: Record<string, number> | null;
  }> {
    const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
    const m = (org.metadata ?? {}) as Record<string, string>;
    // ONE key holds the per-type breakdown and the total is its sum, rather than a
    // key for each: the org map allows ten in total and the library already writes
    // nine, so a second seat key would leave a consuming app none.
    const seatCounts = parseSeatCounts(m.subscriptionSeatCounts);
    const summed = seatCounts
      ? Object.values(seatCounts).reduce((a, b) => a + b, 0)
      : // Back-compat: 2.11.0 wrote a bare total under its own key.
        Number.parseInt(m.subscriptionSeats ?? "", 10);
    return {
      plan: m.plan ?? null,
      status: m.subscriptionStatus ?? null,
      subscriptionId: m.stripeSubscriptionId ?? null,
      // An included allowance is measured over the subscription window, so the
      // START matters as much as the renewal date.
      periodStart: m.subscriptionPeriodStart ?? null,
      periodEnd: m.subscriptionPeriodEnd ?? null,
      // Junk reads as null, which falls back to the active member count rather
      // than to a pool of one seat.
      seats: Number.isFinite(summed) && summed > 0 ? summed : null,
      seatCounts,
    };
  }

  /** Write subscription state onto the org metadata. `plan: undefined` leaves
   *  the plan as-is; `null` clears it (back to the default plan). */
  async setSubscription(
    orgId: string,
    sub: {
      plan?: string | null;
      status: string | null;
      subscriptionId: string | null;
      periodStart?: string | null;
      periodEnd: string | null;
      seats?: number | null;
      seatCounts?: Record<string, number> | null;
    },
  ): Promise<void> {
    const wid = await this.wid(orgId);
    const org = await this.workos.organizations.getOrganization(wid);
    const metadata: Record<string, string> = { ...(org.metadata as Record<string, string> ?? {}) };
    const set = (k: string, v: string | null | undefined) => {
      if (v === undefined) return;
      if (v === null || v === "") delete metadata[k];
      else metadata[k] = v;
    };
    set("subscriptionStatus", sub.status);
    set("stripeSubscriptionId", sub.subscriptionId);
    set("subscriptionPeriodStart", sub.periodStart);
    set("subscriptionPeriodEnd", sub.periodEnd);
    set("plan", sub.plan);
    // The breakdown, from which the total is derived on read — see getSubscription.
    // A caller that only knows the total gets a single synthetic entry, so the one
    // key is always the source of truth and the two can never disagree.
    const counts =
      sub.seatCounts ?? (sub.seats != null ? { total: sub.seats } : sub.seatCounts);
    set("subscriptionSeatCounts", counts == null ? counts : JSON.stringify(counts));
    // Retired in favour of the key above; cleared so it cannot be read as a stale
    // total after seats change, and so the key budget goes back to nine.
    set("subscriptionSeats", null);
    await this.workos.organizations.updateOrganization({ organization: wid, metadata });
  }

  // ── Metering support (org metadata as the store; no separate DB) ───────────

  async getOrgMetadata(orgId: string): Promise<Record<string, string>> {
    const org = await this.workos.organizations.getOrganization(await this.wid(orgId));
    return (org.metadata as Record<string, string>) ?? {};
  }

  /** Merge a patch into the org metadata (null/"" deletes the key). */
  async setOrgMetadata(orgId: string, patch: Record<string, string | null>): Promise<void> {
    const wid = await this.wid(orgId);
    const org = await this.workos.organizations.getOrganization(wid);
    const metadata: Record<string, string> = { ...((org.metadata as Record<string, string>) ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") delete metadata[k];
      else metadata[k] = v;
    }
    await this.workos.organizations.updateOrganization({ organization: wid, metadata });
  }

  /**
   * A member's own metadata — the same 10-key/600-char budget, but per user.
   *
   * This is where a per-MEMBER record belongs. Packed into an org value instead,
   * a per-member map hits a ceiling of about twelve members (measured), and the
   * overflow fails the whole org metadata write rather than just that record.
   * See the note at the top of `topup.ts`.
   */
  async getUserMetadata(userId: string): Promise<Record<string, string>> {
    const user = await this.workos.userManagement.getUser(userId);
    return (user.metadata as Record<string, string>) ?? {};
  }

  /** Merge a patch into a member's metadata (null/"" deletes the key). Read-then-
   *  write for the same reason `setOrgMetadata` does it: the update replaces. */
  async setUserMetadata(userId: string, patch: Record<string, string | null>): Promise<void> {
    const user = await this.workos.userManagement.getUser(userId);
    const metadata: Record<string, string> = { ...((user.metadata as Record<string, string>) ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") delete metadata[k];
      else metadata[k] = v;
    }
    await this.workos.userManagement.updateUser({ userId, metadata });
  }

  /**
   * Admin/owner check via the user's role in the org.
   *
   * The slug comes from `ADMIN_ROLE_SLUG` rather than being spelled here, because
   * `ensureWorkOSRoles` provisions that role and the doctor checks it — three copies
   * of the string is how a check comes to disagree with what it checks. If the role
   * does not exist in the environment, no membership can carry it, so this returns
   * false and `enforceAdmin` 403s every human.
   */
  /**
   * Delete the WorkOS organization.
   *
   * Only ever call this through `closeWorkspace`, which stops the billing FIRST: the org holds
   * `stripeCustomerId`, so deleting it destroys the only mapping from a live subscription back
   * to anything, and the charge keeps recurring with nothing to attribute it to.
   */
  async deleteOrg(orgId: string): Promise<void> {
    await this.workos.organizations.deleteOrganization(orgId);
  }

  async getOrgName(orgId: string): Promise<string | null> {
    return (await this.workos.organizations.getOrganization(await this.wid(orgId))).name ?? null;
  }

  /**
   * Rename the organization.
   *
   * WorkOS's update REPLACES the object, so the name has to be sent with whatever else must
   * survive — the same trap `setSubscription` documents for metadata. Only `name` is passed
   * here, which is exactly why a Pattern B app renames through its mirror (`renameOrg` there
   * keeps the local row and the org in step) rather than calling this directly.
   */
  async renameOrg(orgId: string, name: string): Promise<void> {
    await this.workos.organizations.updateOrganization({
      organization: await this.wid(orgId),
      name,
    });
  }

  async isAdmin(orgId: string, userId: string): Promise<boolean> {
    const r = await this.workos.userManagement.listOrganizationMemberships({
      organizationId: await this.wid(orgId),
      userId,
      statuses: ["active"],
    });
    return r.data.some((m) => m.role?.slug === ADMIN_ROLE_SLUG);
  }
}

/** Seat counts off a metadata value. Junk reads as null (→ member-count fallback)
 *  rather than as an empty map, which would size a pool at zero. */
function parseSeatCounts(raw: string | undefined): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
