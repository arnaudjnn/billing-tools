import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BillingAdapter, ResolvedConfig } from "../types.js";
import { currentPrincipal, enforceAccess } from "../auth.js";
import { sendMagicAuth, verifyMagicAuth } from "../magic-auth.js";
import { ensureStripeCustomer, stripeConfigured } from "../billing.js";

export function registerKeyTools(
  server: McpServer,
  adapter: BillingAdapter,
  config: ResolvedConfig,
) {
  server.tool(
    "get_api_key",
    `Provisions or retrieves an API key for accessing protected tools.
Call with just an email to start authentication (sends a 6-digit code via email).
Then call again with the email and the code to complete authentication and receive your API key.
Add the key to your config as: "Authorization": "Bearer <key>"`,
    {
      email: z.string().email().describe("Your email address"),
      code: z.string().length(6).optional().describe("6-digit verification code from email"),
    },
    async ({ email, code }) => {
      try {
        if (!code) {
          await sendMagicAuth(email);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "code_sent",
                    message: `A 6-digit verification code has been sent to ${email}. Call get_api_key again with your email and the code to get your API key.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const user = await verifyMagicAuth(email, code);
        const { orgId } = await adapter.ensureOrgForUser(user);
        if (stripeConfigured()) {
          await ensureStripeCustomer(adapter, orgId, email, config).catch(() => {});
        }
        const key = await adapter.mintApiKey(orgId, "API Key", user.id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "ok",
                  message:
                    "API key created successfully. Add it as an Authorization header. This key is only shown once.",
                  api_key: key.value,
                  usage: { header: `Authorization: Bearer ${key.value}` },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Authentication error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "create_api_key",
    `Creates an ADDITIONAL API key for the workspace you are already authenticated to, with a
name of your choosing. The value is shown once and never again.

Use this rather than get_api_key when you already hold a key: get_api_key is the
email-verification flow for a caller with none, and it names what it mints "API Key" — so a
workspace with several of them cannot tell from list_api_keys which is which, and cannot
safely revoke one. Free.`,
    {
      name: z
        .string()
        .min(1)
        .max(80)
        .describe(`What this key is for — "CI", "staging worker". Shown by list_api_keys`),
    },
    async ({ name }) => {
      // Not admin-gated, deliberately: whoever holds a key for this workspace can already do
      // everything a new key could, so refusing them a second one protects nothing. What it
      // DOES need is an existing key, which is what `enforceAccess` means here.
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      try {
        const key = await adapter.mintApiKey(auth.orgId, name.trim(), currentPrincipal()?.userId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "ok",
                  id: key.id,
                  name: name.trim(),
                  api_key: key.value,
                  message: "This key is only shown once. Store it now.",
                  usage: { header: `Authorization: Bearer ${key.value}` },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to create key: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_api_keys",
    `Lists the API keys for your workspace (obfuscated values, never the full key).
Useful for finding stale keys to revoke. Free.`,
    {},
    async () => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      try {
        const keys = await adapter.listApiKeys(auth.orgId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", keys }, null, 2) }],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Failed to list keys: ${e instanceof Error ? e.message : String(e)}` },
          ],
        };
      }
    },
  );

  server.tool(
    "revoke_api_key",
    `Revokes (deletes) an API key by id. Use list_api_keys to find the id.
The revoked key stops working immediately. Free.`,
    { api_key_id: z.string().describe("The key id from list_api_keys") },
    async ({ api_key_id }) => {
      const auth = await enforceAccess(adapter);
      if ("isError" in auth) return auth;
      try {
        const revoked = await adapter.revokeApiKey(auth.orgId, api_key_id);
        if (!revoked) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Key ${api_key_id} not found in this workspace.` }],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", revoked }, null, 2) }],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Failed to revoke key: ${e instanceof Error ? e.message : String(e)}` },
          ],
        };
      }
    },
  );
}
