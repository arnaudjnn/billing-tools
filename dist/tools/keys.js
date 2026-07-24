import { z } from "zod";
import { enforceAccess } from "../auth.js";
import { sendMagicAuth, verifyMagicAuth } from "../magic-auth.js";
import { ensureStripeCustomer, stripeConfigured } from "../billing.js";
export function registerKeyTools(server, adapter, config) {
    server.tool("get_api_key", `Provisions or retrieves an API key for accessing protected tools.
Call with just an email to start authentication (sends a 6-digit code via email).
Then call again with the email and the code to complete authentication and receive your API key.
Add the key to your config as: "Authorization": "Bearer <key>"`, {
        email: z.string().email().describe("Your email address"),
        code: z.string().length(6).optional().describe("6-digit verification code from email"),
    }, async ({ email, code }) => {
        try {
            if (!code) {
                await sendMagicAuth(email);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "code_sent",
                                message: `A 6-digit verification code has been sent to ${email}. Call get_api_key again with your email and the code to get your API key.`,
                            }, null, 2),
                        },
                    ],
                };
            }
            const user = await verifyMagicAuth(email, code);
            const { orgId } = await adapter.ensureOrgForUser(user);
            if (stripeConfigured()) {
                await ensureStripeCustomer(adapter, orgId, email, config).catch(() => { });
            }
            const key = await adapter.mintApiKey(orgId, "API Key", user.id);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "ok",
                            message: "API key created successfully. Add it as an Authorization header. This key is only shown once.",
                            api_key: key.value,
                            usage: { header: `Authorization: Bearer ${key.value}` },
                        }, null, 2),
                    },
                ],
            };
        }
        catch (e) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Authentication error: ${e instanceof Error ? e.message : String(e)}`,
                    },
                ],
            };
        }
    });
    server.tool("list_api_keys", `Lists the API keys for your workspace (obfuscated values, never the full key).
Useful for finding stale keys to revoke. Free.`, {}, async () => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth)
            return auth;
        try {
            const keys = await adapter.listApiKeys(auth.orgId);
            return {
                content: [{ type: "text", text: JSON.stringify({ status: "ok", keys }, null, 2) }],
            };
        }
        catch (e) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `Failed to list keys: ${e instanceof Error ? e.message : String(e)}` },
                ],
            };
        }
    });
    server.tool("revoke_api_key", `Revokes (deletes) an API key by id. Use list_api_keys to find the id.
The revoked key stops working immediately. Free.`, { api_key_id: z.string().describe("The key id from list_api_keys") }, async ({ api_key_id }) => {
        const auth = await enforceAccess(adapter);
        if ("isError" in auth)
            return auth;
        try {
            const revoked = await adapter.revokeApiKey(auth.orgId, api_key_id);
            if (!revoked) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Key ${api_key_id} not found in this workspace.` }],
                };
            }
            return {
                content: [{ type: "text", text: JSON.stringify({ status: "ok", revoked }, null, 2) }],
            };
        }
        catch (e) {
            return {
                isError: true,
                content: [
                    { type: "text", text: `Failed to revoke key: ${e instanceof Error ? e.message : String(e)}` },
                ],
            };
        }
    });
}
//# sourceMappingURL=keys.js.map