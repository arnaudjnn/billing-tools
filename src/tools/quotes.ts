import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { enforceAdmin, enforceOperator } from "../auth.js";
import { getBillingCustomerId, sellCredits } from "../billing.js";
import { listPlanRequests, markPlanQuoteAccepted, quotePlanRequest } from "../plan-request.js";
import type { Notify } from "../notifications/index.js";
import type { BillingAdapter, ResolvedConfig } from "../types.js";

// Custom pricing, in the taxonomy that already existed.
//
// This was briefly its own family — `request_credit_quote`, `list_credit_quotes`,
// `resolve_credit_quote`, over a store of its own — and that was the mistake. Asking to move
// to a plan you cannot buy self-serve is the SAME act as asking to move to one you can:
// `request_plan_change` already means "I want to move up", already keeps one open ask per
// member, and already tells the people who can answer. A quote-only plan does not need
// another verb; it needs the answer to be able to carry a price.
//
// So the record grew (`seats`, `contact`, `quote`, `accepted` on `PlanRequest`) and what is
// left here is the two halves the existing tools did not have:
//
//   • `quote_plan_change` — OPERATOR: a quantity, and a price PER CREDIT.
//   • `accept_plan_quote` — ADMIN: takes it, and pays it.
//
// Plus `sell_credits`: the same sale with no request behind it, for a conversation that
// started on a call.

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });

/** What a charge did, in the shape a tool answers with — `sellCredits` returns one of two. */
function saleResult(sale: Awaited<ReturnType<typeof sellCredits>>, credits: number) {
  if (sale.status === "charged") {
    return {
      status: "charged" as const,
      invoice_id: sale.invoiceId,
      invoice_url: sale.hostedInvoiceUrl,
      credits_on_payment: credits,
    };
  }
  if (sale.status === "invoiced") {
    return {
      status: "invoiced" as const,
      invoice_id: sale.invoiceId,
      invoice_url: sale.hostedInvoiceUrl,
      due_at: sale.dueAt,
      emailed: sale.emailed,
      // Said plainly, because "invoiced" reads like "done".
      credits_on_payment: credits,
    };
  }
  return { status: "refused" as const, reason: sale.reason, message: sale.message };
}

export interface QuoteToolOptions {
  config: ResolvedConfig;
  notify?: Notify;
  /**
   * Register the OPERATOR half (`quote_plan_change`, `sell_credits`). Default true.
   *
   * `false` builds the customer's tool set. Not a security boundary — `enforceOperator` is,
   * wherever these exist — but a list that offers "price somebody else's workspace" to
   * somebody who can never do it is a list that sends agents at a 403.
   */
  operatorTools?: boolean;
}

export function registerQuoteTools(server: McpServer, adapter: BillingAdapter, opts: QuoteToolOptions) {
  // The ask and its answer both live in org metadata. An adapter that cannot hold one gets
  // neither tool, rather than a pair that could only ever answer "not supported".
  if (!adapter.getOrgMetadata || !adapter.setOrgMetadata) return;

  server.tool(
    "accept_plan_quote",
    `Accept the price an operator quoted for a plan change (workspace admins). Charges the
card on file if there is one, otherwise emails a payable invoice — either way the credits
land when the invoice is PAID. Nothing is charged until this is called.`,
    {
      request_id: z.string().describe("The quoted request"),
      purchase_order: z.string().max(30).optional().describe("Your PO number, printed on the invoice"),
      days_until_due: z.number().int().positive().optional().describe("Net terms when it is invoiced. Default 30"),
    },
    async (a) => {
      // An ADMIN, because accepting is agreeing to be charged.
      const auth = await enforceAdmin(adapter, "accepting a quote");
      if ("isError" in auth) return auth;

      const open = (await listPlanRequests(adapter, auth.orgId)).find(
        (r) => r.id === a.request_id && r.status === "quoted",
      );
      if (!open?.quote) return err("No quoted request with that id.");
      // A price with an expiry that has passed is not a price. Re-quoting is one operator
      // call; charging somebody last month's rate is a refund and an apology.
      if (open.quote.validUntil && Date.parse(open.quote.validUntil) < Date.now()) {
        return err("That price has expired. Ask for a new one and we will re-quote it.");
      }

      const customerId = await getBillingCustomerId(adapter, auth.orgId);
      if (!customerId) return err("This workspace has no billing account.");

      const sale = await sellCredits(customerId, auth.orgId, opts.config, {
        credits: open.quote.credits,
        amountMinor: open.quote.totalMinor,
        description: `${open.quote.credits.toLocaleString("en-US")} credits`,
        ...(a.days_until_due ? { daysUntilDue: a.days_until_due } : {}),
        ...(a.purchase_order ? { purchaseOrder: a.purchase_order } : {}),
        // The REQUEST id is the idempotency key: accepting twice reuses the invoice rather
        // than billing a second time.
        idempotencyKey: `quote:${open.id}`,
      });
      if (sale.status === "refused") return err(sale.message);

      await markPlanQuoteAccepted(adapter, auth.orgId, {
        requestId: open.id,
        accepted: {
          at: new Date().toISOString(),
          method: sale.status === "charged" ? "saved_card" : "invoice",
          invoiceId: sale.invoiceId,
          ...(sale.hostedInvoiceUrl ? { invoiceUrl: sale.hostedInvoiceUrl } : {}),
        },
      });
      return json(saleResult(sale, open.quote.credits));
    },
  );

  if (opts.operatorTools === false) return;

  server.tool(
    "quote_plan_change",
    `Price an open plan-change request (platform operators only). Give a credit quantity and
a price PER CREDIT — the total is computed here, so the figure a customer accepts and the
figure they are charged cannot drift. Charges nothing: they accept with accept_plan_quote.`,
    {
      workspace_id: z.string().describe("The workspace whose request this is"),
      request_id: z.string(),
      credits: z.number().int().positive().describe("How many credits the deal is for"),
      price_per_credit: z
        .number()
        .positive()
        .describe("Minor units per credit — 0.7 is 0.7 cents. Fractions are allowed"),
      valid_until: z.string().optional().describe("ISO date the price expires"),
      note: z.string().max(280).optional(),
    },
    async (a) => {
      // Cross-org by design, which is exactly why this gate fails closed.
      const operator = enforceOperator("quoting a plan change");
      if ("isError" in operator) return operator;

      const res = await quotePlanRequest(adapter, a.workspace_id, {
        requestId: a.request_id,
        credits: a.credits,
        unitPriceMinor: a.price_per_credit,
        notify: opts.notify,
        ...(a.valid_until ? { validUntil: a.valid_until } : {}),
        ...(a.note ? { note: a.note } : {}),
      });
      if (!res.ok) {
        return err(
          res.reason === "not_found"
            ? "No open request with that id in that workspace."
            : res.reason === "invalid_amount"
              ? "Both `credits` and `price_per_credit` must be positive."
              : "That workspace's request queue is full.",
        );
      }
      return json({
        status: "quoted",
        request: res.request,
        total_minor: res.request.quote!.totalMinor,
        currency: opts.config.currency,
      });
    },
  );

  server.tool(
    "sell_credits",
    `Sell a workspace credits at a negotiated price, with no request on file (platform
operators only). Charges the card on file if there is one, otherwise emails an invoice;
credits land when it is PAID. For a deal that started on a call rather than in the app,
where making the customer file a request so we can answer it is theatre.`,
    {
      workspace_id: z.string().describe("Whose wallet the credits land in when it is paid"),
      credits: z.number().int().positive().describe("What they get"),
      amount: z.number().positive().describe("What they pay, in whole currency units"),
      description: z.string().max(120).optional().describe("What the invoice line says"),
      days_until_due: z.number().int().positive().optional().describe("Net terms. Default 30"),
      purchase_order: z.string().max(30).optional().describe("Their PO, printed on the invoice"),
      method: z
        .enum(["auto", "saved_card", "invoice"])
        .optional()
        .describe("Default auto: the card on file, else an emailed invoice"),
      reference: z
        .string()
        .max(60)
        .optional()
        .describe("Your own idempotency key — the same one reuses the invoice rather than raising a second"),
    },
    async (a) => {
      const operator = enforceOperator("selling credits");
      if ("isError" in operator) return operator;

      const customerId = await getBillingCustomerId(adapter, a.workspace_id);
      if (!customerId) return err("That workspace has no billing account.");

      // Tax is resolved from `config.tax` inside, like every other charge on the account: a
      // negotiated invoice is still a real invoice, and carries the same rate and the same
      // mandatory mention as one raised by `buy_credits`.
      const sale = await sellCredits(customerId, a.workspace_id, opts.config, {
        credits: a.credits,
        amountMinor: Math.round(a.amount * 100),
        ...(a.method ? { method: a.method } : {}),
        ...(a.description ? { description: a.description } : {}),
        ...(a.days_until_due ? { daysUntilDue: a.days_until_due } : {}),
        ...(a.purchase_order ? { purchaseOrder: a.purchase_order } : {}),
        ...(a.reference ? { idempotencyKey: `sell:${a.reference}` } : {}),
      });
      if (sale.status === "refused") return err(sale.message);
      return json(saleResult(sale, a.credits));
    },
  );
}
