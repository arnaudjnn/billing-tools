import type Stripe from "stripe";
import type { Event, EventName } from "@workos-inc/node";
import { getStripe } from "./billing.js";
import { getWorkOS } from "./workos.js";

// Event-polling sync — the zero-webhook path. Poll the Stripe and WorkOS Events
// APIs on a schedule (the app runs a loop/cron); no webhook endpoints, no
// signing secrets, no dashboard — just the API keys + a persisted cursor.
//
// Cursor = the last processed event id. First run (no cursor) BASELINES to the
// newest event WITHOUT processing history (so you don't replay months of events
// or double-grant). Persist the returned cursor after each poll; because we
// stop at the cursor, events are processed exactly once (handlers that mutate,
// e.g. credit grants, are safe as long as the cursor is saved after handling).

export interface PollResult {
  cursor: string | null;
  count: number;
}

/** Poll Stripe events newer than `after` (last processed event id), oldest
 *  first. No `after` → baseline to the newest event, process nothing. */
export async function pollStripeEvents(opts: {
  after?: string | null;
  types?: string[];
  onEvent: (event: Stripe.Event) => Promise<void>;
  maxPerPoll?: number;
}): Promise<PollResult> {
  const stripe = getStripe();
  const listParams = { limit: 100, ...(opts.types ? { types: opts.types } : {}) };

  if (!opts.after) {
    const latest = await stripe.events.list({ ...listParams, limit: 1 });
    return { cursor: latest.data[0]?.id ?? null, count: 0 };
  }

  const max = opts.maxPerPoll ?? 500;
  const PAGE = 100;

  // Walk FORWARD from the cursor, page by page, advancing it only across events
  // actually processed.
  //
  // The obvious implementation — list newest-first and collect until you reach
  // the cursor — loses events. Stripe returns newest first, so once a backlog
  // exceeds the per-poll cap you collect the NEWEST `max`, never reach the
  // cursor, and then move the cursor to the newest event: everything between the
  // old cursor and that window is skipped, silently and permanently. It fires
  // precisely when this path matters — the poller was down, so the backlog is
  // large — which is the worst possible time to drop events.
  //
  // Paging with `ending_before` returns the page immediately NEWER than an id,
  // so each batch is contiguous with the cursor. The cap then bounds throughput
  // per poll instead of discarding history: whatever is left is picked up by the
  // next one.
  let cursor: string | null = opts.after;
  let count = 0;

  for (;;) {
    let page: Stripe.ApiList<Stripe.Event>;
    try {
      page = await stripe.events.list({
        ...listParams,
        limit: PAGE,
        ending_before: cursor!,
      });
    } catch (err) {
      // Stripe keeps events for 30 days. A cursor older than that no longer
      // resolves, and every future poll would raise the same error forever —
      // so re-baseline to the newest event and carry on. History that aged out
      // is unrecoverable either way; wedging the sync on top of it is not.
      if ((err as { code?: string }).code === "resource_missing") {
        const latest = await stripe.events.list({ ...listParams, limit: 1 });
        return { cursor: latest.data[0]?.id ?? null, count };
      }
      throw err;
    }

    const asc = [...page.data].reverse(); // Stripe pages newest-first
    if (asc.length === 0) break;

    for (const event of asc) {
      await opts.onEvent(event);
      // Advance per event: a throw mid-page leaves the caller's stored cursor
      // untouched, so the page is retried rather than half-skipped.
      cursor = event.id;
      count++;
    }

    if (count >= max) break;
    // A short page means we've reached the newest event.
    if (asc.length < PAGE) break;
  }

  return { cursor, count };
}

/** Poll WorkOS events of the given types newer than `after`, oldest first.
 *  No `after` → baseline to the newest event, process nothing. */
export async function pollWorkOSEvents(opts: {
  after?: string | null;
  events: string[];
  onEvent: (event: { id: string; event: string; data: unknown }) => Promise<void>;
  maxPerPoll?: number;
}): Promise<PollResult> {
  const wos = getWorkOS();
  // WorkOS requires the event-name filter (narrow to the SDK's EventName union).
  const events = opts.events as EventName[];
  const page = (after?: string): Promise<{ data: Event[] }> =>
    wos.events.listEvents({ events, order: "asc", limit: 100, ...(after ? { after } : {}) });

  // Baseline (no cursor): page ascending to the very end and take the last id
  // WITHOUT processing. (WorkOS's `order:desc` isn't reliable for "newest", so
  // we walk forward to the end rather than trust a single desc query.)
  // NOTE: listEvents returns a plain List (not an AutoPaginatable), so this
  // manual walk is required — see the AGENTS.md "deliberate exceptions".
  if (!opts.after) {
    let cursor: string | null = null;
    for (;;) {
      const { data } = await page(cursor ?? undefined);
      if (data.length === 0) break;
      cursor = data[data.length - 1].id;
      if (data.length < 100) break;
    }
    return { cursor, count: 0 };
  }

  const max = opts.maxPerPoll ?? 500;
  let cursor: string = opts.after;
  let count = 0;
  for (;;) {
    const { data } = await page(cursor);
    if (data.length === 0) break;
    for (const event of data) {
      await opts.onEvent({ id: event.id, event: event.event, data: event.data });
      cursor = event.id;
      count++;
      if (count >= max) break;
    }
    if (count >= max || data.length < 100) break;
  }
  return { cursor, count };
}
