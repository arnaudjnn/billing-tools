// WHO is in the workspace, against real WorkOS.
//
// The offline suite proves the two rules exhaustively against a fake, and it cannot prove the
// only things that break here: that a real membership listing carries a real role slug, that
// `listUsers({ organizationId })` actually returns the emails the tools report, that a real
// invitation is created and revoked, and that a role change takes effect on the very next call
// — nothing caches `isAdmin`, and if anything did, a demoted admin would keep their powers.
//
// It also proves the refusal that matters most, and the fake cannot: with ONE admin in a real
// org, demoting them is refused. Allow it and `isAdmin` answers false for everybody, every
// admin-gated tool returns 403 to every human, and the only way back in is an org API key.
//
// A whole throwaway workspace, because this section REMOVES people and the run's own org is
// every later section's fixture.

import { note, ok, section, skip } from "../lib/harness.mjs";
import { RUN } from "../lib/scratch-stripe.mjs";
import { createScratchOrg } from "../lib/scratch-workos.mjs";
import { makeCallers } from "../lib/callers.mjs";

const FORBIDDEN = /Forbidden \(403\)/;

export async function run(ctx) {
  const { api, dispatcher, workos } = ctx;

  const team = await createScratchOrg({ name: `E2E Members ${RUN}`, suffix: "-m" });
  const { orgId, adminUserId, memberUserId } = team;
  // Its OWN key: `makeCallers` builds an Authorization header, and a key belongs to one org —
  // the run's key would resolve every call here to the run's workspace, and every assertion
  // below would be about the wrong people.
  const key = await ctx.adapter.mintApiKey(orgId, `e2e-members ${RUN}`, adminUserId);
  const callers = makeCallers({ ...ctx, apiKey: key.value, adminUserId, memberUserId, dispatcher });

  // ── reading ───────────────────────────────────────────────────────────────
  section("12a — the members list, from a real org");
  const list = (await callers.asAdmin("list_members", {})).value;
  const rows = list?.members ?? [];
  ok("both memberships are listed", rows.length === 2, `${rows.length} member(s)`);
  ok(
    "each row carries a real role slug",
    rows.every((m) => m.role === "admin" || m.role === "member"),
    rows.map((m) => `${m.member_id.slice(0, 12)}:${m.role}`).join(" "),
  );
  // The emails come from a SECOND paginated call (`listUsers({ organizationId })`) joined on
  // the user id, rather than a `getUser` per person. If that join is wrong the tool answers
  // with nulls and nothing else fails.
  ok(
    "and the email the join produced",
    rows.every((m) => typeof m.email === "string" && m.email.includes("@")),
    rows.map((m) => m.email).join(" "),
  );
  ok(
    "the admin is the one WorkOS says it is",
    rows.find((m) => m.role === "admin")?.member_id === adminUserId,
  );

  section("12b — a member may read the team; only an admin may change it");
  const asMember = (await callers.asMember("list_members", {})).value;
  ok("a member reads it too", (asMember?.members ?? []).length === 2);
  for (const [tool, args] of [
    ["change_member_role", { member_id: adminUserId, role: "member" }],
    ["remove_member", { member_id: adminUserId }],
  ]) {
    const res = await callers.asMember(tool, args);
    ok(`${tool} refuses a member`, FORBIDDEN.test(res.error ?? ""), res.error?.slice(0, 60));
  }

  // ── the last admin ────────────────────────────────────────────────────────
  section("12c — the last admin, refused against a real membership listing");
  const demote = await callers.asAdmin("change_member_role", { member_id: adminUserId, role: "member" });
  ok(
    "demoting the only admin is refused",
    /only admin left/.test(demote.error ?? ""),
    demote.error?.slice(0, 80),
  );
  const removeAdmin = await callers.asAdmin("remove_member", { member_id: adminUserId });
  ok("and so is removing them", /only admin left/.test(removeAdmin.error ?? ""));

  // The role really did not move — a refusal that had already written would be worse than none.
  const stillAdmin = await api.members.isLastAdmin(orgId, adminUserId);
  ok("the role is untouched", stillAdmin === true);

  section("12d — promote, and the refusal lifts on the NEXT call");
  const promote = await callers.asAdmin("change_member_role", { member_id: memberUserId, role: "admin" });
  ok("the member is promoted", promote.value?.status === "role_changed", promote.error?.slice(0, 60));
  // Nothing caches `isAdmin`: it reads WorkOS every time, so a promotion works immediately and
  // — the half that matters — a demotion bites immediately.
  ok("WorkOS agrees", await ctx.adapter.isAdmin(orgId, memberUserId));
  const demoteNow = await callers.asAdmin("change_member_role", { member_id: adminUserId, role: "member" });
  ok("now the original admin CAN be demoted", demoteNow.value?.status === "role_changed", demoteNow.error?.slice(0, 60));
  // Put the original admin back — the rest of this section needs an admin caller, and the one
  // holding the API key is that person. Through WorkOS directly rather than through the tool:
  // the caller doing the asking has just been demoted, so the tool would refuse it. `orgId` IS
  // the WorkOS org id here (this harness uses the adapter with no map).
  const membership = await workos.userManagement.listOrganizationMemberships({
    organizationId: orgId,
    userId: adminUserId,
    limit: 1,
  });
  if (membership.data[0]) {
    await workos.userManagement.updateOrganizationMembership(membership.data[0].id, {
      roleSlug: "admin",
    });
  }
  ok("the admin is restored for the rest of the section", await ctx.adapter.isAdmin(orgId, adminUserId));

  // ── invitations ───────────────────────────────────────────────────────────
  if (!dispatcher.getToolNames().includes("invite_member")) {
    skip("12e — invitations", "no invitation service wired into this harness");
  } else {
    section("12e — a real invitation, and the seat it holds");
    const email = `${RUN}-invited@example.test`;
    const invited = await callers.asAdmin("invite_member", { email, role: "member" });
    ok("the invitation is created", Boolean(invited.value?.invitation_id), invited.error?.slice(0, 80));

    const pending = (await callers.asAdmin("list_invitations", {})).value?.invitations ?? [];
    ok(
      "it reads back as pending, with the address it was sent to",
      pending.some((i) => i.email === email && i.state === "pending"),
      pending.map((i) => `${i.email}:${i.state}`).join(" "),
    );

    // The seat it is HOLDING is the point of counting pending invitations: three members on a
    // three-seat plan is full whether the third has accepted or not.
    const seats = (await callers.asAdmin("list_members", {})).value?.seats;
    ok("and it counts against the seats", seats?.pending_invitations === 1, JSON.stringify(seats));

    const revoked = await callers.asAdmin("revoke_invitation", {
      invitation_id: invited.value.invitation_id,
    });
    ok("it can be revoked", revoked.value?.status === "revoked", revoked.error?.slice(0, 60));
    const after = (await callers.asAdmin("list_members", {})).value?.seats;
    ok("which gives the seat back", after?.pending_invitations === 0, JSON.stringify(after));
  }

  // ── removing somebody ─────────────────────────────────────────────────────
  section("12f — removing a member takes their records with them");
  // A seat and a granted allowance, both in the member's OWN metadata, keyed by this org.
  await api.seats.assign(orgId, memberUserId, "premium").catch(() => {});
  const cycle = await api.usage.cycle(orgId);
  await api.topUps
    .grant(orgId, { memberId: memberUserId, amount: 50, cycle: cycle.key, id: `${RUN}-m` })
    .catch(() => {});
  const before = await ctx.adapter.getUserMetadata(memberUserId);
  ok("they hold records for this workspace", Object.keys(before).length > 0, Object.keys(before).join(","));

  const removed = await callers.asAdmin("remove_member", { member_id: memberUserId });
  ok("the removal succeeds", removed.value?.status === "removed", removed.error?.slice(0, 80));
  ok("and it reports what it cleared", (removed.value?.records_cleared ?? 0) >= 1, String(removed.value?.records_cleared));

  const left = await ctx.adapter.getUserMetadata(memberUserId);
  const forThisOrg = Object.entries(left).filter(([, v]) => String(v).includes(orgId));
  ok(
    "nothing of this workspace is left on them",
    forThisOrg.length === 0,
    forThisOrg.map(([k]) => k).join(",") || "clean",
  );

  const remaining = (await callers.asAdmin("list_members", {})).value?.members ?? [];
  ok("and the membership is gone", remaining.length === 1 && remaining[0].member_id === adminUserId);

  section("12g — a stranger is refused rather than silently succeeding");
  const stranger = await callers.asAdmin("remove_member", { member_id: "user_01DOESNOTEXIST00000000000" });
  ok("removing somebody not in the workspace", /not a member/i.test(stranger.error ?? ""), stranger.error?.slice(0, 80));

  note("the throwaway workspace and its people are torn down LIFO by the harness");
}
