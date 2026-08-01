"use client";

import * as React from "react";
import { ANONYMOUS_SESSION, type BillingSession } from "../session.js";

// One hook for "who is signed in, and what may they do".
//
// The value is resolved ONCE on the server (`resolveSession()`) and handed down
// as a prop. That is the entire design: the alternative — each component asking
// a server action after mount — is what makes permission-gated UI appear a beat
// late, shifting the layout under the pointer, and it repeats the round trip
// per mount point.
//
// Being a plain prop also means no fetching, no loading state and no client-side
// WorkOS dependency: components read a value that was already correct in the
// first painted frame.

const SessionContext = React.createContext<BillingSession>(ANONYMOUS_SESSION);

export function SessionProvider({
  session,
  children,
}: {
  session: BillingSession;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/**
 * The current session: `{ user, orgId, role, isAdmin, plan }`.
 *
 * Outside a `<SessionProvider>` this returns the anonymous session rather than
 * throwing, so a component can render on a public page and in the app without
 * knowing which it is. It fails closed — `isAdmin` is false — so a forgotten
 * provider hides privileged UI instead of exposing it.
 */
export function useSession(): BillingSession {
  return React.useContext(SessionContext);
}

export { ANONYMOUS_SESSION, type BillingSession, type SessionUser } from "../session.js";
