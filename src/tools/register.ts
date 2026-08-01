import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillingAdapter, BillingConfig } from "../types.js";
import { resolveConfig } from "../types.js";
import { registerKeyTools } from "./keys.js";
import { registerBillingOnlyTools, type TopUpToolOptions } from "./billing.js";
import { registerManagementTools } from "./management.js";
import { registerProfileTools } from "./profile.js";
import { registerSubscriptionTools, type SubscriptionToolOptions } from "./subscription.js";
import { ensurePlans, normalizePlans, poolSizeOf, type PlanCatalog } from "../plans.js";

// Keys whose values must never hit the logs (magic-auth codes, API keys, etc.).
const SENSITIVE_KEY_RE =
  /cookie|token|secret|password|passwd|authorization|api[_-]?key|session|credential|code/i;

function redactForLog(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 300) {
      return `${value.slice(0, 300)}…(${value.length} chars)`;
    }
    return value;
  }
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactForLog(v, depth + 1);
  }
  return out;
}

// Wrap server.tool so every handler logs its (redacted) input. Call before
// registering tools so both the live MCP server and the REST dispatch shadow
// server emit uniform [tool-input] lines.
export function installInputLogging(server: McpServer) {
  const orig = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = function (...args: unknown[]) {
    const name = args[0];
    const cbIdx = args.length - 1;
    const cb = args[cbIdx];
    if (typeof cb === "function" && typeof name === "string") {
      args[cbIdx] = async (toolArgs: unknown, extra: unknown) => {
        try {
          console.log(`[tool-input] ${name} ${JSON.stringify(redactForLog(toolArgs))}`);
        } catch {
          console.log(`[tool-input] ${name} (unserializable args)`);
        }
        return (cb as (a: unknown, e: unknown) => unknown)(toolArgs, extra);
      };
    }
    return orig(...args);
  };
}

export interface RegisterBillingToolsOptions {
  adapter: BillingAdapter;
  config: BillingConfig;
  /** Per-tool token costs (for get_token_balance to echo). Usually from tools.json. */
  toolCosts?: Record<string, number>;
  /** Install the redacted [tool-input] logging wrapper. Default true. */
  installLogging?: boolean;
  /** Declarative plans. When set, a `list_plans` tool is registered and the
   *  Stripe products/prices are auto-provisioned (lazily, on first list). */
  plans?: PlanCatalog;
  /** Default plan key (e.g. "hobby"). */
  defaultPlan?: string;
  /** How to find the org's current plan key, when it isn't on the adapter's
   *  subscription (gtm-tools keeps it in org metadata). Used by the usage tools
   *  and to resolve the billing cycle a top-up is filed against. */
  resolvePlan?: (orgId: string) => Promise<string | null>;
  /** Register the billing-account tools (invoice details, tax id, saved cards).
   *  Default true — they need only a Stripe customer. */
  profileTools?: boolean;
  /** Register the lifecycle tools (`change_plan`, `preview_plan_change`,
   *  `cancel_plan`, `get_plan`). Needs `plans`; pass `false` to leave plan
   *  changes to the app's own UI. */
  subscriptionTools?: boolean | Omit<SubscriptionToolOptions, "plans">;
  /** Tax and return URLs for `buy_tokens`. Supply `taxRates` on any account that
   *  charges tax on its subscriptions: without it a top-up invoices at 0%. */
  topUp?: TopUpToolOptions;
}

// Register the billing-tools surface (auth/key management + token billing) on
// an MCP server. Host apps call this, then register their own product tools.
export function registerBillingTools(server: McpServer, opts: RegisterBillingToolsOptions) {
  const config = resolveConfig(opts.config);
  if (opts.installLogging !== false) installInputLogging(server);
  registerKeyTools(server, opts.adapter, config);
  registerBillingOnlyTools(server, opts.adapter, config, opts.toolCosts ?? {}, opts.topUp ?? {});
  registerManagementTools(server, opts.adapter, config, {
    plans: opts.plans,
    resolvePlan: opts.resolvePlan,
  });
  if (opts.profileTools !== false) registerProfileTools(server, opts.adapter);
  if (opts.plans) {
    registerPlanTools(server, opts.plans, opts.defaultPlan, config.currency);
    if (opts.subscriptionTools !== false) {
      const sub = typeof opts.subscriptionTools === "object" ? opts.subscriptionTools : {};
      registerSubscriptionTools(server, opts.adapter, config, { ...sub, plans: opts.plans });
    }
  }
}

// list_plans: returns the configured plans + live Stripe prices, provisioning
// the Stripe products/prices on first call (idempotent). Zero dashboard setup.
function registerPlanTools(
  server: McpServer,
  plans: PlanCatalog,
  defaultPlan: string | undefined,
  currency: string,
) {
  server.tool(
    "list_plans",
    "List the available subscription plans (seats, included tokens, and monthly/yearly prices). Prices are provisioned in Stripe automatically.",
    {},
    async () => {
      const ensured = await ensurePlans(plans, { currency });
      const priceOf = (plan: string, interval: "monthly" | "yearly", seatType?: string) =>
        ensured.find(
          (e) => e.plan === plan && e.interval === interval && e.seatType === seatType,
        ) ?? null;
      // Reported from the normalised model, so a seat-typed or pooled plan is
      // described as it actually is. This used to read `price`/`tokensPerSeat`
      // off the raw config, which a seat-typed plan doesn't use at all — so an
      // agent was told a plan cost the placeholder plan-level amount, and given
      // no way to see its seat types, its packs or whether it can be bought.
      const out = normalizePlans(plans).map((m) => ({
        plan: m.key,
        default: m.key === defaultPlan,
        sale: m.sale,
        name: m.display?.name ?? m.key,
        members: m.limits.members,
        intervals: m.intervals,
        included: poolSizeOf(m) !== null
          ? { scope: "pool" as const, tokens: poolSizeOf(m) }
          : { scope: "per_seat" as const, tokens: null },
        seat_types: m.seatTypes.map((s) => ({
          key: s.key,
          label: s.display?.label ?? s.key,
          shared: s.shared,
          max: s.max,
          included_tokens: s.includedTokens,
          prices: {
            monthly: { amount: s.price.monthly, currency, price_id: priceOf(m.key, "monthly", s.key)?.priceId ?? null },
            yearly: { amount: s.price.yearly, currency, price_id: priceOf(m.key, "yearly", s.key)?.priceId ?? null },
          },
        })),
        prices: m.price
          ? {
              monthly: { amount: m.price.monthly, currency, price_id: priceOf(m.key, "monthly")?.priceId ?? null },
              yearly: { amount: m.price.yearly, currency, price_id: priceOf(m.key, "yearly")?.priceId ?? null },
            }
          : null,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ plans: out }, null, 2) }] };
    },
  );
}

export const BILLING_TOOL_NAMES = [
  "get_api_key",
  "list_api_keys",
  "revoke_api_key",
  "get_token_balance",
  "buy_tokens",
  "set_auto_reload",
  "get_billing_portal",
  "list_invoices",
  "view_invoice",
  "download_invoice",
  // Workspace-management tools (registerManagementTools).
  "get_usage",
  "get_usage_limits",
  "list_seats",
  "assign_seat_type",
  "list_top_up_requests",
  "request_top_up",
  "approve_top_up",
  "grant_top_up",
  "deny_top_up",
  // The billing account itself (registerProfileTools).
  "get_billing_profile",
  "set_billing_profile",
  "set_tax_id",
  "list_payment_methods",
  "set_default_payment_method",
  "remove_payment_method",
  // The subscription lifecycle (registerSubscriptionTools; needs `plans`).
  "get_plan",
  "preview_plan_change",
  "change_plan",
  "cancel_plan",
] as const;
