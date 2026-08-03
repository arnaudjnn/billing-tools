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
└── util/clearout.ts         lookupCompany(domain) enrichment — OPT-IN, see below
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

  **Company enrichment is opt-in, and used to not be.** `ensureOrgForUser` names an auto-created org after the new user's email domain. It used to call `api.clearout.io` first, unconditionally — so every deployment using this adapter forwarded its customers' email domains to an unrelated third party, on the path that creates a workspace, with no env var to notice it by, no way to switch it off, and nothing here saying it happened. A nicer org name is not worth doing that silently on someone else's behalf. Pass `enrichOrg` to opt in — `new WorkOSOrgAdapter({ enrichOrg: lookupCompany })` is the same call made explicit, or supply your own resolver. Without it an org is named `acme.com` rather than `Acme`. `lookupCompany` also now carries a 3s `AbortSignal.timeout`: it is on the signup path, and "never throws" did not cover "never returns".
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

**The rule: anything the app's own UI can do, an API / CLI / MCP caller can do too.** REST and MCP get this structurally — `createDispatcher` monkey-patches `server.tool`, so every registered tool is an endpoint with no extra wiring — and `test/surface.test.mjs` asserts the tools exist and that `BILLING_TOOL_NAMES` matches what registration actually produces. The CLI is hand-written, and it is the one surface that can silently fall behind — so `test/conventions.test.mjs` asserts it reaches **every** tool. Coverage is per tool, not per command: `get_api_key` has no command of its own because `auth` performs that flow, `preview_credit_purchase` is `buy --quote`, and `set_spend_controls` is `spend limit` / `spend alerts`.

This was NOT true before the audit: plan changes, payment methods, the billing profile and the tax id existed as library functions and as app UI and as nothing else. When adding a capability, register the tool in the same change — a function reachable only from a React component is the failure mode this rule exists to prevent.

### The 33 tools

`BILLING_TOOL_NAMES` (`tools/register.ts`) is the canonical list — what the library **can** register. The **needs** column is what makes each one register, and it is not documentation: `toolCapabilities(plans)` computes it and `registerBillingTools` reads it, so the table and the code cannot disagree.

(The list held 30 of the 33 until this audit. `list_plans` was registered and not advertised, because `test/surface.test.mjs` only checked that everything advertised was registered — the "or hides one that is" half of its own comment. It now asserts both directions and the count.)

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
| `get_billing_portal` | invoices | Short-lived Stripe Billing Portal URL — the no-code self-serve surface | Stripe customer |
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

`registerBillingTools` resolves `toolCapabilities(opts.plans)` and registers a group only where some plan declares it. The same catalogue that already drives Stripe prices, the meter and every pricing surface now decides the tool surface too.

**Why, concretely.** gtm-tools sells two flat plans with an org-wide pool, no seat types and no `replenish.request` — and registered all 33 tools anyway. `list_seats` answered `seat_types: []`; `assign_seat_type` refused everything with `"(none configured)"`; `request_top_up` queued an ask against an allowance the plan does not grant, for an owner to rubber-stamp. **An agent cannot distinguish a tool that always fails from one it is holding wrong**, so those seven were not merely wasted context — they described a product that does not exist. Its surface is now 26; scartoffie, which declares seats and requests, keeps all 33.

| | gtm-tools | scartoffie |
|---|---|---|
| catalogue | `sells: flat`, `cap: pool`, `purchase` + `autoReload` | `nothing`/`seats`/`seats`, `pool` + `per_seat` + `wallet`, `purchase` + `autoReload` + `request` |
| seats (2) | – | ✓ |
| top-ups (5) | – | ✓ |
| everything else (26) | ✓ | ✓ |

Reads are never gated on a write's precondition: `list_plans` and `get_plan` register on any catalogue including a wholly quote-only one, `get_usage` on any at all, and `get_usage_limits` wherever a plan has a window — a rate limit counts, because it is the one refusal a caller can wait out. `caps` is also independent of the adapter's `getOrgMetadata`/`setOrgMetadata` check; the catalogue says whether a group can ever be *needed*, the adapter whether the answer can be *stored*, and neither implies the other.

**No catalogue means no declaration to read, so everything registers.** `undefined` is "the caller did not say", never "nothing applies" — the same distinction `checkPlansConfig` draws for its `usageLedger` option, and for the same reason: inventing a `false` would silently delete tools from a working deployment. `capabilities: { request: true }` is the per-group override for a plan not shipped yet, and `profileTools` / `subscriptionTools` still turn their groups off for an app whose own UI owns the flow.

**Rejected: merging the redundant pairs.** `preview_credit_purchase`→`buy_credits{quote}`, `preview_plan_change`→`change_plan{dry_run}`, `view_invoice`+`download_invoice`→`get_invoice{pdf}`, `approve_top_up`+`deny_top_up`→`resolve_top_up{decision}` would take the canonical 33 to 26. Not done: it breaks both apps and the CLI for a saving that gating already beats per deployment, and a preview that shares its code path with the charge (`previewPlanChange` shares `desiredPrices`/`diffItems` with `changePlan`) is safer as a separate tool than as a boolean an agent can forget to set — a forgotten `dry_run: true` moves money.

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

**Which KEY, for an `api` caller.** `validateApiKey` may return `keyId` alongside `orgId`, and `createApiMeterGuard` passes it as `caller.id`. It used to pass the ORG id, because the seam returned nothing else — so every metered API call recorded a `caller_id` that `MeterCaller.id` documents as "API key id" and that actually held a workspace id, and the counter written under it (`u:<workspace>`) sat in the member namespace looking like a member the workspace does not have. Nothing was mis-charged: an `api` caller's windows are summed by KIND across the org, deliberately (one shared agent seat), so no gate ever read the value. What was impossible was answering "which key burned the quota", for every consumer. An adapter that cannot tell keys apart records **no** caller id rather than a wrong one — a plausible-but-wrong id is worse than a missing one, being indistinguishable downstream from a real member.

**Reading per key is not the same as gating per key.** `memberUsage` narrows an `api` member to its own key when one is named, because "which key spent it" is the question an admin screen asks; summed by kind, a list of five keys returned the org total five times — a table that looks per-key and is not. The GATE still sums by kind.

Per-KEY windows remain a product decision, not a consequence: a `scope: "caller"` limit still sums every key in the org, so switching to one window per key would loosen the aggregate. The id is now recorded, so that choice is available.

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

## Counting usage — all of it in Stripe, no store anywhere (`src/usage-ledger.ts`, `src/usage-scopes.ts`)

Usage counting is separate from moving money, behind one seam: `UsageLedger` (`record` + `total`). **Nothing here needs a database.** Four implementations ship, and **which one is wrong depends on the QUERY, not on the config** — which is why the default is a composite that routes:

| | sees INCLUDED usage | per-member | needs a store |
|---|---|---|---|
| **`stripeUsageLedger()`** (default) | yes | org-wide + wallet-funded | no |
| `stripeBalanceUsageLedger()` | **no** | yes | no |
| `stripeMeterUsageLedger()` | yes | **no** | no |
| `stripeScopeUsageLedger()` | yes | yes | no |

`stripeUsageLedger` dispatches on whether the query carries a caller filter:

- **an ORG-wide window** (`cap: pool`, `scope: "org"` limits, the spend limit) → the **Stripe meter**. It sees every call, included ones too, and a summary is ONE request for any window width: a 200 000-credit weekly window costs the same read as a 400-credit one.
- **a PER-CALLER window** (a seat pack, `scope: "caller"` limits) → **balance transactions**, which carry the caller on their metadata. Exact and per-member, but they only exist where money moved.

Every metered call is one `record`; every window is one `total`. The rule at the call site is **`record` always, `deductCredits` only when the wallet funded it** — an included call must be counted (or its cap can't be enforced) but must not be charged. The composite's `record` writes the meter event *and* forwards to the per-caller leg; it never moves money, because `deductCredits` owns that.

### The pair that used to need a database, and no longer does

A window that is both **INCLUDED and PER-MEMBER** (`cap: per_seat`, a `scope: "caller"` limit) is the one question neither Stripe leg above can answer. This library used to ship three stores for it — `postgresUsageLedger`, `counterUsageLedger` with `sqlUsageCounters` / `redisUsageCounters`, and the `meter.db` / `meter.counters` shortcuts. **They are gone.** `stripeUsageLedger({ perCaller: stripeScopeUsageLedger() })` answers it out of Stripe.

**The insight is that a Customer is just a key.** Measured against the API: `listEventSummaries` *requires* `customer` and offers only `value_grouping_window` (hour/day) — no dimension group-by; `/v1/billing/analytics/meter_usage` is not available; there is no read API for raw meter events; a zero-amount balance transaction is rejected outright (*"The transaction's `amount` must be non-zero"*); WorkOS has no atomic increment anywhere. So Stripe exposes exactly **one** grouping key for usage, and the only ways to a second dimension are more customers or more meters. `stripeScopeUsageLedger` gives each scope (`k:<kind>`, `u:<memberId>`) a Stripe Customer of its own.

**The funding split is what keeps the lag off the limits that care.** Meter summaries lag aggregation by **~40–60 s** (measured three times: 40 s, 48 s, 58 s). Harmless against a monthly seat pack; unacceptable against a `600/hour` limit on an API key, which a script would blow through unseen. So the leg splits on `UsageEvent.funded`, which every record already carries:

| usage | counted by | lag |
|---|---|---|
| **wallet-funded**, per caller | balance transactions (`deductCredits` already writes `caller_id`) | **none** |
| **included** (pool/pack), per caller | the scope meter | ~60 s |

The two sets are disjoint by construction — an event has exactly one funding source — so `total` is a plain sum with no double count, and it reproduces what the deleted SQL counters did, which also counted every event whatever funded it.

**The scope customer is DERIVED, never allocated.** `scopeOf` / `scopesFor` produce the same string on the write and the read path; a read that computed a different one would look up a customer nobody writes to and report 0 for that member for ever. Resolution is `customers.search` on the scope, then `customers.create` under an idempotency key derived from it. The two cover each other exactly: the search index is eventually consistent (measured — a fresh customer was still missing after 20 s), and the idempotency key dedupes concurrent and repeated creates for 24 h (measured — both returned the same id). There is no window where both miss, so two instances cannot split one member's usage across two customers. *(Rejected alternative: one meter per seat SLOT with the org staying the customer — fewer objects, 110 meters created with no ceiling, but it needs an allocation registry and a recycled slot silently inherits the previous member's usage.)*

**It is not the default**, because creating Customer objects is a side effect a consumer should choose rather than discover. `warnLedgerGaps` at boot and `checkPlansConfig` both name the plans that need it. The cost is real and worth stating: one Stripe Customer per active member per org, marked `bt_kind: "usage_counter"` — the doctor's customer-currency check skips them.

**The write is FASTER than the org write it sits beside.** Every scope goes in one `v2.billing.meterEventStream` request: measured **129 ms** warm against **204 ms** for the single v1 meter event this library already sends, and the two legs run in `Promise.all`, so per-call wall-clock is unchanged. Reads are one summary — **~210 ms flat at any window width**.

`scripts/e2e-scope-ledger.mjs` proves it end to end against a sandbox: two members and two API keys in one org, exact on all six scopes.

### The rule that reads all of this

**A ledger declares what it can count, and ONE rule reads that declaration.** `UsageLedger.covers` is a `LedgerCoverage` (`orgIncluded` / `callerIncluded`); `coverageNeededBy(model)` says what a plan requires and `ledgerGaps(models, covers)` returns the plans that don't fit, split by axis. `createMeter` warns at boot through `warnLedgerGaps`, and `checkPlansConfig(plans, { usageLedger })` makes the same finding an **error** — a warning in a deploy log is missable and a month of unenforced caps is not recoverable. Pass the ledger's own `covers`; the old `boolean` still means "the per-caller axis is covered". (Omit it and the check is skipped — undefined means "the caller did not say", not "nothing is wired". A ledger that declares no `covers` is silent for the same reason: an invented `false` would fail a config that is perfectly wired.)

**`coverageNeededBy` asks TWO questions about the caller axis, because asking one was wrong in BOTH directions.** It used to test only `scope === "caller"`, and the reads `resolveAllowance` actually issues disagreed:

- **false negative** — an *org*-scoped limit carrying `callerKind` is issued as a `{callerKind}` filter, i.e. a per-caller read, yet was filed under `orgIncluded`. It passed every check and then read 0 for ever: a limit that never applies, which looks like generosity rather than a fault.
- **false positive** — a `scope: "caller"` limit over usage the wallet always funds (any `cap: wallet` plan, or an `api` caller under `cap.covers: "users"`) is answered exactly by the debits, with no lag. Demanding a store there rejected configs Stripe already handled.

So the axis is needed when the read is caller-filtered (`scope: "caller"` **or** a `callerKind`) **and** the usage behind it can be included. Both cases are pinned in `test/ledger-coverage.test.mjs`.

**The rule is written once because the two copies had already drifted.** The boot warning and the doctor both used to ask only about PER-MEMBER windows, so a POOLED plan metered by a wallet-only ledger passed every check while counting nothing — and `createMeter` defaulted to `stripeBalanceUsageLedger()` while `createBilling` defaulted to the composite, so which entry point composed the app silently decided whether included usage was counted at all. There is now one default (`defaultUsageLedger()`, read by both) and one rule.

**A pool costs nothing to count.** `cap: pool` — including `perSeat`, below — plus org-scoped limits runs on the bare composite at any volume. That was impossible before: the old default was the debits themselves, so an included call counted as 0 and every window read 0% forever.

**`orgWide` is a seam too**, and the one most likely to move: Stripe's Meter Usage Analytics API answers the same question grouped by a dimension (`caller_id`), so if it becomes generally available it belongs there — and the per-caller leg could point at it too, at which point the scope customers disappear. Metronome (a Stripe product) already exposes exactly that shape (`POST /v1/usage/groups`, arbitrary `group_key`), but it is a separate vendor, a separate contract and 0.8% of billing volume, so it stays out.


### What limits this, and the one lever that moves it

**The constraint is Stripe's RATE limits, not latency or storage.** Live: 100 req/s
globally, **25 req/s per endpoint**, 20 read/s for Search. `scripts/load-metering.mjs`
measures the real read path against a real account, counting every HTTP request the
SDK makes via `stripe.on("response")` — which matters because a read is not one
request: `usageSince` paginates.

Measured on a per-seat catalogue with a caller-scoped limit, per metered call:

| caller | uncached | cached 2 s |
|---|---|---|
| member (`user`) | **3.95** | **1.95** |
| API key (`api`) | **1.30** | **1.00** |

(Was 6.63 for a member before three fixes: one customer retrieve instead of two,
`sources` skipping the leg that must return 0, and per-tick batching below.)

**The bottleneck is metered calls per SECOND for the whole account, not users.**
Stripe's limits are per account, so idle users cost nothing and the ceiling is
shared across every org: at ~1.3 `listEventSummaries` per call that is roughly
15-20 metered calls/s in aggregate. What makes it inherent is that the meter has
**no batch read** — one summary per caller per window, so W windows cost W
requests and an N-member screen costs N.

**`UsageQuery.sources` is what makes the agent path cheap.** `resolveAllowance`
states per read whether the window can hold INCLUDED usage (`capCovers`) and
WALLET-funded usage (`exhaustedPolicy`), and the scope ledger skips the leg that
must return 0. An `api` caller on a `covers: "users"` plan draws no included
allowance, so its meter read is a guaranteed zero and its cost falls to 2 requests
— which matters because agents are the high-volume traffic. A member whose pack
overflows to the wallet genuinely needs both legs and is unchanged. Omitting
`sources` means BOTH: a ledger must never invent a restriction, since skipping a
source that could contribute under-reports and refuses no one.

The spread is the point: the cache pays off in proportion to how often the SAME
caller repeats inside the TTL, so a round-robin over many members is close to its
worst case and real traffic does better. Latency follows it (p50 382 ms -> 174 ms
bursty). Requests-per-call transfers to live; THROUGHPUT does not — test mode
allows 25 req/s globally against live's 100, while the per-endpoint cap is 25 in
both and is what actually binds. Cached, that puts sustained metering in the region
of **15-20 calls/s** mixed, higher when bursty.

**The most expensive read is the wallet leg, and it is the only unbounded one.**
`usageSince` pages balance transactions newest-first across the window, 100 per
request, and an org whose API usage the wallet funds writes one transaction per
call — so a monthly window can cost tens of requests on every per-member read.
`stripeScopeUsageLedger({ wallet: null })` removes it, and is correct only where no
per-caller window can ever be wallet-funded (not a `cap: wallet` plan, and not one
whose pack overflows with `onExhausted: "wallet"`). Dropping it elsewhere
under-reports, which reads as generosity and refuses no one.

**`cachedUsageLedger(ledger, { ttlMs })` is the general lever**, and it is opt-in
because it trades the thing the meter exists for. A fixed, UTC-aligned window asked
twice in the same second returns the same number by construction, so the reads are
far more repetitive than the traffic; caching them collapses the per-call cost and
coalesces a usage screen's N per-member reads into one round. The price is stated
rather than hidden: a cached window is stale by up to `ttlMs` and the gate reads
through it, so `overspend <= (calls/sec by one caller) x ttlMs x credits/call`.
Size the TTL against the TIGHTEST window enforced — a `600/hour` limit tolerates
seconds and would not tolerate a minute. `record` is never cached: a write served
from cache is usage counted by nothing.

**Several windows over one caller cost ONE request.** A plan declares a monthly
pack and a weekly limit over the same member, and `resolveAllowance` issues them
together in a single tick — so `stripeScopeUsageLedger` collects what arrives in a
tick and answers it in as few requests as Stripe allows: the meter groups by time
(`value_grouping_window: "day"`, verified — a slice of the bucketed response equals
a dedicated narrow read exactly), and the balance walk sums every window in one
pass. Stripe ENFORCES day alignment for bucketing, which `rateWindowFor` already
satisfies for day/week/month; an `every: "hour"` window is not aligned and keeps
its own read, which costs nothing since an hour is one bucket either way.

**This batching is fragile in one specific way: an `await` between the reads
breaks it.** Adding the shared customer retrieve as an `await` before the pack read
silently undid it — the reads landed in two ticks and two flushes. It is started as
a promise and awaited inside the same `Promise.all` for that reason. If you add a
read to `resolveAllowance`, add it to that batch rather than in front of it.

**A per-member usage SCREEN is the other amplifier.** `memberUsage` is N summaries
by construction (the ledger has no group-by), so a 100-seat org is ~400 requests per
render — sixteen seconds of that endpoint's entire budget. Cache it at the page,
not per request.

**Object count.** One Stripe Customer per active member per org. Stripe holds
millions, but anything that ITERATES customers must bound itself by objects
examined rather than by matches found — the scopes outnumber real customers and are
the most recently created, so they sit at the front of `customers.list`. The
doctor's currency check does exactly that (2 000 examined).

**What no store means you give up: the audit trail.** Nothing here can say WHICH actions made up a total. `UsageLedger` is still a seam, so a consumer who wants per-action history brings their own `ledger` — the library simply no longer ships one, or the database driver it would need.

## Spend controls — the customer's own ceiling (`getSpendControls`)

A monthly ceiling on what a customer may CONSUME, plus the thresholds they want warning at. Both live on the customer's Stripe metadata beside auto-reload (`spend_limit_credits`, `spend_alert_credits`), because all three are billing preferences the customer owns rather than plan config — a handful of stable values, which is exactly what metadata is for.

The ceiling is **not a new gate**. It funds nothing and only refuses, which is what `state.limits` already models, so it rides the existing path: `resolveAllowance` reports it as one more `LimitState` (`kind: "spend"`), `fundingFor` checks it in the same loop, `describeDenial` writes the message. The read joins the same parallel round as every rate-limit read and comes off the customer object `getCreditBalance` already retrieves, so enforcement adds no round trip to the meter's hot path.

Two things are deliberately distinct from a rate limit:

- **`spend_limit_reached`, not `rate_limit_reached`.** A plan's rate limit is the product's and the customer must wait; this one is theirs and they can raise it, so the message says so. Telling them to wait would be wrong.
- **Plan limits are reported first.** When both refuse, the one the customer *cannot* lift is the more useful thing to be told.

The window is the **calendar month**, even for an annual subscriber: "monthly" is what the customer set, and the plan cycle would make that window a year wide. A cleared limit writes `""` (the Stripe metadata clear) and never `"0"`, which would read back as a ceiling of zero and refuse every call in the workspace; junk metadata means "no ceiling" for the same reason.

**The ceiling sees exactly what your ledger sees.** It is an org-wide window, so on the default composite it is answered by the Stripe meter and sees every call, included ones too.

**`get_spend_controls` / `set_spend_controls` exist because this was the one capability still breaking the parity rule.** The ceiling was a library function and a billing screen and nothing else — the same shape as the pre-audit gap the rule was written for. It matters more here than elsewhere: `describeDenial` answers `spend_limit_reached` by telling the caller this is the one limit they can raise *themselves*, which is useless advice to an agent that has no tool to raise it with. Both are **ungated** — a ceiling funds nothing and only refuses, so it needs no `replenish` and no plan, and a free workspace caps itself exactly like a subscribed one. `set_spend_controls` is `enforceAdmin`, like `assign_seat_type`, because the ceiling governs what the whole workspace may consume.

**`0` is the clear, and `null` is deliberately not accepted.** `dispatchTool` strips null and undefined arguments before validation (`dispatch.ts`), so a nullable field would be dropped on the REST and CLI paths and read as "leave it alone" — the caller's clear would silently not happen, while the identical call over raw MCP worked. One spelling that behaves the same on every surface beats two where one quietly doesn't; passing `null` now fails loudly with "nothing to change". Read-back is for the same reason: `0` is stored as `""`, thresholds come back sorted and de-junked, so what was asked for is not always what is now in force.

## Tax — the library calculates it, Stripe Tax is opt-in

**`src/tax.ts` is the default path, and it is not Stripe Tax.** `resolveTax` works the rate out locally from `sales-tax` (a real dependency) with VIES for B2B validation, and `taxRatesFor` applies the answer as an explicit Stripe **TaxRate** on the line items — no per-transaction fee, and no registrations needed to *calculate*. `updateCheckoutSessionTaxRates` re-taxes an open session when the typed country differs from the one guessed, which is the piece Stripe Tax would otherwise do. What you take on instead: evidence-of-location records for EU B2C, threshold monitoring, and filing. The safe direction is already chosen — a tax number VIES cannot verify falls back to CHARGING tax, because wrongly charging is recoverable and wrongly exempting means owing it yourself.

**WHO calculates is declared ONCE, in `config.tax`, and every charge the library builds reads it** — the seat Checkout Session, the `buy_credits` top-up, and the auto-reload invoice. `taxFor(customerId, config.tax)` returns the `{ taxRates, automaticTax }` every charge site already took, so wiring it is one line per site and an explicit argument still wins.

```ts
config: { baseUrl, currency: "eur", tax: { origin: "IT" } }   // ← the whole tax config
```

**Configuring nothing means `"local"` — this library calculates, on this machine. That default changed in 4.x and it used to be `"none"`.** Silence meant no tax on anything the library charged, so a deployment that never thought about VAT shipped charging none of it. That is the expensive direction: over-charging is recoverable, under-collecting means owing it yourself, with interest, in every jurisdiction you sold into. "I did not configure tax" is not a statement that the sale is untaxed. `mode: "none"` is now how you say that, explicitly.

What used to make the default impossible was `origin`: the mode needs to know where you are established, and no rate can be worked out without it. **`originFor` is the one place that resolves it** — `config.tax.origin`, else the Stripe account's own country (the country you gave Stripe at signup, memoised once per process, never throwing because it sits behind `taxFor` on the hot path of every metered call). So the default needs no config at all, and nothing else in the library may read `tax.origin`: it decides domestic vs cross-border, which is the whole question a VAT rate turns on, so a second copy of it is a second answer. **Consumers must not keep their own copy either** — a `const TAX_ORIGIN` beside `config.tax` is exactly that second answer, and scartoffie had one that disagreed with its own Stripe Tax script (`FR` in the code that computed the rate, `IT` in the script that registered it).

`mode` overrides what `automatic` implies; `rates` stays the authoritative hook for an app that resolves from its own records (and it is per-ORG, which `config.tax` cannot express — hence `topUp.taxRates` too). `taxModeOf` is the one place the mode precedence lives, `originFor` the one place the origin's.

**Why one declaration.** Per-site tax arguments meant the tax an account applied depended on which call sites the app had got round to wiring, and the answer to "does this deployment charge VAT" lived in as many places as there were charges. That is exactly how the auto-reload and the top-up went out at 0% while every seat invoice on the same account charged 22% IVA: nothing was wrong at any one site, there was simply no single place that said what the account does. `checkBillingSetup({ config })` reads the same field rather than being told again, so the doctor cannot disagree with the engine.

Under `"local"` the rate comes from the CUSTOMER — their Stripe address decides the place of supply, their tax id decides reverse charge. A customer with **no address on file is charged the DOMESTIC rate, not nothing**: the same direction `resolveTax` takes for a VAT number VIES can't verify, because over-charging is recoverable and under-charging means owing it yourself. On a seat checkout the address isn't typed yet, so the domestic rate goes on at creation and the browser re-applies through `updateCheckoutSessionTaxRates` once it exists.

**Nothing enables Stripe Tax implicitly.** `automatic_tax` is set only where the caller passed `automaticTax: true` (or `config.tax.automatic` for the charges the library raises itself). It used to be inferred from the ABSENCE of `taxRates`, which made it the default for every caller that passed no tax at all — and that is the expensive way round: with no active registration Stripe Tax returns **zero** tax rather than an error, so the total silently drops to the pre-tax amount on precisely the accounts that never opted in and therefore never registered. Passing neither now means an untaxed charge: right for an account that charges no tax, and loud enough to notice for one that does. Manual rates and `automatic_tax` stay mutually exclusive — Stripe rejects both together.

`checkBillingSetup({ taxMode })` names WHERE the calculation happens: **`"local"`** (the default — computed in-process from `sales-tax` + VIES, and deliberately NOT `"auto"`, because Stripe's own field is `automatic_tax`, so `"auto"` would name this mode after the very thing it is the alternative to) reports which TaxRates exist, which is the audit trail of what the account has charged and legitimately empty on a fresh one; `"stripe"` audits the head office, the registrations and `tax_behavior`; `"none"` skips tax. The mode matters because auditing Stripe Tax on a `local` account reports errors for things that account has no reason to hold. `ensureTaxSetup` exists for consumers who do want Stripe Tax and is explicit-only.

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

## Entry points — the root barrel is not the only way in

The root re-exports 45 modules, so `import { planModel } from "@arnaudjnn/billing-tools"` in a Server Component resolves the MCP SDK, mcp-handler, authkit-nextjs, Stripe, WorkOS and sales-tax to answer a question about a plain object. Import from the narrowest entry that has what you need:

| entry | for | reaches |
|---|---|---|
| `/plans` | the catalogue + its arithmetic + the adapter/config types | **nothing** |
| `/pricing` | `derivePlanViews`, `deriveCompareTable`, the markdown renderers | **nothing** |
| `/agent-auth` | auth.md, MPP, the OAuth proxy | WorkOS, Stripe, sales-tax |
| `/routes` | the three Next route factories + `ensureWebhookEndpoint` | MCP SDK, mcp-handler, Stripe, zod |
| `/tools` | `registerBillingTools`, `createDispatcher` | MCP SDK, WorkOS, Stripe, zod |
| `/ui`, `/ui/authkit` | the React checkout components | React, Stripe.js, authkit |
| `/cli` | the customer CLI commands + config store | node builtins only |
| `/dev` | `startLocalWebhooks` (the Stripe CLI fetcher) | node builtins only |
| `.` | everything, incl. `createBilling`, the Stripe/WorkOS engines, the doctor | all of it |

`test/conventions.test.mjs` pins each set **exactly, in both directions** — a leaf that grows a dependency has stopped being one, and a leaf that loses an export means consumers now import from two places.

Two things that look like dependencies and are not. **`commander` is nowhere**, including in the root: `cli/commands.ts` imports `Command` as a *type*, which tsc erases, so the customer CLI never cost a runtime dependency. **`pg` is nowhere** either, and now there is nothing that could want it: the SQL and Redis usage stores were deleted once `stripeScopeUsageLedger` could answer the one question they existed for. The package touches no database at all.

`createBilling` stays at the root on purpose: it composes the tools, all three routes, agent-auth and MPP, so it needs the whole graph — and being one module also guarantees the single instance its shared AsyncLocalStorage depends on. Same for `checkPlansConfig`, which reads Stripe from `doctor.ts`; it is a deploy-time call, not one a page makes.

**The root now DERIVES the pure half instead of re-listing it.** `src/index.ts` used to hand-list all 89 names of the plan model, the storage seam and i18n; it is one `export * from "./entries/plans.js"` line. A hand-maintained list of names is a list that drifts, and this repo has the receipt: `list_plans` was registered and left out of `BILLING_TOOL_NAMES` for exactly that reason. Only the Stripe-touching half of `plans.ts` (`ensurePlans`, `migrateSubscriptions`, the price lookups) is still listed, because the leaf is pure and those are not.

The hazard `export *` introduces is the mirror image of a missing name: TypeScript drops, silently, any name two `export *`s both provide. `plan-model` and `checkout` each export a `Quantities` — the barrel keeps checkout's under its own name and plan-model's as `PlanQuantities`, which works only because an explicit export beats `export *`. `test/conventions.test.mjs` asserts every runtime name the leaf provides is reachable from the barrel, and that both `Quantities` survive. Collapsing the blocks changed the surface by exactly two names (`INTERVALS`, `DEFAULT_SEAT_TYPE`) and removed none — verified by diffing the resolved export set before and after.

## CLI

Two different CLIs, for two different people. **`registerBillingCommands(program, { configDir: "~/.myapp", envPrefix: "MYAPP", defaultUrl })`** is the CUSTOMER's: it adds `auth`, `keys list|revoke`, `balance`, `buy`, `invoices`, talks to the app's REST API with an org API key, and persists to `<configDir>/config.json` (chmod 600).

**`npx billing-tools <command>`** (the package's own `bin`) is the DEVELOPER's, and talks to Stripe with the secret key. It carries only what needs no app config:

- **`dev`** — `startLocalWebhooks()`: fetch the Stripe CLI into `~/.cache` if absent, `stripe listen --api-key` (no `stripe login`, no tunnel, no registered endpoint), and write the session's `whsec_` into `.env.local`. The dotenv write is the point: `stripe listen` mints a NEW secret per session and the dev server is a different process, so a file is the only channel both see.
- **`doctor`** — `checkBillingSetup` + `formatDoctorResult`, exiting non-zero on an error so it can gate CI.

**`runBillingDoctor` is the same command for an app that has plans.** `checkPlansConfig` needs the app's own catalogue, so the bin subcommand cannot run it and each app keeps a script. What the app stopped keeping is the plumbing: the `--url` / `--no-webhook` parsing, the run order (config first — it needs no network and explains most account-level symptoms), and the exit arithmetic were hand-written in both consumers, 64 and 75 lines with 87 of them differing, the second written by copying the first. Each script is now ~12 lines of the three things only that app knows: its `plans`, its `config`, and what its ledger `covers`.

Two behaviours worth knowing. `STRIPE_SECRET_KEY` unset exits **2**, not 1 — that variable decides WHICH environment is checked, and a run against the wrong account is worse than no run. And a Stripe call that THROWS (invalid key, no network) is caught, printed as `✗ Stripe: …` with a fix line, and exits non-zero — the plan-config report already printed stays on screen, because it is the half that needs no network and the half Stripe can never tell you about. Both hand-written copies discarded it to a top-level `.catch`. `exit` and `log` are injectable, which is the only reason `test/doctor-runner.test.mjs` can assert any of this.

Call it, do not `await` it at the top level: it exits the process itself, and a top-level await does not survive a CJS transform — the two consumers differ on `"type": "module"`, so the awaited form worked in one and failed to build in the other.

## Setting up an environment (`setupBilling`)

The deploy-time twin of the lazy provisioning, and the honest scope of it is small: prices, the payment-method configuration and the usage meter all provision themselves from the key on first use, so `setupBilling({ config, plans, webhookUrl, stripeTax? })` exists for the two things that genuinely cannot, plus the reporting.

- The **webhook endpoint**, because Stripe returns its signing secret exactly once, at creation — no request can put that in your env store. `formatSetupReport` prints it as a `STRIPE_WEBHOOK_SECRET=…` line, only on the run that created it.
- **Tax registrations**, because only a human knows where the business collects — and skipped unless `config.tax` mode is `"stripe"`, since running it on a `local` account would create registrations it doesn't need and is billed against.
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

**`cap: { kind: "pool", perSeat: N }` is the rung between a flat pool and `per_seat`, and choosing it is an infrastructure decision as much as a commercial one.** "1 000 credits per seat per month" is what a pricing page says. `per_seat` additionally **enforces** it member by member — which is a stricter product than most teams sell, and the only cap shape that needs a per-member counter to gate. That used to mean a database; it now means `stripeScopeUsageLedger` as the per-caller leg (see the ledger section), which costs a Stripe Customer per active member and ~60 s of lag on that window. Pooled, the same promise is ONE org-wide window: `perSeat × seats`, shared, answered by a single meter summary at any volume with nothing extra at all. The trade is fairness — one member can draw the team's share — so say `per_seat` when that matters and pool when it doesn't.

Seats are the **purchased** quantity (`getSubscription().seats`, recorded by the sync from the subscription's summed item quantities), falling back to the active member count, then to 1. Purchased rather than active deliberately: a workspace that bought ten seats and filled six paid for ten, and sizing on members would quietly hand them a smaller package than the page promised. `poolSizeOf(model, seats)` takes the count as an argument and defaults it to 1, so a caller that forgets it under-reports rather than over-grants — and a pricing surface with no org in hand gets the per-seat unit to display. Mutually exclusive with `cap.credits` (`checkPlansConfig` errors: `perSeat` wins, so the flat number would silently do nothing), and warned when the plan `sells: nothing` — there is no purchased quantity to multiply.

**`cap.window: "month"` is the exception, and it exists because a price and a window are different things.** A plan sold annually whose pricing page says "1 000 per seat **per month**" cannot be expressed by the default: one window per subscription period gives an annual subscriber twelve months' allowance on day one and nothing after it runs out. Declaring `window: "month"` measures the same pack over the calendar month whatever the billing interval. It is read inside **`cycleWindowFor`**, not at the call sites, so the meter, `usageSummary` and `grantExtraAllowance` all keep agreeing on one window — a grant written under a period key that the meter never reads is precisely the defect above. Mutually exclusive with `rollover` (which widens the window instead); `checkPlansConfig` errors on both.

**The legacy `PlanDef` shape is GONE (4.0.0).** `PlanDef`, `PlansConfig`, `SeatTypeDef`, `isLegacyPlan`, `DEFAULT_SEAT_TYPES`, `allowanceMode`, `creditsPerSeat` and `PlanModel.legacy` are removed; `PlanCatalog` is now `Record<string, PlanSpec>` and `normalizePlan` has one branch instead of two.

It was kept for exactly one reason — both apps declared `PLANS: PlansConfig` and read `PLANS[k].price.monthly`, so a union would have broken their builds. Both migrated to `definePlans` with `PlanSpec` long before this, and by 3.1.x the only things still naming the legacy shape were this library and its own tests: 167 lines of `plan-model.ts`, a parallel normalisation branch, a `legacy: boolean` on every model, and a doctor warning for a state no config could reach. Compatibility you are the sole consumer of is not compatibility.

**Migrating, if you are on the old shape:** `seats` → `limits.members`; `price` → `sells: { kind: "flat", price }`; `seatTypes` → `sells: { kind: "seats", seatTypes }` (with `seats` → `max` and `label` → `display.label` per type); `allowanceMode: "per_seat"` → `cap: { kind: "per_seat", onExhausted: "block" }`; `allowanceMode: "global"` → `cap: { kind: "wallet" }` (it only ever meant "no per-seat cap" — **never** `pool`, which would start blocking a live customer); `creditsPerSeat` → `grant: { kind: "per_member", credits }`, or `cap: { kind: "pool", credits }` if what you meant was an included allowance. And `sale` is now required rather than guessed from whether any price exists — guessing it is what let a quote-only plan be bought at its placeholder price.

`sale: "legacy"` is unrelated and stays: it means a plan kept for existing subscribers and offered to nobody new.

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
