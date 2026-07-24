export interface PlanDef {
    /** Max members per workspace. null = unlimited. */
    seats: number | null;
    /** Included tokens granted per seat, per billing cycle. */
    tokensPerSeat: number;
    /** Recurring price in the smallest currency unit (cents). 0 = free (no Stripe price). */
    price: {
        monthly: number;
        yearly: number;
    };
}
export type PlansConfig = Record<string, PlanDef>;
export type BillingInterval = "monthly" | "yearly";
export declare const lookupKeyFor: (plan: string, interval: BillingInterval) => string;
export interface EnsuredPrice {
    plan: string;
    interval: BillingInterval;
    priceId: string;
    productId: string;
    amount: number;
    lookupKey: string;
}
/** Idempotently create/reconcile Stripe products + prices for the paid plans.
 *  Returns the resolved price for every paid plan × interval. Free plans (both
 *  prices 0) create no Stripe objects. Safe to call on every boot / first use. */
export declare function ensurePlans(plans: PlansConfig, opts?: {
    currency?: string;
}): Promise<EnsuredPrice[]>;
/** Resolve the current Stripe price id for a plan + interval (via lookup_key).
 *  Returns null for a free/absent price. */
export declare function planPriceId(plan: string, interval: BillingInterval): Promise<string | null>;
/** Reverse-map a Stripe price id → plan key (via the price's metadata). */
export declare function planForPriceId(priceId: string): Promise<string | null>;
/** Seat limit for a plan (null = unlimited, undefined plan = null). */
export declare function seatLimit(plans: PlansConfig, plan: string): number | null;
/** Included tokens for `seatCount` members on a plan (per cycle). */
export declare function includedTokens(plans: PlansConfig, plan: string, seatCount: number): number;
//# sourceMappingURL=plans.d.ts.map