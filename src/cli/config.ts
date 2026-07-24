import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";

// Parameterized CLI config store. The host supplies configDir (e.g. "~/.myapp"
// or an absolute path), an env-var prefix (e.g. "MYAPP" → MYAPP_API_KEY /
// MYAPP_API_URL), and a default base URL.

export interface CliOptions {
  configDir: string;
  envPrefix: string;
  defaultUrl: string;
}

export interface CliConfig {
  apiKey?: string;
  email?: string;
  baseUrl?: string;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : join(homedir(), p);
}

export function configPath(opts: CliOptions): string {
  return join(expandHome(opts.configDir), "config.json");
}

export function readConfig(opts: CliOptions): CliConfig {
  const p = configPath(opts);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(opts: CliOptions, c: CliConfig): void {
  const p = configPath(opts);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2));
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
}

export function resolveBaseUrl(opts: CliOptions, cliUrl?: string): string {
  return cliUrl || process.env[`${opts.envPrefix}_API_URL`] || readConfig(opts).baseUrl || opts.defaultUrl;
}

export function resolveApiKey(opts: CliOptions, cliKey?: string): string | undefined {
  return cliKey || process.env[`${opts.envPrefix}_API_KEY`] || readConfig(opts).apiKey;
}
