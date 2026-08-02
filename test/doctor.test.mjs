// The doctor's job is to catch configurations that fail SILENTLY, so its own
// checks are worth asserting: a check that stops firing is indistinguishable
// from a healthy account.

import assert from "node:assert/strict";
import { test } from "vitest";

import { checkPlansConfig } from "../dist/doctor.js";

const find = (r, title) => r.checks.find((c) => c.title.includes(title));

test("a plan that both invoices and credits is an error", () => {
  // The measured defect: a Stripe credit balance auto-applies to the next
  // invoice, so crediting a plan's own included credits discounts its renewal.
  const r = checkPlansConfig(
    {
      pro: {
        sells: { kind: "flat", price: { monthly: 5000, yearly: 50000 } },
        grant: { kind: "fixed", credits: 1000 },
        sale: "self_serve",
      },
    },
    { hasCheckout: true },
  );
  const c = find(r, "credits its own invoice");
  assert.ok(c, "expected the grant-vs-cap check to fire");
  assert.equal(c.level, "error");
  assert.equal(r.healthy, false);
});

test("self-serve plans with no checkout are flagged", () => {
  // gtm-tools shipped exactly this: plans on the pricing page, no way to buy
  // one, so resolvePlan stayed null and the pooled cap never activated.
  const plans = {
    pro: {
      sells: { kind: "flat", price: { monthly: 5000, yearly: 50000 } },
      cap: { kind: "pool", credits: 100000 },
      sale: "self_serve",
    },
  };
  const flagged = find(checkPlansConfig(plans), "no way to buy them");
  assert.ok(flagged, "expected the unbuyable-catalogue check to fire");
  assert.equal(flagged.level, "warn");

  assert.equal(
    find(checkPlansConfig(plans, { hasCheckout: true }), "no way to buy them"),
    undefined,
    "must not fire once a checkout is mounted",
  );
});

test("a quote-only catalogue is not flagged as unbuyable", () => {
  // Nothing is promised as self-serve, so there is nothing missing.
  const r = checkPlansConfig({
    enterprise: {
      sells: { kind: "flat", price: { monthly: 0, yearly: 500000 }, intervals: ["yearly"] },
      cap: { kind: "pool", credits: 1000000 },
      sale: "quote",
    },
  });
  assert.equal(find(r, "no way to buy them"), undefined);
});

test("a healthy config reports healthy", () => {
  const r = checkPlansConfig(
    {
      hobby: { sells: { kind: "nothing" }, cap: { kind: "pool", credits: 1000 }, sale: "free" },
      pro: {
        sells: {
          kind: "seats",
          seatTypes: {
            standard: { price: { monthly: 1800, yearly: 18000 }, includedCredits: 1000 },
            api: { price: { monthly: 5000, yearly: 50000 }, includedCredits: 25000, shared: true, max: 1 },
          },
        },
        cap: { kind: "per_seat" },
        sale: "self_serve",
      },
    },
    { hasCheckout: true },
  );
  assert.equal(r.healthy, true, JSON.stringify(r.checks, null, 2));
});
