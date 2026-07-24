import Stripe from "stripe";
import type { BillingAdapter, ResolvedConfig } from "./types.js";
export declare function getStripe(): Stripe;
export declare function stripeConfigured(): boolean;
export interface StripePrice {
    id: string;
    productId: string | null;
    productName: string | null;
    lookupKey: string | null;
    nickname: string | null;
    unitAmount: number | null;
    currency: string;
    interval: string | null;
    intervalCount: number | null;
}
/** All active recurring (subscription) prices on the Stripe account. Uses the
 *  SDK's async auto-pagination so accounts with >1 page of prices aren't
 *  silently truncated. */
export declare function listSubscriptionPrices(): Promise<StripePrice[]>;
/** Resolve a single subscription price without any env config. Resolution
 *  order: explicit `priceId` → matching `lookupKey` → the sole recurring price.
 *  Returns null if nothing matches or the choice is ambiguous (multiple prices,
 *  no lookupKey) — the caller can then list options via listSubscriptionPrices.
 *  The priceId/lookupKey paths query Stripe directly (no full-list scan). */
export declare function resolveSubscriptionPrice(opts?: {
    priceId?: string;
    lookupKey?: string;
}): Promise<StripePrice | null>;
export declare function getBillingCustomerId(adapter: BillingAdapter, orgId: string): Promise<string | null>;
export declare function ensureStripeCustomer(adapter: BillingAdapter, orgId: string, email: string | undefined, config: ResolvedConfig): Promise<string>;
export declare function getTokenBalance(stripeCustomerId: string): Promise<number>;
export declare function deductTokens(stripeCustomerId: string, toolName: string, cost: number, currency: string): Promise<void>;
export declare function creditTokens(stripeCustomerId: string, amount: number, description: string, currency: string, 
/** Pass a stable key (e.g. the source invoice/session id) so replayed events
 *  — a re-delivered webhook, an overlapping poll — credit exactly once. */
idempotencyKey?: string): Promise<void>;
export declare function createTokenCheckoutSession(stripeCustomerId: string, orgId: string, amountMajor: number, config: ResolvedConfig): Promise<string>;
export declare function getAutoReloadSettings(stripeCustomerId: string): Promise<{
    enabled: boolean;
    threshold: number;
    reload_to: number;
} | null>;
export declare function setAutoReloadSettings(stripeCustomerId: string, threshold: number, reloadTo: number, enabled: boolean): Promise<void>;
export declare function tryAutoReload(stripeCustomerId: string, currency: string): Promise<void>;
export declare function listInvoices(stripeCustomerId: string, limit?: number): Promise<Array<{
    id: string;
    type: string;
    number: string | null;
    amount: number;
    status: string | null;
    created: string;
    invoice_url: string | null;
    invoice_pdf: string | null;
}>>;
//# sourceMappingURL=billing.d.ts.map