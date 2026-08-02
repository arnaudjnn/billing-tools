import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { enforceAccess } from "../auth.js";
import {
  ensureStripeCustomer,
  getBillingCustomerId,
  getCreditBalance,
  getAutoReloadSettings,
  setAutoReloadSettings,
  createCreditCheckoutSession,
  createBillingPortalSession,
  listInvoices,
  getInvoice,
  stripeConfigured,
} from "../billing.js";

const NO_STRIPE = {
  isError: true as const,
  content: [{ type: "text" as const, text: "Billing is not configured (STRIPE_SECRET_KEY unset)." }],
};

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
) {
  // Resolve (or lazily create) the org's Stripe customer.
  const customerId = async (orgId: string): Promise<string> => {
    const existing = await getBillingCustomerId(adapter, orgId);
    if (existing) return existing;
    return ensureStripeCustomer(adapter, orgId, undefined, config);
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
        taxRates: topUp.taxRates ? await topUp.taxRates(auth.orgId) : undefined,
        automaticTax: topUp.automaticTax,
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
