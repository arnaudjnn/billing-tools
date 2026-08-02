import type Stripe from "stripe";
import { getStripe, grantCredits } from "../billing.js";

// Stripe webhook handler. Grants credits on one-time top-up completion.
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
  let warnedUnconfigured = false;
  return async (request: Request): Promise<Response> => {
    // The webhook is OPTIONAL — createBillingSync polls the same events — so an
    // unset secret is a legitimate state (every local dev), not a bug. Say so
    // instead of feeding `undefined` to constructEvent, which fails as
    // "signature verification failed" and sends the reader hunting for a
    // signature mismatch that doesn't exist.
    //
    // 503, not 200: without the secret this delivery genuinely wasn't processed,
    // and an endpoint registered against an environment that has no secret is a
    // misconfiguration worth seeing in Stripe's dashboard. Nothing is lost while
    // it retries — the poller credits the same event under the same idempotency
    // key regardless.
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          "[billing] STRIPE_WEBHOOK_SECRET is not set — webhook deliveries are " +
            "rejected; the event poller handles these events instead.",
        );
      }
      return Response.json(
        { error: "Webhook not configured (STRIPE_WEBHOOK_SECRET unset); events are polled instead" },
        { status: 503 },
      );
    }

    const body = await request.text();
    const signature = request.headers.get("stripe-signature");
    if (!signature) return Response.json({ error: "Missing signature" }, { status: 400 });

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(body, signature, secret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return Response.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
    }

    // Only a one-time top-up is credited here. A SUBSCRIPTION checkout falls
    // through to onOtherEvent, because fulfilling one is app-specific work
    // (provisioning) that this route can't do — and silently swallowing it, as
    // this did, left the webhook unable to fulfil anything at all.
    const isTopUp =
      event.type === "checkout.session.completed" &&
      (event.data.object as Stripe.Checkout.Session).mode === "payment";

    if (isTopUp) {
      const session = event.data.object as Stripe.Checkout.Session;
      {
        const customerId = customerIdOf(session.customer as string | { id: string });
        const credits = parseInt(session.metadata?.credits || "0", 10);
        if (customerId && credits > 0) {
          // Idempotency key on the session id: a re-delivered webhook credits once.
          await grantCredits(
            customerId,
            credits,
            `Purchase: ${credits} credits via Checkout`,
            currency,
            `credit:checkout:${session.id}`,
          );
        }
      }
    } else if (opts.onOtherEvent) {
      await opts.onOtherEvent(event);
    }

    return Response.json({ received: true });
  };
}
