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

Two reference adapters:
- **`WorkOSOrgAdapter`** (shipped) — orgs, org API keys (`sk_`), and `stripeCustomerId` in org metadata. Zero extra storage. Import from `@arnaudjnn/billing-tools/adapters/workos-org`.
- **Postgres** (implement in your app) — users stay in WorkOS; workspaces/`api_keys`/billing-pointer live in your DB. Keeps the package free of a `pg` dependency.

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
