import assert from "node:assert/strict";
import { test } from "vitest";

const ok = (label, cond, extra = "") => assert.ok(cond, `${label}${extra ? " — " + extra : ""}`);

test('plan config derives the pricing surfaces', async () => {
  const { derivePlanViews, renderPlansMarkdown, renderRateCardMarkdown, definePlans } =
    await import(new URL("../dist/pricing.js", import.meta.url).href);

  // scartoffie's real numbers, in the new shape, with card content on the plan.
  const PLANS = definePlans({
    hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 1000, onExhausted: "block" },
      limits: { members: 1 }, sale: "free", seat: { key: "solo", display: { label: "Posto unico" } },
      display: { name: "Hobby", order: 1, tagline: "Per iniziare", features: ["Ricerche di base"],
                 cta: { label: "Iniziate gratis" } } },
    pro: { sells: { kind: "seats", minSeats: 2, maxSeats: 100, seatTypes: {
        standard: { price: { monthly: 2104, yearly: 21600 }, includedCredits: 1000, min: 1, display: { label: "Posto Standard", usage: "Tutte le funzioni" } },
        premium: { price: { monthly: 10523, yearly: 108000 }, includedCredits: 5000, display: { label: "Posto Premium", usage: "5× l'utilizzo" } },
        api: { price: { monthly: 52615, yearly: 540000 }, includedCredits: 25000, shared: true, max: 1, display: { label: "Posto API" } } } },
      grant: { kind: "none" }, cap: { kind: "per_seat", onExhausted: "block" }, limits: { members: 100 },
      sale: "self_serve",
      display: { name: "Pro", order: 2, featured: true, badge: "Consigliato", tagline: "Cercate, analizzate, organizzate",
                 featuresIntro: "Tutto il piano Hobby, più:", features: ["Esportazione CSV", "Filtri avanzati"],
                 cta: { label: "Ottenete il piano Pro" } } },
    enterprise: { sells: { kind: "flat", price: { monthly: 0, yearly: 500000 }, intervals: ["yearly"] },
      grant: { kind: "none" }, cap: { kind: "pool", credits: 1000000, onExhausted: "block" },
      limits: { members: null }, sale: "quote",
      display: { name: "Enterprise", order: 3, tagline: "Su misura", cta: { label: "Contattateci" },
                 pooled: { title: "Pacchetto annuale di richieste", note: "Impegno annuale, utilizzo condiviso." } } },
  });

  const it = (minor, cur) => { const v = minor / 100; return `€${Number.isInteger(v) ? v : v.toFixed(2).replace(".", ",")}`; };

  const views = derivePlanViews(PLANS, { interval: "yearly", currency: "eur", locale: "it-IT",
    formatMoney: it, currentPlan: "hobby", hrefs: { contact: "/contatti", signup: "/accedi", checkout: (p) => `/pagamento?piano=${p}` } });
  const [hobby, pro, ent] = views;

  ok("ordered by display.order", views.map((v) => v.key).join(",") === "hobby,pro,enterprise");
  ok("hobby is free with a pool allowance", hobby.price.kind === "free" && hobby.included.scope === "pool" && hobby.included.credits === 1000);
  ok("hobby is the current plan → cta current", hobby.cta.kind === "current");
  // A card labels the single seat segment of a plan that sells no seats. The
  // words come from the plan, not from the app — the same label the usage
  // screen's seat pill shows, so the two cannot call one seat two things.
  ok("seatless plan publishes the name of the seat it gives",
     hobby.price.seatLabel === "Posto unico" && hobby.price.rows.length === 0, hobby.price.seatLabel);
  ok("a plan that SELLS seats has no implicit seat label",
     pro.price.seatLabel === null && ent.price.seatLabel === null);
  ok("pro headline = cheapest non-shared seat per month", pro.price.headline.text === "€18", pro.price.headline.text);
  ok("pro card rows exclude nothing but flag the shared seat",
     pro.price.rows.length === 3 && pro.price.rows.find((r) => r.key === "api").shared === true);
  ok("pro cta → checkout with an href", pro.cta.kind === "checkout" && pro.cta.href === "/pagamento?piano=pro");
  ok("annual saving derived from the DEFAULT BASKET, floored", pro.annualSaving === 14 && pro.annualSavingBasis === "basket",
     `${pro.annualSaving}% basis=${pro.annualSavingBasis}  (the editorial file claimed 17%)`);
  ok("pro included = pack for the default basket", pro.included.scope === "per_seat" && pro.included.credits === 2000,
     `${pro.included.credits} (minSeats 2 × 1000)`);
  ok("member cap comes from config, not copy", pro.members.max === 100);
  ok("enterprise is quoted: no headline invented", ent.price.kind === "quote" && ent.price.headline === null);
  ok("enterprise renders its pooled box FROM CONFIG", ent.price.pooled.title === "Pacchetto annuale di richieste");
  ok("enterprise package size visible at last", ent.included.credits === 1000000 && ent.included.scope === "pool");
  ok("enterprise cta → contact", ent.cta.kind === "contact" && ent.cta.href === "/contatti");
  ok("annual-only plan has no monthly alternate", ent.price.alternate === null);

  const locked = derivePlanViews(PLANS, { canManage: { reason: "Solo un amministratore" }, currency: "eur", formatMoney: it });
  ok("every cta disabled with a reason", locked.every((v) => v.cta.kind === "unavailable" && v.cta.disabledReason));

  const GTM = definePlans({
    hobby: { sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } }, grant: { kind: "none" },
      cap: { kind: "pool", credits: 1000, onExhausted: "wallet" }, limits: { members: 1 }, sale: "self_serve",
      display: { name: "Hobby", order: 1 } },
    pro: { sells: { kind: "flat", price: { monthly: 5000, yearly: 50000 } }, grant: { kind: "none" },
      cap: { kind: "pool", credits: 5000, onExhausted: "wallet" }, limits: { members: 10 }, sale: "self_serve",
      display: { name: "Pro", order: 2 } },
  });
  const md = renderPlansMarkdown(derivePlanViews(GTM, { currency: "usd" }));
  ok("table has a row per plan", md.split("\n").length === 4);
  ok("dollar signs escaped for MDX", md.includes("\\$"));
  const rc = renderRateCardMarkdown({ search: 1, enrich_contact: 5, export: 10 }, { groups: { Search: ["search"] } });
  ok("rate card groups, and ungrouped tools still appear", rc.includes("### Search") && rc.includes("### Other") && rc.includes("enrich_contact"));


});
