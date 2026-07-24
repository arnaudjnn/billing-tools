import { WorkOS } from "@workos-inc/node";

// The ONE WorkOS client bootstrap for the whole lib. Every module (adapter,
// invitations, magic-auth, events) goes through here so there's a single
// lifecycle + one place that reads the env.
//
// Lazy + memoized: constructing WorkOS eagerly throws when WORKOS_API_KEY is
// unset, which must never break app boot (adapters/services are built at module
// load) — so the client is created on first actual use (the v0.4.1 rule).
//
// The env-based client is a shared singleton. Explicit per-instance credentials
// (rare — an app running >1 WorkOS env in one process) get their own client so
// they never collide with the shared one.

let _default: WorkOS | null = null;

export function getWorkOS(opts?: { apiKey?: string; clientId?: string }): WorkOS {
  if (opts?.apiKey || opts?.clientId) {
    return new WorkOS(opts.apiKey ?? process.env.WORKOS_API_KEY, {
      clientId: opts.clientId ?? process.env.WORKOS_CLIENT_ID ?? "",
    });
  }
  return (_default ??= new WorkOS(process.env.WORKOS_API_KEY, {
    clientId: process.env.WORKOS_CLIENT_ID ?? "",
  }));
}
