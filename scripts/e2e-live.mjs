// The live end-to-end run: real Stripe, real WorkOS, the library's own surfaces.
//
//   pnpm e2e:live                       # against gtm-tools' test keys (default)
//   E2E_ENV_FILE=/path/.env.local pnpm e2e:live
//   E2E_ONLY=02,05 pnpm e2e:live        # a subset, by section number
//
// WHAT THIS EXISTS FOR. Everything billing-tools claims about roles, tax, invoices and
// plan changes is proven offline against fakes — and the two things the fakes stub are
// exactly the two that break in a real environment: `getStripe` and WorkOS. So nothing had
// ever established that a WorkOS role slug actually resolves to a refusal, that a computed
// rate lands on a real invoice with its mandatory mention, or that a quoted upgrade total
// equals the charged one.
//
// SAFETY. Test keys only, refused otherwise. Every object is prefixed `live<ts>` and torn
// down LIFO in a `finally`. And `ensurePlans` is made structurally unreachable rather than
// merely avoided — see the header of scripts/lib/scratch-stripe.mjs, which is the most
// important comment in this harness.

import Stripe from "stripe";
import { WorkOSOrgAdapter } from "../dist/adapters/workos-org.js";
import { __setStripeForTests } from "../dist/billing.js";
import { createBilling } from "../dist/create-billing.js";
import { createWorkOSInvitations } from "../dist/invitations.js";
import { createToolDispatchHandler } from "../dist/routes/rest.js";
import { getWorkOS } from "../dist/workos.js";

import {
  defer,
  fatal,
  finish,
  ignoreMissing,
  loadEnvFile,
  note,
  requireTestKeys,
  runDeferred,
  section,
} from "./lib/harness.mjs";
import { makeCallers } from "./lib/callers.mjs";
import {
  LIVE_PLANS,
  RUN,
  attachTestCard,
  createClockCustomer,
  createScratchCatalogue,
} from "./lib/scratch-stripe.mjs";
import { createScratchOrg, preflightRoles } from "./lib/scratch-workos.mjs";

const ENV_FILE =
  process.env.E2E_ENV_FILE ?? "/Users/arnaudjeannin/Documents/gtm-engine/gtm-tools/.env.local";
const ONLY = process.env.E2E_ONLY?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

const SECTIONS = [
  ["01", "keys", () => import("./live/01-keys.mjs")],
  ["02", "roles", () => import("./live/02-roles.mjs")],
  ["03", "tax", () => import("./live/03-tax.mjs")],
  ["05", "lifecycle", () => import("./live/05-lifecycle.mjs")],
  // 04 runs AFTER 05 on purpose: a draft invoice has no PDF and no hosted url, so the
  // invoice assertions need the invoices the lifecycle raised.
  ["04", "invoices", () => import("./live/04-invoices.mjs")],
  ["06", "seats-topups-usage", () => import("./live/06-seats-topups-usage.mjs")],
  // 07 needs a clock at a mid-cycle position and creates its own subscription, so it runs
  // last — 05 has already advanced the shared clock past a period boundary.
  ["07", "mid-cycle documents", () => import("./live/07-mid-cycle-documents.mjs")],
  ["08", "plan moves", () => import("./live/08-plan-moves.mjs")],
  ["09", "roles and isolation", () => import("./live/09-roles-and-isolation.mjs")],
  ["10", "workspace close", () => import("./live/10-workspace-close.mjs")],
  ["11", "refusals and dunning", () => import("./live/11-refusals-and-dunning.mjs")],
  // 12 creates its own throwaway workspace, because it REMOVES people — and the run's org is
  // every other section's fixture.
  ["12", "members", () => import("./live/12-members.mjs")],
];

async function main() {
  const env = loadEnvFile(ENV_FILE);
  const { stripeKey } = requireTestKeys(env);
  note(`env: ${ENV_FILE}`);
  note(`run: ${RUN}`);

  // `maxNetworkRetries: 0` so a rate limit shows up as a failure rather than as a slow
  // pass — the harness should not paper over an account that is being hammered.
  const stripe = new Stripe(stripeKey, { maxNetworkRetries: 0 });
  __setStripeForTests(stripe);
  const workos = getWorkOS();

  section("preflight");
  const slugs = await preflightRoles();
  note(`WorkOS roles present: ${slugs.join(", ")}`);

  section("fixtures");
  // WorkOS first: the Stripe customer's metadata and the adapter's billing pointer both
  // need the org id.
  const { orgId, adminUserId, memberUserId } = await createScratchOrg();
  const adapter = new WorkOSOrgAdapter();

  const { prices } = await createScratchCatalogue(stripe, { currency: "eur" });
  note(`scratch prices: ${prices.size}`);

  const { clockId, customerId } = await createClockCustomer(stripe, { orgId });
  await attachTestCard(stripe, customerId);
  await adapter.setBillingCustomerId(orgId, customerId);
  note(`customer ${customerId} on clock ${clockId}`);

  const config = {
    // 0, not 100: a welcome credit would put a balance on the customer, and a nonzero
    // starting balance is exactly what the "an included allowance must not be credited"
    // assertion is looking for.
    freeCredits: 0,
    currency: "eur",
    baseUrl: "https://e2e.test",
    internalDomains: [],
    defaultLocale: "en",
    tax: {
      mode: "local",
      origin: "IT",
      registrations: [{ country: "IT" }],
      oss: true,
      notes: {
        exempt: "Operazione non soggetta a IVA",
        reverseCharge: "Inversione contabile, art. 196 dir. 2006/112/CE",
      },
    },
  };

  const billing = createBilling({
    adapter,
    config,
    plans: LIVE_PLANS,
    realm: "e2e-live",
    // Membership: the invitation service is what turns the three invitation tools on, and
    // section 12 is the only thing that can prove a real invitation is created, held against a
    // seat, and revoked. WorkOS sends its own email to an `@example.test` address that goes
    // nowhere, which is what a test account is for.
    members: { invitations: createWorkOSInvitations({ baseUrl: config.baseUrl }) },
    // No `meter`: metering is proven exactly by scripts/e2e-scope-ledger.mjs, and its
    // ~60s of meter lag has no place in a run that asserts on money.
  });

  // A handler factory rather than a handler: the roles section needs the same dispatcher
  // reached with different principals, which is the option this run exists to exercise.
  const restDispatch = (principal) =>
    createToolDispatchHandler({
      dispatcher: billing.dispatcher,
      realm: "e2e-live",
      ...(principal ? { principal: () => principal } : {}),
    });

  const apiKey = await (async () => {
    const key = await adapter.mintApiKey(orgId, `${RUN}-primary`);
    defer(`api key ${key.id}`, () => adapter.revokeApiKey(orgId, key.id).catch(ignoreMissing));
    return key;
  })();

  const ctx = {
    stripe,
    workos,
    adapter,
    billing,
    dispatcher: billing.dispatcher,
    restDispatch,
    api: billing.api,
    config,
    plans: LIVE_PLANS,
    prices,
    orgId,
    adminUserId,
    memberUserId,
    customerId,
    clockId,
    apiKey: apiKey.value,
    apiKeyId: apiKey.id,
    callers: makeCallers({
      dispatcher: billing.dispatcher,
      restDispatch,
      apiKey: apiKey.value,
      adminUserId,
      memberUserId,
    }),
    // Carried between sections: 05 creates the subscription 04 reads invoices from.
    state: {},
  };

  // Each section is isolated: one that throws is a counted FAILURE and the rest still run.
  // Before this, an exception in section 05 skipped 04, 06 and 07 silently — and the summary
  // still said ALL PASS.
  for (const [num, name, load] of SECTIONS) {
    if (ONLY && !ONLY.includes(num)) continue;
    section(`${num} — ${name}`);
    try {
      const mod = await load();
      await mod.run(ctx);
    } catch (e) {
      fatal(`section ${num} (${name})`, e);
    }
  }
}

try {
  await main();
} catch (e) {
  // Setup itself failed — no section ran. `fatal` is what makes the exit code agree with
  // the transcript; `process.exitCode` alone was overwritten by `finish()`.
  fatal("setup", e);
} finally {
  await runDeferred();
}
finish();
