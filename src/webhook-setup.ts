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
   * OTHER endpoint ids registered on the same URL. Stripe allows duplicates and
   * delivers to every one of them, so this is usually an accident worth acting
   * on (harmless for credits, which are idempotent, but it doubles delivery
   * volume and makes logs lie). Pass `pruneDuplicates` to remove them.
   */
  duplicates: string[];
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
  /**
   * Replace the event list with exactly `events` instead of adding to it.
   *
   * Off by default, and that default is the important one: an endpoint you
   * didn't create may legitimately carry events another consumer depends on, and
   * silently narrowing it in a deploy script turns their handler into a no-op
   * with nothing in the logs. The union can only ever over-deliver, which costs
   * a discarded event.
   */
  exact?: boolean;
  /** Delete other endpoints registered on the same URL. Destructive. */
  pruneDuplicates?: boolean;
}): Promise<EnsureWebhookResult> {
  const stripe = getStripe();
  const events = opts.events ?? BILLING_WEBHOOK_EVENTS;

  // Stripe has no lookup-by-url, so scan. Accounts have a handful of endpoints;
  // 100 is well past any real count.
  const all = (await stripe.webhookEndpoints.list({ limit: 100 })).data;
  const matches = all.filter((e) => e.url === opts.url);
  const [existing, ...rest] = matches;
  let duplicates = rest.map((e) => e.id);

  if (duplicates.length && opts.pruneDuplicates) {
    for (const id of duplicates) await stripe.webhookEndpoints.del(id);
    duplicates = [];
  }

  if (existing && opts.recreate) {
    await stripe.webhookEndpoints.del(existing.id);
  } else if (existing) {
    const wanted = opts.exact
      ? [...events]
      : [...new Set([...existing.enabled_events, ...events])];
    const same =
      wanted.length === existing.enabled_events.length &&
      wanted.every((e) => existing.enabled_events.includes(e));
    if (!same) {
      await stripe.webhookEndpoints.update(existing.id, {
        enabled_events: wanted as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
      });
    }
    return { id: existing.id, url: existing.url, duplicates, created: false, updated: !same };
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
    duplicates,
    created: true,
    updated: false,
  };
}
