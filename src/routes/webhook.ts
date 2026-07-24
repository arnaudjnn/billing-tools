import type Stripe from "stripe";
import { getStripe, creditTokens } from "../billing.js";

// Stripe webhook handler. Credits tokens on one-time top-up completion.
// Subscription events are intentionally NOT handled here — subscription/plan
// logic (if any) lives in the host app. Requires the raw request body, so the
// route must be excluded from any body-parsing/session middleware.

export interface WebhookOptions {
  currency?: string;
  /** Called for events this handler doesn't process (e.g. subscription.*). */
  onOtherEvent?: (event: Stripe.Event) => Promise<void> | void;
}

function customerIdOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

export function createStripeWebhookHandler(opts: WebhookOptions = {}) {
  const currency = opts.currency ?? "usd";
  return async (request: Request): Promise<Response> => {
    const body = await request.text();
    const signature = request.headers.get("stripe-signature");
    if (!signature) return Response.json({ error: "Missing signature" }, { status: 400 });

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "payment") {
        const customerId = customerIdOf(session.customer as string | { id: string });
        const tokens = parseInt(session.metadata?.tokens || "0", 10);
        if (customerId && tokens > 0) {
          await creditTokens(customerId, tokens, `Purchase: ${tokens} tokens via Checkout`, currency);
        }
      }
    } else if (opts.onOtherEvent) {
      await opts.onOtherEvent(event);
    }

    return Response.json({ received: true });
  };
}
