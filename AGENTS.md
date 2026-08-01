# billing-tools — agent orientation

**Purpose:** make any **Stripe + WorkOS** app ready to get paid. It packages API-key auth (WorkOS magic-auth → workspace + `sk_` key) and token/credit billing (Stripe) as MCP tools + a REST API + a CLI, with storage pluggable behind one adapter. WorkOS is assumed (the common auth substrate); a database is **not** — the app decides where workspaces/keys/billing-pointer live.

## Layout

```
src/
├── types.ts        BillingAdapter interface + BillingConfig + shared result types
├── auth.ts         authContext, runWithAuth, enforceAccess, enforceTokens   (engine)
├── billing.ts      Stripe math: balance/credit/deduct/checkout/auto-reload/invoices/ensureStripeCustomer + getStripe()
├── workos.ts       getWorkOS() — the one shared, lazily-memoized WorkOS client
├── magic-auth.ts   sendMagicAuth / verifyMagicAuth via @workos-inc/node
├── dispatch.ts     dispatchTool, getToolNames, ToolValidationError (REST bridge)
├── tools/          registerBillingTools(server, {adapter, toolCosts, config}) + keys + billing tools
├── routes/         Next route factories: rest (GET/POST), mcp (mcp-handler), webhook (Stripe)
├── cli/            registerBillingCommands(program, {configDir, envPrefix, defaultUrl})
├── adapters/workos-org.ts   WorkOSOrgAdapter — built-in store (WorkOS orgs + org API keys + org metadata)
└── util/clearout.ts         lookupCompany(domain) enrichment
```

## The adapter (the whole storage seam)

`orgId` is an opaque string (a WorkOS org id, a Postgres `ws_…`, whatever). Implement this and everything else is handled:

```ts
export interface BillingAdapter {
  validateApiKey(token): Promise<{ orgId: string } | null>;
  resolveOauthOrg?(token): Promise<string | null>;                 // optional (OAuth JWT path)
  getOrgDomains(orgId): Promise<string[]>;                         // internal-org unmetered check
  getBillingCustomerId(orgId): Promise<string | null>;
  setBillingCustomerId(orgId, customerId): Promise<void>;
  ensureOrgForUser(user): Promise<{ orgId: string }>;             // post-magic-auth
  mintApiKey(orgId, name): Promise<{ id: string; value: string }>;
  listApiKeys(orgId): Promise<Array<{ id; name; obfuscatedValue }>>;
  revokeApiKey(orgId, id): Promise<{ id; name } | null>;          // belongs-to check inside
}
```

**The rule: WorkOS is the source of truth.** `orgId` is always the app's own org handle; the adapter maps it to WorkOS internally. Two patterns, both keeping WorkOS canonical:

- **Pattern A — WorkOS-only** (shipped `WorkOSOrgAdapter`): `orgId` *is* the WorkOS org id. Orgs, org API keys (`sk_`), and `stripeCustomerId` live in WorkOS; no other storage. Import from `@arnaudjnn/billing-tools/adapters/workos-org`. Used by **gtm-tools**.
- **Pattern B — WorkOS + DB mirror**: the app has its own row (e.g. a `ws_…` workspace) 1:1 with a WorkOS org via a `workos_org_id` column **and** `org.externalId = <local id>` (self-healing reverse map). `orgId` stays the local id; the adapter resolves `local id ↔ org` on every call. Memberships + invitations are WorkOS-native (org memberships + invitations, RBAC role slugs — no DB mirror tables), API keys are WorkOS org keys, and billing is the native `org.stripeCustomerId` + subscription state in org metadata. The DB keeps only what WorkOS can't hold (avatars, secondary emails, local prefs). Used by **scartoffie**. The app supplies only WHERE the pointer lives — `createWorkOSOrgMirror({ readPointer, writePointer, reversePointer?, nameFor? })` returns the adapter's `map` plus `ensureOrg` / `renameOrg` / `deleteOrg` / `ensureMembership` / `membershipId`, so the reconcile-on-read, the idempotent `externalId` create and the reverse map are written once here rather than in every mirror app (the package stays free of a `pg` dependency because the two pointer functions are the whole seam).

**`@workos-inc/node` v10.** The shipped `WorkOSOrgAdapter` targets **v10** (the package depends on `^10.7.0`). Org API-key methods live on `apiKeys.*`: `createOrganizationApiKey` / `createValidation` (owner org on `.apiKey.owner.id`) / `listOrganizationApiKeys` (an `AutoPaginatable`) / `deleteApiKey` (hard delete). Org `externalId` + native `stripeCustomerId` are v10 fields. (Historical note: v8 kept these on `organizations.*` — irrelevant now, both consumers run v10.)

## SDK-first (how this lib stays light)

> **Prefer a direct SDK call, SDK type, SDK pagination helper, SDK idempotency, and SDK typed error over any hand-rolled equivalent.** Wrap the SDK only to (a) bind the storage seam (`BillingAdapter`), (b) add a genuinely-missing capability, or (c) map to the tool-result envelope — and when you wrap, wrap thin. Every deviation is a **documented exception** (listed below). This is what keeps the lib small and lets it evolve as `stripe` / `@workos-inc/node` evolve.

Concrete rules:
- **One memoized client per SDK.** `getWorkOS()` (`workos.ts`) and `getStripe()` (`billing.ts`) are the ONLY constructors — every module imports them. Never `new WorkOS(...)` / `new Stripe(...)` elsewhere, and never construct at import time (throws when the key is unset → breaks app boot; build lazily on first use). **Both are exported**, so this rule holds in consuming apps too: an app that needs a raw client imports `getWorkOS` / `getStripe` from the package rather than building a second one (a route handler doing `new WorkOS(...)` per request is a fresh client, and a fresh connection pool, reading the same key to do the same thing).
- **Pagination via the SDK.** Iterate: `for await (const x of stripe.x.list(...))` for Stripe; `(await workos.x.listY(...)).autoPagination()` for WorkOS. Never read `.data` (page 1 only) for a list that can exceed one page.
- **SDK types, not shadows.** Import `Stripe.*` and the WorkOS SDK types (`Invitation`, `Event`, `EventName`, `ApiKey`, …) instead of hand-copying a parallel interface that drifts. **Exception — the storage seam:** the DTOs in `types.ts` (`BillingAdapter`, `ApiKeyInfo`, `BillingUser`) are deliberately SDK-independent — that abstraction is exactly what lets a non-WorkOS adapter satisfy the interface, so keep them minimal and generic. SDK types live *inside* the WorkOS/Stripe modules, never leak into the seam.
- **SDK typed errors.** Catch `NotFoundException`, `ConflictException`, … (`instanceof`), not `e.status === 404` or string matching.
- **Idempotency on money.** Pass a stable Stripe idempotency key on every credit an event can replay (`creditTokens(..., idempotencyKey)`, the welcome bonus). Do **not** add one to `deductTokens` (each debit is a distinct charge) or to Checkout creation (it would block a legitimate repeat purchase within Stripe's 24h key window).

Deliberate exceptions (already SDK-first everywhere else — don't "fix" these):
- `WorkOSOrgAdapter.setSubscription` hand-merges org metadata: WorkOS's metadata update *replaces* the whole object and the SDK offers no partial-merge.
- `pollWorkOSEvents` walks pages by hand: `events.listEvents` returns a plain `List`, not an `AutoPaginatable`.
- **Event polling instead of webhooks** (`events.ts`): a product choice (zero webhook secret, zero dashboard).
- `invitations.accept` reimplements acceptance via `createOrganizationMembership` + `revokeInvitation`: WorkOS's own accept needs the invited user's session.
- `auth.ts:enforceAccess` emits the literal `"Unauthorized (401)"` string the REST/MCP route factories pattern-match downstream — a cross-layer wire contract.

## Agent auth — auth.md (`src/agent-auth/`)

`createAgentAuth({ adapter, config, branding, paths?, identityTypes?, baseUrl?, claimStore?, policy? })` returns framework-agnostic `(Request)=>Response` handlers implementing the [WorkOS auth.md](https://workos.com/auth-md) agent self-registration protocol: `authMd` (the narrative), `protectedResource` (RFC 9728 PRM), `authorizationServer` (RFC 8414 + `agent_auth` block), `identity` (`POST /agent/identity` — `anonymous` + `verified_email`), `claim`, `token`/`handleClaimGrant` (the `urn:workos:agent-auth:grant-type:claim` polling grant), `revoke` (RFC 7009), and `wwwAuthenticate(req)` (the `Bearer resource_metadata="…"` value). Everything flows through the **adapter + magic-auth + shared getWorkOS** — no direct WorkOS calls. Base URL derives from the request's forwarded host/proto by default (works behind any proxy) or an explicit override. `anonymous` needs `adapter.createAnonymousOrg` (WorkOSOrgAdapter ships it; mirror apps that need a workspace row should omit `anonymous` from `identityTypes`). Claim state is a pluggable `ClaimStore` (default `inMemoryClaimStore`, sha256-at-rest, 10-min TTL; inject Redis/DB for multi-instance). Mount the REST/MCP factories with `resourceMetadata` so every 401 advertises the PRM discovery doc. Humans keep using magic-auth + Checkout; this is the headless-agent path.

## Machine payments — MPP (`src/machine-payment/`)

The **payment** sibling of auth.md: Stripe's [MPP](https://mpp.dev) (Machine Payments Protocol) — a client hits a paid resource, gets **HTTP 402 + `WWW-Authenticate: Payment` challenge** + `application/problem+json`, pays (SPT card or crypto/USDC), retries with a credential, gets the resource + receipt. `createMachinePaymentHandler({ methods?, amount, currency?, networkId?, payToAddress?, settle?, onPaid? })` → `requirePayment(request)` returns a 402 `Response` or `{paid:true,…}`. `createPaymentMd(...)` serves `/payment.md` (the agent-facing how-to). **Settlement is pluggable + gated:** the 402 challenge + credential parsing are fully implemented + offline-testable, but the actual charge is injected via `settle` (provide it once the Stripe account is machine-payments-eligible — Stablecoins/Crypto approval, or a US entity for SPT). Without `settle`, the handler keeps 402-ing with a clean "settlement not enabled" note (never a 500). Validate the challenge shape with `mppx validate`; reference impl `github.com/stripe-samples/machine-payments`. Multi-method 402s combine into one comma-joined `WWW-Authenticate` header (Fetch Headers behavior) — the parseable source of truth is the `accepts[]` array in the JSON body; default to a single method for a clean header.

**Dunning / past_due** is reflected via the polled `customer.subscription.updated` **and** `invoice.payment_failed` events (→ `adapter.setSubscription("past_due")` + the `hooks.onPaymentFailed(orgId)` sync hook — use it to notify/gate the user). Stripe **Smart Retries** + the card-updater handle the actual retries (Dashboard config, no code).

**Self-serve billing:** `createBillingPortalSession(customerId, returnUrl)` + the `get_billing_portal` tool return a Stripe Billing Portal URL where customers manage their subscription (upgrade/downgrade/cancel), fix a failing card, and view invoices — the no-code self-serve surface. **Checkout offers wallets automatically:** `createTokenCheckoutSession` sets no `payment_method_types`, so Stripe surfaces every Dashboard-enabled method (cards + Apple Pay / Google Pay / Link).

## Mounting in a Next app

**One-call:** `createBilling({ adapter, config, plans?, toolCosts?, registerTools?, agentAuth?, webhook?, machinePayment? })` (`src/create-billing.ts`) returns `{ mcp, restList, restDispatch, webhook, agentAuth, machinePayment, paymentMd }` from a single module instance (shared AsyncLocalStorage). It's pure sugar over the factories below (all still exported); `registerTools` registers the app's own product tools alongside the billing tools, passing `agentAuth` auto-wires `resourceMetadata` onto the REST/MCP 401s, and passing `machinePayment` (a `MachinePaymentOptions`) returns the MPP `requirePayment` handler + a `/payment.md` handler (`paymentMd`, branded from `agentAuth.branding.productName`). Or wire the factories by hand:

- **MCP** `app/[transport]/route.ts`: `createMcpTransport({ adapter, config })`.
- **REST** `app/api/v0/route.ts` + `app/api/v0/[tool]/route.ts`: `createToolListHandler({toolCosts})` / `createToolDispatchHandler()`.
- **Webhook** `app/api/stripe/webhook/route.ts`: `createStripeWebhookHandler()` (credits tokens on `checkout.session.completed`; raw body — exclude from any session middleware).
- Register tools once: `registerBillingTools(server, { adapter, toolCosts, config })`.

## CLI

`registerBillingCommands(program, { configDir: "~/.myapp", envPrefix: "MYAPP", defaultUrl })` adds `auth`, `keys list|revoke`, `balance`, `buy`, `invoices`. Config persists to `<configDir>/config.json` (chmod 600).

## Env

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (auth + WorkOS-org adapter), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing). `BillingConfig`: `{ freeTokens=100, currency, baseUrl, internalDomains: string[] }`. With `STRIPE_SECRET_KEY` unset, billing tools report "not configured"; metering (`enforceTokens`) is skipped when `cost === 0` or Stripe is unset or the org is internal.

## Build & release

Plain TS → `tsc` → `dist/`. `dist/` is **built in CI and shipped only in the npm tarball** — no longer committed (it's gitignored; the git-dep era is over). Published to **npm as `@arnaudjnn/billing-tools`** (`npm install @arnaudjnn/billing-tools`). Peer deps (`@modelcontextprotocol/sdk`, `zod`, `mcp-handler`) come from the host app.

**Releases are fully automated** (semantic-release + npm Trusted Publishing / OIDC). Just push a [Conventional Commit](https://www.conventionalcommits.org) to `main`; the `Release` workflow computes the next version, publishes to npm (OIDC, automatic provenance), creates the GitHub Release + `vX.Y.Z` tag, and commits the version bump + `CHANGELOG.md` back to `main`:

```bash
git commit -m "fix: …"    # → patch  (0.14.0 → 0.14.1)
git commit -m "feat: …"   # → minor  (0.14.0 → 0.15.0)
git commit -m "feat!: …"  # → major  (0.14.0 → 1.0.0)   (or a `BREAKING CHANGE:` commit body)
git push                  # docs:/chore:/ci:/refactor: → no release
```

**Setup + gotchas:** an npm **Trusted Publisher** must exist (npmjs → package Settings → Trusted Publisher → GitHub Actions: org `arnaudjnn`, repo `billing-tools`, workflow `release.yml`). There is **no `NPM_TOKEN` secret** — CI authenticates via OIDC (`permissions: id-token: write`), which yields automatic provenance attestations. Because `@semantic-release/npm` can't do token-less OIDC yet, it runs with `npmPublish:false` and the real publish is an exec `prepareCmd` (runs in the *prepare* step, before the commit/tag, so npm and the git tag/Release can never desync).

Three non-obvious traps, all learned the hard way (each caused a full round of red runs):
1. **The publish must use npm ≥ 11.5.1, but `node_modules/.bin/npm` shadows it.** OIDC support landed in npm 11.5.1. `npx semantic-release` prepends `node_modules/.bin` to `PATH`, and `@semantic-release/npm` bundles its *own* older `npm` there — so a bare `npm publish` in the exec silently ran that old npm and got `ENEEDAUTH` (no OIDC). Fix: the exec `prepareCmd` is **`npx --yes npm@latest publish`**, which forces a modern npm regardless of the shadow. Upgrading the global npm in the workflow does **not** help — the shadow wins.
2. **Do NOT set `registry-url` in `setup-node`.** Its `.npmrc` writes an empty `_authToken`, so npm attempts (broken) token auth and skips OIDC entirely → publish 404s.
3. **GitHub Actions flakiness is not your bug.** Symptoms seen during setup: jobs stuck `queued` for 10+ min with `runner_name: null` (scheduler stall), and `"GitHub Actions has encountered an internal error"` mid-run — both transient GitHub-side, even while the status page reads "operational." Cancel + re-trigger (or `gh run rerun`). Publishing in *prepare* (trap 1's exec) makes these harmless: a killed job leaves no tag/Release to reconcile.
