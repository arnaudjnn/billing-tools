import { getStripe } from "./billing.js";
import type { BillingAdapter } from "./types.js";

// Who the invoice goes to, and whose name is on it.
//
// Both live on the Stripe Customer rather than in an app database, because
// Stripe is what actually sends the invoice: `email` is the address it mails
// to, `name` is the line printed on the document. Storing a second copy
// somewhere else would create a value that looks authoritative in the UI while
// the real invoice used a different one.
//
// Both are optional overrides. Cleared (null / empty), the app falls back to
// whatever default it shows — typically the workspace owner's email and the
// workspace name — so an empty field means "use the default", not "blank".

export type BillingProfile = {
  /** Where Stripe mails invoices. Null when never overridden. */
  invoiceEmail: string | null;
  /** Company name printed on the invoice. Null when never overridden. */
  companyName: string | null;
};

const EMPTY: BillingProfile = { invoiceEmail: null, companyName: null };

/** Stripe's documented limits. Longer values are rejected by the API. */
export const INVOICE_EMAIL_MAX = 254;
export const COMPANY_NAME_MAX = 64;

export async function getBillingProfile(
  adapter: BillingAdapter,
  orgId: string,
): Promise<BillingProfile> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) return EMPTY;

  const customer = await getStripe().customers.retrieve(customerId);
  if (customer.deleted) return EMPTY;
  return {
    invoiceEmail: customer.email || null,
    companyName: customer.name || null,
  };
}

/**
 * Set or clear the invoice recipient and company name.
 *
 * Only the keys you pass are touched, so saving one field can't silently wipe
 * the other. Passing null (or an empty string) clears that field back to the
 * app's default.
 */
export async function updateBillingProfile(
  adapter: BillingAdapter,
  orgId: string,
  patch: { invoiceEmail?: string | null; companyName?: string | null },
): Promise<BillingProfile> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) throw new Error("No billing customer for this organization");

  // Stripe clears these with an EMPTY STRING, not null — the SDK types reject
  // null, and sending it would be a no-op if they didn't.
  const update: { email?: string; name?: string } = {};

  if (patch.invoiceEmail !== undefined) {
    const email = patch.invoiceEmail?.trim() || null;
    if (email && email.length > INVOICE_EMAIL_MAX) {
      throw new Error(`Email must be at most ${INVOICE_EMAIL_MAX} characters`);
    }
    // Deliberately shallow: a full RFC check belongs to whoever renders the
    // field, and Stripe rejects malformed addresses anyway. This only catches
    // the case that would otherwise silently mail invoices nowhere.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("That doesn't look like an email address");
    }
    update.email = email ?? "";
  }

  if (patch.companyName !== undefined) {
    const name = patch.companyName?.trim() || null;
    if (name && name.length > COMPANY_NAME_MAX) {
      throw new Error(`Name must be at most ${COMPANY_NAME_MAX} characters`);
    }
    update.name = name ?? "";
  }

  if (Object.keys(update).length === 0) return getBillingProfile(adapter, orgId);

  const customer = await getStripe().customers.update(customerId, update);
  return {
    invoiceEmail: customer.email || null,
    companyName: customer.name || null,
  };
}
