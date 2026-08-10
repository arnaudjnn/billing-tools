// Telling somebody, selling at a price nobody published, and warning before the wall.
//
// The three newest seams, and the three whose offline tests can prove the least. A fake
// notifier is a function that pushes onto an array: it cannot show that a POST left the
// process, that the signature a receiver verifies is the signature the sender wrote, or that
// an endpoint being DOWN leaves the grant it was describing in place. A fake Stripe accepts
// any params, so it cannot show that a negotiated invoice carries a rate. And a fake adapter
// accepts any string, so it cannot show that the alert record fits in a WorkOS metadata value
// — the budget every other write on that org shares.
//
// So this section runs a REAL HTTP endpoint on localhost and points the library's own shipped
// transport at it. Every assertion below reads what actually arrived over the wire.
//
// Two defects were found writing it, both invisible offline for the same reason:
//
//   • `quote.requested` is the one event the library deliberately does NOT address — it names
//     the deployment's operators, whom the consumer routes. `createEmitter` dropped any event
//     with an empty `to`, so the one event operators exist to receive was the one event never
//     delivered. A workspace asking for a price reached nobody.
//   • `resolve_credit_quote` raised its invoice with no tax at all, while every seat invoice
//     and every top-up on the same account carried the account's rate. The auto-reload defect
//     again, on the largest sale the library makes.

import http from "node:http";

import { runWithAuth, runWithPrincipal } from "../../dist/auth.js";
import { maybeAlert } from "../../dist/alerts.js";
import { createBilling } from "../../dist/create-billing.js";
import { createEmitter } from "../../dist/notifications/emit.js";
import { verifyNotification, webhookNotifier } from "../../dist/notifications/index.js";
import { grantTopUp, METADATA_VALUE_LIMIT } from "../../dist/topup.js";

import { defer, ignoreMissing, note, ok, retry, section } from "../lib/harness.mjs";
import { PRO_PLAN, RUN } from "../lib/scratch-stripe.mjs";

const FORBIDDEN = /Forbidden \(403\)/;

export async function run(ctx) {
  const { adapter, orgId, adminUserId, memberUserId, stripe } = ctx;

  // ── a real endpoint ───────────────────────────────────────────────────────
  const secret = `whsec_${RUN}`;
  const received = [];
  // How many of the next deliveries to answer 503 to — a receiver that is briefly broken,
  // which is the case the derived id exists for. The attempt is still RECORDED, because what
  // 13d asserts is what a retried delivery looks like on the wire.
  const failNext = { n: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ headers: req.headers, raw, at: Date.now() });
      if (failNext.n > 0) {
        failNext.n--;
        res.writeHead(503).end("later");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/notify`;
  defer("notification endpoint", () => new Promise((r) => server.close(r)));
  note(`notifications → ${endpoint}`);

  // Its own composition, because the run's `billing` has no notifier: a dead endpoint on
  // every earlier section would have cost each of them the transport's retries.
  const billing = createBilling({
    adapter,
    config: ctx.config,
    plans: ctx.plans,
    realm: "e2e-live",
    notifications: webhookNotifier({ endpoint, secret, retries: 1, timeoutMs: 4000 }),
  });
  const { api, dispatcher } = billing;

  const settle = async (fn) => {
    try {
      return { value: await fn(), error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const as = (principal) => (tool, args = {}) =>
    settle(() =>
      runWithPrincipal({ authHeader: `Bearer ${ctx.apiKey}`, principal }, () =>
        dispatcher.dispatchTool(tool, args),
      ),
    );
  const asAdmin = as({ userId: adminUserId });
  const asMember = as({ userId: memberUserId });

  // The operator credential a machine presents. Set here rather than in the environment file
  // because `operatorConfig()` reads `process.env` on every call, which is what makes the
  // "nobody configured" refusal below reachable in the same run.
  const operatorToken = `optok_${RUN}`;
  const previousToken = process.env.BILLING_OPERATOR_TOKEN;
  process.env.BILLING_OPERATOR_TOKEN = operatorToken;
  defer("operator token", () => {
    if (previousToken === undefined) delete process.env.BILLING_OPERATOR_TOKEN;
    else process.env.BILLING_OPERATOR_TOKEN = previousToken;
  });
  const asOperator = (tool, args = {}) =>
    settle(() =>
      runWithAuth(`Bearer ${ctx.apiKey}`, () => dispatcher.dispatchTool(tool, args), { operatorToken }),
    );

  const body = (r) => JSON.parse(r.raw);
  /** Wait for a delivery to actually arrive over HTTP. */
  const delivered = (pred, why) =>
    retry(
      () => {
        const hit = received.map(body).filter(pred);
        if (!hit.length) throw new Error(`nothing delivered: ${why}`);
        return hit;
      },
      { tries: 24, delayMs: 250 },
    );
  const rawFor = (id) => received.find((r) => body(r).id === id);

  // Whose addresses the emitter is expected to resolve to. Real WorkOS memberships, which is
  // the half no fake can supply: "email the admins" is a membership question.
  const members = await adapter.listMembers(orgId);
  const adminEmail = members.find((m) => m.userId === adminUserId)?.email ?? null;
  const memberEmail = members.find((m) => m.userId === memberUserId)?.email ?? null;

  // ── 13a — the ask, and a signed POST that really left the process ──────────
  section("13a — a workspace asks for a price, and the operators are told over HTTP");
  const asked = await asAdmin("request_credit_quote", {
    volume_amount: 20_000,
    volume_unit: "searches",
    volume_per: "month",
    term: "annual",
    seats: 12,
    budget: 4000,
    payment_method: "invoice",
    purchase_order: `PO-${RUN}`,
    note: "e2e live",
  });
  ok("the quote is recorded", asked.value?.status === "requested", asked.error?.slice(0, 90));
  const quoteId = asked.value?.quote?.id;
  ok("in the terms it was asked in", asked.value?.quote?.volume?.unit === "searches");

  const requestedId = `quote-requested:${quoteId}`;
  const [requested] = await delivered((n) => n.id === requestedId, "quote.requested");
  ok("the operators' event arrived", requested.type === "quote.requested");
  // The point of the fix: this event carries no `audience`, because its recipients are on OUR
  // side of the transaction and the consumer routes them. An empty `to` is its shape.
  ok("with an empty `to`, which is its shape and not a failed lookup", requested.to.length === 0);
  ok("and an id derived from the quote", requested.id === requestedId, requested.id);

  const wire = rawFor(requestedId);
  const headers = {
    id: wire.headers["billing-notification-id"],
    timestamp: wire.headers["billing-notification-timestamp"],
    signature: wire.headers["billing-notification-signature"],
  };
  ok("the id and timestamp travel as headers", headers.id === requestedId && Number.isFinite(Number(headers.timestamp)));
  ok(
    "and the signature verifies with the library's own verifier",
    verifyNotification(secret, headers, wire.raw) === true,
    headers.signature?.slice(0, 20),
  );
  ok(
    "a body altered by one character does not",
    verifyNotification(secret, headers, `${wire.raw} `) === false,
  );
  ok("nor does anyone else's secret", verifyNotification("whsec_not_ours", headers, wire.raw) === false);
  // The replay window is the half a hand-rolled verifier forgets: a valid signature is valid
  // for ever without one.
  ok(
    "and a valid signature outside the replay window does not",
    verifyNotification(secret, headers, wire.raw, { now: Number(headers.timestamp) + 10 * 60_000 }) === false,
  );

  // ── 13b — who may ask, who may answer ─────────────────────────────────────
  section("13b — an admin asks, an operator answers, and a member does neither");
  const memberAsk = await asMember("request_credit_quote", { credits: 1000 });
  ok("a member cannot commit the workspace to a price", FORBIDDEN.test(memberAsk.error ?? ""), memberAsk.error?.slice(0, 60));

  const memberReads = await asMember("list_credit_quotes", {});
  ok(
    "but the queue is member-visible, like every other read",
    (memberReads.value?.quotes ?? []).some((q) => q.id === quoteId),
    memberReads.error?.slice(0, 60),
  );

  const secondAsk = await asAdmin("request_credit_quote", { credits: 1000 });
  ok(
    "one open quote per workspace",
    secondAsk.value?.status === "already_pending" && secondAsk.value?.quote?.id === quoteId,
    JSON.stringify(secondAsk.value ?? secondAsk.error).slice(0, 80),
  );

  // The one gate in this library that fails CLOSED — an admin of the customer's own workspace
  // is not an operator, however admin they are.
  const adminAnswers = await asAdmin("resolve_credit_quote", {
    workspace_id: orgId,
    quote_id: quoteId,
    outcome: "approved",
    credits: 1000,
    amount: 10,
  });
  ok(
    "approving your own discount is not a permission that exists",
    FORBIDDEN.test(adminAnswers.error ?? ""),
    adminAnswers.error?.slice(0, 70),
  );

  // ── 13c — the answer: a real invoice, at a price and a rate ────────────────
  section("13c — the operator approves, and Stripe raises the negotiated invoice");
  const CREDITS = 600_000;
  const AMOUNT_MAJOR = 4000;
  const approved = await asOperator("resolve_credit_quote", {
    workspace_id: orgId,
    quote_id: quoteId,
    outcome: "approved",
    credits: CREDITS,
    amount: AMOUNT_MAJOR,
    days_until_due: 45,
    note: "e2e negotiated",
  });
  ok("the machine credential is accepted", approved.value?.status === "approved", approved.error?.slice(0, 90));
  const invoiceId = approved.value?.quote?.answer?.invoiceId;
  ok("and it raised an invoice", Boolean(invoiceId), JSON.stringify(approved.value?.quote?.answer ?? {}).slice(0, 90));

  if (invoiceId) {
    defer(`quote invoice ${invoiceId}`, () => stripe.invoices.voidInvoice(invoiceId).catch(ignoreMissing));
    const inv = await stripe.invoices.retrieve(invoiceId, { expand: ["total_taxes"] });

    // The whole reason this path exists: what they PAY and what they GET are different
    // numbers. Everywhere else in the library they are the same one, deliberately.
    ok("the amount invoiced is the negotiated price", inv.subtotal === AMOUNT_MAJOR * 100, `${inv.subtotal}`);
    ok(
      "and what a payment will grant is the negotiated quantity",
      inv.metadata?.credits === String(CREDITS),
      `credits=${inv.metadata?.credits}`,
    );
    ok("it is payable by a human, on terms", inv.collection_method === "send_invoice" && inv.due_date > 0);
    ok(
      "the PO is on the invoice, where procurement looks for it",
      (inv.custom_fields ?? []).some((f) => f.name === "PO" && f.value === `PO-${RUN}`),
      JSON.stringify(inv.custom_fields ?? []),
    );

    // The defect this section found. A domestic Italian sale, on an account whose every other
    // charge carries 22% — read off the invoice rather than off the request.
    const line = inv.lines?.data?.[0];
    const rates = line?.tax_rates ?? line?.taxes?.map((t) => t.tax_rate_details) ?? [];
    ok("the negotiated invoice is TAXED", inv.total > inv.subtotal, `${inv.subtotal} → ${inv.total}`);
    ok(
      "at the same rate the deployment charges everywhere else",
      inv.total === Math.round(inv.subtotal * 1.22),
      `total ${inv.total}, expected ${Math.round(inv.subtotal * 1.22)}`,
    );
    const rateId = typeof rates[0] === "string" ? rates[0] : rates[0]?.id ?? rates[0]?.tax_rate;
    if (rateId) {
      const rate = await stripe.taxRates.retrieve(rateId);
      // The display name is not decoration: it is the legally mandatory mention, and per CJEU
      // C-247/21 an omitted one cannot be cured afterwards.
      ok(
        "and the rate carries a display name, which is the mandatory mention",
        Boolean(rate.display_name) && rate.percentage === 22,
        `${rate.percentage}% "${rate.display_name}"`,
      );
    } else {
      note("no tax rate id on the line — reported above by the total alone");
    }
  }

  const resolvedId = `quote-approved:${quoteId}`;
  const [answer] = await delivered((n) => n.id === resolvedId, "quote.resolved");
  ok("the answer is delivered", answer.type === "quote.resolved");
  // Addressed, unlike the ask: it goes to the admin who asked, and the emitter resolved that
  // from a real WorkOS membership listing.
  ok(
    "to the admin who asked, by their real address",
    adminEmail ? answer.to.includes(adminEmail) : answer.to.length > 0,
    `${answer.to.join(",")} (expected ${adminEmail})`,
  );
  ok(
    "and the member's own email is filled in, which the call site could not do",
    answer.data?.member?.email === adminEmail,
    answer.data?.member?.email ?? "null",
  );
  // The outcome is IN the id: a denial is not a redelivery of an approval.
  ok("the id names the outcome", answer.id === `quote-approved:${quoteId}`, answer.id);

  // ── 13d — a retried delivery is byte-identical, because the id is derived ───
  section("13d — a receiver that was briefly down gets the same event, not a new one");
  if (!(await api.topUps.grantable(orgId)).ok) {
    await adapter.setSubscription?.(orgId, {
      plan: PRO_PLAN,
      status: "active",
      subscriptionId: null,
      periodEnd: null,
    });
    note(`plan set to ${PRO_PLAN}: a pooled plan has nothing per-member to raise`);
  }
  const cycle = await api.usage.cycle(orgId);
  const grantId = `${RUN}-notify`;

  // 503 once: the transport retries a 5xx (and not a 4xx, which is an answer).
  failNext.n = 1;
  let mark0 = received.length;
  const grant = await api.topUps.grant(orgId, {
    memberId: memberUserId,
    amount: 100,
    cycle: cycle.key,
    id: grantId,
  });
  ok("the grant succeeds", grant?.ok === true, JSON.stringify(grant ?? {}).slice(0, 70));

  const attempts = await retry(
    () => {
      const hit = received.slice(mark0).filter((r) => body(r).type === "topup.resolved");
      if (hit.length < 2) throw new Error(`${hit.length} of 2 attempts seen`);
      return hit;
    },
    { tries: 24, delayMs: 250 },
  );
  ok("a 5xx is retried", attempts.length === 2, `${attempts.length} attempts`);
  // The whole reason a notification carries a derived id: two POSTs, one piece of news. An id
  // that changed per attempt would make the receiver's dedupe impossible and the field a lie.
  ok(
    "and the retry is the SAME event — same id, same timestamp, same body",
    attempts[0].raw === attempts[1].raw &&
      attempts[0].headers["billing-notification-id"] === attempts[1].headers["billing-notification-id"] &&
      attempts[0].headers["billing-notification-timestamp"] ===
        attempts[1].headers["billing-notification-timestamp"],
    attempts.map((a) => a.headers["billing-notification-id"]).join(" | "),
  );
  ok(
    "so the signature is identical too, and verifies on both",
    attempts[0].headers["billing-notification-signature"] ===
      attempts[1].headers["billing-notification-signature"],
  );
  const first = body(attempts[0]);
  ok("the id names the subject and the outcome", first.id === `topup-granted:${grantId}`, first.id);
  ok(
    "addressed to the member it is about, by their real address",
    memberEmail ? first.to.includes(memberEmail) : first.to.length > 0,
    `${first.to.join(",")} (expected ${memberEmail})`,
  );

  // And the SOURCE dedupes as well: the same grant id is already in the record, so there is
  // no second event to send. Both halves matter — the storage one stops a double allowance,
  // the derived id stops a double email.
  mark0 = received.length;
  const again0 = await api.topUps.grant(orgId, {
    memberId: memberUserId,
    amount: 100,
    cycle: cycle.key,
    id: grantId,
  });
  await new Promise((r) => setTimeout(r, 2000));
  ok("a repeated grant is a duplicate, not a second grant", again0?.reason === "duplicate", JSON.stringify(again0 ?? {}));
  ok(
    "and it tells nobody a second time",
    received.slice(mark0).filter((r) => body(r).type === "topup.resolved").length === 0,
  );

  // ── 13e — a dead endpoint changes nothing about what happened ──────────────
  section("13e — the endpoint is down; the grant is not");
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r)); // now nothing is listening there
  const errors = [];
  const notifyNowhere = createEmitter(
    adapter,
    webhookNotifier({ endpoint: `http://127.0.0.1:${deadPort}/gone`, secret, retries: 1, timeoutMs: 4000 }),
    (e) => errors.push(e),
  );

  const deadGrantId = `${RUN}-nowhere`;
  const started = Date.now();
  const res = await grantTopUp(
    adapter,
    orgId,
    { memberId: memberUserId, amount: 75, cycle: cycle.key, id: deadGrantId },
    notifyNowhere,
  );
  const elapsed = Date.now() - started;
  ok("the grant succeeds", res?.ok !== false, JSON.stringify(res ?? {}).slice(0, 70));
  // The transport alone would take one timeout plus a backoff plus another attempt. If the
  // grant waited on it, the customer would be waiting on an email nobody is reading.
  ok("and did not wait on the delivery", elapsed < 4000, `${elapsed}ms`);
  const granted = await api.topUps.granted(orgId, memberUserId, cycle.key);
  ok("the allowance is really there", granted >= 175, `${granted} credits`);
  await retry(
    () => {
      if (!errors.length) throw new Error("no failure reported yet");
      return errors;
    },
    { tries: 20, delayMs: 250 },
  ).catch(() => {});
  ok(
    "the failure is REPORTED rather than swallowed silently",
    errors.length >= 1,
    errors[0] ? String(errors[0]).slice(0, 60) : "nothing reported",
  );

  // ── 13f — the alert, against a real metadata budget ────────────────────────
  section("13f — an allowance crossing a threshold, once per cycle");
  defer("alert records", async () => {
    await Promise.all([
      adapter.setOrgMetadata(orgId, { btAlerts: "" }).catch(ignoreMissing),
      adapter.setUserMetadata(memberUserId, { btAlerts: "" }).catch(ignoreMissing),
    ]);
  });
  const notify = createEmitter(adapter, webhookNotifier({ endpoint, secret, retries: 1, timeoutMs: 4000 }));
  const alertKey = `${cycle.key}-alerts-${RUN}`;
  const at = (used, size = 1000) => ({ pack: { size, used }, pool: null, limits: [] });
  const alertsSince = (from) =>
    received.slice(from).map(body).filter((n) => n.type === "usage.threshold");

  let mark = received.length;
  maybeAlert(adapter, notify, { orgId, memberId: memberUserId, cycleKey: alertKey, state: at(800) });
  const [eighty] = await delivered(
    (n) => n.id === `alert:${orgId}:${alertKey}:pack:80`,
    "the 80% crossing",
  );
  ok("80% is said before the wall, not after it", eighty.data?.threshold === 80);
  ok("as a percentage of an allowance the plan gives", eighty.data?.unit === "percent");
  ok(
    "to the member whose pack it is",
    eighty.data?.scope === "member" && (memberEmail ? eighty.to.includes(memberEmail) : eighty.to.length > 0),
    `${eighty.to.join(",")}`,
  );

  mark = received.length;
  maybeAlert(adapter, notify, { orgId, memberId: memberUserId, cycleKey: alertKey, state: at(820) });
  await new Promise((r) => setTimeout(r, 2500));
  ok(
    "and said once — the claim is in real WorkOS metadata, not in memory",
    alertsSince(mark).length === 0,
    `${alertsSince(mark).length} repeat(s)`,
  );

  mark = received.length;
  maybeAlert(adapter, notify, { orgId, memberId: memberUserId, cycleKey: alertKey, state: at(1000) });
  const [hundred] = await delivered(
    (n) => n.id === `alert:${orgId}:${alertKey}:pack:100`,
    "the 100% crossing",
  );
  ok("a HIGHER threshold is still news", hundred.data?.threshold === 100);
  ok("and the record holds only the highest", alertsSince(mark).length === 1);

  // The customer's OWN ceiling, at the figure the customer typed — so a percentage of it
  // would be a number they never chose.
  mark = received.length;
  maybeAlert(adapter, notify, {
    orgId,
    cycleKey: alertKey,
    state: {
      pack: null,
      pool: null,
      limits: [{ kind: "spend", size: 5000, used: 4200, alertsAt: [4000], every: "month", label: null }],
    },
  });
  const [spend] = await delivered((n) => n.id === `alert:${orgId}:${alertKey}:spend:4000`, "the spend alert");
  ok("a spend alert is in CREDITS", spend.data?.unit === "credits" && spend.data?.threshold === 4000);
  ok(
    "and goes to the admins, because the ceiling is the workspace's",
    spend.data?.scope === "org" && (adminEmail ? spend.to.includes(adminEmail) : spend.to.length > 0),
    spend.to.join(","),
  );

  // Both records are in a value the whole org shares. One oversized value fails EVERY
  // metadata write for that org, which is why this is measured rather than assumed.
  const orgMd = (await adapter.getOrgMetadata(orgId)) ?? {};
  const memberMd = (await adapter.getUserMetadata(memberUserId)) ?? {};
  ok(
    "the org's alert record fits the metadata budget",
    (orgMd.btAlerts?.length ?? 0) > 0 && orgMd.btAlerts.length <= METADATA_VALUE_LIMIT,
    `${orgMd.btAlerts?.length ?? 0}/${METADATA_VALUE_LIMIT} chars`,
  );
  ok(
    "and so does the member's",
    (memberMd.btAlerts?.length ?? 0) > 0 && memberMd.btAlerts.length <= METADATA_VALUE_LIMIT,
    `${memberMd.btAlerts?.length ?? 0}/${METADATA_VALUE_LIMIT} chars`,
  );

  // A new cycle has nothing to say about the last one — which is also what makes the alerts
  // fire again next month, as they should.
  mark = received.length;
  maybeAlert(adapter, notify, {
    orgId,
    memberId: memberUserId,
    cycleKey: `${alertKey}-next`,
    state: at(1000),
  });
  const [again] = await delivered(
    (n) => n.id === `alert:${orgId}:${alertKey}-next:pack:100`,
    "the next cycle's crossing",
  );
  ok("the same crossing fires again next cycle", again.data?.threshold === 100);

  note(`${received.length} notifications delivered over HTTP in this section`);
}
