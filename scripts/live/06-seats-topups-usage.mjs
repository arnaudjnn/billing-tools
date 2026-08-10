// Seats, top-ups and usage — the three things whose storage is the claim.
//
// Everything here is about WHERE a record lands, which is exactly what a fake adapter
// cannot tell you. Three defects the offline suite passed straight through:
//
//  • a seat assignment packed into ONE org-metadata value overflowed at ~13 members, on the
//    one plan shape whose premise is many seats — and dropping an entry silently downgrades
//    a member to the default pack. So a seat must land on the MEMBER, and only real WorkOS
//    metadata (10 keys, values ≤600 chars, ASCII) can show that it did.
//  • a top-up was filed under a CALENDAR month while the meter read the SUBSCRIPTION period,
//    so for every org with a subscription an approved grant granted nothing, with no error
//    anywhere. There is one cycle key, and this asserts the grant is readable under the key
//    the meter uses — not under any key at all.
//  • `usageSince` sums real Stripe balance transactions. A fake sums an array.

import { deductCredits, getCreditBalance, grantCredits } from "../../dist/billing.js";
import { note, ok, section } from "../lib/harness.mjs";
import { PRO_PLAN, RUN } from "../lib/scratch-stripe.mjs";


export async function run(ctx) {
  const { stripe, api, adapter, orgId, customerId, memberUserId, adminUserId, callers } = ctx;

  // Seat types and a top-up allowance both come from the plan IN FORCE, so with no
  // subscription recorded every assertion below would fail for the same uninteresting
  // reason. In a full run 05 leaves one; running this section alone records it here.
  if (!(await api.plan(orgId))) {
    await adapter.setSubscription?.(orgId, { plan: PRO_PLAN, status: "active", subscriptionId: null, periodEnd: null });
    note(`no subscription recorded (05 did not run) — pinned to ${PRO_PLAN}`);
  }

  // ── seats ─────────────────────────────────────────────────────────────────
  section("06a — a seat assignment lands on the MEMBER, not in the org blob");
  const assigned = await callers.asAdmin("assign_seat_type", {
    member_id: memberUserId,
    seat_type: "premium",
  });
  ok("assign_seat_type succeeds for an admin", assigned.ok, assigned.error?.slice(0, 60) ?? "ok");

  ok("and reads back through the library", (await api.seats.get(orgId, memberUserId)) === "premium");

  // The actual claim: it is on the USER's own metadata budget, so the org blob cannot
  // overflow no matter how many members there are.
  const userMeta = await adapter.getUserMetadata(memberUserId);
  const packed = JSON.stringify(userMeta);
  ok("the record is on the member's own metadata", packed.includes("premium"), Object.keys(userMeta).join(", "));
  // Every value the store will accept has to fit ITS limit, which is measured in
  // characters — a record count proves nothing.
  const oversized = Object.entries(userMeta).filter(([, v]) => String(v).length > 600);
  ok("every value fits WorkOS's 600-char limit", oversized.length === 0, oversized.map(([k]) => k).join(", ") || "all fit");
  ok("and within its 10-key budget", Object.keys(userMeta).length <= 10, `${Object.keys(userMeta).length} key(s)`);

  // `assignments` is a MAP of member id → seat type, keyed by the WorkOS user id, which is
  // what makes enumerating it depend on `adapter.listMemberIds`.
  const seats = (await callers.asMember("list_seats", {})).value;
  ok(
    "list_seats reports the assignment",
    seats?.assignments?.[memberUserId] === "premium",
    JSON.stringify(seats?.assignments ?? {}).slice(0, 70),
  );
  // The catalogue drives this, so an empty list would mean the plan's seat types never
  // reached the tool — the "seven tools describing a product that does not exist" failure.
  ok("and offers the plan's own seat types", (seats?.seat_types?.length ?? 0) >= 2, JSON.stringify(seats?.seat_types ?? []).slice(0, 60));

  // A cleared seat writes a TOMBSTONE rather than deleting, because the legacy org map is
  // still read as a fallback and a plain delete would read back as the old seat.
  await callers.asAdmin("assign_seat_type", { member_id: memberUserId, seat_type: "" });
  ok("clearing a seat really clears it", !(await api.seats.get(orgId, memberUserId)));
  await callers.asAdmin("assign_seat_type", { member_id: memberUserId, seat_type: "premium" });

  // ── the cycle ─────────────────────────────────────────────────────────────
  section("06b — a top-up is filed under the cycle the METER reads");
  const cycle = await api.usage.cycle(orgId);
  note(`cycle: ${cycle.key}  (${new Date(cycle.start).toISOString().slice(0, 10)} →)`);
  ok("the cycle has a key anything filed against it must use", Boolean(cycle.key), cycle.key);

  // The TOOL refuses somebody nothing is refusing, and that is the rule rather than an
  // obstacle: an ask filed by a member with allowance left is a question with no answer, and
  // it then blocks the real ask they would make on running out. This harness wires no meter
  // deliberately, so no usage is ever recorded and the member is never blocked — which makes
  // this the one place the refusal can be observed live.
  const premature = await callers.asMember("request_top_up", { member_id: memberUserId, amount: 250 });
  ok(
    "a member with allowance left is refused, not queued",
    /not_blocked|nothing is refusing|allowance left/i.test(premature.error ?? JSON.stringify(premature.value ?? {})),
    (premature.error ?? JSON.stringify(premature.value)).slice(0, 80),
  );

  // So the queue below is driven through the bound API, which resolves the cycle the same way
  // and carries no `blocked` gate (the gate belongs to the ladder, not to the record). NOT the
  // tool's `cycle` escape hatch: passing the key in would make the next assertion tautological,
  // and the claim is precisely that the library derives the SAME key the meter reads.
  const requested = await api.topUps.request(orgId, { memberId: memberUserId, amount: 250 });
  ok("an ask can still be filed for them", Boolean(requested?.id), requested?.id?.slice(0, 8));
  // Not "a cycle" — THE cycle. A request written under a calendar month while the meter
  // reads a subscription period grants nothing and reports no error.
  ok("filed under the meter's cycle", requested?.cycle === cycle.key, `${requested?.cycle} vs ${cycle.key}`);

  const queued = (await callers.asAdmin("list_top_up_requests", {})).value;
  const pending = (queued?.requests ?? []).find((r) => r.id === requested.id);
  ok("it is in the queue", Boolean(pending), pending?.status ?? "missing");

  const approved = (await callers.asAdmin("approve_top_up", { request_id: requested.id })).value;
  ok("an admin approves it", approved?.status === "approved", approved?.status);

  const granted = await api.topUps.granted(orgId, memberUserId, cycle.key);
  ok("and the allowance is readable under that cycle", granted >= 250, `${granted} credits`);

  // The grant is per-MEMBER too, for the same reason the seat is.
  const afterGrant = await adapter.getUserMetadata(memberUserId);
  ok(
    "the grant is on the member's metadata, keyed by org",
    JSON.stringify(afterGrant).includes(orgId) || JSON.stringify(afterGrant).includes(cycle.key),
    Object.keys(afterGrant).join(", "),
  );

  // Unasked, as a percentage of that member's own seat pack.
  const outrightCall = await callers.asAdmin("grant_top_up", { member_id: adminUserId, percent: 10 });
  ok(
    "an admin can grant unasked, as a % of that seat's pack",
    outrightCall.value?.status === "granted",
    outrightCall.ok ? JSON.stringify(outrightCall.value).slice(0, 80) : outrightCall.error?.slice(0, 80),
  );

  // Filed through the bound API for the same reason as above: this member has allowance left,
  // so the TOOL correctly refuses to queue an ask — and what is being asserted here is the
  // DENIAL, which needs something pending to act on.
  const denyTarget = await api.topUps.request(orgId, { memberId: memberUserId, amount: 10 });
  const denied = (await callers.asAdmin("deny_top_up", { request_id: denyTarget.id })).value;
  ok("and refuse one", denied?.status === "denied", denied?.status);

  // Correctness and history trim DIFFERENTLY, and this is where that shows.
  //
  // The queue is packed into one org-metadata value, so it drops SETTLED records to make
  // room — the approved row above is gone by now in a full run, where 05 has already filled
  // the org blob. That is the intended trade and not a defect: losing history costs a UI a
  // row. What must never be lost is the ALLOWANCE, which is why a grant lives on the
  // member's own metadata instead, and it is still there with its row deleted.
  const queueNow = (await callers.asAdmin("list_top_up_requests", {})).value?.requests ?? [];
  const rowStill = queueNow.find((r) => r.id === requested.id);
  note(`queue holds ${queueNow.length} record(s); the approved row is ${rowStill ? "kept" : "trimmed"}`);
  const stillGranted = await api.topUps.granted(orgId, memberUserId, cycle.key);
  ok(
    "the granted allowance outlives its own history row",
    stillGranted >= 250,
    `${stillGranted} credits, row ${rowStill ? "kept" : "trimmed"}`,
  );

  // The other half of the rule: a PENDING ask is never what gets dropped. Filed through the
  // bound API — same reason as the two above, and the claim here is about the metadata trim,
  // not about who may ask.
  const fresh = await api.topUps.request(orgId, { memberId: memberUserId, amount: 5 });
  const pendingAfter = ((await callers.asAdmin("list_top_up_requests", {})).value?.requests ?? []).find(
    (r) => r.id === fresh.id,
  );
  ok("a pending ask is never trimmed away", Boolean(pendingAfter), pendingAfter?.status ?? "gone");

  // ── the wallet ────────────────────────────────────────────────────────────
  section("06c — the wallet is Stripe's own balance, and usage is its debits");
  const before = (await callers.asOrgKey("get_credit_balance", {})).value;
  note(`balance before: ${JSON.stringify(before ?? {}).slice(0, 60)}`);

  // The wallet functions take a Stripe CUSTOMER id, not an org, and the bound API
  // deliberately does not wrap them (see the "What is NOT here" note in bound-api.ts) —
  // `api.customerId` is the documented one-line bridge, so this is the consumer's own path.
  const cid = await api.customerId(orgId);
  ok("api.customerId bridges org → Stripe customer", cid === customerId, cid);

  // Granted twice under one key, because this is money an event can replay.
  const key = `${RUN}:grant`;
  await grantCredits(cid, 1_000, `${RUN} e2e grant`, "eur", key);
  await grantCredits(cid, 1_000, `${RUN} e2e grant`, "eur", key);
  const afterOne = await getCreditBalance(cid, "eur");
  ok("a replayed grant credits exactly once", afterOne === 1_000, `${afterOne} credits`);

  await deductCredits(cid, `${RUN}_probe`, 250, "eur", { kind: "api", id: ctx.apiKeyId });
  const afterDeduct = await getCreditBalance(cid, "eur");
  ok("a debit comes straight off it", afterDeduct === 750, `${afterDeduct} credits`);

  const usage = (await callers.asOrgKey("get_usage", { since_days: 1 })).value;
  ok("get_usage sums the debit and not the grant", usage?.usage === 250, `${usage?.usage}`);

  // The caller filter is what an admin screen asks for: which key spent it.
  const byKey = (await callers.asOrgKey("get_usage", { caller_kind: "api", caller_id: ctx.apiKeyId, since_days: 1 }))
    .value;
  ok("and attributes it to the key that spent it", byKey?.usage === 250, `${byKey?.usage}`);
  const otherKey = (
    await callers.asOrgKey("get_usage", { caller_kind: "api", caller_id: "api_key_nonexistent", since_days: 1 })
  ).value;
  ok("but not to a key that did not", otherKey?.usage === 0, `${otherKey?.usage}`);

  // ── limits ────────────────────────────────────────────────────────────────
  section("06d — every window that applies, and when it resets");
  const limits = (await callers.asOrgKey("get_usage_limits", {})).value;
  const windows = limits?.windows ?? [];
  note(`windows: ${windows.map((w) => `${w.kind}/${w.every ?? "cycle"}`).join(", ") || "none"}`);
  ok("get_usage_limits reports a window", windows.length > 0, `${windows.length} window(s)`);

  // The catalogue declares `{ every: "day", credits: 20000, scope: "org" }`, and a rate
  // limit is the one refusal a caller can wait out — so `resets_at` is the field that makes
  // it actionable rather than just a refusal.
  const daily = windows.find((w) => w.kind === "rate_limit" && w.every === "day");
  ok("including the plan's daily rate limit", Boolean(daily), JSON.stringify(daily ?? windows[0] ?? {}).slice(0, 90));
  ok("sized as the catalogue declares", daily?.limit === 20_000, `${daily?.limit}`);

  const resets = daily?.resets_at ?? windows[0]?.resets_at;
  ok("with a reset in the future", Boolean(resets) && new Date(resets).getTime() > Date.now(), resets ?? "none");
  // Fixed and UTC-aligned, not rolling: a rolling window needs every event's timestamp and
  // cannot honestly state when it resets, which is the only thing that makes waiting possible.
  ok(
    "aligned to the top of a UTC window",
    Boolean(resets) && new Date(resets).getUTCMinutes() === 0 && new Date(resets).getUTCSeconds() === 0,
    resets ?? "none",
  );

  // `cap: covers: "users"` means a machine caller gets NO included window — it is skipped,
  // not treated as exhausted, so `onExhausted: "block"` could never refuse an agent over an
  // allowance that was never included for it.
  const asUser = (await callers.asOrgKey("get_usage_limits", { caller_kind: "user", caller_id: memberUserId })).value;
  const userPack = (asUser?.windows ?? []).find((w) => w.kind === "seat_pack");
  ok("a PERSON draws the seat pack", Boolean(userPack), JSON.stringify(userPack ?? {}).slice(0, 70));
  ok(
    "and an API caller draws none, because the cap covers users",
    !windows.some((w) => w.kind === "seat_pack"),
    windows.map((w) => w.kind).join(", "),
  );
  // The 250 credits granted in 06b, on top of the 5 000 premium pack.
  if (userPack) ok("the approved top-up widened it", userPack.limit >= 5_250, `${userPack.limit} credits`);

  // Stripe keeps a running balance per currency and the scalar denominates in the pinned
  // one, so a blind read after a currency switch reports the wrong number entirely.
  const customer = await stripe.customers.retrieve(customerId);
  ok("the customer is pinned to the configured currency", customer.currency === "eur", customer.currency ?? "unpinned");
}
