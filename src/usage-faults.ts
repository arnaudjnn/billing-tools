// When counting fails, and what the library did about it.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The characteristic failure of usage counting is not an exception, it is a
// NUMBER THAT IS SILENTLY WRONG — and wrong in the direction nobody reports. A
// window that cannot be read counts as 0, so the cap never applies, so nothing is
// refused, so no customer complains. The first symptom is a month of unenforced
// allowances that cannot be recovered.
//
// Measured, that is not a hypothetical: with every Stripe read rate-limited, a
// member who had spent their entire pack was reported at `used: 0` and allowed
// through. It happens exactly when the account is busiest, which is exactly when
// nobody is reading logs.
//
// So the library says so, on a channel a deployment can alert on. One
// `console.error` per process is not that: it is unstructured, unsampled, and
// invisible to anything but a human tailing output.
//
// ── The contract ───────────────────────────────────────────────────────────
//
// Reporting a fault never throws and never blocks: a broken handler must not take
// down the metered call it is describing. Handlers are called synchronously and
// their exceptions are swallowed deliberately.

/** What the library was doing when counting failed. */
export type UsageFaultOperation =
  /** Reading a window (a cap, a rate limit, the spend ceiling). */
  | "read"
  /** Recording usage. A dropped event is usage counted by nothing. */
  | "write"
  /** Resolving the meter or the scope customer a read/write needs. */
  | "resolve";

/** What the library DID as a result — the part that decides whether a customer
 *  was over-served, under-served, or unaffected. */
export type UsageFaultOutcome =
  /** Reported 0. The window does not apply: nothing is refused. */
  | "counted-zero"
  /** Reported the last value read successfully. Stale, but bounded and sane. */
  | "used-last-known"
  /** Refused: the call was denied because usage could not be established. */
  | "refused"
  /** The event was not recorded. That usage is now uncountable, permanently. */
  | "dropped";

export interface UsageFault {
  operation: UsageFaultOperation;
  outcome: UsageFaultOutcome;
  error: unknown;
  orgId?: string;
  /** `org` / `k:<kind>` / `u:<memberId>` when the fault belongs to one. */
  scope?: string;
  /** The value served instead, when one was. */
  served?: number;
}

export type UsageFaultHandler = (fault: UsageFault) => void;

const handlers = new Set<UsageFaultHandler>();

/**
 * Be told when a usage read or write fails, and what was served instead.
 *
 * ```ts
 * onUsageFault((f) => {
 *   if (f.outcome === "counted-zero") metrics.increment("billing.uncounted");
 *   logger.error({ ...f }, "usage counting degraded");
 * });
 * ```
 *
 * Returns an unsubscribe function. Registering ANY handler silences the built-in
 * console warning, on the assumption that a deployment which asked to be told has
 * somewhere better to put it.
 */
export function onUsageFault(handler: UsageFaultHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Test seam: drop every handler, and the once-per-process de-duplication. */
export function resetUsageFaults(): void {
  handlers.clear();
  warned.clear();
}

// One line per distinct problem per process. A metered endpoint under load would
// otherwise print thousands of identical lines and bury the first one.
const warned = new Set<string>();

export function reportUsageFault(fault: UsageFault): void {
  for (const handler of handlers) {
    try {
      handler(fault);
    } catch {
      // A handler that throws must not take down the metered call it describes.
    }
  }
  if (handlers.size) return;

  const key = `${fault.operation}|${fault.outcome}|${fault.scope ?? ""}`;
  if (warned.has(key)) return;
  warned.add(key);
  const detail = (fault.error as Error)?.message ?? String(fault.error);
  console.error(
    `[billing] usage ${fault.operation} failed${fault.scope ? ` for ${fault.scope}` : ""}: ${detail}. ` +
      `${describe(fault)} Register onUsageFault() to route this somewhere you will see it.`,
  );
}

function describe(fault: UsageFault): string {
  switch (fault.outcome) {
    case "counted-zero":
      return "The window counts as 0, so it does not apply and nothing is refused — usage is being under-counted while this lasts.";
    case "used-last-known":
      return `Served the last value read successfully (${fault.served}), which is stale but bounded.`;
    case "refused":
      return "The call was REFUSED, because usage could not be established.";
    case "dropped":
      return "That usage was not recorded and can no longer be counted.";
  }
}
