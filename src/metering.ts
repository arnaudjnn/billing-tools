import {
  deductTokens,
  getBillingCustomerId,
  getTokenBalance,
  stripeConfigured,
  tryAutoReload,
  usageSince,
} from "./billing.js";
import { isInternalOrg } from "./auth.js";
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
  if (cost <= 0) return { ok: true }
  if (!stripeConfigured()) return { ok: true }
  if (await isInternalOrg(adapter, orgId, config.internalDomains)) return { ok: true }

  const customerId = await getBillingCustomerId(adapter, orgId)
  if (!customerId) {
    return { ok: false, reason: "no_billing", message: "No billing account found." }
  }

  // The shared reserve must cover the debit (it funds every pack + any API top-up).
  const balance = await getTokenBalance(customerId)
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
      if (used + cost > pack && caller.kind === "user") {
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
