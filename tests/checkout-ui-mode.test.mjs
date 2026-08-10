// Who draws the form, and what comes back.
//
// Elements mode returns a CLIENT SECRET, which only a browser running Stripe.js can
// do anything with. That was the only mode, so a caller with no browser — an agent
// on `change_plan`, arriving at exactly the first-purchase case that needs a
// checkout — was handed a value it could not use. The consumer's answer was a
// hand-rolled `checkout.sessions.create` next to this one, which is how a second
// checkout path appears that inherits neither the deployment's tax nor its
// payment-method configuration and quietly bills 0%.
//
// So hosted mode exists, and what these assert is that it is the SAME session with a
// different front door: same tax, same methods, same metadata.

process.env.STRIPE_SECRET_KEY ??= "sk_test_fake";

import assert from "node:assert/strict";
import { test } from "vitest";

import { __setStripeForTests } from "../dist/billing.js";
import { createCheckoutSession } from "../dist/checkout.js";
import { __setPlanPricesForTests, lookupKeyFor } from "../dist/plans.js";
import { stripeList } from "./helpers.mjs";

const PLANS = {
  pro: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 2000, yearly: 20000 } } } },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    sale: "self_serve",
  },
};

__setPlanPricesForTests(new Map([[lookupKeyFor("pro", "monthly", "standard"), "price_std"]]));

function fakeStripe() {
  const sessions = [];
  return {
    sessions,
    checkout: {
      sessions: {
        async create(params) {
          sessions.push(params);
          // Stripe returns a url for a hosted session and a client secret for an
          // elements one; the fake mirrors that so a mode reading the wrong field
          // shows up as null rather than passing on the other mode's value.
          return params.ui_mode
            ? { id: "cs_1", client_secret: "cs_secret", url: null }
            : { id: "cs_1", client_secret: null, url: "https://checkout.stripe.com/c/pay/cs_1" };
        },
      },
    },
    customers: {
      async retrieve() {
        return { id: "cus_1", address: { country: "IT" }, tax_ids: { data: [] } };
      },
    },
    taxRates: {
      list() {
        return stripeList([]);
      },
      async create(params) {
        return { id: "txr_1", ...params };
      },
    },
    paymentMethodConfigurations: {
      list() {
        throw new Error("permission denied");
      },
    },
  };
}

const open = async (extra = {}) => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  const result = await createCheckoutSession({
    plans: PLANS,
    plan: "pro",
    interval: "monthly",
    seats: { standard: 1 },
    returnUrl: "https://t.local/done",
    customerId: "cus_1",
    currency: "eur",
    taxRates: ["txr_it_22"],
    metadata: { org_id: "org_1" },
    ...extra,
  });
  return { params: stripe.sessions[0], result };
};

test("elements stays the default, and keeps returning a client secret", async () => {
  const { params, result } = await open();
  assert.equal(params.ui_mode, "custom");
  assert.equal(params.return_url, "https://t.local/done");
  assert.equal(params.success_url, undefined, "an elements session has no hosted page");
  assert.equal(result.clientSecret, "cs_secret");
  assert.equal(result.url, null);
});

test("hosted returns a URL a caller with no browser can open", async () => {
  const { params, result } = await open({ uiMode: "hosted" });
  assert.equal(params.ui_mode, undefined, "hosted is Stripe's own page, not a ui_mode");
  assert.equal(params.success_url, "https://t.local/done");
  // `cancel_url` falls back to the same place: a customer who backs out has to land
  // somewhere, and a session without it is Stripe's error, not a default worth
  // making the caller state.
  assert.equal(params.cancel_url, "https://t.local/done");
  assert.equal(result.url, "https://checkout.stripe.com/c/pay/cs_1");
});

test("hosted is the same session — same tax, same methods, same metadata", async () => {
  // The whole point. A second, hand-rolled hosted session is how a deployment ends
  // up charging 22% on every form and 0% on the one an agent uses.
  const elements = await open();
  const hosted = await open({ uiMode: "hosted" });

  for (const key of [
    "line_items",
    "automatic_tax",
    "tax_id_collection",
    "payment_method_types",
    "metadata",
    "subscription_data",
    "customer_update",
    "billing_address_collection",
  ]) {
    assert.deepEqual(hosted.params[key], elements.params[key], `${key} differs between modes`);
  }
  assert.deepEqual(hosted.params.line_items[0].tax_rates, ["txr_it_22"]);
});

test("`config` is a real input, not one only the tests could pass", async () => {
  // The body always read `opts.config`; the public TYPE did not carry it, so no
  // TypeScript caller could hand it over and every seat session resolved tax as if
  // no declaration existed — right by luck where the Stripe account's country is the
  // establishment, silently wrong for `mode: "none"` and for registrations.
  const { params } = await open({
    taxRates: undefined,
    config: { baseUrl: "https://t.local", currency: "eur", tax: { mode: "none" } },
  });
  assert.deepEqual(params.automatic_tax, { enabled: false });
  assert.equal(params.line_items[0].tax_rates, undefined, "`mode: none` still taxed the line");
});

test("a reused session is never handed to the other mode", async () => {
  // `reuse` keys on everything that shapes the session. Without the mode in that
  // key, a caller asking for a URL would be handed the elements session opened a
  // moment earlier and read `url: null` as Stripe's fault.
  await open({ reuse: true });
  const { result } = await open({ uiMode: "hosted", reuse: true });
  assert.equal(result.url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(result.clientSecret, null);
});

// ── Requiring a tax id, and what Stripe will not let you do ──────────────────
//
// "If the address is in the UK, make the VAT number mandatory" is not expressible in one
// hosted session: the address is typed inside Stripe's form, after the session was
// created with this flag already fixed. Stripe's only value is `if_supported` — required
// wherever it supports a tax id type — so it is all-or-nothing across countries, and it
// is rejected outright under `ui_mode: "custom"`.
test("a tax id is offered but not required, by default", async () => {
  const { params } = await open();
  assert.deepEqual(params.tax_id_collection, { enabled: true });
});

test("taxIdRequired applies only to the hosted page, because Stripe rejects it elsewhere", async () => {
  const hosted = await open({ uiMode: "hosted", taxIdRequired: true });
  assert.deepEqual(hosted.params.tax_id_collection, { enabled: true, required: "if_supported" });

  // Elements mode: the parameter is dropped rather than sent, because sending it fails
  // the whole session instead of degrading — a checkout that 400s is worse than one that
  // collects an optional field.
  const elements = await open({ taxIdRequired: true });
  assert.deepEqual(elements.params.tax_id_collection, { enabled: true });
});

test("requiring a tax id is part of a reused session's identity", async () => {
  // Or a caller that asked for "required" could be handed the permissive session opened
  // a moment earlier, and a consumer would walk through a form that should have stopped.
  await open({ uiMode: "hosted", reuse: true });
  const { params } = await open({ uiMode: "hosted", taxIdRequired: true, reuse: true });
  assert.equal(params.tax_id_collection.required, "if_supported");
});

// ── The basket, refused before a session exists ──────────────────────────────
//
// `changePlan` has validated the basket since it was written; this path had not. So the
// two ways of buying the SAME basket disagreed, and the one that disagreed was the FIRST
// purchase — where a stepper in a browser was the only thing enforcing a limit. Every
// declared ceiling was enforced on an upgrade and by nothing at all on signup.

const LIMITED = {
  team: {
    sells: {
      kind: "seats",
      minSeats: 2,
      maxSeats: 5,
      seatTypes: {
        standard: { price: { monthly: 2000, yearly: 20000 }, min: 1 },
        // Declared unique. Nothing stopped a request buying fifty.
        lead: { price: { monthly: 9000, yearly: 90000 }, max: 1 },
      },
    },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    sale: "self_serve",
    limits: { members: 4 },
  },
  legacy: {
    sells: { kind: "seats", seatTypes: { standard: { price: { monthly: 1000, yearly: 10000 } } } },
    grant: { kind: "none" },
    cap: { kind: "wallet" },
    sale: "legacy",
  },
};

__setPlanPricesForTests(
  new Map([
    [lookupKeyFor("pro", "monthly", "standard"), "price_std"],
    [lookupKeyFor("team", "monthly", "standard"), "price_team_std"],
    [lookupKeyFor("team", "monthly", "lead"), "price_team_lead"],
  ]),
);

const openLimited = async (seats, extra = {}) => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  try {
    await createCheckoutSession({
      plans: LIMITED,
      plan: "team",
      interval: "monthly",
      seats,
      returnUrl: "https://t.local/done",
      customerId: "cus_1",
      currency: "eur",
      metadata: { org_id: "org_1" },
      ...extra,
    });
    return { error: null, created: stripe.sessions.length };
  } catch (e) {
    return { error: e, created: stripe.sessions.length };
  }
};

test("a seat type declared unique cannot be bought fifty times", async () => {
  const { error, created } = await openLimited({ standard: 1, lead: 50 });
  assert.equal(created, 0, "no session is opened for a basket that may not be bought");
  assert.equal(error?.name, "InvalidBasketError");
  assert.deepEqual(
    error.problems.map((p) => p.code),
    ["seat_type_limit", "seat_limit", "member_limit"],
    "every ceiling the catalogue declares, not just the first",
  );
});

test("the total minimum and the member limit are both enforced, not one or the other", async () => {
  // A stepper reading `maxSeats ?? limits.members` picks ONE of these; the catalogue
  // declares both and the tighter one is what the plan actually sells.
  const below = await openLimited({ standard: 1 });
  assert.deepEqual(below.error.problems, [{ code: "below_minimum", min: 2, got: 1 }]);

  const overMembers = await openLimited({ standard: 5 });
  assert.deepEqual(
    overMembers.error.problems,
    [{ code: "member_limit", max: 4, got: 5 }],
    "5 is inside maxSeats and outside limits.members",
  );
});

test("a plan kept only for existing subscribers cannot be bought by anybody new", async () => {
  const stripe = fakeStripe();
  __setStripeForTests(stripe);
  await assert.rejects(
    () =>
      createCheckoutSession({
        plans: LIMITED,
        plan: "legacy",
        interval: "monthly",
        seats: { standard: 1 },
        returnUrl: "https://t.local/done",
        customerId: "cus_1",
      }),
    (e) => e.name === "InvalidBasketError" && e.problems[0].code === "not_purchasable",
  );
  assert.equal(stripe.sessions.length, 0);
});

test("an invalid basket is not REMEMBERED either", async () => {
  // The refusal is before the reuse cache. Behind it, one crafted request would poison the
  // key for every later caller asking for the same basket.
  const first = await openLimited({ standard: 1, lead: 50 }, { reuse: true });
  assert.equal(first.error?.name, "InvalidBasketError");
  const second = await openLimited({ standard: 1, lead: 50 }, { reuse: true });
  assert.equal(second.error?.name, "InvalidBasketError", "still refused, not served from cache");
});

test("a valid basket still opens exactly one session", async () => {
  const { error, created } = await openLimited({ standard: 2, lead: 1 });
  assert.equal(error, null, error?.message);
  assert.equal(created, 1);
});
