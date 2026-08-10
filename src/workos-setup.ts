import { getWorkOS } from "./workos.js";

// Provisioning the WorkOS half, so a fresh environment needs as little Dashboard
// clicking as Stripe does.
//
// The asymmetry this closes: Stripe provisions itself from the secret key —
// products, prices, the meter, the payment-method configuration, TaxRates all
// appear on first use. WorkOS did not, so "it worked in sandbox" carried no
// information about production, and the failure was silent in the worst way (see
// `isAdmin` below).
//
// What is genuinely NOT automatable in `@workos-inc/node` v10, and so stays a
// Dashboard step: AuthKit's **redirect URIs** and AuthKit's appearance/settings.
// The only `redirect_uris` the SDK can write belong to a *Connect application* (a
// third-party OAuth app), which is a different object entirely. `checkWorkOSSetup`
// therefore prints the exact URI to add rather than pretending it can check it.

// `ADMIN_ROLE_SLUG` lives in `types.ts` — a dependency-free module on the `/plans` leaf —
// and is re-exported here because this is where callers expect it. It moved because a bare
// string reachable only from the ROOT barrel forces every client component to hardcode it:
// importing it pulled Stripe, WorkOS and the MCP SDK into a browser bundle to answer
// `role === "admin"`, so a consumer wrote the literal instead, in six files.
export { ADMIN_ROLE_SLUG } from "./types.js";

export interface WorkOSRoleSpec {
  /** Stable identifier. `isAdmin` matches on this, not on the name. */
  slug: string;
  name?: string;
  description?: string;
}

// There is deliberately NO default role list.
//
// A WorkOS environment ships with `admin` and `member` already (verified against a
// live one), so provisioning them would be a step that never fires while reading like
// it does something — and it would cost a `listEnvironmentRoles` call on every deploy
// to discover that. What the API is genuinely good for is the roles an APP invents,
// which only the app knows. So this creates what you name and nothing else.
//
// The `admin` slug is still WORTH CHECKING, which the doctor does, and that is a
// different claim: not "did we create it" but "does the slug `isAdmin` matches on
// exist here". A team that renames or deletes it gets `isAdmin` false for everyone
// and a 403 from every admin-gated tool, while org API keys keep working — which is
// why that one survives a headless pass and fails on the first real person.

export interface EnsureRolesResult {
  created: string[];
  existing: string[];
}

/**
 * Create any of YOUR environment roles that are missing. Idempotent, safe on every
 * deploy, and a no-op (no request at all) when you name none.
 *
 * Which environment is decided by `WORKOS_API_KEY`, exactly as the Stripe half is
 * decided by `STRIPE_SECRET_KEY`.
 */
export async function ensureWorkOSRoles(
  opts: { roles?: WorkOSRoleSpec[] } = {},
): Promise<EnsureRolesResult> {
  const wanted = opts.roles ?? [];
  // Nothing asked for, nothing read: the common case must not spend a round trip
  // discovering that it had nothing to do.
  if (!wanted.length) return { created: [], existing: [] };
  const workos = getWorkOS();

  const list = await workos.authorization.listEnvironmentRoles();
  const have = new Set(list.data.map((r) => r.slug));

  const created: string[] = [];
  const existing: string[] = [];
  for (const role of wanted) {
    if (have.has(role.slug)) {
      existing.push(role.slug);
      continue;
    }
    try {
      await workos.authorization.createEnvironmentRole({
        slug: role.slug,
        name: role.name ?? role.slug,
        description: role.description,
      });
      created.push(role.slug);
    } catch (e) {
      // A concurrent deploy of the same commit is the expected race, and it means
      // the role now exists — which is the outcome asked for, so it is not a
      // failure. Anything else is.
      if (isAlreadyExists(e)) {
        existing.push(role.slug);
        continue;
      }
      throw e;
    }
  }
  return { created, existing };
}

/** Roles present in this environment, by slug. Read-only; for the doctor. */
export async function listWorkOSRoleSlugs(): Promise<string[]> {
  const list = await getWorkOS().authorization.listEnvironmentRoles();
  return list.data.map((r) => r.slug);
}

function isAlreadyExists(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 409) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /already exists|conflict|duplicate/i.test(message);
}

/**
 * The AuthKit redirect URI this deployment needs allowlisted.
 *
 * Returned rather than checked: v10 exposes no API for AuthKit's redirect URIs (the
 * SDK's `redirect_uris` belong to Connect applications), so the honest thing is to
 * print the exact string to paste instead of a check that cannot fail.
 */
export function oauthCallbackUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/oauth/callback`;
}
