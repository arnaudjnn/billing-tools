import Stripe from "stripe";
// Token model: 1 token = 1 cent. Held in the Stripe customer credit balance,
// where a negative balance = available credit. All functions keyed on a
// stripeCustomerId are pure Stripe math (identical across host apps); the
// customer-id pointer itself is stored by the host via the adapter.
export function getStripe() {
    return new Stripe(process.env.STRIPE_SECRET_KEY);
}
export function stripeConfigured() {
    return !!process.env.STRIPE_SECRET_KEY;
}
function toStripePrice(p) {
    const product = typeof p.product === "object" && p.product && !("deleted" in p.product)
        ? p.product
        : null;
    return {
        id: p.id,
        productId: product?.id ?? (typeof p.product === "string" ? p.product : null),
        productName: product?.name ?? null,
        lookupKey: p.lookup_key ?? null,
        nickname: p.nickname ?? null,
        unitAmount: p.unit_amount,
        currency: p.currency,
        interval: p.recurring?.interval ?? null,
        intervalCount: p.recurring?.interval_count ?? null,
    };
}
/** All active recurring (subscription) prices on the Stripe account. */
export async function listSubscriptionPrices() {
    const res = await getStripe().prices.list({
        active: true,
        type: "recurring",
        limit: 100,
        expand: ["data.product"],
    });
    return res.data.map(toStripePrice);
}
/** Resolve a single subscription price without any env config. Resolution
 *  order: explicit `priceId` → matching `lookupKey` → the sole recurring price.
 *  Returns null if nothing matches or the choice is ambiguous (multiple prices,
 *  no lookupKey) — the caller can then list options via listSubscriptionPrices. */
export async function resolveSubscriptionPrice(opts = {}) {
    const prices = await listSubscriptionPrices();
    if (opts.priceId)
        return prices.find((p) => p.id === opts.priceId) ?? null;
    if (opts.lookupKey) {
        const match = prices.find((p) => p.lookupKey === opts.lookupKey);
        if (match)
            return match;
    }
    return prices.length === 1 ? prices[0] : null;
}
export async function getBillingCustomerId(adapter, orgId) {
    return adapter.getBillingCustomerId(orgId);
}
// Idempotent: return the org's Stripe customer id, creating the customer +
// welcome credit and persisting the pointer via the adapter on first use.
export async function ensureStripeCustomer(adapter, orgId, email, config) {
    const existing = await adapter.getBillingCustomerId(orgId);
    if (existing)
        return existing;
    const stripe = getStripe();
    const customer = await stripe.customers.create({
        email,
        metadata: { org_id: orgId },
    });
    if (config.freeTokens > 0) {
        await stripe.customers.createBalanceTransaction(customer.id, {
            amount: -config.freeTokens,
            currency: config.currency,
            description: `Welcome bonus: ${config.freeTokens} free tokens`,
        });
    }
    await adapter.setBillingCustomerId(orgId, customer.id);
    return customer.id;
}
export async function getTokenBalance(stripeCustomerId) {
    const customer = await getStripe().customers.retrieve(stripeCustomerId);
    if (customer.deleted)
        return 0;
    return -customer.balance; // negative balance = credit
}
export async function deductTokens(stripeCustomerId, toolName, cost, currency) {
    await getStripe().customers.createBalanceTransaction(stripeCustomerId, {
        amount: cost, // positive = debit
        currency,
        description: `Tool call: ${toolName} (${cost} tokens)`,
    });
}
export async function creditTokens(stripeCustomerId, amount, description, currency) {
    await getStripe().customers.createBalanceTransaction(stripeCustomerId, {
        amount: -amount, // negative = credit
        currency,
        description,
    });
}
export async function createTokenCheckoutSession(stripeCustomerId, orgId, amountMajor, config) {
    const amountMinor = Math.round(amountMajor * 100);
    const tokens = amountMinor; // 1 token = 1 minor unit
    const session = await getStripe().checkout.sessions.create({
        customer: stripeCustomerId,
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
            {
                price_data: {
                    currency: config.currency,
                    product_data: {
                        name: `${tokens} tokens`,
                        description: `${amountMajor} = ${tokens} tokens`,
                    },
                    unit_amount: amountMinor,
                },
                quantity: 1,
            },
        ],
        invoice_creation: { enabled: true },
        payment_intent_data: {
            setup_future_usage: "off_session",
            metadata: { org_id: orgId, tokens: String(tokens) },
        },
        metadata: { org_id: orgId, tokens: String(tokens) },
        success_url: `${config.baseUrl}/billing/success?tokens=${tokens}`,
        cancel_url: `${config.baseUrl}/billing/cancel`,
    });
    return session.url;
}
export async function getAutoReloadSettings(stripeCustomerId) {
    const customer = await getStripe().customers.retrieve(stripeCustomerId);
    if (customer.deleted)
        return null;
    const meta = customer.metadata;
    if (meta.auto_reload_enabled !== "true")
        return null;
    return {
        enabled: true,
        threshold: parseInt(meta.auto_reload_threshold || "0", 10),
        reload_to: parseInt(meta.auto_reload_to || "0", 10),
    };
}
export async function setAutoReloadSettings(stripeCustomerId, threshold, reloadTo, enabled) {
    await getStripe().customers.update(stripeCustomerId, {
        metadata: {
            auto_reload_enabled: String(enabled),
            auto_reload_threshold: String(threshold),
            auto_reload_to: String(reloadTo),
        },
    });
}
export async function tryAutoReload(stripeCustomerId, currency) {
    const settings = await getAutoReloadSettings(stripeCustomerId);
    if (!settings || !settings.enabled)
        return;
    const balance = await getTokenBalance(stripeCustomerId);
    if (balance > settings.threshold)
        return;
    const tokensNeeded = settings.reload_to - balance;
    if (tokensNeeded <= 0)
        return;
    const stripe = getStripe();
    const pms = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: "card",
        limit: 1,
    });
    if (pms.data.length === 0)
        return;
    try {
        const pi = await stripe.paymentIntents.create({
            amount: tokensNeeded,
            currency,
            customer: stripeCustomerId,
            payment_method: pms.data[0].id,
            off_session: true,
            confirm: true,
            description: `Auto-reload: ${tokensNeeded} tokens`,
            metadata: { auto_reload: "true", tokens: String(tokensNeeded) },
        });
        if (pi.status === "succeeded") {
            await creditTokens(stripeCustomerId, tokensNeeded, `Auto-reload: ${tokensNeeded} tokens`, currency);
        }
    }
    catch {
        // card declined / off-session failure — never block the triggering call
    }
}
export async function listInvoices(stripeCustomerId, limit = 10) {
    const stripe = getStripe();
    const [invoices, charges] = await Promise.all([
        stripe.invoices.list({ customer: stripeCustomerId, limit }),
        stripe.charges.list({ customer: stripeCustomerId, limit }),
    ]);
    const invoiceEntries = invoices.data.map((inv) => ({
        id: inv.id,
        type: "purchase",
        number: inv.number,
        amount: inv.amount_paid,
        status: inv.status,
        created: new Date(inv.created * 1000).toISOString(),
        invoice_url: inv.hosted_invoice_url ?? null,
        invoice_pdf: inv.invoice_pdf ?? null,
    }));
    const autoReloadCharges = charges.data
        .filter((ch) => ch.metadata?.auto_reload === "true" && ch.status === "succeeded")
        .map((ch) => ({
        id: ch.id,
        type: "auto_reload",
        number: null,
        amount: ch.amount,
        status: ch.status,
        created: new Date(ch.created * 1000).toISOString(),
        invoice_url: ch.receipt_url ?? null,
        invoice_pdf: null,
    }));
    return [...invoiceEntries, ...autoReloadCharges]
        .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
        .slice(0, limit);
}
//# sourceMappingURL=billing.js.map