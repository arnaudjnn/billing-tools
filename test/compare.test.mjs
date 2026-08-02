import assert from "node:assert/strict";
import { test } from "vitest";

const ok = (label, cond, extra = "") => assert.ok(cond, `${label}${extra ? " — " + extra : ""}`);

test('the comparison table derives from the same config', async () => {
  const { deriveCompareTable, defineCompare, definePlans } =
    await import(new URL("../dist/pricing.js", import.meta.url).href);
  let fail = 0; const ok=(l,c,e="")=>{console.log(`  ${c?"✓":"✗"} ${l}${e?"  — "+e:""}`);if(!c)fail++;};

  const PLANS = definePlans({
    hobby: { sells:{kind:"nothing"}, cap:{kind:"pool",credits:1000}, limits:{members:1}, sale:"free",
             display:{name:"Hobby",order:1} },
    pro: { sells:{kind:"seats",minSeats:2,maxSeats:100,seatTypes:{
             standard:{price:{monthly:2104,yearly:21600},includedCredits:1000,min:1,display:{label:"Posto Standard"}},
             premium:{price:{monthly:10523,yearly:108000},includedCredits:5000,display:{label:"Posto Premium"}},
             api:{price:{monthly:52615,yearly:540000},includedCredits:25000,shared:true,max:1,display:{label:"API"}}}},
           grant:{kind:"none"}, cap:{kind:"per_seat"}, limits:{members:100}, sale:"self_serve",
           display:{name:"Pro",order:2,featured:true} },
    enterprise: { sells:{kind:"flat",price:{monthly:0,yearly:500000},intervals:["yearly"]}, grant:{kind:"none"},
                  cap:{kind:"pool",credits:1000000}, limits:{members:null}, sale:"quote",
                  display:{name:"Enterprise",order:3} },
  });

  const COMPARE = defineCompare([
    { title: "Ricerca", description: "Cosa potete cercare.", icon: "search", groups: [
      { label: "Ricerca", rows: [
        { label: "Ricerca full-text", in: ["hobby","pro","enterprise"] },
        { label: "Filtri avanzati", in: ["pro","enterprise"] },
        { label: "Esportazioni in blocco", in: ["enterprise"] },
        { label: "Ciclo di fatturazione", from: "intervals" },
      ]},
      { label: "Limiti", rows: [
        { label: "Utenti inclusi", from: "members" },
        { label: "Richieste incluse", from: "included" },
        { label: "Tipi di posto", from: "seatTypes" },
        { label: "SLA", values: { enterprise: "99,9%" }, hint: "Su contratto" },
      ]},
    ]},
  ]);

  const t = deriveCompareTable(PLANS, COMPARE, {
    currency: "eur", locale: "it-IT",
    labels: { unlimited: "Illimitati", monthly: "Mensile", yearly: "Annuale" },
  });
  const rows = t.sections[0].groups.flatMap(g => g.rows);
  const cell = (label, plan) => rows.find(r => r.label === label).cells[plan];

  ok("ordered + named from config", t.columns.map(c=>c.key).join(",") === "hobby,pro,enterprise");
  ok("featured flag carried", t.columns.find(c=>c.key==="pro").featured === true);

  ok('in: all → ✓ everywhere', ["hobby","pro","enterprise"].every(p => cell("Ricerca full-text",p).kind==="yes"));
  ok('in: subset → ✓ / ✗', cell("Filtri avanzati","hobby").kind==="no" && cell("Filtri avanzati","pro").kind==="yes");
  ok('in: one → only that plan', cell("Esportazioni in blocco","enterprise").kind==="yes" && cell("Esportazioni in blocco","pro").kind==="no");

  ok("members: 1 / 100 / unlimited",
     cell("Utenti inclusi","hobby").text==="1" && cell("Utenti inclusi","pro").text==="100" &&
     cell("Utenti inclusi","enterprise").text==="Illimitati",
     [cell("Utenti inclusi","hobby").text, cell("Utenti inclusi","pro").text, cell("Utenti inclusi","enterprise").text].join(" / "));
  ok("included: the real pool/pack sizes",
     cell("Richieste incluse","hobby").text==="1000" && cell("Richieste incluse","enterprise").text==="1.000.000",
     [cell("Richieste incluse","hobby").text, cell("Richieste incluse","pro").text, cell("Richieste incluse","enterprise").text].join(" / "));
  ok("seatTypes: card rows only (shared API seat excluded)",
     cell("Tipi di posto","pro").text==="Posto Standard, Posto Premium", cell("Tipi di posto","pro").text);
  ok("intervals: annual-only Enterprise says so",
     cell("Ciclo di fatturazione","enterprise").text==="Annuale" &&
     cell("Ciclo di fatturazione","pro").text==="Mensile, Annuale",
     `ent=${cell("Ciclo di fatturazione","enterprise").text} pro=${cell("Ciclo di fatturazione","pro").text}`);

  ok("text only where given", cell("SLA","enterprise").text==="99,9%" && cell("SLA","hobby").kind==="no");
  ok("hint carried", rows.find(r=>r.label==="SLA").hint === "Su contratto");
  ok("section meta carried", t.sections[0].icon==="search" && t.sections[0].description==="Cosa potete cercare.");
  ok("sub-group titles kept", t.sections[0].groups.map(g=>g.label).join(",")==="Ricerca,Limiti");


});
