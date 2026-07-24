import type Stripe from "stripe";
export interface PollResult {
    cursor: string | null;
    count: number;
}
/** Poll Stripe events newer than `after` (last processed event id), oldest
 *  first. No `after` → baseline to the newest event, process nothing. */
export declare function pollStripeEvents(opts: {
    after?: string | null;
    types?: string[];
    onEvent: (event: Stripe.Event) => Promise<void>;
    maxPerPoll?: number;
}): Promise<PollResult>;
/** Poll WorkOS events of the given types newer than `after`, oldest first.
 *  No `after` → baseline to the newest event, process nothing. */
export declare function pollWorkOSEvents(opts: {
    after?: string | null;
    events: string[];
    onEvent: (event: {
        id: string;
        event: string;
        data: unknown;
    }) => Promise<void>;
    maxPerPoll?: number;
}): Promise<PollResult>;
//# sourceMappingURL=events.d.ts.map