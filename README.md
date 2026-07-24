# billing-tools

**Make your Stripe + WorkOS app ready to get paid.**

Drop-in API-key auth (WorkOS) + token/credit billing (Stripe), exposed as **MCP tools**, a **REST API**, and a **CLI**. Storage-agnostic: use the built-in WorkOS-org store, or plug in your own (e.g. Postgres) via a small adapter.

It gives any app the "get money in" plumbing without rebuilding it each time:

- **Auth** — users authenticate with a WorkOS **magic-auth** code; each gets a workspace/org and an API key (`sk_…`) they pass as `Authorization: Bearer`.
- **Billing** — a Stripe customer per workspace, a token/credit balance (1 token = 1 cent), Checkout top-ups, auto-reload, and invoices.
- **Surfaces** — the same tools over MCP (`/mcp`), REST (`/api/v0`), and a CLI.

## Tools

| Tool | What it does |
|---|---|
| `get_api_key` | WorkOS magic-auth bootstrap → workspace + API key (shown once) |
| `list_api_keys` | List the workspace's keys (obfuscated) |
| `revoke_api_key` | Revoke a key by id (belongs-to checked) |
| `get_token_balance` | Current token balance + per-tool costs + auto-reload settings |
| `buy_tokens` | Stripe Checkout top-up (returns a payment URL) |
| `set_auto_reload` | Recharge the balance automatically below a threshold |
| `list_invoices` | Recent invoices + auto-reload charges |

## Install (git dependency, pinned by tag)

```jsonc
// package.json
"dependencies": {
  "@arnaudjnn/billing-tools": "github:arnaudjnn/billing-tools#v0.1.0"
}
```

The package ships compiled `dist/`, so no build step or `transpilePackages` is needed in the consumer.

## Quick start (Next.js)

```ts
import { registerBillingTools } from "@arnaudjnn/billing-tools";
import { WorkOSOrgAdapter } from "@arnaudjnn/billing-tools/adapters/workos-org";

const adapter = new WorkOSOrgAdapter();          // WorkOS orgs + org API keys + org metadata
const config = { freeTokens: 100, currency: "usd", baseUrl: process.env.APP_URL!, internalDomains: [] };

// MCP: registerBillingTools(server, { adapter, toolCosts, config })
// REST/webhook: mount the route factories from "@arnaudjnn/billing-tools" (see AGENTS.md)
```

**WorkOS is always the source of truth.** Two adapter patterns (see `AGENTS.md`): **Pattern A — WorkOS-only** (`WorkOSOrgAdapter`, above — `orgId` is the WorkOS org id, zero extra storage); **Pattern B — WorkOS + DB mirror** (your app row is 1:1 with a WorkOS org via a `workos_org_id` column + `org.externalId`; memberships/invitations/keys/billing stay in WorkOS, the DB mirrors only what WorkOS can't hold). Note: the shipped adapter targets `@workos-inc/node` v8; v10 moved the org API-key methods (`organizations.*` → `apiKeys.*`), so a v10 consumer writes its own adapter.

See **AGENTS.md** for the full integration guide (adapter interface, route factories, CLI, env, release flow).
