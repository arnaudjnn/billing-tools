import { randomBytes } from "node:crypto";

// Machine payments — the server side of Stripe's MPP (Machine Payments Protocol,
// https://mpp.dev), the *payment* sibling of auth.md. A client requests a paid
// resource → we return HTTP 402 with a signed-challenge `WWW-Authenticate:
// Payment` header per accepted method + an application/problem+json body. The
// client pays (SPT card or crypto/USDC) and retries with a payment credential;
// we settle and return the resource + a receipt.
//
// SETTLEMENT IS PLUGGABLE + GATED. Emitting the 402 challenge and parsing the
// retry credential is fully implemented here and testable offline. Actually
// charging requires the Stripe account to be enabled for machine payments
// (Stablecoins/Crypto approval, or a US entity for SPT) — so the money step is
// injected via `settle`. Without it, the handler keeps 402-ing with a clear
// "settlement not enabled" note (never a 500). Validate the challenge shape with
// the `mppx validate` CLI; reference impl: github.com/stripe-samples/machine-payments.

export type MachinePaymentMethod = "stripe" | "tempo" | "solana" | "base";

export interface PaymentChallenge {
  id: string;
  method: MachinePaymentMethod;
  intent: "charge";
  amount: number; // minor units (or USDC units for crypto)
  currency: string;
  /** SPT profile id (`profile_…`) for method "stripe", or a deposit address for crypto. */
  payTo?: string;
}

/** Settle a presented payment credential against a challenge. Provided by the
 *  app once its Stripe account is machine-payments-eligible (e.g. `stripe.charge`
 *  with the SPT, or a crypto verification). Resolve with a receipt on success;
 *  throw / return null to reject. */
export type SettleFn = (
  credential: string,
  challenge: PaymentChallenge,
) => Promise<{ receipt: string } | null>;

export interface MachinePaymentOptions {
  /** Accepted methods, in preference order. Default ["stripe"]. */
  methods?: MachinePaymentMethod[];
  /** Price in minor units — fixed, or resolved per request (e.g. by path/tool). */
  amount: number | ((request: Request) => number | Promise<number>);
  currency?: string; // default "usd"
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

const PROBLEM_TYPE = "https://paymentauth.org/problems/payment-required";

function challengeHeader(c: PaymentChallenge): string {
  const parts = [
    `id="${c.id}"`,
    `method="${c.method}"`,
    `intent="${c.intent}"`,
    `amount="${c.amount}"`,
    `currency="${c.currency}"`,
    ...(c.payTo ? [`payTo="${c.payTo}"`] : []),
  ];
  return `Payment ${parts.join(", ")}`;
}

/** Read the payment credential the client presents on retry. MPP clients send
 *  it in an `Authorization: Payment <credential>` header (we also accept the
 *  common `X-Payment` header). */
function readCredential(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Payment ")) return auth.slice(8).trim();
  return request.headers.get("x-payment");
}

/** Build the MPP payment gate. Returns `requirePayment(request)` → either a 402
 *  `Response` (payment needed / rejected / not-settled) or `{ paid: true,
 *  challenge, receipt }` when settlement succeeds — the caller then serves the
 *  paid resource. */
export function createMachinePaymentHandler(opts: MachinePaymentOptions) {
  const methods = opts.methods ?? ["stripe"];
  const currency = opts.currency ?? "usd";

  async function buildChallenges(request: Request): Promise<PaymentChallenge[]> {
    const amount = typeof opts.amount === "function" ? await opts.amount(request) : opts.amount;
    return methods.map((method) => ({
      id: `chal_${randomBytes(12).toString("hex")}`,
      method,
      intent: "charge" as const,
      amount,
      currency,
      payTo: method === "stripe" ? opts.networkId : opts.payToAddress,
    }));
  }

  function paymentRequired(challenges: PaymentChallenge[], detail: string): Response {
    const headers = new Headers({ "Content-Type": "application/problem+json", "Cache-Control": "no-store" });
    for (const c of challenges) headers.append("WWW-Authenticate", challengeHeader(c));
    return new Response(
      JSON.stringify({
        type: PROBLEM_TYPE,
        title: "Payment Required",
        status: 402,
        detail,
        challengeId: challenges[0]?.id,
        accepts: challenges.map((c) => ({ method: c.method, amount: c.amount, currency: c.currency, payTo: c.payTo })),
      }),
      { status: 402, headers },
    );
  }

  async function requirePayment(
    request: Request,
  ): Promise<Response | { paid: true; challenge: PaymentChallenge; receipt: string }> {
    const credential = readCredential(request);
    const challenges = await buildChallenges(request);

    if (!credential) return paymentRequired(challenges, "Payment is required.");
    if (!opts.settle) {
      return paymentRequired(challenges, "Payment settlement is not enabled on this account yet.");
    }
    // Settle against the first challenge (single-method retries are typical).
    const challenge = challenges[0];
    try {
      const result = await opts.settle(credential, challenge);
      if (!result) return paymentRequired(challenges, "Payment was declined.");
      await opts.onPaid?.(challenge, result.receipt, request);
      return { paid: true, challenge, receipt: result.receipt };
    } catch (e) {
      return paymentRequired(challenges, `Payment failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { requirePayment, buildChallenges };
}

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
export function createPaymentMd(opts: PaymentMdOptions) {
  return function paymentMd(request: Request): Response {
    const b =
      typeof opts.baseUrl === "function"
        ? opts.baseUrl(request)
        : (opts.baseUrl ??
          (() => {
            const h = request.headers;
            const host = h.get("x-forwarded-host") ?? h.get("host") ?? new URL(request.url).host;
            const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
            return `${proto}://${host}`;
          })());
    const methods = (opts.methods ?? ["stripe"]).join(", ");
    const path = opts.resourcePath ?? "/mcp";
    const body = `# ${opts.productName} — payment.md

This service accepts per-request machine payments via [MPP](https://mpp.dev) (the Machine Payments Protocol). As an agent you can pay for a resource on demand — no account or API key required.

## Flow

1. Request the paid resource:
   \`\`\`http
   POST ${b}${path}
   \`\`\`
2. If payment is required you get **HTTP 402** with one \`WWW-Authenticate: Payment …\` header per accepted method and an \`application/problem+json\` body describing the amount, currency, and \`payTo\`.
3. Authorize the payment (methods: ${methods}) and retry the request with the credential:
   \`\`\`http
   POST ${b}${path}
   Authorization: Payment <credential>
   \`\`\`
4. On success you get the resource plus a \`Payment-Receipt\` header.

Accepted currency: ${opts.currency ?? "usd"}. See https://docs.stripe.com/payments/machine for client tooling.
`;
    return new Response(body, {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  };
}
