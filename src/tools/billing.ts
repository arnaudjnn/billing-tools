import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { enforceAccess } from "../auth.js";
import {
  ensureStripeCustomer,
  getBillingCustomerId,
  getTokenBalance,
  getAutoReloadSettings,
  setAutoReloadSettings,
  createTokenCheckoutSession,
  createBillingPortalSession,
  listInvoices,
  stripeConfigured,
} from "../billing.js";

const NO_STRIPE = {
  isError: true as const,
  content: [{ type: "text" as const, text: "Billing is not configured (STRIPE_SECRET_KEY unset)." }],
};

export function registerBillingOnlyTools(
  server: McpServer,
  adapter: BillingAdapter,
  config: ResolvedConfig,
  toolCosts: Record<string, number>,
) {
  // Resolve (or lazily create) the org's Stripe customer.
  const customerId = async (orgId: string): Promise<string> => {
    const existing = await getBillingCustomerId(adapter, orgId);
    if (existing) return existing;
    return ensureStripeCustomer(adapter, orgId, undefined, config);
  };

  server.tool(
    "get_token_balance",
    `Returns your current token balance, per-tool costs, and auto-reload settings.`,
    {},
    async () => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const balance = await getTokenBalance(cid);
      const autoReload = await getAutoReloadSettings(cid);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { token_balance: balance, tool_costs: toolCosts, auto_reload: autoReload || { enabled: false } },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "buy_tokens",
    `Purchase tokens via Stripe Checkout. Returns a payment URL.
1 unit of currency = 100 tokens. Minimum 5, maximum 200,000. Your card is saved for auto-reload.`,
    {
      amount: z.number().min(5).max(200000).describe("Amount in your currency to purchase (e.g. 10 = 1000 tokens)"),
    },
    async ({ amount }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return NO_STRIPE;
      const cid = await customerId(auth.orgId);
      const url = await createTokenCheckoutSession(cid, auth.orgId, amount, config);
      const tokens = Math.round(amount * 100);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "checkout_created",
                checkout_url: url,
                amount,
                tokens,
                message: `Open this URL to purchase ${tokens} tokens.`,
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
    `Configure automatic token reload. When your balance drops to or below the threshold
after a tool call, your saved card is charged to bring the balance back to reload_to.
Requires a saved card (use buy_tokens first).`,
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
                  ? `Auto-reload enabled: at <=${threshold} tokens, recharge to ${reload_to}.`
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
    `Returns your recent invoices with amounts, dates, and links to view/download PDFs.`,
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
}
