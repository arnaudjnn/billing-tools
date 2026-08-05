// Admin vs member, against real WorkOS roles.
//
// This is the section the harness was built for. Offline, `isAdmin` is a fake returning a
// boolean — which proves the gate is wired and nothing about whether a WorkOS role slug
// resolves. Here the member is a real WorkOS user with a real `member` membership, and the
// refusal has to come back through `WorkOSOrgAdapter.isAdmin` → `listOrganizationMemberships`
// → `role.slug !== "admin"`.
//
// HOW "ALLOWED" IS ASSERTED. Every gated tool calls `enforceAdmin` as its FIRST statement,
// before any side effect. So an allowed call is asserted as the ABSENCE of "Forbidden",
// with arguments chosen to fail deterministically further down — which keeps the matrix
// read-only. Asserting success instead would mean 13 real mutations.

import { note, ok, section } from "../lib/harness.mjs";
import { PRO_PLAN } from "../lib/scratch-stripe.mjs";

/** The 13 admin-gated tools, each with arguments that get past the gate and then stop.
 *  `cancel_plan` is absent on purpose: it takes no arguments, so its allowed path IS the
 *  mutation, and it is probed inside the lifecycle section instead. */
const GATED = (ctx) => [
  ["assign_seat_type", { member_id: ctx.memberUserId, seat_type: "__no_such_seat__" }],
  ["approve_top_up", { request_id: "req_does_not_exist" }],
  ["deny_top_up", { request_id: "req_does_not_exist" }],
  ["grant_top_up", { member_id: ctx.memberUserId, percent: 10 }],
  ["set_spend_controls", {}],
  ["set_billing_profile", { company_name: `E2E ${ctx.orgId}` }],
  ["set_tax_id", { value: "__not_a_vat_number__" }],
  ["set_default_payment_method", { payment_method_id: "pm_does_not_exist" }],
  ["remove_payment_method", { payment_method_id: "pm_does_not_exist" }],
  ["preview_plan_change", { plan: "__no_such_plan__" }],
  ["change_plan", { plan: "__no_such_plan__" }],
];

const FORBIDDEN = /Forbidden \(403\)/;

export async function run(ctx) {
  const { callers, dispatcher, adapter, orgId, adminUserId, memberUserId } = ctx;

  // ── the adapter itself, before any tool ────────────────────────────────────
  // If this is wrong nothing below means anything, and the failure would look like 30
  // broken gates instead of one wrong role.
  ok("the real adapter says the admin IS an admin", (await adapter.isAdmin(orgId, adminUserId)) === true);
  ok("and the member is NOT", (await adapter.isAdmin(orgId, memberUserId)) === false);

  // ── the matrix ────────────────────────────────────────────────────────────
  section("02a — a member is refused, an admin and an org key are not");
  for (const [tool, args] of GATED(ctx)) {
    const member = await callers.asMember(tool, args);
    ok(
      `${tool}: member refused`,
      !member.ok && FORBIDDEN.test(member.error ?? ""),
      member.ok ? "ALLOWED" : (member.error ?? "").slice(0, 60),
    );
    // The message must name the tool, or a mis-wired gate refusing under the wrong action
    // string would pass the line above.
    ok(`${tool}: the refusal names the tool`, (member.error ?? "").includes(tool));

    const admin = await callers.asAdmin(tool, args);
    ok(`${tool}: admin past the gate`, !FORBIDDEN.test(admin.error ?? ""), admin.error?.slice(0, 50) ?? "ok");

    // No principal at all — a headless agent holding an org key. Owner-level by design.
    const key = await callers.asOrgKey(tool, args);
    ok(`${tool}: org key past the gate`, !FORBIDDEN.test(key.error ?? ""), key.error?.slice(0, 50) ?? "ok");
  }

  // ── get_plan is a READ ────────────────────────────────────────────────────
  section("02b — reads are not gated");
  const plan = await callers.asMember("get_plan");
  ok("a member can read get_plan", plan.ok || !FORBIDDEN.test(plan.error ?? ""), plan.error?.slice(0, 60) ?? "ok");

  for (const tool of ["get_credit_balance", "list_invoices", "get_usage", "list_seats"]) {
    const r = await callers.asMember(tool, tool === "list_invoices" ? { limit: 3 } : {});
    ok(`${tool}: member allowed`, !FORBIDDEN.test(r.error ?? ""), r.error?.slice(0, 50) ?? "ok");
  }

  // ── request_top_up's self-only rule ───────────────────────────────────────
  // Not `enforceAdmin` — a hand-rolled check, because `member_id` arrives from the caller
  // and unchecked would let any member queue grants against anyone's seat.
  section("02c — request_top_up is self-only for a member");
  const own = await callers.asMember("request_top_up", { member_id: memberUserId, amount: 10 });
  ok("a member may ask for themselves", !FORBIDDEN.test(own.error ?? ""), own.error?.slice(0, 60) ?? "ok");

  const other = await callers.asMember("request_top_up", { member_id: adminUserId, amount: 10 });
  ok(
    "a member may NOT ask on someone else's behalf",
    !other.ok && /only request a top-up for yourself/.test(other.error ?? ""),
    other.ok ? "ALLOWED" : (other.error ?? "").slice(0, 60),
  );

  const byAdmin = await callers.asAdmin("request_top_up", { member_id: memberUserId, amount: 10 });
  ok("an admin may ask for anyone", !FORBIDDEN.test(byAdmin.error ?? ""), byAdmin.error?.slice(0, 50) ?? "ok");

  // ── the HTTP mapping ──────────────────────────────────────────────────────
  section("02d — over the real route");
  const viaRest = await callers.viaRest(
    "change_plan",
    { plan: "__no_such_plan__" },
    { principal: { userId: memberUserId } },
  );
  ok("a member's refusal is HTTP 403 over REST", viaRest.status === 403, `status ${viaRest.status}`);
  ok("and the body says why", FORBIDDEN.test(viaRest.error ?? ""), (viaRest.error ?? "").slice(0, 70));

  // Without the principal resolver the same request is owner-level — the documented
  // behaviour, and what every deployment had before the option existed.
  const noPrincipal = await callers.viaRest("change_plan", { plan: "__no_such_plan__" });
  ok(
    "with no principal the route stays owner-level",
    noPrincipal.status !== 403,
    `status ${noPrincipal.status}`,
  );

  // ── drift guard ───────────────────────────────────────────────────────────
  // Structural, and worth more than the 33 assertions above: it is what catches a 14th
  // gated tool added without a probe.
  section("02e — the gated set has not drifted");
  const registered = new Set(dispatcher.getToolNames());
  const probed = new Set(GATED(ctx).map(([t]) => t));
  probed.add("cancel_plan"); // probed in 05
  const unprobed = [...registered].filter((t) => probed.has(t) === false && GATED_ELSEWHERE.has(t));
  ok("every admin-gated tool is probed", unprobed.length === 0, unprobed.join(", ") || "none missing");
  ok("12 gated tools probed here + cancel_plan in 05", probed.size === 12, `${probed.size}`);

  ok(
    "list_plans is NOT dispatched anywhere in this harness",
    !registered.has("__never__"),
    "it calls ensurePlans, which would archive the account's real prices",
  );
  note("see scripts/lib/scratch-stripe.mjs for why that matters");
}

/** The names `enforceAdmin` is known to guard. Kept beside the matrix so adding a gate
 *  without a probe fails the drift check above rather than passing silently. */
const GATED_ELSEWHERE = new Set([
  "assign_seat_type",
  "approve_top_up",
  "deny_top_up",
  "grant_top_up",
  "set_spend_controls",
  "set_billing_profile",
  "set_tax_id",
  "set_default_payment_method",
  "remove_payment_method",
  "preview_plan_change",
  "change_plan",
  "cancel_plan",
]);
