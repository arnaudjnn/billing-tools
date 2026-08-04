import type { TaxCalculation, TaxCalculator } from "./types.js";

// A `TaxCalculator` backed by Numeral (numeralhq.com), for `config.tax.mode: "external"`.
//
// It exists to fill the one hole the built-in modes leave: `local` cannot compute US
// sales tax, because there is no national rate to know — destination-based across
// 13 000+ jurisdictions with SaaS taxable in some states and not others. The two
// alternatives are Stripe Tax at 0.5% of every taxed transaction, or a provider.
//
// **This is the only file in the package that talks to a third party**, it is reached
// only when a deployment configures it, and `fetch` is injectable so the suite stays
// offline. Nothing else here gains a network dependency.
//
// Numeral is not endorsed and not special: `TaxCalculator` is a plain function type, so
// Anrok, Kintsugi, Vertex or an internal service are each one adapter of this shape.
// This one ships because it was the provider with a documented calculation endpoint and
// a free nexus-monitoring tier, which is the shape an early-stage deployment wants.

/** Numeral's calculation endpoint. Override for a sandbox or a proxy. */
const NUMERAL_API = "https://api.numeralhq.com/tax/calculations";

export type NumeralOptions = {
  /** Numeral API key. Read it from the environment; never commit it. */
  apiKey: string;
  /**
   * Where the calculation is sent. Override to point at a sandbox, or at your own
   * proxy if you would rather the key never reached this process.
   */
  endpoint?: string;
  /** Injected for tests, and so a caller can add retries or a timeout of their own. */
  fetch?: typeof globalThis.fetch;
  /**
   * How long to wait. A tax provider sits on a charge path, so the wait is bounded —
   * but note that a timeout here REFUSES the charge rather than untaxing it, which is
   * the direction this library takes everywhere it cannot answer.
   */
  timeoutMs?: number;
  /** What the invoice line says. Defaults to Numeral's own jurisdiction name. */
  displayName?: string;
};

/**
 * Build a `TaxCalculator` that asks Numeral.
 *
 * ```ts
 * import { numeralTax } from "@arnaudjnn/billing-tools";
 *
 * tax: {
 *   mode: "external",
 *   origin: "US",
 *   calculate: numeralTax({ apiKey: process.env.NUMERAL_API_KEY! }),
 * }
 * ```
 *
 * **It throws rather than returning 0 when it cannot get an answer.** A provider that
 * is down, rate-limited or misconfigured must refuse the charge: the reason to pay one
 * is that its answer is the authority, and a silent 0% invoice is the failure nobody
 * notices until an audit. `mode: "none"` is how a deployment says "charge no tax".
 */
export function numeralTax(opts: NumeralOptions): TaxCalculator {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? NUMERAL_API;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  return async (input): Promise<TaxCalculation | null> => {
    // No destination means no calculation. Numeral would either error or answer about
    // nowhere, and both are worse than saying so here.
    if (!input.country) {
      throw new Error(
        "numeralTax: the customer has no address on file, so there is no place of supply " +
          "to calculate for. Collect an address before charging, or use `mode: \"none\"`.",
      );
    }

    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customer_id: input.customerId,
        address: {
          country: input.country,
          state: input.state ?? undefined,
          postal_code: input.postalCode ?? undefined,
        },
        // Numeral decides B2B treatment from the id; passing it is what makes a
        // reverse-charged or exempt sale come back as such rather than as a rate.
        tax_id: input.taxNumber ?? undefined,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(
        `numeralTax: ${res.status} from ${endpoint}. The charge is refused rather than ` +
          "sent out untaxed — a provider that cannot answer must not be read as 0%.",
      );
    }

    const body = (await res.json()) as {
      tax_rate?: number;
      rate?: number;
      tax_amount_percent?: number;
      jurisdiction?: string;
      exempt?: boolean;
      reverse_charge?: boolean;
    };

    // Numeral's field naming has moved; accept the shapes it has used rather than
    // breaking on the one it did not send. A response with none of them is an error,
    // not a zero — see the note about silent 0% above.
    const percent = body.tax_rate ?? body.rate ?? body.tax_amount_percent;
    if (typeof percent !== "number" || Number.isNaN(percent)) {
      throw new Error(
        "numeralTax: no rate in the response. Refusing rather than assuming 0%. " +
          `Got keys: ${Object.keys(body).join(", ") || "(none)"}`,
      );
    }

    return {
      percent,
      country: input.country.toUpperCase(),
      reverseCharge: body.reverse_charge ?? false,
      // Numeral names the jurisdiction; that is what belongs on the invoice line, and
      // it beats a generic "Sales tax" for a customer checking a city surcharge.
      displayName: (opts.displayName ?? body.jurisdiction ?? "Sales tax").slice(0, 50),
    };
  };
}
