# billing-tools — agent orientation

**Purpose:** make any **Stripe + WorkOS** app ready to get paid. It packages API-key auth (WorkOS magic-auth → workspace + `sk_` key) and token/credit billing (Stripe) as MCP tools + a REST API + a CLI, with storage pluggable behind one adapter. WorkOS is assumed (the common auth substrate); a database is **not** — the app decides where workspaces/keys/billing-pointer live.

## Layout

```
src/
├── types.ts        BillingAdapter interface + BillingConfig + shared result types
├── auth.ts         authContext, runWithAuth, enforceAccess, enforceTokens   (engine)
├── billing.ts      Stripe math: balance/credit/deduct/checkout/auto-reload/invoices/ensureStripeCustomer
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

**v8 vs v10 of `@workos-inc/node`** — the org API-key methods moved: v8 `organizations.createOrganizationApiKey` / `validateApiKey` → v10 `apiKeys.createOrganizationApiKey` / `apiKeys.createValidation` (owner org on `.apiKey.owner.id`) / `apiKeys.deleteApiKey` (hard delete). The shipped `WorkOSOrgAdapter` targets **v8** (this package pins `^8`); a v10 consumer supplies its own adapter (scartoffie does). Org `externalId` + native `stripeCustomerId` are v10 fields.

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
