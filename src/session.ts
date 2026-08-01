// The signed-in user, as one shape, resolved WITHOUT a database.
//
// Apps built on this package don't necessarily have a `users` or `workspaces`
// table — some are pure WorkOS + Stripe. So everything here comes from the two
// services that always exist:
//
//   user / orgId / role  →  the WorkOS session's own claims
//   plan                 →  WorkOS organization metadata, which billing-sync
//                           already writes on every subscription change
//
// `role` is the piece worth understanding. WorkOS only puts it on an
// ORGANIZATION-SCOPED session, so an app that authenticates without selecting an
// organization gets `null` here and every `isAdmin` check fails closed. That is
// the correct failure direction, but it is usually a bug in the sign-in flow
// rather than a genuine absence — scope the session at sign-in.

export type SessionUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
};

export type BillingSession = {
  user: SessionUser | null;
  /** WorkOS organization id — null when the session isn't org-scoped. */
  orgId: string | null;
  /** Role slug within that organization, e.g. "admin" / "member". */
  role: string | null;
  /** `role === "admin"`. False whenever the role is unknown. */
  isAdmin: boolean;
  /** Plan key from organization metadata, e.g. "hobby" / "pro". */
  plan: string | null;
};

export const ANONYMOUS_SESSION: BillingSession = {
  user: null,
  orgId: null,
  role: null,
  isAdmin: false,
  plan: null,
};

const ADMIN_ROLE = "admin";

/**
 * Anything that can report an organization's plan — structurally the
 * `WorkOSOrgAdapter`, but stated as a shape so a host with its own adapter,
 * or a test, can supply one.
 */
export type PlanSource = {
  getSubscription(orgId: string): Promise<{ plan?: string | null } | null>;
};

// Shape of the one AuthKit function used here, declared locally on purpose.
// `@workos-inc/authkit-nextjs` is an OPTIONAL peer, and this module is exported
// from the package ROOT — so a consumer that doesn't use AuthKit would still
// have a bundler try to resolve a statically-typed import of it and fail the
// build. Widening the specifier keeps the dependency genuinely optional; only
// `ui/authkit`, which nobody else imports, binds to it for real.
type AuthKit = {
  withAuth: () => Promise<{
    user: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
      profilePictureUrl?: string | null;
    } | null;
    organizationId?: string | null;
    role?: string | null;
  }>;
};

/**
 * Resolve the current session on the server, to seed `<SessionProvider>`.
 *
 * Next.js + AuthKit only: it reads the sealed session cookie through
 * `@workos-inc/authkit-nextjs`, which stays an OPTIONAL peer — imported
 * dynamically so a CLI or non-Next consumer never loads it.
 *
 * Pass `adapter` to include the plan; without one the plan is null and no
 * WorkOS organization is fetched, which keeps this to zero network calls.
 */
export async function resolveSession(
  opts: { adapter?: PlanSource } = {},
): Promise<BillingSession> {
  // The specifier is widened to `string` so TypeScript doesn't try to resolve a
  // module this package doesn't install — see the AuthKit type above.
  const { withAuth } = (await import(
    "@workos-inc/authkit-nextjs" as string
  )) as AuthKit;
  const auth = await withAuth();
  if (!auth.user) return ANONYMOUS_SESSION;

  const orgId = auth.organizationId ?? null;
  const role = auth.role ?? null;

  // A plan lookup must never cost a sign-in: an unreachable WorkOS here should
  // render the app plan-less, not throw out of a layout.
  let plan: string | null = null;
  if (orgId && opts.adapter) {
    try {
      plan = (await opts.adapter.getSubscription(orgId))?.plan ?? null;
    } catch {
      plan = null;
    }
  }

  return {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      firstName: auth.user.firstName ?? null,
      lastName: auth.user.lastName ?? null,
      profilePictureUrl: auth.user.profilePictureUrl ?? null,
    },
    orgId,
    role,
    isAdmin: role === ADMIN_ROLE,
    plan,
  };
}
