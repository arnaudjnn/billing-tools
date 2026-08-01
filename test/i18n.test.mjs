import assert from "node:assert/strict";
import { test } from "node:test";

const ok = (label, cond, extra = "") => assert.ok(cond, `${label}${extra ? " — " + extra : ""}`);

test("text localises, and the library's own words default to English", async () => {
  const P = new URL("../dist/pricing.js", import.meta.url).href;
  const { derivePlanViews, deriveCompareTable, renderPlansMarkdown, definePlans, defineCompare,
          DEFAULT_MESSAGES } = await import(P);
  const { describeBasketProblem, validateBasket } =
    await import(new URL("../dist/index.js", import.meta.url).href);
  let fail=0; const ok=(l,c,e="")=>{console.log(`  ${c?"✓":"✗"} ${l}${e?"  — "+e:""}`);if(!c)fail++;};

  // One config, two languages. Plain strings stay single-language (most configs).
  const PLANS = definePlans({
    free: { sells:{kind:"nothing"}, cap:{kind:"pool",tokens:1000}, limits:{members:1}, sale:"free",
            display:{ name:"Hobby", order:1,
                      tagline:{ en:"Get started", it:"Scoprite il servizio" },
                      features:{ en:["Full-text search","1 000 requests a month"],
                                 it:["Ricerca full-text","1 000 richieste al mese"] },
                      cta:{ label:{ en:"Start free", it:"Iniziate gratis" } } } },
    pro: { sells:{kind:"seats",minSeats:2,seatTypes:{
             standard:{price:{monthly:2104,yearly:21600},includedTokens:1000,min:1,
                       display:{ label:{en:"Standard seat",it:"Posto Standard"}, usage:{en:"All features",it:"Tutte le funzioni"} }}}},
           grant:{kind:"none"}, cap:{kind:"per_seat"}, limits:{members:100}, sale:"self_serve",
           display:{ name:"Pro", order:2, badge:{en:"Most popular",it:"Consigliato"} } },
    ent: { sells:{kind:"flat",price:{monthly:0,yearly:500000},intervals:["yearly"]}, grant:{kind:"none"},
           cap:{kind:"pool",tokens:1000000}, limits:{members:null}, sale:"quote",
           display:{ name:"Enterprise", order:3 } },
  });

  const COMPARE = defineCompare([
    { title: { en:"Search", it:"Ricerca" }, groups: [
      { label: { en:"Limits", it:"Limiti" }, rows: [
        { label: { en:"Members", it:"Utenti" }, from: "members" },
        { label: { en:"Billing cycle", it:"Ciclo di fatturazione" }, from: "intervals" },
        { label: { en:"SLA", it:"SLA" }, values: { ent: { en:"99.9%", it:"99,9%" } } },
      ]},
    ]},
  ]);

  const IT = { unlimited:"Illimitati", monthly:"Mensile", yearly:"Annuale", separator:" o ",
               contactUs:"Su misura", free:"Gratuito" };

  const en = derivePlanViews(PLANS);
  ok("tagline falls back to en", en[0].tagline === "Get started", en[0].tagline);
  ok("features fall back to en", en[0].features[0] === "Full-text search");
  ok("badge falls back to en", en[1].badge === "Most popular");
  ok("seat label falls back to en", en[1].price.rows[0].label === "Standard seat");
  ok("library words are English", DEFAULT_MESSAGES.unlimited === "Unlimited");
  const enTable = deriveCompareTable(PLANS, COMPARE);
  const enRow = (l) => enTable.sections[0].groups[0].rows.find(r=>r.label===l);
  ok("compare labels in en", !!enRow("Members"), enTable.sections[0].groups[0].rows.map(r=>r.label).join(", "));
  ok("unlimited in en", enRow("Members").cells.ent.text === "Unlimited");
  ok("intervals in en", enRow("Billing cycle").cells.ent.text === "Yearly");

  const it = derivePlanViews(PLANS, { locale: "it-IT", currency: "eur", messages: IT });
  ok("tagline in it", it[0].tagline === "Scoprite il servizio", it[0].tagline);
  ok("features in it", it[0].features[1] === "1 000 richieste al mese");
  ok("cta label in it", it[0].cta.label === "Iniziate gratis");
  ok("badge in it", it[1].badge === "Consigliato");
  ok("seat label + usage in it",
     it[1].price.rows[0].label === "Posto Standard" && it[1].price.rows[0].usage === "Tutte le funzioni");
  const itTable = deriveCompareTable(PLANS, COMPARE, { locale:"it", currency:"eur", messages: IT });
  const itRow = (l) => itTable.sections[0].groups[0].rows.find(r=>r.label===l);
  ok("section + group titles in it",
     itTable.sections[0].title === "Ricerca" && itTable.sections[0].groups[0].label === "Limiti");
  ok("row labels in it", !!itRow("Utenti"));
  ok("library words in it", itRow("Utenti").cells.ent.text === "Illimitati");
  ok("intervals in it", itRow("Ciclo di fatturazione").cells.ent.text === "Annuale");
  ok("localized cell VALUE in it", itRow("SLA").cells.ent.text === "99,9%");

  ok('"it-IT" matches an "it" entry', derivePlanViews(PLANS, { locale:"it-IT" })[0].tagline === "Scoprite il servizio");
  ok("unknown locale → defaultLocale (en)", derivePlanViews(PLANS, { locale:"de" })[0].tagline === "Get started");
  ok("defaultLocale override works",
     derivePlanViews(PLANS, { locale:"de", defaultLocale:"it" })[0].tagline === "Scoprite il servizio");
  ok("plain strings unaffected", derivePlanViews(PLANS, { locale:"it" })[1].name === "Pro");
  ok("partial messages keep English for the rest",
     deriveCompareTable(PLANS, COMPARE, { messages: { unlimited: "Illimitati" } })
       .sections[0].groups[0].rows.find(r=>r.label==="Billing cycle").cells.ent.text === "Yearly");

  const problems = validateBasket(PLANS, { plan: "pro", seats: { standard: 1 } });
  ok("English by default", describeBasketProblem(problems[0]).startsWith("At least 2 seats"),
     describeBasketProblem(problems[0]));
  ok("translatable with placeholders",
     describeBasketProblem(problems[0], { seatMinimum: "Servono almeno {min} posti (ne hai {got})" })
       === "Servono almeno 2 posti (ne hai 1)");
  const md = renderPlansMarkdown(derivePlanViews(PLANS, { currency:"eur", messages: IT }), { messages: IT });
  ok("markdown headers + cells localised", md.includes("Illimitati") && md.includes("Su misura"),
     md.split("\n")[0]);


});
