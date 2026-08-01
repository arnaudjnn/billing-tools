"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import * as React from "react";
import { ANONYMOUS_SESSION, type BillingSession } from "../session.js";
import { SessionProvider } from "./session.js";

// Seed `useSession()` from AuthKit's CLIENT session, so the hook answers
// everywhere — including pages that must stay statically rendered.
//
// The server-side `resolveSession()` reads cookies, which opts a route out of
// static rendering. On a marketing or SEO page that cost is unacceptable, but
// the role still has to be known there or permission-gated UI silently differs
// between the app and the public site. AuthKit already resolves the session in
// the browser for `useAuth()`, and its claims include `organizationId` and
// `role` — so this needs no extra request, only the value AuthKit already has.
//
// The trade is timing, not correctness: on a static page the session arrives
// after hydration, exactly like the avatar does. Nest a server-seeded
// `<SessionProvider>` inside this one on routes that already render
// dynamically — the inner provider wins, and there the session is right in the
// first painted frame.
//
// Lives at its own entry point (`@arnaudjnn/billing-tools/ui/authkit`) because
// it is the one module that imports `@workos-inc/authkit-nextjs`, which stays
// an optional peer: an app not using AuthKit never loads this file.

export function AuthKitSessionProvider({
  plan = null,
  children,
}: {
  /**
   * Plan for the active organization. AuthKit's session doesn't carry it, so a
   * page that needs `session.plan` client-side must pass it; otherwise it is
   * null here and only populated by a server-seeded provider.
   */
  plan?: string | null;
  children: React.ReactNode;
}) {
  const { user, organizationId, role } = useAuth();

  const session = React.useMemo<BillingSession>(() => {
    if (!user) return ANONYMOUS_SESSION;
    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        profilePictureUrl: user.profilePictureUrl ?? null,
      },
      orgId: organizationId ?? null,
      role: role ?? null,
      isAdmin: role === "admin",
      plan,
    };
  }, [user, organizationId, role, plan]);

  return <SessionProvider session={session}>{children}</SessionProvider>;
}
