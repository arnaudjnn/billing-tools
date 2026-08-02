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
