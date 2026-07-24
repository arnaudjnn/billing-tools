import { getStripe } from "./billing.js";
const INTERVALS = ["monthly", "yearly"];
const STRIPE_INTERVAL = {
    monthly: "month",
    yearly: "year",
};
const MANAGED_BY = "billing-tools";
export const lookupKeyFor = (plan, interval) => `${plan}_${interval}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** The single managed Stripe product for a plan (reuse across price versions),
 *  discovered via any existing managed price's product. */
async function findPlanProduct(stripe, plan) {
    for (const interval of INTERVALS) {
        const found = await stripe.prices.list({
            lookup_keys: [lookupKeyFor(plan, interval)],
            limit: 1,
            expand: ["data.product"],
        });
        const p = found.data[0];
        if (p)
            return typeof p.product === "string" ? p.product : p.product.id;
    }
    return null;
}
/** Idempotently create/reconcile Stripe products + prices for the paid plans.
 *  Returns the resolved price for every paid plan × interval. Free plans (both
 *  prices 0) create no Stripe objects. Safe to call on every boot / first use. */
export async function ensurePlans(plans, opts = {}) {
    const stripe = getStripe();
    const currency = (opts.currency ?? "usd").toLowerCase();
    const result = [];
    const wanted = new Set();
    for (const [plan, def] of Object.entries(plans)) {
        let productId = await findPlanProduct(stripe, plan);
        for (const interval of INTERVALS) {
            const amount = def.price[interval];
            if (!amount || amount <= 0)
                continue; // free interval — no Stripe price
            const lookupKey = lookupKeyFor(plan, interval);
            wanted.add(lookupKey);
            const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
            const matches = existing &&
                existing.unit_amount === amount &&
                existing.currency === currency &&
                existing.recurring?.interval === STRIPE_INTERVAL[interval];
            if (existing && matches) {
                productId =
                    typeof existing.product === "string" ? existing.product : existing.product.id;
                result.push({ plan, interval, priceId: existing.id, productId, amount, lookupKey });
                continue;
            }
            if (!productId) {
                const product = await stripe.products.create({
                    name: cap(plan),
                    metadata: { managedBy: MANAGED_BY, plan },
                });
                productId = product.id;
            }
            // Create the new price and move the lookup_key onto it (frees it from the
            // old price), then archive the old price. Subscribers on it are untouched.
            const created = await stripe.prices.create({
                product: productId,
                currency,
                unit_amount: amount,
                recurring: { interval: STRIPE_INTERVAL[interval] },
                lookup_key: lookupKey,
                transfer_lookup_key: true,
                metadata: { managedBy: MANAGED_BY, plan, interval },
            });
            if (existing)
                await stripe.prices.update(existing.id, { active: false });
            result.push({ plan, interval, priceId: created.id, productId, amount, lookupKey });
        }
    }
    await archiveOrphans(stripe, wanted);
    return result;
}
/** Archive managed prices whose lookup_key is no longer configured (a plan or
 *  interval you removed), and deactivate now-empty managed products. */
async function archiveOrphans(stripe, wanted) {
    const managedProducts = new Set();
    for await (const price of stripe.prices.list({ active: true, limit: 100 })) {
        if (price.metadata?.managedBy !== MANAGED_BY)
            continue;
        const productId = typeof price.product === "string" ? price.product : price.product.id;
        if (price.lookup_key && wanted.has(price.lookup_key)) {
            managedProducts.add(productId);
            continue;
        }
        await stripe.prices.update(price.id, { active: false });
    }
    // A managed product with no remaining wanted price → archive it.
    for await (const product of stripe.products.list({ active: true, limit: 100 })) {
        if (product.metadata?.managedBy !== MANAGED_BY)
            continue;
        if (!managedProducts.has(product.id)) {
            await stripe.products.update(product.id, { active: false }).catch(() => { });
        }
    }
}
/** Resolve the current Stripe price id for a plan + interval (via lookup_key).
 *  Returns null for a free/absent price. */
export async function planPriceId(plan, interval) {
    const r = await getStripe().prices.list({
        lookup_keys: [lookupKeyFor(plan, interval)],
        active: true,
        limit: 1,
    });
    return r.data[0]?.id ?? null;
}
/** Reverse-map a Stripe price id → plan key (via the price's metadata). */
export async function planForPriceId(priceId) {
    try {
        const price = await getStripe().prices.retrieve(priceId);
        return price.metadata?.plan ?? null;
    }
    catch {
        return null;
    }
}
/** Seat limit for a plan (null = unlimited, undefined plan = null). */
export function seatLimit(plans, plan) {
    return plans[plan]?.seats ?? null;
}
/** Included tokens for `seatCount` members on a plan (per cycle). */
export function includedTokens(plans, plan, seatCount) {
    const def = plans[plan];
    if (!def)
        return 0;
    return def.tokensPerSeat * Math.max(1, seatCount);
}
//# sourceMappingURL=plans.js.map