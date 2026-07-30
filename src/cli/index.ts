// Lightweight CLI barrel. A consumer CLI (compiled to a standalone binary)
// imports from "@arnaudjnn/billing-tools/cli" to get the HTTP client, the config
// store, and the shared billing commands WITHOUT pulling the package root (which
// drags in Stripe / WorkOS / MCP SDKs). Keep this module free of server deps.
export { callTool, listTools, type ApiClientConfig } from "./client.js";
export {
  type CliOptions,
  type CliConfig,
  configPath,
  readConfig,
  writeConfig,
  resolveBaseUrl,
  resolveApiKey,
} from "./config.js";
export { registerBillingCommands } from "./commands.js";
