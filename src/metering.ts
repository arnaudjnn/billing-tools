import {
  deductTokens,
  getBillingCustomerId,
  getTokenBalance,
  stripeConfigured,
  tryAutoReload,
  usageSince,
} from "./billing.js";
import { isInternalOrg } from "./auth.js";
import { extraAllowance } from "./topup.js";
import { getSeatType } from "./seats.js";
import type { PlansConfig } from "./plans.js";
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
  plans: PlansConfig;
  /** The org's current plan key (consumer resolves + caches it). */
  plan: string | null;
  /** Start of the current billing cycle, unix seconds — the window for per-seat
   *  usage. */
  cycleStart: number;
  /** Approved extra allowance for this caller this cycle (owner-granted top-up),
   *  added on top of the seat pack. Consumer resolves it via `extraAllowance`. */
  extraAllowance?: number;
  caller?: MeterCaller;
}

export type MeterResult =
  | { ok: true }
  | {
      ok: false
      reason: "no_billing" | "insufficient_balance" | "seat_allowance_reached"
      message: string
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
  const { orgId, action, cost, plans, plan, cycleStart, caller } = input
  const extra = input.extraAllowance ?? 0
  if (cost <= 0) return { ok: true }
  if (!stripeConfigured()) return { ok: true }
  if (await isInternalOrg(adapter, orgId, config.internalDomains)) return { ok: true }

  const customerId = await getBillingCustomerId(adapter, orgId)
  if (!customerId) {
    return { ok: false, reason: "no_billing", message: "No billing account found." }
  }

  // The shared reserve must cover the debit (it funds every pack + any API top-up).
  const balance = await getTokenBalance(customerId, config.currency)
  if (balance < cost) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: `Insufficient tokens: this costs ${cost} but the workspace has ${balance}. Top up to continue.`,
    }
  }

  // Per-seat allowance cap — only for `per_seat` plans with a seat context.
  // `global` plans (Enterprise commitment) have no per-seat cap.
  const planDef = plan ? plans[plan] : undefined
  const mode = planDef?.allowanceMode ?? "per_seat"
  if (mode === "per_seat" && caller?.seatType) {
    const pack = planDef?.seatTypes?.[caller.seatType]?.includedTokens
    if (pack != null) {
      const used = await usageSince(
        customerId,
        cycleStart,
        caller.kind === "api"
          ? { callerKind: "api" }
          : { callerKind: "user", callerId: caller.id },
      )
      if (used + cost > pack + extra && caller.kind === "user") {
        // Hard cap for a user seat. (API seat over its pack is allowed — it
        // draws the shared reserve, which is the API pool's top-up.)
        return {
          ok: false,
          reason: "seat_allowance_reached",
          message:
            "Seat token allowance reached for this cycle. Request extra from the workspace owner.",
        }
      }
    }
  }

  await deductTokens(
    customerId,
    action,
    cost,
    config.currency,
    caller ? { kind: caller.kind, id: caller.id } : undefined,
  )
  tryAutoReload(customerId, config.currency).catch(() => {})
  return { ok: true }
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
  /** Plan catalog (for seat packs + allowance mode). */
  plans: PlansConfig
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
  /** Start of the current billing cycle, unix seconds. Default: 1st of the month
   *  UTC. Override to align to the Stripe subscription period. */
  cycleStart?: () => number
  /** Cycle key top-up grants are stored under. Default "YYYY-MM" UTC. Must move
   *  in lockstep with `cycleStart`. */
  cycleKey?: () => string
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
    cycleStart = defaultCycleStart,
    cycleKey = defaultCycleKey,
  } = meterCfg
  const userSeat = seatDefaults?.user ?? "standard"
  const apiSeat = seatDefaults?.api ?? "api"

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
    // Owner-approved extra allowance for a user seat this cycle (top-up flow).
    const extra =
      caller?.kind === "user" && caller.id
        ? await extraAllowance(adapter, orgId, caller.id, cycleKey())
        : 0
    return meterUsage(adapter, config, {
      orgId,
      action,
      cost,
      plans,
      plan: await currentPlan(orgId),
      cycleStart: cycleStart(),
      extraAllowance: extra,
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
