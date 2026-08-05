// Roles beyond the gate, and the boundary between two workspaces.
//
// 02 proves the GATE: twelve tools refuse a member and allow an admin. That is one question,
// and it is not the only one a real deployment depends on. Four more, none of them previously
// asked:
//
//   VISIBILITY — a refusal stops a WRITE. What a member can SEE is a separate decision, and
//                nothing had ever looked at it. A queue listing every colleague's top-up
//                request is not obviously wrong, but it must be a choice, not an accident.
//   ISOLATION  — every id-taking tool is a chance to reach into another workspace.
//                `view_invoice` was checked (04d) because that bug had happened; the other
//                dozen never were. This is the highest-risk untested surface in the library:
//                one missing belongs-to check is a cross-tenant read.
//   ROLE CHANGE— promoting someone must take effect, and demoting them must too. If `isAdmin`
//                were cached anywhere, a demoted admin would keep their powers.
//   THE LAST ADMIN — demote the only admin and nobody can administer the workspace again.
//
// Plus the top-up flow's edges: approving twice, approving something that does not exist,
// approving what was already denied, and what happens to a grant when the cycle rolls.

import { advanceClock, note, ok, section, skip } from "../lib/harness.mjs";
import { PRO_PLAN, RUN } from "../lib/scratch-stripe.mjs";
import { createScratchOrg } from "../lib/scratch-workos.mjs";
import { makeCallers } from "../lib/callers.mjs";

const FORBIDDEN = /Forbidden \(403\)/;

export async function run(ctx) {
  const { adapter, api, orgId, adminUserId, memberUserId, callers, dispatcher, restDispatch, workos } = ctx;

  // ── visibility ────────────────────────────────────────────────────────────
  section("09a — what a member can SEE, which no refusal governs");
  // Two asks from two different people, so "can a member see someone else's" is answerable.
  const mine = (await callers.asMember("request_top_up", { member_id: memberUserId, amount: 15 })).value;
  const theirs = (await callers.asAdmin("request_top_up", { member_id: adminUserId, amount: 15 })).value;
  ok("both asks are filed", Boolean(mine?.id && theirs?.id), `${mine?.id?.slice(0, 8)} / ${theirs?.id?.slice(0, 8)}`);

  const asMember = (await callers.asMember("list_top_up_requests", {})).value?.requests ?? [];
  const asAdmin = (await callers.asAdmin("list_top_up_requests", {})).value?.requests ?? [];
  ok("a member can read the queue at all", asMember.length > 0, `${asMember.length} record(s)`);
  // The finding, either way — this is a product decision the deployment should know it has
  // made. `list_top_up_requests` is not admin-gated, so the queue is workspace-wide.
  // `memberId`, camelCase — the raw `TopUpRequest` is returned as-is, while `request_top_up`
  // answers `member_id`. Two spellings of one field across two tools in the same group, and
  // reading the wrong one here produced a confident FALSE finding ("the queue is per-member")
  // on the first run. Asserted on both spellings so the test cannot be fooled by either.
  const memberOf = (r) => r.memberId ?? r.member_id;
  const seesOthers = asMember.some((r) => memberOf(r) === adminUserId);
  ok(
    "and the queue is WORKSPACE-wide, not per-member",
    seesOthers,
    seesOthers ? "a member sees colleagues' asks — ungated, by design" : "PER-MEMBER",
  );
  note("→ the records use `memberId` while request_top_up answers `member_id` — one field, two spellings");
  ok("an admin sees the same queue", asAdmin.length >= asMember.length, `${asAdmin.length} vs ${asMember.length}`);

  // A member CAN read the workspace's money — deliberately, and worth pinning, because it is
  // the mirror image of the gate: every read is member-visible except none.
  for (const tool of ["get_credit_balance", "get_usage", "get_usage_limits", "get_spend_controls", "get_plan", "list_seats", "list_invoices", "list_payment_methods", "get_billing_profile", "get_billing_portal"]) {
    const r = await callers.asMember(tool, tool === "list_invoices" ? { limit: 2 } : {});
    ok(`${tool}: member may read`, !FORBIDDEN.test(r.error ?? ""), r.error?.slice(0, 40) ?? "ok");
  }

  // ── the approval flow's edges ─────────────────────────────────────────────
  section("09b — approving a top-up: twice, unknown, and already-denied");
  const cycle = await api.usage.cycle(orgId);
  const before = await api.topUps.granted(orgId, memberUserId, cycle.key);
  const first = await callers.asAdmin("approve_top_up", { request_id: mine.id });
  const afterOne = await api.topUps.granted(orgId, memberUserId, cycle.key);
  ok("the first approval grants", afterOne > before, `${before} → ${afterOne}`);

  // Approving twice must not grant twice. An admin refreshing the page and clicking again is
  // the ordinary way this happens, and a double grant is allowance the customer was not sold.
  const second = await callers.asAdmin("approve_top_up", { request_id: mine.id });
  const afterTwo = await api.topUps.granted(orgId, memberUserId, cycle.key);
  ok(
    "approving the same request again does NOT grant again",
    afterTwo === afterOne,
    `${afterOne} → ${afterTwo}${second.ok ? "" : ` (refused: ${(second.error ?? "").slice(0, 40)})`}`,
  );

  const unknown = await callers.asAdmin("approve_top_up", { request_id: "req_does_not_exist" });
  ok(
    "an unknown request id is refused cleanly",
    !unknown.ok && !/undefined|cannot read|TypeError/i.test(unknown.error ?? ""),
    (unknown.error ?? "no error — it ACCEPTED a request that does not exist").slice(0, 60),
  );

  const toDeny = (await callers.asMember("request_top_up", { member_id: memberUserId, amount: 5 })).value;
  await callers.asAdmin("deny_top_up", { request_id: toDeny.id });
  const beforeFlip = await api.topUps.granted(orgId, memberUserId, cycle.key);
  const flip = await callers.asAdmin("approve_top_up", { request_id: toDeny.id });
  const afterFlip = await api.topUps.granted(orgId, memberUserId, cycle.key);
  ok(
    "a denied request cannot then be approved into a grant",
    afterFlip === beforeFlip,
    `${beforeFlip} → ${afterFlip}${flip.ok ? " — APPROVED after denial" : ""}`,
  );

  // ── the grant is per-CYCLE ────────────────────────────────────────────────
  section("09c — an approved grant belongs to ONE cycle and does not carry over");
  {
    // Its own clock: the grant has to be read on both sides of a boundary, and the shared
    // clock has already been moved by earlier sections.
    const { createClockCustomer } = await import("../lib/scratch-stripe.mjs");
    const previous = await adapter.getBillingCustomerId(orgId);
    const { clockId, customerId } = await createClockCustomer(ctx.stripe, { orgId, name: "cycle roll" });
    await adapter.setBillingCustomerId(orgId, customerId);
    // No subscription, so the cycle is the calendar month — which is exactly the case where a
    // grant filed under the wrong key used to vanish silently.
    await adapter.setSubscription?.(orgId, { plan: PRO_PLAN, status: "active", subscriptionId: null, periodEnd: null });

    const thisCycle = await api.usage.cycle(orgId);
    await api.topUps.grant(orgId, { memberId: memberUserId, amount: 500, cycle: thisCycle.key, id: `${RUN}-roll` });
    ok("granted for this cycle", (await api.topUps.granted(orgId, memberUserId, thisCycle.key)) >= 500, thisCycle.key);

    // Move a whole month on. `extraAllowance` reads the cycle it is GIVEN and nothing else, so
    // next month starts clean — the customer bought extra allowance for one cycle, not forever.
    const nextMonth = Math.floor(Date.parse(`${thisCycle.key}-01T00:00:00Z`) / 1000) + 40 * 86_400;
    await advanceClock(ctx.stripe, clockId, nextMonth);
    const later = await api.usage.cycle(orgId, { now: nextMonth * 1000 });
    ok("the clock is in a new cycle", later.key !== thisCycle.key, `${thisCycle.key} → ${later.key}`);
    ok("and the grant did NOT carry over", (await api.topUps.granted(orgId, memberUserId, later.key)) === 0, later.key);
    ok("while last cycle's record is still readable", (await api.topUps.granted(orgId, memberUserId, thisCycle.key)) >= 500);

    if (previous) await adapter.setBillingCustomerId(orgId, previous);
  }

  // ── role changes ──────────────────────────────────────────────────────────
  section("09d — promoting and demoting take effect on the next call");
  const membership = (
    await workos.userManagement.listOrganizationMemberships({ organizationId: orgId, userId: memberUserId })
  ).data[0];
  ok("the member's membership is findable", Boolean(membership), membership?.id);

  await workos.userManagement.updateOrganizationMembership(membership.id, { roleSlug: "admin" });
  ok("the adapter now says they ARE an admin", (await adapter.isAdmin(orgId, memberUserId)) === true);
  const promoted = await callers.asMember("set_billing_profile", { company_name: `Promoted ${RUN}` });
  // No cache anywhere: a promotion a customer just made must work on the next click, and a
  // demotion must bite just as fast.
  ok("and an admin-only tool now succeeds for them", !FORBIDDEN.test(promoted.error ?? ""), promoted.error?.slice(0, 40) ?? "ok");

  await workos.userManagement.updateOrganizationMembership(membership.id, { roleSlug: "member" });
  ok("demoting them reverses it immediately", (await adapter.isAdmin(orgId, memberUserId)) === false);
  const demoted = await callers.asMember("set_billing_profile", { company_name: "nope" });
  ok("and the tool refuses again", !demoted.ok && FORBIDDEN.test(demoted.error ?? ""), (demoted.error ?? "ALLOWED").slice(0, 40));

  // ── the last admin ────────────────────────────────────────────────────────
  section("09e — the last admin, and what stands between a workspace and lockout");
  const admins = (await workos.userManagement.listOrganizationMemberships({ organizationId: orgId }))
    .data.filter((m) => m.role?.slug === "admin");
  ok("there is exactly one admin", admins.length === 1, `${admins.length}`);

  const adminMembership = admins[0];
  await workos.userManagement.updateOrganizationMembership(adminMembership.id, { roleSlug: "member" });
  const anyAdmin = await Promise.all(
    [adminUserId, memberUserId].map((u) => adapter.isAdmin(orgId, u)),
  );
  const lockedOut = anyAdmin.every((v) => v === false);
  note(`after demoting the only admin: isAdmin = ${JSON.stringify(anyAdmin)}`);
  // Nothing in this library prevents it, and this records that plainly rather than pretending
  // otherwise: WorkOS allows the write, so a workspace CAN be left with no administrator, and
  // every admin-gated tool then answers 403 to everyone. An org API key still works, which is
  // why it survives a headless test suite and only bites a real person.
  ok("the workspace can be left with NO admin at all", lockedOut, lockedOut ? "→ FINDING, see below" : "something prevented it");
  if (lockedOut) {
    const stuck = await callers.asAdmin("set_billing_profile", { company_name: "locked out" });
    ok("and every admin-gated tool then refuses everyone", !stuck.ok && FORBIDDEN.test(stuck.error ?? ""), (stuck.error ?? "").slice(0, 40));
    const byKey = await callers.asOrgKey("set_billing_profile", { company_name: `Recovered ${RUN}` });
    ok("while an org API key still gets through, which is the way back", byKey.ok, byKey.error?.slice(0, 40) ?? "ok");
    note("→ FINDING: nothing refuses demoting the last admin. A UI that offers the control");
    note("  must guard it itself, or the only recovery is an org API key / the WorkOS dashboard.");
  }
  await workos.userManagement.updateOrganizationMembership(adminMembership.id, { roleSlug: "admin" });
  ok("restored", (await adapter.isAdmin(orgId, adminUserId)) === true);

  // ── cross-workspace isolation ─────────────────────────────────────────────
  section("09f — a second workspace's key must not reach into the first");
  const other = await createScratchOrg({ name: `E2E Other ${RUN}`, suffix: "-b" });
  const otherKey = await adapter.mintApiKey(other.orgId, `${RUN}-other`);
  const asOther = makeCallers({
    dispatcher,
    restDispatch,
    apiKey: otherKey.value,
    adminUserId: other.adminUserId,
    memberUserId: other.memberUserId,
  });

  ok("the other key resolves to the OTHER org", (await adapter.validateApiKey(otherKey.value))?.orgId === other.orgId);

  // Every tool that takes an id belonging to workspace A, called with workspace B's key. Each
  // must refuse or answer about B — never act on A's object.
  const ourKeys = await adapter.listApiKeys(orgId);
  const ourKeyId = ourKeys[0]?.id;
  // An invoice OF OURS has to exist for the crossing to mean anything — the first run skipped
  // both invoice checks because this section had never raised one, which is a silent hole in
  // exactly the place a cross-tenant read would live.
  let ourInvoiceId = (await callers.asOrgKey("list_invoices", { limit: 1 })).value?.invoices?.[0]?.id;
  if (!ourInvoiceId) {
    const ourCustomer = await api.customerId(orgId);
    const draft = await ctx.stripe.invoices.create({ customer: ourCustomer, collection_method: "charge_automatically", auto_advance: false, metadata: { bt_scratch: RUN } });
    await ctx.stripe.invoiceItems.create({ customer: ourCustomer, invoice: draft.id, currency: "eur", amount: 1_000, description: `${RUN} isolation probe` });
    ourInvoiceId = (await ctx.stripe.invoices.finalizeInvoice(draft.id)).id;
    note(`raised ${ourInvoiceId} so the invoice crossings can run`);
  }
  const ourRequests = (await callers.asAdmin("list_top_up_requests", {})).value?.requests ?? [];
  // Captured BEFORE the crossing, because section 06 legitimately seats this member: asserting
  // an absolute value here failed in a full run and passed standalone, which is the shape of a
  // test that measures the wrong thing.
  const seatBefore = await api.seats.get(orgId, memberUserId);
  const ourRequestId = ourRequests.find((r) => r.status === "pending")?.id ?? ourRequests[0]?.id;

  const crossings = [
    // `api_key_id`, not `key_id` — the first run passed the wrong name and the tool rejected it
    // on VALIDATION, so the belongs-to check it was meant to probe never executed. A refusal
    // for the wrong reason is not a passing isolation test.
    ["revoke_api_key", { api_key_id: ourKeyId }, () => Boolean(ourKeyId)],
    ["view_invoice", { invoice_id: ourInvoiceId }, () => Boolean(ourInvoiceId)],
    ["download_invoice", { invoice_id: ourInvoiceId }, () => Boolean(ourInvoiceId)],
    ["assign_seat_type", { member_id: memberUserId, seat_type: "premium" }, () => true],
    ["grant_top_up", { member_id: memberUserId, percent: 50 }, () => true],
    ["approve_top_up", { request_id: ourRequestId }, () => Boolean(ourRequestId)],
    ["deny_top_up", { request_id: ourRequestId }, () => Boolean(ourRequestId)],
  ];

  for (const [tool, args, ready] of crossings) {
    if (!ready()) {
      skip(`${tool} across workspaces`, "no id of ours to attempt it with");
      continue;
    }
    const attempt = await asOther.asOrgKey(tool, args);
    // Every one of these must be REFUSED. Accepting it is the finding, even when the write
    // happens to land somewhere harmless: `assign_seat_type` accepted a foreign `member_id`
    // and wrote to that stranger's WorkOS user metadata, whose 10-key / 600-char budget is
    // shared with their real workspace — enough writes and their own seats stop saving.
    ok(
      `${tool}: refused across workspaces`,
      !attempt.ok,
      attempt.ok ? "ACCEPTED — cross-tenant" : (attempt.error ?? "").slice(0, 52),
    );
  }

  // The checks that matter: our objects, after all of that.
  ok("our API key still exists", (await adapter.listApiKeys(orgId)).some((k) => k.id === ourKeyId), ourKeyId);
  // Not just "refused": nothing of ours moved. The per-org keying already protected the seat
  // value itself, which is why the accepted write looked harmless and was not.
  const ourSeatAfter = await api.seats.get(orgId, memberUserId);
  ok("our seat is unchanged", ourSeatAfter === seatBefore, `"${seatBefore}" → "${ourSeatAfter}"`);
  const strangerMeta = await adapter.getUserMetadata(memberUserId);
  ok(
    "and nothing of THEIRS was written onto our member's record",
    !JSON.stringify(strangerMeta).includes(other.orgId),
    Object.keys(strangerMeta).join(", ") || "empty",
  );
  ok(
    "their grant did not land on OUR member",
    (await api.topUps.granted(other.orgId, memberUserId, (await api.usage.cycle(other.orgId)).key)) === 0,
    "checked against their org's ledger",
  );
  const theirInvoices = (await asOther.asOrgKey("list_invoices", { limit: 5 })).value?.invoices ?? [];
  ok(
    "and they cannot list our invoices as theirs",
    !theirInvoices.some((i) => i.id === ourInvoiceId),
    `${theirInvoices.length} invoice(s) of their own`,
  );
  const theirBalance = (await asOther.asOrgKey("get_credit_balance", {})).value;
  ok("their wallet is their own", (theirBalance?.credit_balance ?? 0) === 0, `${theirBalance?.credit_balance}`);
}
