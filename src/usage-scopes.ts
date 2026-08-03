import { getStripe } from "./billing.js";
import type { LedgerCoverage } from "./plan-model.js";
import {
  meterIdFor,
  stripeBalanceUsageLedger,
  type UsageEvent,
  type UsageLedger,
  type UsageQuery,
} from "./usage-ledger.js";

// Per-member usage counted in Stripe, so the one window Stripe "cannot" count
// needs no database after all.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// A window that is both INCLUDED and PER-MEMBER (`cap: per_seat`, a
// `scope: "caller"` rate limit) was the single reason this library ever asked for
// a store. A balance transaction carries the caller but only exists where money
// moved, and a meter summary sees every call but cannot be filtered by one.
//
// That second half is true of a meter's DIMENSIONS, and only of those. Measured
// against the API: `listEventSummaries` requires `customer` and offers no
// group-by; `/v1/billing/analytics/meter_usage` is not available; there is no read
// API for raw meter events; a zero-amount balance transaction is rejected outright
// ("The transaction's `amount` must be non-zero"); WorkOS has no atomic increment.
// So Stripe exposes exactly ONE grouping key for usage — the Customer.
//
// Which is enough, because a customer is just a key. A counter here is an opaque
// scope string (`org` / `k:<kind>` / `u:<memberId>`) derived identically on the
// write and read paths, and this file backs each one with a Stripe Customer.
//
// That is what let the SQL and Redis counter backends be deleted outright: they
// existed for this one question, and it now has a Stripe answer.
//
// ── Why this does not inherit the meter's lag where it would hurt ───────────
//
// Meter summaries lag aggregation by roughly 40–60 seconds (measured three times:
// 40 s, 48 s, 58 s). Against a monthly seat pack that is noise. Against a
// `600/hour` limit on an API key it is not — a script would burn most of the
// window before any of it became visible.
//
// It does not have to apply to both, because the two are funded differently and
// the funding is already on the event. `deductCredits` writes `caller_kind` /
// `caller_id` onto every debit, so WALLET-funded per-caller usage is already
// exact, per member, with no lag at all. Only INCLUDED usage needs the meter.
//
//   wallet-funded, per caller → balance transactions   (exact, no lag)
//   included, per caller      → this scope meter       (exact, ~60 s lag)
//
// The two sets are disjoint by construction — an event is funded by exactly one of
// them — so `total` is a plain sum with no double count. It also reproduces the
// SQL behaviour exactly: `counterUsageLedger.record` counts every event whatever
// funded it, and so does the sum of these two legs.
//
// ── Why the org scope gets no customer of its own ───────────────────────────
//
// Because it already has one. `stripeUsageLedger` routes org-wide windows to the
// meter on the org's REAL customer, and that leg is untouched here. This file only
// ever writes and reads `k:` and `u:` scopes, which is what makes it additive: an
// existing deployment's org-wide numbers cannot move.

// ── The scope contract ──────────────────────────────────────────────────────
//
// WHOSE usage. Derived identically on the write and the read path, which is the
// whole contract: a `total` that computed a different scope string from the same
// caller would look up a customer nobody writes to, and report 0 for that member
// for ever — a failure that looks like generosity rather than a fault.
//
// `org` is every call in the workspace. A caller kind with no id is every caller
// of that kind (how a shared API seat is measured); with an id it is one member.

/** The scope a query is asking about. */
export function scopeOf(filter?: { callerKind?: string; callerId?: string }): string {
  if (filter?.callerId) return `u:${filter.callerId}`;
  if (filter?.callerKind) return `k:${filter.callerKind}`;
  return "org";
}

/** Every scope a single event counts toward. One event is counted once per
 *  scope, so an org-wide read and a per-member read both see it. */
export function scopesFor(event: { caller?: { kind?: string; id?: string } }): string[] {
  const scopes = ["org"];
  if (event.caller?.kind) scopes.push(`k:${event.caller.kind}`);
  if (event.caller?.id) scopes.push(`u:${event.caller.id}`);
  return scopes;
}

/** Default name of the Stripe Billing Meter the per-caller scopes report to.
 *
 *  Deliberately NOT the org meter's event name. They could share one — the scopes
 *  are separated by customer either way — but a separate meter keeps a shadow
 *  customer's usage out of anything the org meter is ever attached to for actual
 *  billing. One extra account-level object, not one per org. */
export const SCOPE_METER_EVENT = "billing_tools_scope_usage";

/** Marks a customer as a counter rather than someone who buys anything. Read by
 *  the doctor, which must not sample these when it checks customer currency. */
export const USAGE_SCOPE_KIND = "usage_counter";

/** Where the scope string is stored, so the customer can be found again from
 *  nothing but the scope. */
export const USAGE_SCOPE_KEY = "bt_usage_scope";

// ── Resolving a scope to its customer ───────────────────────────────────────
//
// Derived, never allocated. The key IS the member id, so there is no free list, no
// collision, and no way for a recycled slot to inherit someone else's usage — the
// failure that ruled out the obvious alternative (a meter per seat index, with the
// org staying the customer).
//
// Two mechanisms, and they cover each other's blind spot exactly:
//
//   • `customers.search` on the scope. Authoritative, but the search index is
//     EVENTUALLY consistent — measured, a fresh customer was still missing after
//     20 s. So it cannot be the only lookup.
//   • `customers.create` under an idempotency key derived from the scope. Measured:
//     two concurrent creates and a later repeat all returned the same customer id.
//     Stripe keeps a key for 24 h.
//
// Search is stale only for objects created minutes ago; the idempotency key covers
// the next 24 hours. There is no window where both miss, so two instances cannot
// end up writing the same member's usage to two different customers — which would
// under-report, and under-reporting reads as generosity rather than as a fault.
const customers = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const warned = new Set<string>();

/** One line per process, not per call: this is on the hot path of every metered
 *  execution, and a broken key would otherwise print thousands of them. */
function complain(what: string, e: unknown): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.error(
    `[billing] per-caller usage scope "${what}" could not be resolved: ${(e as Error).message}. ` +
      "Included usage for that caller counts as 0, so a seat pack or a caller-scoped rate " +
      "limit will not apply to them. Grant the Stripe key read/write access to customers.",
  );
}

function customerForScope(orgId: string, scope: string): Promise<string | null> {
  const key = `${orgId}|${scope}`;
  const hit = customers.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const resolve = (async () => {
    try {
      const stripe = getStripe();
      const found = await stripe.customers.search({
        query: `metadata['${USAGE_SCOPE_KEY}']:'${key}'`,
        limit: 1,
      });
      const id =
        found.data[0]?.id ??
        (
          await stripe.customers.create(
            {
              name: `usage ${key}`,
              metadata: { [USAGE_SCOPE_KEY]: key, bt_kind: USAGE_SCOPE_KIND },
            },
            // Covers precisely the window in which the search above can be stale.
            { idempotencyKey: `bt-usage-scope-${key}` },
          )
        ).id;
      customers.set(key, id);
      return id;
    } catch (e) {
      // NOT remembered as a failure. Unlike a meter, this is one cheap lookup and
      // the memo already prevents repeats on success; caching the miss would keep
      // a member uncounted for the life of the process after one blip.
      complain(key, e);
      return null;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, resolve);
  return resolve;
}

/** Forget resolved scope customers — for a test, or after deleting one. */
export function invalidateUsageScopes(): void {
  customers.clear();
  warned.clear();
}

// ── The v2 meter event stream ───────────────────────────────────────────────
//
// Used instead of `billing.meterEvents.create` because it carries every scope in
// ONE request, and because it is faster: measured, three events in one v2 call is
// 128 ms against 249 ms for a single v1 event. Writing per-caller scopes therefore
// costs less than the org write this library already does, rather than adding to
// it.
let session: { token: string; expiresAt: number } | null = null;

async function streamToken(): Promise<string> {
  // Refreshed a minute early: a token that expires mid-flight would drop the write,
  // and a dropped write is usage counted by nothing.
  if (session && session.expiresAt - Date.now() > 60_000) return session.token;
  const s = await getStripe().v2.billing.meterEventSession.create();
  session = { token: s.authentication_token, expiresAt: Date.parse(s.expires_at) };
  return session.token;
}

// ── Answering several windows with one request ──────────────────────────────
//
// A plan declares more than one window over the SAME caller — a monthly seat pack
// and a weekly limit, say — and `resolveAllowance` issues them together, in one
// tick, deliberately (they go in a single `Promise.all` so the meter costs one
// round trip's latency rather than three). That makes them batchable without any
// change to the seam: collect what arrives in a tick, then answer it in as few
// requests as Stripe allows.
//
// The meter can group by time: `value_grouping_window: "day"` returns one bucket
// per day over the range, so a month-wide read and a week-wide read over the same
// scope both come out of ONE response. Verified against the API — a slice of the
// bucketed response equals a dedicated narrow read exactly, and empty days are
// simply absent, so a slice sums the buckets it contains rather than assuming they
// are contiguous.
//
// Stripe ENFORCES alignment for that parameter ("start_time … should be aligned
// with daily boundaries"), so only day-aligned windows can share a read. That is
// most of them: `rateWindowFor` aligns day, week and month to UTC boundaries. An
// `every: "hour"` window is not day-aligned and keeps its own read — which costs
// nothing, since an hour is one bucket either way.

const DAY_MS = 86_400_000;
const isDayAligned = (q: UsageQuery): boolean =>
  q.start % DAY_MS === 0 && (q.end == null || q.end % DAY_MS === 0);

/** Sum the buckets that fall inside a window. Buckets are day-sized and the
 *  window is day-aligned, so they nest exactly and none is split. */
function sliceBuckets(
  buckets: readonly { start_time: number; end_time: number; aggregated_value: number }[],
  q: UsageQuery,
): number {
  const from = Math.floor(q.start / 1000);
  const to = q.end == null ? Number.POSITIVE_INFINITY : Math.floor(q.end / 1000);
  let sum = 0;
  for (const b of buckets) if (b.start_time >= from && b.end_time <= to) sum += b.aggregated_value;
  return sum;
}

export interface ScopeLedgerOptions {
  /** Meter event name. Defaults to `SCOPE_METER_EVENT`. */
  eventName?: string;
  /**
   * Where WALLET-funded per-caller usage is read from. Defaults to the balance
   * ledger, which is exact and has no lag because the debit IS the record.
   *
   * A seam so a test can substitute one; there is no second right answer.
   *
   * There used to be a `null` here meaning "never read the wallet", because that
   * walk is the most expensive read in this file. It is gone: it was a
   * per-DEPLOYMENT switch for a per-QUERY fact, and the same plan can have a
   * member window that overflows into the wallet and an agent window that is
   * wallet-only — so one flag could not be right for both, and setting it wrong
   * under-reported, which reads as generosity and refuses no one.
   * `UsageQuery.sources` carries it per read instead, and `resolveAllowance`
   * derives it from the plan, so nothing has to be declared by hand.
   */
  wallet?: UsageLedger;
}

/**
 * A per-CALLER `UsageLedger` backed entirely by Stripe.
 *
 * Built to be the `perCaller` leg of the composite, which is the only thing that
 * ever asks it a caller-filtered question:
 *
 * ```ts
 * stripeUsageLedger({ perCaller: stripeScopeUsageLedger() })
 * ```
 *
 * `covers.orgIncluded` is false because it does not answer org-wide windows — the
 * composite's own meter leg does, on the org's real customer, unchanged.
 */
export function stripeScopeUsageLedger(opts: ScopeLedgerOptions = {}): UsageLedger {
  const eventName = opts.eventName ?? SCOPE_METER_EVENT;
  const wallet = opts.wallet ?? stripeBalanceUsageLedger();

  const api: UsageLedger = {
    covers: { orgIncluded: false, callerIncluded: true } satisfies LedgerCoverage,

    async record(event: UsageEvent) {
      if (!event.cost) return; // a free call moves no counter
      // The wallet leg has already recorded this one: `deductCredits` wrote the
      // balance transaction, carrying the caller. Reporting it here as well would
      // make `total` count it twice.
      if (event.funded === "wallet") return;

      // `org` is deliberately absent: the composite's meter leg already reported
      // this event on the org's real customer.
      const scopes = scopesFor(event).filter((s) => s !== "org");
      if (!scopes.length) return;

      try {
        // Resolved BEFORE reporting, like the meter itself: an event naming a
        // customer that does not exist is rejected outright (verified), and this is
        // the write side, whose loss cannot be recovered by a later read.
        const meter = await meterIdFor(eventName, { displayName: "billing-tools per-caller usage" });
        if (!meter) return;
        const ids = await Promise.all(scopes.map((s) => customerForScope(event.orgId, s)));
        const at = new Date(event.at ?? Date.now()).toISOString();
        const events = ids.flatMap((id, i) =>
          id
            ? [
                {
                  event_name: eventName,
                  // Makes a retried execution a no-op rather than a double count,
                  // per scope. Without a key every event is genuinely distinct, so
                  // a fresh id is the honest answer.
                  identifier: `${event.idempotencyKey ?? globalThis.crypto.randomUUID()}-${scopes[i]}`,
                  timestamp: at,
                  payload: { stripe_customer_id: id, value: String(event.cost) },
                },
              ]
            : [],
        );
        if (!events.length) return;
        await getStripe().v2.billing.meterEventStream.create(
          { events },
          { apiKey: await streamToken() },
        );
      } catch (e) {
        // Never throws, for the same reason `meterIdFor` does not: this runs inside
        // every metered call, and a counting failure must not take the product down.
        complain(`${event.orgId}|record`, e);
      }
    },

    total(query: UsageQuery) {
      // Queued rather than issued: everything asked for in this tick is answered
      // together below. `resolveAllowance` issues its windows in one `Promise.all`,
      // so this collapses them with no change at the call site.
      return new Promise<number>((resolve, reject) => {
        pending.push({ query, resolve, reject });
        if (!flushing) {
          flushing = true;
          queueMicrotask(flush);
        }
      });
    },

    totals: (queries) => Promise.all(queries.map((q) => api.total(q))),
  };

  // ── the per-tick batcher ──────────────────────────────────────────────────
  type Waiting = {
    query: UsageQuery;
    resolve: (n: number) => void;
    reject: (e: unknown) => void;
  };
  let pending: Waiting[] = [];
  let flushing = false;

  async function flush(): Promise<void> {
    const batch = pending;
    pending = [];
    flushing = false;
    if (!batch.length) return;

    // Group by everything that decides WHICH events are eligible. The window
    // bounds are not part of it — they only decide which group member each event
    // lands in, which is exactly what makes one read serve several windows.
    const groups = new Map<string, Waiting[]>();
    for (const w of batch) {
      const scope = scopeOf(w.query.filter);
      const key = [
        w.query.orgId,
        w.query.customerId,
        scope,
        w.query.sources?.wallet ?? true,
        w.query.sources?.included ?? true,
      ].join("|");
      const g = groups.get(key);
      if (g) g.push(w);
      else groups.set(key, [w]);
    }

    await Promise.all([...groups.values()].map((g) => answerGroup(g).catch(() => {})));
  }

  async function answerGroup(group: Waiting[]): Promise<void> {
    const first = group[0]!.query;
    const scope = scopeOf(first.filter);

    // An org-wide window is not this leg's question — see `total`'s old comment.
    if (scope === "org") {
      const sums = await legTotals(wallet, group.map((w) => w.query));
      group.forEach((w, i) => w.resolve(sums[i] ?? 0));
      return;
    }

    const wantsWallet = first.sources?.wallet ?? true;
    const wantsIncluded = first.sources?.included ?? true;

    const [paid, included] = await Promise.all([
      wantsWallet
        ? legTotals(wallet, group.map((w) => w.query)).catch((e) => {
            complain(`${first.orgId}|wallet`, e);
            return group.map(() => 0);
          })
        : Promise.resolve(group.map(() => 0)),
      wantsIncluded
        ? meterTotals(group, scope).catch((e) => {
            complain(`${first.orgId}|${scope}`, e);
            return group.map(() => 0);
          })
        : Promise.resolve(group.map(() => 0)),
    ]);

    group.forEach((w, i) => w.resolve((paid[i] ?? 0) + (included[i] ?? 0)));
  }

  /** One bucketed read for every day-aligned window in the group; the rest keep
   *  their own, which is what an `every: "hour"` window needs and costs nothing. */
  async function meterTotals(group: Waiting[], scope: string): Promise<number[]> {
    const out = new Array<number>(group.length).fill(0);
    const meter = await meterIdFor(eventName, { create: false });
    if (!meter) return out;
    const id = await customerForScope(group[0]!.query.orgId, scope);
    if (!id) return out;
    const stripe = getStripe();
    const floorMinute = (ms: number) => Math.floor(ms / 60_000) * 60;

    const aligned: number[] = [];
    const loose: number[] = [];
    group.forEach((w, i) => (isDayAligned(w.query) ? aligned : loose).push(i));

    const work: Promise<void>[] = [];

    if (aligned.length === 1) {
      // One window needs no bucketing, and a plain read is cheaper to page.
      loose.push(aligned.pop()!);
    } else if (aligned.length > 1) {
      const from = Math.min(...aligned.map((i) => group[i]!.query.start));
      const opened = aligned.some((i) => group[i]!.query.end == null);
      const to = opened
        ? Math.ceil(Date.now() / DAY_MS) * DAY_MS
        : Math.max(...aligned.map((i) => group[i]!.query.end!));
      work.push(
        (async () => {
          const buckets: { start_time: number; end_time: number; aggregated_value: number }[] = [];
          for await (const b of stripe.billing.meters.listEventSummaries(meter, {
            customer: id,
            start_time: Math.floor(from / 1000),
            end_time: Math.floor(to / 1000),
            value_grouping_window: "day",
            limit: 100,
          })) {
            buckets.push(b as unknown as (typeof buckets)[number]);
          }
          for (const i of aligned) out[i] = sliceBuckets(buckets, group[i]!.query);
        })(),
      );
    }

    for (const i of loose) {
      const q = group[i]!.query;
      work.push(
        (async () => {
          const s = await stripe.billing.meters.listEventSummaries(meter, {
            customer: id,
            start_time: floorMinute(q.start),
            end_time: floorMinute(q.end ?? Date.now()),
            limit: 100,
          });
          out[i] = s.data.reduce((sum, x) => sum + x.aggregated_value, 0);
        })(),
      );
    }

    await Promise.all(work);
    return out;
  }

  /** A leg's answer for many windows: its own batch method when it has one. */
  function legTotals(leg: UsageLedger, queries: readonly UsageQuery[]): Promise<number[]> {
    return leg.totals ? leg.totals(queries) : Promise.all(queries.map((q) => leg.total(q)));
  }

  return api;
}
