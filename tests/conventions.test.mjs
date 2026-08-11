// The rules that used to live only in AGENTS.md, as checks that can fail.
//
// Everything here is decidable by reading the repo, which is exactly why it
// belongs in a test rather than in a paragraph: prose goes stale silently, and
// each of these rules was written down because breaking it already cost
// something once.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

function sources(dir = join(ROOT, "src")) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

// Comments explain the rules below; without stripping them, every explanation
// reads as a violation of the thing it explains.
function code(path) {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const rel = (p) => p.slice(ROOT.length);

// ── One memoized client per SDK ──────────────────────────────────────
//
// getWorkOS() and getStripe() are the ONLY constructors, and both are
// exported so the rule survives into consuming apps. A route handler doing
// `new WorkOS(...)` per request is a fresh client and a fresh connection pool,
// reading the same key to do the same thing. Constructing at import time is
// the other half: it throws when the key is unset, which breaks app boot,
// so both build lazily on first use.
test("only workos.ts and billing.ts construct an SDK client", () => {
  const constructors = sources()
    .filter((path) => /new (WorkOS|Stripe)\(/.test(code(path)))
    .map(rel)
    .sort();
  assert.deepEqual(constructors, ["src/billing.ts", "src/workos.ts"]);
});

// ── SDK typed errors, not status sniffing ───────────────────────────
test("errors are caught by type, not by status code", () => {
  const offenders = [];
  for (const path of sources()) {
    for (const m of code(path).matchAll(/\.status\s*===\s*(\d{3})/g)) {
      offenders.push(`${rel(path)}: .status === ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ── The one cross-layer wire contract ───────────────────────────────
//
// auth.ts returns a tool RESULT (not a throw) whose text the REST factory
// pattern-matches to decide on a 401. Two files, no shared constant, no type
// — so reword the message and REST silently starts answering 200 with an
// error body. This asserts the two halves still agree.
test("the strings auth.ts emits are the ones rest.ts reads as a 401", () => {
  const emitted = [...code(join(ROOT, "src/auth.ts")).matchAll(/"(Unauthorized[^"]*)"/g)].map(
    (m) => m[1],
  );
  assert.ok(emitted.length > 0, "auth.ts no longer emits an Unauthorized message");

  const rest = code(join(ROOT, "src/routes/rest.ts"));
  const pattern = rest.match(/\/(\\b[^/]*Unauthorized[^/]*)\/i/);
  assert.ok(pattern, "rest.ts no longer pattern-matches an Unauthorized result");

  const matcher = new RegExp(pattern[1], "i");
  for (const message of emitted) {
    assert.ok(matcher.test(message), `rest.ts would not recognise: ${message}`);
  }
});

// ── Env ──────────────────────────────────────────────────────────────
//
// A library that reads an env var nobody documented is a support ticket
// waiting to happen: the consuming app has no way to know it exists.
test("every env var the library reads is documented in AGENTS.md", () => {
  const read = new Set();
  for (const path of sources()) {
    for (const m of code(path).matchAll(/process\.env\.([A-Z_]+)/g)) read.add(m[1]);
  }
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const undocumented = [...read].filter((name) => !agents.includes(name)).sort();
  assert.deepEqual(undocumented, []);
});

// ── Publish shape ────────────────────────────────────────────────────
//
// dist/ is gitignored and built in CI, so the tarball is the only place it
// exists. A `files` array that forgets it publishes an empty package — and
// npm will happily do that.
test("the npm tarball ships dist", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("dist"), "package.json files must include dist");
  assert.match(pkg.main, /^\.\/dist\//);
});

// ── Release traps ────────────────────────────────────────────────────
//
// Three settings, each of which produced a full round of red runs when it was
// wrong. They look removable to anyone who does not know the history, which is
// why they are asserted rather than only commented.
test("the release stays on the OIDC path", () => {
  const releaserc = readFileSync(join(ROOT, ".releaserc.json"), "utf8");
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

  // @semantic-release/npm cannot do token-less OIDC, so it must not publish;
  // the real publish is an exec in the *prepare* step, before the commit and
  // tag, so npm and the git tag can never desync.
  assert.match(releaserc, /"npmPublish":\s*false/);

  // OIDC needs npm >= 11.5.1, but `npx semantic-release` puts
  // node_modules/.bin first on PATH and @semantic-release/npm bundles an older
  // npm there. A bare `npm publish` silently runs that one and gets ENEEDAUTH.
  assert.match(releaserc, /npx --yes npm@latest publish/);

  // setup-node's registry-url writes an .npmrc with an empty _authToken, so
  // npm attempts broken token auth and skips OIDC entirely -> publish 404s.
  const setupNodeUsesRegistry = workflow
    .split("\n")
    .some((line) => /^\s*registry-url:/.test(line));
  assert.equal(setupNodeUsesRegistry, false, "registry-url disables OIDC");
});

// ── Leaf entry points stay leaves ────────────────────────────────────
//
// The root barrel re-exports 45 modules, so `import { planModel } from
// "@arnaudjnn/billing-tools"` in a Server Component pulls in commander, the MCP
// SDK, mcp-handler, authkit-nextjs, Stripe, WorkOS and eu-vat-rates-data to answer a
// question about a plain object. The leaf entries exist so that stops being the
// only way in.
//
// This walks the built graph rather than the sources, because that is what a
// bundler resolves — and it is asserted because the way a leaf stops being one is
// a single convenient re-export, which nothing else would notice.

// Every `from "..."` in the emitted JS, followed transitively through relative
// specifiers. Returns the set of BARE specifiers reached (the external packages).
function externals(entry) {
  const seen = new Set();
  const bare = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // A module specifier holds no whitespace and tsc always terminates the
    // statement, so requiring both is what keeps the word "from" inside a string
    // literal (there is one in pricing.ts) from reading as an import.
    const specifiers = [
      ...src.matchAll(/\bfrom\s*["']([^"'\s]+)["'];/g),
      ...src.matchAll(/^\s*import\s*["']([^"'\s]+)["'];/gm),
      ...src.matchAll(/\bimport\(\s*["']([^"'\s]+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (spec.startsWith(".")) walk(new URL(spec, `file://${file}`).pathname);
      // Strip any subpath: "stripe" and "@workos-inc/node/foo" both name a package.
      else bare.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  };
  walk(join(ROOT, "dist", entry));
  return bare;
}

test("the pure entries pull in no runtime dependency at all", () => {
  // `plan-model.ts`, `i18n.ts` and `types.ts` import nothing external, which is
  // what lets a config file, a docs generator and a pricing page read the
  // catalogue without a Stripe key in the environment.
  for (const entry of ["entries/plans.js", "pricing.js"]) {
    assert.deepEqual([...externals(entry)].sort(), [], `${entry} must stay pure`);
  }
});

test("each entry point reaches exactly the packages it needs", () => {
  // Pinned exactly, in both directions. A leaf that grows a dependency has stopped
  // being one; a leaf that LOSES one usually means an export moved to the root and
  // consumers now have to import from two places.
  //
  // Two notes on what is absent. `commander` appears nowhere — `cli/commands.ts`
  // describes the slice it needs as `CommandLike`, so the package does not depend on
  // commander at all, not even as a peer (see the dependency test below). And `pg`
  // appears nowhere
  // because there is no longer anything that could want it: the SQL and Redis
  // usage stores were removed once `stripeScopeUsageLedger` could answer the one
  // question they existed for — a window that is both INCLUDED and PER-MEMBER —
  // out of Stripe. This package touches no database at all.
  const expected = {
    "entries/plans.js": [],
    "pricing.js": [],
    "adapters/workos-org.js": ["@workos-inc/node"],
    "cli/index.js": ["node:fs", "node:os", "node:path"],
    "ui/authkit.js": ["@workos-inc/authkit-nextjs", "react"],
    "entries/agent-auth.js": ["@workos-inc/node", "eu-vat-rates-data", "node:crypto", "stripe"],
    "entries/routes.js": ["@modelcontextprotocol/sdk", "eu-vat-rates-data", "mcp-handler", "node:async_hooks", "stripe", "zod"],
    "entries/tools.js": ["@modelcontextprotocol/sdk", "@workos-inc/node", "eu-vat-rates-data", "node:async_hooks", "stripe", "zod"],
  };
  for (const [entry, packages] of Object.entries(expected)) {
    assert.deepEqual([...externals(entry)].sort(), packages, entry);
  }

  // And the root reaches everything, which is the point of splitting: importing a
  // plan helper from here loads the MCP SDK, mcp-handler, authkit and Stripe too.
  const root = externals("index.js");
  for (const heavy of [
    "@modelcontextprotocol/sdk",
    "@workos-inc/authkit-nextjs",
    "@workos-inc/node",
    "mcp-handler",
    "eu-vat-rates-data",
    "stripe",
  ]) {
    assert.ok(root.has(heavy), `root barrel unexpectedly no longer reaches ${heavy}`);
  }
});

test("the entry points resolve to files that exist", () => {
  // A typo in the exports map is invisible until a consumer imports the subpath,
  // and then it is an unhelpful ERR_MODULE_NOT_FOUND at their build time.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const [subpath, map] of Object.entries(pkg.exports)) {
    for (const target of new Set(Object.values(map))) {
      assert.ok(
        statSync(join(ROOT, target)).isFile(),
        `exports["${subpath}"] -> ${target} does not exist`,
      );
    }
  }
});

test("nothing compiled is reachable from no entry point", async () => {
  // A function can be written, tested, documented and SHIPPED, and still be
  // impossible to import. `defaultSeatOf` was: it sat in `dist/plan-request.js`
  // with the rest of that module — `nextUsageAsk`, `seatRank`, `nextSeatUp`,
  // `isSatisfied`, the queue writers — and no entry point named any of them. A
  // consumer that needed "which seat does an unassigned member draw" got
  // `TS2305: has no exported member`, and re-implemented the ordering rule in its
  // own UI. That is the failure mode this test exists for: not a missing feature,
  // a feature nobody can reach, which looks identical to the consumer and is far
  // more expensive, because their copy then disagrees with the meter.
  //
  // The rule is deliberately about RUNTIME names. Types are checked by tsc at the
  // consumer's build, and a few (`ToolErrorResult`, the adapter internals) are
  // genuinely implementation detail.
  // The React entries are out of scope, in both directions: they cannot be imported
  // here (they reach `next/cache`, which resolves only inside a Next build) and their
  // exports are components, whose reachability a consumer discovers the moment they
  // render one. Everything else — the whole engine — is in.
  const isReact = (p) => p.includes("/ui/");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const entries = new Set(
    Object.values(pkg.exports)
      .flatMap((map) => Object.values(map))
      .filter((t) => t.endsWith(".js") && !isReact(t)),
  );
  const reachable = new Set();
  for (const target of entries) {
    for (const name of Object.keys(await import(join(ROOT, target)))) reachable.add(name);
  }

  // Every `export declare function|const|class` in dist, minus the deliberate
  // exceptions. Test seams and per-registrar internals are the only ones.
  const EXEMPT = new Set([
    // Test seams: the suite reaches them by path, a consumer never should.
    "__setStripeForTests",
    "__setWorkOSForTests",
    "__setPlanPricesForTests",
    "__setVatValidatorForTests",
    // The five tool registrars. `registerBillingTools` composes them and is
    // exported; registering one group alone is not a supported arrangement.
    "registerKeyTools",
    "registerBillingOnlyTools",
    "registerManagementTools",
    "registerProfileTools",
    "registerSubscriptionTools",
    // Internal helpers that are exported only so a sibling module can use them.
    // Each is one half of something whose OTHER half is public, which is the test
    // for "internal": a consumer reaching for it has already been given the answer.
    "retrieveBillingCustomer", //   shared Stripe read behind the balance + controls
    "usageSinceWindows", //         the ledger walk behind `usageSummary`
    "meterIdFor", //                the meter id behind `stripeMeterUsageLedger`
    "reportUsageFault", //          the EMITTER; consumers subscribe via `onUsageFault`
    "webhookUrlFromArgv", //        argv parsing for `runBillingDoctor`
    "workosEnvironmentOf", //       ditto
    "environmentMismatch", //       ditto
  ]);

  const orphans = [];
  for (const file of sources(join(ROOT, "dist")).filter((f) => f.endsWith(".d.ts") && !isReact(f))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^export declare (?:async )?(?:function|const|class) (\w+)/gm)) {
      const name = m[1];
      if (EXEMPT.has(name) || reachable.has(name)) continue;
      orphans.push(`${name} (${file.slice(ROOT.length)})`);
    }
  }
  assert.deepEqual(orphans, [], "compiled but exported from no entry point");
});

// ── The CLI half of the parity rule ──────────────────────────────────────────
//
// REST and MCP get parity structurally, because `createDispatcher` captures every
// registered tool. The customer CLI is hand-written, so it is the one surface that
// can silently fall behind — and it did: the spend ceiling was settable from a
// billing screen and from nowhere else, tool included.
test("every structured refusal reason has a describeReason sentence", async () => {
  // The codes are wire format: a consumer's screens branch on them, and
  // `describeReason` is the one map from code to sentence. A reason added
  // tomorrow without a key would echo its own code at a customer — visible,
  // but not a sentence — so this fails by name the moment one is added.
  const { describeReason } = await import(
    new URL("../dist/i18n.js", import.meta.url).href
  );
  const MODULES = ["topup.ts", "members.ts", "plan-request.ts", "seats.ts", "billing.ts"];
  const codes = new Set();
  for (const file of MODULES) {
    // \breason does not match billing_reason (underscore is a word character),
    // so Stripe's own field never leaks into the set.
    for (const m of code(join(ROOT, "src", file)).matchAll(/\breason:\s*"([a-z_]+)"/g)) {
      codes.add(m[1]);
    }
    // Union-typed results name their codes once in the type, not per return site.
    for (const m of code(join(ROOT, "src", file)).matchAll(
      /\breason\??:\s*((?:"[a-z_]+"\s*\|\s*)+"[a-z_]+")/g,
    )) {
      for (const lit of m[1].matchAll(/"([a-z_]+)"/g)) codes.add(lit[1]);
    }
  }
  // PlanChangeError carries its code as a class field rather than a `reason:` literal.
  const sub = code(join(ROOT, "src/subscription.ts"));
  const union = sub.match(/PlanChangeErrorCode =([\s\S]*?);/);
  for (const lit of union[1].matchAll(/"([a-z_]+)"/g)) codes.add(lit[1]);

  assert.ok(codes.size >= 20, `expected the scan to find the codes, got ${codes.size}`);
  for (const reason of codes) {
    assert.notEqual(
      describeReason(reason),
      reason,
      `reason "${reason}" has no Messages key — add reason* to i18n.ts and REASON_KEYS`,
    );
  }
});

test("the CLI reaches every billing tool", async () => {
  const { BILLING_TOOL_NAMES } = await import("../dist/tools/register.js");
  // Comments stripped, so a tool merely NAMED in an explanation does not count as
  // reached. Every quoted name in the code: `buy` picks between two of them in a
  // ternary, so matching only `callTool(cfg, "x"` would miss half the wallet.
  const src = code(join(ROOT, "src/cli/commands.ts"));
  const referenced = new Set([...src.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

  const missing = BILLING_TOOL_NAMES.filter((n) => !referenced.has(n));
  assert.deepEqual(missing, []);

  // Coverage is per TOOL, not per command: `get_api_key` has no command of its own
  // because `auth` already performs that flow, and `preview_credit_purchase` is
  // `buy --quote`. Both are reached, neither is a verb a customer has to guess.
  assert.match(src, /"get_api_key"/);
  assert.match(src, /"preview_credit_purchase"/);
});

// ── The barrel is derived, not hand-listed ───────────────────────────────────
//
// `src/index.ts` used to re-list all 89 names of the pure half (the plan model,
// the storage seam, i18n) by hand. A hand-maintained list of names is a list that
// drifts — `list_plans` was registered and left out of `BILLING_TOOL_NAMES` for
// exactly that reason — so the root now re-exports the curated `/plans` leaf
// wholesale and only lists what the leaf does not cover (the Stripe-touching half).
//
// The hazard `export *` brings is the opposite of a missing name: TypeScript drops
// a name that two `export *`s both provide, silently. So this asserts the names the
// leaf is responsible for are actually reachable from the root, and that the two
// deliberate `Quantities` survive the collision between plan-model and checkout.
test("the root re-exports the pure leaf rather than re-listing it", async () => {
  const index = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  assert.match(index, /export \* from "\.\/entries\/plans\.js";/);

  const root = await import("../dist/index.js");
  const leaf = await import("../dist/entries/plans.js");

  // Every runtime name the leaf exports is reachable from the barrel.
  const missing = Object.keys(leaf).filter((n) => !(n in root));
  assert.deepEqual(missing, [], "export * dropped names the leaf provides");

  // A few load-bearing ones by name, so this fails loudly rather than by count if
  // the leaf itself is ever gutted.
  for (const name of ["definePlans", "planModel", "resolveConfig", "toolCapabilities"]) {
    assert.equal(typeof root[name], "function", `${name} must stay on the barrel`);
  }
});

test("both Quantities survive the plan-model / checkout name collision", () => {
  // plan-model and checkout each export a `Quantities`. The barrel keeps the
  // checkout one under its own name and the plan one aliased, and an explicit
  // export beats `export *` — which is the only reason this works at all.
  const d = readFileSync(join(ROOT, "dist/index.d.ts"), "utf8");
  assert.match(d, /Quantities as PlanQuantities/, "the plan-model alias is gone");
  assert.match(d, /\bQuantities\b[^}]*\} from "\.\/checkout\.js"/, "checkout's Quantities is gone");
});

// ── The dependency list, which is what every consumer installs ───────────────
//
// `commander` sat in `dependencies` while being imported as a TYPE only, so tsc
// erased it from the build and every consumer installed it anyway — to satisfy a
// type both consumers already had, from their own commander, since they are the ones
// constructing the program. It also pinned them to a major.
//
// It is now a `CommandLike` interface and a devDependency. This asserts it cannot
// come back, because the way it would is one convenient `import type`.
test("commander is not something a consumer has to install", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    assert.ok(
      !(pkg[field] ?? {})["commander"],
      `commander is in ${field}; it is a type-only shape (CommandLike), so nothing needs it at install time`,
    );
  }
  assert.ok(pkg.devDependencies?.commander, "keep it as a devDependency: the shape test typechecks against the real Command");

  // And the shape is real: `registerBillingCommands` still takes something a
  // commander program satisfies. Asserted here by USING it the way a consumer does.
  const { registerBillingCommands } = await import("../dist/cli/commands.js");
  const calls = [];
  const stub = {
    command(name) { calls.push(name); return stub; },
    description() { return stub; },
    option() { return stub; },
    action() { return stub; },
    opts() { return {}; },
  };
  registerBillingCommands(stub, { configDir: "~/.t", envPrefix: "T", defaultUrl: "https://t.local" });
  // The customer-facing verbs. Matched on the leading word, because a commander name
  // carries its argument syntax with it (`auth <email>`, `buy <amount>`).
  const verbs = new Set(calls.map((c) => c.split(" ")[0]));
  for (const verb of ["auth", "keys", "balance", "buy", "invoices", "plans", "spend"]) {
    assert.ok(verbs.has(verb), `\`${verb}\` was not registered (got: ${[...verbs].join(", ")})`);
  }
});

// ── The CLI is gated by the catalogue, like the tools ────────────────────────
//
// The tool surface is derived: a flat/pooled catalogue registers no seat or top-up
// tools. The CLI was not, so the same deployment shipped `seats`, `assign-seat` and
// five `topup` commands that called tools which had never been registered — they
// could only ever answer "Unknown tool", and a customer cannot tell that from
// holding it wrong. Measured on gtm-tools: 7 such commands.
test("the CLI registers the same groups the tools do", async () => {
  const { registerBillingCommands } = await import("../dist/cli/commands.js");

  const verbsFor = (plans) => {
    const names = [];
    const make = () => ({
      command(name) { names.push(name.split(" ")[0]); return make(); },
      description() { return this; },
      option() { return this; },
      action() { return this; },
      opts() { return {}; },
    });
    const root = make();
    registerBillingCommands(root, {
      configDir: "~/.t", envPrefix: "T", defaultUrl: "https://t.local", ...(plans ? { plans } : {}),
    });
    return new Set(names);
  };

  const FLAT = {
    pro: {
      sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } },
      cap: { kind: "pool", credits: 1000 },
      replenish: { purchase: {} },
      sale: "self_serve",
    },
  };
  const SEATS = {
    team: {
      sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 } } } },
      cap: { kind: "per_seat", perSeat: 1000 },
      replenish: { purchase: {}, request: {} },
      sale: "self_serve",
    },
  };

  const flat = verbsFor(FLAT);
  assert.ok(!flat.has("seats"), "a flat catalogue must not ship a `seats` command");
  assert.ok(!flat.has("assign-seat"), "…nor `assign-seat`");
  assert.ok(!flat.has("topup"), "…nor the top-up queue: `replenish.request` is unset");
  // One level down, where the group check cannot see: `plan request-seat` calls
  // `request_seat_change`, which registers only where a plan SELLS seats. It shipped
  // dead on a real flat deployment while every top-level group was correctly gated.
  assert.ok(!flat.has("request-seat"), "…nor `plan request-seat`: no plan sells a seat");
  assert.ok(flat.has("request"), "…but `plan request` stays: a plan change is the one rung a pooled catalogue has");
  // The gap this line was written for: the CLI shipped `quotes` on a catalogue whose REST
  // and MCP surfaces both hid it. Three surfaces, two answers, is worse than either.
  assert.ok(!flat.has("quotes"), "…nor `quotes`: nothing here is sold by conversation");
  // What it must still have: the wallet, the reads, and the lifecycle it does sell.
  for (const v of ["balance", "buy", "invoices", "usage", "plans", "plan", "spend", "cards"]) {
    assert.ok(flat.has(v), `\`${v}\` must survive gating (got: ${[...flat].sort().join(", ")})`);
  }

  const seats = verbsFor(SEATS);
  assert.ok(seats.has("seats") && seats.has("assign-seat") && seats.has("topup"),
    "a seat catalogue with `request` must ship all three");
  assert.ok(seats.has("request-seat"), "…and `plan request-seat`, because a bigger seat exists to ask for");
  assert.ok(!seats.has("quotes"), "…and still no `quotes`, because it sells no quote-only plan");

  // `seats` and `request` are independent capabilities, and the tools gate the five
  // top-up tools on `request` alone — so must the CLI, in both directions. The topup
  // group used to ride inside the seats gate, where the SEATS fixture (which has both)
  // could never notice: a flat plan with a per-seat cap and `request` registered the
  // tools and hid all five commands.
  const requestNoSeats = verbsFor({
    team: {
      sells: { kind: "flat", price: { monthly: 2000, yearly: 20000 } },
      cap: { kind: "per_seat", perSeat: 1000 },
      replenish: { purchase: {}, request: {} },
      sale: "self_serve",
    },
  });
  assert.ok(requestNoSeats.has("topup"), "`request` without `seats` still ships the top-up queue");
  assert.ok(!requestNoSeats.has("seats") && !requestNoSeats.has("assign-seat"),
    "…and no seat commands: nothing here sells one");

  const seatsNoRequest = verbsFor({
    team: { ...SEATS.team, replenish: { purchase: {} } },
  });
  assert.ok(seatsNoRequest.has("seats") && seatsNoRequest.has("assign-seat"),
    "`seats` without `request` keeps the seat commands");
  assert.ok(!seatsNoRequest.has("topup"),
    "…and no top-up queue: the plan takes no asks");

  // A catalogue WITH one gets it, so the gate is a gate and not a deletion.
  const quoted = verbsFor({
    ...FLAT,
    enterprise: { sells: { kind: "flat", price: { monthly: 0 } }, cap: { kind: "wallet" }, sale: "quote" },
  });
  assert.ok(quoted.has("quotes"), "a quote-only plan is what the command group is FOR");

  // Omitting the catalogue means "the caller did not say", never "nothing applies" —
  // the same rule registerBillingTools follows, so an existing consumer that passes
  // no plans keeps every command it had.
  const ungated = verbsFor(null);
  for (const v of ["seats", "assign-seat", "topup", "quotes", "plan", "plans"]) {
    assert.ok(ungated.has(v), `no catalogue must register everything, missing \`${v}\``);
  }
});

// ── A removed mode stays removed ─────────────────────────────────────────────
//
// `mode: "external"` took an injected calculator for a third-party provider and no
// adapter ever shipped — but the reason it went is that the SEAM could not reach one:
// it passed an address and expected a RATE, while every such provider takes a basket
// and returns an AMOUNT. An extension point that cannot reach the thing it exists for
// is a false statement about what the library supports.
//
// This asserts it does not come back by accident, and that nothing still POINTS at it —
// an error message offering an alternative that no longer exists sends someone looking.
test("the external tax mode is gone, and nothing advertises it", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e)) files.push(p);
    }
  };
  walk(join(ROOT, "src"));

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = f.replace(ROOT + "/", "");
    assert.ok(!/mode:\s*"external"/.test(src), `${rel} still references mode: "external"`);
    assert.ok(!/\bTaxCalculator\b/.test(src), `${rel} still references TaxCalculator`);
  }

  // And the boot refusal must not offer it as the way out.
  const types = readFileSync(join(ROOT, "src/types.ts"), "utf8");
  assert.ok(!types.includes('`mode: "external"`'), "the resolveConfig error still offers external");
});
