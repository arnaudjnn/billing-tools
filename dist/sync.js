import { pollStripeEvents, pollWorkOSEvents } from "./events.js";
import { creditTokens, getStripe } from "./billing.js";
import { includedTokens, planForPriceId } from "./plans.js";
const CURSOR_TABLE = "billing_sync_cursors";
// A CursorStore backed by a self-managed table via the app's query executor.
function queryCursorStore(query) {
    let ensured = false;
    const ensure = async () => {
        if (ensured)
            return;
        await query(`CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (source text PRIMARY KEY, cursor text, updated_at timestamptz NOT NULL DEFAULT now())`, []);
        ensured = true;
    };
    return {
        async get(source) {
            await ensure();
            const r = await query(`SELECT cursor FROM ${CURSOR_TABLE} WHERE source = $1`, [source]);
            return r.rows[0]?.cursor ?? null;
        },
        async set(source, cursor) {
            if (cursor === null)
                return;
            await ensure();
            await query(`INSERT INTO ${CURSOR_TABLE} (source, cursor) VALUES ($1, $2)
         ON CONFLICT (source) DO UPDATE SET cursor = $2, updated_at = now()`, [source, cursor]);
        },
    };
}
const STRIPE_TYPES = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
];
const WORKOS_EVENTS = [
    "organization.updated",
    "organization.deleted",
    "user.updated",
    "user.deleted",
];
export function createBillingSync(opts) {
    const currency = opts.currency ?? "usd";
    const cursor = opts.cursor ?? queryCursorStore(opts.query);
    async function handleStripe(event) {
        if (event.type.startsWith("customer.subscription.")) {
            const sub = event.data.object;
            const orgId = sub.metadata?.org_id;
            if (!orgId)
                return;
            if (event.type === "customer.subscription.deleted") {
                await opts.adapter.setSubscription(orgId, {
                    plan: null,
                    status: "canceled",
                    subscriptionId: null,
                    periodEnd: null,
                });
                return;
            }
            const priceId = sub.items?.data?.[0]?.price?.id;
            const plan = priceId ? await planForPriceId(priceId) : null;
            await opts.adapter.setSubscription(orgId, {
                plan: plan ?? undefined,
                status: sub.status,
                subscriptionId: sub.id,
                periodEnd: sub.current_period_end
                    ? new Date(sub.current_period_end * 1000).toISOString()
                    : null,
            });
            return;
        }
        if (event.type === "invoice.paid") {
            const invoice = event.data.object;
            if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle")
                return;
            if (!invoice.subscription || !invoice.customer)
                return;
            const sub = await getStripe().subscriptions.retrieve(invoice.subscription);
            const orgId = sub.metadata?.org_id;
            if (!orgId)
                return;
            const priceId = sub.items?.data?.[0]?.price?.id;
            const plan = priceId ? await planForPriceId(priceId) : null;
            if (!plan)
                return; // unknown price → no grant
            const seats = await opts.adapter.memberCount(orgId);
            const tokens = includedTokens(opts.plans, plan, seats);
            if (tokens > 0) {
                await creditTokens(invoice.customer, tokens, `Included tokens: ${plan} (${seats} seat${seats === 1 ? "" : "s"})`, currency);
            }
        }
    }
    async function handleWorkOS(event) {
        const data = event.data;
        if (!data?.id)
            return;
        switch (event.event) {
            case "organization.updated":
                await opts.orgMirror?.syncResource(data.id, data);
                break;
            case "organization.deleted":
                await opts.orgMirror?.remove(data.id);
                break;
            case "user.updated":
                await opts.userMirror?.syncResource(data.id, data);
                break;
            case "user.deleted":
                await opts.userMirror?.remove(data.id);
                await opts.hooks?.onUserDeleted?.(data.id);
                break;
        }
    }
    async function runOnce() {
        const s = await pollStripeEvents({
            after: await cursor.get("stripe"),
            types: STRIPE_TYPES,
            onEvent: handleStripe,
        });
        await cursor.set("stripe", s.cursor);
        const w = await pollWorkOSEvents({
            after: await cursor.get("workos"),
            events: WORKOS_EVENTS,
            onEvent: handleWorkOS,
        });
        await cursor.set("workos", w.cursor);
        return { stripe: s.count, workos: w.count };
    }
    function start(opts = {}) {
        const intervalMs = opts.intervalMs ?? 60_000;
        let running = false;
        let stopped = false;
        const tick = async () => {
            if (running || stopped)
                return; // never overlap
            running = true;
            try {
                await runOnce();
            }
            catch (e) {
                if (opts.onError)
                    opts.onError(e);
                else
                    console.error(`[billing-sync] ${e.message}`);
            }
            finally {
                running = false;
            }
        };
        const handle = setInterval(tick, intervalMs);
        // Don't keep the process alive just for the timer.
        handle.unref?.();
        void tick(); // run once immediately
        return () => {
            stopped = true;
            clearInterval(handle);
        };
    }
    return { runOnce, start };
}
/** Web-standard (Request → Response) handler that runs one sync cycle — for a
 *  serverless cron trigger. Framework-agnostic: mount in a Next route
 *  (`export const GET = createSyncRoute(sync, { secret })`), Hono, Bun, etc.
 *  If `secret` is set, requests must send it as `Authorization: Bearer <secret>`
 *  (or an `x-cron-secret` header). */
export function createSyncRoute(sync, opts = {}) {
    return async (request) => {
        if (opts.secret) {
            const auth = request.headers.get("authorization") ?? request.headers.get("x-cron-secret") ?? "";
            if (auth !== opts.secret && auth !== `Bearer ${opts.secret}`) {
                return new Response(JSON.stringify({ error: "unauthorized" }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                });
            }
        }
        try {
            const result = await sync.runOnce();
            return Response.json({ ok: true, ...result });
        }
        catch (e) {
            return Response.json({ ok: false, error: e.message }, { status: 500 });
        }
    };
}
//# sourceMappingURL=sync.js.map