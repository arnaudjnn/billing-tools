---
name: billing-tools
description: Add drop-in auth and billing to a Stripe + WorkOS app with the @arnaudjnn/billing-tools library (Next.js, Hono, Bun, Deno, any Node host). Use this skill whenever the user wants to monetize an app, MCP server, or API, charge per token or per credit, add subscriptions or API-key auth, let AI agents self-register with auth.md and pay per request with Stripe MPP machine payments, or wire a token wallet, Stripe Checkout, auto-reload, a Customer Portal, invoices, seat limits, or per-seat token grants, and expose it all as MCP tools, a REST API, or a CLI. Covers the pluggable WorkOS-org adapter (WorkOS-only or WorkOS plus a DB mirror), declarative plans auto-provisioned in Stripe, and a zero-webhook event-polling sync. Triggers on "add billing", "monetize my agent or tools or API", "Stripe and WorkOS", "charge per token", "agent auth.md", "machine payments", or "MPP", even when the library is not named.
license: MIT
metadata:
  homepage: https://github.com/arnaudjnn/billing-tools
---

# Billing Tools

`@arnaudjnn/billing-tools` is the get-paid engine for Stripe + WorkOS apps, for humans **and** AI agents. It packages API-key auth (WorkOS), token/credit + subscription billing (Stripe), agent self-registration ([auth.md](https://workos.com/auth-md)), and machine payments ([MPP](https://mpp.dev/)) behind one storage-pluggable engine, exposed as MCP tools, a REST API, and a CLI. Use it instead of rebuilding billing plumbing in every app.

## When to use this skill

Reach for it when the user wants to charge for an app / MCP server / API, add per-token or per-credit metering, sell subscriptions, add API-key auth, let agents register and pay without a human, or stand up a token wallet + Checkout + invoices on a Stripe + WorkOS stack.

## Prerequisites

- Node 18+, plus env: `STRIPE_SECRET_KEY`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (and `STRIPE_WEBHOOK_SECRET` if mounting the webhook).
- Install as a Git dependency, pinned by commit SHA (ships compiled `dist/`, so no build step or `transpilePackages` in the consumer):
  ```jsonc
  "dependencies": { "@arnaudjnn/billing-tools": "github:arnaudjnn/billing-tools#<commit-sha>" }
  ```

## Core wiring (one composition root)

Build **one** adapter + config and reuse it everywhere, so `runWithAuth` and the tools share a single AsyncLocalStorage instance:

```ts
import {
  registerBillingTools, createDispatcher, resolveConfig,
  createToolListHandler, createToolDispatchHandler,
  createMcpTransport, createStripeWebhookHandler,
} from "@arnaudjnn/billing-tools";
import { WorkOSOrgAdapter } from "@arnaudjnn/billing-tools/adapters/workos-org";

export const adapter = new WorkOSOrgAdapter();            // WorkOS = source of truth
const config = resolveConfig({ currency: "usd", baseUrl: process.env.APP_URL! });
const register = (server: any) => registerBillingTools(server, { adapter, config });
const dispatcher = createDispatcher(register);

export const mcp          = createMcpTransport({ register, adapter });   // app/[transport]/route.ts
export const toolList     = createToolListHandler({ dispatcher });       // app/api/v0/route.ts
export const toolDispatch = createToolDispatchHandler({ dispatcher });   // app/api/v0/[tool]/route.ts
export const webhook      = createStripeWebhookHandler();                // app/api/stripe/webhook/route.ts
```

Route files stay thin: `export const GET = mcp.GET`, etc. All handlers are Web-standard `Request` to `Response`, so they mount in Next.js, Hono, Bun, Deno, or Cloudflare Workers.

## Adapter patterns

- **Pattern A (WorkOS-only):** `new WorkOSOrgAdapter()`. `orgId` is the WorkOS org id. No extra storage.
- **Pattern B (WorkOS + DB mirror):** pass a `map` so `orgId` stays your own id (e.g. `ws_…`) while the adapter resolves it to a WorkOS org per call. API keys + the Stripe pointer stay in WorkOS.

## Agent auth (auth.md)

Let agents self-register (no human signup):

```ts
import { createAgentAuth } from "@arnaudjnn/billing-tools";
export const agentAuth = createAgentAuth({
  adapter, config,
  branding: { productName: "Acme", logoUri: "https://acme.com/logo.svg" },
  identityTypes: ["anonymous", "verified_email"],
});
```

Mount `/auth.md`, `/.well-known/oauth-{protected-resource,authorization-server}`, `/agent/identity`, `/agent/identity/claim`, `/oauth/token`, `/oauth/revoke`, and pass `resourceMetadata: agentAuth.resourceMetadataUrl` to the REST/MCP factories so every 401 advertises discovery.

## Machine payments (MPP)

Charge agents per request:

```ts
import { createMachinePaymentHandler } from "@arnaudjnn/billing-tools";
const pay = createMachinePaymentHandler({ methods: ["stripe"], amount: 50, currency: "usd" });
const gate = await pay.requirePayment(request);
if (gate instanceof Response) return gate; // 402 + WWW-Authenticate: Payment
```

The 402 challenge ships ready; live settlement is injected via a `settle` function once the Stripe account is machine-payments-eligible.

## Subscriptions, plans, and sync

- Declare plans in code; `registerBillingTools({ plans, defaultPlan })` auto-provisions Stripe products/prices via `lookup_key` (zero dashboard).
- Reconcile Stripe + WorkOS with `createBillingSync(...)` (event polling, no webhooks); run it in-process with `sync.start()` or as a serverless cron with `createSyncRoute()`.
- Self-serve: the `get_billing_portal` tool + `createBillingPortalSession()` return a Stripe Billing Portal URL.

## Tools exposed

`get_api_key`, `list_api_keys`, `revoke_api_key`, `get_token_balance`, `buy_tokens`, `set_auto_reload`, `get_billing_portal`, `list_invoices`, `view_invoice`, `download_invoice`, `list_plans`.

## Reference

- Full integration guide (adapter interface, route factories, CLI, env, SDK-first doctrine): [AGENTS.md](https://github.com/arnaudjnn/billing-tools/blob/main/AGENTS.md)
- Overview + features: [README](https://github.com/arnaudjnn/billing-tools)
