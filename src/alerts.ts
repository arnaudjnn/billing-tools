import type { AllowanceState, LimitState } from "./allowance.js";
import type { Notify } from "./notifications/index.js";
import type { BillingAdapter } from "./types.js";

// "You are nearly out" — said before the wall, not after it.
//
// Everything needed to say it was already on the hot path and thrown away: `meterUsage`
// holds the whole `AllowanceState` (pack, pool, the customer's own spend ceiling) because
// it has to, to decide whether this call is allowed. What it did NOT do was notice that the
// call took somebody from 79% to 81%. So the customer learned they were out by being
// refused, and the "Avvisi via email" a billing page offered was a setting that was stored
// and never read by anything.
//
// Two kinds of threshold, deliberately kept as one event:
//
//   • PERCENT, on an allowance the plan gives you (a seat pack, the shared pool). The
//     deployment picks the levels; 80 and 100 by default.
//   • CREDITS, on the customer's OWN monthly spend ceiling (`setSpendControls`'s
//     `alertCredits`). They chose the number, so it is absolute, not a share of anything.
//
// Rate limits are deliberately NOT alerted on. They are the product's, they reset within
// days, and the customer cannot act on one — an email saying "you are at 80% of a weekly
// cap that clears on Monday" is noise about a decision nobody has to make.

/** Where a threshold was crossed. `key` is stable, and is what dedupe is keyed on. */
export interface AlertCrossing {
  key: "pack" | "pool" | "spend";
  scope: "member" | "org";
  threshold: number;
  unit: "percent" | "credits";
  every: string;
  label: string | null;
  used: number;
  limit: number;
  percent: number;
}

export const DEFAULT_ALERT_THRESHOLDS = [80, 100] as const;

const pct = (used: number, size: number): number =>
  size <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((used / size) * 100)));

/**
 * Which thresholds this state is AT, highest first — pure, and knows nothing about what has
 * already been sent.
 *
 * Highest first because only the top one is worth an email: crossing 80 and 100 in the same
 * call is one piece of news ("you are out"), not two.
 */
export function crossings(
  state: Pick<AllowanceState, "pack" | "pool" | "limits">,
  thresholds: readonly number[] = DEFAULT_ALERT_THRESHOLDS,
): AlertCrossing[] {
  const levels = [...thresholds].sort((a, b) => b - a);
  const out: AlertCrossing[] = [];

  const allowance = (
    key: "pack" | "pool",
    scope: "member" | "org",
    w: { size: number; used: number } | null,
  ) => {
    if (!w || w.size <= 0) return;
    const percent = pct(w.used, w.size);
    const hit = levels.find((t) => percent >= t);
    if (hit == null) return;
    out.push({
      key,
      scope,
      threshold: hit,
      unit: "percent",
      every: "cycle",
      label: null,
      used: w.used,
      limit: w.size,
      percent,
    });
  };

  allowance("pack", "member", state.pack);
  allowance("pool", "org", state.pool);

  // The customer's own ceiling, at the figures the customer chose.
  const spend = (state.limits ?? []).find((l): l is LimitState => l.kind === "spend");
  if (spend && spend.size > 0) {
    const chosen = [...(spend.alertsAt ?? [])].sort((a, b) => b - a);
    const hit = chosen.find((credits) => spend.used >= credits);
    if (hit != null) {
      out.push({
        key: "spend",
        scope: "org",
        threshold: hit,
        unit: "credits",
        every: spend.every,
        label: spend.label,
        used: spend.used,
        limit: spend.size,
        percent: pct(spend.used, spend.size),
      });
    }
  }

  return out;
}

// ── What has already been said ───────────────────────────────────────────────
//
// One record per subject per cycle, holding only the HIGHEST threshold announced. That is
// the whole state: "already told them about 80" answers both "tell them about 80 again?"
// (no) and "tell them about 100?" (yes). A list of everything ever sent would grow without
// bound inside a metadata value measured in hundreds of characters.
//
// Bounded by construction: the current cycle only. A new cycle replaces the record rather
// than appending to it, because an allowance that reset has nothing to say about the last
// one — which is also what makes the alerts fire again next month, as they should.

const ORG_KEY = "btAlerts";
const MEMBER_KEY = "btAlerts";
/** Same ceiling `topup.ts` respects, for the same WorkOS reason. */
const ORGS_PER_MEMBER = 3;

type Sent = { c: string; w: Record<string, number> };

function parse(raw: string | undefined): Record<string, Sent> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, Sent>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Filter to the crossings nobody has been told about, and record them.
 *
 * Read-modify-write, and NOT transactional — two concurrent calls can both decide to send.
 * That is deliberate and safe: every notification carries a derived id
 * (`alert:<org>:<cycle>:<key>:<threshold>`), so a receiver deduping on it turns the race
 * into one email. Locking a metered call to avoid a rare duplicate would be the wrong trade
 * by a wide margin.
 */
export async function claimCrossings(
  adapter: BillingAdapter,
  input: { orgId: string; memberId?: string | null; cycleKey: string; crossings: AlertCrossing[] },
): Promise<AlertCrossing[]> {
  const org = input.crossings.filter((c) => c.scope === "org");
  const member = input.crossings.filter((c) => c.scope === "member");

  const [orgFresh, memberFresh] = await Promise.all([
    org.length ? claimOrg(adapter, input.orgId, input.cycleKey, org) : Promise.resolve([]),
    member.length && input.memberId
      ? claimMember(adapter, input.orgId, input.memberId, input.cycleKey, member)
      : Promise.resolve([]),
  ]);
  return [...orgFresh, ...memberFresh];
}

async function claimOrg(
  adapter: BillingAdapter,
  orgId: string,
  cycleKey: string,
  want: AlertCrossing[],
): Promise<AlertCrossing[]> {
  if (!adapter.getOrgMetadata || !adapter.setOrgMetadata) return want;
  const md = (await adapter.getOrgMetadata(orgId)) ?? {};
  const current = parse(md[ORG_KEY])[orgId];
  const sent = current?.c === cycleKey ? current.w : {};
  const fresh = want.filter((c) => (sent[c.key] ?? -1) < c.threshold);
  if (!fresh.length) return [];

  const next: Sent = { c: cycleKey, w: { ...sent } };
  for (const c of fresh) next.w[c.key] = c.threshold;
  await adapter.setOrgMetadata(orgId, { [ORG_KEY]: JSON.stringify({ [orgId]: next }) });
  return fresh;
}

async function claimMember(
  adapter: BillingAdapter,
  orgId: string,
  memberId: string,
  cycleKey: string,
  want: AlertCrossing[],
): Promise<AlertCrossing[]> {
  // An adapter with no per-member store cannot remember what it said, and repeating an
  // alert every call would be worse than not sending it. The receiver's dedupe on the id
  // still holds the line for a deployment that wants them anyway.
  if (!adapter.getUserMetadata || !adapter.setUserMetadata) return [];
  const md = (await adapter.getUserMetadata(memberId)) ?? {};
  const all = parse(md[MEMBER_KEY]);
  const current = all[orgId];
  const sent = current?.c === cycleKey ? current.w : {};
  const fresh = want.filter((c) => (sent[c.key] ?? -1) < c.threshold);
  if (!fresh.length) return [];

  const next: Sent = { c: cycleKey, w: { ...sent } };
  for (const c of fresh) next.w[c.key] = c.threshold;

  // Oldest orgs shed first, the same discipline the grants store follows: one member of
  // many workspaces must not be able to overflow a value every one of them writes to.
  const entries = Object.entries({ ...all, [orgId]: next });
  const kept = entries.slice(Math.max(0, entries.length - ORGS_PER_MEMBER));
  await adapter.setUserMetadata(memberId, { [MEMBER_KEY]: JSON.stringify(Object.fromEntries(kept)) });
  return fresh;
}

/**
 * The whole thing, as the meter calls it: notice, claim, say. Never awaited by the caller.
 *
 * Failures are swallowed here rather than at the meter, for the reason every notification
 * follows: the call this describes already happened and was already charged.
 */
export function maybeAlert(
  adapter: BillingAdapter,
  notify: Notify | undefined,
  input: {
    orgId: string;
    memberId?: string | null;
    cycleKey: string;
    state: Pick<AllowanceState, "pack" | "pool" | "limits">;
    thresholds?: readonly number[];
  },
): void {
  if (!notify) return;
  const at = crossings(input.state, input.thresholds);
  if (!at.length) return;

  void claimCrossings(adapter, { ...input, crossings: at })
    .then((fresh) => {
      for (const c of fresh) {
        notify({
          id: `alert:${input.orgId}:${input.cycleKey}:${c.key}:${c.threshold}`,
          type: "usage.threshold",
          orgId: input.orgId,
          to: [],
          audience:
            c.scope === "member" && input.memberId
              ? { kind: "member", memberId: input.memberId }
              : { kind: "admins" },
          data: {
            scope: c.scope,
            member: c.scope === "member" && input.memberId ? { id: input.memberId, email: null } : null,
            window: {
              every: c.every,
              label: c.label,
              used: c.used,
              limit: c.limit,
              percent: c.percent,
            },
            threshold: c.threshold,
            unit: c.unit,
          },
        });
      }
    })
    .catch(() => {
      // Alerting is the least important thing happening on this call.
    });
}
