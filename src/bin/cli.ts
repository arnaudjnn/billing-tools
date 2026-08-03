#!/usr/bin/env node
// `npx billing-tools <command>` — the two things a developer needs that don't
// require the app's own config.
//
// Everything that needs `plans` (the price reconcile) is `setupBilling()`, called
// from a script in the app, because only the app knows its catalogue. What's left
// needs nothing but STRIPE_SECRET_KEY, so it can be a command rather than a
// snippet each consumer copies:
//
//   billing-tools dev      forward Stripe webhooks to localhost, no tunnel, no login
//   billing-tools doctor   audit this environment for the failures that are silent
//
// Which Stripe environment either one touches is decided by STRIPE_SECRET_KEY and
// nothing else.

const HELP = `billing-tools <command>

  dev       Forward Stripe webhooks to a local server (downloads the Stripe CLI if
            needed; no \`stripe login\`, no tunnel) and write the session's signing
            secret into a dotenv file.

              --forward-to <url>   default http://localhost:3000/api/stripe/webhook
              --env-file <path>    default .env.local ("none" to skip the write)

  doctor    Read-only audit of the Stripe environment: the misconfigurations that
            cost money and produce no error.

              --webhook-url <url>  also check the registered endpoint
              --tax <mode>         billing-tools (default) | stripe | none
              --currency <code>    check for customers pinned elsewhere

Environment: STRIPE_SECRET_KEY decides which account and mode this talks to.
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function dev(argv: string[]): Promise<number> {
  // Imported lazily, and by path: this module is the only one allowed to touch
  // child_process/fs, and `doctor` below must not pay for loading it.
  const { startLocalWebhooks } = await import("../dev/stripe-cli.js");
  const envFile = flag(argv, "env-file");
  const listener = await startLocalWebhooks({
    forwardTo: flag(argv, "forward-to"),
    envFile: envFile === "none" ? null : envFile,
  });
  // Hold the process open; the CLI child streams events until interrupted.
  const stop = () => {
    listener.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
  return 0;
}

async function doctor(argv: string[]): Promise<number> {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not set — there is no environment to inspect.");
    return 1;
  }
  const { checkBillingSetup, formatDoctorResult } = await import("../doctor.js");
  const tax = flag(argv, "tax");
  const result = await checkBillingSetup({
    webhookUrl: flag(argv, "webhook-url"),
    currency: flag(argv, "currency"),
    ...(tax ? { taxMode: tax as "billing-tools" | "stripe" | "none" } : {}),
  });
  // The library's own renderer, not a second one — a command that formatted checks
  // differently from `formatDoctorResult` is two things to keep in step.
  const { text, exitCode } = formatDoctorResult(result);
  console.log(text);
  // Non-zero exit is the point of running this in CI.
  return exitCode;
}

async function main(): Promise<number> {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "dev":
      return dev(argv);
    case "doctor":
      return doctor(argv);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
