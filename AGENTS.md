# billing-tools — agent orientation

**Purpose:** make any **Stripe + WorkOS** app ready to get paid. It packages API-key auth (WorkOS magic-auth → workspace + `sk_` key) and credit billing (Stripe) as MCP tools + a REST API + a CLI, with storage pluggable behind one adapter. WorkOS is assumed (the common auth substrate); a database is **not** — the app decides where workspaces/keys/billing-pointer live.

**Keep this file light.** It records rules and the reason each one exists. It is not a changelog: `git log` holds the history, and a post-mortem written here outlives the code it describes. If you fix something, fix it — do not park it here as a note.

## Layout

```
src/
├── types.ts        BillingAdapter interface + BillingConfig + shared result types
├── auth.ts         authContext, runWithAuth, enforceAccess, enforceCredits  (engine)
├── billing.ts      Stripe math: balance/credit/deduct/checkout/auto-reload/invoices/ensureStripeCustomer + getStripe()
├── workos.ts       getWorkOS() — the one shared, lazily-memoized WorkOS client
├── magic-auth.ts   sendMagicAuth / verifyMagicAuth via @workos-inc/node
├── dispatch.ts     dispatchTool, getToolNames, ToolValidationError (REST bridge)
├── tools/          registerBillingTools(server, {adapter, toolCosts, config}) + keys + billing tools
├── routes/         Next route factories: rest (GET/POST), mcp (mcp-handler), webhook (Stripe)
├── cli/            registerBillingCommands(program, {configDir, envPrefix, defaultUrl})
├── adapters/workos-org.ts   WorkOSOrgAdapter — WorkOS orgs + org API keys + org metadata
└── util/clearout.ts         lookupCompany(domain) enrichment — OPT-IN, see below
```

## The adapter (the whole storage seam)

`orgId` is an opaque string (a WorkOS org id, a Postgres `ws_…`, whatever). Implement this and everything else is handled:

```ts
export interface BillingAdapter {
  validateApiKey(token): Promise<{ orgId: string; keyId?: string } | null>;
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

**The rule: WorkOS is the source of truth.** `orgId` is always the app's own org handle; the adapter maps it to WorkOS internally. Two patterns:

- **Pattern A — WorkOS-only** (shipped `WorkOSOrgAdapter`, used by **gtm-tools**): `orgId` *is* the WorkOS org id. An app whose identity provider mints JWTs attaches `resolveOauthOrg` to the adapter (`Object.assign(new WorkOSOrgAdapter(…), { resolveOauthOrg })`) rather than verifying them in a route body — that member is where the MCP transport looks, so wiring it there is what lets the transport own the gate. Verification stays in the consumer: it needs a JWT library, and this package has no business growing one for one provider. Orgs, org API keys and `stripeCustomerId` live in WorkOS; no other storage. Import from `@arnaudjnn/billing-tools/adapters/workos-org`.
- **Pattern B — WorkOS + DB mirror** (used by **scartoffie**): the app has its own row 1:1 with a WorkOS org via a `workos_org_id` column **and** `org.externalId = <local id>` (self-healing reverse map). `orgId` stays the local id. Memberships, invitations and RBAC role slugs are WorkOS-native (no mirror tables), API keys are WorkOS org keys, billing is native `org.stripeCustomerId` + subscription state in org metadata. The DB keeps only what WorkOS can't hold (avatars, secondary emails, local prefs). The app supplies only WHERE the pointer lives: `createWorkOSOrgMirror({ readPointer, writePointer, reversePointer?, nameFor? })` returns the adapter's `map` plus `ensureOrg` / `renameOrg` / `deleteOrg` / `ensureMembership` / `membershipId`, so the reconcile-on-read, the idempotent `externalId` create and the reverse map are written once here. Those two pointer functions are the whole seam, which is why the package needs no `pg`.

**Company enrichment is opt-in.** `ensureOrgForUser` names an auto-created org after the new user's email domain. Pass `enrichOrg` to resolve a nicer name — `new WorkOSOrgAdapter({ enrichOrg: lookupCompany })` calls `api.clearout.io`, or supply your own resolver. Without it an org is named `acme.com` rather than `Acme`. **It must stay opt-in:** unconditionally, it forwarded every deployment's customer email domains to an unrelated third party on the workspace-creation path, with no env var to notice it by. `lookupCompany` carries a 3s `AbortSignal.timeout`, because it sits on the signup path and "never throws" does not cover "never returns".

**`@workos-inc/node` v10.** Org API-key methods live on `apiKeys.*`: `createOrganizationApiKey` / `createValidation` (owner org on `.apiKey.owner.id`) / `listOrganizationApiKeys` (an `AutoPaginatable`) / `deleteApiKey` (hard delete). Org `externalId` and native `stripeCustomerId` are v10 fields.

## SDK-first (how this lib stays light)

> **Prefer a direct SDK call, SDK type, SDK pagination helper, SDK idempotency and SDK typed error over any hand-rolled equivalent.** Wrap the SDK only to (a) bind the storage seam, (b) add a genuinely-missing capability, or (c) map to the tool-result envelope — and wrap thin. Every deviation is a documented exception, listed below.

- **One memoized client per SDK.** `getWorkOS()` and `getStripe()` are the ONLY constructors. Never `new WorkOS(...)` / `new Stripe(...)` elsewhere, and never construct at import time (it throws when the key is unset, breaking app boot — build lazily on first use). Both are **exported**, so a consuming app that needs a raw client imports them rather than building a second one: a route handler doing `new WorkOS(...)` per request is a fresh client and a fresh connection pool reading the same key to do the same thing.
- **Pagination via the SDK.** `for await (const x of stripe.x.list(...))`; `(await workos.x.listY(...)).autoPagination()`. Never read `.data` for a list that can exceed one page.
- **SDK types, not shadows.** Import `Stripe.*` and the WorkOS types (`Invitation`, `Event`, `EventName`, `ApiKey`, …) rather than hand-copying a parallel interface that drifts. **Exception — the storage seam:** the DTOs in `types.ts` (`BillingAdapter`, `ApiKeyInfo`, `BillingUser`) are deliberately SDK-independent, since that abstraction is what lets a non-WorkOS adapter satisfy the interface. SDK types live *inside* the WorkOS/Stripe modules and never leak into the seam.
- **SDK typed errors.** Catch `NotFoundException`, `ConflictException`, … with `instanceof`, not `e.status === 404` or string matching.
- **Idempotency on money.** Pass a stable Stripe idempotency key on every credit an event can replay (`grantCredits(..., idempotencyKey)`, the welcome bonus). Do **not** add one to `deductCredits` (each debit is a distinct charge) or to Checkout creation (it would block a legitimate repeat purchase inside Stripe's 24h key window).

Deliberate exceptions — don't "fix" these:

- `WorkOSOrgAdapter.setSubscription` hand-merges org metadata: WorkOS's update *replaces* the whole object and the SDK offers no partial merge.
- `pollWorkOSEvents` walks pages by hand: `events.listEvents` returns a plain `List`, not an `AutoPaginatable`.
- **Event polling instead of webhooks** (`events.ts`): a product choice — zero webhook secret, zero dashboard.
- `invitations.accept` reimplements acceptance via `createOrganizationMembership` + `revokeInvitation`: WorkOS's own accept needs the invited user's session.
- `auth.ts:enforceAccess` emits the literal `"Unauthorized (401)"` string the REST/MCP route factories pattern-match downstream — a cross-layer wire contract.

## The tool surface, and the parity rule

**The rule: anything the app's own UI can do, an API / CLI / MCP caller can do too.** When adding a capability, register the tool in the same change — a function reachable only from a React component is the failure mode this rule exists to prevent.

**A registered tool is not reachable until what it RETURNS is usable without a browser.** `change_plan` on the first-purchase path returned a Checkout **client secret**, which needs Stripe.js mounted, so the one caller the tool exists for could not finish the purchase. Hence `createCheckoutSession({ uiMode: "hosted" })` — the same session, same tax, same payment-method configuration, a URL instead (`test/checkout-ui-mode.test.mjs` pins that the two modes differ in nothing else).

**The cost of not having it, measured in a consumer:** scartoffie hand-rolled a hosted `checkout.sessions.create` to get a URL, and that second session inherited neither `config.tax` nor the method configuration. Note what it did NOT look like — the two paths agreed on the rate, because that deployment is registered nowhere and charges 0% everywhere, so no total was ever wrong. What actually diverged was **the 0% TaxRate itself**, whose `display_name` carries the legally mandatory mention ("TVA non applicable, art. 293 B du CGI", "Autoliquidation, art. 196 dir. 2006/112/CE") — €15 per invoice for the first, and per CJEU C-247/21 an omitted reverse-charge mention cannot be cured afterwards. **A duplicated charge path is not safe because the numbers currently match**: this one would have started charging 0% against 22% the day that establishment moved to Italy, which its own config already documents as the next step.

REST and MCP get it structurally (`createDispatcher` monkey-patches `server.tool`, so every registered tool is an endpoint). `test/surface.test.mjs` asserts `BILLING_TOOL_NAMES` matches what registration produces, **in both directions and by count**. The CLI is hand-written and is the one surface that can silently fall behind, so `test/conventions.test.mjs` asserts it reaches every tool. Coverage is per tool, not per command: `get_api_key` has no command because `auth` performs that flow, `preview_credit_purchase` is `buy --quote`, `set_spend_controls` is `spend limit` / `spend alerts`.

### The 33 tools

`BILLING_TOOL_NAMES` (`tools/register.ts`) is the canonical list of what the library **can** register. The **needs** column is not documentation: `toolCapabilities(plans)` computes it and `registerBillingTools` reads it, so the table and the code cannot disagree.

| tool | group | what it does | needs |
|---|---|---|---|
| `get_api_key` | keys | Provisions or retrieves the workspace's API key | — |
| `list_api_keys` | keys | Lists the keys, obfuscated — never the full value | — |
| `revoke_api_key` | keys | Hard-deletes one key by id | — |
| `get_credit_balance` | wallet | Balance + per-tool costs + auto-reload state | — |
| `preview_credit_purchase` | wallet | Credits / tax / total before buying, from the rates the charge will carry | `replenish.purchase` |
| `buy_credits` | wallet | Checkout Session for a top-up; saves the card | `replenish.purchase` |
| `set_auto_reload` | wallet | Threshold + target for the automatic card charge | `replenish.autoReload` |
| `get_spend_controls` | wallet | The customer's own monthly ceiling + alert thresholds | Stripe customer |
| `set_spend_controls` | wallet | Sets either; `0` clears the ceiling (admin) | Stripe customer |
| `list_invoices` | invoices | Recent invoices: amount, date, status, PDF links | Stripe customer |
| `view_invoice` | invoices | One invoice + a hosted browser link | Stripe customer |
| `download_invoice` | invoices | Direct PDF link (drafts and receipts have none) | Stripe customer |
| `get_billing_portal` | invoices | Short-lived Stripe Billing Portal URL | Stripe customer |
| `get_usage` | usage | Credits spent this cycle, filterable by caller or a day window | — |
| `get_usage_limits` | usage | Every window that applies now: used, remaining, `resets_at` | a `cap` or a `limits.rate` |
| `list_seats` | seats | Per-member seat-type assignments + the types on offer | `sells: seats` **+** org metadata |
| `assign_seat_type` | seats | Puts a member on a seat type (admin) | `sells: seats` **+** org metadata |
| `list_top_up_requests` | top-ups | The queue, pending and settled | `replenish.request` **+** org metadata |
| `request_top_up` | top-ups | A member asks for extra allowance this cycle | `replenish.request` **+** org metadata |
| `approve_top_up` | top-ups | Owner grants a pending ask (admin) | `replenish.request` **+** org metadata |
| `grant_top_up` | top-ups | Owner grants unasked, as a % of that seat's pack (admin) | `replenish.request` **+** org metadata |
| `deny_top_up` | top-ups | Owner refuses a pending ask (admin) | `replenish.request` **+** org metadata |
| `list_plans` | plans | The catalogue + live Stripe prices, provisioning them on first call | `plans` |
| `get_plan` | lifecycle | What this workspace is on, what is scheduled, which moves exist | `plans` |
| `preview_plan_change` | lifecycle | `due_now` / `next_invoice_total` / `recurring_total` / `credit_applied` | `plans` **+** a `self_serve` plan |
| `change_plan` | lifecycle | Up, down or off — one entry point | `plans` **+** a `self_serve` plan |
| `cancel_plan` | lifecycle | Cancel at the end of the period already paid for | `plans` **+** a `self_serve` plan |
| `get_billing_profile` | account | Invoice recipient, company name, billing address | Stripe customer |
| `set_billing_profile` | account | Patches those fields | Stripe customer |
| `set_tax_id` | account | The VAT number printed on invoices | Stripe customer |
| `list_payment_methods` | account | Saved cards + which is default | Stripe customer |
| `set_default_payment_method` | account | Chooses what future charges bill to | Stripe customer |
| `remove_payment_method` | account | Detaches a card (refuses the default while another exists) | Stripe customer |

### The surface is DERIVED, because a dead tool is a false statement

`registerBillingTools` resolves `toolCapabilities(opts.plans)` and registers a group only where some plan declares it. The same catalogue that drives Stripe prices, the meter and every pricing surface decides the tool surface too.

**An agent cannot distinguish a tool that always fails from one it is holding wrong.** A flat-plan deployment with an org-wide pool and no seat types registered `list_seats` (answering `seat_types: []`), `assign_seat_type` (refusing everything) and `request_top_up` (queueing asks against an allowance the plan does not grant) — seven tools describing a product that does not exist.

| | gtm-tools | scartoffie |
|---|---|---|
| catalogue | `sells: flat`, `cap: pool`, `purchase` + `autoReload` | `nothing`/`seats`/`seats`, `pool` + `per_seat` + `wallet`, `purchase` + `autoReload` + `request` |
| seats (2) | – | ✓ |
| top-ups (5) | – | ✓ |
| everything else (26) | ✓ | ✓ |

- **Reads are never gated on a write's precondition.** `list_plans` and `get_plan` register on any catalogue including a wholly quote-only one, `get_usage` on any at all, `get_usage_limits` wherever a plan has a window — a rate limit counts, because it is the one refusal a caller can wait out.
- **`caps` is independent of the adapter's metadata check.** The catalogue says whether a group can ever be *needed*, the adapter whether the answer can be *stored*; neither implies the other.
- **No catalogue means no declaration to read, so everything registers.** `undefined` is "the caller did not say", never "nothing applies" — inventing a `false` would silently delete tools from a working deployment. `capabilities: { request: true }` is the per-group override for a plan not shipped yet; `profileTools` / `subscriptionTools` turn their groups off for an app whose own UI owns the flow.

**Rejected: merging the redundant pairs** into `buy_credits{quote}`, `change_plan{dry_run}`, `get_invoice{pdf}`, `resolve_top_up{decision}` (33 → 26). Gating already beats that per deployment, and a preview sharing its code path with the charge is safer as a separate tool than as a boolean an agent can forget — a forgotten `dry_run: true` moves money.

## Changing plan mid-cycle — what the customer is charged

Measured (`scripts/e2e-proration.mjs`, test clock, Pro €18/mo → Premium €90/mo on day 15 of 30):

| | charged today | next invoice |
|---|---|---|
| **upgrade, deferred** — `proration: "next_invoice"` (default) | nothing | **€127.16** = −€9.29 unused Pro **+** €46.45 Premium remainder **+** €90 next month |
| **upgrade, immediate** — `proration: "invoice_now"` | €37.16 | €90.00 |
| **downgrade** — `timing: "auto"` → period end (default) | nothing | €18.00 |
| **downgrade now** — `timing: "now"` | nothing | €18.00, with the unused remainder credited |

The customer pays **€37.16 either way** on an upgrade; only the timing differs. The unused part of the old plan is always credited back — the `−€9.29` line, which `previewPlanChange` reports as `credit`.

**Why deferred is the default.** Billing immediately takes a payment, and a payment can be challenged by SCA; `always_invoice` + `pending_if_incomplete` then leaves the upgrade *not applied* until the customer completes the challenge, and the pending update expires in ~23h. An upgrade that silently doesn't happen is worse than a larger invoice. The cost is the surprise, which is why `previewPlanChange` returns **`nextInvoiceTotal` AND `nextInvoiceAt`**. Apps preferring the industry-common immediate charge pass `proration: "invoice_now"`.

**Why a downgrade credits nothing.** It takes effect at the period end, so the customer keeps the tier they already paid for and loses nothing. `timing: "now"` drops immediately and credits the remainder, which is worse on features and leaves a credit balance that auto-applies to a later invoice.

`previewPlanChange` shares `desiredPrices` and `diffItems` with `changePlan`, so the quoted number is the charged number — **pass it the same `proration` you will pass to `changePlan`**, or you are quoting a different policy from the one you apply.

**Which KEY, for an `api` caller.** `validateApiKey` may return `keyId` alongside `orgId`, and `createApiMeterGuard` passes it as `caller.id`. An adapter that cannot tell keys apart records **no** caller id rather than a wrong one, since a plausible-but-wrong id is indistinguishable downstream from a real member. `memberUsage` narrows an `api` member to its own key when one is named, because "which key spent it" is what an admin screen asks — but the GATE still sums by KIND across the org (one shared agent seat), and a `scope: "caller"` limit sums every key, so per-KEY windows would loosen the aggregate and remain a product decision.

## Who is calling — org vs principal (`src/auth.ts`)

Every call resolves to an **org**. An org API key means exactly that — the org, with no person behind it, which is what a headless agent holds — so org-keyed calls are owner-level, deliberately.

A surface that DOES know the human (a server action, an OAuth token minted for a user) wraps the call in `runWithPrincipal({ authHeader?, orgId?, principal: { userId, isAdmin? } })`. Admin-only tools then call **`enforceAdmin(adapter, action)`** — `enforceAccess` plus `adapter.isAdmin` when a principal is present. `approve_top_up`, `deny_top_up` and `assign_seat_type` use it; `request_top_up` lets a known non-admin request only for themselves, since `member_id` arrives from the caller and unchecked would let a member queue grants against anyone's seat.

Two deliberate fallbacks, both "allow": no principal (the org-key case), and an adapter with no `isAdmin` — silently disabling every management tool for adapters without a role concept is a worse failure than the one being prevented. So with only org keys in play the API is permissive and the app's own UI gate separates member from owner. **Extension point:** an OAuth path that can identify the user should resolve a principal alongside the org.

## Metadata is a budget, and a per-member record does not fit in it

WorkOS org metadata is **10 keys, keys ≤40 chars, values ≤600, ASCII**; Stripe customer metadata is 50 keys × 500. Treat both as a budget measured in **characters**, not records.

- **Never bound a packed value by a record COUNT.** A queue capped at 50 records in a value that holds 3, and a `member → cycle → credits` map that overflowed at the 12th member, both passed every test because the fake accepted any string. `test/helpers.mjs` enforces the real limits, and anything packed into a value is trimmed against `METADATA_VALUE_LIMIT` — the same unit the store rejects on.
- **The blast radius is the whole org, not the record.** `setOrgMetadata` and `setSubscription` re-write the entire object, so ONE oversized value fails *every* metadata write for that org — a long top-up history stopped `past_due` from being recorded.
- **A per-MEMBER record goes on the member.** `adapter.getUserMetadata` / `setUserMetadata` (optional; `WorkOSOrgAdapter` has them) give each member their own budget, removing the ceiling rather than raising it. A grant is stored `{ [orgId]: { [cycle]: credits } }` — keyed by org because WorkOS user metadata is global to the user, and pruned to the cycle being written because `extraAllowance` only reads the current one. An adapter without them falls back to the org blob, reads included, so a grant approved by an earlier version still applies.
- **Correctness and history trim differently.** A request queue may drop **settled** records to make room, never a pending ask: losing history costs a UI a row, losing a grant costs the customer allowance they were promised.
- **A seat is never trimmable.** `seatAssignments` (`seats.ts`) had the same overflow at ~13 members, on the one plan shape whose premise is many seats. Dropping an entry silently downgrades a member to the default pack, so the per-member path does not write the legacy value at all — which is what lets an already-oversized org be assigned into. A cleared seat writes a **tombstone** (`""`) rather than deleting, because the legacy map is still read as a fallback and a plain delete would read back as the old seat.
- **Enumerating a per-member record needs `adapter.listMemberIds`** (`WorkOSOrgAdapter` lists active memberships; `memberCount` derives from it). Without it `listSeatAssignments` returns what the legacy map holds.

## Cycles — one definition (`currentCycle`)

Anything filed against a billing cycle must key it with `currentCycle(adapter, {orgId, plans, plan})`, the same window the meter reads. `request_top_up` once wrote a calendar month while the meter read the subscription period, so for **every org with a subscription** an approved top-up granted nothing, with no error anywhere. There is exactly ONE key: `extraAllowance` reads the cycle it is given and nothing else. **Do not reintroduce a fallback key** — a miss looks like "no grant" rather than an error, which is why the defect was invisible.

## Counting usage — all of it in Stripe, no store anywhere (`src/usage-ledger.ts`, `src/usage-scopes.ts`)

Counting is separate from moving money, behind one seam: `UsageLedger` (`record` + `total`). **Nothing here needs a database.** Which implementation is wrong depends on the QUERY, not the config, so the default is a composite that routes:

| | sees INCLUDED usage | per-member | needs a store |
|---|---|---|---|
| **`stripeUsageLedger()`** (default) | yes | org-wide + wallet-funded | no |
| `stripeBalanceUsageLedger()` | **no** | yes | no |
| `stripeMeterUsageLedger()` | yes | **no** | no |
| `stripeScopeUsageLedger()` | yes | yes | no |

- **ORG-wide** (`cap: pool`, `scope: "org"` limits, the spend limit) → the **Stripe meter**: sees every call including included ones, one request at any window width.
- **PER-CALLER** (a seat pack, `scope: "caller"` limits) → **balance transactions**, which carry the caller in metadata — exact and per-member, but they only exist where money moved.
- **INCLUDED *and* per-caller** (`cap: per_seat`) → `stripeUsageLedger({ perCaller: stripeScopeUsageLedger() })`, below.

**The call-site rule: `record` always, `deductCredits` only when the wallet funded it.** An included call must be counted (or its cap can't be enforced) but must not be charged.

### The scope ledger

**A Customer is just a key.** Stripe exposes exactly ONE grouping key for usage — `listEventSummaries` requires `customer` and has no dimension group-by, there is no read API for raw meter events, `/v1/billing/analytics/meter_usage` is unavailable, a zero-amount balance transaction is rejected — so the only routes to a second dimension are more customers or more meters. `stripeScopeUsageLedger` gives each scope (`k:<kind>`, `u:<memberId>`) a Customer of its own.

- **The funding split keeps the lag off the limits that care.** Meter summaries lag ~60 s: fine for a monthly pack, useless against a `600/hour` limit. So the leg splits on `UsageEvent.funded` — wallet-funded usage from balance transactions (no lag), included usage from the scope meter. The sets are disjoint, so `total` is a plain sum.
- **The scope customer is DERIVED, never allocated.** `scopeOf` / `scopesFor` must produce the same string on the write and read paths, or a read looks up a customer nobody writes to and reports 0 for that member for ever. Resolution is `customers.search` then `customers.create` under an idempotency key derived from the scope: the search index is eventually consistent (~20 s) and the key dedupes creates for 24 h, so there is no window where both miss and two instances cannot split one member's usage.
- **Not the default**, because creating Customer objects is a side effect a consumer should choose. Cost: one Customer per active member per org, marked `bt_kind: "usage_counter"`. Writes ride one `v2.billing.meterEventStream` request in `Promise.all` with the org write, so per-call wall-clock is unchanged. `scripts/e2e-scope-ledger.mjs` proves it against a sandbox.

### One rule reads the coverage declaration

`UsageLedger.covers` is a `LedgerCoverage` (`orgIncluded` / `callerIncluded`); `coverageNeededBy(model)` says what a plan requires, `ledgerGaps(models, covers)` returns the plans that don't fit. `createMeter` warns at boot; `checkPlansConfig(plans, { usageLedger })` makes it an **error**, because a warning in a deploy log is missable and a month of unenforced caps is not recoverable. One default (`defaultUsageLedger()`) is read by both — two copies of this rule had already drifted, so a pooled plan on a wallet-only ledger passed every check while counting nothing. Omitting `covers` skips the check: undefined means "the caller did not say", not "fail it".

**The caller axis needs TWO questions, because asking one was wrong in both directions.** An *org*-scoped limit carrying `callerKind` is issued as a caller-filtered read, so filing it under `orgIncluded` made it read 0 for ever; a `scope: "caller"` limit over always-wallet-funded usage is answered exactly by the debits, so demanding a store rejected working configs. The axis is needed when the read is caller-filtered (`scope: "caller"` **or** a `callerKind`) **and** the usage behind it can be included. Pinned in `test/ledger-coverage.test.mjs`.

A pool costs nothing to count: `cap: pool` plus org-scoped limits runs on the bare composite at any volume. **`orgWide` is the seam most likely to move** — if Stripe's Meter Usage Analytics API becomes generally available, the scope customers disappear.

### What limits this, and the levers

**The constraint is Stripe's RATE limits, not latency or storage.** Live: 100 req/s globally, **25 req/s per endpoint**. `scripts/load-metering.mjs` counts every HTTP request via `stripe.on("response")`, because a read is not one request — `usageSince` paginates.

| per metered call | uncached | cached 2 s |
|---|---|---|
| member (`user`) | **3.95** | **1.95** |
| API key (`api`) | **1.30** | **1.00** |

**The bottleneck is metered calls per SECOND for the whole account** — roughly **15–20/s** cached, shared across every org, so idle users cost nothing. It is inherent because the meter has **no batch read**: W windows cost W requests, an N-member screen costs N. Requests-per-call transfers to live; throughput does not.

- **`UsageQuery.sources`** lets `resolveAllowance` state whether a window can hold included and wallet-funded usage, so the ledger skips a leg that must return 0. Omitting it means BOTH: **a ledger must never invent a restriction**, since skipping a contributing source under-reports and refuses no one.
- **The wallet leg is the only unbounded read** — `usageSince` pages 100 transactions at a time, so a monthly window can cost tens of requests. `stripeScopeUsageLedger({ wallet: null })` removes it, correct ONLY where no per-caller window can ever be wallet-funded.
- **`cachedUsageLedger(ledger, { ttlMs })`** is opt-in because it trades the thing the meter exists for: a cached window is stale by up to `ttlMs` and the gate reads through it, so `overspend <= (calls/sec by one caller) × ttlMs × credits/call`. Size the TTL against the TIGHTEST window enforced. **`record` is never cached** — a write served from cache is usage counted by nothing.
- **Several windows over one caller cost ONE request:** `resolveAllowance` issues them in a single tick, the meter groups by day and the balance walk sums every window in one pass. **This breaks if you `await` between the reads** — adding a customer retrieve in front silently split it into two flushes. If you add a read there, add it *inside* the same `Promise.all`.

**When a read FAILS there is ONE policy, on the composite.** Rate-limited, a per-caller window used to return 0 (letting through a member who had spent their pack) while an org-wide window 500'd — same cause, opposite outcomes, neither chosen. `onReadFailure` is `"last-known"` (default), `"zero"` or `"throw"`, and the degradation is always reported through **`onUsageFault`**, because the characteristic failure here is not an exception but a number silently wrong in the direction nobody reports.

**Two amplifiers.** `memberUsage` is N summaries by construction — cache it at the page, not per request. And anything iterating customers must bound itself by objects **examined**, not matches found, since the scopes outnumber real customers and sit at the front of `customers.list`.

**What no store gives up: the audit trail.** Nothing here can say WHICH actions made up a total; a consumer who needs that brings their own `ledger`.

## Spend controls — the customer's own ceiling (`getSpendControls`)

A monthly ceiling on what a customer may CONSUME, plus the thresholds they want warning at, both on the customer's Stripe metadata beside auto-reload (`spend_limit_credits`, `spend_alert_credits`) — billing preferences the customer owns rather than plan config.

The ceiling is **not a new gate**: it funds nothing and only refuses, which is what `state.limits` already models, so it rides the existing path — `resolveAllowance` reports it as one more `LimitState` (`kind: "spend"`), `fundingFor` checks it in the same loop, `describeDenial` writes the message. The read joins the same parallel round as the rate-limit reads and comes off the customer object `getCreditBalance` already retrieves, so it adds no round trip.

- **`spend_limit_reached`, not `rate_limit_reached`** — a plan's rate limit is the product's and the customer must wait; this one is theirs and they can raise it. And **plan limits are reported first** when both refuse: the one the customer *cannot* lift is more useful to be told.
- **The window is the calendar month**, even for an annual subscriber: "monthly" is what the customer set, and the plan cycle would make it a year wide.
- **`0` clears it and writes `""`**, never `"0"`, which would read back as a ceiling of zero and refuse every call in the workspace. Junk metadata means "no ceiling" for the same reason. `null` is rejected with "nothing to change": `dispatchTool` strips null arguments before validation, so a nullable field would be dropped on REST and CLI and read as "leave it alone" while the identical raw-MCP call worked.
- **Both tools are ungated** — a ceiling funds nothing, so it needs no `replenish` and no plan. `set_spend_controls` is `enforceAdmin`, because the ceiling governs what the whole workspace may consume. They exist because `describeDenial` tells the caller this is the one limit they can raise themselves, which is useless advice to an agent with no tool to raise it with.
- **The ceiling sees exactly what your ledger sees** — it is org-wide, so the meter answers it and it sees every call.

## Tax — the library calculates it, Stripe Tax is opt-in

`resolveTax` works the rate out locally from `eu-vat-rates-data` (45 European countries, tracked daily from the European Commission's TEDB) with VIES for B2B validation, and `taxRatesFor` applies it as an explicit Stripe **TaxRate** — no per-transaction fee. `updateCheckoutSessionTaxRates` re-taxes an open session when the typed country differs from the one guessed. What you take on instead: evidence-of-location records for EU B2C, threshold monitoring, and filing.

**WHO calculates is declared ONCE, and every charge the library builds reads it** — the seat Checkout Session, the `buy_credits` top-up, the auto-reload invoice:

```ts
config: { baseUrl, currency: "eur", tax: { origin: "IT" } }   // ← the whole tax config
```

Per-site tax arguments meant the answer to "does this deployment charge VAT" lived in as many places as there were charges — which is how the auto-reload and the top-up went out at 0% while every seat invoice on the same account charged 22% IVA. `checkBillingSetup({ config })` reads the same field, so the doctor cannot disagree with the engine.

- **Configuring nothing means `"local"`**; `mode: "none"` is how you say "untaxed", explicitly. `taxModeOf` owns the precedence.
- **Four modes, and `config.tax` is a DISCRIMINATED UNION so the wrong pairing cannot be written.** `local` constrains `origin` to the 45 countries the dataset covers (`LocalTaxOrigin`), so `origin: "US"` — or AU, JP, SG, CA, BR — is a **compile error** rather than a charge refused at runtime. `resolveConfig` throws for the half types cannot see: an origin that is cast, or inferred from a US Stripe account with none declared. `mode: "external"` takes an injected `calculate` (`TaxCalculator`) so a provider can answer, and **no adapter ships**. One did briefly, for Numeral, written from a docs summary rather than the OpenAPI spec — it could not have worked: the version header is mandatory, `customer`/`origin_address`/`order_details` are all required, and the response carries `total_tax_amount` and no rate field, so it would have thrown on every call. The seam also cannot yet reach a provider of that kind at all: it passes an address and expects a RATE, while Numeral, Anrok and Stripe's Tax API take a BASKET and return an AMOUNT. Threading `currency` + `lineItems` through `taxFor` is what unblocks that, and converting an amount back to a percentage can drift a cent from the provider's own filed figure. **For a US establishment, `mode: "stripe"` is the supported answer** — Stripe owns the calculation and the invoice, so no conversion exists to be wrong.
- **`originFor` is the one place the origin resolves** — `config.tax.origin`, else the Stripe account's country (memoised, never throwing, since it sits behind `taxFor` on a charge path). Nothing else may read `tax.origin` and **consumers must not keep their own copy**: it decides domestic vs cross-border, so a second copy is a second answer. One consumer's `const TAX_ORIGIN` said `FR` while its own script registered `IT`.
- **`rates` is the authoritative hook** for an app resolving from its own records, and is per-ORG, which `config.tax` cannot express (hence `topUp.taxRates`).

### The two rules the rest follows from

1. **A rate is charged where the SELLER's regime says tax is due, never because the dataset has a number for the destination.** Only 27 of the 45 countries are in the EU, so "we have a rate" is not "you owe it": GB, CH, NO, TR and IS once fell through every EU branch and were charged their own domestic rate — an Italian seller invoicing 20% "VAT" to a UK customer, which is neither EU VAT nor collectable without a UK registration.
2. **Every uncertainty resolves toward CHARGING** — an unverifiable VAT number, an address that cannot be placed, a tax id contradicting the address. Wrongly charging is recoverable; wrongly exempting means owing the tax yourself.

So `TaxDecision` separates **`outOfScope`** (0% is the complete answer) from **`approximate`** (tax IS due and there is no rate for where it is due, so the charge is refused). There is **no override flag**: the ways out both assert something true — `registrations` if you do not owe it there, `mode: "stripe"` if you do, `mode: "none"` to charge nothing deliberately.

### The inputs

**`config.tax.registrations` is the second input a rate needs, and no dataset can supply it.** `origin` is where you are established; this is where you took on an obligation. `[{ country: "IT" }, { country: "GB" }]` for VAT registrations, `[{ country: "US", state: "CA" }]` for US nexus — country-wide covers every state, state-scoped only its own, and an address with no state matches no state-scoped entry. **Undefined is "the caller did not say"**, so the regime rules alone decide; declared, ONE rule covers everywhere including domestic, which is why `[]` says what omitting it cannot: a US seller with no nexus charges 0% everywhere, correctly and without a refusal. Post-Wayfair you must not collect in a state before you have nexus there — that is what makes a US destination answerable rather than a throw, and why `state` is finally read.

Everything else comes from the CUSTOMER: their Stripe address decides the place of supply, their tax id decides reverse charge. **No address on file is charged the DOMESTIC rate, not nothing** — on a seat checkout the address isn't typed yet, so the domestic rate goes on at creation and the browser re-applies once it exists.

### Reverse charge

- **It does NOT require the seller to be in the EU** — the customer self-accounts under Art. 44/196 whoever the supplier is. Requiring it billed a German business 19% MwSt from a US supplier, tax that supplier can neither collect nor remit.
- **The VAT id must belong to the country the customer is IN.** It is the evidence of where they are established, so a German address with an Italian id is a contradiction — and unchecked it was self-serve VAT avoidance. A mismatch is refused, not resolved.
- **Greece needs its own format check:** the dataset keys it `GR` but writes its pattern as `^EL\d{9}$`, the only entry carrying the prefix the others omit, so `validateFormat` rejects every spelling. `parseVatNumber` accepts either, reports `GR` (what an address carries) and canonicalises to `EL…` (what VIES routes on).
- **`oss` decides ONE case:** a cross-border EU customer with no valid id must be taxed somewhere — registered (default) at the CUSTOMER's rate, `oss: false` at YOUR OWN, which is the only rate you can remit without a foreign registration. The display name follows the rate, or the invoice says MwSt above an Italian figure.
- **Confirmed numbers are cached for a day; refusals never are.** A confirmed registration stays real, so re-asking can only worsen the answer — while a refusal conflates "no such number" with "that member state is unreachable", and caching the second would extend an outage's over-charging past the outage. `invalidateVatNumbers()` clears it.
- **The lookup is injectable** (`__setVatValidatorForTests`) because the suite is offline by design, and the bare reset installs a validator that REFUSES rather than the real one, so a test with a `taxNumber` and no stub fails deterministically instead of re-arming the network.

**Nothing enables Stripe Tax implicitly.** `automatic_tax` is set only where the caller passed `automaticTax: true` (or `config.tax.automatic`). Inferring it from the ABSENCE of `taxRates` was the expensive way round: with no active registration Stripe Tax returns **zero** tax rather than an error, so the total silently dropped on exactly the accounts that never opted in. Manual rates and `automatic_tax` are mutually exclusive — Stripe rejects both.

`checkBillingSetup({ taxMode })` names WHERE calculation happens: `"local"` (the default, and deliberately not `"auto"`, which would name this mode after `automatic_tax`, its alternative) lists the TaxRates that exist — the audit trail of what the account charged, legitimately empty on a fresh one; `"stripe"` audits head office, registrations and `tax_behavior`; `"none"` skips it. `ensureTaxSetup` is explicit-only.

### Charges the library raises itself

A subscription is taxed by whoever builds its Checkout Session. Two charges have no session: the **auto-reload invoice** (covered by `config.tax`) and the **top-up** via `buy_credits` (`registerBillingTools({ topUp })`).

`quoteCreditPurchase(amount, taxRateIds)` reads the same TaxRate objects the charge will carry, so the quoted number is the charged number. INCLUSIVE rates leave the total alone, and several rates round ONCE on the summed percentage — rounding each and adding drifts a cent. `createCreditCheckoutSession` takes `uiMode: "embedded"` for a client secret; hosted stays the default, needing no Stripe.js on the page.

**Auto-reload bills as an invoice**, not a PaymentIntent — a receipt is not a valid sales document, and this is the one purchase the customer never confirms. It carries an idempotency key per customer/target/hour because the meter fires it, fire-and-forget, on every metered call.

**Its tax arrives as a THUNK.** `tryAutoReload` takes `ChargeTax | (() => Promise<ChargeTax>)` and calls it only past every early return — below threshold, no card, nothing owed. Resolving tax first meant a live VIES request plus a customer retrieve on **every wallet-funded metered call**, almost none of which reload; rate-limited at VIES no number verifies, and an unverifiable number means CHARGE, so every B2B customer silently stops reverse-charging. **If you add a read there, add it after the early returns.**

## Agent auth — auth.md (`src/agent-auth/`)

`createAgentAuth({ adapter, config, branding, paths?, identityTypes?, baseUrl?, claimStore?, policy? })` returns framework-agnostic `(Request)=>Response` handlers implementing the [WorkOS auth.md](https://workos.com/auth-md) agent self-registration protocol: `authMd` (the narrative), `protectedResource` (RFC 9728 PRM), `authorizationServer` (RFC 8414 + `agent_auth` block), `identity` (`POST /agent/identity` — `anonymous` + `verified_email`), `claim`, `token`/`handleClaimGrant` (the `urn:workos:agent-auth:grant-type:claim` polling grant), `revoke` (RFC 7009), and `wwwAuthenticate(req)`. Everything flows through the **adapter + magic-auth + shared getWorkOS** — no direct WorkOS calls. Base URL derives from the request's forwarded host/proto by default, or an explicit override. `anonymous` needs `adapter.createAnonymousOrg` (mirror apps that need a workspace row should omit it from `identityTypes`). Claim state is a pluggable `ClaimStore` (default `inMemoryClaimStore`, sha256-at-rest, 10-min TTL; inject Redis/DB for multi-instance). Mount the REST/MCP factories with `resourceMetadata` so every 401 advertises the PRM discovery doc. Humans keep using magic-auth + Checkout; this is the headless-agent path.

## Machine payments — MPP (`src/machine-payment/`)

The **payment** sibling of auth.md: Stripe's [MPP](https://mpp.dev) — a client hits a paid resource, gets **HTTP 402 + `WWW-Authenticate: Payment`** + `application/problem+json`, pays (SPT card or crypto/USDC), retries with a credential, gets the resource + receipt. `createMachinePaymentHandler({ methods?, amount, currency?, networkId?, payToAddress?, settle?, onPaid? })` → `requirePayment(request)` returns a 402 `Response` or `{paid:true,…}`. `createPaymentMd(...)` serves `/payment.md`.

**Settlement is pluggable and gated:** the challenge and credential parsing are complete and offline-testable, but the charge is injected via `settle` (provide it once the account is machine-payments-eligible — Stablecoins/Crypto approval, or a US entity for SPT). Without `settle` the handler keeps 402-ing with a "settlement not enabled" note, never a 500. Validate the challenge with `mppx validate`; reference impl `github.com/stripe-samples/machine-payments`. Multi-method 402s combine into one comma-joined header — the parseable source of truth is the `accepts[]` array in the body, so default to a single method.

**Dunning / `past_due`** comes from the polled `customer.subscription.updated` **and** `invoice.payment_failed` events → `adapter.setSubscription("past_due")` + the `hooks.onPaymentFailed(orgId)` hook. Stripe Smart Retries and the card updater handle retries (Dashboard config, no code). `createBillingPortalSession(customerId, returnUrl)` and `get_billing_portal` return the no-code self-serve surface.

**What the payment forms offer is a library default, not an app decision** (`payment-method-config.ts`). Every form the library builds resolves `defaultPaymentMethodConfig(kind, config)` when the caller names no `paymentMethodConfiguration`, and the answer is **card + Apple Pay + Google Pay, nothing else**.

- **Wallets are in** because they are not another way to pay — Apple Pay and Google Pay ARE the card with the typing removed. Forced ON rather than inherited, so they don't depend on a Dashboard toggle.
- **Everything else is out.** Inheriting every method the account had enabled put a tab row — Carta, Klarna, Amazon Pay, Satispay — in front of every customer of an app that had always shown one field. A method reaches a customer because someone chose to sell that way; inheriting it from a toggle is not that choice. An account that does sell via SEPA or iDEAL passes its own `paymentMethodConfiguration`.
- **Link is off, and that default is the point.** Link's inline signup is drawn by the Payment Element from the **account's** Link setting, so it survives both `wallets.link: "never"` (which removes only the Link *wallet*) and `payment_method_types: ["card"]`. A payment-method configuration is the only lever, obscure enough that leaving it to each consumer meant every app shipped the signup by accident. `config.paymentMethods.link = true` opts back in.

`ensurePaymentMethodConfig` takes `only` / `enable` / `disable`, memoised per process and idempotent by `name`. `defaultPaymentMethodConfig` **never throws**: a restricted key that cannot read configurations returns undefined and the form renders with the account default, because a missing permission must not take down checkout.

## Mounting in a Next app

**Both consumers mount this way, and hand-wiring is the thing it replaces.** gtm-tools kept five factories plus its own MCP route, REST routes and Stripe webhook, and every defect that cost it something came from that: no `customer.subscription.*` branch, so nothing wrote the org's `plan` and every subscriber metered as planless (`planModel(plans, null)` is null — the pool they bought never applied); no idempotency key, so a re-delivery double-credited; `caller.id` set to the org id; and an empty wallet answered 500. **The composition is not boilerplate — it is where those five decisions live**, so a consumer writing its own re-decides them all, silently and one at a time.

**One-call:** `createBilling({ adapter, config, plans?, toolCosts?, registerTools?, agentAuth?, webhook?, machinePayment? })` (`src/create-billing.ts`) returns `{ mcp, restList, restDispatch, webhook, agentAuth, machinePayment, paymentMd, cli }` from a single module instance (shared AsyncLocalStorage). It is sugar over the factories below, all still exported: `registerTools` registers the app's own product tools alongside the billing ones, `agentAuth` auto-wires `resourceMetadata` onto the REST/MCP 401s, and `machinePayment` returns the MPP `requirePayment` handler plus a `/payment.md` handler branded from `agentAuth.branding.productName`. Or wire them by hand:

- **MCP** `app/[transport]/route.ts`: `createMcpTransport({ adapter, config })`. **`requireAuth` gates the HANDSHAKE**, not just the tool calls — off by default, because each tool enforces access itself, so an anonymous client can otherwise complete `initialize`/`tools/list` and enumerate the catalogue before being refused on every call. Which tools exist and what they cost is itself information; a deployment that does not publish it passes `requireAuth: true` (`createBilling({ mcp: { requireAuth: true } })`).
- **REST** `app/api/v0/route.ts` + `app/api/v0/[tool]/route.ts`: `createToolListHandler({toolCosts})` / `createToolDispatchHandler()`. A refusal becomes the status an HTTP client can act on: **402** for an empty wallet, 401 (+ `WWW-Authenticate`) unauthorized, 429 (+ `Retry-After`) for `try_again_later`, 400 invalid arguments, 404 unknown tool. The 402 lives here because this library writes that message — a consumer had hand-rolled the same regex over it, and without the mapping "buy credits" reaches the caller as "the server is broken".
- **Webhook** `app/api/stripe/webhook/route.ts`: `createStripeWebhookHandler()` (raw body — exclude from any session middleware). It credits ONE thing: a `mode: "payment"` checkout, under `credit:checkout:<session id>` so a **re-delivery credits once**. Everything else — `invoice.paid`, `invoice.payment_failed`, `customer.subscription.*` — falls to `onOtherEvent`, which is where `createStripeEventHandler` belongs; without it a subscription is never mirrored onto the org, so `resolvePlan` reads null for ever and **no subscriber is given the pool they paid for**.
- Register tools once: `registerBillingTools(server, { adapter, toolCosts, config })`.

## Entry points — the root barrel is not the only way in

The root re-exports 45 modules, so `import { planModel } from "@arnaudjnn/billing-tools"` in a Server Component resolves the MCP SDK, mcp-handler, authkit-nextjs, Stripe, WorkOS and eu-vat-rates-data to answer a question about a plain object. Import from the narrowest entry that has what you need:

| entry | for | reaches |
|---|---|---|
| `/plans` | the catalogue + its arithmetic + the adapter/config types | **nothing** |
| `/pricing` | `derivePlanViews`, `deriveCompareTable`, the markdown renderers | **nothing** |
| `/agent-auth` | auth.md, MPP, the OAuth proxy | WorkOS, Stripe, eu-vat-rates-data |
| `/routes` | the three Next route factories + `ensureWebhookEndpoint` | MCP SDK, mcp-handler, Stripe, zod |
| `/tools` | `registerBillingTools`, `createDispatcher` | MCP SDK, WorkOS, Stripe, zod |
| `/ui`, `/ui/authkit` | the React checkout components | React, Stripe.js, authkit |
| `/cli` | the customer CLI commands + config store | node builtins only |
| `/dev` | `startLocalWebhooks` (the Stripe CLI fetcher) | node builtins only |
| `.` | everything, incl. `createBilling`, the Stripe/WorkOS engines, the doctor | all of it |

`test/conventions.test.mjs` pins each set **exactly, in both directions** — a leaf that grows a dependency has stopped being one, and a leaf that loses an export means consumers now import from two places.

Two things that look like dependencies and are not. **`commander` is nowhere**, including the root: `cli/commands.ts` imports `Command` as a *type*, which tsc erases. **`pg` is nowhere** either, and nothing could want it — the package touches no database at all.

`createBilling` stays at the root deliberately: it composes the tools, all three routes, agent-auth and MPP, so it needs the whole graph, and being one module guarantees the single instance its shared AsyncLocalStorage depends on. Same for `checkPlansConfig`, which reads Stripe from `doctor.ts` — a deploy-time call, not one a page makes.

The root DERIVES its pure half (`export * from "./entries/plans.js"`) rather than hand-listing names, because a hand-maintained list drifts. **The hazard `export *` introduces is the mirror image:** TypeScript silently drops any name two `export *`s both provide. `plan-model` and `checkout` each export a `Quantities` — the barrel keeps checkout's under its own name and plan-model's as `PlanQuantities`, which works only because an explicit export beats `export *`. `test/conventions.test.mjs` asserts every runtime name the leaf provides is reachable from the barrel, and that both `Quantities` survive.

## CLI

Two CLIs, for two different people.

**`registerBillingCommands(program, { configDir: "~/.myapp", envPrefix: "MYAPP", defaultUrl })`** is the CUSTOMER's: `auth`, `keys list|revoke`, `balance`, `buy`, `invoices`, talking to the app's REST API with an org API key and persisting to `<configDir>/config.json` (chmod 600).

**`npx billing-tools <command>`** (the package's `bin`) is the DEVELOPER's, and talks to Stripe with the secret key. It carries only what needs no app config:

- **`dev`** — `startLocalWebhooks()`: fetch the Stripe CLI into `~/.cache` if absent, `stripe listen --api-key` (no `stripe login`, no tunnel, no registered endpoint), and write the session's `whsec_` into `.env.local`. The dotenv write is the point — `stripe listen` mints a NEW secret per session and the dev server is a different process, so a file is the only channel both see.
- **`doctor`** — `checkBillingSetup` + `formatDoctorResult`, exiting non-zero on an error so it can gate CI.

**`runBillingCli` is the app-side entry, and it is ONE script with two verbs.** `plans` is a TypeScript value in the app, so neither half can be a bin subcommand; what the app stops keeping is the plumbing. `doctor` (default) is `runBillingDoctor` — `checkPlansConfig` first, because it needs no network and explains most account-level symptoms — and `setup` is `setupBilling` + `formatSetupReport`. Both read the same `--url` / `--no-webhook` through `webhookUrlFromArgv`, because two hand-written copies of that parsing had already drifted.

**`doctor` is the default and `setup` must be typed**, since the default has to be the verb that cannot change anything: a bare `pnpm billing` on a laptop holding live keys should read the account, never provision it. An unknown verb exits 2 rather than falling through to either half.

**The script's options are DERIVED from the app's own composition — `runBillingCli({ ...billing.cli, webhookUrl })`.** `createBilling` already holds the catalogue, the resolved config and the ledger, so `billing.cli` reads them off it instead of the script naming them a second time. Two of those were mere duplication; the third is the shape of the worst bug this library has had — a wallet-only ledger counting pooled usage as 0, so every subscriber got unlimited requests while every check passed. **A script that declares its own coverage can be right while the app is wrong.** `hasCheckout` is true when a catalogue is registered with the lifecycle tools on, because `change_plan` now opens a hosted session itself; `workos` audits by default and claims `oauthProxy` only when one is mounted. **The webhook URL stays the app's to pass** — it is a deployment fact, and a production URL in that object is one a laptop run would register.

Two behaviours worth knowing. `STRIPE_SECRET_KEY` unset exits **2**, not 1, on either verb: that variable decides WHICH environment is read or written, and a run against the wrong account is worse than no run. And a Stripe call that THROWS (invalid key, no network) is caught, printed as `✗ Stripe: …` with a fix line, and exits non-zero — the plan-config report already printed stays on screen, because it is the half that needs no network and the half Stripe can never tell you about. `exit` and `log` are injectable, which is the only reason `test/doctor-runner.test.mjs` can assert any of this.

Call it, do not `await` it at the top level: it exits the process itself, and a top-level await does not survive a CJS transform — the two consumers differ on `"type": "module"`, so the awaited form worked in one and failed to build in the other.

## Setting up an environment (`setupBilling`)

The deploy-time twin of the lazy provisioning, and its honest scope is small: prices, the payment-method configuration and the usage meter all provision themselves on first use, so `setupBilling({ config, plans, webhookUrl, stripeTax? })` exists for the two things that cannot, plus the reporting.

- The **webhook endpoint**, because Stripe returns its signing secret exactly once, at creation — no request can put that in your env store. `formatSetupReport` prints it as a `STRIPE_WEBHOOK_SECRET=…` line, only on the run that created it.
- **Tax registrations**, because only a human knows where the business collects — skipped unless `config.tax` mode is `"stripe"`, since running it on a `local` account would create registrations it does not need and is billed against.
- Everything else runs only because a deploy log is a better place to find a broken config than a customer's first request.

No step throws: each failure is reported and the rest continue, because a missing tax registration must not stop the webhook being registered. A skipped step renders `–`, never `✓`. The doctor runs last, so it sees what was just provisioned — `setupBilling` provisions, `checkBillingSetup` decides whether it worked, and they are separate claims.

It needs the app's `plans`, so it stays a function the app calls from a script (`tsx scripts/billing-setup.ts`) rather than a bin subcommand.

## Plan shapes (`src/plan-model.ts`)

One flat shape can only express one product: fold the axes together and an org-level package — "we don't care about seats, here are N tool requests" — becomes unrepresentable. So a plan is FIVE independent axes. Only `sells` is a union, because it alone decides which fields are required and what `ensurePlans` mints:

| axis | values | what it decides |
|---|---|---|
| `sells` | `nothing` \| `seats` \| `flat` | what Stripe charges for (and what gets minted) |
| `grant` | `none` \| `purchased_seats` \| `per_member` \| `fixed` | what is CREDITED as money on `invoice.paid` |
| `cap` | `wallet` \| `per_seat` \| `pool` (flat `credits` or `perSeat`) | what is INCLUDED, as a counted window |
| `replenish` | `{purchase?, autoReload?, request?}` | how to get more (a record — they compose) |
| `sale` | `free` \| `self_serve` \| `quote` \| `legacy` | whether it can be bought. **Required, never inferred** |

Plus `limits.members`, `limits.rate` (below), and `display` (name/tagline/features/badge/cta/pooled) so one config drives every pricing surface. `sale: "legacy"` means a plan kept for existing subscribers and offered to nobody new.

**`grant` vs `cap` is a money bug, not a preference.** A Stripe credit balance auto-applies to the next invoice and cannot be opted out of — measured: 1000 credits granted to a customer on a €21.04 seat produced `starting_balance: -1000`, `amount_due: 1104`. So an *included* allowance must never be credited; it is a `cap`, a window usage is COUNTED against (`src/allowance.ts`). Credit is for what a customer actually buys. `checkPlansConfig` fails a plan that both invoices and credits.

### `limits.rate` is a sixth axis, and it is NOT `cap`

`cap` is the commercial ceiling over the billing cycle; it cannot say "no more than 300 in a week", so a month of allowance spent in one afternoon sits inside the cap and is still not what was sold. A plan declares any number of `{ every: "hour"|"day"|"week"|"month"|"cycle", credits, scope?: "org"|"caller", seatType?, callerKind?, label? }`, all enforced together.

Rate limits are checked FIRST in `fundingFor` and are absolute: they fund nothing, never fall through to the wallet (a limit a top-up could lift is not a limit), and unlike an exhausted `cap` a `shared`/`api` caller does not escape them — what is protected is the product, not the customer's money. The denial is its own reason, `rate_limit_reached`, carrying `retryAt`: it is the one refusal that fixes itself, so the caller is told *when* rather than told to buy.

Windows are **fixed and UTC-aligned** (top of the hour, midnight, **Monday**, the 1st) via `rateWindowFor`, not rolling — a rolling window needs every event's timestamp and cannot be answered by one summed read, and a fixed window is the only kind that can honestly state when it resets. `every: "cycle"` defers to the subscription period. `callerKind` separates the pace a person sustains from the pace a script does, which otherwise needs a dedicated `shared` seat that a wallet-funded API plan does not have. `checkPlansConfig` rejects a zero limit, and warns when a wider window is no larger than a narrower one **that can reach the same caller**, or when an org-scoped limit sets a `seatType` that is therefore ignored.

### Windows, caps and who they cover

- **The window comes from the SUBSCRIPTION period**, not the calendar month: an annual package measured monthly resets twelve times. Calendar month is the fallback with no subscription.
- **`cap.window: "month"` is the exception**, because a price and a window are different things — a plan sold annually whose page says "1 000 per seat per month" would otherwise hand an annual subscriber twelve months' allowance on day one. It is read inside **`cycleWindowFor`**, not at the call sites, so the meter, `usageSummary` and `grantExtraAllowance` keep agreeing on one window. Mutually exclusive with `rollover`.
- **`cap.covers: "users"` says the included window belongs to PEOPLE.** A machine caller then gets no included allowance and is wallet-funded from its FIRST call. Distinct from `onExhausted`, which says what happens once a window is *spent*: an agent overflowed there too, but only after burning a person's monthly allowance. The window is SKIPPED rather than treated as exhausted, so `onExhausted: "block"` cannot refuse an agent over an allowance never included for it.
- **`onExhausted`**: `"block"` refuses even when the wallet could pay (a committed package's overage is a renegotiation), `"wallet"` falls through so a top-up funds it. An agent always overflows to the wallet.
- **A plan that advertises pay-as-you-go must be able to take the money** — `checkPlansConfig` warns when `cap: wallet` or `onExhausted: "wallet"` is set without `replenish.purchase`/`autoReload`.
- **`cap: { kind: "pool", perSeat: N }` is the rung between a flat pool and `per_seat`, and the choice is infrastructural.** "1 000 credits per seat per month" is what a pricing page says; `per_seat` additionally **enforces** it member by member, which is stricter than most teams sell and the only cap shape needing a per-member counter to gate (`stripeScopeUsageLedger`, one Customer per member, ~60 s lag). Pooled, the same promise is ONE org-wide window — `perSeat × seats`, one meter summary at any volume. The trade is fairness: one member can draw the team's share.
- **Seats are the PURCHASED quantity** (`getSubscription().seats`), falling back to the active member count, then 1 — a workspace that bought ten and filled six paid for ten, and sizing on members would quietly hand them a smaller package than the page promised. `poolSizeOf(model, seats)` defaults to 1, so a caller that forgets it under-reports rather than over-grants. Mutually exclusive with `cap.credits` (`perSeat` wins, so the flat number would silently do nothing), and warned when the plan `sells: nothing`.

**The Stripe meter provisions itself on first use**, like plan prices and the payment-method configuration. `record` resolves the meter before reporting to it (memoised; a meter event names its meter by `event_name`, so without that the first call on a fresh account reports into nothing), and the resolver **never throws** — it is on the hot path, so a key that cannot create a meter degrades to windows reading 0 and says so once. `ensureMeters` is the eager version for a deploy step, and it DOES throw.

### Reading usage (`src/usage.ts`)

`usageSummary(adapter, config, {orgId, plans, plan, caller?})` → every window with `used`/`remaining`/`percent`/`resetsAt` plus pool, pack and wallet; `memberUsage(...)` → the per-member breakdown an admin view needs. Both go through `resolveAllowance` **deliberately** — a screen computing its own numbers would eventually disagree with the gate, and the disagreement would be invisible until a customer was refused at 60%. Agents get the same from `get_usage_limits`.

A summary with a caller also reports **`seat: {type, label}`** — the plan's own word for the seat (`SeatTypeDisplay.badge`, else `label`, resolved for `locale`). It is independent of `pack`, because a pooled or free plan has none and every member of one was reported as `standard`, a seat type such a plan does not declare. A plan that sells no seats names the seat it gives with `seat: { key, display }`; `resolveSeat(model, type, locale)` is the same lookup for other surfaces.

**Presentation** derives via `@arnaudjnn/billing-tools/pricing` (a leaf — no Stripe, no WorkOS, no React): `derivePlanViews(plans, {interval, currency, locale, formatMoney, currentPlan, canManage, hrefs})` → `PlanView[]`, consumed by both a React card and the markdown renderers. `price.headline` is a per-MONTH comparison figure, `price.totals` is what is charged, and `annualSaving` carries `annualSavingBasis` — two surfaces of one app derived that percentage from different baskets and advertised 17% while charging 14%.

## i18n (`src/i18n.ts`)

Two kinds of text, two owners. **The library ships English and nothing else.**

- **App-authored** (plan name, tagline, badge, features, CTA label, pooled copy, seat labels, every compare title/label/text) is `Localized` — a plain string for one language, or `{ en: …, fr: … }` for several. Resolution is exact tag → language subtag (`fr-CA` → `fr`) → `defaultLocale` (default `en`) and its subtag → first entry; that last step is deliberate, so a config keyed unexpectedly still renders something.
- **Library-authored** — the structural words it cannot avoid supplying: `Unlimited` in a members column, `Monthly`/`Yearly`, generated markdown headers, `Contact us`, `Free`, and the refusal messages a customer reads. All in `DEFAULT_MESSAGES`, overridden per consumer via `messages` on `derivePlanViews` / `deriveCompareTable` / `renderPlansMarkdown` / `renderRateCardMarkdown`, and via the optional last argument of `describeBasketProblem` / `describeDenial`. Partial bundles are filled from English, so a missing key is never a blank string. Placeholders are `{name}`, substituted by `formatMessage`.

Money localises through `Intl` (`locale` + `currency`), with `formatMoney` as the escape hatch for a house style Intl won't reproduce.

**Keep this package English-only**, including comments and examples. Consumer-specific wording belongs in the consumer.

## Changing a price, changing the currency

**A price is one edit.** Change the amount in `PLANS` and deploy: the next call mints a new Stripe price, transfers the `lookup_key` onto it, archives the old one and reuses the product; the `resolvePlanPrices` memo is keyed on the config, so there is nothing to flush. But a Stripe price is IMMUTABLE and a subscription references one by id, so **existing subscribers keep paying the old amount** — `ensurePlans` will not silently reprice live customers. `migrateSubscriptions({ plans, plan, interval, dryRun })` is that step, made explicit: it walks the plan's superseded prices, moves live subscriptions (active/trialing/past_due/unpaid/paused) onto the current one preserving quantity and seat type, defaults to `proration_behavior: "none"`, only touches prices this library minted, and is idempotent. Do the dry run first.

**The currency is one edit for a NEW deployment and a migration for an existing one.** `config.currency` threads everywhere and the catalogue reconciles like an amount change. What does not follow: `customer.currency` is pinned by whatever first touched the customer — for this library, the welcome credit — and cannot be changed. Stripe still accepts balance transactions in any currency, keeping a **separate running balance per currency**, while `customer.balance` stays a single scalar in the pinned one. So after a switch, debits land in the new currency and a blind read of the scalar reports the OLD balance, with no error anywhere. Hence `getCreditBalance(id, config.currency)` (every internal call site passes it) and the doctor's `Customer currency` check, which samples customers and warns when they are pinned elsewhere — pass `currency` to `checkBillingSetup` or the check is skipped. Existing subscriptions keep billing in the old currency until `migrateSubscriptions` moves them.

## Env

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (auth + WorkOS-org adapter), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing), `REFRESH_TOKEN_SECRET` (OAuth proxy — signs refresh tokens; **required, no fallback**: an earlier version fell back to `WORKOS_CLIENT_ID`, a *public* identifier, so anyone who knew it could forge a 30-day refresh token. Without it the token endpoint returns `server_error` rather than signing with something guessable). `test/conventions.test.mjs` fails if the library reads one this list forgets.

**The two keys must name the same environment, and `environmentMismatch` is what says so.** Each half of the report already stated its own — "LIVE MODE" from Stripe, "production key" from WorkOS — so a live Stripe key beside a staging WorkOS key printed both facts, passed every check and read as healthy. It is the worst mistake available here: real cards charged against orgs and `sk_` keys in the wrong environment, with the mapping between them (the org's `stripeCustomerId`) written where nobody is looking. `checkWorkOSSetup({ expectLivemode })` errors on it, from the key prefixes and no network, and both `setupBilling` and `runBillingDoctor` pass it. **Undefined stays "the caller did not say there is a Stripe half"** — never "the halves agree" — so a WorkOS-only audit is unaffected.

**Only an OLD WorkOS key names its environment, so `workosEnvironmentOf` has three answers.** `sk_test_…` and `sk_live_…` say; a newer `sk_<base64 key id>` (decoding to `key_01…`) says nothing, and the pre-existing check read "not `sk_test`, therefore production" — mislabelling those, and then, once the comparison existed, accusing a correctly matched local setup of being mixed. It did that on its first real run. **`unknown` compares against nothing and reports nothing**, because a guard whose errors are sometimes fiction is one people learn to scroll past, which costs more than the check was worth.

`BillingConfig`: `{ freeCredits=100, currency, baseUrl, internalDomains: string[] }`. With `STRIPE_SECRET_KEY` unset, billing tools report "not configured"; metering (`enforceCredits`) is skipped when `cost === 0`, Stripe is unset, or the org is internal.

## Build & release

Plain TS → `tsc` → `dist/`, built in CI and shipped only in the npm tarball (gitignored, not committed). Published to npm as **`@arnaudjnn/billing-tools`**. Peer deps (`@modelcontextprotocol/sdk`, `zod`, `mcp-handler`) come from the host app.

**Releases are fully automated** (semantic-release + npm Trusted Publishing / OIDC). Push a [Conventional Commit](https://www.conventionalcommits.org) to `main`; the `Release` workflow computes the version, publishes to npm with provenance, creates the GitHub Release + `vX.Y.Z` tag, and commits the bump + `CHANGELOG.md` back to `main`:

```bash
git commit -m "fix: …"    # → patch
git commit -m "feat: …"   # → minor
git commit -m "feat!: …"  # → major   (or a `BREAKING CHANGE:` commit body)
git push                  # docs:/chore:/ci:/refactor: → no release
```

**`!` means a real consumer breaks, not that an export moved.** Fourteen majors shipped in three days — ten on one day — and checking each against the two consumers afterwards, **none of them broke either app**: the removed options were unused, and the `config.tax` union typechecked clean in both. They were breaking in theory and no-ops in practice, so the honest labels were `feat:` and `fix:`.

The test is not "could this break someone" — almost anything could. It is: **name the consumer and the line that stops compiling.** If you cannot, it is a `feat:`. If you can, say so in the footer *and* give the migration, which is the part that actually earns the major. Removing an option nothing calls, tightening a type that every real config already satisfies, or changing a default that no deployment relies on are all minors. The cost of getting this wrong is not the number — it is that a package churning majors reads as unstable to exactly the people you want adopting it, and a version line cannot be walked back: 2.x through 13.x are permanently taken on npm.

**Setup:** an npm **Trusted Publisher** must exist (npmjs → package Settings → Trusted Publisher → GitHub Actions: org `arnaudjnn`, repo `billing-tools`, workflow `release.yml`). There is **no `NPM_TOKEN`** — CI authenticates via OIDC (`permissions: id-token: write`). Because `@semantic-release/npm` cannot do token-less OIDC yet, it runs with `npmPublish:false` and the real publish is an exec `prepareCmd`, which runs *before* the commit/tag so npm and the git tag can never desync.

Three traps. The first two are asserted in `test/conventions.test.mjs`, which also records why each setting looks removable and is not: `npmPublish:false` plus the `npx --yes npm@latest publish` exec (OIDC needs npm ≥ 11.5.1, and `node_modules/.bin/npm` shadows it), and the absence of `registry-url` in `setup-node` (it writes an empty `_authToken`, so npm tries broken token auth and skips OIDC). The third cannot be tested: **GitHub Actions flakiness is not your bug** — jobs stuck `queued` with `runner_name: null`, or an internal error mid-run, are transient even while the status page reads "operational". Cancel and re-trigger; publishing in *prepare* makes it harmless, since a killed job leaves no tag to reconcile.
