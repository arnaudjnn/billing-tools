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
  // imports `Command` as a TYPE, which tsc erases, so the customer CLI never cost
  // a runtime dependency even from the root barrel. And `pg` appears nowhere
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

// ── The CLI half of the parity rule ──────────────────────────────────────────
//
// REST and MCP get parity structurally, because `createDispatcher` captures every
// registered tool. The customer CLI is hand-written, so it is the one surface that
// can silently fall behind — and it did: the spend ceiling was settable from a
// billing screen and from nowhere else, tool included.
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
