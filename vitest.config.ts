import { defineConfig } from "vitest/config";

// This library has no DOM and no server of its own, so there is one
// environment (node) and one kind of test: import a module, assert on what it
// returns. No jsdom, no browser, no Playwright — an end-to-end run for this
// package means real Stripe money movement, which is what
// `scripts/e2e-lifecycle.mjs` does against a test clock, deliberately, by hand.
//
// The suite is OFFLINE by design: no Stripe key, no WorkOS key, no network.
// That is why it can gate every push (.github/workflows/test.yml) — a library
// that moves money should never be publishable without its tests passing.
//
// Tests import from `../dist/*.js`, not `../src/*.ts`: they exercise the
// artifact that actually gets published, so a broken `files`/exports map or a
// tsc misconfiguration fails here rather than in a consuming app. Hence
// `npm test` builds first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
  },
});
