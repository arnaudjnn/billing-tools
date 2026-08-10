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

Optional members, and each one is a GATE: `listMembers` (with roles) registers `list_members`, `setMemberRole` registers `change_member_role`, `removeMember` registers `remove_member`. An adapter without them keeps everything else and advertises none of those — a tool that could only ever answer "not supported" is the false statement this file keeps deleting.

**There is ONE adapter, and it is WorkOS.** `BillingAdapter` is not a storage-swap seam and no second implementation is wanted — it exists so an app can say WHERE its org pointer lives, nothing more. So do not add a Postgres adapter, do not write one "to prove the interface", and do not widen the interface to accommodate a store that isn't WorkOS. **A database's only job here is keeping the app's own row in step with a WorkOS org** (Pattern B below) plus whatever WorkOS genuinely cannot hold — avatars, secondary emails, local prefs. Anything else billing-related belongs in WorkOS or Stripe, which is what makes `pg` absent from this package and keeps it absent.

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

**A registered tool is not reachable until what it RETURNS is usable without a browser.** `change_plan` on the first-purchase path returned a Checkout **client secret**, which needs Stripe.js mounted, so the one caller the tool exists for could not finish the purchase. Hence `createCheckoutSession({ uiMode: "hosted" })` — the same session, same tax, same payment-method configuration, a URL instead (`tests/checkout-ui-mode.test.mjs` pins that the two modes differ in nothing else).

**The cost of not having it, measured in a consumer:** scartoffie hand-rolled a hosted `checkout.sessions.create` to get a URL, and that second session inherited neither `config.tax` nor the method configuration. Note what it did NOT look like — the two paths agreed on the rate, because that deployment is registered nowhere and charges 0% everywhere, so no total was ever wrong. What actually diverged was **the 0% TaxRate itself**, whose `display_name` carries the legally mandatory mention ("TVA non applicable, art. 293 B du CGI", "Autoliquidation, art. 196 dir. 2006/112/CE") — €15 per invoice for the first, and per CJEU C-247/21 an omitted reverse-charge mention cannot be cured afterwards. **A duplicated charge path is not safe because the numbers currently match**: this one would have started charging 0% against 22% the day that establishment moved to Italy, which its own config already documents as the next step.

REST and MCP get it structurally (`createDispatcher` monkey-patches `server.tool`, so every registered tool is an endpoint). `tests/surface.test.mjs` asserts `BILLING_TOOL_NAMES` matches what registration produces, **in both directions and by count**. The CLI is hand-written and is the one surface that can silently fall behind, so `tests/conventions.test.mjs` asserts it reaches every tool — and, since it is hand-written, that it is **gated by the same `toolCapabilities`**: pass `plans` to `registerBillingCommands` and a flat/pooled deployment stops shipping `seats` / `assign-seat` / the five `topup` commands, which on that catalogue call tools that were never registered and can only answer "Unknown tool". A dead command is the same false statement as a dead tool. Omitting `plans` registers everything, because undefined is "the caller did not say". Coverage is per tool, not per command: `get_api_key` has no command because `auth` performs that flow, `preview_credit_purchase` is `buy --quote`, `set_spend_controls` is `spend limit` / `spend alerts`.

### The 46 tools

`BILLING_TOOL_NAMES` (`tools/register.ts`) is the canonical list of what the library **can** register. The **needs** column is not documentation: `toolCapabilities(plans)` computes it and `registerBillingTools` reads it, so the table and the code cannot disagree.

| tool | group | what it does | needs |
|---|---|---|---|
| `get_api_key` | keys | Provisions or retrieves the workspace's API key | — |
| `create_api_key` | keys | An ADDITIONAL key, named by the caller — `get_api_key` names what it mints "API Key", so several were indistinguishable and none safely revocable | — |
| `list_api_keys` | keys | Lists the keys, obfuscated — never the full value | — |
| `revoke_api_key` | keys | Hard-deletes one key by id | — |
| `get_credit_balance` | wallet | Balance + per-tool costs + auto-reload state | — |
| `preview_credit_purchase` | wallet | Credits / tax / total before buying, from the rates the charge will carry | `replenish.purchase` |
| `buy_credits` | wallet | Buys credits by `method`: hosted checkout, embedded, the card on file (off-session), or an invoice Stripe emails | `replenish.purchase` |
| `set_auto_reload` | wallet | Threshold + target for the automatic card charge | `replenish.autoReload` |
| `get_spend_controls` | wallet | The customer's own monthly ceiling + alert thresholds | Stripe customer |
| `set_spend_controls` | wallet | Sets either; `0` clears the ceiling (admin) | Stripe customer |
| `list_invoices` | invoices | Recent invoices: amount, date, status, PDF links | Stripe customer |
| `view_invoice` | invoices | One invoice + a hosted browser link | Stripe customer |
| `download_invoice` | invoices | Direct PDF link (drafts and receipts have none) | Stripe customer |
| `get_billing_portal` | invoices | Short-lived portal URL; `flow` lands on the card form / cancel / update | Stripe customer |
| `get_usage` | usage | Credits spent this cycle, filterable by caller or a day window | — |
| `get_usage_limits` | usage | Every window that applies now: used, remaining, `resets_at` | a `cap` or a `limits.rate` |
| `get_org_usage` | usage | Every member against whatever caps them, who is over it, and the workspace reading — a mean of the seats, or the POOL read once | `listMemberIds` |
| `list_members` | members | Everyone in the workspace with their role, plus seats used / left | `listMemberIds` |
| `invite_member` | members | Invites by email, refusing past `limits.members` (admin) | `invitations` |
| `list_invitations` | members | Invitations and their state | `invitations` |
| `revoke_invitation` | members | Cancels a pending one, freeing its seat (admin) | `invitations` |
| `change_member_role` | members | Moves a member between roles; refuses the last admin (admin) | `setMemberRole` |
| `remove_member` | members | Removes them, clearing their records FIRST; refuses the last admin (admin) | `removeMember` |
| `rename_workspace` | workspace | Renames it — the name invoices, members lists and switchers all show (admin) | `renameOrg` |
| `close_workspace` | workspace | Stops the billing, KEEPS the invoices, returns each member's metadata budget. Deleting is opt-in (admin) | — |
| `list_seats` | seats | Per-member seat-type assignments + the types on offer | `sells: seats` **+** org metadata |
| `assign_seat_type` | seats | Puts a member on a seat type (admin) | `sells: seats` **+** org metadata |
| `list_top_up_requests` | top-ups | The queue, pending and settled | `replenish.request` **+** org metadata |
| `request_top_up` | top-ups | A member asks for extra allowance on the window refusing them | `replenish.request` **+** org metadata |
| `approve_top_up` | top-ups | Owner grants a pending ask (admin) | `replenish.request` **+** org metadata |
| `grant_top_up` | top-ups | Owner grants unasked, as a % of that seat's pack (admin) | `replenish.request` **+** org metadata |
| `deny_top_up` | top-ups | Owner refuses a pending ask (admin) | `replenish.request` **+** org metadata |
| `list_plans` | plans | The catalogue + live Stripe prices, provisioning them on first call | `plans` |
| `get_plan` | lifecycle | What this workspace is on, what is scheduled, which moves exist | `plans` |
| `preview_plan_change` | lifecycle | `due_now` / `next_invoice_total` / `recurring_total` / `credit_applied` | `plans` **+** a `self_serve` plan |
| `change_plan` | lifecycle | Up, down or off — one entry point | `plans` **+** a `self_serve` plan |
| `cancel_plan` | lifecycle | Cancel at the end of the period already paid for | `plans` **+** a `self_serve` plan |
| `request_plan_change` | lifecycle | A member asks an owner to move the workspace up a tier | `plans` |
| `request_seat_change` | lifecycle | A member asks for a bigger SEAT — the right ask while one exists | `plans` |
| `resolve_plan_request` | lifecycle | Owner records that ask handled or refused (admin) | `plans` |
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
| everything else (29) | ✓ | ✓ |

- **Reads are never gated on a write's precondition.** `list_plans` and `get_plan` register on any catalogue including a wholly quote-only one, `get_usage` on any at all, `get_usage_limits` wherever a plan has a window — a rate limit counts, because it is the one refusal a caller can wait out.
- **`caps` is independent of the adapter's metadata check.** The catalogue says whether a group can ever be *needed*, the adapter whether the answer can be *stored*; neither implies the other.
- **No catalogue means no declaration to read, so everything registers.** `undefined` is "the caller did not say", never "nothing applies" — inventing a `false` would silently delete tools from a working deployment. `capabilities: { request: true }` is the per-group override for a plan not shipped yet; `profileTools` / `subscriptionTools` turn their groups off for an app whose own UI owns the flow.

**Rejected: merging the redundant pairs** into `buy_credits{quote}`, `change_plan{dry_run}`, `get_invoice{pdf}`, `resolve_top_up{decision}` (36 → 29). Gating already beats that per deployment, and a preview sharing its code path with the charge is safer as a separate tool than as a boolean an agent can forget — a forgotten `dry_run: true` moves money.

**Every path that BUYS a basket validates it, and there were two.** `changePlan` has called `validateBasket` since it was written; `createCheckoutSession` never did — so `maxSeats`, a seat type's own `max`, `limits.members` and the plan's `sale` were enforced on an upgrade and by nothing at all on a FIRST purchase, where a browser stepper was the only gate. Fifty of a seat declared unique was one crafted request away, and it would have become a real subscription at a real price. Measured in a consumer: `validateBasket` appeared nowhere in scartoffie, whose stepper checked the total min/max and neither the per-type nor the member limit. It refuses **before the reuse cache**, since behind it one crafted request poisons the key for every later caller asking for the same basket. `InvalidBasketError` carries the `problems` array; `changePlan` keeps wrapping the same problems in `PlanChangeError("invalid_basket")` because it refuses for half a dozen other reasons and the caller branches on the code.

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

**Why a downgrade credits nothing.** It takes effect at the period end, so the customer keeps the tier they already paid for and loses nothing. `timing: "now"` drops immediately and credits the remainder — as a negative LINE on the next invoice, **not** as a customer credit balance, which this file claimed until it was measured (`scripts/live/08-plan-moves.mjs`: `customer.balance` never moves under the default proration). The distinction matters because a balance auto-applies to any later invoice and cannot be opted out of, while a line is confined to the invoice it sits on.

`previewPlanChange` shares `desiredPrices` and `diffItems` with `changePlan`, so the quoted number is the charged number — **pass it the same `proration` you will pass to `changePlan`**, or you are quoting a different policy from the one you apply.

### Four rules a real Stripe request enforces and a fake cannot

All four were live-only failures — every one passed the offline suite, because a fake accepts any params. Pinned in `tests/plan-change-live-defects.test.mjs`, which asserts on the params SENT.

- **Tax carries from BOTH places, not just the items.** Checkout writes rates per line ITEM; a subscription SCHEDULE can only hold them at the subscription level. So `diffItems` reads `items[].tax_rates` **and** `default_tax_rates` — reading only the first meant that once a scheduled downgrade released, the items were bare and the next upgrade's added line was invoiced at **0%**, on any subscription that had ever been downgraded.
- **`pending_if_incomplete` supports NO tax parameter.** Neither `items[].tax_rates` nor `default_tax_rates`; Stripe hard-400s rather than ignoring one, so `proration: "invoice_now"` could not run at all on a self-calculating account. Tax is a *configuration* change — applied immediately, generating no invoice — so it moves to a separate update issued FIRST, and the added line inherits it. Do not "simplify" that into one call, and do not drop `pending_if_incomplete` instead: it is what stops an upgrade applying before its invoice is paid.
- **The idempotency key names the MUTATION, not the target.** `items` is a diff, so upgrade → downgrade → upgrade back returns to the same prices and quantities while the request does not — a released schedule replaces the items, so the diff deletes a different `si_…`. Keyed on the target alone, the third move 400'd with an idempotency error naming a key the caller had never seen. `itemFingerprint` covers item ids, deletions, quantities and the carried rates; a genuine double-click still sends the identical diff, so it still dedupes.
- **A schedule owns the cancellation behaviour.** Stripe refuses `cancel_at_period_end` outright while one is attached, so `cancelPlan` **releases** it first — otherwise the one sequence a downgrade makes likely (downgrade, then cancel) was impossible. Abandoning the scheduled downgrade is correct there: they are cancelling, so the tier they would have moved to is moot.
- **And so does an IMMEDIATE change.** A pending phase replaces the subscription's items when it starts, so a customer who downgraded, changed their mind and **paid** to go back up was dropped to the lower tier at the period end — measured: the renewal billed €18 Starter after an upgrade to €90 Pro, with no invoice or event naming the cause. Every applies-now path releases the schedule; only the scheduled-downgrade path keeps it, because there it is the mechanism.
- **A held change is NOT an applied change.** A declined `invoice_now` upgrade comes back `status: "active"` with the items **unchanged** and `pending_update` set. `changePlan` reported `updated` and recorded the new plan on the org — so the mirror granted a tier nobody paid for, the meter resolved its pool, and if the invoice went unpaid the pending update expired in ~23h and the entitlement vanished silently. It now returns **`kind: "pending"`** with `pendingUntil` and `invoiceId`, files the target as `pendingPlan`, and leaves the plan in force alone.
- **An idempotency key dedupes a SEQUENTIAL repeat, not a concurrent one.** Two requests carrying it at once make Stripe reject the second with "another in-progress request using this Idempotent Key" — which is exactly what a double-clicked Confirm sends. The loser waits and re-sends, so the key replays the winner's response and both callers get the one real outcome. Matched on the message, deliberately: an `instanceof Stripe.errors.StripeIdempotencyError` guard did **not** fire on the real rejection, and the "key reused with different params" case has a different message so it still surfaces.

Two catalogue traps found the same way, both about `defaultBasket` reading each seat type's `min` (default **0**): a seats plan declaring none makes any `changePlan` without explicit seats throw *"No seats selected"*, blaming the caller for a gap in the config; and `planRank` prices that same default basket, so a higher tier whose extra seat type has no `min` **ranks equal** to the one below it — `isDowngrade` is false and `timing: "auto"` applies a downgrade immediately.

**Which KEY, for an `api` caller.** `validateApiKey` may return `keyId` alongside `orgId`, and `createApiMeterGuard` passes it as `caller.id`. An adapter that cannot tell keys apart records **no** caller id rather than a wrong one, since a plausible-but-wrong id is indistinguishable downstream from a real member. `memberUsage` narrows an `api` member to its own key when one is named, because "which key spent it" is what an admin screen asks — but the GATE still sums by KIND across the org (one shared agent seat), and a `scope: "caller"` limit sums every key, so per-KEY windows would loosen the aggregate and remain a product decision.

## Who is calling — org vs principal (`src/auth.ts`)

Every call resolves to an **org**. An org API key means exactly that — the org, with no person behind it, which is what a headless agent holds — so org-keyed calls are owner-level, deliberately.

A surface that DOES know the human (a server action, an OAuth token minted for a user) wraps the call in `runWithPrincipal({ authHeader?, orgId?, principal: { userId, isAdmin? } })`. Admin-only tools then call **`enforceAdmin(adapter, action)`** — `enforceAccess` plus `adapter.isAdmin` when a principal is present. `approve_top_up`, `deny_top_up` and `assign_seat_type` use it; `request_top_up` lets a known non-admin request only for themselves, since `member_id` arrives from the caller and unchecked would let a member queue grants against anyone's seat.

Two deliberate fallbacks, both "allow": no principal (the org-key case), and an adapter with no `isAdmin` — silently disabling every management tool for adapters without a role concept is a worse failure than the one being prevented. So with only org keys in play the API is permissive and the app's own UI gate separates member from owner.

**A route can now carry a principal, and until this it could not.** `runWithAuth` installs a *fresh* AsyncLocalStorage store, so a principal set outside the handler was discarded — `currentPrincipal()` read null, `enforceAdmin` took its org-key branch, and **no admin-only tool was enforceable through the REST or MCP route at all**. `runWithPrincipal` was exported and called nowhere in `src/`. An app whose own UI hit those endpoints was relying on gating it did itself, or on nothing. `createToolDispatchHandler({ principal })` and `createMcpTransport({ principal })` take `(request) => Principal | null`; returning null — or omitting it — keeps the org-key path byte for byte, which is what a headless agent holding an `sk_` key depends on.

**And a role refusal is HTTP 403.** `enforceAdmin` writes "Forbidden (403)" and the status ladder had no 403 branch, so every one was served as a 500 — the server reporting itself broken over something that is neither a fault nor retryable. Invisible until the principal option made the path reachable.

**`get_plan` is a READ and is not gated.** It called `enforceAdmin`, copied from the three tools that CHANGE a plan beside it, so a member could not answer "what is my workspace paying for" — while every other read (`list_invoices`, `get_credit_balance`, `get_usage`) is member-visible.

**The org gate answers "which workspace", never "is this person IN it" — so `enforceMember` is a separate check.** Three tools take a `member_id` (`assign_seat_type`, `grant_top_up`, `request_top_up`) and none verified it, so any valid org key could name **any user id in the environment**. What that reaches is not a wrong seat: all three write to the named user's WorkOS **user** metadata, which is global to the user, and the per-org keying meant the victim's own seat survived. It is the BUDGET — 10 keys, 600 characters per value, rejected as a whole once it overflows — so enough writes from a stranger and the victim's real workspace can no longer assign a seat or record a grant. A cross-tenant denial of service from a legitimate key. Absent `listMemberIds` the check allows, the same trade-off `enforceAdmin` makes and for the same reason.

**The check has to sit on the BOUND API too, not only in the tool.** A consumer that writes its own server action bypasses the tool entirely — scartoffie's seat control calls `assignSeatType` directly, so while the tool's hole was being closed its admin path still had none. `api.seats.assign` refuses a non-member; `assignSeatType` itself stays a pure storage write and `api.seats.assignUnchecked` is the deliberate way to seat an invitee who has not accepted, since `listMemberIds` counts only ACTIVE memberships.

**A SEAT IS A PRICE, and assigning one was free.** `assignSeatType` writes metadata and touches the subscription not at all, so an owner could move the whole team onto the €105/month Premium seat and no invoice would ever mention it — every member drawing the larger pack, the plan billing the smaller one. Unnoticed while seats were only set from a members table by someone reading prices; it became one click the moment the usage ladder let a member ASK for a bigger seat and an owner grant it from the row. `seatAssignable(adapter, orgId, model, memberId, seatType)` is the check, on both the tool and `api.seats.assign`, and it reads two different ceilings: **purchased** (`getSubscription().seatCounts[type]`) and the plan's own **`seatTypes[t].max` — the first is what was paid for, the second a product rule ("there is one shared agent seat"), and neither implies the other. Members with no explicit assignment are counted against the DEFAULT seat, because they draw its pack: counting only assignments let one purchased Standard seat carry a workspace of ten. **Unknown capacity ALLOWS** — no `seatCounts`, no subscription, a plan selling no seats — since refusing on a number the adapter cannot report would leave owners unable to seat their own team, which is worse than the giveaway. `assignUnchecked` stays the deliberate way past it. What this does NOT do is buy the seat: `change_plan` is still how a workspace gets another one, and the refusal says so.

**A seat key alone is not a permission — the plan has to SELL it.** `assign_seat_type` validated against the union of seat keys across every plan in the catalogue, which on a two-plan config reads as "premium is a known seat type" and let a workspace on a plan selling only Standard be put on Premium. Metadata is a plain write, `seatAssignable` fails open on a spec it cannot find (deliberately), and the member then drew a pack nobody bought — nothing in the chain asked the only question that mattered. Both surfaces now ask `seatTypeExists(model, key)` of the ORG'S OWN model, and the catalogue union survives only as the fallback where the plan is unknown, where refusing would be worse. `list_seats` had the mirror bug: it advertised the catalogue's types, so a picker built from its answer offered the seat the write refuses. It now answers with the plan's own types, its `ladder` (cheapest rung first, shared seats excluded), its `default_seat`, each member's rung with `is_top`, and `capacity`.

**`seatCapacity` is the same counting as a READ, and it exists because the guard is the wrong shape for a UI.** `seatAssignable` answers "may I put THIS member here" one candidate at a time and explains a refusal; a picker needs the number before it offers anything, and asking the guard once per seat type costs N × (assignments + members + subscription) reads. So consumers stopped asking and offered every seat. `remaining: null` means UNKNOWN — no subscription, no `seatCounts`, no `max` — and a UI must read it as available, never as full, exactly as the guard's fail-open does.

**Every read is member-visible; that is the rule, not an oversight.** Balance, usage, limits, spend controls, plan, seats, invoices, payment methods, profile, portal — and the top-up queue, which is workspace-wide, so a member sees colleagues' requests. Pinned in `scripts/live/09-roles-and-isolation.mjs`, because "what a member can SEE" is a decision no refusal governs and nothing had ever asserted.

**The LAST admin cannot be demoted or removed**, and this is the one place the library refuses on "I cannot tell". Measured before it was guarded: WorkOS accepts the write, `isAdmin` then returns false for everyone, and every admin-gated tool answers 403 to every human — an org API key still gets through, which is why it survives a headless test suite and only bites a real person, and why it is the way back in. `isLastAdmin` returns `null` when no role can be read (an adapter with `listMemberIds` but no `listMembers`), and callers treat that as REFUSE — the opposite of the "unknown allows" trade-off `enforceMember`, `seatAssignable` and the top-up gate all make, because here the thing being prevented IS the stranding. Promoting is never refused: it can only add an admin.

**A role change takes effect on the next call.** `isAdmin` reads WorkOS every time and is cached nowhere, so a promotion works immediately and — the half that matters — a demotion bites immediately.

## Closing a workspace — stop the billing, keep the records, then remove it (`src/close-workspace.ts`)

Deleting a workspace was one call (`deleteOrg`) that removed the WorkOS organization and nothing else. The Stripe subscription **kept billing the card every month** for a workspace that no longer existed, and because `stripeCustomerId` lives on the org, the deletion destroyed the only mapping from that charge back to anything: unattributable, indefinite, and silent — nobody refused, nothing errored.

`closeWorkspace(adapter, orgId, opts)` is the ordered version, and the order is the whole design:

- **The Stripe customer is NEVER deleted.** An invoice is a legally required record and deleting a customer takes its invoices with it — the one object that must stay is the one the instinct says to remove. It is annotated instead (`bt_closed_at` / `bt_closed_org` / `bt_closed_reason`), so a later audit can tell a closed workspace from a lost pointer.
- **If the billing cannot be stopped, the org is NOT removed.** A workspace still listed is a nuisance; an unattributable recurring charge is a customer's money. Every live status is stopped, `past_due` and `unpaid` included — those are the ones whose dunning emails would otherwise keep arriving after the customer left.
- **`cancelAt: "period_end"` + `deleteOrg: true` is refused up front**, because that combination *is* the orphan. Refused before acting, since the half of a half-done deletion is a deletion.
- **Each member's entries for that workspace are cleared** (`clearMemberRecords`). Both per-member stores are keyed by org, so a closed workspace's entries would otherwise sit in every ex-member's record for ever, spending a character budget their remaining workspaces still need. An emptied store has its KEY deleted rather than being written as `"{}"` — the budget is returned, not merely reduced.
- **No refund is issued.** A refund is a credit note with tax consequences, not a negative charge, so it stays the operator's decision; `cancelAt: "period_end"` (with `deleteOrg: false`) is the no-refund way to let a customer use what they paid for.
- **`findOrphanedSubscriptions`** finds what the old way already lost, bounded by subscriptions *examined* rather than orphans found. A subscription with no `org_id` is not an orphan — one created outside this library never had one, and reporting it would cry wolf.

**WorkOS organization deletion is eventually consistent** — measured at ~3–6s: `deleteOrganization` returns success and `getOrganization` still answers with the org. A UI that deletes then re-lists will show it, and a delete-then-verify check reads as a failed delete.

**`limits.members` is ENFORCED at the invitation, and PENDING INVITATIONS COUNT.** `list_plans` advertised it on every plan and nothing refused a membership beyond it, so a plan selling ten seats admitted a hundred — left to each app, which means each app wrote the counting and the count that matters existed per consumer. `memberSeats` / `inviteMember` (`src/members.ts`) own it now. Counting active members alone is not a limit: a three-seat workspace with one member can send two invitations and the third has nowhere to land, and the refusal — if it ever comes — arrives when the last person ACCEPTS, addressed to the one person who cannot do anything about it. A revoked invitation gives the seat back. **Membership creation is still the app's flow** (Pattern B needs its own row first); what the library owns is who may be added.

## Metadata is a budget, and a per-member record does not fit in it

WorkOS org metadata is **10 keys, keys ≤40 chars, values ≤600, ASCII**; Stripe customer metadata is 50 keys × 500. Treat both as a budget measured in **characters**, not records.

- **Never bound a packed value by a record COUNT.** A queue capped at 50 records in a value that holds 3, and a `member → cycle → credits` map that overflowed at the 12th member, both passed every test because the fake accepted any string. `tests/helpers.mjs` enforces the real limits, and anything packed into a value is trimmed against `METADATA_VALUE_LIMIT` — the same unit the store rejects on.
- **The blast radius is the whole org, not the record.** `setOrgMetadata` and `setSubscription` re-write the entire object, so ONE oversized value fails *every* metadata write for that org — a long top-up history stopped `past_due` from being recorded.
- **A per-MEMBER record goes on the member.** `adapter.getUserMetadata` / `setUserMetadata` (optional; `WorkOSOrgAdapter` has them) give each member their own budget, removing the ceiling rather than raising it. A grant is stored `{ [orgId]: { [cycle]: credits } }` — keyed by org because WorkOS user metadata is global to the user, and pruned to the cycle being written because `extraAllowance` only reads the current one. An adapter without them falls back to the org blob, reads included, so a grant approved by an earlier version still applies.
- **Correctness and history trim differently.** A request queue may drop **settled** records to make room, never a pending ask: losing history costs a UI a row, losing a grant costs the customer allowance they were promised.
- **A seat is never trimmable.** `seatAssignments` (`seats.ts`) had the same overflow at ~13 members, on the one plan shape whose premise is many seats. Dropping an entry silently downgrades a member to the default pack, so the per-member path does not write the legacy value at all — which is what lets an already-oversized org be assigned into. A cleared seat writes a **tombstone** (`""`) rather than deleting, because the legacy map is still read as a fallback and a plain delete would read back as the old seat.
- **Enumerating a per-member record needs `adapter.listMemberIds`** (`WorkOSOrgAdapter` lists active memberships; `memberCount` derives from it). Without it `listSeatAssignments` returns what the legacy map holds.

## Three different "more usage", and only one of them is money

They are constantly confused, so the distinction is worth stating once:

| | what it changes | invoice | expires |
|---|---|---|---|
| **extra allowance** (`request_top_up` → `grant_top_up`) | an ENTITLEMENT: one window, one member | **none — no money moves** | with the window |
| **credit top-up** (`buy_credits`) | the wallet, in real currency | a real invoice (`invoice_creation`) | never; credit sits until spent |
| **plan change** (`change_plan`) | the subscription | prorated line items on the next invoice | n/a |

**An extra-allowance grant touches Stripe not at all** — `src/topup.ts` contains no reference to it. It is a metadata write saying "this person may use more of what you already bought", so there is no charge, no line item and nothing to reconcile. An owner giving allowance away is not selling anything.

**You may only ASK when something is actually refusing you.** `requestExtraAllowance` refuses with `not_blocked` for a member with allowance left — the rule used to live only in the screens that draw the button, so any tool call, server action or agent could file one, and one did: a member on an untouched pack with a pending request against it, which then blocked the real ask they would make on running out. The GRANT is deliberately not gated the same way (an owner may top somebody up before they hit the wall — a demo on Monday, a Friday deadline — and it costs nothing), and an unreadable ledger ALLOWS, the same trade-off `enforceMember` and `seatAssignable` make. **The tools read the app's own ledger to answer it** (`registerBillingTools({ usageLedger })`, passed by `createBilling`): the default composite routes per-caller reads to balance transactions alone, so on a deployment whose per-seat usage is INCLUDED every caller window read 0 — `get_usage_limits` reporting allowance a call would be refused for, and a blocked member's ask refused as "not blocked".

**It raises the window that is REFUSING them, not everything.** `topUpTargetOf` picks the tightest exhausted caller-scoped window; a weekly grant leaves the monthly pack exactly where it was, and vice versa. If both are blocked the week goes first (it refuses the next call) and the pack is a second ask — measured in `tests/window-topup.test.mjs`, which also pins that the extra is gone when the window rolls, because it is filed under that window's own key.

**An ORG-scoped window can never be raised for a person.** It is the product's pace, not theirs; lifting it for one member lifts it for everyone, which is a plan change and not an exception.

**WHICH ask to offer is one decision, and `nextUsageAsk` owns it.** A ladder, cheapest and most targeted rung first, each existing because the one below cannot help:

1. **a better SEAT** — their pack is what their seat includes, so a Standard member out of usage should be offered a bigger seat, never a top-up. A top-up buys them a few days and leaves them in the same place next week. It outranks even a payable wall: the seat raises the pack AND the pace every cycle, where credits are this week's answer bought again next week.
2. **CREDITS, where money can actually lift the wall** — a `covers: "included"` window paces only what the plan gives away, and an exhausted pack whose plan overflows to the wallet says the same thing. Paying works, permanently and without anybody's permission.
3. **extra USAGE on the blocked window** — the answer where money CANNOT help: a `covers: "all"` window is the product's own pace, no purchase touches it, and an exception somebody grants is the only door.
4. **a PLAN change** — for a plan with no per-member allowance at all.

**Rungs 2 and 3 were ONE rung, and it was wrong in whichever direction a deployment went.** A plan whose card says pay-as-you-go sent a blocked member to ask an owner for something they could have bought in a click; a plan pacing the product would have offered credits that lift nothing, taking money for a wall still there. Which applies is not a preference — it is what `covers` says, so `topUpTargetOf` reports it and the ladder reads it rather than the config being stated twice. Both halves are necessary: the plan must SELL credits (`replenish.purchase`/`autoReload`) *and* the wall must be one credits reach.

Null when nothing is blocked, because a control permanently on screen asks a question nobody at 40% can answer. A screen inventing its own ladder is how a Standard member ends up being sold a weekly top-up forever.

**WHO may act on a rung is the LADDER'S, and `usageAction` answers it.** `nextUsageAsk` says which rung; that is half an answer, because every act on one is an owner action — `change_plan`, `assign_seat_type` (a seat is a price), `grant_top_up` — so a member's only route is a request. This used to be left to the consumer, and every consumer worked it out again in the component that draws the button: an agent hitting the same wall over the API got the rung and no idea that buying was not its call. `usageAction(model, {blocked, seatType, plans, currentPlan, actor, purchase})` returns `{rung, to?, actor: "self"|"admin", action}` where **`action` is a TOOL NAME** — `assign_seat_type` / `buy_credits` / `grant_top_up` / `change_plan` when the caller may act, the matching `request_*` when they must ask. A headless caller gets the next call; a UI gets one branch. It rides `get_usage_limits` as `next_step`, so the answer that says you are blocked also says what to do about it.

**A catalogue must not be offered what it cannot sell, and `request_seat_change` was.** It registered unconditionally whenever `plans` was passed, so a consumer with three FLAT plans over one shared pool — no seat at any price — advertised a tool for asking to be moved to a bigger seat, whose best possible answer there is a refusal. It is now behind `caps.seats`, the gate `list_seats` and `assign_seat_type` have always used. `request_plan_change` and `resolve_plan_request` stay unconditional on purpose: a plan change is the ONLY rung a pooled catalogue has, and `nextUsageAsk` climbs to it precisely because there is nothing per-member to raise.

**A pooled workspace is one ceiling, and `orgUsage` was summing it per member.** `limit = pack ?? pool` is right for a row — the pool caps that person just as hard as a pack would — but the aggregate then added it up, so a two-person workspace reported twice the credits it has and a ten-person one ten times, drifting further from true with every colleague hired. On a pooled plan `aggregate.limit` is now the pool ONCE, `aggregate.percent` is the pool's own usage (a mean of identical fractions is that fraction wearing a hat), `aggregate.seats` is 0 because no mean was taken, and `aggregate.pool` carries `{size, used, remaining}` so a caller never has to work out which shape it is holding. Each member row carries `shared: true`, which is what stops a renderer inviting the reader to add five identical numbers together.

**Taking money had exactly one shape, and it ended at a browser.** `buy_credits` returned a Checkout URL; a card could only be saved by confirming a SetupIntent with Stripe.js; the sole off-session charge lived inside `tryAutoReload`, threshold-triggered and uncallable; and nothing ever asked Stripe to EMAIL a bill. So a caller with no browser could be told how to pay and never actually pay. `purchaseCredits(customer, orgId, amount, config, {method})` is now one implementation with four methods — `checkout` (hosted URL), `embedded` (a client secret for an app's own Elements form), **`saved_card`** (invoice + `pay({off_session:true})` + credit — headless end to end, no URL and no human) and **`invoice`** (`collection_method: "send_invoice"` + finalize + send — the path for a customer with NO card, which is precisely what `saved_card` cannot bootstrap). Refusals are codes with the alternative named in them: `no_card` points at `invoice` and at the portal's `payment_method_update` flow, `no_email` at `set_billing_profile`, and a decline comes back as `charge_failed` rather than as a throw an agent reads as a 500.

**The emailed invoice needed a crediting path, and neither existing one would take it.** A manual invoice arrives as `invoice.paid` with `billing_reason: "manual"`; the webhook route only handled `checkout.session.completed`, and `createStripeEventHandler` returned early unless the reason was `subscription_create`/`subscription_cycle`. Both now credit when `invoice.metadata.credits` is set — and on the SAME idempotency key (`credit:invoice:<id>`) the off-session path uses, so a charge credited synchronously cannot be credited a second time when its event lands.

**`createCreditCheckoutSession` returns the session, not a string.** It used to return one string whose meaning depended on the mode, which forced every embedded caller to recover the session id by splitting the client secret on `_secret_` — a consumer did exactly that, in production, with a comment apologising for it.

**`describeDenial` reads `Messages` now, and that was the gap that mattered most.** It is the one string a REFUSED caller actually reads, and it was the one the package hardcoded — while `poolExhausted`, `seatAllowanceReached` and `insufficientBalance` sat in the message table read by nobody, and the two refusals customers meet most (`rate_limit_reached`, `spend_limit_reached`) had no key at all. A consumer selling in one language translated refusals by mapping reason codes on its own screens, so the same customer got Italian in the browser and English from a tool call. `config.messages` is now the one place a deployment states its words; the meter passes them into every 402/429 body, `changePlan` into every basket refusal, and an unlisted key falls back to English rather than to nothing.

**A default spend ceiling has to be enforced by the METER, not persisted by a page.** The one consumer that wanted every workspace capped got there by writing the default the first time its billing page read the controls — so the ceiling existed only for a workspace somebody had opened that page for, and every API-only one was uncapped with nothing saying so. `config.spendLimit.defaultCredits` is read by `resolveAllowance`, so it applies to a customer who has never seen a screen; `get_spend_controls` reports the EFFECTIVE ceiling plus `limit_source` (`"customer"` | `"default"`), because a settings screen showing `null` while the gate applies a default is the screen contradicting the gate; and `required: true` refuses clearing it, which otherwise leaves the customer reading "no limit" and being refused at the old one.

**The card policy is the library's too.** `attachedPaymentMethod` makes the FIRST card the default whether or not it was asked for — a customer with one card and no default has a card on file and nothing chargeable, because every invoice and every auto-reload reads the default — and `prunePaymentMethods` evicts least-recently-used down to `config.paymentMethods.maxCards` (default 3), never the default at any count. LRU needs a stamp Stripe does not keep, so `touchPaymentMethod` writes `last_used_at` on the PaymentMethod itself: a fact about the card, surviving every path that charges one, and detached along with it.

**What one purchase and one grant may be is the PLAN's rule, and `purchaseBounds` / `requestBounds` publish it.** Both were literals in a tool schema — `min(5).max(200000)` on `buy_credits`, `min(1).max(1000)` on `grant_top_up` — and re-declared in every consumer's form. Scartoffie clamped the grant at 500 in a server action, again at 500 in a number input, and the tool took 1000: three answers, and the loosest was the one an agent hit. `percent: 2500` is a plausible typo that hands out 25× a seat, free and uninvoiced. A tool schema is registered ONCE for every plan, so it takes the WIDEST bound in the catalogue and the handler enforces the org's own — pinning the schema to the narrowest would refuse a purchase the customer's plan permits, and the caller could not tell which rule refused them.

**`config.roles.purchase` is the one part that is genuinely a deployment's choice**, because a product whose members hold their own cards is a real arrangement. It moves the CREDITS rung and nothing else. Its default is `"admin"`, and that default is a fix: `buy_credits` and `set_auto_reload` were `enforceAccess`, so any member holding an org key could charge the card the owner saved — while the consuming app's own buy button refused them. A rule the frontend enforces and the API does not is exactly the gap this library exists to close, so both tools now read the same value the ladder reads.

**Where extra allowance cannot apply, the other ask is a PLAN change** (`src/plan-request.ts`). A pooled plan has nothing per-member to raise, so `grant_top_up` refuses it (`not_capped`) and a screen offering one offers a door that does not open. `request_plan_change` queues "please move us up" for whoever can, defaulting to the next tier — the member is saying they need more, not choosing a SKU. **Resolving it moves no plan and charges nobody**: `change_plan` takes a payment, and nothing a member asks for may charge an owner as a side effect of being answered. A request is satisfied the moment the workspace is on that plan or better, however it got there, so a want somebody already granted stops appearing without anyone clicking.

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

**The caller axis needs TWO questions, because asking one was wrong in both directions.** An *org*-scoped limit carrying `callerKind` is issued as a caller-filtered read, so filing it under `orgIncluded` made it read 0 for ever; a `scope: "caller"` limit over always-wallet-funded usage is answered exactly by the debits, so demanding a store rejected working configs. The axis is needed when the read is caller-filtered (`scope: "caller"` **or** a `callerKind`) **and** the usage behind it can be included. Pinned in `tests/ledger-coverage.test.mjs`.

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

`resolveTax` works the rate out locally from `eu-vat-rates-data` (45 European countries, tracked daily from the European Commission's TEDB) with VIES for B2B validation, and `taxRatesFor` applies it as an explicit Stripe **TaxRate** — no per-transaction fee. `updateCheckoutSessionTaxRates` re-taxes an open session when the typed country differs from the one guessed — **measured live** (section 03d): 22% IT at creation → 19% DE once the address is known → the rate REMOVED for an out-of-scope customer, with the total following each time. Two details only a real session shows. The applied rates are not on `line_items` from a session retrieve (that shape carries `amount_tax` and no `taxes` array); they need `listLineItems` with `data.taxes.rate` expanded, and the rate OBJECT is what has to change rather than just the percentage, because it is what carries the mandatory mention onto the invoice. And an empty list must CLEAR the rate: replacing it would leave an out-of-scope sale charged the seller's own 22%. What you take on instead: evidence-of-location records for EU B2C, threshold monitoring, and filing.

**WHO calculates is declared ONCE, and every charge the library builds reads it** — the seat Checkout Session, the `buy_credits` top-up, the auto-reload invoice:

```ts
config: { baseUrl, currency: "eur", tax: { origin: "IT" } }   // ← the whole tax config
```

Per-site tax arguments meant the answer to "does this deployment charge VAT" lived in as many places as there were charges — which is how the auto-reload and the top-up went out at 0% while every seat invoice on the same account charged 22% IVA. `checkBillingSetup({ config })` reads the same field, so the doctor cannot disagree with the engine.

- **Configuring nothing means `"local"`**; `mode: "none"` is how you say "untaxed", explicitly. `taxModeOf` owns the precedence.
- **Three modes, and `config.tax` is a DISCRIMINATED UNION so the wrong pairing cannot be written.** `local` constrains `origin` to the 45 countries the dataset covers (`LocalTaxOrigin`), so `origin: "US"` — or AU, JP, SG, CA, BR — is a **compile error** rather than a charge refused at runtime. `resolveConfig` throws for the half types cannot see: an origin that is cast, or inferred from a US Stripe account with none declared. **For an establishment the local engine cannot compute, `mode: "stripe"` is the answer** — Stripe owns the calculation and the invoice, so no rate conversion exists to be wrong.

  **`mode: "external"` was removed, and the reason is a warning about seam design.** It took an injected `calculate` so a third-party provider could answer, and no adapter ever shipped. One did briefly, for Numeral, written from a docs summary rather than the OpenAPI spec — it could not have worked: the version header is mandatory, `customer`/`origin_address`/`order_details` are all required, and the response carries `total_tax_amount` and no rate field. But the deeper problem was the seam itself: it passed an address and expected a **RATE**, while every provider of that kind (Numeral, Anrok, Vertex, Stripe's own Tax API) takes a **BASKET** and returns an **AMOUNT**. So it could not have been adapted without changing its own signature, and converting an amount back to a percentage drifts from the figure the provider actually files. An extension point that cannot reach the thing it exists for is a false statement about what the library supports; deleting it is the honest version. If a provider seam returns, it takes `currency` + `lineItems` and yields an amount.
- **`originFor` is the one place the origin resolves** — `config.tax.origin`, else the Stripe account's country (memoised, never throwing, since it sits behind `taxFor` on a charge path). Because the declared value WINS, the two can disagree in silence, so the doctor compares them and warns (a consumer's `TAX_ORIGIN` said FR while its own setup script registered IT). **Declaring it is not redundant with reading Stripe, and must stay** — three reasons, each checkable: `origin` is typed `LocalTaxOrigin`, so `"US"` under `mode: "local"` is a **compile error** where an inferred one is not; a declared origin means the rate needs **no network** on the charge path, whereas an inferred one that fails to read returns `null` and every charge goes out **UNTAXED** with a console warning as its only signal; and a test-mode account in another country would silently compute a different rate from live. `resolveConfig` throws for a declared-but-unsupported origin at boot — it is synchronous, so the *undeclared* case is the one only the doctor can reach, and it is an **error** there. **Stripe cannot supply the rest of the legal identity** — on the account's own key `company` returns `name` and nothing else: no `tax_id`, no `vat_id`, no `registration_number`, no address, and `individual` carries no address either. `business_profile.support_address` is a SUPPORT address, so using it on an invoice or a mentions légales page would be wrong. Legal identity stays the app's to declare. Nothing else may read `tax.origin` and **consumers must not keep their own copy**: it decides domestic vs cross-border, so a second copy is a second answer. One consumer's `const TAX_ORIGIN` said `FR` while its own script registered `IT`.
- **`rates` is the authoritative hook** for an app resolving from its own records, and is per-ORG, which `config.tax` cannot express (hence `topUp.taxRates`).

### The two rules the rest follows from

1. **A rate is charged where the SELLER's regime says tax is due, never because the dataset has a number for the destination.** Only 27 of the 45 countries are in the EU, so "we have a rate" is not "you owe it": GB, CH, NO, TR and IS once fell through every EU branch and were charged their own domestic rate — an Italian seller invoicing 20% "VAT" to a UK customer, which is neither EU VAT nor collectable without a UK registration.
2. **Every uncertainty resolves toward CHARGING** — an unverifiable VAT number, an address that cannot be placed, a tax id contradicting the address. Wrongly charging is recoverable; wrongly exempting means owing the tax yourself.

So `TaxDecision` separates **`outOfScope`** (0% is the complete answer) from **`approximate`** (tax IS due and there is no rate for where it is due, so the charge is refused). There is **no override flag**: the ways out both assert something true — `registrations` if you do not owe it there, `mode: "stripe"` if you do, `mode: "none"` to charge nothing deliberately.

### The inputs

**`sellerRegime({ country, vatRegistered, oss?, alsoCollectIn? })` is the front door**, because the model was always expressive enough and never obvious. Two facts stood between a developer and a correct charge: **omitting your own country from `registrations` is how a domestic exemption is said**, and **`oss` covers the member states independently of that list**. Together they express the state that looked impossible — exempt at home, destination VAT across the EU, 20% to a UK consumer — and `tests/seller-regime.test.mjs` pins the OUTCOME at each stage a European small business passes through, not the shape of the object:

| regime | domestic | EU B2C | EU B2B | GB B2C |
|---|---|---|---|---|
| `vatRegistered: false` | 0% | 0% | 0% RC | 0% |
| `+ oss: true` (past €10k EU B2C) | **0%** | 22% / 19% | 0% RC | 0% |
| `+ alsoCollectIn: [{country:"GB"}]` | 0% | 22% / 19% | 0% RC | **20%** |
| `vatRegistered: true` | 20% | 22% / 19% | 0% RC | 20% |

`vatRegistered` is a **domestic** fact and changes nothing cross-border — the last two rows differ in one cell. It adds no capability: it returns a plain `config.tax`, and anything it expresses can still be written by hand.

**Every form the library builds collects the address and the tax id** — including the TOP-UP, which did neither until this was noticed. That session issues an invoice, and for a wallet-funded product it is usually the first and only form a customer sees: so the invoice carried no billing address (EU B2C needs evidence of location), a business had no field for the number that reverse-charges the sale, and a rate resolved from `customer.address` fell back to the seller's own country — which is how a UK-registered seller would have charged a UK consumer 0%. `customer_update` rides along because without it the typed address stays on the session and never reaches the Customer, where the *next* charge looks for it.

**Two different facts, and conflating them is why `registrations` felt like busywork.** WHAT EACH COUNTRY DEMANDS of a seller with no establishment there is objective, identical for every deployment, and belongs in the library exactly as the rate data does — it now lives in **`src/tax-obligations.ts`**, one file, because these rules move. WHERE YOU ARE REGISTERED is a fact only the seller knows, and the library must never assume it: charging UK VAT without a UK registration is collecting tax you cannot remit, which is worse than not charging. So the rules file does not replace `registrations`; it is what lets the doctor say the declaration is **incomplete** — "2 customers are in GB, which taxes a non-established seller from the first sale, and registrations does not include it".

**A zero-threshold country is an ERROR; a thresholded one can only WARN.** GB is the outlier the file exists for: the £90 000 threshold is for UK-*established* businesses, so a non-established supplier of digital services to UK consumers registers from the first sale (HMRC VATREG37200) — a certainty needing no knowledge of turnover. NO (NOK 50 000) and AU (A$75 000) can only be warnings, because whether you crossed a threshold is a fact about your books and a library that pretended to know would be guessing. **B2B is excluded where the country reverse-charges**, which is nearly everywhere — HMRC's own words are that such a seller is "not entitled or liable to register", so requiring a VAT id is the real alternative to registering.

**The list is deliberately short, and absence means NO CLAIM.** Only countries whose rule has been read and cited, each with a `source` and a `reviewed` date. A plausible-looking threshold for a country nobody checked is worse than no entry, because it would be trusted — so `nonResidentRule` returns undefined for JP or BR and the doctor stays quiet rather than reassuring. EU member states are absent for the opposite reason: the engine already models place of supply, the €10 000 cross-border B2C threshold, OSS and reverse charge, so a second statement here could only disagree with it.

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

**`mode: "stripe"` has FOUR prerequisites, and only one of them fails silently — measured against a live test account, not reasoned about.** With a head office set but **no active registration**, an invoice came back `tax 0.00` with `automatic_tax.status: "complete"` — nothing in the request or the response says anything is wrong. With a registration, the same invoice charged **20% FR VAT** on a domestic sale, 0% to an IT consumer (not registered there), 0% reverse-charged to an IT business, 0% out of scope to a US consumer. The other two prerequisites **hard-error**, which is the merciful failure: a price whose `tax_behavior` is unset ("required for automatic tax computation") and no tax code anywhere ("You must specify a tax code in all line items… or set a default"). So `ensurePlans` setting `tax_behavior: "exclusive"` and `stripeTax.taxCode` are not optional polish — without them every `automatic_tax` charge 400s — while the registration is the one the doctor must **error** on rather than warn, because a request can never see it. Pinned in `tests/tax-mode-e2e.test.mjs`.

`checkBillingSetup({ taxMode })` names WHERE calculation happens: `"local"` (the default, and deliberately not `"auto"`, which would name this mode after `automatic_tax`, its alternative) lists the TaxRates that exist — the audit trail of what the account charged, legitimately empty on a fresh one; `"stripe"` audits head office, registrations and `tax_behavior`; `"none"` skips it. `ensureTaxSetup` is explicit-only.

### What an invoice must SAY, not just what it charges

**The supplier's own VAT number was on none of them.** Art. 226(3) of the VAT Directive requires an invoice to carry the SUPPLIER's VAT identification number, and for a reverse-charged EU B2B supply it is mandatory beside the customer's (C-247/21 again: an omitted mention cannot be cured afterwards). Stripe prints the account's business name and address from Dashboard settings but **no tax id of its own**, and the number lives in the consuming app's entity declaration — so every invoice this library produced was defective, and `list_invoices` / `view_invoice` returned that document faithfully. `ensureAccountTaxId({ type, value })` creates it as a tax id owned by the ACCOUNT (not a customer) and sets `default_account_tax_ids`, because an id that exists but is not the default prints on nothing. Idempotent by value: a second id with the same number would leave Stripe choosing which to print. It THROWS, unlike the lazy provisioning — a missing supplier VAT number is a defective invoice, not a degraded one.

**"Require the VAT number when the address is in a country I am not registered in" cannot be done in one hosted session, and it is worth knowing why.** Stripe's `tax_id_collection.required` has exactly one value, `"if_supported"` — required wherever Stripe supports a tax id type for that country — so it is **all-or-nothing across countries**, and turning it on also blocks every legitimate B2C sale in France, Italy and everywhere else it is supported. It is also **rejected under `ui_mode: "custom"`**, so an elements deployment must enforce it itself. And the timing defeats it anyway: the address is typed INSIDE Stripe's form, after the session was created with the flag already fixed. `taxIdRequired` exposes the capability honestly (hosted only, dropped rather than sent in elements mode, part of the `reuse` key), but the two shapes that actually work are to ask for the country in your own step first and create the session accordingly, or to **register where you owe and charge the rate** — which needs no tax id from the customer at all.

**Every path collects the customer's half, and the tools match the forms.** The seat checkout, the top-up and the add-card form all set `billing_address_collection: "required"` + `tax_id_collection` + `customer_update`; `set_billing_profile` (full address, company name, invoice locale) and `set_tax_id` are the programmatic equivalents, so an API/CLI/MCP caller can supply exactly what a browser can. The top-up was the exception until this audit — see above.

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

**`creditWallet: true` is what makes a paid request WORTH something.** The protocol was complete and pointless: a request could be challenged, paid and verified, and the payer got nothing, because `onPaid` was a callback the consumer had to write — so "the agent paid" and "the agent has credits" were unrelated events. Through `createBilling`, a settled payment now credits the paying org's wallet, keyed `credit:mpp:<challengeId>` (server-issued and single-use, so a replayed retry credits once). The org comes from the request's API key in `Authorization: Bearer` **or `X-Api-Key`** — the retry's Authorization header carries the payment credential instead, which is exactly the caller that hit 402 on an empty wallet. An anonymous payer credits nothing; there is no wallet to credit, and the settlement is still between that agent and Stripe.

**It had no tests, and now it has six.** The challenge is a wire format other people's clients parse, so `tests/machine-payment.test.mjs` asserts it header by header — the `Payment` scheme, every parameter, `application/problem+json`, `Cache-Control: no-store`, the `accepts` array, both credential headers, and that a rejection is another 402 rather than a 500. "We changed the quoting" is not something a type checker notices.

**Dunning / `past_due`** comes from the polled `customer.subscription.updated` **and** `invoice.payment_failed` events → `adapter.setSubscription("past_due")` + the `hooks.onPaymentFailed(orgId)` hook.

**`invoice.subscription` NO LONGER EXISTS, and reading it silently disabled two branches.** In the API version this SDK pins (2026-02-25) it moved to `invoice.parent.subscription_details.subscription` — the same relocation as `current_period_end` moving off `Subscription` onto `SubscriptionItem`. Both invoice branches opened with `if (!invoice.subscription) return`, so against a real account they returned immediately, every time: **`invoice.paid` never granted a renewal's credits** (any plan with a `grant` gave a paying subscriber nothing, monthly, silently — both shipped consumers use `grant: none`, so no live deployment lost credits, but the branch existed for the ones that don't), and **`invoice.payment_failed` never recorded `past_due` nor fired `onPaymentFailed`**, so an app could not tell Stripe was dunning its customer. `subscriptionRefOf` reads both spellings; `parent.subscription_details.metadata` also carries `org_id`, so the org resolves even when the retrieved subscription has lost it. Found by replaying a REAL event — a fake built from the same wrong assumption agreed with the code. Stripe Smart Retries and the card updater handle retries (Dashboard config, no code). `createBillingPortalSession(customerId, returnUrl)` and `get_billing_portal` return the no-code self-serve surface.

**What the payment forms offer is a library default, not an app decision** (`payment-method-config.ts`). Every form the library builds resolves `defaultPaymentMethodConfig(kind, config)` when the caller names no `paymentMethodConfiguration`, and the answer is **card + Apple Pay + Google Pay, nothing else**.

- **Wallets are in** because they are not another way to pay — Apple Pay and Google Pay ARE the card with the typing removed. Forced ON rather than inherited, so they don't depend on a Dashboard toggle.
- **Everything else is out.** Inheriting every method the account had enabled put a tab row — Carta, Klarna, Amazon Pay, Satispay — in front of every customer of an app that had always shown one field. A method reaches a customer because someone chose to sell that way; inheriting it from a toggle is not that choice. An account that does sell via SEPA or iDEAL passes its own `paymentMethodConfiguration`.
- **Link is off, and that default is the point.** Link's inline signup is drawn by the Payment Element from the **account's** Link setting, so it survives both `wallets.link: "never"` (which removes only the Link *wallet*) and `payment_method_types: ["card"]`. A payment-method configuration is the only lever, obscure enough that leaving it to each consumer meant every app shipped the signup by accident. `config.paymentMethods.link = true` opts back in.

`ensurePaymentMethodConfig` takes `only` / `enable` / `disable`, memoised per process and idempotent by `name`. `defaultPaymentMethodConfig` **never throws**: a restricted key that cannot read configurations returns undefined and the form renders with the account default, because a missing permission must not take down checkout.

## Telling somebody — notifications (`src/notifications/`)

The library knows the moment an invitation exists, the moment a member asks their admin for
more credit, the moment an admin answers, and the moment somebody hits a wall. It renders no
email, in no language, and it never will: a branded template is JSX in the consumer's app, in
the consumer's words. So it does not send. It **says**, and the consumer sends.

`notifications: <Notifier>` on `createBilling` turns it on; absent, every emission is a
no-op that costs nothing (`createEmitter` returns `undefined` and every call site is
`notify?.(…)`). The shipped transport is **`webhookNotifier({ endpoint, secret })`** — for
the common case where the code that CAN render the email is one HTTP hop away, which is
exactly why the three invitation tools used to be missing from a deployment whose invite
email was react-email in a Next app.

**The contract: emitting never throws and never blocks.** Every event describes something
that ALREADY happened, so a failed delivery must not undo it or delay it. `createEmitter`
holds the one `.catch()`, rather than each of the eight call sites — where the ninth would
forget, and a down email service would roll back a granted top-up. Same rule, same reason as
`usage-faults.ts`.

**Recipients are resolved HERE, not by the app.** "Email the admins" is a question about
membership and roles, which is this package's; answering it in a consumer means answering it
once per consumer. A call site states an **audience** (`{kind:"admins"}`,
`{kind:"member",memberId}`, `{kind:"email",email}`) and the emitter turns it into addresses
off the hot path — one `adapter.listMembers`, which also fills in the member's own address
where the event names one. An adapter that cannot list members tells nobody rather than
throwing, and nobody-to-tell skips the round trip entirely.

**But nobody-to-tell only applies to an ADDRESSED event.** An event carrying no `audience` was
never this library's to address: its recipients are the DEPLOYMENT's — an ops inbox, a Slack
channel, a CRM — and the consumer routes it, so an empty `to` is its shape rather than a
failed lookup. The guard reads `audience && !to.length`. Every event shipped today IS
addressed; the one that was not (`quote.requested`) went when custom pricing became a plan
change, and its union variant went with it, because a variant a consumer can write a handler
for that never fires is the same false statement as a dead tool. The branch stays: dropping
that event on the "nobody to tell" test meant the single event its operators existed to
receive was the single one **never delivered**, with nothing erroring — invisible offline
because every emitter test passed an audience.

**Ids are stable and derived, never random or timestamped.** `invite:<invitationId>`,
`topup-requested:<requestId>`, `topup-approved:<requestId>`, `upgrade-requested:<requestId>`.
A receiver dedupes on that id, so a retry, a re-delivery or two replicas send one email — and
`topup-denied:` is a different id from `topup-approved:` on purpose, so a second decision is
not swallowed as a repeat of the first.

**The wire format is a leaf entry point.** A receiver imports `verifyNotification` from
`@arnaudjnn/billing-tools/notifications`, which pulls no Stripe, no WorkOS, no MCP SDK — the
same reasoning as `/plans`. The signature is Svix-shaped (HMAC-SHA256 over
`<id>.<timestamp>.<body>`, ±300s replay window, `timingSafeEqual`) because that is what a
consumer's inbound route most likely already verifies. `webhookNotifier` retries 5xx and
network failures, and does **not** retry a 4xx: the receiver understood and refused, and
repeating it only doubles the refusals.

**Usage alerts (`src/alerts.ts`) are the one kind only the hot path can notice.** Nothing
else knows the moment a call took somebody from 79% to 81%, and `meterUsage` already holds
the whole `AllowanceState` — pack, pool, and the customer's own ceiling — because it had to,
to decide the call was allowed. So the check is free: no extra read, no cron re-walking every
workspace. Fired after the charge, fire-and-forget, beside the auto-reload.

Two kinds, one event. **Percent** thresholds on an allowance the PLAN gives (default
`[80, 100]`, `meter.alertThresholds`), and **credits** on the customer's own spend alerts
(`setSpendControls`'s `alertCredits` — collected by a billing page since forever and read by
nothing until now; it comes off the customer object `resolveAllowance` already retrieves, so
carrying it costs nothing). Rate limits are deliberately never alerted on: they reset within
days and the customer cannot act on one.

Said ONCE, which is the whole difficulty. The store holds the HIGHEST threshold announced per
subject per cycle — that single number answers both "again?" (no) and "the next one up?"
(yes) — in ORG metadata for a pool or a ceiling and in the MEMBER's own store for a seat
pack, bounded to three workspaces the way the grants store is. A new cycle replaces the
record rather than appending, which is also what makes the alerts fire again next month. The
read-modify-write is deliberately not transactional: two concurrent calls can both decide to
send, and the derived id (`alert:<org>:<cycle>:<key>:<threshold>`) turns that race into one
email at the receiver. Locking a metered call to avoid a rare duplicate would be the wrong
trade by a wide margin.

Events today: `invitation.created`, `topup.requested`, `topup.resolved`,
`upgrade.requested`, `quote.resolved`, `usage.threshold`. They fire from the choke points every path funnels through —
`requestTopUp` (the raw tool, the derived `requestExtraAllowance`, and `api.topUps.request`
all reach it), `approveTopUp` / `denyTopUp` / `grantTopUp`, `requestSeatChange` /
`requestPlanChange`, and the invitation service, which `createBilling` **wraps** so the event
fires whatever service was passed and whether or not it has a `sendEmail` hook of its own.

## Custom pricing — in the taxonomy that already existed (`src/plan-request.ts`)

`sale: "quote"` used to be a label: it withheld the self-serve tools, rendered "contact us",
refused `validateBasket`, and there the trail ended. The first attempt at fixing that grew a
family of its own — `request_credit_quote` / `list_credit_quotes` / `resolve_credit_quote`,
over a second store — and **that was the mistake**. Asking to move to a plan you cannot buy
self-serve is the SAME act as asking to move to one you can. `request_plan_change` already
means "I want to move up", already keeps one open ask per member, and already tells the
people who can answer. A quote-only plan does not need another verb; it needs the answer to
be able to carry a price.

So the record grew and the family collapsed. `PlanRequest` gains `seats`, `contact`, `quote`
and `accepted`, plus a `quoted` status between `pending` and `done`. Four verbs, three
authorities:

| | who | what |
|---|---|---|
| `request_plan_change` | admin | the ask. `metadata` is the consumer's own form, verbatim; `contact` comes from the SIGNED-IN user, never typed |
| `quote_plan_change` | **operator** | a quantity and a price PER CREDIT |
| `accept_plan_quote` | admin | takes it, and pays it |
| `sell_credits` | **operator** | the same sale with no request behind it |

**Gated by the catalogue, like everything else.** `toolCapabilities` gains `quote`, derived
from `sale: "quote"` on any plan: a catalogue where everything is self-serve has no
conversation to price, and three tools for one it cannot have is the same false
advertisement the seat group already refuses to make. gtm-tools registers none of them;
scartoffie registers all three because its Enterprise tier is quote-only.

**`metadata` is a BAG, not fields.** The library acts on none of it: one consumer asks for
`totalEstimatedSeats`, the next will want a region, a use case, a contract start. Typing each
one would make this package the place a consumer edits to add a question to its own form,
which is the opposite of what a seam is for. Bounded at 300 characters and DROPPED rather
than truncated when it does not fit — the whole queue shares one 600-character metadata
value, so an oversized bag would evict somebody's pending ask, and losing the extras is
recoverable where losing the question is not.

**Per credit, not per deal.** That is what a negotiation is actually about — "we can do
0.7¢" survives the customer changing how much they want, and a total does not. The total is
arithmetic, computed in `quotePlanRequest`, so the figure a customer accepts and the figure
they are charged cannot drift. Fractional minor units are allowed on purpose.

**Accepting charges the card on file, or emails a bill.** `sellCredits({ method: "auto" })`
reads the wallet FIRST, because `collection_method` cannot be changed after an invoice is
created: a card means `charge_automatically` + `invoices.pay({ off_session: true })`, no card
means `send_invoice` at net 30. Off-session because nobody is at a browser — this is an admin
accepting a price agreed days ago. A DECLINE leaves the finalized invoice behind rather than
losing the sale: it is payable from its hosted page, and the credits still land through
`invoice.paid`. `saved_card` forces the charge and refuses instead of falling back, for a
caller that needs to know.

**And it is TAXED like every other charge, because `sellCredits` takes the `ResolvedConfig`.**
It resolved no tax at all and its one caller passed none, so the largest sale the library
makes went out at 0% while every seat invoice and every top-up on the same account carried
the account's rate — the auto-reload defect, on an Enterprise deal, with the mandatory
mention missing from the invoice most likely to be audited. The currency AND the tax
declaration both come off that one object, so neither can be a second answer: manual rates
ride the ITEM, `automatic_tax` rides the invoice, exactly as `purchaseCredits` does. Measured
live in `scripts/live/13-*.mjs` at €4 200 → €5 124 with `22% "IVA"` on the rate.

**An invoice EATS the customer's own credits, and `creditsOwedFor` is what gives them back.**
Stripe applies a customer's credit balance to any invoice it finalizes, and this library's
wallet IS that balance. Measured on a real account: a €4 200 sale of 600 000 credits came out
`subtotal 420000, starting_balance -500, amount_due 419500, ending_balance 0` — the customer
would have paid €5 less and LOST the 500 credits they were already holding, which is the one
outcome nobody would agree to. There is no per-invoice flag to refuse it, so the fix is on
the other side: `invoice.paid` grants what was sold PLUS what the invoice consumed. The rule
lives beside `grantCredits` because it belongs to every invoiced purchase — a quote, a
`buy_credits --method invoice`, an auto-reload — not to the quote path that happened to
expose it.

**The credits are granted by payment, never by acceptance.** `metadata.credits` on the
invoice is the negotiated quantity and the amount is the negotiated price — the one place in
this library where they are allowed to differ — so the existing `invoice.paid` branch grants
exactly that, with the `credit:invoice:<id>` key it already uses. No second crediting path,
and an unaccepted or unpaid quote hands over nothing. Every tool answers
`credits_on_payment`, never `credits`.

**`enforceOperator` is the only gate here that FAILS CLOSED.** Everywhere else an
unanswerable question allows — `enforceAdmin` lets an org API key through, an adapter that
cannot report roles does not lock every management tool — because the thing prevented is
smaller than the thing broken. Invert it here and "unknown allows" means any workspace key
prices its own discount. `BILLING_OPERATOR_EMAILS` for a signed-in human (the principal
carries `email`, because an operator is identified across workspaces rather than by a role
inside one) and `BILLING_OPERATOR_TOKEN` as `X-Operator-Token` for a machine.

**Neither operator tool is advertised to a customer.** The REST list filters
`OPERATOR_TOOL_NAMES`, and the MCP transport builds TWO memoised tool sets rather than one,
because `createMcpHandler` registers once and serves every connection from that server. An
honesty boundary, not a security one: the gate runs at call time and does not care what was
advertised — the dispatcher keeps both registered so an operator can call them through the
same REST surface a customer reads the list from.

## Mounting in a Next app

**Both consumers mount this way, and hand-wiring is the thing it replaces.** gtm-tools kept five factories plus its own MCP route, REST routes and Stripe webhook, and every defect that cost it something came from that: no `customer.subscription.*` branch, so nothing wrote the org's `plan` and every subscriber metered as planless (`planModel(plans, null)` is null — the pool they bought never applied); no idempotency key, so a re-delivery double-credited; `caller.id` set to the org id; and an empty wallet answered 500. **The composition is not boilerplate — it is where those five decisions live**, so a consumer writing its own re-decides them all, silently and one at a time.

**One-call:** `createBilling({ adapter, config, plans?, toolCosts?, registerTools?, agentAuth?, webhook?, machinePayment? })` (`src/create-billing.ts`) returns `{ mcp, restList, restDispatch, webhook, agentAuth, machinePayment, paymentMd, cli }` from a single module instance (shared AsyncLocalStorage). It is sugar over the factories below, all still exported: `registerTools` registers the app's own product tools alongside the billing ones, `agentAuth` auto-wires `resourceMetadata` onto the REST/MCP 401s, and `machinePayment` returns the MPP `requirePayment` handler plus a `/payment.md` handler branded from `agentAuth.branding.productName`. Or wire them by hand:

- **MCP** `app/[transport]/route.ts`: `createMcpTransport({ adapter, config })`. **`requireAuth` gates the HANDSHAKE**, not just the tool calls — off by default, because each tool enforces access itself, so an anonymous client can otherwise complete `initialize`/`tools/list` and enumerate the catalogue before being refused on every call. Which tools exist and what they cost is itself information; a deployment that does not publish it passes `requireAuth: true` (`createBilling({ mcp: { requireAuth: true } })`).
- **REST** `app/api/v0/route.ts` + `app/api/v0/[tool]/route.ts`: `createToolListHandler({toolCosts})` / `createToolDispatchHandler()`. A refusal becomes the status an HTTP client can act on: **402** for an empty wallet, 401 (+ `WWW-Authenticate`) unauthorized, 429 (+ `Retry-After`) for `try_again_later`, 400 invalid arguments, 404 unknown tool. The 402 lives here because this library writes that message — a consumer had hand-rolled the same regex over it, and without the mapping "buy credits" reaches the caller as "the server is broken".
- **`meterRequest` guards a consumer's OWN routes, and it must agree with that ladder.** It answered **402 for every refusal**, so a caller who had merely hit a rate limit was told to buy credits — the body carried the right sentence and the status contradicted it, and a status is the part an HTTP client acts on. Now `rate_limit_reached` and `spend_limit_reached` are **429 + `Retry-After`** (both reset, and buying lifts neither — the first is the product's pace, the second the customer's own cap), while an empty wallet and an exhausted committed pool stay 402 because money or a conversation is the remedy. Every refusal also carries `reason`, so a client can branch on the cause instead of parsing the sentence.
- **Webhook** `app/api/stripe/webhook/route.ts`: `createStripeWebhookHandler()` (raw body — exclude from any session middleware). It credits ONE thing: a `mode: "payment"` checkout, under `credit:checkout:<session id>` so a **re-delivery credits once**. Everything else — `invoice.paid`, `invoice.payment_failed`, `customer.subscription.*` — falls to `onOtherEvent`, which is where `createStripeEventHandler` belongs; without it a subscription is never mirrored onto the org, so `resolvePlan` reads null for ever and **no subscriber is given the pool they paid for**.
- Register tools once: `registerBillingTools(server, { adapter, toolCosts, config })`.

**Opening a Checkout Session was always the library's; FINISHING one was every consumer's.** `completeCheckout(adapter, sessionId, opts)` / `api.checkout.complete` is the composite, because it is not one step and the first app to write it wrote it three times (signup, plan change, top-up), each copy a different subset: was it actually PAID (a tab coming back is not a payment), attach the customer if the org has none — never overwrite one, which would hand a workspace somebody else's invoices — **stamp `org_id` on the subscription**, mirror the plan now rather than when the webhook lands, and **put the billing profile back**. The last two are the ones nobody thinks of. The signup path cannot set `org_id` at create time because no workspace exists yet, and without it every sync handler reads `subscription.metadata.org_id` as undefined and silently does nothing for the life of that subscription — no plan mirrored on renewal, no `past_due`, no per-cycle grant. And Checkout writes the payer's name and address onto the CUSTOMER (`customer_update`), because Stripe Tax computes zero without a location there — those being the very fields that ARE the workspace's billing address and company name, so paying with a personal address silently replaced the team's. It cannot be prevented during the payment; `keepBillingAddress: false` restores what `createCheckoutSession` carried on the session, which is the honest version of "no". Every step is idempotent (a return URL is a page a browser reloads) and a failed step is a WARNING, never a refusal: the money moved, so refusing would leave a customer charged and unprovisioned.

## Entry points — the root barrel is not the only way in

The root re-exports 45 modules, so `import { planModel } from "@arnaudjnn/billing-tools"` in a Server Component resolves the MCP SDK, mcp-handler, authkit-nextjs, Stripe, WorkOS and eu-vat-rates-data to answer a question about a plain object. Import from the narrowest entry that has what you need:

| entry | for | reaches |
|---|---|---|
| `/plans` | the catalogue + its arithmetic + **the rungs** (`ladder.ts`) + the adapter/config types | **nothing** |
| `/pricing` | `derivePlanViews`, `deriveCompareTable`, the markdown renderers | **nothing** |
| `/agent-auth` | auth.md, MPP, the OAuth proxy | WorkOS, Stripe, eu-vat-rates-data |
| `/routes` | the three Next route factories + `ensureWebhookEndpoint` | MCP SDK, mcp-handler, Stripe, zod |
| `/tools` | `registerBillingTools`, `createDispatcher` | MCP SDK, WorkOS, Stripe, zod |
| `/ui`, `/ui/authkit` | the React checkout components | React, Stripe.js, authkit |
| `/cli` | the customer CLI commands + config store | node builtins only |
| `/dev` | `startLocalWebhooks` (the Stripe CLI fetcher) | node builtins only |
| `.` | everything, incl. `createBilling`, the Stripe/WorkOS engines, the doctor | all of it |

`tests/conventions.test.mjs` pins each set **exactly, in both directions** — a leaf that grows a dependency has stopped being one, and a leaf that loses an export means consumers now import from two places.

Two things that look like dependencies and are not. **`commander` is nowhere**, including the root: `cli/commands.ts` imports `Command` as a *type*, which tsc erases. **`pg` is nowhere** either, and nothing could want it — the package touches no database at all.

`createBilling` stays at the root deliberately: it composes the tools, all three routes, agent-auth and MPP, so it needs the whole graph, and being one module guarantees the single instance its shared AsyncLocalStorage depends on. Same for `checkPlansConfig`, which reads Stripe from `doctor.ts` — a deploy-time call, not one a page makes.

**Nothing compiled may be reachable from no entry point**, and `tests/conventions.test.mjs` fails on it by name. A function can be written, tested, documented and published and still be impossible to import — `defaultSeatOf` was, along with the whole of `plan-request.ts`: `nextUsageAsk`, `seatRank`, `nextSeatUp`, `isSatisfied`, the queue writers. A consumer that needed "which seat does an unassigned member draw" got `TS2305: has no exported member` and re-implemented the ordering rule in its own UI, where it then disagreed with the meter. That is worse than a missing feature, because from the outside it looks identical to one and the workaround ships. The rungs now live in `src/ladder.ts` — pure arithmetic, on the `/plans` leaf, so a seat picker or a pricing table can reach one without loading Stripe — and `plan-request.ts` / `subscription.ts` re-export from it so no existing import moved. The same test caught `dist` never being cleaned before a build: modules deleted from `src` stayed in the tarball, so `build` is now `clean && tsc`.

The root DERIVES its pure half (`export * from "./entries/plans.js"`) rather than hand-listing names, because a hand-maintained list drifts. **The hazard `export *` introduces is the mirror image:** TypeScript silently drops any name two `export *`s both provide. `plan-model` and `checkout` each export a `Quantities` — the barrel keeps checkout's under its own name and plan-model's as `PlanQuantities`, which works only because an explicit export beats `export *`. `tests/conventions.test.mjs` asserts every runtime name the leaf provides is reachable from the barrel, and that both `Quantities` survive.

## CLI

Two CLIs, for two different people.

**`registerBillingCommands(program, { configDir: "~/.myapp", envPrefix: "MYAPP", defaultUrl })`** is the CUSTOMER's: `auth`, `keys list|revoke`, `balance`, `buy`, `invoices`, talking to the app's REST API with an org API key and persisting to `<configDir>/config.json` (chmod 600).

**`npx billing-tools <command>`** (the package's `bin`) is the DEVELOPER's, and talks to Stripe with the secret key. It carries only what needs no app config:

- **`dev`** — `startLocalWebhooks()`: fetch the Stripe CLI into `~/.cache` if absent, `stripe listen --api-key` (no `stripe login`, no tunnel, no registered endpoint), and write the session's `whsec_` into `.env.local`. The dotenv write is the point — `stripe listen` mints a NEW secret per session and the dev server is a different process, so a file is the only channel both see.
- **`doctor`** — `checkBillingSetup` + `formatDoctorResult`, exiting non-zero on an error so it can gate CI.

**`runBillingCli` is the app-side entry, and it is ONE script with two verbs.** `plans` is a TypeScript value in the app, so neither half can be a bin subcommand; what the app stops keeping is the plumbing. `doctor` (default) is `runBillingDoctor` — `checkPlansConfig` first, because it needs no network and explains most account-level symptoms — and `setup` is `setupBilling` + `formatSetupReport`. Both read the same `--url` / `--no-webhook` through `webhookUrlFromArgv`, because two hand-written copies of that parsing had already drifted.

**`doctor` is the default and `setup` must be typed**, since the default has to be the verb that cannot change anything: a bare `pnpm billing` on a laptop holding live keys should read the account, never provision it. An unknown verb exits 2 rather than falling through to either half.

**The script's options are DERIVED from the app's own composition — `runBillingCli({ ...billing.cli, webhookUrl })`.** `createBilling` already holds the catalogue, the resolved config and the ledger, so `billing.cli` reads them off it instead of the script naming them a second time. Two of those were mere duplication; the third is the shape of the worst bug this library has had — a wallet-only ledger counting pooled usage as 0, so every subscriber got unlimited requests while every check passed. **A script that declares its own coverage can be right while the app is wrong.** `hasCheckout` is true when a catalogue is registered with the lifecycle tools on, because `change_plan` now opens a hosted session itself; `workos` audits by default and claims `oauthProxy` only when one is mounted. **The webhook URL stays the app's to pass** — it is a deployment fact, and a production URL in that object is one a laptop run would register.

Two behaviours worth knowing. `STRIPE_SECRET_KEY` unset exits **2**, not 1, on either verb: that variable decides WHICH environment is read or written, and a run against the wrong account is worse than no run. And a Stripe call that THROWS (invalid key, no network) is caught, printed as `✗ Stripe: …` with a fix line, and exits non-zero — the plan-config report already printed stays on screen, because it is the half that needs no network and the half Stripe can never tell you about. `exit` and `log` are injectable, which is the only reason `tests/doctor-runner.test.mjs` can assert any of this.

Call it, do not `await` it at the top level: it exits the process itself, and a top-level await does not survive a CJS transform — the two consumers differ on `"type": "module"`, so the awaited form worked in one and failed to build in the other.

## Setting up an environment (`setupBilling`)

The deploy-time twin of the lazy provisioning, and its honest scope is small: prices, the payment-method configuration and the usage meter all provision themselves on first use, so `setupBilling({ config, plans, webhookUrl, stripeTax? })` exists for the two things that cannot, plus the reporting.

- The **webhook endpoint**, because Stripe returns its signing secret exactly once, at creation — no request can put that in your env store. `formatSetupReport` prints it as a `STRIPE_WEBHOOK_SECRET=…` line, only on the run that created it.
- **Tax registrations**, because only a human knows where the business collects — skipped unless `config.tax` mode is `"stripe"`, since running it on a `local` account would create registrations it does not need and is billed against.
- Everything else runs only because a deploy log is a better place to find a broken config than a customer's first request.

**The WorkOS half has almost nothing to provision, and saying so is the point.** A WorkOS environment ships `admin` and `member` already (verified against a live one), so `ensureWorkOSRoles` has **no default list** — it creates only the roles an app invents, and naming none costs not even a `listEnvironmentRoles` call. Provisioning the two that always exist would be a step that never fires while reading like it does something, which is the same false statement a dead tool makes.

**Whether the `admin` slug EXISTS is a separate claim, and it is the doctor's.** `isAdmin` matches on it, so a team that renames or deletes that role gets `false` for everyone and **403 from every admin-gated tool** — while org API keys keep working, which is why it survives a headless pass and fails on the first real person. The adapter and the doctor read one `ADMIN_ROLE_SLUG` constant, so the check cannot disagree with what it checks.

**What stays manual, and why it cannot be otherwise:** AuthKit's **redirect URIs** and its appearance settings. `@workos-inc/node` v10 exposes no API for either — the only writable `redirect_uris` belong to a *Connect application*, a different object entirely. So `checkWorkOSSetup({ baseUrl })` prints the exact URI to paste rather than a check that can never fail. That is the honest shape: a value, not a tick.

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

Rate limits are checked FIRST in `fundingFor`. A `covers: "all"` one (the default) is absolute: it funds nothing, never falls through to the wallet, and unlike an exhausted `cap` a `shared`/`api` caller does not escape it — what is protected is the product, not the customer's money.

**`covers: "included"` is the other statement, and a plan whose card says pay-as-you-go needs it.** Such a window paces what the plan GIVES AWAY, not what the customer may buy: exhausted, it bars the pool and the pack and falls through to the wallet. Under `all`, a workspace that had already bought credits sat refused for three days, which is not what pay-as-you-go means — and no amount of paying could change it. It is the shape Claude's own weekly limit has (included usage stops, purchased usage credits continue). Two details are load-bearing: an `included` window **counts only included usage**, so paying past it does not consume the window that stopped governing you; and with nothing to pay with it still refuses **as a rate limit**, because the week being spent is why they stopped even though "buy credits" is the fix. The denial is its own reason, `rate_limit_reached`, carrying `retryAt`: it is the one refusal that fixes itself, so the caller is told *when* rather than told to buy.

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

`usageSummary(adapter, config, {orgId, plans, plan, caller?})` → every window with `used`/`remaining`/`percent`/`resetsAt` plus pool, pack and wallet; `memberUsage(...)` → the per-member breakdown an admin view needs; **`orgUsage(...)`** → that breakdown with the three lines every consumer wrote after it: which limit applies to each person (their pack, else the pool), whether they are AT it, and what the team looks like together. Its `aggregate.percent` is the **mean of the members' own percentages, each capped at 100** — a summed one is the workspace's totals expressed as a fraction nobody can spend, so two members (one blocked, one idle) read as "83% used" while half the team is stuck and the other half has not started. `overage` counts who is at the wall, which is the question an owner opens the screen to ask and the one the library could not answer at all. Both go through `resolveAllowance` **deliberately** — a screen computing its own numbers would eventually disagree with the gate, and the disagreement would be invisible until a customer was refused at 60%. Agents get the same from `get_usage_limits`.

A summary with a caller also reports **`seat: {type, label}`** — the plan's own word for the seat (`SeatTypeDisplay.badge`, else `label`, resolved for `locale`). It is independent of `pack`, because a pooled or free plan has none and every member of one was reported as `standard`, a seat type such a plan does not declare. A plan that sells no seats names the seat it gives with `seat: { key, display }`; `resolveSeat(model, type, locale)` is the same lookup for other surfaces.

**Presentation** derives via `@arnaudjnn/billing-tools/pricing` (a leaf — no Stripe, no WorkOS, no React): `derivePlanViews(plans, {interval, currency, locale, formatMoney, currentPlan, canManage, hrefs})` → `PlanView[]`, consumed by both a React card and the markdown renderers. `price.headline` is a per-MONTH comparison figure, `price.totals` is what is charged, and `annualSaving` carries `annualSavingBasis` — two surfaces of one app derived that percentage from different baskets and advertised 17% while charging 14%.

**Four things a consumer kept its own copy of, and now asks for.** Each was a second answer to a question the library already answers, in the place least likely to be updated when the answer moves. `CREDITS_PER_UNIT` / `creditsForAmount` / `amountForCredits` — the credits↔currency ratio is this library's arithmetic and `buy_credits` quotes it in its own description, so an app constant beside a control the library prices was one of them being wrong the day it changed. `visibleWindows(windows, scope, included)` — a monthly rate limit and a monthly package are the same period read twice with different denominators, so a card that listed both showed three rows that read as a mistake; the rule is about the plan model, not about anybody's language, and it had been written once per usage screen. `resolveSeat` reports **`badge` beside `label`** rather than only the collapsed `badge ?? label`, because a consumer needing the short word where the long one carries a noun was stripping it with a regex in two files. `api.topUps.grantable(orgId)` — `grantExtraAllowance` answers `not_capped` for a plan with no per-seat pack, and a screen needs that before it renders the control rather than re-deriving `cap.kind === "per_seat"` itself.

**A constant reachable only from the ROOT barrel is a constant consumers retype.** `ADMIN_ROLE_SLUG` is a bare string, and importing it cost Stripe + WorkOS + the MCP SDK — so a consumer wrote `role === "admin"` in six client components instead, each one a place a renamed role silently turns every admin into a non-admin in the UI while the API still agrees they are one. It lives in `types.ts` now (dependency-free, on the `/plans` leaf) and is re-exported from `workos-setup.ts`. There were **four** copies before this, and the fourth was the library's own `notifications/emit.ts`, which answers the `{kind:"admins"}` audience: a renamed slug would have kept `isAdmin` and `isLastAdmin` right while every "somebody is asking you for something" email went to nobody. **Anything a client component must compare against belongs on a leaf** — the test for whether an export is on the right entry point is not what it depends on, but who has to reach it.

**A hand-kept ban is a snapshot; DERIVE the other half.** Both consumers now assert that no name billing-tools **exports** is redeclared locally — read off the root barrel at test time (300 names, so the leaves are covered), which means a rule the library gains tomorrow is guarded without anyone editing a list. It is not a replacement for the hand-kept list, which names concepts an app owns under its OWN names (`VAT_PERCENT`, `MAX_TOP_UP`, `DEFAULT_USER_SEAT`) and that no derivation can produce: one catches a name the library owns, the other a concept it owns under a different name. Adding it cost two fixes and both were worth making on their own — a local `const isLastAdmin` beside the library's policy function of that name, and a private `callTool` in gtm-tools reaching into `McpServer._registeredTools` while the library's `callTool` is the customer CLI's HTTP client. **Prefer renaming the local to allowlisting it:** `SHADOWS_ALLOWED` exists, starts empty, and an entry in it is a permanent note that two things share a name.

**A name ban reads as clean while the same defect sits one expression lower.** Both consumers now assert their own "policy this app no longer decides" lists, and matching by NAME let two things through: a second spelling (`DEFAULT_SPEND_LIMIT_CREDITS` past a `DEFAULT_SPEND_LIMIT_UNITS` entry, carrying its own `?? 20_000` beside a config that already declared it) and the ARITHMETIC — `Math.round(x * CREDITS_PER_UNIT)` written out in nine places while the ratio itself was correctly imported. Ban the expression too, and match a **literal right-hand side only**: `const PER_UNIT = CREDITS_PER_UNIT` asks the library for the value, `= 100` is the transcription, and banning the name outright pushes a repo into hiding the alias. The other direction is worth stating too: a consumer's parity test that walks server ACTIONS cannot see a ROUTE, which is how both consumers' CLI callbacks came to mint API keys straight off `workos.apiKeys` — one of them re-implementing `ensureOrgForUser` line for line, including its own `lookupCompany`.

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

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (auth + WorkOS-org adapter), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing), `BILLING_WEBHOOK_URL` (optional — where this deployment's webhook lives, read by `webhookUrlFromArgv`, so the URL travels with the environment instead of being hardcoded in an ops script a laptop can run against production), `REFRESH_TOKEN_SECRET` (OAuth proxy — signs refresh tokens; **required, no fallback**: an earlier version fell back to `WORKOS_CLIENT_ID`, a *public* identifier, so anyone who knew it could forge a 30-day refresh token. Without it the token endpoint returns `server_error` rather than signing with something guessable), `BILLING_OPERATOR_EMAILS` + `BILLING_OPERATOR_TOKEN` (who may answer a credit quote — a comma-separated list of addresses for a signed-in human, and one shared secret for a machine, presented as `X-Operator-Token`. Both unset means nobody can approve a negotiated price, which is the correct state for a deployment that does not sell them). `tests/conventions.test.mjs` fails if the library reads one this list forgets.

**The two keys must name the same environment, and `environmentMismatch` is what says so.** Each half of the report already stated its own — "LIVE MODE" from Stripe, "production key" from WorkOS — so a live Stripe key beside a staging WorkOS key printed both facts, passed every check and read as healthy. It is the worst mistake available here: real cards charged against orgs and `sk_` keys in the wrong environment, with the mapping between them (the org's `stripeCustomerId`) written where nobody is looking. `checkWorkOSSetup({ expectLivemode })` errors on it, from the key prefixes and no network, and both `setupBilling` and `runBillingDoctor` pass it. **Undefined stays "the caller did not say there is a Stripe half"** — never "the halves agree" — so a WorkOS-only audit is unaffected.

**Only an OLD WorkOS key names its environment, so `workosEnvironmentOf` has three answers.** `sk_test_…` and `sk_live_…` say; a newer `sk_<base64 key id>` (decoding to `key_01…`) says nothing, and the pre-existing check read "not `sk_test`, therefore production" — mislabelling those, and then, once the comparison existed, accusing a correctly matched local setup of being mixed. It did that on its first real run. **`unknown` compares against nothing and reports nothing**, because a guard whose errors are sometimes fiction is one people learn to scroll past, which costs more than the check was worth.

`BillingConfig`: `{ freeCredits=100, currency, baseUrl, internalDomains: string[] }`. With `STRIPE_SECRET_KEY` unset, billing tools report "not configured"; metering (`enforceCredits`) is skipped when `cost === 0`, Stripe is unset, or the org is internal.

## Tests — `pnpm test` offline, `pnpm e2e:live` against a real environment

`tests/` is vitest against fakes, and it stubs exactly the two things that break in a real environment: `getStripe` and WorkOS. So it can prove the tax decision table exhaustively and cannot prove that a rate reached an invoice, that a WorkOS role slug resolves to a refusal, or that a quoted upgrade total equals the charged one.

**`pnpm e2e:live` is that second half** (`scripts/e2e-live.mjs` + `scripts/live/NN-*.mjs`, one file per section: keys, roles, tax, invoices, lifecycle, seats/top-ups/usage, mid-cycle documents, plan moves, roles/isolation, workspace close, refusals/dunning, members, notifications/quotes/alerts). Test keys only — refused otherwise — every object prefixed `live<ts>` and torn down LIFO in a `finally`. `E2E_ENV_FILE` picks the environment, `E2E_ONLY=02,05` a subset. **Never in CI**, because it creates real objects in whichever account the keys name.

- **`ensurePlans` is made structurally UNREACHABLE, not merely avoided.** It archives every managed price the catalogue it is handed does not name, so a harness holding a partial catalogue archives the real product's prices — which has happened. `scratch-stripe.mjs` installs the price map via `__setPlanPricesForTests`, which `resolvePlanPrices` checks first, so no plan path can reach Stripe's price list. Two corollaries: **never dispatch `list_plans`** (the one tool calling `ensurePlans` directly — the roles matrix excludes it by name and asserts the exclusion), and do not tag scratch prices `managedBy: "billing-tools"`, so a concurrent real `ensurePlans` cannot see them. Its header is the most important comment in the harness.
- **A teardown error is a FAILED RUN, not a line in the log.** `.catch(() => {})` around a cleanup call turns a real failure into a `✓` — a run once reported a clean teardown while leaving six active prices and a test clock behind, and the state that left took a while to explain. Use `ignoreMissing`, which tolerates only "it was already gone" (deleting a test clock deletes its customers, so their own teardown legitimately 404s) and rethrows everything else.
- **TaxRates are deliberately KEPT.** They are immutable, account-level, and reused by real charges; archiving them would break the account. Same reasoning makes section 04 read-only about `default_account_tax_ids` — it reports a missing supplier tax id with the exact call to run rather than writing account-wide state.
- **One instance of an event is not coverage.** Sections 07 and 08 exist because a single measured upgrade was reported as "upgrades are covered": the matrix of twelve moves a customer can actually make then found three defects, every one in a path nothing had executed — including the DEFAULT proration policy. Each scenario gets its own clock and customer (`scripts/lib/scenario.mjs`), because a test clock cannot be wound backwards, a leftover subscription makes the next `changePlan` refuse, and a failure in case 9 that was caused by case 1 is the thing a matrix exists to prevent.
- **A green assertion can be green for the wrong reason, and that is the failure mode to hunt.** Three caught here: a declined-card scenario attached the bad card BEFORE the first payment, so the subscription expired and every assertion passed while measuring nothing about an upgrade; a seat-removal case changed two things at once and blamed the library for the resulting charge; and a visibility check read `member_id` where the record says `memberId`, producing a confident FALSE finding. Assert the precondition you depend on, in the test.
- **WHICH functions have run against a real account is a list, not a judgement** (`tests/live-coverage.test.mjs`). A static call graph over `src/`, rooted at what the live suite actually reaches — every function it names, plus every tool FILE containing a tool it dispatches — answers one question: which exports that touch Stripe or WorkOS have never been executed against either. 127 SDK-touching exports; the ledger names every uncovered one with a reason, and the real gaps carry a `GAP:` prefix so closing one is a deliberate edit. It works: the retax handoff was one of five, and closing it in section 03d made the ledger fail on its own stale entry. An uncovered function is fine; a **silently** uncovered one is where every expensive defect in this package has lived. **Its premise is that the live suite is GREEN** — it credits what the suite NAMES, and a section that throws halfway still names everything below the throw. The first full run after it was written had four sections red, every one inflating the coverage it counted, so run `pnpm e2e:live` before trusting the file and treat a red section as coverage withdrawn. Two biases are deliberate and must stay: a function body runs to the next top-level `export` (over-inclusion makes coverage look BETTER, so anything still reported really is uncovered), and tools are rooted at the file rather than the handler (per-handler regex under-matched 31 of 49, and a guard that cries wolf is one people scroll past). Writing it deleted four dead exports — the `default_incomplete` subscription trio and the `useCheckout` hook that drove them, a second charge path with none of the real one's guards.
- **A LIBRARY guard that lands after a section was written STRANDS it, and only a full run says so.** Three did, and the harness had quietly gone un-runnable end to end: `request_top_up` refusing a member nothing is refusing (06 and 09 file an ask for a member with allowance left — deliberately, so drive the queue through `api.topUps.request`, which resolves the same cycle and carries no `blocked` gate, and assert the tool's refusal separately; do **not** reach for the tool's `cycle` escape hatch, which makes "filed under the meter's cycle" tautological); `createCreditCheckoutSession` returning `{url, clientSecret, sessionId}` rather than a string (07e asserted the old shape from the day it was written, so it had **never** passed); and `seatTypeExists` refusing a seat the org's own plan does not sell (10 assigned `premium` on a Starter workspace). **Run the whole suite after adding a refusal**, not the section you were working on — `E2E_ONLY` is what let all three sit there.
- **A seam whose fake is a one-line function is the one a live section is worth most.** Section 13 runs a real `http.createServer` on localhost and points `webhookNotifier` at it, because a fake notifier — a function that pushes onto an array — can show none of what actually breaks: that a POST left the process, that the signature a receiver verifies is the one the sender wrote, that a 503 is retried byte-for-byte so a derived id really does dedupe, that a **down** endpoint leaves the grant it was describing in place, or that an alert record fits inside the WorkOS metadata value every other write on that org shares. It builds its OWN `createBilling`, because a notifier on the shared one would charge every earlier section the transport's retries against an endpoint that does not exist yet. Two defects on the first run, both of them the "a fake accepts anything" shape: an unaddressed event never delivered, and the negotiated invoice untaxed. It was then stranded itself when `feat(quotes)!` replaced the tools it dispatched — see the stranding rule above.
- **An "allowed" role assertion is the ABSENCE of a refusal.** Every admin-gated tool calls `enforceAdmin` first, so the matrix passes deliberately inert arguments (`plan: "__no_such_plan__"`, `pm_does_not_exist`) and asserts no `Forbidden` — which keeps 33 probes read-only instead of 33 real mutations. The structural assertion beside them, that every gated tool is probed, is worth more than any single one: it catches a 14th gate added without a probe.

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

Three traps. The first two are asserted in `tests/conventions.test.mjs`, which also records why each setting looks removable and is not: `npmPublish:false` plus the `npx --yes npm@latest publish` exec (OIDC needs npm ≥ 11.5.1, and `node_modules/.bin/npm` shadows it), and the absence of `registry-url` in `setup-node` (it writes an empty `_authToken`, so npm tries broken token auth and skips OIDC). The third cannot be tested: **GitHub Actions flakiness is not your bug** — jobs stuck `queued` with `runner_name: null`, or an internal error mid-run, are transient even while the status page reads "operational". Cancel and re-trigger; publishing in *prepare* makes it harmless, since a killed job leaves no tag to reconcile.
