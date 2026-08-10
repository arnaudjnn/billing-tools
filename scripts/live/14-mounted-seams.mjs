// The three seams a CONSUMER mounts, which the coverage ledger had named as gaps.
//
// `tests/live-coverage.test.mjs` listed four exports that touch Stripe or WorkOS and had
// never been executed against either. Three of them are here, and the reason they were
// missing was a bad reason in two cases:
//
//   • `createWorkOSOrgMirror` — "Pattern B needs a Postgres the harness has not got". It does
//     NOT: the seam is two async functions, `readPointer` and `writePointer`, which is the
//     whole point of the design. A `Map` satisfies them, and what gets proven is the part no
//     fake can — that `getOrganizationByExternalId` really finds an org created with an
//     `externalId`, that a second `ensureOrg` FINDS rather than duplicating, and that a
//     missing pointer reconciles from WorkOS instead of minting a second org.
//   • `createBillingSync` / `createSyncRoute` — "a route factory". It is a
//     `(Request) => Response`, so there is nothing to stop it being called.
//
// The fourth stays, and now for a measured reason rather than a guess: a
// `savedCardFromCheckoutSession` needs a COMPLETED setup session, and Stripe answers
// `setupIntents.confirm` on one with "You cannot confirm SetupIntents created by Checkout."
//
// Runs LAST because 14c touches ACCOUNT-level state. As it turns out it cannot make that
// state stick — the invoice default is a Dashboard setting — so the dummy id is torn down
// again; the ordering stays, because a future run that CAN set a default must not perturb the
// invoice assertions in 03, 04, 05 and 07.

import { createBillingSync, createSyncRoute } from "../../dist/sync.js";
import { createWorkOSOrgMirror } from "../../dist/org-mirror.js";
import { ensureAccountTaxId, accountTaxIds } from "../../dist/tax-setup.js";
import { getWorkOS } from "../../dist/workos.js";

import { defer, eur, ignoreMissing, note, ok, section } from "../lib/harness.mjs";
import { RUN } from "../lib/scratch-stripe.mjs";

export async function run(ctx) {
  const { stripe, adapter, customerId } = ctx;
  const workos = getWorkOS();

  // ── 14a — the mirror, on two functions and a Map ──────────────────────────
  section("14a — Pattern B: the pointer is a cache of the truth in WorkOS, not a second copy");
  const pointers = new Map();
  let writes = 0;
  const mirror = createWorkOSOrgMirror({
    async readPointer(localId) {
      // THROWS for a local id with no row at all, which is the contract: `null` means "no
      // pointer, go find or make the org", and answering that for a row that does not exist
      // would mint an org for nothing.
      if (!pointers.has(localId)) throw new Error(`no such workspace: ${localId}`);
      return pointers.get(localId);
    },
    async writePointer(localId, workosOrgId) {
      writes++;
      pointers.set(localId, workosOrgId);
    },
    nameFor: () => `E2E Mirror ${RUN}`,
  });

  const localId = `ws_${RUN}`;
  pointers.set(localId, null); // the row exists; the pointer does not yet

  const orgId = await mirror.ensureOrg(localId);
  defer(`mirrored org ${orgId}`, () => workos.organizations.deleteOrganization(orgId).catch(ignoreMissing));
  ok("an org is created for the local id", Boolean(orgId), orgId);
  ok("and the pointer is written", pointers.get(localId) === orgId, `${writes} write(s)`);

  const live = await workos.organizations.getOrganization(orgId);
  // The reverse map, self-healing: the app's id lives ON the org, so the mapping survives the
  // app's own store being wiped.
  ok("carrying the local id as its externalId", live.externalId === localId, live.externalId ?? "null");

  // Twice. Keyed on `externalId`, so this must FIND rather than create a second org — the one
  // thing a fake cannot tell you, because it is WorkOS that enforces the uniqueness.
  const again = await mirror.ensureOrg(localId);
  ok("a second ensureOrg finds the same org, never a duplicate", again === orgId, `${again} vs ${orgId}`);

  // A row that predates the mirror: the pointer is gone, the org is not.
  pointers.set(localId, null);
  const reconciled = await mirror.toWorkosOrgId(localId);
  ok("a missing pointer RECONCILES from WorkOS", reconciled === orgId, `${reconciled}`);
  ok("and is written back, so the next read is one query", pointers.get(localId) === orgId);

  // No `reversePointer` was configured, so this falls back to the org's own externalId.
  const back = await mirror.toOrgId(orgId);
  ok("the reverse direction answers from the org itself", back === localId, back ?? "null");
  ok("and an unknown org id is null rather than a throw", (await mirror.toOrgId("org_01DOESNOTEXIST0000000000")) === null);

  await mirror.renameOrg(orgId, `E2E Mirror renamed ${RUN}`);
  const renamed = await workos.organizations.getOrganization(orgId);
  ok("renaming reaches WorkOS", renamed.name.includes("renamed"), renamed.name);
  // NotFound is swallowed: a rename racing a deletion is not an error worth propagating.
  let renameThrew = false;
  await mirror.renameOrg("org_01DOESNOTEXIST0000000000", "nope").catch(() => (renameThrew = true));
  ok("and renaming a deleted org is swallowed, not thrown", renameThrew === false);

  // ── 14b — the sync route ──────────────────────────────────────────────────
  section("14b — the poller a consumer mounts on a cron");
  const cursors = new Map();
  const sync = createBillingSync({
    adapter,
    plans: ctx.plans,
    currency: ctx.config.currency,
    // The cursor OVERRIDE, which is what makes this reachable without a database: `query` is
    // only consulted by `queryCursorStore`, and passing `cursor` means it never is. The stub
    // throws to prove that rather than assume it.
    query: () => {
      throw new Error("the query executor must not be touched when `cursor` is provided");
    },
    cursor: {
      async get(source) {
        return cursors.get(source) ?? null;
      },
      async set(source, value) {
        cursors.set(source, value);
      },
    },
  });

  const secret = `cron_${RUN}`;
  const route = createSyncRoute(sync, { secret });

  const unauth = await route(new Request("https://e2e.test/api/sync", { method: "POST" }));
  ok("an unauthenticated call is 401, not a free poll", unauth.status === 401, String(unauth.status));
  const wrong = await route(
    new Request("https://e2e.test/api/sync", { method: "POST", headers: { authorization: "Bearer nope" } }),
  );
  ok("and so is the wrong secret", wrong.status === 401, String(wrong.status));

  // A real poll: it reads Stripe's event list and WorkOS's, through the same handlers a
  // webhook uses. Nothing here is asserted about WHAT it found — this account's events are
  // whatever the earlier sections made — only that it ran and moved its cursors.
  const ran = await route(
    new Request("https://e2e.test/api/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
  );
  const body = await ran.json().catch(() => null);
  ok("with the secret it polls and answers 200", ran.status === 200, `${ran.status} ${JSON.stringify(body).slice(0, 70)}`);
  ok(
    "and it recorded where it got to, so the next run resumes",
    cursors.size > 0,
    [...cursors.keys()].join(","),
  );
  // `x-cron-secret` is the other accepted header, because that is what a scheduler sends.
  const viaCronHeader = await route(
    new Request("https://e2e.test/api/sync", { method: "POST", headers: { "x-cron-secret": secret } }),
  );
  ok("a scheduler's own header works too", viaCronHeader.status === 200, String(viaCronHeader.status));

  // ── 14c — the supplier's own VAT number, on the invoice ───────────────────
  section("14c — the number Art. 226(3) requires, which was on no invoice at all");
  // A DUMMY, format-shaped and deliberately not real: this is a test account, and what is
  // being proven is that the number reaches the document — not whose number it is.
  const DUMMY_VAT = "IT12345678901";
  const first = await ensureAccountTaxId({ type: "eu_vat", value: DUMMY_VAT });
  defer(`account tax id ${first.id}`, () => stripe.taxIds.del(first.id).catch(ignoreMissing));
  ok("an account-level tax id exists", Boolean(first.id), `${first.id} (${first.created ? "created" : "reused"})`);
  // `owner: { type: "self" }` is the ONLY shape your own account accepts, and this call had
  // never worked: it sent `owner: { type: "account" }`, refused with "Must provide `account`",
  // and your own id there is refused too because `account` means a CONNECTED account.
  const created = await stripe.taxIds.retrieve(first.id);
  ok("owned by the account making the request", created.owner?.type === "self", JSON.stringify(created.owner));
  ok("with the number as the invoice must print it", created.value.replace(/\s+/g, "").toUpperCase() === DUMMY_VAT, created.value);

  // And it is NOT the invoice default, because no API can make it one for your own account:
  // `accounts.update` is refused there with "you may only use it on connected accounts". So
  // the library reports `isDefault: false` rather than pretending, and the doctor names the
  // Dashboard step. A platform doing this TO a connected account genuinely can, which is why
  // the attempt is still made.
  ok(
    "and it says honestly that it is not the invoice default",
    first.isDefault === false,
    `isDefault=${first.isDefault}`,
  );

  // Idempotent BY VALUE: a second id with the same number would leave Stripe choosing which
  // one to print.
  const second = await ensureAccountTaxId({ type: "eu_vat", value: DUMMY_VAT });
  ok("asking twice reuses it rather than making a second", second.id === first.id, `${second.id}`);
  const all = await accountTaxIds();
  ok(
    "so the account holds exactly one of that number",
    all.filter((t) => t.value.replace(/\s+/g, "").toUpperCase() === DUMMY_VAT).length === 1,
    `${all.length} account tax id(s)`,
  );

  // The point of all of it: the SUPPLIER's number on a real document. Art. 226(3) requires it,
  // and for a reverse-charged EU B2B supply C-247/21 holds that an omitted mention cannot be
  // cured afterwards — Stripe prints the account's business name and address from Dashboard
  // settings and no tax id of its own.
  //
  // Passed PER INVOICE here, which is the half that does not need the Dashboard: the account
  // default would apply it to everything, and `account_tax_ids` on the invoice is how a
  // caller gets there today.
  const probe = await stripe.invoices.create({
    customer: customerId,
    collection_method: "charge_automatically",
    auto_advance: false,
    account_tax_ids: [first.id],
    metadata: { bt_scratch: RUN },
  });
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: probe.id,
    currency: ctx.config.currency,
    amount: 1_000,
    description: `${RUN} supplier-vat probe`,
  });
  const finalized = await stripe.invoices.finalizeInvoice(probe.id);
  defer(`vat probe invoice ${finalized.id}`, () => stripe.invoices.voidInvoice(finalized.id).catch(ignoreMissing));
  ok(
    "a finalized invoice now carries the supplier's tax id",
    (finalized.account_tax_ids ?? []).length > 0,
    `${(finalized.account_tax_ids ?? []).length} on ${eur(finalized.total)}`,
  );

  note(
    "the id is deleted in teardown: it is a DUMMY number, and it never became the account " +
      "default, so nothing else on this account depends on it",
  );
}
