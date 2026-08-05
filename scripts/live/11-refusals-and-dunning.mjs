// What a customer HITS, and what they are told when they hit it.
//
// Everything measured so far is a customer succeeding. These are the four ways the product
// says no, and the message and the HTTP status are the entire deliverable — a refusal that
// misdescribes itself is worse than a refusal, because the caller acts on it: a rate limit
// reported as "buy credits" sells someone a top-up that changes nothing.
//
//   11a  an empty wallet          → 402, and the message says buy credits
//   11b  a funded wallet          → allowed, and the debit is real
//   11c  a rate limit             → 429 + Retry-After, naming when it resets
//   11d  the customer's own cap   → 429, and told they can raise it themselves
//   11e  a card that fails on RENEWAL → past_due recorded on the org, hook fired
//
// 11c and 11d are made deterministic by a single call that costs more than the whole window,
// which is refused at zero usage. That is a real scenario (one expensive action against a
// daily allowance) and it avoids the meter's ~60s read lag, which would otherwise decide
// whether this section passes. Accumulation across many small calls is covered offline.

import { createBilling } from "../../dist/create-billing.js";
import { createStripeEventHandler } from "../../dist/sync.js";
import { getCreditBalance, grantCredits, setAutoReloadSettings, setSpendControls } from "../../dist/billing.js";
import { advanceClock, eur, note, ok, section, skip } from "../lib/harness.mjs";
import { PRO_PLAN, RUN, STARTER_PLAN, attachTestCard } from "../lib/scratch-stripe.mjs";
import { midCycle } from "../lib/scenario.mjs";
import { createScratchOrg } from "../lib/scratch-workos.mjs";
import { taxRatesFor } from "../../dist/tax.js";

/** A rate card whose one expensive action costs more than the plan's daily window. */
const RATE_CARD = { probe: 10, huge: 25_000 };

export async function run(ctx) {
  const { stripe, adapter, api, config, plans } = ctx;

  // Its own workspace and customer: this section empties a wallet and pins a spend ceiling,
  // and both would change what every other section measures.
  const own = await createScratchOrg({ name: `E2E Refusals ${RUN}`, suffix: "-r" });
  const { rateIds } = await taxRatesFor({
    originCountry: "IT",
    registrations: [{ country: "IT" }],
    country: "IT",
    notes: config.tax.notes,
  });
  const s = await midCycle(
    { ...ctx, orgId: own.orgId },
    { plan: PRO_PLAN, priceKey: `${PRO_PLAN}_premium_monthly`, at: 0.2, taxRates: rateIds, label: "refusals" },
  );

  // A metered billing instance — the harness's own has no meter, deliberately. This is the
  // wiring a consumer does: a rate card, and the plan resolved the way the meter resolves it.
  const metered = createBilling({
    adapter,
    config,
    plans,
    realm: "e2e-refusals",
    meter: { rateCard: RATE_CARD, resolvePlan: async () => PRO_PLAN },
  });
  const key = await adapter.mintApiKey(own.orgId, `${RUN}-refusals`);
  const guard = (action) =>
    metered.meterRequest(
      new Request("https://e2e.test/api/run", {
        method: "POST",
        headers: { authorization: `Bearer ${key.value}` },
      }),
      action,
    );

  // ── 11a an empty wallet ───────────────────────────────────────────────────
  section("11a — an empty wallet is 402, and the message names the remedy");
  const startBalance = await getCreditBalance(s.customerId, "eur");
  ok("the wallet starts empty", startBalance === 0, `${startBalance}`);

  const refused = await guard("probe");
  ok("a metered call is refused", refused !== null && refused.status !== 200, `status ${refused?.status}`);
  ok("with HTTP 402, the status a client can act on", refused?.status === 402, `${refused?.status}`);
  const body402 = await refused.json();
  note(`402 body: ${JSON.stringify(body402).slice(0, 110)}`);
  ok("naming the reason", body402.reason === "insufficient_balance" || body402.reason === "pool_exhausted", body402.reason);
  // The one thing the caller must be able to act on. "Buy credits" is the whole point of 402.
  ok("and telling them what to do", /credit|buy|top.?up/i.test(body402.error ?? ""), (body402.error ?? "").slice(0, 70));
  ok("with no Retry-After, because waiting fixes nothing", refused.headers.get("Retry-After") === null);

  // ── 11b a funded wallet ───────────────────────────────────────────────────
  section("11b — funded, the same call goes through and the debit is real");
  await grantCredits(s.customerId, 30_000, `${RUN} refusal test float`, "eur", `${RUN}:float`);
  const funded = await getCreditBalance(s.customerId, "eur");
  ok("the wallet is funded", funded === 30_000, `${funded}`);

  const allowed = await guard("probe");
  ok("the guard lets it through", allowed === null, allowed ? `status ${allowed.status}` : "null = continue");
  const afterCall = await getCreditBalance(s.customerId, "eur");
  ok("and the credits really left the wallet", afterCall === funded - RATE_CARD.probe, `${funded} → ${afterCall}`);

  // ── 11c a rate limit ──────────────────────────────────────────────────────
  section("11c — a rate limit is 429 with Retry-After, never 402");
  // The plan declares 20 000 credits per DAY, org-wide. One call costing 25 000 cannot fit in
  // the window however empty it is, so this is deterministic and needs no meter propagation.
  const limited = await guard("huge");
  ok("the call is refused", limited !== null, `status ${limited?.status}`);
  ok("with HTTP 429, not 402", limited?.status === 429, `${limited?.status}`);
  const retryAfter = limited?.headers.get("Retry-After");
  ok("and a Retry-After header a client can obey", Boolean(retryAfter), retryAfter ?? "missing");
  const body429 = await limited.json();
  note(`429 body: ${JSON.stringify(body429).slice(0, 130)}`);
  ok("named as a rate limit", body429.reason === "rate_limit_reached", body429.reason);
  ok("with the seconds to wait in the body too", Number(body429.retry_after_seconds) > 0, `${body429.retry_after_seconds}`);
  // The message must NOT tell them to buy anything: buying does not lift a rate limit, and this
  // is the refusal a caller can simply wait out.
  ok(
    "and the message does not sell them credits",
    !/buy_credits|buy credits/i.test(body429.error ?? ""),
    (body429.error ?? "").slice(0, 80),
  );
  // The wallet is untouched: a rate limit funds nothing and charges nothing.
  ok("the wallet was not debited for a refused call", (await getCreditBalance(s.customerId, "eur")) === afterCall);

  // ── 11d the customer's own ceiling ────────────────────────────────────────
  section("11d — a self-imposed ceiling refuses too, and says they can raise it");
  await setSpendControls(s.customerId, { limitCredits: 5 });
  const capped = await guard("probe"); // costs 10, ceiling is 5
  ok("the call is refused by the ceiling", capped !== null, `status ${capped?.status}`);
  const bodyCap = capped ? await capped.json() : {};
  note(`ceiling body: ${JSON.stringify(bodyCap).slice(0, 130)}`);
  ok("named as the SPEND limit, not a rate limit", bodyCap.reason === "spend_limit_reached", bodyCap.reason);
  ok("as 429, because it resets and they can lift it", capped?.status === 429, `${capped?.status}`);
  // The distinction that makes this worth a separate reason: this is the one limit the customer
  // controls, so the message has to say so — otherwise they wait a month for nothing.
  ok(
    "and the message says they can raise it themselves",
    /spend|raise|limit/i.test(bodyCap.error ?? ""),
    (bodyCap.error ?? "").slice(0, 80),
  );
  await setSpendControls(s.customerId, { limitCredits: 0 });
  ok("clearing the ceiling lets calls through again", (await guard("probe")) === null);

  // ── 11e the card fails on a renewal ───────────────────────────────────────
  section("11e — a card that fails at renewal: past_due, recorded and hooked");
  {
    const failing = await createScratchOrg({ name: `E2E Dunning ${RUN}`, suffix: "-p" });
    const d = await midCycle(
      { ...ctx, orgId: failing.orgId },
      { plan: STARTER_PLAN, priceKey: `${STARTER_PLAN}_standard_monthly`, at: 0.5, taxRates: rateIds, label: "dunning" },
    );
    // The card goes bad AFTER the first payment, which is what a real expiry looks like.
    await attachTestCard(stripe, d.customerId, { card: "fail" });
    await setAutoReloadSettings(d.customerId, 0, 0, false);

    await d.toBoundary();
    const renewal = (await d.invoices(10)).find((i) => i.billing_reason === "subscription_cycle");
    ok("a renewal invoice was issued", Boolean(renewal), renewal?.id);
    ok("and it did NOT get paid", renewal && renewal.status !== "paid", renewal?.status);

    const live = await d.live();
    ok("Stripe moved the subscription to past_due", live.status === "past_due" || live.status === "unpaid", live.status);

    // The library learns about this from an EVENT. A real one, fetched from Stripe and fed to
    // the real handler — no webhook endpoint needed, and nothing about it is simulated.
    const failed = [];
    const handle = createStripeEventHandler({
      adapter,
      plans,
      currency: "eur",
      hooks: { onPaymentFailed: async (orgId) => failed.push(orgId) },
    });
    const events = await stripe.events.list({ types: ["invoice.payment_failed"], limit: 20 });
    const ours = events.data.find((e) => {
      const inv = e.data.object;
      return inv?.customer === d.customerId;
    });
    if (!ours) {
      skip("the invoice.payment_failed event", "not visible in the events list yet");
    } else {
      note(`replaying real event ${ours.id} (${ours.type})`);
      await handle(ours);
      const recorded = await adapter.getSubscription(failing.orgId);
      // The point: an app that mounts the handler learns the customer is behind, and can say so
      // in its own UI. Without it the workspace looks healthy while Stripe is dunning them.
      ok("the org's record says past_due", recorded?.status === "past_due", recorded?.status ?? "nothing recorded");
      ok("and the hook fired with the org id", failed.includes(failing.orgId), failed.join(", ") || "not called");
    }

    // Recovery: the customer fixes the card and pays. The portal is how they reach it, and the
    // invoice is payable — both already exist, so this asserts the door is open, not the fix.
    ok("the unpaid invoice is still payable", Boolean(renewal?.hosted_invoice_url), renewal?.hosted_invoice_url?.slice(0, 40));
    note(`amount owed: ${eur(renewal?.amount_due)}`);
  }
}
