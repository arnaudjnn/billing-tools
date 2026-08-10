import type { BillingAdapter } from "./types.js";
import type { Notify } from "./notifications/index.js";

// Selling credits at a price nobody published.
//
// Every other way to get credits in this library is self-serve at one rate: `CREDITS_PER_UNIT`
// is a constant, deliberately, so a customer typing an amount and an agent calling
// `buy_credits` cannot be quoted differently. That is right for the top-up and wrong for the
// only deal that matters commercially — the one where somebody wants 600 000 credits and a
// number to take to their finance department.
//
// A plan marked `sale: "quote"` said exactly as much and could do nothing about it: the CTA
// renders "contact us", `validateBasket` refuses to sell it, and there the trail ended. No
// record of who asked, no way to answer, and no credit sale anywhere that could carry a
// negotiated price.
//
// ── The two halves are deliberately not the same person ──────────────────────
//
// A workspace ADMIN asks. A platform OPERATOR answers — not an admin of that workspace,
// because "approve my own discount" is not a permission that should exist. `enforceOperator`
// is the only gate in this library that fails CLOSED, for the same reason the last-admin rule
// does: what it prevents IS the harm.
//
// ── Approving is an invoice, not a grant ─────────────────────────────────────
//
// The credits are not handed over on approval. `sellCredits` raises a Stripe invoice whose
// AMOUNT is the negotiated price and whose `metadata.credits` is the negotiated quantity —
// two numbers that every other path forces to be equal. Paying it credits the wallet through
// the `invoice.paid` branch that already exists, with the idempotency key it already uses. So
// there is no second crediting path to keep in step with the first, and an unpaid quote
// grants nothing.

/**
 * What the customer is asking for, and what a salesperson needs to answer it.
 *
 * NOT `CreditQuote` — that name is taken, by the tax estimate `quoteCreditPurchase` returns
 * for a self-serve top-up. Two records called the same thing in one barrel is how somebody
 * imports the wrong one and finds out at runtime; the same reason `plan-model`'s Quantity and
 * `checkout`'s stayed distinct.
 */
export interface VolumeQuote {
  id: string;
  /** Who asked — an admin of the workspace. */
  memberId: string;
  createdAt: string;
  status: "pending" | "approved" | "denied";

  /** How much they want. Credits when they think in credits. */
  credits?: number;
  /**
   * What they actually said, when they do not.
   *
   * Buyers think in searches, documents or seats per month, not in credits — asking them to
   * convert is asking them to price the product on our behalf. Stored as they said it, so a
   * quote can be answered in the terms it was asked in.
   */
  volume?: { amount: number; unit: string; per: "month" | "year" };
  /** One purchase, or a commitment. Decides whether the answer is an invoice or a contract. */
  term: "one_off" | "monthly" | "annual";
  /** How many people. An Enterprise deal is seats × usage; the seats half is already known
   *  to the workspace, and this is what they expect to GROW to. */
  seats?: number;
  /** What they expect to pay, in minor units. Optional, and the single most useful field on
   *  the form: it anchors the negotiation and tells an operator whether the ask is a discount
   *  request or simply a big order. */
  budgetMinor?: number;
  /** ISO date. Urgency, and whether this can wait for a contract cycle. */
  neededBy?: string;
  /** Italian B2B is bank transfer against an invoice far more often than a card. */
  paymentMethod: "invoice" | "card";
  /** Procurement blocks payment without it, and it has to be on the invoice, not in an email. */
  purchaseOrder?: string;
  /** Why. The qualifying signal, and the first thing a human reads. */
  note?: string;

  /** What the operator decided. */
  answer?: QuoteAnswer;
}

export interface QuoteAnswer {
    credits: number;
    amountMinor: number;
    currency: string;
    /** ISO date the quote stops being honoured. A price with no expiry is a price for ever. */
    validUntil?: string;
    invoiceId?: string;
    invoiceUrl?: string;
  note?: string;
  at: string;
}

const QUOTES_KEY = "btCreditQuotes";
/** WorkOS metadata values are 600 chars. Same ceiling, same shedding discipline as the
 *  top-up queue and the plan-request queue. */
const VALUE_LIMIT = 600;

async function read(adapter: BillingAdapter, orgId: string): Promise<VolumeQuote[]> {
  const md = (await adapter.getOrgMetadata?.(orgId)) ?? {};
  try {
    const parsed = JSON.parse(md[QUOTES_KEY] ?? "[]") as VolumeQuote[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fit the queue into one metadata value, shedding what costs least to lose:
 * notes on settled quotes, then settled quotes, then notes on pending ones.
 *
 * A PENDING quote is never dropped. Somebody is waiting on a price, and losing the question
 * means they wait for ever — so past that point the write fails and the caller is refused,
 * which is the rule `plan-request.ts` arrived at the same way.
 */
function pack(list: VolumeQuote[]): { kept: VolumeQuote[]; fits: boolean } {
  const size = (l: VolumeQuote[]) => JSON.stringify(l).length;
  const pendingFirst = [...list].sort(
    (a, b) => Number(a.status !== "pending") - Number(b.status !== "pending"),
  );
  let kept = pendingFirst;
  if (size(kept) <= VALUE_LIMIT) return { kept, fits: true };

  const strip = (q: VolumeQuote) => {
    const { note: _n, purchaseOrder: _p, ...rest } = q;
    return rest as VolumeQuote;
  };
  kept = kept.map((q) => (q.status === "pending" ? q : strip(q)));
  while (size(kept) > VALUE_LIMIT) {
    const settledAt = kept.map((q) => q.status !== "pending").lastIndexOf(true);
    if (settledAt === -1) break;
    kept = kept.filter((_, i) => i !== settledAt);
  }
  if (size(kept) > VALUE_LIMIT) kept = kept.map(strip);
  return { kept, fits: size(kept) <= VALUE_LIMIT };
}

async function write(adapter: BillingAdapter, orgId: string, list: VolumeQuote[]): Promise<boolean> {
  const { kept, fits } = pack(list);
  if (!fits) return false;
  await adapter.setOrgMetadata?.(orgId, { [QUOTES_KEY]: JSON.stringify(kept) });
  return true;
}

/** Every quote this workspace has asked for, newest first. */
export async function listCreditQuotes(
  adapter: BillingAdapter,
  orgId: string,
): Promise<VolumeQuote[]> {
  return (await read(adapter, orgId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type QuoteAsk = Omit<VolumeQuote, "id" | "memberId" | "createdAt" | "status" | "answer"> & {
  id?: string;
  now?: number;
};

/**
 * File an ask. One open quote per workspace.
 *
 * Not per member, unlike the top-up: a quote is the WORKSPACE's commercial conversation, and
 * two admins asking separately would put an operator in the position of answering the same
 * customer twice with two prices.
 */
export async function requestCreditQuote(
  adapter: BillingAdapter,
  orgId: string,
  input: QuoteAsk & { memberId: string; notify?: Notify },
): Promise<
  | { ok: true; quote: VolumeQuote }
  | { ok: false; reason: "already_pending" | "queue_full" | "nothing_asked"; pending?: VolumeQuote }
> {
  const { memberId, notify, id, now, ...ask } = input;
  // A quote with neither a quantity nor a volume is a question nobody can answer.
  if (!ask.credits && !ask.volume) return { ok: false, reason: "nothing_asked" };

  const list = await read(adapter, orgId);
  const open = list.find((q) => q.status === "pending");
  if (open) return { ok: false, reason: "already_pending", pending: open };

  const quote: VolumeQuote = {
    id: id ?? crypto.randomUUID(),
    memberId,
    createdAt: new Date(now ?? Date.now()).toISOString(),
    status: "pending",
    ...ask,
    ...(ask.note ? { note: ask.note.slice(0, 280) } : {}),
  };
  if (!(await write(adapter, orgId, [...list, quote]))) return { ok: false, reason: "queue_full" };

  // The operators, not the workspace's own admins: this is the one ask in the library whose
  // audience is on our side of the transaction.
  notify?.({
    id: `quote-requested:${quote.id}`,
    type: "quote.requested",
    orgId,
    to: [],
    data: { quoteId: quote.id, member: { id: memberId, email: null }, quote },
  });
  return { ok: true, quote };
}

/** Record the operator's answer. The MONEY half is `sellCredits`; this is the record. */
export async function answerCreditQuote(
  adapter: BillingAdapter,
  orgId: string,
  input: {
    quoteId: string;
    outcome: "approved" | "denied";
    answer?: Omit<QuoteAnswer, "at"> & { at?: string };
    now?: number;
    notify?: Notify;
  },
): Promise<{ ok: true; quote: VolumeQuote } | { ok: false; reason: "not_found" | "queue_full" }> {
  const list = await read(adapter, orgId);
  const found = list.find((q) => q.id === input.quoteId && q.status === "pending");
  if (!found) return { ok: false, reason: "not_found" };

  const updated: VolumeQuote = {
    ...found,
    status: input.outcome,
    ...(input.answer
      ? { answer: { ...input.answer, at: input.answer.at ?? new Date(input.now ?? Date.now()).toISOString() } }
      : {}),
  };
  if (!(await write(adapter, orgId, list.map((q) => (q.id === updated.id ? updated : q))))) {
    return { ok: false, reason: "queue_full" };
  }

  input.notify?.({
    // The outcome is in the id: a denial is not a redelivery of an approval.
    id: `quote-${input.outcome}:${updated.id}`,
    type: "quote.resolved",
    orgId,
    to: [],
    audience: { kind: "member", memberId: updated.memberId },
    data: { quoteId: updated.id, member: { id: updated.memberId, email: null }, quote: updated },
  });
  return { ok: true, quote: updated };
}
