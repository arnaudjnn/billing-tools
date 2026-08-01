import { getStripe } from "./billing.js";
import type { BillingAdapter } from "./types.js";

// The tax id printed on the customer's invoices.
//
// A Stripe Customer Tax ID is its own object, not a field: created and deleted,
// never edited. So "changing" one is delete-then-create, which is what
// `setCustomerTaxId` does — and why it takes the whole value rather than a
// patch.
//
// Distinct from the tax id collected during CHECKOUT, which exists to decide
// whether that sale is reverse-charged. This is the standing one: it lands on
// every future invoice, and Stripe validates it in the background (`verification`
// goes `pending` → `verified` / `unverified` for EU VAT).
//
// Note Stripe does NOT re-run tax logic on past invoices when this changes; it
// applies from the next one.

export type CustomerTaxId = {
  id: string;
  /** Stripe's `tax_id.type`, e.g. "eu_vat". */
  type: string;
  value: string;
  /** "pending" | "verified" | "unverified" | "unavailable", when Stripe checks. */
  verification: string | null;
  /** Registered name Stripe got back from the tax authority, when it checks. */
  verifiedName: string | null;
};

/** The customer's tax ids, newest first. Empty when billing never started. */
export async function listCustomerTaxIds(
  adapter: BillingAdapter,
  orgId: string,
): Promise<CustomerTaxId[]> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) return [];

  const { data } = await getStripe().customers.listTaxIds(customerId, {
    limit: 20,
  });
  return data.map((t) => ({
    id: t.id,
    type: t.type,
    value: t.value,
    verification: t.verification?.status ?? null,
    verifiedName: t.verification?.verified_name ?? null,
  }));
}

/**
 * Replace the customer's tax id with this one, or remove it when value is empty.
 *
 * Singular on purpose: Stripe allows several, but an invoice shows them all and
 * a settings screen that asks for "your tax id" implies one. Keeping it to one
 * also means this can be idempotent — the old ids go, the new one arrives —
 * instead of quietly accumulating duplicates every time someone corrects a typo.
 */
export async function setCustomerTaxId(
  adapter: BillingAdapter,
  orgId: string,
  input: { type: string; value: string } | null,
): Promise<CustomerTaxId | null> {
  const customerId = await adapter.getBillingCustomerId(orgId);
  if (!customerId) throw new Error("No billing customer for this organization");
  const stripe = getStripe();

  const existing = await stripe.customers.listTaxIds(customerId, { limit: 20 });
  const value = input?.value.trim();

  // Delete first: Stripe rejects a duplicate (same type AND value), so a
  // re-save of an unchanged id would fail if the old one were still there.
  await Promise.all(
    existing.data.map((t) => stripe.customers.deleteTaxId(customerId, t.id)),
  );
  if (!input || !value) return null;

  const created = await stripe.customers.createTaxId(customerId, {
    type: input.type as Parameters<
      typeof stripe.customers.createTaxId
    >[1]["type"],
    value,
  });
  return {
    id: created.id,
    type: created.type,
    value: created.value,
    verification: created.verification?.status ?? null,
    verifiedName: created.verification?.verified_name ?? null,
  };
}
