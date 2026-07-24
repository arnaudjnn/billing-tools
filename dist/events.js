import { WorkOS } from "@workos-inc/node";
import { getStripe } from "./billing.js";
// Event-polling sync — the zero-webhook path. Poll the Stripe and WorkOS Events
// APIs on a schedule (the app runs a loop/cron); no webhook endpoints, no
// signing secrets, no dashboard — just the API keys + a persisted cursor.
//
// Cursor = the last processed event id. First run (no cursor) BASELINES to the
// newest event WITHOUT processing history (so you don't replay months of events
// or double-grant). Persist the returned cursor after each poll; because we
// stop at the cursor, events are processed exactly once (handlers that mutate,
// e.g. token grants, are safe as long as the cursor is saved after handling).
let _workos = null;
function getWorkOS() {
    if (!_workos) {
        const apiKey = process.env.WORKOS_API_KEY;
        if (!apiKey)
            throw new Error("WORKOS_API_KEY is not set");
        _workos = new WorkOS(apiKey, { clientId: process.env.WORKOS_CLIENT_ID ?? "" });
    }
    return _workos;
}
/** Poll Stripe events newer than `after` (last processed event id), oldest
 *  first. No `after` → baseline to the newest event, process nothing. */
export async function pollStripeEvents(opts) {
    const stripe = getStripe();
    const listParams = { limit: 100, ...(opts.types ? { types: opts.types } : {}) };
    if (!opts.after) {
        const latest = await stripe.events.list({ ...listParams, limit: 1 });
        return { cursor: latest.data[0]?.id ?? null, count: 0 };
    }
    const max = opts.maxPerPoll ?? 500;
    const fresh = [];
    for await (const event of stripe.events.list(listParams)) {
        if (event.id === opts.after)
            break; // caught up
        fresh.push(event);
        if (fresh.length >= max)
            break;
    }
    fresh.reverse(); // oldest → newest
    for (const event of fresh)
        await opts.onEvent(event);
    return {
        cursor: fresh.length ? fresh[fresh.length - 1].id : opts.after,
        count: fresh.length,
    };
}
/** Poll WorkOS events of the given types newer than `after`, oldest first.
 *  No `after` → baseline to the newest event, process nothing. */
export async function pollWorkOSEvents(opts) {
    const wos = getWorkOS();
    // WorkOS requires the event-name filter.
    const events = opts.events;
    const page = (after) => wos.events.listEvents({ events, order: "asc", limit: 100, ...(after ? { after } : {}) });
    // Baseline (no cursor): page ascending to the very end and take the last id
    // WITHOUT processing. (WorkOS's `order:desc` isn't reliable for "newest", so
    // we walk forward to the end rather than trust a single desc query.)
    if (!opts.after) {
        let cursor = null;
        for (;;) {
            const p = await page(cursor ?? undefined);
            const data = p.data;
            if (data.length === 0)
                break;
            cursor = data[data.length - 1].id;
            if (data.length < 100)
                break;
        }
        return { cursor, count: 0 };
    }
    const max = opts.maxPerPoll ?? 500;
    let cursor = opts.after;
    let count = 0;
    for (;;) {
        const p = await page(cursor);
        const data = p.data;
        if (data.length === 0)
            break;
        for (const event of data) {
            await opts.onEvent(event);
            cursor = event.id;
            count++;
            if (count >= max)
                break;
        }
        if (count >= max || data.length < 100)
            break;
    }
    return { cursor, count };
}
//# sourceMappingURL=events.js.map