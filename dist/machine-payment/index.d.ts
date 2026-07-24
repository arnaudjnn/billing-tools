export type MachinePaymentMethod = "stripe" | "tempo" | "solana" | "base";
export interface PaymentChallenge {
    id: string;
    method: MachinePaymentMethod;
    intent: "charge";
    amount: number;
    currency: string;
    /** SPT profile id (`profile_…`) for method "stripe", or a deposit address for crypto. */
    payTo?: string;
}
/** Settle a presented payment credential against a challenge. Provided by the
 *  app once its Stripe account is machine-payments-eligible (e.g. `stripe.charge`
 *  with the SPT, or a crypto verification). Resolve with a receipt on success;
 *  throw / return null to reject. */
export type SettleFn = (credential: string, challenge: PaymentChallenge) => Promise<{
    receipt: string;
} | null>;
export interface MachinePaymentOptions {
    /** Accepted methods, in preference order. Default ["stripe"]. */
    methods?: MachinePaymentMethod[];
    /** Price in minor units — fixed, or resolved per request (e.g. by path/tool). */
    amount: number | ((request: Request) => number | Promise<number>);
    currency?: string;
    /** SPT profile id (`profile_…`) advertised for method "stripe". */
    networkId?: string;
    /** Crypto deposit address advertised for crypto methods. */
    payToAddress?: string;
    /** Inject the actual charge once the account is eligible. Omit → 402 with a
     *  "settlement not enabled" note (protocol ready, money path pending). */
    settle?: SettleFn;
    /** Called after a successful settle; use to record the payment / grant access. */
    onPaid?: (challenge: PaymentChallenge, receipt: string, request: Request) => Promise<void> | void;
}
/** Build the MPP payment gate. Returns `requirePayment(request)` → either a 402
 *  `Response` (payment needed / rejected / not-settled) or `{ paid: true,
 *  challenge, receipt }` when settlement succeeds — the caller then serves the
 *  paid resource. */
export declare function createMachinePaymentHandler(opts: MachinePaymentOptions): {
    requirePayment: (request: Request) => Promise<Response | {
        paid: true;
        challenge: PaymentChallenge;
        receipt: string;
    }>;
    buildChallenges: (request: Request) => Promise<PaymentChallenge[]>;
};
export interface PaymentMdOptions {
    productName: string;
    methods?: MachinePaymentMethod[];
    currency?: string;
    /** Path the paid resource lives at, for the doc examples. Default "/mcp". */
    resourcePath?: string;
    baseUrl?: string | ((request: Request) => string);
}
/** `/payment.md` — the agent-facing "how to pay per request" narrative; the
 *  payment equivalent of auth.md. */
export declare function createPaymentMd(opts: PaymentMdOptions): (request: Request) => Response;
//# sourceMappingURL=index.d.ts.map