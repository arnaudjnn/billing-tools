import type Stripe from "stripe";
import { getStripe } from "./billing.js";

// Create the Stripe webhook endpoint from code instead of from the Dashboard.
//
// Registering an endpoint is ordinary API surface, so "click through Developers
// → Webhooks on every account and every mode" was never a requirement — just a
// habit. This makes it a deploy step: run it against each environment's secret
// key and the endpoint exists, with the right events, in test and in live.
//
// WHEN YOU NEED IT AT ALL: less often than you'd think. Subscription state,
// invoices and token grants are reconciled by `createBillingSync`, which POLLS
// the Events API on a cursor, and a seat checkout is confirmed synchronously by
// reading the session back. The webhook's only job is crediting a one-time
// top-up the instant it completes — the poller does the same within its interval.
// So: skip it locally, add it in production for the latency.

/** The events this package's handlers actually consume. */
export const BILLING_WEBHOOK_EVENTS = [
  "checkout.session.completed",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

export type EnsureWebhookResult = {
  id: string;
  url: string;
  /**
   * The signing secret for STRIPE_WEBHOOK_SECRET.
   *
   * Present only when this call CREATED the endpoint: Stripe returns it once and
   * never again ("Only returned at creation"). For an endpoint that already
   * exists, keep the secret you stored — or pass `recreate: true` to replace the
   * endpoint and mint a fresh one.
   */
  secret?: string;
  created: boolean;
  /** The event list differed and was updated in place. */
  updated: boolean;
};

/**
 * Idempotently ensure a webhook endpoint for `url`, matched on the URL.
 *
 * Safe to run on every deploy: an existing endpoint is reused, and its event
 * list is corrected only when it has drifted.
 */
export async function ensureWebhookEndpoint(opts: {
  /** Absolute URL of your handler, e.g. https://example.com/api/stripe/webhook */
  url: string;
  /** Defaults to BILLING_WEBHOOK_EVENTS. */
  events?: readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];
  description?: string;
  /** Delete and re-create, to mint a new signing secret. Destructive: the old
   *  secret stops verifying as soon as this runs. */
  recreate?: boolean;
}): Promise<EnsureWebhookResult> {
  const stripe = getStripe();
  const events = opts.events ?? BILLING_WEBHOOK_EVENTS;

  // Stripe has no lookup-by-url, so scan. Accounts have a handful of endpoints;
  // 100 is well past any real count.
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(
    (e) => e.url === opts.url,
  );

  if (existing && opts.recreate) {
    await stripe.webhookEndpoints.del(existing.id);
  } else if (existing) {
    const same =
      existing.enabled_events.length === events.length &&
      events.every((e) => existing.enabled_events.includes(e));
    if (!same) {
      await stripe.webhookEndpoints.update(existing.id, {
        enabled_events: [...events],
      });
    }
    return { id: existing.id, url: existing.url, created: false, updated: !same };
  }

  const created = await stripe.webhookEndpoints.create({
    url: opts.url,
    enabled_events: [...events],
    description: opts.description ?? "Managed by @arnaudjnn/billing-tools",
  });
  return {
    id: created.id,
    url: created.url,
    secret: created.secret,
    created: true,
    updated: false,
  };
}
