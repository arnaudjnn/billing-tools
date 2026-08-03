import type { UsageEvent, UsageLedger, UsageQuery } from "./usage-ledger.js";

// A short-lived cache in front of any `UsageLedger`.
//
// ── Why this exists, in requests ────────────────────────────────────────────
//
// Every window a plan declares is one `total` on the hot path of every metered
// call. Measured on a real per-seat catalogue, one metered call by a member costs
// two `listEventSummaries` plus two balance-transaction walks. Stripe's live
// limits are 100 req/s globally and **25 req/s per endpoint** — and
// `listEventSummaries` is one endpoint — so that shape tops out around a dozen
// metered calls per second for the whole account, whatever the traffic.
//
// The reads are also far more repetitive than the traffic is: a fixed, UTC-aligned
// window (`rateWindowFor`) asked twice in the same second returns the same number
// by construction, and a usage screen asks N members the same question at once.
//
// ── What it costs, stated plainly ──────────────────────────────────────────
//
// A cached window can be STALE by up to `ttlMs`, and the gate reads through it, so
// a caller can overspend by whatever they can burn inside that TTL. That is a real
// trade, not a free win:
//
//   overspend ≤ (calls per second by one caller) × ttlMs × (credits per call)
//
// At the default 2 s that is single-digit credits against windows measured in
// hundreds or thousands. Pick the TTL against the TIGHTEST window you enforce,
// not the loosest — a 600/hour limit tolerates seconds; it would not tolerate a
// minute.
//
// This is why it is OPT-IN and not the default: a library that silently let
// customers past their cap to save requests would be trading the thing the meter
// exists for. `createBilling({ meter: { ledger } })` is where you say yes.
//
// ── What is NOT cached ─────────────────────────────────────────────────────
//
// `record` always passes straight through — a write that skipped would be usage
// counted by nothing, which is the failure this whole subsystem is built to avoid.
// The wallet BALANCE is not read here at all (`getCreditBalance` is its own call),
// so money is never served from cache.

export interface UsageCacheOptions {
  /** How long a window's total may be reused. Default 2 000 ms. */
  ttlMs?: number;
  /**
   * Cap on remembered windows. Beyond it the expired entries are dropped, and if
   * that is not enough the cache is cleared outright.
   *
   * A bound is needed because the key includes the window, so a long-running
   * process accumulates one entry per window per caller for ever. Clearing is
   * safe — the next read simply goes to the ledger — whereas an unbounded map is
   * a slow leak that only shows up in production.
   */
  maxEntries?: number;
}

/** Same shape on the write and read paths, so a cached read cannot answer for a
 *  different window than the one asked about. `end` omitted means "up to now",
 *  which is a distinct key from a closed window ending at this instant. */
function keyOf(q: UsageQuery): string {
  const f = q.filter;
  return [
    q.orgId,
    q.customerId,
    q.start,
    q.end ?? "now",
    f?.callerKind ?? "",
    f?.callerId ?? "",
  ].join("|");
}

/**
 * Wrap a ledger so repeated reads of the same window inside `ttlMs` cost one
 * request instead of one per call.
 *
 * ```ts
 * const ledger = cachedUsageLedger(
 *   stripeUsageLedger({ perCaller: stripeScopeUsageLedger() }),
 *   { ttlMs: 2_000 },
 * );
 * ```
 *
 * `covers` is inherited unchanged: caching does not alter WHICH windows the
 * underlying ledger can see, only how often it is asked.
 */
export function cachedUsageLedger(inner: UsageLedger, opts: UsageCacheOptions = {}): UsageLedger {
  const ttl = Math.max(0, opts.ttlMs ?? 2_000);
  const maxEntries = Math.max(1, opts.maxEntries ?? 10_000);
  const values = new Map<string, { at: number; total: number }>();
  // In-flight reads are shared, which is the part that matters for a usage screen:
  // twenty members asking at once become one request per distinct window rather
  // than twenty identical ones racing each other.
  const inflight = new Map<string, Promise<number>>();

  function prune(now: number): void {
    if (values.size <= maxEntries) return;
    for (const [k, v] of values) if (now - v.at >= ttl) values.delete(k);
    if (values.size > maxEntries) values.clear();
  }

  return {
    ...(inner.covers ? { covers: inner.covers } : {}),

    // Never cached, never coalesced: a dropped write is usage counted by nothing.
    record: (event: UsageEvent) => inner.record(event),

    async total(query: UsageQuery) {
      if (ttl === 0) return inner.total(query);
      const key = keyOf(query);
      const now = Date.now();

      const hit = values.get(key);
      if (hit && now - hit.at < ttl) return hit.total;

      const pending = inflight.get(key);
      if (pending) return pending;

      const read = inner
        .total(query)
        .then((total) => {
          values.set(key, { at: Date.now(), total });
          prune(Date.now());
          return total;
        })
        // A failed read is not remembered: the next call retries rather than
        // serving an error's absence as a number for the rest of the TTL.
        .finally(() => inflight.delete(key));

      inflight.set(key, read);
      return read;
    },
  };
}
