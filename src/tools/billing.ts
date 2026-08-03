import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { enforceAccess, enforceAdmin } from "../auth.js";
import { ALL_TOOL_CAPABILITIES, type ToolCapabilities } from "../plan-model.js";
import { taxFor } from "../tax.js";
import {
  ensureStripeCustomer,
  getBillingCustomerId,
  getCreditBalance,
  getAutoReloadSettings,
  setAutoReloadSettings,
  getSpendControls,
  setSpendControls,
  createCreditCheckoutSession,
  quoteCreditPurchase,
  createBillingPortalSession,
  listInvoices,
  getInvoice,
  stripeConfigured,
} from "../billing.js";

const NO_STRIPE = {
  isError: true as const,
  content: [{ type: "text" as const, text: "Billing is not configured (STRIPE_SECRET_KEY unset)." }],
};

// Same shape management.ts and subscription.ts use, so a refusal reads identically
// whichever module raised it.
function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

/**
 * Per-org top-up settings, resolved at call time.
 *
 * A callback rather than a value because a top-up bought over MCP or the CLI has
 * no address form: the rate has to be derived from what is already known about
 * the customer (their stored billing country / VAT id), which only the app can
 * look up.
 */
export interface TopUpToolOptions {
  /** Stripe TaxRate ids for this org's top-up, e.g. via `taxRatesFor`. */
  taxRates?: (orgId: string) => Promise<string[]> | string[];
  automaticTax?: boolean;
  successUrl?: string;
  cancelUrl?: string;
}

export function registerBillingOnlyTools(
  server: McpServer,
  adapter: BillingAdapter,
  config: ResolvedConfig,
  toolCosts: Record<string, number>,
  topUp: TopUpToolOptions = {},
  caps: ToolCapabilities = ALL_TOOL_CAPABILITIES,
) {
  // Resolve (or lazily create) the org's Stripe customer.
  const customerId = async (orgId: string): Promise<string> => {
    const existing = await getBillingCustomerId(adapter, orgId);
    if (existing) return existing;
    return ensureStripeCustomer(adapter, orgId, undefined, config);
  };

  // What a top-up is taxed at: the caller's own hooks first (they are per-ORG, which
  // `config.tax` cannot express), then the deployment's declared mode. Both the
  // quote and the charge go through this, so the number quoted is the number
  // charged — the whole point of `quoteCreditPurchase` sharing the rate ids.
  const topUpTax = async (
    orgId: string,
    cid?: string,
  ): Promise<{ taxRates?: string[]; automaticTax?: boolean }> => {
    if (topUp.taxRates) {
      const rates = await topUp.taxRates(orgId);
      if (rates?.length) return { taxRates: rates };
    }
    if (topUp.automaticTax) return { automaticTax: true };
    return taxFor(cid ?? (await getBillingCustomerId(adapter, orgId)), config.tax);
  };

  server.tool(
    "get_credit_balance",
    `Returns your current credit balance, per-tool costs, and auto-reload settings.`,
    {},
    async () => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const balance = await getCreditBalance(cid, config.currency);
      const autoReload = await getAutoReloadSettings(cid);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { credit_balance: balance, tool_costs: toolCosts, auto_reload: autoReload || { enabled: false } },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Only when some plan actually sells top-ups (`replenish.purchase`). A
  // wallet-less catalogue that advertised buy_credits sent an agent to a
  // Checkout Session for an allowance the plan cannot replenish.
  if (caps.purchase) {
    server.tool(
      "preview_credit_purchase",
      `What a credit purchase will cost, before buying: credits, tax and total.
Quoted from the same Stripe tax rates buy_credits will charge, so the two agree.`,
      {
        amount: z.number().min(5).max(200000).describe("Amount in your currency to quote (e.g. 10 = 1000 credits)"),
      },
      async ({ amount }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        if (!stripeConfigured()) return NO_STRIPE;
        // The quote must read the SAME rates the purchase will carry, or the dialog
        // shows a total the card is not charged.
        const { taxRates } = await topUpTax(auth.orgId);
        const quote = await quoteCreditPurchase(amount, taxRates ?? []);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  credits: quote.credits,
                  subtotal: quote.subtotal,
                  tax: quote.tax,
                  total: quote.total,
                  tax_percent: quote.taxPercent,
                  currency: config.currency,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.tool(
      "buy_credits",
      `Purchase credits via Stripe Checkout. Returns a payment URL.
1 unit of currency = 100 credits. Minimum 5, maximum 200,000. Your card is saved for auto-reload.`,
      {
        amount: z.number().min(5).max(200000).describe("Amount in your currency to purchase (e.g. 10 = 1000 credits)"),
      },
      async ({ amount }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        if (!stripeConfigured()) return NO_STRIPE;
        const cid = await customerId(auth.orgId);
        const url = await createCreditCheckoutSession(cid, auth.orgId, amount, config, {
          ...(await topUpTax(auth.orgId, cid)),
          successUrl: topUp.successUrl,
          cancelUrl: topUp.cancelUrl,
        });
        const credits = Math.round(amount * 100);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "checkout_created",
                  checkout_url: url,
                  amount,
                  credits,
                  message: `Open this URL to purchase ${credits} credits.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }

  // Gated the same way, on `replenish.autoReload`.
  if (caps.autoReload) {
    server.tool(
      "set_auto_reload",
      `Configure automatic credit reload. When your balance drops to or below the threshold
after a tool call, your saved card is charged to bring the balance back to reload_to.
Requires a saved card (use buy_credits first).`,
      {
        enabled: z.boolean().describe("Enable or disable auto-reload"),
        threshold: z.number().min(0).describe("Balance threshold that triggers reload"),
        reload_to: z.number().min(1).describe("Target balance after reload"),
      },
      async ({ enabled, threshold, reload_to }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth) return auth;
        if (!stripeConfigured()) return NO_STRIPE;
        if (reload_to <= threshold) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "reload_to must be greater than threshold." }],
          };
        }
        const cid = await customerId(auth.orgId);
        await setAutoReloadSettings(cid, threshold, reload_to, enabled);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "ok",
                  auto_reload: { enabled, threshold, reload_to },
                  message: enabled
                    ? `Auto-reload enabled: at <=${threshold} credits, recharge to ${reload_to}.`
                    : "Auto-reload disabled.",
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }

  // ── The customer's own ceiling ─────────────────────────────────────────────
  //
  // Ungated, and on purpose. A spend limit FUNDS nothing and only refuses, so it
  // needs no `replenish` and no plan: a free workspace can cap its own consumption
  // exactly like a subscribed one. All it needs is the Stripe customer the limit
  // lives on.
  //
  // These exist because the parity rule was broken here, in the direction it was
  // written to catch: `getSpendControls` / `setSpendControls` were a library
  // function and a billing screen and nothing else. The cost was specific, not
  // theoretical — `describeDenial` answers `spend_limit_reached` by telling the
  // caller this is the one limit they can raise themselves, which is useless advice
  // to an agent with no tool to raise it with.
  server.tool(
    "get_spend_controls",
    `Your workspace's own monthly spending ceiling and the alert thresholds set on it.
This is the limit YOU control, distinct from the plan's rate limits. For how much of
it is already used and when it resets, call get_usage_limits (the ceiling appears
there as a window with kind "spend").`,
    {},
    async () => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const controls = await getSpendControls(await customerId(auth.orgId));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                // Named `_credits` like the metadata keys they come from, because a
                // bare `limit` next to `buy_credits` (which takes CURRENCY) is the
                // one ambiguity worth spending two words to remove.
                limit_credits: controls.limitCredits,
                alert_credits: controls.alertCredits,
                window: "calendar_month",
                currency: config.currency,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "set_spend_controls",
    `Set your workspace's monthly spending ceiling, in CREDITS, and/or the thresholds to
be warned at. Pass only the field you want to change; omitting one leaves it alone.
Pass limit_credits: 0 to remove the ceiling entirely, and alert_credits: [] to clear
every threshold. The window is the calendar month, even on an annual plan.`,
    {
      // 0 is the clear, and `null` is deliberately NOT accepted: `dispatchTool`
      // strips null/undefined arguments before validation (dispatch.ts), so a
      // nullable field would be dropped on the REST and CLI paths and read as
      // "leave it alone" — the caller's clear would silently not happen, while the
      // same call over raw MCP worked. One spelling that behaves identically on
      // every surface beats two where one quietly doesn't.
      limit_credits: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Credits allowed per calendar month. 0 removes the ceiling"),
      alert_credits: z
        .array(z.number().int().min(1))
        .optional()
        .describe("Credit thresholds to warn at, any order. [] clears them"),
    },
    async ({ limit_credits, alert_credits }) => {
      // The ceiling governs what the whole workspace may consume, so raising it is
      // an owner action wherever the caller is a known person — the same reasoning
      // as assign_seat_type. With only an org key in play there is no principal and
      // this allows, so a headless agent is unaffected.
      const auth = await enforceAdmin(adapter, "set_spend_controls");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      if (limit_credits === undefined && alert_credits === undefined) {
        return err("Pass limit_credits and/or alert_credits — there is nothing to change.");
      }
      // Built key-by-key because `setSpendControls` distinguishes an ABSENT field
      // ("leave it") from a null one ("clear it") with `in`. Spreading both
      // unconditionally would clear whichever the caller did not mention.
      const input: { limitCredits?: number | null; alertCredits?: number[] } = {};
      // 0 arrives as 0 and `setSpendControls` stores it as "" — the Stripe metadata
      // clear — never as "0", which would read back as a ceiling of zero and refuse
      // every call in the workspace.
      if (limit_credits !== undefined) input.limitCredits = limit_credits;
      if (alert_credits !== undefined) input.alertCredits = alert_credits;

      const cid = await customerId(auth.orgId);
      await setSpendControls(cid, input);
      // Read back rather than echoing the request: 0 is stored as a cleared key and
      // the thresholds come back sorted and de-junked, so what the caller asked for
      // is not always what is now in force.
      const controls = await getSpendControls(cid);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "ok",
                limit_credits: controls.limitCredits,
                alert_credits: controls.alertCredits,
                window: "calendar_month",
                message:
                  controls.limitCredits === null
                    ? "No monthly spending ceiling."
                    : `Ceiling: ${controls.limitCredits} credits per calendar month.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "get_billing_portal",
    `Get a Stripe billing-portal URL to manage your subscription (upgrade, downgrade, cancel),
update your payment method, and view invoices. Returns a short-lived link.`,
    { return_url: z.string().url().optional().describe("Where to send the user back to after the portal (defaults to the app)") },
    async ({ return_url }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const url = await createBillingPortalSession(cid, return_url ?? config.baseUrl);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { status: "portal_created", portal_url: url, message: "Open this URL to manage billing." },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "list_invoices",
    `Returns your recent invoices with amounts, dates, status (paid/open), and links to view/download PDFs.`,
    { limit: z.number().min(1).max(100).optional().default(10).describe("Number to return (default 10)") },
    async ({ limit }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const invoices = await listInvoices(cid, limit);
      return { content: [{ type: "text" as const, text: JSON.stringify({ invoices }, null, 2) }] };
    },
  );

  // Not found and not yours are the SAME answer here (getInvoice checks the
  // customer), so an invoice id from another org tells the caller nothing.
  const NOT_FOUND = {
    isError: true as const,
    content: [{ type: "text" as const, text: "No such invoice." }],
  };

  server.tool(
    "view_invoice",
    `Returns one invoice by id: amount, status, date, and a hosted link to view it in the browser.`,
    { invoice_id: z.string().describe("Invoice id (in_…) or auto-reload charge id (ch_…)") },
    async ({ invoice_id }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const invoice = await getInvoice(cid, invoice_id);
      if (!invoice) return NOT_FOUND;
      return { content: [{ type: "text" as const, text: JSON.stringify({ invoice }, null, 2) }] };
    },
  );

  server.tool(
    "download_invoice",
    `Returns a direct PDF link for one invoice. Drafts and auto-reload receipts have no PDF;
use view_invoice for those.`,
    { invoice_id: z.string().describe("Invoice id (in_…)") },
    async ({ invoice_id }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const invoice = await getInvoice(cid, invoice_id);
      if (!invoice) return NOT_FOUND;
      if (!invoice.invoice_pdf) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "no_pdf",
                  invoice_url: invoice.invoice_url,
                  message:
                    invoice.type === "auto_reload"
                      ? "An auto-reload charge has a receipt page, not a PDF. Open invoice_url."
                      : "This invoice has no PDF yet (it is still a draft). Open invoice_url.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "ok",
                invoice_id: invoice.id,
                number: invoice.number,
                pdf_url: invoice.invoice_pdf,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
