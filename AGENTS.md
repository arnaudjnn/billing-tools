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
- **Pattern B — WorkOS + DB mirror**: the app has its own row (e.g. a `ws_…` workspace) 1:1 with a WorkOS org via a `workos_org_id` column **and** `org.externalId = <local id>` (self-healing reverse map). `orgId` stays the local id; the adapter resolves `local id ↔ org` on every call. Memberships + invitations are WorkOS-native (org memberships + invitations, RBAC role slugs — no DB mirror tables), API keys are WorkOS org keys, and billing is the native `org.stripeCustomerId` + subscription state in org metadata. The DB keeps only what WorkOS can't hold (avatars, secondary emails, local prefs). Used by **scartoffie** (adapter implemented app-side, so the package stays free of a `pg` dependency).

**`@workos-inc/node` v10.** The shipped `WorkOSOrgAdapter` targets **v10** (the package depends on `^10.7.0`). Org API-key methods live on `apiKeys.*`: `createOrganizationApiKey` / `createValidation` (owner org on `.apiKey.owner.id`) / `listOrganizationApiKeys` (an `AutoPaginatable`) / `deleteApiKey` (hard delete). Org `externalId` + native `stripeCustomerId` are v10 fields. (Historical note: v8 kept these on `organizations.*` — irrelevant now, both consumers run v10.)

## SDK-first (how this lib stays light)

> **Prefer a direct SDK call, SDK type, SDK pagination helper, SDK idempotency, and SDK typed error over any hand-rolled equivalent.** Wrap the SDK only to (a) bind the storage seam (`BillingAdapter`), (b) add a genuinely-missing capability, or (c) map to the tool-result envelope — and when you wrap, wrap thin. Every deviation is a **documented exception** (listed below). This is what keeps the lib small and lets it evolve as `stripe` / `@workos-inc/node` evolve.

Concrete rules:
- **One memoized client per SDK.** `getWorkOS()` (`workos.ts`) and `getStripe()` (`billing.ts`) are the ONLY constructors — every module imports them. Never `new WorkOS(...)` / `new Stripe(...)` elsewhere, and never construct at import time (throws when the key is unset → breaks app boot; build lazily on first use).
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

## Mounting in a Next app

- **MCP** `app/[transport]/route.ts`: `createMcpTransport({ adapter, config })`.
- **REST** `app/api/v0/route.ts` + `app/api/v0/[tool]/route.ts`: `createToolListHandler({toolCosts})` / `createToolDispatchHandler()`.
- **Webhook** `app/api/stripe/webhook/route.ts`: `createStripeWebhookHandler()` (credits tokens on `checkout.session.completed`; raw body — exclude from any session middleware).
- Register tools once: `registerBillingTools(server, { adapter, toolCosts, config })`.

## CLI

`registerBillingCommands(program, { configDir: "~/.myapp", envPrefix: "MYAPP", defaultUrl })` adds `auth`, `keys list|revoke`, `balance`, `buy`, `invoices`. Config persists to `<configDir>/config.json` (chmod 600).

## Env

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (auth + WorkOS-org adapter), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing). `BillingConfig`: `{ freeTokens=100, currency, baseUrl, internalDomains: string[] }`. With `STRIPE_SECRET_KEY` unset, billing tools report "not configured"; metering (`enforceTokens`) is skipped when `cost === 0` or Stripe is unset or the org is internal.

## Build & release

Plain TS → `tsc` → `dist/` (**committed**, since consumers install via git dependency and import compiled JS). Release: bump `version`, `pnpm build`, commit `dist/`, tag `vX.Y.Z`, push; bump the tag in each consumer. Peer deps (`@modelcontextprotocol/sdk`, `zod`, `mcp-handler`) come from the host app.
