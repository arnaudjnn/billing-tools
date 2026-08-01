import { autoReloadFor, deductTokens, getBillingCustomerId, stripeConfigured } from "./billing.js";
import { isInternalOrg } from "./auth.js";
import { describeDenial, fundingFor, resolveAllowance } from "./allowance.js";
import { getSeatType } from "./seats.js";
import { cycleWindowFor, planModel, type CycleWindow, type PlanCatalog } from "./plan-model.js";
import { stripeBalanceUsageLedger, type UsageLedger } from "./usage-ledger.js";
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
  /** Token cost for this execution (rate card × units), resolved by the consumer. */
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
  /** @deprecated Resolved from the adapter now (see `resolveAllowance`), so a
   *  caller can no longer pass a cycle key that disagrees with the window. */
  extraAllowance?: number;
  /** Where usage is counted. Defaults to the balance-transaction ledger, which
   *  is exact but can only see wallet-funded calls — a plan with an included
   *  window wants `stripeMeterUsageLedger()`. */
  ledger?: UsageLedger;
  caller?: MeterCaller;
}

export type MeterResult =
  | { ok: true; funded?: "pool" | "pack" | "wallet" | null }
  | {
      ok: false
      /** `pool_exhausted` is new: an org whose included package is used up used
       *  to be told "insufficient balance", which pointed at the wrong problem
       *  and the wrong remedy. */
      reason:
        | "no_billing"
        | "insufficient_balance"
        | "seat_allowance_reached"
        | "pool_exhausted"
        /** A declared per-window limit (hour/day/week/month) refused it. Distinct
         *  from an exhausted cap: waiting fixes this one, buying does not. */
        | "rate_limit_reached"
      message: string
      /** When a rate limit refused: epoch ms at which it resets. */
      retryAt?: number
    }

// The shared metering engine (used by every consumer). Pricing is per execution
// at a uniform cost regardless of surface. The org's prepaid Stripe balance is
// the shared reserve; in `per_seat` plans each caller's per-cycle pack caps how
// much of it they may spend (usage summed from Stripe balance-transaction
// metadata — no separate ledger), while `global` plans (e.g. an Enterprise token
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
  const ledger = input.ledger ?? stripeBalanceUsageLedger()
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
      message: describeDenial(reason, state, funding.limit),
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
    await deductTokens(
      customerId,
      action,
      cost,
      config.currency,
      caller ? { kind: caller.kind, id: caller.id } : undefined,
    )
    autoReloadFor(customerId, config).catch(() => {})
  }
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
  /** action → token cost (per unit). Consumer-authored product data. Omit to
   *  always pass an explicit `cost` at the call site. */
  rateCard?: R
  /** Resolve the org's current plan key. Source varies per app (subscription
   *  metadata, WorkOS org metadata, …) so the consumer supplies it; the result
   *  is cached here for `planCacheTtlMs`. */
  resolvePlan: (orgId: string) => Promise<string | null>
  /** Seat-type keys a caller maps to by identity. Default standard / api (the
   *  DEFAULT_SEAT_TYPES convention). */
  seatDefaults?: { user?: string; api?: string }
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
  /** Where usage is counted. Default: the balance-transaction ledger (exact, and
   *  free for a wallet-only product). A plan with an INCLUDED window needs
   *  `stripeMeterUsageLedger()` — an included call moves no money, so it writes
   *  no transaction to count. */
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
  /** Explicit token cost, bypassing the rate card (e.g. a dynamically-priced op). */
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
      ledger: meterCfg.ledger,
      caller,
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
  cfg?: { realm?: string },
): ApiMeterGuard<R> {
  const realm = cfg?.realm ?? "api"
  return async function meterRequest(req, action, opts) {
    const token = req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim()
    if (!token) return unauthorized(realm)
    const auth = await adapter.validateApiKey(token)
    if (!auth) return unauthorized(realm)
    const res = await meter(auth.orgId, action, {
      caller: { kind: "api", id: auth.orgId },
      units: opts?.units,
    })
    if (!res.ok) return jsonResponse(402, { error: res.message ?? "Insufficient balance." })
    return null
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
