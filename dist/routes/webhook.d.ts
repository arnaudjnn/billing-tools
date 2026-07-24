import type Stripe from "stripe";
export interface WebhookOptions {
    currency?: string;
    /** Called for events this handler doesn't process (e.g. subscription.*). */
    onOtherEvent?: (event: Stripe.Event) => Promise<void> | void;
}
export declare function createStripeWebhookHandler(opts?: WebhookOptions): (request: Request) => Promise<Response>;
//# sourceMappingURL=webhook.d.ts.map