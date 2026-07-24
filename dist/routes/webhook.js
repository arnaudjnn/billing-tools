import { getStripe, creditTokens } from "../billing.js";
function customerIdOf(v) {
    if (!v)
        return null;
    return typeof v === "string" ? v : v.id;
}
export function createStripeWebhookHandler(opts = {}) {
    const currency = opts.currency ?? "usd";
    return async (request) => {
        const body = await request.text();
        const signature = request.headers.get("stripe-signature");
        if (!signature)
            return Response.json({ error: "Missing signature" }, { status: 400 });
        let event;
        try {
            event = getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return Response.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
        }
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            if (session.mode === "payment") {
                const customerId = customerIdOf(session.customer);
                const tokens = parseInt(session.metadata?.tokens || "0", 10);
                if (customerId && tokens > 0) {
                    // Idempotency key on the session id: a re-delivered webhook credits once.
                    await creditTokens(customerId, tokens, `Purchase: ${tokens} tokens via Checkout`, currency, `credit:checkout:${session.id}`);
                }
            }
        }
        else if (opts.onOtherEvent) {
            await opts.onOtherEvent(event);
        }
        return Response.json({ received: true });
    };
}
//# sourceMappingURL=webhook.js.map