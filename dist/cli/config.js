import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
function expandHome(p) {
    if (p === "~" || p.startsWith("~/"))
        return join(homedir(), p.slice(1));
    return isAbsolute(p) ? p : join(homedir(), p);
}
export function configPath(opts) {
    return join(expandHome(opts.configDir), "config.json");
}
export function readConfig(opts) {
    const p = configPath(opts);
    if (!existsSync(p))
        return {};
    try {
        return JSON.parse(readFileSync(p, "utf-8"));
    }
    catch {
        return {};
    }
}
export function writeConfig(opts, c) {
    const p = configPath(opts);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(c, null, 2));
    try {
        chmodSync(p, 0o600);
    }
    catch {
        /* best effort */
    }
}
export function resolveBaseUrl(opts, cliUrl) {
    return cliUrl || process.env[`${opts.envPrefix}_API_URL`] || readConfig(opts).baseUrl || opts.defaultUrl;
}
export function resolveApiKey(opts, cliKey) {
    return cliKey || process.env[`${opts.envPrefix}_API_KEY`] || readConfig(opts).apiKey;
}
//# sourceMappingURL=config.js.map