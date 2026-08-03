import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const run = promisify(execFile);

// Everything a developer needs to receive Stripe webhooks locally, without a
// tunnel, a registered endpoint, or a Dashboard visit.
//
// NODE-ONLY, and behind its own entry point (`@arnaudjnn/billing-tools/dev`)
// so child_process and fs never follow the library into a server bundle.
//
// Two things make the "one command" possible:
//
//  - `stripe listen` needs no `stripe login`. Login is an interactive browser
//    pairing and can't be scripted, but `--api-key` bypasses it entirely, and
//    the key is already in the environment.
//  - The CLI is a single static binary published on Stripe's GitHub releases,
//    so it can be fetched into a project-local cache instead of requiring
//    Homebrew and a global install.

const CACHE_DIR = join(homedir(), ".cache", "billing-tools", "stripe-cli");

/** Asset naming used by github.com/stripe/stripe-cli releases. */
function assetPattern(): { os: string; cpu: string; ext: string } | null {
  const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x86_64" : null;
  if (!cpu) return null;
  switch (platform()) {
    case "darwin":
      return { os: "mac-os", cpu, ext: ".tar.gz" };
    case "linux":
      return { os: "linux", cpu, ext: ".tar.gz" };
    default:
      // Windows ships a .zip and no tar; scoop is the sane path there.
      return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function onPath(): Promise<string | null> {
  try {
    await run("stripe", ["--version"]);
    return "stripe";
  } catch {
    return null;
  }
}

/**
 * Absolute path to a usable `stripe` binary, downloading it if needed.
 *
 * Order: an existing install on PATH (respect what the developer already has) →
 * this package's cache → download from Stripe's GitHub releases into the cache.
 * Nothing is installed globally and nothing outside the cache is touched.
 */
export async function resolveStripeCli(
  opts: { log?: (msg: string) => void; allowDownload?: boolean } = {},
): Promise<string> {
  const log = opts.log ?? (() => {});

  const found = await onPath();
  if (found) return found;

  const cached = join(CACHE_DIR, platform() === "win32" ? "stripe.exe" : "stripe");
  if (await exists(cached)) return cached;

  if (opts.allowDownload === false) {
    throw new Error(
      "The Stripe CLI is not installed. Install it (brew install stripe/stripe-cli/stripe) " +
        "or allow this to download it.",
    );
  }

  const target = assetPattern();
  if (!target) {
    throw new Error(
      `No prebuilt Stripe CLI for ${platform()}/${arch()}. Install it manually: ` +
        "https://docs.stripe.com/stripe-cli#install",
    );
  }

  // Resolve the newest release, then the asset matching this platform.
  const release = (await fetch(
    "https://api.github.com/repos/stripe/stripe-cli/releases/latest",
    { headers: { accept: "application/vnd.github+json" } },
  ).then((r) => r.json())) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };

  const asset = release.assets?.find(
    (a) => a.name.includes(target.os) && a.name.includes(target.cpu) && a.name.endsWith(target.ext),
  );
  if (!asset) {
    throw new Error(
      `No Stripe CLI asset for ${target.os}/${target.cpu} in ${release.tag_name ?? "latest"}`,
    );
  }

  log(`Downloading the Stripe CLI (${release.tag_name}, ${target.os}/${target.cpu})…`);
  await mkdir(CACHE_DIR, { recursive: true });
  const tarball = join(CACHE_DIR, asset.name);
  const res = await fetch(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tarball));

  await run("tar", ["-xzf", tarball, "-C", CACHE_DIR, "stripe"]);
  await chmod(cached, 0o755);
  // Prove it runs before handing it back — a truncated download otherwise
  // surfaces as an inscrutable failure inside `listen`.
  const { stdout } = await run(cached, ["--version"]);
  log(`Stripe CLI ready: ${stdout.trim()} (${cached})`);
  return cached;
}

export type Listener = {
  /** The signing secret for THIS session — not the registered endpoint's. */
  secret: string;
  /** Stop forwarding. */
  stop: () => void;
};

/**
 * Start `stripe listen` and resolve once it reports its signing secret.
 *
 * No endpoint is registered and no tunnel is opened: the CLI holds an outbound
 * connection to Stripe and forwards events to `forwardTo`.
 */
export async function listenForWebhooks(opts: {
  /** e.g. http://localhost:3000/api/stripe/webhook */
  forwardTo: string;
  /** Defaults to STRIPE_SECRET_KEY. Passing it avoids the interactive login. */
  apiKey?: string;
  /** Restrict forwarding to these event types. */
  events?: readonly string[];
  log?: (msg: string) => void;
  /** Fail if no secret appears within this long. Default 30s. */
  timeoutMs?: number;
}): Promise<Listener> {
  const log = opts.log ?? (() => {});
  const apiKey = opts.apiKey ?? process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error("No STRIPE_SECRET_KEY — needed so `stripe listen` can skip login");

  const bin = await resolveStripeCli({ log });
  const args = [
    "listen",
    "--api-key",
    apiKey,
    "--forward-to",
    opts.forwardTo,
    ...(opts.events?.length ? ["--events", opts.events.join(",")] : []),
  ];

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => child.kill("SIGINT");

  return await new Promise<Listener>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("`stripe listen` produced no signing secret within the timeout"));
    }, opts.timeoutMs ?? 30_000);

    let settled = false;
    // The CLI announces the secret on startup, then streams received events.
    const scan = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) if (line.trim()) log(line.trimEnd());
      const match = text.match(/whsec_[A-Za-z0-9]+/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ secret: match[0], stop });
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled) reject(new Error(`stripe listen exited with code ${code}`));
    });
  });
}

/**
 * The whole local-webhook story in ONE call: fetch the CLI if needed, start
 * forwarding, and hand the session's signing secret to the dev server.
 *
 * The pieces above have existed for a while and every app still wired them
 * itself — which is the gap this closes, because "you can do local payments with
 * only a Stripe key" and "you can do local payments once you've written the
 * script that does it" are different promises.
 *
 * Writing the secret into a dotenv file rather than the environment is deliberate:
 * `stripe listen` mints a NEW secret per session, and the dev server that has to
 * verify against it is a different process (often started by the same `dev`
 * script). A file is the only channel both can see.
 */
export async function startLocalWebhooks(
  opts: {
    /** Default http://localhost:3000/api/stripe/webhook */
    forwardTo?: string;
    /** Dotenv file the secret is written to. Default `.env.local`. Pass `null` to
     *  skip the write and read `secret` off the return value yourself. */
    envFile?: string | null;
    /** Restrict forwarding to these event types. Default: the ones that move
     *  money (`BILLING_WEBHOOK_EVENTS`) — a local run has no use for the rest,
     *  and a narrower stream is a readable log. */
    events?: readonly string[];
    apiKey?: string;
    log?: (msg: string) => void;
  } = {},
): Promise<Listener & { forwardTo: string; envFile: string | null }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const forwardTo = opts.forwardTo ?? "http://localhost:3000/api/stripe/webhook";
  const envFile = opts.envFile === undefined ? ".env.local" : opts.envFile;

  const listener = await listenForWebhooks({
    forwardTo,
    apiKey: opts.apiKey,
    events: opts.events ?? LOCAL_WEBHOOK_EVENTS,
    log,
  });

  if (envFile) {
    await setEnvVar(envFile, "STRIPE_WEBHOOK_SECRET", listener.secret);
    log(`STRIPE_WEBHOOK_SECRET written to ${envFile} — restart the dev server if it was already up`);
  }
  log(`Forwarding Stripe events to ${forwardTo}`);
  return { ...listener, forwardTo, envFile };
}

// Duplicated from webhook-setup.ts rather than imported: that module pulls in
// `billing.ts` → the Stripe SDK, and this entry point is deliberately reachable
// with nothing installed but Node (it is also the only module here allowed to
// touch child_process and fs). Three strings are a cheaper price than that edge.
const LOCAL_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/**
 * Set one key in a dotenv file, leaving everything else byte-identical.
 *
 * Used to hand the session's signing secret to a dev server running in another
 * process. Rewrites the existing line when present rather than appending a
 * duplicate, because two definitions of the same key is a debugging afternoon.
 */
export async function setEnvVar(file: string, key: string, value: string): Promise<boolean> {
  const current = (await exists(file)) ? await readFile(file, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");

  if (pattern.test(current)) {
    const next = current.replace(pattern, line);
    if (next === current) return false;
    await writeFile(file, next);
    return true;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, current && !current.endsWith("\n") ? `${current}\n${line}\n` : `${current}${line}\n`);
  return true;
}
