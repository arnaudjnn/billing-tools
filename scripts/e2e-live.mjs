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
import { createToolDispatchHandler } from "../dist/routes/rest.js";
import { getWorkOS } from "../dist/workos.js";

import {
  defer,
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

  for (const [num, name, load] of SECTIONS) {
    if (ONLY && !ONLY.includes(num)) continue;
    section(`${num} — ${name}`);
    const mod = await load();
    await mod.run(ctx);
  }
}

try {
  await main();
} catch (e) {
  console.error(`\n✗ the run threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exitCode = 1;
} finally {
  await runDeferred();
}
finish();
