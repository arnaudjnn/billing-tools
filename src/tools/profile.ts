import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { enforceAccess, enforceAdmin } from "../auth.js";
import { stripeConfigured } from "../billing.js";
import { getBillingProfile, updateBillingProfile } from "../billing-profile.js";
import {
  detachPaymentMethod,
  listPaymentMethods,
  setDefaultPaymentMethod,
} from "../payment-methods.js";
import { listCustomerTaxIds, setCustomerTaxId } from "../tax-ids.js";
import type { BillingAdapter } from "../types.js";

// The billing account itself: who the invoice is addressed to, what card pays
// it, and the tax id printed on it. All three existed as library functions and
// as app UI, and none was reachable from an API, a CLI or an agent — so a
// customer could be invoiced to the wrong address by every surface except the
// one they were using.
//
// Adding a CARD stays out on purpose: it needs a SetupIntent confirmed in a
// browser with Stripe.js. `get_billing_portal` is the headless answer, and it is
// already a tool.

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
// Only used to infer `eu_vat`, which is the one type derivable from a country
// alone. Anything else must be named by the caller.
const EU = new Set(
  ("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE").split(" "),
);

function err(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function registerProfileTools(server: McpServer, adapter: BillingAdapter) {
  server.tool(
    "get_billing_profile",
    `The workspace's billing details: invoice recipient, company name, billing address
(which decides the VAT charged), invoice language, and any tax id on file.`,
    {},
    async () => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      const [profile, taxIds] = await Promise.all([
        getBillingProfile(adapter, auth.orgId),
        listCustomerTaxIds(adapter, auth.orgId).catch(() => []),
      ]);
      return json({
        invoice_email: profile.invoiceEmail,
        company_name: profile.companyName,
        address: profile.address,
        invoice_locale: profile.invoiceLocale,
        tax_ids: taxIds,
      });
    },
  );

  server.tool(
    "set_billing_profile",
    `Update the billing details. Only the fields you pass are changed; pass an empty
string to clear one. The address determines the tax charged on future invoices —
Stripe does not reissue invoices already sent.`,
    {
      invoice_email: z.string().optional().describe("Where invoices are emailed"),
      company_name: z.string().optional().describe("Name printed on the invoice"),
      invoice_locale: z.string().optional().describe('Invoice language, e.g. "it" or "en"'),
      address_line1: z.string().optional(),
      address_line2: z.string().optional(),
      address_city: z.string().optional(),
      address_state: z.string().optional(),
      address_postal_code: z.string().optional(),
      address_country: z.string().optional().describe("Two-letter country code, e.g. IT"),
    },
    async (args) => {
      const auth = await enforceAdmin(adapter, "set_billing_profile");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");

      // An address is all-or-nothing in Stripe (line1 + country are required), so
      // a partial patch would be rejected. Merge onto what is already stored.
      const anyAddress = [
        args.address_line1,
        args.address_line2,
        args.address_city,
        args.address_state,
        args.address_postal_code,
        args.address_country,
      ].some((v) => v !== undefined);

      let address;
      if (anyAddress) {
        const current = (await getBillingProfile(adapter, auth.orgId)).address;
        const line1 = args.address_line1 ?? current?.line1;
        const country = args.address_country ?? current?.country;
        if (!line1 || !country) {
          return err("An address needs at least address_line1 and address_country.");
        }
        address = {
          line1,
          line2: args.address_line2 ?? current?.line2 ?? undefined,
          city: args.address_city ?? current?.city ?? undefined,
          state: args.address_state ?? current?.state ?? undefined,
          postal_code: args.address_postal_code ?? current?.postal_code ?? undefined,
          country,
        };
      }

      const updated = await updateBillingProfile(adapter, auth.orgId, {
        invoiceEmail: args.invoice_email,
        companyName: args.company_name,
        invoiceLocale: args.invoice_locale,
        ...(address ? { address } : {}),
      });
      return json({
        status: "ok",
        invoice_email: updated.invoiceEmail,
        company_name: updated.companyName,
        address: updated.address,
        invoice_locale: updated.invoiceLocale,
      });
    },
  );

  server.tool(
    "set_tax_id",
    `Set the workspace's tax id (VAT number) as printed on invoices. It applies from
the next invoice issued — Stripe does not regenerate ones already sent. Pass an
empty value to remove it.`,
    {
      value: z.string().describe('The tax id, e.g. "IT01234567890". Empty to remove'),
      type: z.string().optional().describe('Stripe tax id type, e.g. "eu_vat". Inferred from the country when omitted'),
    },
    async ({ value, type }) => {
      const auth = await enforceAdmin(adapter, "set_tax_id");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      try {
        let resolvedType = type;
        if (value && !resolvedType) {
          const country = (await getBillingProfile(adapter, auth.orgId)).address?.country?.toUpperCase();
          resolvedType = country && EU.has(country) ? "eu_vat" : undefined;
          if (!resolvedType) {
            return err(
              "Cannot infer the tax id type from the billing address — pass `type` (see Stripe's tax id types).",
            );
          }
        }
        const r = await setCustomerTaxId(
          adapter,
          auth.orgId,
          value && resolvedType ? { value, type: resolvedType } : null,
        );
        return json({ status: "ok", tax_ids: r });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "list_payment_methods",
    `The cards saved for this workspace, and which one is the default that
subscription and usage charges are billed to.`,
    {},
    async () => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      return json({ cards: await listPaymentMethods(adapter, auth.orgId) });
    },
  );

  server.tool(
    "set_default_payment_method",
    `Choose which saved card future charges are billed to. Use get_billing_portal to
ADD a card — that needs a browser to confirm it with Stripe.`,
    { payment_method_id: z.string().describe("Card id from list_payment_methods") },
    async ({ payment_method_id }) => {
      const auth = await enforceAdmin(adapter, "set_default_payment_method");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      try {
        await setDefaultPaymentMethod(adapter, auth.orgId, payment_method_id);
        return json({ status: "ok", default_payment_method: payment_method_id });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "remove_payment_method",
    `Remove a saved card. Removing the default is refused while another card exists —
Stripe does not promote a replacement, so the next invoice would simply fail.`,
    { payment_method_id: z.string().describe("Card id from list_payment_methods") },
    async ({ payment_method_id }) => {
      const auth = await enforceAdmin(adapter, "remove_payment_method");
      if ("isError" in auth) return auth;
      if (!stripeConfigured()) return err("Billing is not configured (STRIPE_SECRET_KEY unset).");
      try {
        await detachPaymentMethod(adapter, auth.orgId, payment_method_id);
        return json({ status: "removed", payment_method_id });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
