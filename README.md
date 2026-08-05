<p align="center">
  <img src="https://raw.githubusercontent.com/arnaudjnn/billing-tools/main/assets/hero.svg" alt="Billing Tools, the get-paid engine for Stripe + WorkOS apps, for humans and AI agents" width="100%">
</p>

<p align="center">
  <b>Drop-in auth + billing for any Stripe&nbsp;+&nbsp;WorkOS app, usable by humans <i>and</i> AI agents,</b><br/>
  exposed as <b>MCP tools</b>, a <b>REST API</b>, and a <b>CLI</b>, over one storage-agnostic engine.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@arnaudjnn/billing-tools"><img alt="npm version" src="https://img.shields.io/npm/v/@arnaudjnn/billing-tools?color=635BFF&label=npm"></a>
  <a href="https://www.npmjs.com/package/@arnaudjnn/billing-tools"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@arnaudjnn/billing-tools?color=8A8A9A"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-635BFF.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg">
  <img alt="Stripe" src="https://img.shields.io/badge/Stripe-635BFF.svg">
  <img alt="WorkOS" src="https://img.shields.io/badge/WorkOS-000000.svg">
  <img alt="MCP compatible" src="https://img.shields.io/badge/MCP-compatible-16a34a.svg">
  <img alt="Framework agnostic" src="https://img.shields.io/badge/framework-agnostic-8A8A9A.svg">
  <a href="https://github.com/arnaudjnn/billing-tools/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/arnaudjnn/billing-tools/actions/workflows/test.yml/badge.svg"></a>
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

---

**Billing Tools** packages the "get money in" plumbing you'd otherwise rebuild in every SaaS: API-key auth on top of **WorkOS**, credit + subscription billing on top of **Stripe**, and (because the next wave of customers is autonomous) first-class **agent** rails: [`auth.md`](https://workos.com/auth-md) self-registration and [`MPP`](https://mpp.dev/) machine payments. Wire it once; serve humans through a browser and agents through headless HTTP with the same engine. Storage is pluggable behind one small adapter (use the built-in WorkOS store, or mirror into your own Postgres).

## Table of contents

- [Ship tools, not billing plumbing](#ship-tools-not-billing-plumbing)
- [Key Features](#key-features)
- [Getting Started](#getting-started)
- [From sandbox to production](#from-sandbox-to-production)
- [Pricing examples](#pricing-examples)
- [How it works](#how-it-works)
- [Agent auth (auth.md)](#agent-auth-authmd)
- [Machine payments (MPP)](#machine-payments-mpp)
- [MCP OAuth proxy (dynamic clients)](#mcp-oauth-proxy-dynamic-clients)
- [CLI](#cli)
- [Configuration](#configuration)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Ship tools, not billing plumbing

The next generation of software is **agents**, and an agent is only as useful as the **tools** it can call. Tools *are* the product now.

But you don't go to war naked. Ship a tool into the wild with no auth and no way to get paid, and you're just donating GPU time to strangers. Someone still has to meter every call, hold a balance, bill the workspace, enforce seats, and cut off the freeloaders: the boring, identical, get-it-wrong-once-and-bleed-money layer that *every* AI product rebuilds from scratch.

**Billing Tools is the armor.** Bring a Stripe + WorkOS stack and you inherit, out of the box, the exact monetization model the frontier labs run on. The same shape as **Anthropic, OpenAI, and xAI (Grok)**:

- 💰 **A price per credit:** every tool call costs credits, metered and deducted automatically.
- 🏢 **Workspaces:** the billable account, with one Stripe customer + balance each.
- 👥 **Users per workspace:** seats, invitations, and roles.
- 🪙 **Credits per user:** per-seat grants, seat limits, and auto-reload.

So you do the one thing only you can do (**build great tools**) and monetize them the same afternoon. The get-paid layer is already handled, battle-tested, and agent-ready. 🛡️

## Key Features

### 🔐 Auth & identity
- 🔑 **API-key auth:** WorkOS organization API keys (`Authorization: Bearer sk_…`), validated on every request.
- ✉️ **Passwordless magic-auth:** email a 6-digit code, get back a workspace/org + API key. No passwords.
- 🤖 **auth.md agent self-registration:** the [WorkOS auth.md](https://workos.com/auth-md) protocol (RFC 9728 Protected-Resource-Metadata + RFC 8414 Authorization-Server-Metadata + `/agent/identity` anonymous or verified-email + the claim ceremony), so agents onboard with **no human signup**.
- ♻️ **RFC 7009 revocation:** revoke a key by value; always-200, no token-existence leak.
- 🎫 **Optional OAuth-JWT hook:** bring your own MCP OAuth proxy via a single adapter method.

### 💳 Billing & payments
- 🪙 **Usage-metered credit wallet:** held in the native Stripe customer credit balance (1 credit = 1¢), with idempotent credit/debit.
- 🛒 **Checkout top-ups:** Stripe Checkout that auto-offers cards **+ Apple&nbsp;Pay / Google&nbsp;Pay / Link**.
- 📦 **Declarative subscription plans:** describe plans in code; products/prices are **auto-provisioned in Stripe** via `lookup_key` (immutable-price safe, orphan-cleaning). Zero dashboard clicks.
- 🎟️ **Per-seat / per-cycle credit grants + seat limits:** included credits scale with active members.
- 🔁 **Auto-reload:** off-session saved-card recharge when the balance drops below a threshold.
- 🧾 **Invoices + 🏛️ Customer Portal:** list invoices, and a one-call Stripe Billing Portal URL for self-serve upgrade/downgrade/cancel + card updates.
- 🔒 **Idempotency on every money move:** welcome bonus, checkout credit, and per-cycle grants each carry a stable key, so retries/replays never double-charge.

### 🤖 Built for AI agents
- 📄 **auth.md:** the [agent onboarding standard](https://workos.com/auth-md), served for you (`/auth.md` narrative + discovery metadata).
- 🏧 **MPP machine payments:** Stripe's [Machine Payments Protocol](https://mpp.dev/): a HTTP **402 + `WWW-Authenticate: Payment`** challenge for pay-per-request (SPT card or crypto/USDC), the payment sibling of auth.md's 401.
- 🧰 **MCP server tools:** `get_api_key`, `get_credit_balance`, `buy_credits`, `list_plans`, `get_billing_portal`, and more, drop straight into Claude, Cursor, or any MCP client.
- 🧭 **Discovery hints:** every 401/402 advertises `resource_metadata`, so an agent can bootstrap unattended.

### 🧩 Three surfaces, one engine
- 🛠️ **MCP:** `createMcpTransport({ register, adapter })`.
- 🌐 **REST:** `createToolListHandler` + `createToolDispatchHandler` (429/401/400/404 mapping built in).
- ⌨️ **CLI:** `registerBillingCommands(program, …)` gives you `auth`, `keys`, `balance`, `buy`, `invoices`.
- 🪝 **Stripe webhook:** `createStripeWebhookHandler()` for instant checkout crediting.

### 🧾 Tax, calculated here
- 🇪🇺 **VAT/GST from code:** `sales-tax` + VIES work the rate out and it's applied as an explicit Stripe TaxRate — no per-transaction fee, no Dashboard.
- 1️⃣ **One line, every charge:** `tax: { origin: "IT" }` in your config and the seat checkout, the top-up and the auto-reload invoice all carry the right rate. Reverse charge for cross-border EU B2B included.
- 🔁 **Live re-tax:** `updateCheckoutSessionTaxRates` recalculates an open session when the customer types a different country.
- ☑️ **Stripe Tax is opt-in:** `tax: { mode: "stripe" }` when you want it. Nothing infers it — with no active registration it computes 0% silently.

### 🧑‍💻 Set up an environment with one command
- 🏠 **Local payments, no tunnel:** `npx billing-tools dev` downloads the Stripe CLI if needed, forwards webhooks to localhost (no `stripe login`), and writes the session's signing secret into `.env.local`.
- 🩺 **`npx billing-tools doctor`:** audits the environment your `STRIPE_SECRET_KEY` points at, exit-code and all, for the misconfigurations that produce no error.
- 🚀 **`setupBilling({ config, plans, webhookUrl })`:** provisions the few things that can't be lazy (webhook endpoint + its once-only secret, tax registrations) and then runs the doctor. Idempotent — safe on every deploy.

### 🔄 Zero-webhook sync
- 📡 **Event polling:** reconcile Stripe **and** WorkOS via their Events APIs. No webhook endpoints, no signing secrets.
- ⏱️ **Any scheduler:** run it in-process with `sync.start()` (persistent hosts) or as a serverless cron via `createSyncRoute()`.
- 🪞 **Generic DB mirror:** shadow WorkOS orgs/users into your own tables (`createMirror`), driver-agnostic.
- 📉 **Dunning hook:** `invoice.payment_failed` flips the org to `past_due` and fires an `onPaymentFailed` hook (Stripe Smart Retries do the retries).

### 🌍 Framework and platform agnostic
- ⚡ **Web-standard handlers:** everything returns `Request` to `Response`; mount in Next.js, Hono, Bun, Deno, or Cloudflare Workers.
- 🧱 **No framework imports:** runtime deps are just `stripe` + `@workos-inc/node`.
- 🗄️ **No database, at all:** usage — including per-member included allowances — is counted in Stripe. No `pg`, no Redis, no table to migrate.
- 🔌 **Pluggable storage adapter:** WorkOS-only, or WorkOS + your DB mirror, behind one interface.
- ☁️ **No lock-in:** runs on any Node host (Railway / Render / Fly / Vercel / self-host).

### 📈 Scale, stated plainly

Counting usage in Stripe means the limit is Stripe's **rate** limits, not a table's
size. Live, Stripe allows 100 req/s globally and **25 req/s per endpoint** — and
every usage window is read through the same endpoint (`listEventSummaries`), so
that endpoint is what binds.

Measured against a real account (`scripts/load-metering.mjs`, which counts the HTTP
requests the SDK actually sends), per metered call on a per-seat plan with a
caller-scoped limit:

| caller | uncached | with `cachedUsageLedger` |
|---|---|---|
| member | 3.95 requests | 1.95 |
| API key | 1.30 | 1.00 |

Which puts sustained metering in the region of **15–20 calls/second for the whole
account**, all customers combined — idle users cost nothing, since the limits are
per account rather than per customer. Comfortable for most SaaS; a ceiling you
would hit building high-volume metering, and worth knowing before you adopt this
rather than after.

Three things keep it there, and all are on by default except the first:
`cachedUsageLedger(ledger, { ttlMs })` (opt-in — a cached window is a stale window,
and the gate reads through it), a plan's windows over one caller answered in a
single bucketed read, and `UsageQuery.sources` skipping the leg that cannot
contribute. If you outgrow it, the levers are asking Stripe to raise the account
limit, or bringing your own `ledger` — the seam is unchanged.

### ⚖️ What this deliberately does not do

Worth knowing before you adopt it, rather than after.

- **No per-action audit trail.** Usage is counted, not logged: a total can say a
  member spent 412 credits this cycle, never *which* calls made it up. That is the
  price of having no database. If you owe customers an itemised breakdown —
  enterprise contracts often do — bring your own `ledger`; the seam is unchanged
  and takes a store alongside.
- **Counting degrades, it does not stop the product.** A read that cannot be
  answered serves the last known value (or 0), and a write that cannot be delivered
  is retried and then dropped. Both report through `onUsageFault` — **wire it**, or
  your only signal is one line on stderr.
- **The wallet read fails closed.** If the customer's balance cannot be read the
  metered call is refused, because a stale balance would let someone spend what
  they do not have. Usage windows degrade; money does not.
- **Versioning is semantic and moves fast.** Releases are automated from
  Conventional Commits, so anything that changes a signature or a default lands as
  a major — several have. Pin a major range and read the changelog; the majors are
  honest, not cosmetic.

### 🏛️ Design doctrine
- 📐 **SDK-first:** thin-wraps the Stripe & WorkOS SDKs (SDK types, pagination, typed errors, idempotency) so the lib evolves *with* the platforms instead of drifting.
- 🎯 **One memoized client per SDK:** lazy, never constructed at import.
- 🔒 **Secure by default:** AES-256-GCM session encryption at rest, SHA-256-hashed claim tokens, verified-domain-only internal-org checks.
- 🧪 **Offline-testable:** the auth.md + MPP protocol surfaces are pure `Request` to `Response`, unit-testable without a live account.

## Getting Started

Five steps to a workspace that can be billed, and the last two are one command each.

### Prerequisites
- **Node 18+**
- A **Stripe** secret key — test mode is fine, and it decides which environment everything below reads and writes
- A **WorkOS** API key + client id

### Install

```bash
npm install @arnaudjnn/billing-tools
# peers (provide the ones you use): @modelcontextprotocol/sdk mcp-handler zod
```

Ships compiled `dist/`, so there's no build step or `transpilePackages` needed in the consumer.

### 1. Declare what you sell

The catalogue is the input everything else is derived from: Stripe products and prices, which tools get registered, what each plan includes, and every pricing surface. Nothing here is a Dashboard click.

```ts
// plans.ts
import { definePlans } from "@arnaudjnn/billing-tools/plans";

export const PLANS = definePlans({
  hobby: {
    sells: { kind: "flat", price: { monthly: 1000, yearly: 10000 } },   // cents
    grant: { kind: "none" },                    // included allowance is COUNTED, not credited
    cap: { kind: "pool", credits: 1_000, onExhausted: "wallet" },
    replenish: { purchase: { packs: [500, 2_000] }, autoReload: { threshold: 200, reloadTo: 2_000 } },
    sale: "self_serve",                          // required, never inferred
  },
});
```

`grant` vs `cap` is the one distinction worth reading twice: a Stripe credit balance auto-applies to the next invoice, so crediting a plan's *own* included allowance discounts its own renewal. Include it as a `cap`; credit only what a customer buys. `checkPlansConfig` fails a plan that does both.

### 2. Environment

Four to set. The library reads no others.

```bash
STRIPE_SECRET_KEY=sk_test_…
WORKOS_API_KEY=sk_…
WORKOS_CLIENT_ID=client_…
REFRESH_TOKEN_SECRET=…                 # only if you mount the MCP OAuth proxy (`openssl rand -hex 32`)
```

Plus two you don't type by hand, and one optional:

```bash
STRIPE_WEBHOOK_SECRET=whsec_…          # written by `npx billing-tools dev` locally; printed once by `billing setup` in a deployed env
BILLING_WEBHOOK_URL=https://…          # where THIS environment's endpoint lives, read by the doctor
INTERNAL_ORG_DOMAINS=acme.com          # optional: orgs with these verified domains are unmetered
```

**Both keys must name the same environment.** A live Stripe key beside a staging WorkOS key charges real cards against orgs and `sk_` keys in the wrong environment, and writes the mapping between them where nobody is looking. The doctor errors on it — when the WorkOS key states its environment (older `sk_test_`/`sk_live_` keys do; newer `sk_<key id>` ones carry no marker, so it stays silent rather than guessing).

### 3. Wire it up (one call)

`createBilling()` composes every surface from a single config — one module instance, so `runWithAuth` in the routes and `enforceAccess` inside the tools share one AsyncLocalStorage.

```ts
// billing.ts
import { createBilling } from "@arnaudjnn/billing-tools";
import { WorkOSOrgAdapter } from "@arnaudjnn/billing-tools/adapters/workos-org";
import { PLANS } from "./plans";

const billing = createBilling({
  adapter: new WorkOSOrgAdapter(),                        // WorkOS is the source of truth
  config: { currency: "usd", baseUrl: process.env.APP_URL!, tax: { origin: "US", mode: "stripe" } },
  plans: PLANS,
  registerTools: (server) => registerMyProductTools(server),   // your own tools, alongside the billing ones
  agentAuth: { branding: { productName: "Acme" } },      // enables auth.md (optional)
  mcp: { requireAuth: true },                             // gate the MCP handshake, not just the tool calls
});

export const { mcp, restList, restDispatch, webhook, agentAuth, meter, api } = billing;
export const BILLING_CLI = billing.cli;                   // for step 5
```

Prefer fine-grained control? Every factory is exported individually (`registerBillingTools`, `createMcpTransport`, `createToolListHandler`, `createToolDispatchHandler`, `createStripeWebhookHandler`, `createAgentAuth`, …) so you can build your own composition root — but note that the composition is **where five decisions live** (webhook idempotency, subscription mirroring, the 402/401/429 mapping, handshake gating, which ledger counts), so hand-wiring means re-deciding each one.

### 4. Mount the routes

Every route file is a re-export.

```ts
// app/[transport]/route.ts        →  export const { GET, POST } = mcp
// app/api/v0/route.ts             →  export const GET = restList
// app/api/v0/[tool]/route.ts      →  export const POST = restDispatch
// app/api/stripe/webhook/route.ts →  export const POST = webhook      // raw body: keep it out of session middleware
```

Pass `onOtherEvent: createStripeEventHandler({ adapter, plans })` to `webhook` unless you run the [event poller](#-zero-webhook-sync). Without one of the two, nothing mirrors `customer.subscription.*` onto the org, so `resolvePlan` reads `null` for ever and **no subscriber is given the allowance they paid for**.

### 5. One command for the environment

`plans` and `config` are TypeScript values, so this is a script the app owns rather than a bin subcommand — but it holds no facts of its own.

```ts
// scripts/billing.ts
import { runBillingCli } from "@arnaudjnn/billing-tools";
import { BILLING_CLI } from "../billing";

runBillingCli(BILLING_CLI);   // call it; it exits the process itself
```

```json
{ "scripts": { "billing": "tsx --env-file-if-exists=.env.local scripts/billing.ts" } }
```

| | |
|---|---|
| `pnpm billing` | audit, read-only. The default, because the default must be the verb that cannot change anything |
| `pnpm billing setup` | provision, then audit. Idempotent, safe on every deploy |
| `--no-webhook` | there is no endpoint here, by design (correct on a laptop) |
| `--url <url>` / `--prune` | check a different endpoint / delete duplicates on the same URL |

`billing.cli` carries the catalogue, the config, the wired ledger's coverage, whether a checkout is mounted and whether the OAuth proxy is — read off the composition, not restated. A script that declares its own ledger coverage can be right while the app is wrong, which is how a wallet-only ledger once counted pooled usage as 0 and gave every subscriber unlimited requests with every check passing.

### Local webhooks

No tunnel, no `stripe login`, no registered endpoint:

```bash
npx billing-tools dev     # fetches the Stripe CLI if needed, forwards to localhost,
                          # and writes the session's whsec_ into .env.local
```

The dotenv write is the point: `stripe listen` mints a new secret per session and your dev server is a different process, so a file is the only channel both see.

### First call

```bash
curl https://your-app.com/api/v0                          # tools + costs
curl -X POST https://your-app.com/api/v0/get_credit_balance \
  -H "Authorization: Bearer sk_…"
```

Add agent onboarding with [`createAgentAuth`](#agent-auth-authmd) and pay-per-call with [`createMachinePaymentHandler`](#machine-payments-mpp).

## From sandbox to production

**Nothing is copied between environments.** The same catalogue evaluated against a different key produces equivalent objects — which is why a key swap is *almost* the whole story, and why anything you clicked together by hand in a Dashboard is not.

That is the test: **did code create it, or did you click it?**

### Creates itself, from the keys alone

| | On what trigger |
|---|---|
| Stripe products + prices | first checkout, or `billing setup` |
| Usage meter | first metered call |
| Payment-method configuration (card + Apple Pay + Google Pay) | first payment form |
| Stripe TaxRate objects | first taxed charge |
| Stripe customers | first billed request per org |
| WorkOS orgs, memberships, `sk_` API keys | per customer, on demand |
| WorkOS roles you declared in `workos: { roles }` | `billing setup` |

### Needs you, once per environment

| | Why it cannot be automatic |
|---|---|
| **`STRIPE_WEBHOOK_SECRET`** | Stripe returns it once, at creation. No request can put it in your env store, so you cannot set it in advance — `billing setup` creates the endpoint and prints the secret |
| **AuthKit redirect URI** | WorkOS exposes no API for it in v10 (its only writable `redirect_uris` belong to a Connect application, a different object). `pnpm billing` prints the exact string to allowlist |
| **AuthKit appearance/settings** | same: Dashboard only |
| **Stripe Tax registrations** | only a human knows where the business collects. Skipped unless `config.tax.mode` is `"stripe"` |

`admin` and `member` ship with a WorkOS environment, so there is nothing to do there — `ensureWorkOSRoles` has no default list and creates only roles you name.

### The deploy

```bash
# 1. set the four env vars (live Stripe key + prod WorkOS key)
pnpm billing setup          # → prints STRIPE_WEBHOOK_SECRET=… ONCE
# 2. paste it into Vercel/Railway, redeploy
# 3. allowlist the redirect URI the report printed
pnpm billing                # exits non-zero: gate the pipeline on it
```

Run `setup` by hand, not from a build step — the signing secret would print into a build log nobody reads, and Stripe never shows it again. Because everything else provisions lazily, a broken config otherwise surfaces on a customer's first request; `pnpm billing` in the pipeline is what moves that into the deploy.

## Pricing examples

Five independent axes, so a catalogue describes a product rather than picking from a
menu. Only `sells` is a union — it alone decides which fields are required and what
Stripe objects get minted.

| axis | values | decides |
|---|---|---|
| `sells` | `nothing` \| `seats` \| `flat` | what Stripe charges for |
| `grant` | `none` \| `purchased_seats` \| `per_member` \| `fixed` | what is CREDITED as money on `invoice.paid` |
| `cap` | `wallet` \| `per_seat` \| `pool` | what is INCLUDED, as a counted window |
| `replenish` | `{purchase?, autoReload?, request?}` | how to get more |
| `sale` | `free` \| `self_serve` \| `quote` \| `legacy` | whether it can be bought. Required, never inferred |

Every example below is typechecked against the published types in CI.

### Flat subscription + one org-wide pool

The shape for a product sold by volume rather than by seat — an API, an agent
platform. One pool for the whole workspace; overage draws the prepaid wallet so a
long run never stops halfway.

**The arithmetic that makes a tier worth buying:** top-ups are fixed at **1 credit per
cent** (`$1 = 100 credits`), so included credits have to cost *less* than that, and
less at each step, or a customer who does the division has no reason to subscribe —
let alone upgrade.

```ts
export const PLANS = definePlans({
  starter: {
    sells: { kind: "flat", price: { monthly: 3_000, yearly: 30_000 } },  // $30 → 0.75¢/credit, 25% off
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 4_000, onExhausted: "wallet" },
    replenish: { purchase: { packs: [1_000, 5_000] } },
    sale: "self_serve",
  },
  pro: {
    sells: { kind: "flat", price: { monthly: 9_000, yearly: 90_000 } },  // $90 → 0.60¢/credit, 40% off
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 15_000, onExhausted: "wallet" },
    replenish: {
      purchase: { packs: [5_000, 20_000] },
      autoReload: { threshold: 2_000, reloadTo: 15_000, enabledByDefault: true },
    },
    sale: "self_serve",
    display: { name: "Pro", featured: true, badge: "Most popular" },
  },
});
```

No `limits.members` means unlimited — a seat was never what this product sells, and a
ceiling on people only pushes a team onto one shared key.

### Per-seat packs, with a top-up queue

Each member draws their own included pack, and a member who runs out can ask the owner
for more instead of being blocked. `cap: per_seat` is the only shape that needs a
per-member counter, so it also needs a ledger that can count one — see
[Scale](#-scale-stated-plainly).

```ts
export const PLANS = definePlans({
  team: {
    sells: {
      kind: "seats",
      seatTypes: {
        standard: { price: { monthly: 2_000, yearly: 20_000 }, credits: 1_000 },
        premium: { price: { monthly: 9_000, yearly: 90_000 }, credits: 5_000 },
      },
    },
    grant: { kind: "none" },
    cap: { kind: "per_seat", onExhausted: "block" },   // a committed pack's overage is a renegotiation
    replenish: { request: {} },                         // request_top_up → approve_top_up
    sale: "self_serve",
  },
});
```

`onExhausted: "block"` refuses even when the wallet could pay. `"wallet"` falls through
instead, so a top-up funds the overage.

### Pure pay-as-you-go, no subscription

No plan to be on: a wallet, and credits bought as needed. `cap: wallet` includes
nothing, so every call is funded by the balance.

```ts
export const PLANS = definePlans({
  payg: {
    sells: { kind: "nothing" },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    replenish: { purchase: { packs: [1_000, 5_000, 20_000] }, autoReload: { threshold: 500, reloadTo: 5_000 } },
    sale: "free",
  },
});
```

`checkPlansConfig` warns if you advertise `cap: wallet` without any `replenish` — a
plan that promises pay-as-you-go and cannot take the money.

### Free → self-serve → quote-only, with a rate limit

`sale` is what makes a plan buyable, and `quote` keeps Enterprise off the self-serve
path — an agent holding a workspace key cannot subscribe an org to it at its
placeholder amount. `limits.rate` is a sixth axis and NOT the same as `cap`: a cap is
the commercial ceiling over the billing cycle, a rate limit is the pace, and a month's
allowance spent in one afternoon sits inside the cap.

```ts
export const PLANS = definePlans({
  free: {
    sells: { kind: "nothing" },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 200 },
    limits: { rate: [{ every: "day", credits: 50 }] },
    sale: "free",
  },
  growth: {
    sells: { kind: "flat", price: { monthly: 4_900, yearly: 49_000 } },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 10_000, onExhausted: "wallet" },
    replenish: { purchase: {} },
    limits: { rate: [{ every: "hour", credits: 600, callerKind: "api" }] },
    sale: "self_serve",
  },
  enterprise: {
    sells: { kind: "flat", price: { monthly: 100_000, yearly: 1_000_000 } },
    grant: { kind: "none" },
    cap: { kind: "pool", credits: 250_000, onExhausted: "wallet" },
    sale: "quote",     // listed, not buyable
  },
});
```

Rate limits fund nothing and never fall through to the wallet — a limit a top-up could
lift is not a limit. The refusal is its own reason (`rate_limit_reached`) and carries
`retryAt`, because it is the one refusal that fixes itself.

### What a catalogue decides for you

The catalogue is not just prices. **The tool surface and the CLI surface are derived
from it**, so a shape that cannot happen is not advertised:

| | flat + pool | seats + per_seat + `request` |
|---|---|---|
| tools registered | **26** | **33** (adds seats + top-ups) |
| CLI commands | no `seats` / `topup` | all groups |

That is the point of deriving rather than listing: an agent cannot tell a tool that
always fails from one it is holding wrong, and a customer cannot tell a dead command
from a mistake. Pass `plans` to `registerBillingCommands` to gate the CLI the same way.

### Buying one

`change_plan` is the single entry point for up, down and off. On a first purchase there
is no subscription to prorate, so it opens a Checkout Session — **hosted** for the tool
(a URL any caller can open), **elements** for your own UI (a client secret you mount).
Same session either way: same tax, same payment-method configuration.

```ts
await changePlan(adapter, orgId, { plans: PLANS, to: { plan: "pro" }, config, uiMode: "hosted" });
```

Quote it first with `previewPlanChange(adapter, orgId, { plans, to, proration })` — it
shares `desiredPrices` and `diffItems` with `changePlan`, so the quoted number is the
charged number. Pass it the same `proration` you will pass to `changePlan`, or you are
quoting a different policy from the one you apply. (It takes no `config`: it only reads,
so it never needs to create a customer.)

## How it works

**WorkOS is always the source of truth.** Your app's `orgId` is opaque: implement the adapter and everything (auth, metering, Stripe math, all surfaces) works unchanged. Two shipped patterns:

| Pattern | What `orgId` maps to | Storage | Use when |
|---|---|---|---|
| **A: WorkOS-only** | the WorkOS org id | none beyond WorkOS | you don't have (or need) your own DB rows |
| **B: WorkOS + DB mirror** | your own id (e.g. `ws_…`) | a `workos_org_id` column + `org.externalId`, 1:1 | you keep local rows and mirror WorkOS into them |

In both, API keys are WorkOS org keys and the Stripe pointer lives on the org. The `WorkOSOrgAdapter` (`@arnaudjnn/billing-tools/adapters/workos-org`) implements both; pass a `map` for Pattern B.

## Agent auth (auth.md)

Implements the [WorkOS auth.md](https://workos.com/auth-md) spec.

```ts
import { createAgentAuth } from "@arnaudjnn/billing-tools";

export const agentAuth = createAgentAuth({
  adapter, config,
  branding: { productName: "Acme", logoUri: "https://acme.com/logo.svg" },
  identityTypes: ["anonymous", "verified_email"],
});
// mount: /auth.md, /.well-known/oauth-{protected-resource,authorization-server},
//        /agent/identity, /agent/identity/claim, /oauth/token, /oauth/revoke
```

An agent hits a 401, follows the `resource_metadata` hint to your metadata, reads `/auth.md`, then registers (either **anonymously** for an instant key, or via a **verified-email** claim ceremony where the user reads back a code) and starts calling tools. All handlers are `Request` to `Response`.

## Machine payments (MPP)

Implements Stripe's [Machine Payments Protocol](https://mpp.dev/).

```ts
import { createMachinePaymentHandler } from "@arnaudjnn/billing-tools";

const pay = createMachinePaymentHandler({ methods: ["stripe"], amount: 50, currency: "usd" });
const gate = await pay.requirePayment(request);
if (gate instanceof Response) return gate;   // 402 + WWW-Authenticate: Payment challenge
// else settlement succeeded, serve the paid resource
```

The 402 challenge + credential parsing ship ready and are offline-testable. Actual settlement (card via shared payment tokens, or crypto/USDC) is injected via a `settle` function once your Stripe account is enabled for machine payments; until then the gate returns a clean "settlement not enabled" 402 (never a crash). `createPaymentMd()` serves an agent-facing `/payment.md`.

## MCP OAuth proxy (dynamic clients)

MCP clients like Claude Desktop and Claude.ai can't be handed an API key — they
register themselves (RFC 7591) and expect an OAuth 2.1 authorization-code flow.
`oauthProxy` gives you that on top of WorkOS AuthKit, in one option:

```ts
const billing = createBilling({
  adapter, config,
  agentAuth: { branding: { productName: "Acme" } },
  oauthProxy: true,          // needs REFRESH_TOKEN_SECRET
});

// app/oauth/authorize/route.ts   export const GET  = billing.oauth!.authorize
// app/oauth/register/route.ts    export const POST = billing.oauth!.register
// app/oauth/callback/route.ts    export const GET  = billing.oauth!.callback
// app/oauth/token/route.ts       export const POST = billing.oauth!.token
```

The user authenticates with AuthKit; the client receives the WorkOS access token
plus an HS256 refresh token that wraps the WorkOS one and is bound to the
`client_id` that obtained it. PKCE (S256) is enforced whenever the client sends a
challenge, authorization codes are single-use, and the `/oauth/token` route also
serves the auth.md claim grant so one route covers both flows.

Enabling it also makes discovery honest: `authorization_endpoint` and
`registration_endpoint` appear in `/.well-known/oauth-authorization-server` only
when the proxy is on, and `authorization_code`/`refresh_token` join
`grant_types_supported`. Consumers without the proxy no longer advertise an
`/oauth/authorize` they don't implement.

**`REFRESH_TOKEN_SECRET` is required and has no fallback.** Falling back to
`WORKOS_CLIENT_ID` — a public identifier — would let anyone who knows it forge a
30-day refresh token. Without the secret the token endpoint returns
`server_error` rather than signing with something guessable.

## CLI

```ts
import { registerBillingCommands } from "@arnaudjnn/billing-tools";
import { Command } from "commander";

const program = new Command();
registerBillingCommands(program, {
  configDir: "~/.acme",
  envPrefix: "ACME",
  defaultUrl: "https://acme.com",
  // Gates the commands by the catalogue, exactly as the TOOLS are gated: a flat/pooled
  // plan ships no `seats` or `topup` commands, which would otherwise call tools that
  // were never registered and could only answer "Unknown tool". Omit to register all.
  plans: PLANS,
});
// acme auth | keys | balance | buy | invoices | usage | plans | plan | spend | cards | …
```

Every command hits the same REST endpoint an agent would, so the CLI can never do more
or less than the API. `commander` is yours, not a dependency of this package — the
parameter is typed structurally (`CommandLike`).

## Configuration

`BillingConfig` (pass to `resolveConfig`):

| Field | Default | Purpose |
|---|---|---|
| `baseUrl` | required | Checkout success/cancel + portal return URLs |
| `currency` | `"usd"` | Stripe currency |
| `freeCredits` | `100` | Welcome credit on first customer creation |
| `internalDomains` | `[]` | Orgs with these **verified** WorkOS domains are unmetered (see `internalDomainsFromEnv`) |
| `tax.origin` | unset | Where you're established (`"IT"`). Decides domestic vs cross-border, which is the whole question a VAT rate turns on. Unset falls back to the Stripe account's country — `mode: "none"` is how you opt out of tax entirely |
| `tax.mode` | derived | `"local"` \| `"stripe"` \| `"none"`. Overrides what `origin` implies |

## Roadmap

- 🪙 x402 machine-payment protocol alongside [MPP](https://mpp.dev/)

## Contributing

Issues and PRs welcome. The engine is plain TypeScript compiled with `tsc`; `dist/` is gitignored and built in CI, so it exists only in the published npm tarball. See `AGENTS.md` for the architecture, the adapter interface, the SDK-first doctrine, and the release flow.

## License

[MIT](LICENSE) © Arnaud Jeannin
