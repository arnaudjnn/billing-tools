// API keys, against real WorkOS.
//
// The claim worth proving is not "a key can be minted" — it is that the value is shown
// once and never again, that revocation is immediate, and that a dead key is refused with
// a 401 carrying the header an agent needs to re-authenticate. All three are properties of
// WorkOS's org-API-key behaviour, which a fake adapter asserts nothing about.

import { note, ok, skip } from "../lib/harness.mjs";
import { RUN } from "../lib/scratch-stripe.mjs";

export async function run(ctx) {
  const { adapter, orgId, callers } = ctx;

  const minted = await adapter.mintApiKey(orgId, `${RUN}-throwaway`);
  ok("mintApiKey returns an id and a value", Boolean(minted.id && minted.value));
  ok("the value is an sk_ secret", minted.value.startsWith("sk_"), minted.value.slice(0, 8) + "…");

  const validated = await adapter.validateApiKey(minted.value);
  ok("the key validates to its own org", validated?.orgId === orgId, validated?.orgId);
  ok(
    "and names which key it was",
    Boolean(validated?.keyId),
    validated?.keyId ?? "no keyId — per-key usage attribution is unavailable",
  );

  const listed = await adapter.listApiKeys(orgId);
  const entry = listed.find((k) => k.id === minted.id);
  ok("listApiKeys includes it", Boolean(entry));
  // The actual claim: the list is safe to render. A list that echoed the secret would be a
  // leak on every settings page.
  ok(
    "the listed value is obfuscated, not the secret",
    Boolean(entry) && !entry.obfuscatedValue.includes(minted.value),
    entry?.obfuscatedValue,
  );

  const revoked = await adapter.revokeApiKey(orgId, minted.id);
  ok("revokeApiKey confirms what it removed", revoked?.id === minted.id, revoked?.name);
  ok("a revoked key no longer validates", (await adapter.validateApiKey(minted.value)) === null);

  // Through the real route, because the 401 envelope is what an agent bootstraps from.
  const dead = await callers.viaRest("get_credit_balance", {}, { token: minted.value });
  ok("a dead key is 401 over REST", dead.status === 401, `status ${dead.status}`);
  ok(
    "and the 401 advertises how to authenticate",
    Boolean(dead.wwwAuthenticate),
    dead.wwwAuthenticate ?? "no WWW-Authenticate header",
  );

  // `get_api_key` cannot be COMPLETED here — it sends a magic-auth code to a real inbox
  // and wants the six digits back. The reachable half is that it gets as far as asking.
  //
  // A skip rather than a failure when the environment has magic auth switched off: that is
  // a Dashboard setting, not a defect in this library, and failing would blame the code for
  // the environment. It IS worth knowing though — see the note below.
  const bootstrap = await callers.asOrgKey("get_api_key", { email: `${RUN}@example.test` });
  const payload = bootstrap.ok ? bootstrap.value : null;
  if (!bootstrap.ok && /authentication_method_not_allowed/.test(bootstrap.error ?? "")) {
    skip("get_api_key asks for a code", "this WorkOS environment has Magic Auth disabled");
    note("→ FINDING: with Magic Auth off, get_api_key cannot bootstrap an agent in this");
    note("  environment at all. Enable it in WorkOS → Authentication, or agents must be");
    note("  handed a key out of band.");
  } else {
    ok(
      "get_api_key asks for a code rather than erroring",
      bootstrap.ok && typeof payload === "object",
      payload?.status ?? bootstrap.error,
    );
  }
  note("the full magic-auth flow needs an inbox — covered offline, not here");
}
