import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { currentPrincipal, enforceAccess, enforceAdmin, enforceOperator } from "../auth.js";
import { getBillingCustomerId, sellCredits } from "../billing.js";
import {
  answerCreditQuote,
  listCreditQuotes,
  requestCreditQuote,
  type VolumeQuote,
} from "../credit-quotes.js";
import type { Notify } from "../notifications/index.js";
import type { BillingAdapter, ResolvedConfig } from "../types.js";

// The commercial conversation, as three tools.
//
// A plan marked `sale: "quote"` renders "contact us" and refuses every checkout — and until
// now that was the end of it: no record of who asked, nothing to answer with, and no credit
// sale anywhere that could carry a negotiated price. These are the two halves of that
// conversation plus the reading in between, and they are deliberately gated by two different
// authorities: an ADMIN of the workspace asks, an OPERATOR of the deployment answers.

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });

export interface QuoteToolOptions {
  config: ResolvedConfig;
  notify?: Notify;
}

export function registerQuoteTools(server: McpServer, adapter: BillingAdapter, opts: QuoteToolOptions) {
  // Both halves need somewhere to keep the record. An adapter with no org metadata cannot
  // hold a quote, and a tool that could only ever answer "not supported" is the false
  // advertisement this library keeps deleting.
  if (!adapter.getOrgMetadata || !adapter.setOrgMetadata) return;

  server.tool(
    "request_credit_quote",
    `Ask for a price on a volume of credits this plan does not sell self-serve (an Enterprise
deal). Say either how many credits you want, or the volume you expect in your own terms —
"20000 searches per month" is a better answer than a credit figure you had to work out.
A budget is optional and helps: it tells us whether you need a discount or simply a big
order. One open quote per workspace.`,
    {
      credits: z.number().int().positive().optional().describe("Credits wanted, if you think in credits"),
      volume_amount: z.number().positive().optional().describe('Your own unit, e.g. 20000 for "20000 searches"'),
      volume_unit: z.string().max(40).optional().describe('What those are: "searches", "documents", …'),
      volume_per: z.enum(["month", "year"]).optional().default("month"),
      term: z.enum(["one_off", "monthly", "annual"]).default("one_off").describe("One purchase, or a commitment"),
      seats: z.number().int().positive().optional().describe("How many people will use it"),
      budget: z.number().positive().optional().describe("What you expect to pay, in whole currency units"),
      needed_by: z.string().optional().describe("ISO date you need it live by"),
      payment_method: z.enum(["invoice", "card"]).default("invoice"),
      purchase_order: z.string().max(30).optional().describe("Your PO number, if procurement needs one on the invoice"),
      note: z.string().max(280).optional().describe("What you are doing with it"),
      first_name: z.string().max(80).optional(),
      last_name: z.string().max(80).optional(),
      work_email: z
        .string()
        .email()
        .optional()
        .describe("Address on the company's own domain — who we answer, and where"),
    },
    async (a) => {
      // An admin, because a quote commits the workspace to a conversation about money — and
      // because the answer arrives as an invoice addressed to it.
      const auth = await enforceAdmin(adapter, "requesting a credit quote");
      if ("isError" in auth) return auth;

      const res = await requestCreditQuote(adapter, auth.orgId, {
        memberId: currentPrincipal()?.userId ?? auth.orgId,
        notify: opts.notify,
        term: a.term,
        paymentMethod: a.payment_method,
        ...(a.credits ? { credits: a.credits } : {}),
        ...(a.volume_amount
          ? { volume: { amount: a.volume_amount, unit: a.volume_unit ?? "units", per: a.volume_per } }
          : {}),
        ...(a.seats ? { seats: a.seats } : {}),
        // Minor units on the record, because that is what the answer is priced in.
        ...(a.budget ? { budgetMinor: Math.round(a.budget * 100) } : {}),
        ...(a.needed_by ? { neededBy: a.needed_by } : {}),
        ...(a.purchase_order ? { purchaseOrder: a.purchase_order } : {}),
        ...(a.note ? { note: a.note } : {}),
        ...(a.work_email
          ? {
              contact: {
                firstName: a.first_name ?? "",
                lastName: a.last_name ?? "",
                email: a.work_email,
              },
            }
          : {}),
      });

      if (!res.ok) {
        if (res.reason === "already_pending") {
          return json({ status: "already_pending", quote: res.pending });
        }
        return err(
          res.reason === "nothing_asked"
            ? "Say something to go on: `credits`, `volume_amount`, `seats`, or a `work_email` to answer."
            : "This workspace's quote history is full. Ask an operator to settle the open one first.",
        );
      }
      return json({ status: "requested", quote: res.quote });
    },
  );

  server.tool(
    "list_credit_quotes",
    "List this workspace's credit quotes — what was asked for, and what was answered.",
    {},
    async () => {
      // A READ, member-visible: what the workspace asked for is not privileged information
      // to somebody in it.
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      return json({ quotes: await listCreditQuotes(adapter, auth.orgId) });
    },
  );

  server.tool(
    "sell_credits",
    `Sell a workspace credits at a NEGOTIATED price (platform operators only). Raises a
Stripe invoice for \`amount\` and grants \`credits\` when it is paid — the two are
deliberately independent, which is the whole point: every other path here prices credits at
the list rate. Needs no quote on file, so an operator can price a conversation that started
anywhere.`,
    {
      workspace_id: z.string().describe("Whose wallet the credits land in when it is paid"),
      credits: z.number().int().positive().describe("What they get"),
      amount: z.number().positive().describe("What they pay, in whole currency units"),
      description: z.string().max(120).optional().describe("What the invoice line says"),
      days_until_due: z.number().int().positive().optional().describe("Net terms. Default 30"),
      purchase_order: z.string().max(30).optional().describe("Their PO, printed on the invoice"),
      reference: z
        .string()
        .max(60)
        .optional()
        .describe("Your own idempotency key — the same one reuses the invoice rather than raising a second"),
    },
    async (a) => {
      // Cross-org by design: the argument names a workspace that is not the caller's, which
      // is exactly why this is the one gate in the library that fails closed.
      const operator = enforceOperator("selling credits");
      if ("isError" in operator) return operator;

      const customerId = await getBillingCustomerId(adapter, a.workspace_id);
      if (!customerId) return err("That workspace has no billing account.");

      // Tax is resolved from `config.tax` inside, like every other charge on the account:
      // a negotiated invoice is still a real invoice, and it carries the same rate and the
      // same mandatory mention as one raised by `buy_credits`.
      const sale = await sellCredits(customerId, a.workspace_id, opts.config, {
        credits: a.credits,
        amountMinor: Math.round(a.amount * 100),
        ...(a.description ? { description: a.description } : {}),
        ...(a.days_until_due ? { daysUntilDue: a.days_until_due } : {}),
        ...(a.purchase_order ? { purchaseOrder: a.purchase_order } : {}),
        ...(a.reference ? { idempotencyKey: `sell:${a.reference}` } : {}),
      });
      if (sale.status === "refused") return err(sale.message);

      return json({
        status: "invoiced",
        invoice_id: sale.invoiceId,
        invoice_url: sale.hostedInvoiceUrl,
        due_at: sale.dueAt,
        emailed: sale.emailed,
        // Said plainly, because an operator reading "sold" would reasonably assume the
        // credits are already there. They are not: the invoice.paid branch grants them.
        credits_on_payment: a.credits,
      });
    },
  );

  server.tool(
    "resolve_credit_quote",
    `Answer a credit quote (platform operators only). Approving raises a Stripe invoice for
\`amount\` and grants \`credits\` when it is PAID — the two are deliberately independent, which
is what makes a negotiated price possible. Denying records the decision and charges nothing.`,
    {
      workspace_id: z.string().describe("The workspace whose quote this is"),
      quote_id: z.string(),
      outcome: z.enum(["approved", "denied"]).default("approved"),
      credits: z.number().int().positive().optional().describe("What they get. Required to approve"),
      amount: z.number().positive().optional().describe("What they pay, in whole currency units. Required to approve"),
      valid_until: z.string().optional().describe("ISO date the price expires"),
      days_until_due: z.number().int().positive().optional().describe("Net terms on the invoice. Default 30"),
      note: z.string().max(280).optional(),
    },
    async (a) => {
      // FAILS CLOSED, unlike every other gate here: this one stands between a customer and
      // their own discount.
      const operator = enforceOperator("resolving a credit quote");
      if ("isError" in operator) return operator;

      if (a.outcome === "denied") {
        const res = await answerCreditQuote(adapter, a.workspace_id, {
          quoteId: a.quote_id,
          outcome: "denied",
          notify: opts.notify,
          ...(a.note ? { answer: { credits: 0, amountMinor: 0, currency: opts.config.currency, note: a.note } } : {}),
        });
        return res.ok ? json({ status: "denied", quote: res.quote }) : err("No open quote with that id.");
      }

      if (!a.credits || !a.amount) {
        return err("Approving needs both `credits` (what they get) and `amount` (what they pay).");
      }

      const customerId = await getBillingCustomerId(adapter, a.workspace_id);
      if (!customerId) return err("That workspace has no billing account.");

      const quotes = await listCreditQuotes(adapter, a.workspace_id);
      const open = quotes.find((q: VolumeQuote) => q.id === a.quote_id && q.status === "pending");
      if (!open) return err("No open quote with that id.");

      // The INVOICE first, then the record. A record saying "approved" with no invoice
      // behind it is a promise nobody can collect on; an invoice with no record is a bill
      // the customer can still pay, and the next approval is refused as a duplicate by
      // Stripe's idempotency key rather than billing them twice.
      // `config` carries the currency AND the tax declaration, so the negotiated invoice is
      // taxed by whatever decided every other charge on this account.
      const sale = await sellCredits(customerId, a.workspace_id, opts.config, {
        credits: a.credits,
        amountMinor: Math.round(a.amount * 100),
        description: `${a.credits.toLocaleString("en-US")} credits`,
        ...(a.days_until_due ? { daysUntilDue: a.days_until_due } : {}),
        ...(open.purchaseOrder ? { purchaseOrder: open.purchaseOrder } : {}),
        idempotencyKey: `quote:${a.quote_id}`,
      });
      if (sale.status === "refused") return err(sale.message);

      const res = await answerCreditQuote(adapter, a.workspace_id, {
        quoteId: a.quote_id,
        outcome: "approved",
        notify: opts.notify,
        answer: {
          credits: a.credits,
          amountMinor: Math.round(a.amount * 100),
          currency: opts.config.currency,
          invoiceId: sale.invoiceId,
          ...(sale.hostedInvoiceUrl ? { invoiceUrl: sale.hostedInvoiceUrl } : {}),
          ...(a.valid_until ? { validUntil: a.valid_until } : {}),
          ...(a.note ? { note: a.note } : {}),
        },
      });

      return json({
        status: "approved",
        invoice_url: sale.hostedInvoiceUrl,
        invoice_id: sale.invoiceId,
        due_at: sale.dueAt,
        emailed: sale.emailed,
        // The credits land when the invoice is PAID, through the same branch every other
        // invoice goes through. Said plainly, because "approved" reads like "granted".
        credits_on_payment: a.credits,
        quote: res.ok ? res.quote : null,
      });
    },
  );
}
