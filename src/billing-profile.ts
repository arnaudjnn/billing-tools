import { getStripe } from "./billing.js";
import type { BillingAdapter } from "./types.js";
import { COMPANY_NAME_MAX, INVOICE_EMAIL_MAX } from "./ui/limits.js";

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

/** A postal address, in Stripe's field names. */
export type BillingAddress = {
  line1: string;
  line2?: string | null;
  city?: string | null;
  /** State / province / region. */
  state?: string | null;
  postal_code?: string | null;
  /** Two-letter ISO country. */
  country: string;
};

export type BillingProfile = {
  /** Where Stripe mails invoices. Null when never overridden. */
  invoiceEmail: string | null;
  /** Company name printed on the invoice. Null when never overridden. */
  companyName: string | null;
  /**
   * Billing address printed on the invoice.
   *
   * Not cosmetic: it is also what decides VAT on a sale, so changing it changes
   * what future invoices charge.
   */
  address: BillingAddress | null;
  /**
   * Language for invoices, receipts, credit notes and the hosted invoice page.
   *
   * Stripe stores an ordered LIST of preferred locales; this exposes the first,
   * because a settings UI asks for one language and round-tripping a list
   * through a single select would silently drop the rest.
   */
  invoiceLocale: string | null;
};

const EMPTY: BillingProfile = {
  invoiceEmail: null,
  companyName: null,
  address: null,
  invoiceLocale: null,
};

/** Stripe returns every address field, nulled out, even when none was set. */
function readAddress(a: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
} | null | undefined): BillingAddress | null {
  if (!a?.line1 || !a.country) return null;
  return {
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    postal_code: a.postal_code ?? null,
    country: a.country,
  };
}

// Re-exported from the client-safe leaf so server and form agree on one number.
export { COMPANY_NAME_MAX, INVOICE_EMAIL_MAX } from "./ui/limits.js";

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
    address: readAddress(customer.address),
    invoiceLocale: customer.preferred_locales?.[0] ?? null,
  };
}

/**
 * Set or clear the invoice recipient, company name, address and language.
 *
 * Only the keys you pass are touched, so saving one field can't silently wipe
 * the other. Passing null (or an empty string) clears that field back to the
 * app's default.
 */
export async function updateBillingProfile(
  adapter: BillingAdapter,
  orgId: string,
  patch: {
    invoiceEmail?: string | null;
    companyName?: string | null;
    address?: BillingAddress | null;
    invoiceLocale?: string | null;
  },
): Promise<BillingProfile> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) throw new Error("No billing customer for this organization");

  // Stripe clears these with an EMPTY STRING, not null — the SDK types reject
  // null, and sending it would be a no-op if they didn't.
  const update: {
    email?: string;
    name?: string;
    address?: {
      line1: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country: string;
    } | null;
    preferred_locales?: string[];
  } = {};

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

  if (patch.address !== undefined) {
    if (patch.address && (!patch.address.line1?.trim() || !patch.address.country)) {
      throw new Error("A billing address needs at least a street and a country");
    }
    // null (not "") is how Stripe clears an address — the opposite of the
    // string fields above. Sub-fields must be omitted rather than nulled, so
    // an unset line2 disappears instead of being sent as null.
    update.address = patch.address
      ? {
          line1: patch.address.line1.trim(),
          country: patch.address.country,
          ...(patch.address.line2 ? { line2: patch.address.line2 } : {}),
          ...(patch.address.city ? { city: patch.address.city } : {}),
          ...(patch.address.state ? { state: patch.address.state } : {}),
          ...(patch.address.postal_code
            ? { postal_code: patch.address.postal_code }
            : {}),
        }
      : null;
  }

  if (patch.invoiceLocale !== undefined) {
    const locale = patch.invoiceLocale?.trim() || null;
    // An empty LIST is how Stripe clears the preference, falling back to its
    // own default (English) rather than leaving the previous language pinned.
    update.preferred_locales = locale ? [locale] : [];
  }

  if (Object.keys(update).length === 0) return getBillingProfile(adapter, orgId);

  const customer = await getStripe().customers.update(customerId, update);
  return {
    invoiceEmail: customer.email || null,
    companyName: customer.name || null,
    address: readAddress(customer.address),
    invoiceLocale: customer.preferred_locales?.[0] ?? null,
  };
}
