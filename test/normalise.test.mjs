import assert from "node:assert/strict";
import { test } from "vitest";

const ok = (label, cond, extra = "") => assert.ok(cond, `${label}${extra ? " — " + extra : ""}`);

test("legacy configs normalise to today's exact behaviour", async () => {
  // The safety property: both apps' CURRENT configs must normalise to today's
  // behaviour, and no legacy config may produce cap: "pool" (which would switch
  // the new entitlement path on under a live customer).
  const L = new URL("../dist/index.js", import.meta.url).href;
  const { normalizePlans, grantFor, poolSizeOf, packSizeOf, exhaustedPolicy, selfServePlans, validateBasket, defaultBasket } = await import(L);

  const SCARTOFFIE = {
    hobby: { seats: 1, creditsPerSeat: 1000, price: { monthly: 0, yearly: 0 }, allowanceMode: "per_seat",
      seatTypes: { standard: { label: "Standard", price: { monthly: 0, yearly: 0 }, includedCredits: 1000, seats: 1 } } },
    pro: { seats: 100, creditsPerSeat: 1000, price: { monthly: 2900, yearly: 28800 }, allowanceMode: "per_seat",
      seatTypes: {
        standard: { label: "Standard", price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000 },
        premium: { label: "Premium", price: { monthly: 10523, yearly: 108000 }, includedCredits: 5000 },
        api: { label: "API", price: { monthly: 52615, yearly: 540000 }, includedCredits: 25000, seats: 1 } } },
    enterprise: { seats: null, creditsPerSeat: 10000, price: { monthly: 5000, yearly: 50000 }, allowanceMode: "global",
      seatTypes: { standard: { label: "Standard", price: { monthly: 2104, yearly: 21600 }, includedCredits: 0 } } },
  };
  const GTM = {
    hobby: { seats: 1, creditsPerSeat: 1000, price: { monthly: 1000, yearly: 10000 }, allowanceMode: "per_seat",
      seatTypes: { standard: { price: { monthly: 2500, yearly: 24000 }, includedCredits: 1000, label: "Standard" } } },
    pro: { seats: 10, creditsPerSeat: 5000, price: { monthly: 5000, yearly: 50000 }, allowanceMode: "per_seat",
      seatTypes: {
        standard: { price: { monthly: 2500, yearly: 24000 }, includedCredits: 1000, label: "Standard" },
        premium: { price: { monthly: 12500, yearly: 120000 }, includedCredits: 5000, label: "Premium" },
        api: { price: { monthly: 62500, yearly: 600000 }, includedCredits: 25000, seats: 1, label: "API" } } },
  };


  for (const [app, PLANS] of [["scartoffie", SCARTOFFIE], ["gtm-tools", GTM]]) {
    console.log(`\n${app}`);
    const models = normalizePlans(PLANS);
    ok("every plan normalises", models.length === Object.keys(PLANS).length);
    ok("NO legacy plan yields cap: pool", models.every((m) => m.cap.kind !== "pool"),
       models.map((m) => `${m.key}:${m.cap.kind}`).join(" "));
    ok("all flagged legacy", models.every((m) => m.legacy));
    ok('allowanceMode "global" → cap wallet',
       models.filter((m) => PLANS[m.key].allowanceMode === "global").every((m) => m.cap.kind === "wallet"));
    ok("seat-typed plans sell seats", models.filter((m) => PLANS[m.key].seatTypes).every((m) => m.sells.kind === "seats"));
    ok("member limit carried from `seats`", models.every((m) => m.limits.members === PLANS[m.key].seats));
    ok("per-type cap carried from `seats`",
       models.every((m) => m.seatTypes.every((s) => s.max === (PLANS[m.key].seatTypes?.[s.key]?.seats ?? null))));
    ok("label carried to display", models.every((m) => m.seatTypes.every((s) =>
       (s.display?.label ?? null) === (PLANS[m.key].seatTypes?.[s.key]?.label ?? null))));

    // Grants must equal what sync.ts computed before: Σ includedCredits × purchased qty.
    for (const m of models.filter((m) => m.sells.kind === "seats")) {
      const counts = Object.fromEntries(m.seatTypes.map((s, i) => [s.key, i + 1]));
      const legacySum = Object.entries(counts).reduce(
        (sum, [k, q]) => sum + (PLANS[m.key].seatTypes[k].includedCredits ?? 0) * q, 0);
      ok(`grant unchanged for ${m.key}`, grantFor(m, { seatCounts: counts }) === legacySum,
         `${grantFor(m, { seatCounts: counts })} === ${legacySum}`);
    }
    ok("no pool sizes anywhere", models.every((m) => poolSizeOf(m) === null));
  }

  // The per-seat cap that scartoffie Pro relies on must still be found, and the
  // API seat must still overflow into the wallet rather than blocking.
  const pro = normalizePlans(SCARTOFFIE).find((m) => m.key === "pro");
  ok("standard pack = 1000", packSizeOf(pro, "standard") === 1000);
  ok("premium pack = 5000", packSizeOf(pro, "premium") === 5000);
  ok("user seat blocks at its pack", exhaustedPolicy(pro, { seatType: "standard", kind: "user" }) === "block");
  ok("api seat overflows to wallet", exhaustedPolicy(pro, { seatType: "api", kind: "api" }) === "wallet",
     "(legacy: hardcoded caller.kind === 'user')");

  ok("legacy free plan → sale free", normalizePlans(SCARTOFFIE).find((m) => m.key === "hobby").sale === "free");
  ok("legacy priced plans → self_serve (and the doctor warns)",
     selfServePlans(SCARTOFFIE).sort().join(",") === "enterprise,pro");
  ok("default basket for pro respects nothing yet (legacy has no minSeats)",
     JSON.stringify(defaultBasket(pro)) === '{"standard":0,"premium":0,"api":0}');
  ok("unknown seat type is a problem",
     validateBasket(SCARTOFFIE, { plan: "pro", seats: { nope: 1 } }).some((p) => p.code === "unknown_seat_type"));
  ok("api seat capped at 1 (was enforced nowhere)",
     validateBasket(SCARTOFFIE, { plan: "pro", seats: { standard: 2, api: 3 } })
       .some((p) => p.code === "seat_type_limit" && p.seatType === "api"));


});
