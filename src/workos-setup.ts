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

/** The role slug `WorkOSOrgAdapter.isAdmin` matches on. ONE definition, imported by
 *  the adapter, the provisioner and the doctor — three copies of a magic string is
 *  how the check comes to disagree with the thing it checks. */
export const ADMIN_ROLE_SLUG = "admin";

export interface WorkOSRoleSpec {
  /** Stable identifier. `isAdmin` matches on this, not on the name. */
  slug: string;
  name?: string;
  description?: string;
}

/**
 * The roles this library's own behaviour depends on.
 *
 * A WorkOS environment normally ships with both, so this is usually a no-op — but
 * "usually" is not a guarantee, and the failure mode is bad enough to be worth
 * asserting: `enforceAdmin` refuses with 403 when `adapter.isAdmin` says no, and
 * `isAdmin` asks whether the member's role slug is `admin`. No such role in the
 * environment means no membership can carry it, so **every admin-gated tool refuses
 * every human** — seat assignment, top-up approval, the spend ceiling, plan changes.
 * Org API keys are unaffected (they carry no principal and are owner-level), which is
 * exactly why this survives a headless test pass and fails on the first real person.
 */
export const DEFAULT_WORKOS_ROLES: WorkOSRoleSpec[] = [
  {
    slug: ADMIN_ROLE_SLUG,
    name: "Admin",
    description: "Full access to the workspace, its billing and its members.",
  },
  {
    slug: "member",
    name: "Member",
    description: "Uses the workspace. Cannot change billing or manage members.",
  },
];

export interface EnsureRolesResult {
  created: string[];
  existing: string[];
}

/**
 * Create any missing environment roles. Idempotent, and safe on every deploy.
 *
 * Which environment is decided by `WORKOS_API_KEY`, exactly as the Stripe half is
 * decided by `STRIPE_SECRET_KEY`.
 */
export async function ensureWorkOSRoles(
  opts: { roles?: WorkOSRoleSpec[] } = {},
): Promise<EnsureRolesResult> {
  const wanted = opts.roles ?? DEFAULT_WORKOS_ROLES;
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
