import { WorkOS } from "@workos-inc/node";
const PAGE = 100;
const statusOf = (e) => typeof e === "object" && e !== null && "status" in e
    ? e.status
    : undefined;
export function createWorkOSInvitations(opts = {}) {
    const workos = new WorkOS(opts.apiKey ?? process.env.WORKOS_API_KEY, {
        clientId: opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "",
    });
    const hooks = opts.hooks ?? {};
    const baseUrl = opts.baseUrl ?? "";
    const acceptPath = opts.acceptPath ?? "/invita";
    const toWid = (orgId) => opts.map ? opts.map.toWorkosOrgId(orgId) : Promise.resolve(orgId);
    const toOrgId = (workosOrgId) => opts.map ? opts.map.toOrgId(workosOrgId) : Promise.resolve(workosOrgId);
    async function normalize(inv, orgId) {
        const resolved = orgId ?? (inv.organizationId ? await toOrgId(inv.organizationId) : null);
        return {
            id: inv.id,
            email: inv.email,
            roleSlug: inv.roleSlug ?? "member",
            orgId: resolved ?? "",
            organizationId: inv.organizationId ?? "",
            state: inv.state,
            createdAt: inv.createdAt,
            expiresAt: inv.expiresAt,
        };
    }
    async function get(invitationId) {
        let inv;
        try {
            inv = (await workos.userManagement.getInvitation(invitationId));
        }
        catch (e) {
            if (statusOf(e) === 404)
                return null;
            throw e;
        }
        if (inv.state !== "pending")
            return null;
        return normalize(inv);
    }
    async function send(orgId, email, roleSlug, inviterUserId) {
        const organizationId = await toWid(orgId);
        const inv = (await workos.userManagement.sendInvitation({
            email: email.trim().toLowerCase(),
            organizationId,
            roleSlug,
            inviterUserId,
        }));
        if (hooks.sendEmail) {
            await hooks.sendEmail({
                id: inv.id,
                email: inv.email,
                roleSlug: inv.roleSlug ?? roleSlug,
                orgId,
                organizationId,
                acceptUrl: `${baseUrl}${acceptPath}/${inv.id}`,
                inviterUserId,
            });
        }
        return normalize(inv, orgId);
    }
    async function list(orgId) {
        const organizationId = await toWid(orgId);
        const r = await workos.userManagement.listInvitations({ organizationId, limit: PAGE });
        const pending = r.data.filter((i) => i.state === "pending");
        return Promise.all(pending.map((i) => normalize(i, orgId)));
    }
    async function accept(invitationId, user) {
        const inv = await get(invitationId);
        if (!inv)
            throw new Error("Invitation is invalid or already used");
        const allowed = hooks.canAccept
            ? await hooks.canAccept(inv.email, user)
            : inv.email.toLowerCase() === user.email.toLowerCase();
        if (!allowed) {
            throw new Error(`This invitation is for ${inv.email}.`);
        }
        const organizationId = await toWid(inv.orgId);
        // Tolerate an already-present membership (never downgrade).
        try {
            await workos.userManagement.createOrganizationMembership({
                organizationId,
                userId: user.id,
                roleSlug: inv.roleSlug,
            });
        }
        catch (e) {
            if (statusOf(e) !== 409)
                throw e;
        }
        // Consume the pending invitation.
        try {
            await workos.userManagement.revokeInvitation(invitationId);
        }
        catch (e) {
            if (statusOf(e) !== 404)
                throw e;
        }
        return { orgId: inv.orgId };
    }
    async function revoke(orgId, invitationId) {
        const organizationId = await toWid(orgId);
        let inv;
        try {
            inv = (await workos.userManagement.getInvitation(invitationId));
        }
        catch (e) {
            if (statusOf(e) === 404)
                return;
            throw e;
        }
        // Belongs-to check: the invitation must target this org.
        if (inv.organizationId !== organizationId)
            return;
        await workos.userManagement.revokeInvitation(invitationId);
    }
    return { send, list, get, accept, revoke };
}
//# sourceMappingURL=invitations.js.map