import type { BillingUser } from "./types.js";
import { getWorkOS as workos } from "./workos.js";

// WorkOS magic-auth — the common auth substrate for billing-tools. The host
// app's storage (WorkOS orgs vs Postgres) only matters *after* the user is
// verified; that post-auth step is the adapter's ensureOrgForUser.

// Step 1: ensure the user exists in WorkOS and email them a 6-digit code.
export async function sendMagicAuth(email: string): Promise<void> {
  const wos = workos();
  const users = await wos.userManagement.listUsers({ email });
  if (users.data.length === 0) {
    await wos.userManagement.createUser({ email, emailVerified: false });
  }
  await wos.userManagement.createMagicAuth({ email });
}

// Step 2: verify the code, returning the WorkOS user.
export async function verifyMagicAuth(email: string, code: string): Promise<BillingUser> {
  const res = await workos().userManagement.authenticateWithMagicAuth({
    code,
    email,
    clientId: process.env.WORKOS_CLIENT_ID!,
  });
  const u = res.user;
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    profilePictureUrl: u.profilePictureUrl,
  };
}
