import { autoReloadFor, deductCredits, getBillingCustomerId, stripeConfigured } from "./billing.js";
import { isInternalOrg } from "./auth.js";
import { describeDenial, fundingFor, resolveAllowance, type DenialReason } from "./allowance.js";
import { getSeatType } from "./seats.js";
import { cycleWindowFor, planModel, type CycleWindow, type PlanCatalog } from "./plan-model.js";
import { defaultUsageLedger, warnLedgerGaps, type UsageLedger } from "./usage-ledger.js";
import { maybeAlert } from "./alerts.js";
import type { Notify } from "./notifications/index.js";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

export interface MeterCaller {
  /** `user` = a human via session/OAuth (their seat); `api` = an API key / agent
   *  (the shared API seat). Decides which pack the execution draws — the surface
   *  (ui/api/mcp/cli) is irrelevant. */
  kind: "user" | "api";
  /** WorkOS member id (user) or API key id (api) — for per-caller attribution. */
  id?: string;
  /** The caller's seat type, resolved by the consumer (e.g. `standard`,
   *  `premium`, `api`). Used for the per-seat pack cap in `per_seat` plans. */
  seatType?: string;
}

export interface MeterInput {
  orgId: string;
  action: string;
  /** Credit cost for this execution (rate card × units), resolved by the consumer. */
  cost: number;
  plans: PlanCatalog;
  /** The org's current plan key (consumer resolves + caches it). */
  plan: string | null;
  /** Start of the current billing cycle, unix SECONDS (unchanged). Prefer
   *  `cycle`, which also carries the END — an annual window needs both. */
  cycleStart?: number;
  /** The window usage is measured over. Derived from the subscription period
   *  when omitted. */
  cycle?: CycleWindow;
  /** Where usage is counted. Defaults to `stripeUsageLedger()` — the composite,
   *  the same default `createBilling` and `createMeter` apply. */
  ledger?: UsageLedger;
  caller?: MeterCaller;
  /** Say "you are nearly out" when this call crosses a threshold. See `alerts.ts`. */
  notify?: Notify;
  /** Percentages of an included allowance worth an email. Default `[80, 100]`. */
  alertThresholds?: readonly number[];
}

export type MeterResult =
  | { ok: true; funded?: "pool" | "pack" | "wallet" | null }
  | {
      ok: false
      /**
       * `DenialReason` plus the one refusal that happens before any allowance is
       * read. Spelled as a reference rather than a copy: this union was a
       * duplicate of that one, so every new reason had to be added twice and the
       * compiler only caught it because a value flowed between them.
       *
       * `pool_exhausted` exists because an org whose included package is used up
       * used to be told "insufficient balance", which pointed at the wrong
       * problem and the wrong remedy. `rate_limit_reached` is a declared
       * per-window limit — waiting fixes it, buying does not — while
       * `spend_limit_reached` is the customer's own ceiling, which they can raise.
       */
      reason: DenialReason | "no_billing"
      message: string
      /** When a rate limit refused: epoch ms at which it resets. */
      retryAt?: number
    }

// The shared metering engine (used by every consumer). Pricing is per execution
// at a uniform cost regardless of surface. The org's prepaid Stripe balance is
// the shared reserve; in `per_seat` plans each caller's per-cycle pack caps how
// much of it they may spend (usage summed from Stripe balance-transaction
// metadata — no separate ledger), while `global` plans (e.g. an Enterprise credit
// commitment) impose no per-seat cap. The debit is tagged with the caller so
// usage is attributable. Free (cost 0), Stripe-unset, and internal orgs pass
// through untouched. Persistence is entirely Stripe + the adapter — no new DB.
export async function meterUsage(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  input: MeterInput,
): Promise<MeterResult> {
  const { orgId, action, cost, plans, plan, caller } = input
  if (cost <= 0) return { ok: true, funded: null }
  if (!stripeConfigured()) return { ok: true, funded: null }
  if (await isInternalOrg(adapter, orgId, config.internalDomains)) return { ok: true, funded: null }

  const customerId = await getBillingCustomerId(adapter, orgId)
  if (!customerId) {
    return { ok: false, reason: "no_billing", message: "No billing account found." }
  }

  const model = planModel(plans, plan)
  const ledger = input.ledger ?? defaultUsageLedger()
  const cycle =
    input.cycle ??
    (input.cycleStart != null
      ? {
          start: input.cycleStart * 1000,
          end: null,
          key: new Date(input.cycleStart * 1000).toISOString().slice(0, 7),
        }
      : undefined)

  const state = await resolveAllowance(adapter, config, {
    orgId,
    plans,
    plan,
    caller,
    customerId,
    cycle,
    ledger,
  })

  // Included allowance first, wallet last: a pooled org that has used up its
  // package is told exactly that, instead of being told its balance is short.
  const funding = fundingFor(state, model, cost, caller)
  if (!funding.ok) {
    const reason = funding.reason ?? "insufficient_balance"
    return {
      ok: false,
      reason,
      // The deployment's own words when it declared any: this sentence is what a refused
      // caller reads, through the API and the CLI as much as through a screen.
      message: describeDenial(reason, state, funding.limit, config.messages),
      // A rate limit is the one denial that fixes itself, so say when.
      ...(funding.limit?.window.end ? { retryAt: funding.limit.window.end } : {}),
    }
  }

  // Count every call; charge only the ones the wallet funds. Included usage was
  // paid for by the subscription, and debiting it would charge twice — while
  // crediting the allowance instead would discount the subscription's own
  // invoice (a Stripe credit balance auto-applies to it).
  await ledger.record({
    orgId,
    customerId,
    action,
    cost,
    funded: funding.source ?? "wallet",
    caller: caller ? { kind: caller.kind, id: caller.id } : undefined,
  })

  if (funding.source === "wallet") {
    await deductCredits(
      customerId,
      action,
      cost,
      config.currency,
      caller ? { kind: caller.kind, id: caller.id } : undefined,
    )
    autoReloadFor(customerId, config).catch(() => {})
  }

  // "You are nearly out", from the state this call already loaded to decide it was allowed.
  //
  // Here rather than anywhere else because here is the only place the numbers are current
  // AND free: `state` holds the pack, the pool and the customer's own ceiling, and the
  // alternative is a cron re-reading every workspace to learn what one metered call just
  // found out. Fire-and-forget, after the charge, for the same reason as the auto-reload
  // above — an email must not delay or fail the call it is about.
  maybeAlert(adapter, input.notify, {
    orgId,
    memberId: caller?.kind === "user" ? caller.id : null,
    cycleKey: state.cycle.key,
    state,
    thresholds: input.alertThresholds,
  })
  return { ok: true, funded: funding.source }
}

// ── The bound call-site meter ────────────────────────────────────────────────
// `meterUsage` is the low-level engine: it wants an already-resolved cost, plan,
// cycle window, seat type, and top-up grant. Every consumer would otherwise write
// the SAME glue to produce those (rate-card lookup, caller→seat mapping, plan
// resolution + cache, calendar-month cycle, extra-allowance lookup). `createMeter`
// is that glue, once. Call it a single time with your rate card + plans + a
// plan resolver, re-export the returned `meter`, and every surface (UI/API/MCP/
// CLI) calls `meter(orgId, action, { caller })` — no per-app wrapper.

export interface MeterConfig<R extends Record<string, number> = Record<string, number>> {
  /** Plan catalog (shapes, packs, pools, limits). */
  plans: PlanCatalog
  /** action → credit cost (per unit). Consumer-authored product data. Omit to
   *  always pass an explicit `cost` at the call site. */
  rateCard?: R
  /** Resolve the org's current plan key. Source varies per app (subscription
   *  metadata, WorkOS org metadata, …) so the consumer supplies it; the result
   *  is cached here for `planCacheTtlMs`. */
  resolvePlan: (orgId: string) => Promise<string | null>
  /** Seat-type keys a caller maps to by identity. Default standard / api. */
  seatDefaults?: { user?: string; api?: string }
  /** Say "you are nearly out" — `createBilling` passes its emitter. See `alerts.ts`. */
  notify?: Notify
  /** Percentages of an included allowance worth an email. Default `[80, 100]`. */
  alertThresholds?: readonly number[]
  /** Plan-cache TTL (ms). Default 60_000. The plan changes rarely; a brief stale
   *  read only affects which allowance mode applies, never the debit. */
  planCacheTtlMs?: number
  /**
   * Start of the current billing cycle, unix seconds.
   *
   * No longer needed: the window is derived from the SUBSCRIPTION period when the
   * adapter can report one, falling back to the 1st of the month UTC — which is
   * what an included allowance requires (an annual package measured over calendar
   * months would reset twelve times). Override only to impose your own window.
   */
  cycleStart?: () => number
  /** Cycle key top-up grants are stored under. Default "YYYY-MM" UTC. Derived
   *  from the same window as the usage measurement, so the two cannot drift —
   *  which they could when this was the caller's obligation. */
  cycleKey?: () => string
  /**
   * Where usage is counted. Default: `stripeUsageLedger()`, the composite — every
   * ORG-wide window on a Stripe meter (included usage too, one request at any
   * volume) and per-CALLER windows from balance-transaction metadata.
   *
   * Pass one for the pair the bare composite can't see: a window that is both
   * INCLUDED and PER-MEMBER (`cap: per_seat`, a `scope: "caller"` limit) —
   * `stripeUsageLedger({ perCaller: stripeScopeUsageLedger() })`, which counts it
   * in Stripe too rather than in a database.
   */
  ledger?: UsageLedger
}

function defaultCycleStart(): number {
  const d = new Date()
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
}
function defaultCycleKey(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

export interface MeterCallOpts {
  /** Who is spending — decides which seat pack the debit draws (by auth identity,
   *  NOT surface). Omit for an org-level debit with no seat cap. */
  caller?: { kind: "user" | "api"; id?: string }
  /** Executions this call represents (cost = rateCard[action] × units). Default 1. */
  units?: number
  /** Explicit credit cost, bypassing the rate card (e.g. a dynamically-priced op). */
  cost?: number
}

export type Meter<R extends Record<string, number>> = (
  orgId: string,
  action: keyof R & string,
  opts?: MeterCallOpts,
) => Promise<MeterResult>

export function createMeter<R extends Record<string, number> = Record<string, number>>(
  adapter: BillingAdapter,
  config: ResolvedConfig,
  meterCfg: MeterConfig<R>,
): Meter<R> {
  const {
    plans,
    rateCard,
    resolvePlan,
    seatDefaults,
    planCacheTtlMs = 60_000,
    cycleStart,
    cycleKey,
  } = meterCfg
  const userSeat = seatDefaults?.user ?? "standard"
  const apiSeat = seatDefaults?.api ?? "api"
  const ledger = meterCfg.ledger ?? defaultUsageLedger()

  // Said once, here, because this is the entry point every metered call goes
  // through however the app was composed — `createBilling` wires its meter through
  // it too, so the check can't be skipped by picking the other constructor.
  warnLedgerGaps(plans, ledger)

  // A consumer-imposed window. When absent, the window comes from the
  // subscription period (see resolveAllowance) — which is what an annual package
  // needs — and the cycle key travels with it, so a top-up grant can no longer be
  // recorded against a different cycle than the usage it is meant to extend.
  const cycleOverride =
    cycleStart || cycleKey
      ? () => ({
          start: (cycleStart ?? defaultCycleStart)() * 1000,
          end: null,
          key: (cycleKey ?? defaultCycleKey)(),
        })
      : null

  const planCache = new Map<string, { plan: string | null; at: number }>()
  async function currentPlan(orgId: string): Promise<string | null> {
    const hit = planCache.get(orgId)
    if (hit && Date.now() - hit.at < planCacheTtlMs) return hit.plan
    const plan = await resolvePlan(orgId)
    planCache.set(orgId, { plan, at: Date.now() })
    return plan
  }

  return async function meter(orgId, action, opts = {}) {
    const cost = opts.cost ?? (rateCard?.[action] ?? 0) * (opts.units ?? 1)
    // Seat type by auth identity: an API key → the shared api seat; a member →
    // their assigned seat type (falling back to the default user seat).
    let caller: { kind: "user" | "api"; id?: string; seatType: string } | undefined
    if (opts.caller) {
      const seatType =
        opts.caller.kind === "api"
          ? apiSeat
          : (opts.caller.id && (await getSeatType(adapter, orgId, opts.caller.id))) || userSeat
      caller = { kind: opts.caller.kind, id: opts.caller.id, seatType }
    }
    return meterUsage(adapter, config, {
      orgId,
      action,
      cost,
      plans,
      plan: await currentPlan(orgId),
      // Only when the consumer imposed one; otherwise the window (and with it
      // the top-up cycle key) comes from the subscription period.
      cycle: cycleOverride?.(),
      ledger,
      caller,
      notify: meterCfg.notify,
      ...(meterCfg.alertThresholds ? { alertThresholds: meterCfg.alertThresholds } : {}),
    })
  }
}

// ── The API route guard ──────────────────────────────────────────────────────
// The other reusable half: a first-line guard for a public HTTP route that must
// require a workspace API key and meter one execution before the handler runs.
// It's pure Web-standard glue (parse Bearer → validateApiKey → meter → 401/402),
// so it lives here once instead of in every consumer's routes. Returns a Response
// to short-circuit, or null to proceed:
//   const gate = await meterRequest(req, "api_request"); if (gate) return gate
export type ApiMeterGuard<R extends Record<string, number>> = (
  req: Request,
  action: keyof R & string,
  opts?: { units?: number },
) => Promise<Response | null>

export function createApiMeterGuard<R extends Record<string, number>>(
  adapter: BillingAdapter,
  meter: Meter<R>,
  cfg?: {
    realm?: string
    /**
     * The MPP gate, when the app accepts machine payments. A money refusal (never a
     * waitable one) is re-issued as a `WWW-Authenticate: Payment` challenge, and a
     * caller that settles it is metered again — for real, because paying funds the
     * meter rather than skipping it.
     *
     * The tool surface gets this from `createToolDispatchHandler`; this is the same
     * offer for a route that is not a tool. Both consumers had written it by hand.
     */
    payment?: { requirePayment(request: Request): Promise<Response | { paid: true }> }
  },
): ApiMeterGuard<R> {
  const realm = cfg?.realm ?? "api"
  // `retried` is internal — the public guard takes three arguments, and the fourth only
  // exists so a paid retry cannot become a loop.
  const meterRequest = async (
    req: Request,
    action: keyof R & string,
    opts?: { units?: number },
    retried = false,
  ): Promise<Response | null> => {
    const token = req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim()
    if (!token) return unauthorized(realm)
    const auth = await adapter.validateApiKey(token)
    if (!auth) return unauthorized(realm)
    const res = await meter(auth.orgId, action, {
      // The KEY, when the adapter can name it. Never the org id as a stand-in:
      // `caller.id` means "which key", so an org id there is a value that answers
      // a different question, and it wrote a counter under `u:<workspace>` that
      // looked like a member. An adapter that cannot tell keys apart records no
      // caller id at all, which is honest — the api windows are summed by KIND
      // across the org either way, so nothing about the gate depends on it.
      caller: { kind: "api", ...(auth.keyId ? { id: auth.keyId } : {}) },
      units: opts?.units,
    })
    if (!res.ok) {
      // The STATUS has to match the reason, and it did not: every refusal came back 402,
      // so a caller that had merely hit a rate limit was told to buy credits. The body
      // carried the right sentence and the status contradicted it — and a status is what an
      // HTTP client acts on. This is the same mapping `createToolDispatchHandler` already
      // does for the tool surface; the two must not disagree about one refusal.
      //
      // A rate limit and a spend ceiling both RESET, and buying fixes neither: the first is
      // the product's pace, the second the customer's own cap, which they can also raise.
      // So both are 429 with `Retry-After`, and the rest stay 402 because money is the
      // remedy — an exhausted committed pool included, where the remedy is a conversation.
      const waitable = res.reason === "rate_limit_reached" || res.reason === "spend_limit_reached"
      const retryAfter =
        res.retryAt != null ? Math.max(1, Math.ceil((res.retryAt - Date.now()) / 1000)) : null
      // Money can lift this one, so offer to take it. Once: a caller whose settled
      // payment still leaves the wallet short gets the ordinary 402, not a loop.
      if (!waitable && cfg?.payment && !retried) {
        const paid = await cfg.payment.requirePayment(req)
        if (paid instanceof Response) return paid
        return meterRequest(req, action, opts, true)
      }
      return jsonResponse(
        waitable ? 429 : 402,
        {
          error: res.message ?? "Insufficient balance.",
          // Named, so a client can branch on the cause instead of parsing the sentence.
          reason: res.reason,
          ...(retryAfter != null ? { retry_after_seconds: retryAfter } : {}),
        },
        waitable && retryAfter != null ? { "Retry-After": String(retryAfter) } : undefined,
      )
    }
    return null
  }
  return (req, action, opts) => meterRequest(req, action, opts)
}

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  })
}
function unauthorized(realm: string): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized: provide a workspace API key as a Bearer token." }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="${realm}"`,
      },
    },
  )
}
