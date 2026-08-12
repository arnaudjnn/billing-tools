import type Stripe from "stripe";
import { ensureStripeCustomer, getBillingCustomerId, getStripe } from "./billing.js";
import { createCheckoutSession } from "./checkout.js";
import {
  defaultBasket,
  normalizePlans,
  planModel,
  resolvePlanPrices,
  validateBasket,
  describeBasketProblem,
  lookupKeyFor,
  type BillingInterval,
  type PlanCatalog,
  type PlanModel,
  type Quantities,
} from "./plans.js";
import type { BillingAdapter, ResolvedConfig } from "./types.js";

// The subscription LIFECYCLE: moving an org between plans, and off them.
//
// One entry point, deliberately. Before this, every plan or seat change opened a
// fresh Checkout Session and created a SECOND subscription against the same
// customer — the first was never cancelled, so the customer was billed twice and
// the app's own pointer named only one of them. Nothing downstream noticed.
// `changePlan` cannot do that: it looks the live subscription up in STRIPE (not in
// the app's metadata, which is exactly what can be wrong), updates it, and refuses
// rather than guessing if it finds two.
//
// It is separate from checkout.ts because that file is about creating something
// payable. `updateSubscription` there re-prices a still-INCOMPLETE checkout
// subscription: its `proration_behavior: "none"` and `payment_behavior:
// "default_incomplete"` are right for that job and wrong for every job here —
// `default_incomplete` on a LIVE subscription is how a paying customer ends up in
// `incomplete`.

export type PlanChangeTiming = "auto" | "now" | "period_end";
export type ProrationPolicy = "next_invoice" | "invoice_now" | "none";

export type PlanChangeKind =
  /** No live subscription: a Checkout Session was opened instead. */
  | "checkout"
  /** Applied immediately. */
  | "updated"
  /**
   * Sent, but NOT in force: the invoice it raised has not been paid, so Stripe is holding
   * the change as a pending update (~23h, then it is dropped). The customer is still on
   * `plan`. Only `proration: "invoice_now"` can produce this.
   */
  | "pending"
  /** Takes effect at the end of the paid period. */
  | "scheduled"
  /** Ends at the end of the paid period (a downgrade to a free plan is this). */
  | "canceling"
  /** A pending cancellation was called off. */
  | "resumed"
  /** Already where it was asked to be. */
  | "noop";

export interface PlanChangeResult {
  kind: PlanChangeKind;
  customerId: string | null;
  subscriptionId: string | null;
  /** The plan in force NOW (unchanged for `scheduled` / `canceling`). */
  plan: string | null;
  status: string | null;
  /** ISO, for `scheduled` / `canceling` — when it takes effect. */
  effectiveAt: string | null;
  /** `checkout` only: mount these with BillingCheckoutSessionProvider. */
  sessionId?: string;
  clientSecret?: string | null;
  /** `checkout` under `uiMode: "hosted"` — the page to send a customer to, and the
   *  only usable answer for a caller that has no browser. */
  checkoutUrl?: string | null;
  /** `pending` only: when Stripe drops the held change if the invoice is still unpaid. */
  pendingUntil?: string | null;
  /** `pending` only: the unpaid invoice. Settling it is what applies the change. */
  invoiceId?: string | null;
}

export type PlanChangeErrorCode =
  | "multiple_subscriptions"
  | "unknown_plan"
  | "not_purchasable"
  | "invalid_basket"
  | "needs_return_url"
  | "no_customer";

export class PlanChangeError extends Error {
  constructor(
    readonly code: PlanChangeErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PlanChangeError";
  }
}

/** Statuses that are still being billed, so still worth changing. A canceled or
 *  incomplete_expired subscription will never be invoiced again. */
const LIVE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
]);

/**
 * The subscription period, read off the ITEMS.
 *
 * `current_period_start/_end` moved off `Subscription` onto `SubscriptionItem` in
 * the API version this SDK pins, so reading them from the subscription yields
 * `undefined` — and this is the date a "cancels on …" or "changes on …" line has
 * to show. Widest window, since items can differ.
 */
function periodEndOf(sub: Stripe.Subscription): string | null {
  type Periodic = { current_period_end?: number };
  const ends = ((sub.items?.data ?? []) as unknown as Periodic[])
    .map((i) => i.current_period_end)
    .filter((v): v is number => !!v);
  return ends.length ? new Date(Math.max(...ends) * 1000).toISOString() : null;
}

// `planRank` / `planActions` are pure catalogue arithmetic and now live in `ladder.ts`
// beside the seat rungs, so a pricing page can order plans without importing Stripe.
// Re-exported here because this is where every consumer has always imported them from.
export { planActions, planRank, type PlanActions } from "./ladder.js";
import { planRank } from "./ladder.js";

async function liveSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
  const out: Stripe.Subscription[] = [];
  for await (const sub of getStripe().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  })) {
    if (LIVE_STATUSES.has(sub.status)) out.push(sub);
  }
  return out;
}

/**
 * Move an org to `to.plan` — up, down, or off.
 *
 * The decision tree, which is why this is one function and not three:
 *
 *   no live subscription, paid target   → open a Checkout Session
 *   live subscription, FREE target      → cancel at period end
 *   live subscription, same plan, pending cancel → resume
 *   live subscription, paid target      → update the items; upgrades apply now,
 *                                         downgrades at the period end
 *
 * Proration defaults to `next_invoice` (`create_prorations`): nothing is charged
 * today and the difference rides the next invoice. That is the safe default — no
 * charge today means no SCA challenge, no pending update that expires in ~23h, and
 * a mistake shows up as a wrong line on the next invoice rather than a wrong
 * charge now.
 */
/**
 * The Stripe prices a basket resolves to, as `priceId → quantity`.
 *
 * Shared by the change and its preview, deliberately: the number quoted to a
 * customer and the number charged to them must come from the same arithmetic, or
 * the quote is a guess that happens to be right most of the time.
 */
async function desiredPrices(
  plans: PlanCatalog,
  target: PlanModel,
  interval: BillingInterval,
  seats: Quantities,
  currency?: string,
): Promise<Map<string, number>> {
  const prices = await resolvePlanPrices(plans, { currency });
  const desired = new Map<string, number>();
  const idFor = (key: string) => {
    const id = prices.get(key);
    if (!id) throw new PlanChangeError("invalid_basket", `No Stripe price for ${key}`);
    return id;
  };
  if (target.sells.kind === "flat") {
    desired.set(idFor(lookupKeyFor(target.key, interval)), 1);
  } else {
    for (const [seatType, qty] of Object.entries(seats)) {
      if (qty <= 0) continue;
      desired.set(idFor(lookupKeyFor(target.key, interval, seatType)), qty);
    }
  }
  return desired;
}

/**
 * Send the change, and survive the customer clicking Confirm twice.
 *
 * An idempotency key deduplicates a repeat, but only a SEQUENTIAL one: two requests carrying
 * the same key at the same moment make Stripe reject the second outright — "There is
 * currently another in-progress request using this Idempotent Key". Measured, from two
 * concurrent `changePlan` calls, which is precisely what a double-clicked button sends.
 *
 * Rejecting it would be defensible if the caller saw something actionable, but they saw that
 * sentence. So the loser waits and re-sends: by then the winner has finished and the same key
 * REPLAYS its stored response, so both callers get the one real outcome. Bounded, because an
 * in-progress request that never finishes must surface rather than hang.
 */
async function sendChange(
  subscriptionId: string,
  params: Stripe.SubscriptionUpdateParams,
  idempotencyKey: string,
  // Generous, because the twin is creating and PAYING an invoice: a stingy budget turns a
  // recoverable double-click back into the raw error it exists to hide.
  { tries = 6, delayMs = 900 } = {},
): Promise<Stripe.Subscription> {
  const stripe = getStripe();
  for (let attempt = 0; ; attempt++) {
    try {
      return await stripe.subscriptions.update(subscriptionId, params, { idempotencyKey });
    } catch (e) {
      // Matched on the MESSAGE, which is the exception to this package's prefer-typed-errors
      // rule and is measured rather than assumed: an `instanceof
      // Stripe.errors.StripeIdempotencyError` guard here did NOT fire on the real rejection,
      // so the SDK does not classify this one the way its name suggests. The message is also
      // the only thing that separates "the twin is still running" (retryable) from "this key
      // was used with different params" (a caller bug, where retrying would just burn the
      // attempts and hide it).
      const inFlight = /another in-progress request using this Idempotent Key/i.test(
        e instanceof Error ? e.message : String(e),
      );
      if (!inFlight || attempt >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

/**
 * A stable, compact fingerprint of the item mutations a plan change will send.
 *
 * It covers the SUBSCRIPTION ITEM ids, not just prices, which is the part that is easy to
 * get wrong: upgrade → downgrade → upgrade back returns to the same prices and quantities,
 * so a key built from those alone repeats — while the request does not, because a released
 * schedule replaces the items and the diff now deletes a different `si_…`. Stripe answers a
 * reused key whose params changed with a 400 naming a key the caller has never seen.
 *
 * Compact because Stripe caps a key at 255 characters and a full id per line overruns that
 * on a wide basket. An id's tail is its random part, so it identifies the object alone.
 */
function itemFingerprint(items: Stripe.SubscriptionUpdateParams.Item[], carried: string[]): string {
  const tail = (v: unknown) => String(v ?? "").slice(-8);
  const parts = items
    .map((i) =>
      i.id
        ? `${tail(i.id)}${i.deleted ? "-" : `x${i.quantity ?? 1}`}`
        : `+${tail(i.price)}x${i.quantity ?? 1}`,
    )
    .sort();
  // The rates ride the same request, so a tax change with an identical basket is a
  // different request too.
  return [...parts, ...carried.map(tail).sort()].join(",");
}

/** The item mutations that turn `sub` into `desired`, plus the tax rates that
 *  must ride along. Also shared between the change and its preview. */
function diffItems(
  sub: Stripe.Subscription,
  desired: Map<string, number>,
  taxRates?: string[],
): { items: Stripe.SubscriptionUpdateParams.Item[]; carried: string[] } {
  // Tax rates already on the subscription carry onto ADDED lines. Without this, an
  // account that computes its own tax (manual TaxRates rather than Stripe Tax)
  // invoices a newly added line at 0%.
  //
  // BOTH places have to be read. Checkout writes the rates per LINE ITEM, but a
  // subscription schedule can only carry them at the SUBSCRIPTION level
  // (`default_tax_rates` — the phases this file writes, and `createSubscriptionSchedule`).
  // So once a scheduled downgrade released, the items held no rates and the next upgrade's
  // added line went out at 0% — the very bug the paragraph above is about, reappearing on
  // any subscription that had ever been through a schedule.
  const carried =
    taxRates ??
    [
      ...new Set([
        ...sub.items.data.flatMap((i) => (i.tax_rates ?? []).map((r) => r.id)),
        ...(sub.default_tax_rates ?? []).map((r) => (typeof r === "string" ? r : r.id)),
      ]),
    ];

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  const seen = new Set<string>();
  for (const item of sub.items.data) {
    const want = desired.get(item.price.id);
    if (want != null) {
      seen.add(item.price.id);
      if ((item.quantity ?? 1) !== want) items.push({ id: item.id, quantity: want });
    } else {
      items.push({ id: item.id, deleted: true });
    }
  }
  for (const [priceId, quantity] of desired) {
    if (!seen.has(priceId)) {
      items.push({ price: priceId, quantity, ...(carried.length ? { tax_rates: carried } : {}) });
    }
  }
  return { items, carried };
}

export async function changePlan(
  adapter: BillingAdapter,
  orgId: string,
  opts: {
    plans: PlanCatalog;
    to: { plan: string; interval?: BillingInterval; seats?: Quantities };
    config?: ResolvedConfig;
    currency?: string;
    timing?: PlanChangeTiming;
    proration?: ProrationPolicy;
    /**
     * Manual TaxRate ids. Defaults to the rates already on the subscription's
     * items — which is what stops a newly ADDED seat line being invoiced at 0%
     * tax on an account that computes tax itself rather than with Stripe Tax.
     */
    taxRates?: string[];
    /** Required for the no-subscription case, which opens a Checkout Session. */
    returnUrl?: string;
    /** `"hosted"` makes that session a URL rather than a client secret — what a
     *  caller with no browser needs. See `createCheckoutSession`. */
    uiMode?: "elements" | "hosted";
    email?: string;
    metadata?: Record<string, string>;
    /** Disambiguates when a customer somehow has more than one live subscription.
     *  Without it that case throws rather than guessing which one to change. */
    subscriptionId?: string;
    /** Write the outcome through the adapter as well as letting the sync engine
     *  mirror it, so the next render is already correct. Default true. */
    record?: boolean;
  },
): Promise<PlanChangeResult> {
  const stripe = getStripe();
  const target = planModel(opts.plans, opts.to.plan);
  if (!target) throw new PlanChangeError("unknown_plan", `Unknown plan "${opts.to.plan}"`);

  const interval = opts.to.interval ?? (target.intervals.includes("monthly") ? "monthly" : "yearly");
  const targetIsFree = target.sells.kind === "nothing" || target.sale === "free";
  const record = opts.record ?? true;

  let customerId = await getBillingCustomerId(adapter, orgId);
  if (!customerId && !targetIsFree) {
    if (!opts.config) throw new PlanChangeError("no_customer", "No Stripe customer, and no config to create one with");
    customerId = await ensureStripeCustomer(adapter, orgId, opts.email, opts.config);
  }
  if (!customerId) {
    // Nothing was ever billed and nothing is being asked for.
    if (record) await adapter.setSubscription?.(orgId, { plan: target.key, status: null, subscriptionId: null, periodEnd: null });
    return { kind: "noop", customerId: null, subscriptionId: null, plan: target.key, status: null, effectiveAt: null };
  }

  const live = await liveSubscriptions(customerId);
  const sub =
    opts.subscriptionId
      ? live.find((s) => s.id === opts.subscriptionId)
      : live.length > 1
        ? undefined
        : live[0];
  if (!sub && live.length > 1) {
    throw new PlanChangeError(
      "multiple_subscriptions",
      `Customer ${customerId} has ${live.length} live subscriptions; pass subscriptionId to say which one to change`,
      live.map((s) => s.id),
    );
  }

  // ── No live subscription: open a checkout ─────────────────────────────────
  if (!sub) {
    if (targetIsFree) {
      if (record) {
        await adapter.setSubscription?.(orgId, { plan: target.key, status: null, subscriptionId: null, periodEnd: null });
      }
      return { kind: "noop", customerId, subscriptionId: null, plan: target.key, status: null, effectiveAt: null };
    }
    const problems = validateBasket(opts.plans, { plan: target.key, interval, seats: opts.to.seats });
    if (problems.length) {
      throw new PlanChangeError(
        "invalid_basket",
        // The deployment's own words, like every other string the library emits.
        problems.map((problem) => describeBasketProblem(problem, opts.config?.messages)).join("; "),
        problems,
      );
    }
    if (!opts.returnUrl) {
      throw new PlanChangeError("needs_return_url", "No live subscription, so a Checkout Session is needed — pass returnUrl");
    }
    const session = await createCheckoutSession({
      plans: opts.plans,
      plan: target.key,
      interval,
      seats: opts.to.seats ?? defaultBasket(target),
      returnUrl: opts.returnUrl,
      uiMode: opts.uiMode,
      customerId,
      // The deployment's tax declaration. Without it this session resolved tax as
      // if none had been made — and this is the FIRST purchase, so there are no
      // subscription items to inherit rates from either.
      config: opts.config,
      currency: opts.currency,
      taxRates: opts.taxRates,
      reuse: true,
      // `org_id`, the key every sync handler reads. Without it the subscription
      // this session creates is invisible to plan mirroring and to grants.
      metadata: { ...opts.metadata, org_id: orgId, plan: target.key },
    });
    return {
      kind: "checkout",
      customerId,
      subscriptionId: null,
      plan: null,
      status: null,
      effectiveAt: null,
      sessionId: session.sessionId,
      clientSecret: session.clientSecret,
      checkoutUrl: session.url,
    };
  }

  const effectiveAt = periodEndOf(sub);
  const currentPlanKey = sub.metadata?.plan ?? null;

  // ── A pending cancellation being called off ───────────────────────────────
  if (sub.cancel_at_period_end && currentPlanKey && currentPlanKey === target.key) {
    const resumed = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    if (record) {
      await adapter.setSubscription?.(orgId, {
        plan: target.key,
        status: resumed.status,
        subscriptionId: resumed.id,
        periodEnd: periodEndOf(resumed),
      });
      // The cancelling branch filed `pendingPlan` so a UI could say what was
      // scheduled; calling the cancellation off has to UNFILE it, or every
      // surface keeps reporting "In disdetta" for a subscription Stripe says is
      // healthy — measured in a browser: cancel → resume left the plan card
      // stuck on the scheduled move with nothing left to schedule.
      await adapter.setOrgMetadata?.(orgId, { pendingPlan: null, pendingPlanAt: null });
    }
    return { kind: "resumed", customerId, subscriptionId: sub.id, plan: target.key, status: resumed.status, effectiveAt: periodEndOf(resumed) };
  }

  // ── Down to a free plan: cancel at the end of the paid period ─────────────
  //
  // The cheap primitive, not a schedule: it is one field, reversible with
  // `false`, and the customer keeps what they paid for until it runs out.
  if (targetIsFree) {
    if (sub.cancel_at_period_end) {
      return { kind: "canceling", customerId, subscriptionId: sub.id, plan: currentPlanKey, status: sub.status, effectiveAt };
    }
    // A schedule OWNS the cancellation behaviour: while one is attached, Stripe refuses
    // `cancel_at_period_end` outright ("updating any cancelation behavior directly is not
    // allowed"). So a customer who had scheduled a downgrade could not cancel at all — the
    // one sequence a downgrade makes likely. Releasing detaches the schedule and leaves the
    // subscription exactly as it is, and abandoning a scheduled downgrade is right here:
    // they are cancelling, so the tier they would have moved to is moot.
    if (sub.schedule) {
      await stripe.subscriptionSchedules.release(
        typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id,
      );
    }
    const canceling = await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
      metadata: { ...sub.metadata, org_id: orgId, pending_plan: target.key },
    });
    if (record) {
      // The plan in force does NOT change yet — writing the downgraded plan now
      // would remove the customer's access a month before they stop paying.
      await adapter.setOrgMetadata?.(orgId, {
        pendingPlan: target.key,
        pendingPlanAt: periodEndOf(canceling),
      });
    }
    return {
      kind: "canceling",
      customerId,
      subscriptionId: sub.id,
      plan: currentPlanKey,
      status: canceling.status,
      effectiveAt: periodEndOf(canceling),
    };
  }

  // ── A paid target: diff the items ─────────────────────────────────────────
  const seats = opts.to.seats ?? defaultBasket(target);
  const problems = validateBasket(opts.plans, { plan: target.key, interval, seats });
  if (problems.length) {
    throw new PlanChangeError("invalid_basket", problems.map((problem) => describeBasketProblem(problem)).join("; "), problems);
  }

  const desired = await desiredPrices(opts.plans, target, interval, seats, opts.currency);
  const { items, carried } = diffItems(sub, desired, opts.taxRates);

  if (items.length === 0) {
    // Asking for the plan already in force is "STAY here". A schedule still
    // attached is a move away from it being called off — same act as resuming
    // a pending cancellation above, reached when the scheduled target was a
    // paid tier rather than free.
    if (sub.schedule) {
      await stripe.subscriptionSchedules.release(
        typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id,
      );
      if (record) {
        await adapter.setOrgMetadata?.(orgId, { pendingPlan: null, pendingPlanAt: null });
      }
      return { kind: "resumed", customerId, subscriptionId: sub.id, plan: currentPlanKey ?? target.key, status: sub.status, effectiveAt };
    }
    // Nothing to release — but a pendingPlan record contradicting a healthy
    // subscription has NOTHING else to clear it on this path: the resume branch
    // needs cancel_at_period_end and the updated branch needs a real diff, so a
    // record left behind (the resume bug this fixes shipped one) was permanent.
    if (record) {
      await adapter.setOrgMetadata?.(orgId, { pendingPlan: null, pendingPlanAt: null });
    }
    return { kind: "noop", customerId, subscriptionId: sub.id, plan: currentPlanKey ?? target.key, status: sub.status, effectiveAt };
  }

  const proration = opts.proration ?? "next_invoice";
  const proration_behavior: Stripe.SubscriptionUpdateParams.ProrationBehavior =
    proration === "invoice_now" ? "always_invoice" : proration === "none" ? "none" : "create_prorations";

  // Direction decides the default timing: pay more now, pay less at the boundary.
  const currentModel = currentPlanKey ? planModel(opts.plans, currentPlanKey) : null;
  const isDowngrade = currentModel ? planRank(target) < planRank(currentModel) : false;
  const timing = opts.timing ?? "auto";
  const applyAtPeriodEnd = timing === "period_end" || (timing === "auto" && isDowngrade);

  if (applyAtPeriodEnd) {
    // A schedule, because a downgrade must not take effect before the paid period
    // it replaces has run out.
    const schedule = sub.schedule
      ? await stripe.subscriptionSchedules.retrieve(sub.schedule as string)
      : await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    const currentPhase = schedule.phases[schedule.phases.length - 1];
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          items: currentPhase.items.map((i) => ({
            price: typeof i.price === "string" ? i.price : i.price.id,
            quantity: i.quantity ?? 1,
          })),
          start_date: currentPhase.start_date,
          end_date: currentPhase.end_date,
          ...(carried.length ? { default_tax_rates: carried } : {}),
        },
        {
          items: [...desired].map(([price, quantity]) => ({ price, quantity })),
          ...(carried.length ? { default_tax_rates: carried } : {}),
        },
      ],
    });
    if (record) {
      await adapter.setOrgMetadata?.(orgId, { pendingPlan: target.key, pendingPlanAt: effectiveAt });
    }
    return { kind: "scheduled", customerId, subscriptionId: sub.id, plan: currentPlanKey, status: sub.status, effectiveAt };
  }

  // An IMMEDIATE change has to release any schedule first, or the schedule wins later.
  //
  // A pending phase replaces the subscription's items when it starts, so a customer who
  // downgraded, changed their mind and PAID to go back up was silently dropped to the lower
  // tier at the period end — the upgrade they bought lasted until the boundary and then
  // evaporated, with no invoice or event naming the cause. (Stripe also cancels a pending
  // update on a phase transition, so the same schedule could void an unpaid upgrade.)
  //
  // Releasing is right rather than rewriting the phase: they have just told us where they
  // want to be, so the plan they abandoned is no longer a plan. The scheduled-downgrade path
  // above keeps its schedule; only this branch, which applies now, drops it.
  if (sub.schedule) {
    await stripe.subscriptionSchedules.release(
      typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id,
    );
    if (record) {
      await adapter.setOrgMetadata?.(orgId, { pendingPlan: null, pendingPlanAt: null });
    }
  }

  // `pending_if_incomplete` supports ONLY the params that control proration or generate an
  // invoice — no tax parameter of any kind, neither `items[].tax_rates` nor
  // `default_tax_rates` — and Stripe hard-400s rather than ignoring one. So an account
  // computing its own tax (the default) could not run an `invoice_now` upgrade at all: the
  // added line always carries a rate. Measured, not inferred; both spellings were refused.
  //
  // Tax is a CONFIGURATION change though, which Stripe applies immediately and which
  // generates no invoice, so it moves OUT of the gated update: set the subscription's
  // `default_tax_rates` first and the line added below inherits them. The alternative —
  // dropping `pending_if_incomplete` — would silently give up the thing it is there for,
  // which is applying the upgrade only once its invoice is actually paid.
  const pending = proration === "invoice_now";
  if (pending && carried.length) {
    const already = new Set(
      (sub.default_tax_rates ?? []).map((r) => (typeof r === "string" ? r : r.id)),
    );
    if (carried.some((id) => !already.has(id))) {
      await stripe.subscriptions.update(sub.id, { default_tax_rates: carried });
    }
  }

  const updated = await sendChange(
    sub.id,
    {
      // Stripped for the same reason, on the same path.
      items: pending ? items.map(({ tax_rates: _tax, ...rest }) => rest) : items,
      proration_behavior,
      // The live-subscription equivalent of `default_incomplete`: the change
      // applies only once the invoice it generates is paid, and the original
      // subscription is untouched if it never is.
      ...(pending ? { payment_behavior: "pending_if_incomplete" as const } : {}),
      metadata: { ...sub.metadata, org_id: orgId, plan: target.key },
    },
    // Keyed on the target, so a double-clicked Confirm inside Stripe's 24h window
    // is a no-op rather than a second proration invoice.
    //
    // The MUTATION is in the key, not just the target — see `itemFingerprint`. A genuine
    // double-click sends the identical diff, so it still dedupes.
    ["plan", sub.id, target.key, interval, itemFingerprint(items, carried), timing, proration].join(":"),
  );

  // The payment FAILED and Stripe is holding the change — measured: `status: "active"`,
  // `pending_update` set, items untouched, an open invoice. It returned `kind: "updated"` and
  // recorded the NEW plan on the org, so the app's own mirror granted a tier the customer had
  // not paid for: the meter resolved it, its pool applied, and if the invoice was never paid
  // the pending update expired in ~23h and the entitlement silently vanished with no event
  // naming why. Reporting an unapplied change as applied is the failure mode, not the decline.
  if (updated.pending_update) {
    const expiresAt = updated.pending_update.expires_at;
    if (record) {
      // The plan in force does NOT change. Filed as pending, exactly like a scheduled
      // downgrade, so a UI can say "waiting for payment" instead of showing the wrong tier.
      await adapter.setOrgMetadata?.(orgId, {
        pendingPlan: target.key,
        pendingPlanAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      });
    }
    return {
      kind: "pending",
      customerId,
      subscriptionId: updated.id,
      plan: currentPlanKey,
      status: updated.status,
      effectiveAt: null,
      pendingUntil: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      // The caller needs this to let the customer pay: settling it applies the change.
      invoiceId: typeof updated.latest_invoice === "string" ? updated.latest_invoice : (updated.latest_invoice?.id ?? null),
    };
  }

  if (record) {
    await adapter.setSubscription?.(orgId, {
      plan: target.key,
      status: updated.status,
      subscriptionId: updated.id,
      periodEnd: periodEndOf(updated),
    });
    await adapter.setOrgMetadata?.(orgId, { pendingPlan: null, pendingPlanAt: null });
  }
  return {
    kind: "updated",
    customerId,
    subscriptionId: updated.id,
    plan: target.key,
    status: updated.status,
    effectiveAt: periodEndOf(updated),
  };
}

/** What a plan change would cost, before committing to it. */
export interface PlanChangePreview {
  /** What `changePlan` would do with these same arguments. */
  kind: "immediate" | "scheduled" | "checkout" | "canceling" | "noop";
  currency: string;
  /**
   * Charged NOW, in minor units.
   *
   * Only `proration: "invoice_now"` charges anything today; the default
   * (`next_invoice`) defers the prorated difference to the next invoice, and a
   * period-end change charges nothing at all. Getting this wrong is not a
   * rounding error — quoting the upcoming invoice as if it were due immediately
   * told a customer €197.64 for an upgrade that charged €87.84.
   */
  dueNow: number;
  /** What the NEXT invoice comes to — including any deferred proration. */
  nextInvoiceTotal: number;
  /** The steady-state amount per period once the change has settled. */
  recurringTotal: number;
  /** The credit for the unused remainder of the current plan, positive. */
  credit: number;
  /** When the change takes effect — now, or the period end for a scheduled one. */
  effectiveAt: string | null;
  /**
   * When `nextInvoiceTotal` will actually be charged.
   *
   * Deferring the proration is the kinder default (no payment today, so no SCA
   * challenge and no upgrade that silently fails to apply), but it produces the
   * classic surprise: measured on a mid-month €18 → €90 upgrade, the next
   * invoice is €127.16, not €90. A surface that shows the figure AND the date
   * turns that from a surprise into a quote, which is the whole reason this
   * field exists.
   */
  nextInvoiceAt: string | null;
  /** The proration lines Stripe would write, for an itemised summary. */
  lines: Array<{ description: string; amount: number; proration: boolean }>;
}

/**
 * Quote a plan change without making it.
 *
 * The number here is the number `changePlan` charges, because both build the
 * basket with `desiredPrices` and the mutation with `diffItems` — a preview that
 * recomputed the diff its own way would agree until the day it didn't, and the
 * day it didn't would be a customer disputing a charge.
 *
 * A scheduled (downgrade) change quotes `dueNow: 0` and the new recurring total,
 * which is what actually happens: the customer keeps what they paid for until it
 * runs out, and Stripe issues no refund.
 */
export async function previewPlanChange(
  adapter: BillingAdapter,
  orgId: string,
  opts: {
    plans: PlanCatalog;
    to: { plan: string; interval?: BillingInterval; seats?: Quantities };
    currency?: string;
    timing?: PlanChangeTiming;
    /** Must match what you will pass to `changePlan` — it decides whether the
     *  prorated difference is billed today or deferred to the next invoice. */
    proration?: ProrationPolicy;
    taxRates?: string[];
    subscriptionId?: string;
  },
): Promise<PlanChangePreview> {
  const stripe = getStripe();
  const target = planModel(opts.plans, opts.to.plan);
  if (!target) throw new PlanChangeError("unknown_plan", `Unknown plan "${opts.to.plan}"`);

  const interval = opts.to.interval ?? (target.intervals.includes("monthly") ? "monthly" : "yearly");
  const currency = opts.currency ?? "usd";
  const empty = (kind: PlanChangePreview["kind"], effectiveAt: string | null = null): PlanChangePreview => ({
    kind,
    currency,
    dueNow: 0,
    nextInvoiceTotal: 0,
    recurringTotal: 0,
    credit: 0,
    effectiveAt,
    nextInvoiceAt: null,
    lines: [],
  });

  const customerId = await getBillingCustomerId(adapter, orgId);
  if (!customerId) return empty("checkout");

  const live = await liveSubscriptions(customerId);
  const sub = opts.subscriptionId ? live.find((s) => s.id === opts.subscriptionId) : live.length > 1 ? undefined : live[0];
  if (!sub && live.length > 1) {
    throw new PlanChangeError(
      "multiple_subscriptions",
      `Customer ${customerId} has ${live.length} live subscriptions; pass subscriptionId to say which one to preview`,
      live.map((s) => s.id),
    );
  }
  // Nothing to prorate against: this is a first purchase, quoted by Checkout.
  if (!sub) return empty("checkout");

  const targetIsFree = target.sells.kind === "nothing" || target.sale === "free";
  if (targetIsFree) return empty("canceling", periodEndOf(sub));

  const seats = opts.to.seats ?? defaultBasket(target);
  const problems = validateBasket(opts.plans, { plan: target.key, interval, seats });
  if (problems.length) {
    throw new PlanChangeError("invalid_basket", problems.map((p) => describeBasketProblem(p)).join("; "), problems);
  }

  const desired = await desiredPrices(opts.plans, target, interval, seats, opts.currency);
  const { items } = diffItems(sub, desired, opts.taxRates);
  if (items.length === 0) return empty("noop", periodEndOf(sub));

  const currentPlanKey = sub.metadata?.plan ?? null;
  const currentModel = currentPlanKey ? planModel(opts.plans, currentPlanKey) : null;
  const isDowngrade = currentModel ? planRank(target) < planRank(currentModel) : false;
  const timing = opts.timing ?? "auto";
  // Both previews, always: the recurring one is the ONLY exact way to separate
  // the prorated difference from the next period's regular charge. Stripe's
  // preview returns the whole upcoming invoice, so reading `amount_due` as "due
  // now" quoted €197.64 for an upgrade that charged €87.84 — the recurring line
  // counted twice. Differencing the two is Stripe's own arithmetic on both sides.
  const [recurring, prorated] = await Promise.all([
    stripe.invoices.createPreview({
      customer: customerId,
      subscription: sub.id,
      subscription_details: { items, proration_behavior: "none" },
    }),
    stripe.invoices.createPreview({
      customer: customerId,
      subscription: sub.id,
      subscription_details: { items, proration_behavior: "create_prorations" },
    }),
  ]);

  const recurringTotal = recurring.total;
  const prorationTotal = prorated.total - recurring.total;

  const lines = prorated.lines.data.map((l) => ({
    description: l.description ?? "",
    amount: l.amount,
    proration: Boolean((l as unknown as { proration?: boolean }).proration),
  }));
  // The credit for the unused remainder arrives as negative proration lines.
  const credit = lines.filter((l) => l.proration && l.amount < 0).reduce((s, l) => s - l.amount, 0);

  if (timing === "period_end" || (timing === "auto" && isDowngrade)) {
    // Nothing is charged today, and no proration is raised at all: the customer
    // keeps what they paid for and the new price starts at the boundary.
    return {
      kind: "scheduled",
      currency: recurring.currency ?? currency,
      dueNow: 0,
      nextInvoiceTotal: recurringTotal,
      recurringTotal,
      credit: 0,
      effectiveAt: periodEndOf(sub),
      nextInvoiceAt: periodEndOf(sub),
      lines: [],
    };
  }

  // Only `invoice_now` bills the difference today. The default defers it to the
  // next invoice, which is then the proration plus the regular charge.
  const billsNow = (opts.proration ?? "next_invoice") === "invoice_now";
  const defersProration = (opts.proration ?? "next_invoice") === "next_invoice";

  return {
    kind: "immediate",
    currency: prorated.currency ?? currency,
    dueNow: billsNow ? prorationTotal : 0,
    nextInvoiceTotal: defersProration ? prorated.total : recurringTotal,
    recurringTotal,
    credit,
    effectiveAt: new Date().toISOString(),
    // The next scheduled invoice is the one the deferred proration rides on.
    nextInvoiceAt: periodEndOf(sub),
    lines,
  };
}

/**
 * End the paid subscription at the end of the period it has been paid for.
 *
 * A named alias over `changePlan` to the free plan, because "cancel" is what the
 * copy says and what the customer means. Reversible: calling `changePlan` back to
 * the current plan resumes it.
 */
export async function cancelPlan(
  adapter: BillingAdapter,
  orgId: string,
  opts: { plans: PlanCatalog; currency?: string; record?: boolean },
): Promise<PlanChangeResult> {
  const free = normalizePlans(opts.plans).find((m) => m.sale === "free");
  if (!free) throw new PlanChangeError("unknown_plan", "No free plan to cancel down to");
  return changePlan(adapter, orgId, { ...opts, to: { plan: free.key } });
}
