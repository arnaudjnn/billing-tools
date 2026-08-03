# billing-tools — agent orientation

**Purpose:** make any **Stripe + WorkOS** app ready to get paid. It packages API-key auth (WorkOS magic-auth → workspace + `sk_` key) and credit billing (Stripe) as MCP tools + a REST API + a CLI, with storage pluggable behind one adapter. WorkOS is assumed (the common auth substrate); a database is **not** — the app decides where workspaces/keys/billing-pointer live.

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
- **Idempotency on money.** Pass a stable Stripe idempotency key on every credit an event can replay (`grantCredits(..., idempotencyKey)`, the welcome bonus). Do **not** add one to `deductCredits` (each debit is a distinct charge) or to Checkout creation (it would block a legitimate repeat purchase within Stripe's 24h key window).

Deliberate exceptions (already SDK-first everywhere else — don't "fix" these):
- `WorkOSOrgAdapter.setSubscription` hand-merges org metadata: WorkOS's metadata update *replaces* the whole object and the SDK offers no partial-merge.
- `pollWorkOSEvents` walks pages by hand: `events.listEvents` returns a plain `List`, not an `AutoPaginatable`.
- **Event polling instead of webhooks** (`events.ts`): a product choice (zero webhook secret, zero dashboard).
- `invitations.accept` reimplements acceptance via `createOrganizationMembership` + `revokeInvitation`: WorkOS's own accept needs the invited user's session.
- `auth.ts:enforceAccess` emits the literal `"Unauthorized (401)"` string the REST/MCP route factories pattern-match downstream — a cross-layer wire contract.

## The tool surface, and the parity rule

**31 tools.** Keys (3) · wallet (4) · invoices (4) · usage (2) · seats (2) · top-ups (5) · plans (1) · billing account (6) · lifecycle (4).

**The rule: anything the app's own UI can do, an API / CLI / MCP caller can do too.** REST and MCP get this structurally — `createDispatcher` monkey-patches `server.tool`, so every registered tool is an endpoint with no extra wiring — and `test/surface.test.mjs` asserts the tools exist and that `BILLING_TOOL_NAMES` matches what registration actually produces. The CLI is hand-written and covers 30/31 (`buy --quote` is `preview_credit_purchase`); `get_api_key` is the exception, because the `auth` command already performs that flow.

This was NOT true before the audit: plan changes, payment methods, the billing profile and the tax id existed as library functions and as app UI and as nothing else. When adding a capability, register the tool in the same change — a function reachable only from a React component is the failure mode this rule exists to prevent.

`registerBillingTools` gates two groups: `profileTools` (default on) and `subscriptionTools` (default on when `plans` is set), so an app that keeps plan changes in its own UI can pass `false`.

## Changing plan mid-cycle — what the customer is charged

Measured, not assumed (`scripts/e2e-proration.mjs`, test clock, Pro €18/mo → Premium €90/mo on day 15 of 30):

| | charged today | next invoice |
|---|---|---|
| **upgrade, deferred** — `proration: "next_invoice"` (default) | nothing | **€127.16** = −€9.29 unused Pro **+** €46.45 Premium remainder **+** €90 next month |
| **upgrade, immediate** — `proration: "invoice_now"` | €37.16 | €90.00 |
| **downgrade** — `timing: "auto"` → period end (default) | nothing | €18.00 |
| **downgrade now** — `timing: "now"` | nothing | €18.00, with the unused remainder credited |

**The customer pays the same in both upgrade cases** — €37.16 either way, only the timing differs. The unused part of the old plan is always credited back; that is the `−€9.29` line, and `previewPlanChange` reports it as `credit`.

**Why deferred is the default.** Billing immediately means taking a payment, and a payment can be challenged by SCA. `always_invoice` + `pending_if_incomplete` then leaves the upgrade *not applied* until the customer completes the challenge, and the pending update expires in ~23h — an upgrade that silently doesn't happen is worse than a larger invoice, especially for a European consumer app. The cost of deferring is the surprise: the next invoice is €127.16, not €90. That is why `previewPlanChange` returns **`nextInvoiceTotal` AND `nextInvoiceAt`** — quote both and it stops being a surprise. Apps that prefer the industry-common immediate charge pass `proration: "invoice_now"`.

**Why a downgrade credits nothing.** It takes effect at the period end, so the customer keeps the tier they already paid for and loses nothing — there is nothing to refund. This is Stripe's own recommendation and near-universal SaaS practice. `timing: "now"` gives the alternative (drop immediately, credit the remainder), which is worse for the customer on features and leaves a credit balance that auto-applies to a later invoice — the exact mechanism behind the grant-vs-cap defect above.

`previewPlanChange` shares `desiredPrices` and `diffItems` with `changePlan`, so the quoted number is the charged number. Pass it the **same** `proration` you will pass to `changePlan`, or you are quoting a different policy from the one you apply.

## Who is calling — org vs principal (`src/auth.ts`)

Every call resolves to an **org**. An org API key means exactly that: the org, with no person behind it, which is what a headless agent holds. So org-keyed calls are owner-level, deliberately and unchanged.

A surface that DOES know the human — a server action, an OAuth token minted for a user — wraps the call in `runWithPrincipal({ authHeader?, orgId?, principal: { userId, isAdmin? } })`. Admin-only tools then call **`enforceAdmin(adapter, action)`**, which is `enforceAccess` plus `adapter.isAdmin` when a principal is present. `approve_top_up`, `deny_top_up` and `assign_seat_type` use it, and `request_top_up` lets a known non-admin request only for themselves (`member_id` arrives from the caller; unchecked, a member could queue grants against anyone's seat for an owner to rubber-stamp).

Two deliberate fallbacks, both "allow": no principal (the org-key case above), and an adapter with no `isAdmin` — silently disabling every management tool for adapters without a role concept is a worse failure than the one being prevented. Consequence worth knowing: with only org keys in play, the API is as permissive as it was, and the app's own UI gate is still what separates a member from an owner. **Extension point:** an OAuth path that can identify the user should resolve a principal alongside the org and pass it here.

## Metadata is a budget, and a per-member record does not fit in it

WorkOS org metadata is **10 keys, keys ≤40 chars, values ≤600, ASCII**; Stripe customer metadata is 50 keys × 500. Both are for a handful of stable attributes, and the library treats them as a **budget measured in characters** — not in records.

**Never bound a packed value by a record COUNT.** `topUpRequests` was capped at 50 records in a value that holds 3 (measured: 175 chars per request, 222 for an admin grant carrying `grantedBy`), and `topUpGrants` packed `member → cycle → credits` into one value that overflowed at the **12th member** while pruning no cycle ever. Neither failed in a test, because the test fake accepted any string. `test/helpers.mjs` now enforces the real limits, and anything packed into a value is trimmed against `METADATA_VALUE_LIMIT` — the same unit the store rejects on.

**The blast radius is the whole org, not the record.** `setOrgMetadata` and `setSubscription` both re-write the entire metadata object, so ONE oversized value fails *every* metadata write for that org — a long enough top-up history stopped `past_due` from being recorded.

**So a per-MEMBER record goes on the member.** `adapter.getUserMetadata` / `setUserMetadata` (optional; the shipped `WorkOSOrgAdapter` has them) give each member their own budget, which removes the ceiling instead of raising it. A grant is stored `{ [orgId]: { [cycle]: credits } }` — keyed by org because WorkOS user metadata is global to the user and a grant is only good where it was given, and pruned to the cycle being written because `extraAllowance` only ever reads the current one. An adapter without those methods falls back to the org blob, keeping today's behaviour and today's ceiling. Reads fall back too, so a grant approved by an earlier version still applies mid-cycle.

Correctness and history are trimmed differently: a request queue may drop **settled** records to make room, never a pending ask, because losing history costs a UI a row while losing a grant costs the customer allowance they were promised.

**`seatAssignments` (`seats.ts`) had the identical defect** — `member → seatType` at ~43 chars, overflowing at about 13, on the one plan shape whose premise is many seats — and is fixed the same way, with two differences worth knowing. A seat is **never trimmable**: dropping an entry silently downgrades a member to the default pack, so the new path does not write the legacy value at all rather than repairing it, which is what lets an already-oversized org be assigned into. And a cleared seat writes a **tombstone** (`""`) instead of deleting, because the legacy map is still read as a fallback and a plain delete would read back as the *old* seat.

Enumerating a per-member record needs `adapter.listMemberIds` (`WorkOSOrgAdapter` lists active memberships; `memberCount` now derives from it). Without it `listSeatAssignments` returns what the legacy map holds — everything an adapter with no per-member store has anyway.

## Cycles — one definition (`currentCycle`)

Anything that files something against a billing cycle must key it with `currentCycle(adapter, {orgId, plans, plan})`, the same window the meter reads. This is not stylistic: `request_top_up` used to write a calendar month while the meter read the subscription period, so for **every org with a subscription** an approved top-up granted nothing, with no error anywhere. There is now exactly ONE key — `extraAllowance` reads the cycle it is given and nothing else, so a grant is visible under the window the meter is in or it is not visible at all. Do not reintroduce a second key to read as a fallback: the reason the defect was invisible is that a miss looked like "no grant" rather than an error.

## Counting usage — the composite counts it in Stripe (`src/usage-ledger.ts`)

Usage counting is separate from moving money, behind one seam: `UsageLedger` (`record` + `total`). Four implementations ship, and **which one is wrong depends on the QUERY, not on the config** — which is why the default is a composite that routes:

| | sees INCLUDED usage | per-member | needs a DB |
|---|---|---|---|
| **`stripeUsageLedger()`** (default) | yes | org-wide + wallet-funded | **no** |
| `stripeBalanceUsageLedger()` | **no** | yes | no |
| `stripeMeterUsageLedger()` | yes | **no** | no |
| `postgresUsageLedger(db)` | yes | yes | yes |

`stripeUsageLedger` dispatches on whether the query carries a caller filter:

- **an ORG-wide window** (`cap: pool`, `scope: "org"` limits, the spend limit) → the **Stripe meter**. It sees every call, included ones too, and a summary is ONE request for any window width. This is the leg that removes a database: a 200 000-credit weekly window costs the same read as a 400-credit one.
- **a PER-CALLER window** (a seat pack, `scope: "caller"` limits) → **balance transactions**, which carry the caller on their metadata. Exact and per-member, but they only exist where money moved.

Every metered call is one `record`; every window is one `total`. The rule at the call site is **`record` always, `deductCredits` only when the wallet funded it** — an included call must be counted (or its cap can't be enforced) but must not be charged. The composite's `record` writes the meter event *and* forwards to the per-caller leg (a no-op for balance transactions, the write for a store); it never moves money, because `deductCredits` owns that.

**So a store is needed for exactly one thing: a window that is both INCLUDED and PER-MEMBER.** Nothing in Stripe can count that pair — a balance transaction carries the caller but only exists where money moved, and a meter summary sees every call but cannot be filtered by one.

**A ledger declares what it can count, and ONE rule reads that declaration.** `UsageLedger.covers` is a `LedgerCoverage` (`orgIncluded` / `callerIncluded`); `coverageNeededBy(model)` says what a plan requires and `ledgerGaps(models, covers)` returns the plans that don't fit, split by axis because the two have different fixes (an org-wide gap is closed by the meter, with no store; a per-caller one needs a store). `createMeter` warns at boot through `warnLedgerGaps`, and `checkPlansConfig(plans, { usageLedger })` makes the same finding an **error** — a warning in a deploy log is missable and a month of unenforced caps is not recoverable. Pass the ledger's own `covers` there; the old `boolean` still means "a per-member store is wired". (Omit it and the check is skipped — undefined means "the caller did not say", not "nothing is wired". A ledger that declares no `covers`, i.e. a consumer's own, is silent for the same reason: an invented `false` would fail a config that is perfectly wired.)

**The rule is written once because the two copies had already drifted.** The boot warning and the doctor both used to ask only about PER-MEMBER windows, so a POOLED plan metered by a wallet-only ledger passed every check while counting nothing — and `createMeter` defaulted to `stripeBalanceUsageLedger()` while `createBilling` defaulted to the composite, so which entry point composed the app silently decided whether included usage was counted at all. There is now one default (`defaultUsageLedger()`, read by both) and one rule.

**A pool costs nothing to count.** `cap: pool` — including `perSeat`, below — plus org-scoped limits is a config that runs with **no store at all, at any volume**. That was impossible before: the old default was the debits themselves, so an included call counted as 0 and every window read 0% forever.

**`orgWide` is a seam too**, and the one most likely to move: Stripe's Meter Usage Analytics API answers the same question grouped by a dimension (`caller_id`), so when it leaves preview it belongs there — and the per-caller leg can point at it too, at which point the store disappears entirely.

**Pairing a store with the composite beats the store alone.** `stripeUsageLedger({ perCaller: postgresUsageLedger(db) })` — which is what `meter.db` now builds — keeps exact per-member figures while answering every org-wide window from Stripe, so those reads stop scanning rows.

## Counters, not events, when the per-member store has to scale (`src/usage-counters.ts`)

`meter.counters` is the scale-correct per-caller leg, and the only one that needs no SQL.

**Why.** Every read here is `sum(cost) where org, [start, end), caller?` over a FIXED, UTC-aligned window. `usage_events` answers that by aggregating a range on the hot path of every metered call, over a table that grows by one row per call forever — at an Enterprise window of 200 000 credits a week, millions of rows a month whose only purpose is to be summed back into a handful of integers. `usage_counters` keeps **one row per (org, scope, hour)**: a caller making a thousand calls in an hour writes ONE row, every read is a point lookup, and the row count is bounded by time rather than traffic.

**Why hourly buckets rather than a counter per declared window.** A counter keyed by the plan's own windows would be smaller, but `record` would have to know which windows exist — and a window it failed to bump is usage counted by nothing, which reads 0% and refuses no one. Bucketing at a fixed grain means `record` needs no plan knowledge: it bumps the bucket the event falls in, `total` sums the buckets its window covers, and a window added to the config later is answerable retroactively. An hour is the grain because `every: "hour"` is the tightest window the model can express; a month is then at most 744 keys in ONE batched read.

**The contract is that both paths derive the same scope string** (`scopesFor` on write, `scopeOf` on read → `org` / `k:<kind>` / `u:<memberId>`). A read that computed a different one would look up a counter nobody writes and report 0 forever — the same silent-generosity failure the coverage rule exists to catch. One event increments every scope it belongs to, so an org-wide read and a per-member read both see it.

**Backends.** `sqlUsageCounters(pool)` (one `unnest` upsert per call, `used = used + excluded.used` as the atomic increment, `ANY($1)` on the primary key to read) reuses the database you already have; `redisUsageCounters(client)` needs none (`redis`, `ioredis`, `@upstash/redis`, Vercel KV all satisfy the duck type — `incrby` + `mget` + optional `pexpireat`); `memoryUsageCounters()` is for tests and single-process dev only, since separate instances would each allow a full window. `ensureUsageCountersTable` / `USAGE_COUNTERS` / `pruneUsageCounters` mirror the event-log helpers.

**Atomic increment is the requirement that decides where this can live.** Redis and Postgres have one; Stripe and WorkOS metadata do not, which is why counters cannot go there — two concurrent metered calls would both read `n`, both write `n+1`, and one call would vanish.

**What counters give up: the audit trail.** They cannot say WHICH actions made up a total, or when inside the hour. `postgresUsageLedger` keeps that and stays right for a consumer who wants per-action history — both satisfy the same seam, so a deployment can write to both. Clamping is deliberate too: a window wider than `maxKeysPerRead` reads the most RECENT slice, under-reporting rather than over-granting, because refusing early is recoverable and handing out unpaid-for allowance is not.

```ts
createBilling({ adapter, config, plans, meter: { rateCard, db: pool } })
// once, from your migrations:
await ensureUsageLedgerTable(pool)   // or paste USAGE_EVENTS into your own tool
```

`db` is duck-typed — anything with `query(sql, params) → { rows }`, which `pg`'s Pool/Client and Neon's driver already satisfy — so **this library depends on no database driver**. `ledger` still wins if you bring your own store.

**Why a table at all for the per-member case, when everything else here is Stripe-backed.** Because no metadata store can do it, and each was checked: Stripe customer metadata holds 50 keys, WorkOS organization metadata holds **10** (keys ≤40 chars, values ≤**600**, ASCII), and *neither has an atomic increment* — counting would be read-modify-write, so two concurrent metered calls both read `n` and both write `n+1` and one disappears (Stripe idempotency keys explicitly do not cover concurrent conflicting requests). Stripe Billing Meters can't help either: `listEventSummaries` takes only customer + meter + time window + an hour/day bucket, with no dimensions and no group-by, so a per-member question returns the whole org. A meter per member is unbounded against an account-level cap, and zero-amount balance transactions would write junk into the customer's *money* ledger — the history that backs invoices. Metadata is for a handful of stable attributes; usage is an append-only event stream. Hence one row, one index-covered `SUM`.

## Spend controls — the customer's own ceiling (`getSpendControls`)

A monthly ceiling on what a customer may CONSUME, plus the thresholds they want warning at. Both live on the customer's Stripe metadata beside auto-reload (`spend_limit_credits`, `spend_alert_credits`), because all three are billing preferences the customer owns rather than plan config — a handful of stable values, which is exactly what metadata is for.

The ceiling is **not a new gate**. It funds nothing and only refuses, which is what `state.limits` already models, so it rides the existing path: `resolveAllowance` reports it as one more `LimitState` (`kind: "spend"`), `fundingFor` checks it in the same loop, `describeDenial` writes the message. The read joins the same parallel round as every rate-limit read and comes off the customer object `getCreditBalance` already retrieves, so enforcement adds no round trip to the meter's hot path.

Two things are deliberately distinct from a rate limit:

- **`spend_limit_reached`, not `rate_limit_reached`.** A plan's rate limit is the product's and the customer must wait; this one is theirs and they can raise it, so the message says so. Telling them to wait would be wrong.
- **Plan limits are reported first.** When both refuse, the one the customer *cannot* lift is the more useful thing to be told.

The window is the **calendar month**, even for an annual subscriber: "monthly" is what the customer set, and the plan cycle would make that window a year wide. A cleared limit writes `""` (the Stripe metadata clear) and never `"0"`, which would read back as a ceiling of zero and refuse every call in the workspace; junk metadata means "no ceiling" for the same reason.

**The ceiling sees exactly what your ledger sees.** On the default ledger it counts wallet-funded calls only — correct for a wallet-only product, and blind to included usage otherwise. That is the same reason to pass `meter.db` as above.

## Tax — the library calculates it, Stripe Tax is opt-in

**`src/tax.ts` is the default path, and it is not Stripe Tax.** `resolveTax` works the rate out locally from `sales-tax` (a real dependency) with VIES for B2B validation, and `taxRatesFor` applies the answer as an explicit Stripe **TaxRate** on the line items — no per-transaction fee, and no registrations needed to *calculate*. `updateCheckoutSessionTaxRates` re-taxes an open session when the typed country differs from the one guessed, which is the piece Stripe Tax would otherwise do. What you take on instead: evidence-of-location records for EU B2C, threshold monitoring, and filing. The safe direction is already chosen — a tax number VIES cannot verify falls back to CHARGING tax, because wrongly charging is recoverable and wrongly exempting means owing it yourself.

**WHO calculates is declared ONCE, in `config.tax`, and every charge the library builds reads it** — the seat Checkout Session, the `buy_credits` top-up, and the auto-reload invoice. `taxFor(customerId, config.tax)` returns the `{ taxRates, automaticTax }` every charge site already took, so wiring it is one line per site and an explicit argument still wins.

```ts
config: { baseUrl, currency: "eur", tax: { origin: "IT" } }   // ← the whole tax config
```

`origin` (where YOU are established) selects `mode: "billing-tools"` on its own, because that country is the only thing the mode needs — it decides domestic vs cross-border, which is the whole question a VAT rate turns on. `mode` overrides what `origin`/`automatic` imply; `rates` stays the authoritative hook for an app that resolves from its own records (and it is per-ORG, which `config.tax` cannot express — hence `topUp.taxRates` too). `taxModeOf` is the one place the precedence lives.

**Why one declaration.** Per-site tax arguments meant the tax an account applied depended on which call sites the app had got round to wiring, and the answer to "does this deployment charge VAT" lived in as many places as there were charges. That is exactly how the auto-reload and the top-up went out at 0% while every seat invoice on the same account charged 22% IVA: nothing was wrong at any one site, there was simply no single place that said what the account does. `checkBillingSetup({ config })` reads the same field rather than being told again, so the doctor cannot disagree with the engine.

Under `"billing-tools"` the rate comes from the CUSTOMER — their Stripe address decides the place of supply, their tax id decides reverse charge. A customer with **no address on file is charged the DOMESTIC rate, not nothing**: the same direction `resolveTax` takes for a VAT number VIES can't verify, because over-charging is recoverable and under-charging means owing it yourself. On a seat checkout the address isn't typed yet, so the domestic rate goes on at creation and the browser re-applies through `updateCheckoutSessionTaxRates` once it exists.

**Nothing enables Stripe Tax implicitly.** `automatic_tax` is set only where the caller passed `automaticTax: true` (or `config.tax.automatic` for the charges the library raises itself). It used to be inferred from the ABSENCE of `taxRates`, which made it the default for every caller that passed no tax at all — and that is the expensive way round: with no active registration Stripe Tax returns **zero** tax rather than an error, so the total silently drops to the pre-tax amount on precisely the accounts that never opted in and therefore never registered. Passing neither now means an untaxed charge: right for an account that charges no tax, and loud enough to notice for one that does. Manual rates and `automatic_tax` stay mutually exclusive — Stripe rejects both together.

`checkBillingSetup({ taxMode })` names WHO calculates, not how it feels: **`"billing-tools"`** (the default — the same spelling as the `managedBy: "billing-tools"` marker on everything this library mints) reports which TaxRates exist, which is the audit trail of what the account has charged and legitimately empty on a fresh one; `"stripe"` audits the head office, the registrations and `tax_behavior`; `"none"` skips tax. The mode matters because auditing Stripe Tax on a `billing-tools` account reports errors for things that account has no reason to hold. `ensureTaxSetup` exists for consumers who do want Stripe Tax and is explicit-only.

### Tax on charges the library raises itself

A subscription is taxed by whoever builds its Checkout Session. Two charges have no session: the **auto-reload invoice** and the **top-up** bought through `buy_credits`. Both were untaxed — an account charging 22% IVA on seats invoiced 0% on a top-up. Now `config.tax.rates(customerId)` (or `automatic`) covers the auto-reload, and `registerBillingTools({ topUp })` covers `buy_credits`. Manual rates and `automatic_tax` are mutually exclusive — Stripe rejects both together. `createCreditCheckoutSession` takes `uiMode: "embedded"` to return a `ui_mode: "elements"` client secret instead of a hosted URL, so a top-up can render its card fields in a dialog through the same `BillingCheckoutSessionProvider` the seat checkout uses (a customer with a saved card is offered it rather than retyping). Hosted stays the default: a redirect needs no Stripe.js on the page and no publishable key wired, and silently moving every consumer's top-up flow is not a minor release.

`quoteCreditPurchase(amount, taxRateIds)` is the READ side of the same charge, for a "credits / estimated tax / total due" dialog: it reads the same Stripe TaxRate objects `createCreditCheckoutSession` will carry, so the quoted number is the charged number (`preview_credit_purchase`, or `buy --quote`). INCLUSIVE rates leave the total alone — that is what inclusive means — and several rates round ONCE on the summed percentage, because rounding each and adding drifts a cent from Stripe's own total.

Auto-reload bills as an **invoice**, not a PaymentIntent: a receipt is not a valid sales document, and it is the one purchase the customer never confirms. It carries an idempotency key per customer/target/hour because the meter fires it, fire-and-forget, on every metered call.

## Agent auth — auth.md (`src/agent-auth/`)

`createAgentAuth({ adapter, config, branding, paths?, identityTypes?, baseUrl?, claimStore?, policy? })` returns framework-agnostic `(Request)=>Response` handlers implementing the [WorkOS auth.md](https://workos.com/auth-md) agent self-registration protocol: `authMd` (the narrative), `protectedResource` (RFC 9728 PRM), `authorizationServer` (RFC 8414 + `agent_auth` block), `identity` (`POST /agent/identity` — `anonymous` + `verified_email`), `claim`, `token`/`handleClaimGrant` (the `urn:workos:agent-auth:grant-type:claim` polling grant), `revoke` (RFC 7009), and `wwwAuthenticate(req)` (the `Bearer resource_metadata="…"` value). Everything flows through the **adapter + magic-auth + shared getWorkOS** — no direct WorkOS calls. Base URL derives from the request's forwarded host/proto by default (works behind any proxy) or an explicit override. `anonymous` needs `adapter.createAnonymousOrg` (WorkOSOrgAdapter ships it; mirror apps that need a workspace row should omit `anonymous` from `identityTypes`). Claim state is a pluggable `ClaimStore` (default `inMemoryClaimStore`, sha256-at-rest, 10-min TTL; inject Redis/DB for multi-instance). Mount the REST/MCP factories with `resourceMetadata` so every 401 advertises the PRM discovery doc. Humans keep using magic-auth + Checkout; this is the headless-agent path.

## Machine payments — MPP (`src/machine-payment/`)

The **payment** sibling of auth.md: Stripe's [MPP](https://mpp.dev) (Machine Payments Protocol) — a client hits a paid resource, gets **HTTP 402 + `WWW-Authenticate: Payment` challenge** + `application/problem+json`, pays (SPT card or crypto/USDC), retries with a credential, gets the resource + receipt. `createMachinePaymentHandler({ methods?, amount, currency?, networkId?, payToAddress?, settle?, onPaid? })` → `requirePayment(request)` returns a 402 `Response` or `{paid:true,…}`. `createPaymentMd(...)` serves `/payment.md` (the agent-facing how-to). **Settlement is pluggable + gated:** the 402 challenge + credential parsing are fully implemented + offline-testable, but the actual charge is injected via `settle` (provide it once the Stripe account is machine-payments-eligible — Stablecoins/Crypto approval, or a US entity for SPT). Without `settle`, the handler keeps 402-ing with a clean "settlement not enabled" note (never a 500). Validate the challenge shape with `mppx validate`; reference impl `github.com/stripe-samples/machine-payments`. Multi-method 402s combine into one comma-joined `WWW-Authenticate` header (Fetch Headers behavior) — the parseable source of truth is the `accepts[]` array in the JSON body; default to a single method for a clean header.

**Dunning / past_due** is reflected via the polled `customer.subscription.updated` **and** `invoice.payment_failed` events (→ `adapter.setSubscription("past_due")` + the `hooks.onPaymentFailed(orgId)` sync hook — use it to notify/gate the user). Stripe **Smart Retries** + the card-updater handle the actual retries (Dashboard config, no code).

**Self-serve billing:** `createBillingPortalSession(customerId, returnUrl)` + the `get_billing_portal` tool return a Stripe Billing Portal URL where customers manage their subscription (upgrade/downgrade/cancel), fix a failing card, and view invoices — the no-code self-serve surface. **What the payment forms offer is a library default, not an app decision** (`payment-method-config.ts`). Every form the library builds — the add-card SetupIntent, the subscription Checkout Session, the `buy_credits` one — resolves `defaultPaymentMethodConfig(kind, config)` when the caller names no `paymentMethodConfiguration`, and the answer is **card + Apple Pay + Google Pay, nothing else**.

Wallets are in because they are not another way to pay: Apple Pay and Google Pay ARE the card with the typing removed. They are forced ON rather than inherited, so they don't depend on remembering a Dashboard toggle.

**Everything else is out, deliberately, and the wider version was tried first.** For a charge this briefly inherited every method the account had enabled (`enable` the wallets, `disable` Link) on the reasoning that a charge should offer whatever the Dashboard offers. What it produced on a live subscription checkout was a tab row — Carta, Klarna, Amazon Pay, Satispay — in front of every customer of an app that had always shown one field. A method reaches a customer because someone chose to sell that way; inheriting it from a toggle is not that choice. An account that does sell via SEPA or iDEAL passes its own `paymentMethodConfiguration`, or an explicit `paymentMethods` list on checkout.

**Link is off, and that default is the point.** Link's inline signup ("Save my info for faster checkout") is drawn by the Payment Element from the **account's** Link setting, so it survives both `wallets.link: "never"` (that only removes the Link *wallet*) and `payment_method_types: ["card"]`. A payment-method configuration is the only lever, obscure enough that leaving it to each consumer meant every app shipped the signup by accident. `config.paymentMethods.link = true` opts back in (no configuration is imposed at all). The Element side — `layout: {type:"tabs"}` so a single method renders bare card fields instead of a "Card" accordion header — is already unconditional in `src/ui`.

`ensurePaymentMethodConfig` takes `only` (exactly these) / `enable` (these on top of the account's) / `disable` (these off), is memoised per process and idempotent by `name`. `defaultPaymentMethodConfig` **never throws**: a restricted key that cannot read or write configurations returns undefined and the form renders with the account default, because a missing permission must not take down checkout.

## Mounting in a Next app

**One-call:** `createBilling({ adapter, config, plans?, toolCosts?, registerTools?, agentAuth?, webhook?, machinePayment? })` (`src/create-billing.ts`) returns `{ mcp, restList, restDispatch, webhook, agentAuth, machinePayment, paymentMd }` from a single module instance (shared AsyncLocalStorage). It's pure sugar over the factories below (all still exported); `registerTools` registers the app's own product tools alongside the billing tools, passing `agentAuth` auto-wires `resourceMetadata` onto the REST/MCP 401s, and passing `machinePayment` (a `MachinePaymentOptions`) returns the MPP `requirePayment` handler + a `/payment.md` handler (`paymentMd`, branded from `agentAuth.branding.productName`). Or wire the factories by hand:

- **MCP** `app/[transport]/route.ts`: `createMcpTransport({ adapter, config })`.
- **REST** `app/api/v0/route.ts` + `app/api/v0/[tool]/route.ts`: `createToolListHandler({toolCosts})` / `createToolDispatchHandler()`.
- **Webhook** `app/api/stripe/webhook/route.ts`: `createStripeWebhookHandler()` (grants credits on `checkout.session.completed`; raw body — exclude from any session middleware).
- Register tools once: `registerBillingTools(server, { adapter, toolCosts, config })`.

## CLI

Two different CLIs, for two different people. **`registerBillingCommands(program, { configDir: "~/.myapp", envPrefix: "MYAPP", defaultUrl })`** is the CUSTOMER's: it adds `auth`, `keys list|revoke`, `balance`, `buy`, `invoices`, talks to the app's REST API with an org API key, and persists to `<configDir>/config.json` (chmod 600).

**`npx billing-tools <command>`** (the package's own `bin`) is the DEVELOPER's, and talks to Stripe with the secret key. It carries only what needs no app config:

- **`dev`** — `startLocalWebhooks()`: fetch the Stripe CLI into `~/.cache` if absent, `stripe listen --api-key` (no `stripe login`, no tunnel, no registered endpoint), and write the session's `whsec_` into `.env.local`. The dotenv write is the point: `stripe listen` mints a NEW secret per session and the dev server is a different process, so a file is the only channel both see.
- **`doctor`** — `checkBillingSetup` + `formatDoctorResult`, exiting non-zero on an error so it can gate CI.

## Setting up an environment (`setupBilling`)

The deploy-time twin of the lazy provisioning, and the honest scope of it is small: prices, the payment-method configuration and the usage meter all provision themselves from the key on first use, so `setupBilling({ config, plans, webhookUrl, stripeTax? })` exists for the two things that genuinely cannot, plus the reporting.

- The **webhook endpoint**, because Stripe returns its signing secret exactly once, at creation — no request can put that in your env store. `formatSetupReport` prints it as a `STRIPE_WEBHOOK_SECRET=…` line, only on the run that created it.
- **Tax registrations**, because only a human knows where the business collects — and skipped unless `config.tax` mode is `"stripe"`, since running it on a `billing-tools` account would create registrations it doesn't need and is billed against.
- Everything else runs only because a deploy log is a better place to find a broken config than a customer's first request.

No step throws: each failure is reported and the rest continue, because a missing tax registration must not stop the webhook from being registered, and four outcomes beat the first exception. A skipped step renders `–`, never `✓`. The doctor runs last, so it sees what was just provisioned — `setupBilling` provisions, `checkBillingSetup` decides whether it worked, and they are separate claims.

It needs the app's `plans`, so it stays a function the app calls from a script (`tsx scripts/billing-setup.ts`) rather than a bin subcommand — only the app knows its catalogue.

## Plan shapes (`src/plan-model.ts`)

A plan is FIVE independent axes, not one. Only `sells` is a union, because it alone decides which fields are required and what `ensurePlans` mints:

| axis | values | what it decides |
|---|---|---|
| `sells` | `nothing` \| `seats` \| `flat` | what Stripe charges for (and what gets minted) |
| `grant` | `none` \| `purchased_seats` \| `per_member` \| `fixed` | what is CREDITED as money on `invoice.paid` |
| `cap` | `wallet` \| `per_seat` \| `pool` (flat `credits` or `perSeat`) | what is INCLUDED, as a counted window |
| `replenish` | `{purchase?, autoReload?, request?}` | how to get more (a record — they compose) |
| `sale` | `free` \| `self_serve` \| `quote` \| `legacy` | whether it can be bought. **Required, never inferred** |

Plus `limits.members`, `limits.rate` (below), and `display` (name/tagline/features/badge/cta/pooled) so one config drives every pricing surface.

**`limits.rate` is a sixth axis, and it is NOT `cap`.** `cap` is the commercial ceiling, measured over the billing cycle; it cannot say "no more than 300 in a week", so a month of allowance spent in one afternoon sits inside the cap and is still not what was sold. A plan therefore declares any number of `{ every: "hour"|"day"|"week"|"month"|"cycle", credits, scope?: "org"|"caller", seatType?, label? }`, all enforced together — a call must fit inside **every** one. Rate limits are checked FIRST in `fundingFor` and are absolute: they fund nothing, never fall through to the wallet (a limit a top-up could lift is not a limit) and — unlike an exhausted `cap` — a `shared`/`api` caller does not escape them, because what is being protected is the product, not the customer's money. The denial is its own reason, `rate_limit_reached`, carrying `retryAt`: it is the one refusal that fixes itself, so the caller is told when rather than told to buy.

Windows are **fixed and UTC-aligned** (top of the hour, midnight, **Monday**, the 1st) via `rateWindowFor`, not rolling. A rolling window needs every event's timestamp and cannot be answered by one summed read, which is what both the hot path and a usage screen get to do here; a fixed window is also the only kind that can honestly state when it resets. `every: "cycle"` defers to the subscription period. Each applicable limit is one more ledger read, issued in the SAME parallel round as the pool and pack, so three limits cost the meter latency rather than three times it. A limit can be narrowed to one seat type (`seatType`) or to one KIND of caller (`callerKind: "user" | "api"`) — the pace a person sustains and the pace a script does are different problems, and before `callerKind` the only way to separate them was a dedicated `shared` seat to hang `seatType` off. A plan that funds API usage from the wallet has no such seat, so both limits landed on every caller and the tighter one made the other unreachable. `checkPlansConfig` rejects a zero limit and warns when a wider window is no larger than a narrower one **that can reach the same caller** (its window can never be reached), or when an org-scoped limit sets a `seatType` that is therefore ignored.

**Reading usage is `src/usage.ts`**, the read side of the same arithmetic: `usageSummary(adapter, config, {orgId, plans, plan, caller?})` → every window with `used`/`remaining`/`percent`/`resetsAt` plus pool, pack and wallet, and `memberUsage(...)` → the per-member breakdown an admin view needs (N summaries in parallel: the ledger has no group-by, so cache it rather than rendering it per request). Both go through `resolveAllowance`, deliberately — a screen that computed its own numbers would eventually disagree with the gate, and the disagreement would be invisible until a customer was refused at 60%. Agents get the same thing from `get_usage_limits`. The library ships **no strings**: a UI localises from `every` (or the plan's own `label`) and formats `resetsAt` itself.

A summary with a caller also reports **`seat: {type, label}`** — which seat that member holds and the plan's own word for it (`SeatTypeDisplay.badge`, else `label`, resolved for `locale`). It is deliberately independent of `pack`: `pack` is an allowance, so a pooled or free plan had none, and every member of one was reported as `standard` — a seat type such a plan does not even declare. A plan that sells no seats names the seat it gives with **`seat: { key, display }`** on the plan (ignored when `sells.kind === "seats"`, where the sold types are the seat types); `resolveSeat(model, type, locale)` is the same lookup, exported for surfaces other than the usage screen.

**`grant` vs `cap` is a money bug, not a preference.** A Stripe credit balance auto-applies to the customer's next invoice and cannot be opted out of — measured: granting 1000 credits to a customer on a €21.04 seat produced `starting_balance: -1000`, `amount_due: 1104`. So an *included* allowance must never be credited; it is a `cap`, a window usage is COUNTED against (`src/allowance.ts`), and an annual package credited as money would invoice year two at zero. Credit stays for what a customer actually buys — a top-up. `checkPlansConfig` fails a plan that both invoices and credits.

Counting therefore has to be separable from charging: `src/usage-ledger.ts` is that seam, and the default is the composite (see above) — `stripeBalanceUsageLedger()` remains as the wallet-only leg, which can see nothing a subscription included. The rule at the call site: **`ledger.record` always, `deductCredits` only when the wallet funded it.**

**The Stripe meter provisions itself on first use**, like plan prices and the payment-method configuration: the one thing a deployment sets is `STRIPE_SECRET_KEY`. `record` resolves the meter before reporting to it (memoised per process; a meter event names its meter by `event_name`, so without that the first call on a fresh account reports into nothing), and the resolver **never throws** — it is on the hot path of every metered call, so a key that cannot create a meter degrades to windows reading 0 and says so once with `console.error`, rather than taking the product down. `ensureMeters` is the same call made eagerly for a deploy step, and it DOES throw, because a setup script wants to know.

**`cap.covers: "users"` says the included window belongs to PEOPLE.** A machine caller (`caller.kind: "api"`, or a `shared` seat) then gets no included allowance and is funded by the wallet from its FIRST call — "API usage is pay-as-you-go, 0 credits included". This is a different statement from `onExhausted`, which only says what happens once a window is spent: a machine caller already overflowed to the wallet there, but it spent the window first, so an agent drew a person's monthly allowance and could burn it in a minute. The window is SKIPPED rather than treated as exhausted, so `onExhausted: "block"` cannot refuse an agent over an allowance that was never included for it.

**A plan that advertises pay-as-you-go must be able to take the money.** `cap: wallet` (no window at all) and `onExhausted: "wallet"` both refuse every call past the allowance unless the customer can add funds, so `checkPlansConfig` warns when either is set without `replenish.purchase`/`autoReload`. The claim and the capability travel together.

`onExhausted` decides what a used-up window does: `"block"` refuses even when the wallet could pay (a committed package's overage is a renegotiation; a free plan has no wallet), `"wallet"` falls through so a top-up funds it. An agent (`shared` seat / `caller.kind: "api"`) always overflows to the wallet — that was a hardcoded `caller.kind === "user"` test, now declarative.

The window comes from the SUBSCRIPTION period, not the calendar month: an annual package measured monthly resets twelve times. Calendar month remains the fallback for an org with no subscription.

**`cap: { kind: "pool", perSeat: N }` is the rung between a flat pool and `per_seat`, and choosing it is an infrastructure decision as much as a commercial one.** "1 000 credits per seat per month" is what a pricing page says. `per_seat` additionally **enforces** it member by member — which is a stricter product than most teams sell, and the *only* cap shape that needs a per-member counter to gate, i.e. the only one that needs a store (see the ledger section). Pooled, the same promise is ONE org-wide window: `perSeat × seats`, shared, countable by a single Stripe meter summary at any volume with no store anywhere. The trade is fairness — one member can draw the team's share — so say `per_seat` when that matters and pool when it doesn't.

Seats are the **purchased** quantity (`getSubscription().seats`, recorded by the sync from the subscription's summed item quantities), falling back to the active member count, then to 1. Purchased rather than active deliberately: a workspace that bought ten seats and filled six paid for ten, and sizing on members would quietly hand them a smaller package than the page promised. `poolSizeOf(model, seats)` takes the count as an argument and defaults it to 1, so a caller that forgets it under-reports rather than over-grants — and a pricing surface with no org in hand gets the per-seat unit to display. Mutually exclusive with `cap.credits` (`checkPlansConfig` errors: `perSeat` wins, so the flat number would silently do nothing), and warned when the plan `sells: nothing` — there is no purchased quantity to multiply.

**`cap.window: "month"` is the exception, and it exists because a price and a window are different things.** A plan sold annually whose pricing page says "1 000 per seat **per month**" cannot be expressed by the default: one window per subscription period gives an annual subscriber twelve months' allowance on day one and nothing after it runs out. Declaring `window: "month"` measures the same pack over the calendar month whatever the billing interval. It is read inside **`cycleWindowFor`**, not at the call sites, so the meter, `usageSummary` and `grantExtraAllowance` all keep agreeing on one window — a grant written under a period key that the meter never reads is precisely the defect above. Mutually exclusive with `rollover` (which widens the window instead); `checkPlansConfig` errors on both.

**Backwards compatible.** The legacy `PlanDef` is unchanged and `normalizePlans` maps it; every function takes `PlanCatalog` (the supertype), so an existing `PlansConfig` passes as-is. `allowanceMode: "global"` maps to `cap: wallet`, **NOT** `pool` — it only ever meant "no per-seat cap", and mapping it to a pool would start blocking a live customer. No legacy config can produce `cap: "pool"`, so the new path stays dead until a config opts in. `allowanceMode`/`creditsPerSeat` are `@deprecated` and still work.

**Presentation** lives on the plan, and derives via `@arnaudjnn/billing-tools/pricing` (a leaf entry — no Stripe, no WorkOS, no React): `derivePlanViews(plans, {interval, currency, locale, formatMoney, currentPlan, canManage, hrefs})` → `PlanView[]`, which a React card and `renderPlansMarkdown`/`renderRateCardMarkdown` both consume. Note `price.headline` is a per-MONTH comparison figure and `price.totals` is what is actually charged — and `annualSaving` carries `annualSavingBasis`, because the two surfaces of the app this came from derived that percentage from different baskets and advertised 17% while charging 14%.

## i18n (`src/i18n.ts`)

Two kinds of text, two owners. **The library ships English and nothing else.**

- **App-authored** (plan name, tagline, badge, features, CTA label, pooled copy, seat labels, every compare title/label/text value) is `Localized` — a plain string for one language, or `{ en: …, fr: … }` for several. A plain string is unchanged from before, so a single-language config needs no edit. Resolution is exact tag → language subtag (`fr-CA` → `fr`) → `defaultLocale` (default `en`) and its subtag → first entry; that last step is deliberate, so a config keyed unexpectedly still renders something.
- **Library-authored** — the structural words it cannot avoid supplying: `Unlimited` in a members column, `Monthly`/`Yearly` in a derived billing-cycle row, generated markdown headers, `Contact us`, `Free`, and the refusal messages a customer reads. All of it is `DEFAULT_MESSAGES` (English), overridden per consumer via `messages` on `derivePlanViews` / `deriveCompareTable` / `renderPlansMarkdown` / `renderRateCardMarkdown`, and via the optional last argument of `describeBasketProblem` / `describeDenial`. Partial bundles are filled from English, so a missing key is never a blank string. Placeholders are `{name}`, substituted by `formatMessage`.

Money already localises through `Intl` (`locale` + `currency`), with `formatMoney` as the escape hatch for a house style Intl won't reproduce.

**Keep this package English-only** — including comments and examples. Consumer-specific wording belongs in the consumer.

## Changing a price, changing the currency

**A price is one edit.** Change the amount in `PLANS` and deploy: the next call mints a new Stripe price, transfers the `lookup_key` onto it, archives the old one and reuses the product; the `resolvePlanPrices` memo is keyed on the config, so nothing to flush. Verified end-to-end. But a Stripe price is IMMUTABLE and a subscription references one by id, so **existing subscribers keep paying the old amount** — `ensurePlans` will not silently reprice live customers. `migrateSubscriptions({ plans, plan, interval, dryRun })` is that step, made explicit: it walks the plan's superseded prices, moves live subscriptions (active/trialing/past_due/unpaid/paused) onto the current one preserving quantity and seat type, defaults to `proration_behavior: "none"` (new amount from the next renewal), only touches prices this library minted, and is idempotent. Do the dry run first.

**The currency is one edit for a NEW deployment and a migration for an existing one.** `config.currency` threads everywhere and the catalogue reconciles like an amount change (new prices in the new currency, old ones archived). What doesn't follow: `customer.currency` is pinned by whatever first touched the customer — for this library, the welcome credit — and cannot be changed. Stripe still accepts balance transactions in any currency, keeping a **separate running balance per currency**, while `customer.balance` stays a single scalar in the pinned one. So after a switch, debits land in the new currency and a blind read of the scalar reports the OLD balance, with no error anywhere. Hence `getCreditBalance(id, config.currency)` (every internal call site passes it; it reads that currency's balance from the latest transaction in it) and the doctor's `Customer currency` check, which samples customers and warns when they're pinned elsewhere — pass `currency` to `checkBillingSetup` or the check is skipped. Existing subscriptions also keep billing in the old currency until `migrateSubscriptions` moves them. Display formatting, VAT rate and tax-origin stay app-side.

## Env

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (auth + WorkOS-org adapter), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing), `REFRESH_TOKEN_SECRET` (OAuth proxy — signs refresh tokens; **required, no fallback**: an earlier version fell back to `WORKOS_CLIENT_ID`, a *public* identifier, so anyone who knew it could forge a 30-day refresh token. Without it the token endpoint returns `server_error` rather than signing with something guessable). `test/conventions.test.mjs` fails if the library reads one this list forgets. `BillingConfig`: `{ freeCredits=100, currency, baseUrl, internalDomains: string[] }`. With `STRIPE_SECRET_KEY` unset, billing tools report "not configured"; metering (`enforceCredits`) is skipped when `cost === 0` or Stripe is unset or the org is internal.

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

Three non-obvious traps, all learned the hard way. The first two are now **asserted in `test/conventions.test.mjs`** — which also records why each setting looks removable and is not: `npmPublish:false` + the `npx --yes npm@latest publish` exec (OIDC needs npm >= 11.5.1, and `node_modules/.bin/npm` shadows it), and the absence of `registry-url` in `setup-node` (it writes an empty `_authToken`, so npm tries broken token auth and skips OIDC).

The third can't be tested: **GitHub Actions flakiness is not your bug.** Jobs stuck `queued` with `runner_name: null`, or `"GitHub Actions has encountered an internal error"` mid-run, are transient GitHub-side even while the status page reads "operational." Cancel + re-trigger. Publishing in *prepare* makes these harmless: a killed job leaves no tag/Release to reconcile.
