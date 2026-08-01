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

/** What a plan costs per month for its default basket — the ordering a UI means
 *  by "higher" and "lower". A quoted plan sorts above every priced one. */
export function planRank(model: PlanModel): number {
  if (model.sale === "quote") return Number.MAX_SAFE_INTEGER;
  const basket = defaultBasket(model);
  if (model.sells.kind === "flat") return model.sells.price.monthly;
  return model.seatTypes.reduce((sum, s) => sum + (basket[s.key] ?? 0) * s.price.monthly, 0);
}

export interface PlanActions {
  /** The next plan up, or null when already at the top. */
  upgradeTo: string | null;
  /** The next plan down, or null when already at the bottom. */
  downgradeTo: string | null;
  /** Whether there is a paid subscription to end. False on a free plan — there
   *  is nothing to cancel, so the action shouldn't be offered. */
  canCancel: boolean;
  /** The plan a cancellation lands on. */
  cancelTo: string | null;
}

/**
 * Which of upgrade / downgrade / cancel apply to an org on `currentPlan`.
 *
 * Pure, so a UI can hide what doesn't apply instead of offering an action that
 * will be refused: no "upgrade" on the top plan, no "cancel" on a free one.
 */
export function planActions(plans: PlanCatalog, currentPlan: string | null): PlanActions {
  const models = normalizePlans(plans)
    .filter((m) => m.sale !== "legacy" && !m.display?.hidden)
    .sort((a, b) => planRank(a) - planRank(b));
  const free = models.find((m) => m.sale === "free") ?? null;
  const current = currentPlan ? models.find((m) => m.key === currentPlan) : null;
  // No recorded plan behaves as the free tier: nothing is being billed.
  const rank = current ? planRank(current) : (free ? planRank(free) : 0);
  const above = models.filter((m) => planRank(m) > rank);
  const below = models.filter((m) => planRank(m) < rank);
  const isPaid = current ? current.sells.kind !== "nothing" && current.sale !== "free" : false;
  return {
    upgradeTo: above[0]?.key ?? null,
    downgradeTo: below[below.length - 1]?.key ?? null,
    canCancel: isPaid,
    cancelTo: free?.key ?? null,
  };
}

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
  const carried =
    taxRates ?? [...new Set(sub.items.data.flatMap((i) => (i.tax_rates ?? []).map((r) => r.id)))];

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
      throw new PlanChangeError("invalid_basket", problems.map((problem) => describeBasketProblem(problem)).join("; "), problems);
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
      customerId,
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

  const updated = await stripe.subscriptions.update(
    sub.id,
    {
      items,
      proration_behavior,
      // The live-subscription equivalent of `default_incomplete`: the change
      // applies only once the invoice it generates is paid, and the original
      // subscription is untouched if it never is.
      ...(proration === "invoice_now" ? { payment_behavior: "pending_if_incomplete" as const } : {}),
      metadata: { ...sub.metadata, org_id: orgId, plan: target.key },
    },
    // Keyed on the target, so a double-clicked Confirm inside Stripe's 24h window
    // is a no-op rather than a second proration invoice.
    { idempotencyKey: `plan:${sub.id}:${target.key}:${interval}:${JSON.stringify([...desired].sort())}:${timing}:${proration}` },
  );

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
