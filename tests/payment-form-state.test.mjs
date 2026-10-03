// A payment form must say when it can be submitted, and never swallow a submit.
//
// Both forms returned early from `onSubmit` while Stripe was initialising, so the first press
// on a slow network did nothing at all — no error, no state the app could read. Scartoffie
// disabled its own button until ready; every other consumer shipped one that ignores its
// first click. And a load failure (bad key, blocked script, expired session) was swallowed by
// the same early return, so a broken form looked like a slow one for ever.
//
// The decision lives in `src/ui/form-state.ts`, free of React and Stripe.js, which is what
// lets it be asserted here (this suite has no DOM). The last test pins that both forms
// actually USE it, since a pure function nobody calls protects nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { paymentFormState, submitRefusal, SUBMITTING } from "../dist/ui/form-state.js";
import { resolveMessages } from "../dist/i18n.js";

const t = resolveMessages();
const base = { sdkReady: true, elementReady: true, elementRequired: true, loadError: null, submitting: false };

test("ready only once the SDK has loaded AND the payment fields are mounted", () => {
  assert.equal(paymentFormState({ ...base, sdkReady: false }).ready, false);
  assert.equal(paymentFormState({ ...base, elementReady: false }).ready, false);
  assert.deepEqual(paymentFormState(base), { ready: true, disabled: false, error: null });
});

test("a saved card mounts no element, so it is ready on the SDK alone", () => {
  const s = paymentFormState({ ...base, elementReady: false, elementRequired: false });
  assert.equal(s.ready, true);
});

test("disabled while not ready, while submitting, and when broken", () => {
  assert.equal(paymentFormState({ ...base, sdkReady: false }).disabled, true);
  assert.equal(paymentFormState({ ...base, submitting: true }).disabled, true);
  const broken = paymentFormState({ ...base, loadError: "Invalid API Key provided" });
  assert.deepEqual(broken, { ready: false, disabled: true, error: "Invalid API Key provided" });
});

test("a submit before ready is REPORTED with a sentence, not dropped", () => {
  // REGRESSION: `if (!stripe || !elements) return;` — the press vanished.
  const notReady = paymentFormState({ ...base, sdkReady: false });
  assert.equal(submitRefusal(notReady, false, t), t.paymentFormNotReady);
  assert.match(t.paymentFormNotReady, /loading/);
});

test("a load failure is surfaced on submit as the failure itself", () => {
  const broken = paymentFormState({ ...base, loadError: "This Checkout Session has expired" });
  assert.equal(submitRefusal(broken, false, t), "This Checkout Session has expired");
});

test("a ready form goes ahead; a second press mid-submit is ignored quietly", () => {
  assert.equal(submitRefusal(paymentFormState(base), false, t), null);
  assert.equal(submitRefusal(paymentFormState({ ...base, submitting: true }), true, t), SUBMITTING);
});

test("both forms are wired to it: ready state, onReady, load errors, disabled submit area", () => {
  const src = readFileSync(new URL("../src/ui/index.tsx", import.meta.url), "utf8");
  const forms = ["BillingPaymentForm", "BillingCheckoutSessionForm"].map((name) => {
    const start = src.indexOf(`export function ${name}(`);
    const end = src.indexOf("\nexport ", start + 10);
    return [name, src.slice(start, end)];
  });
  for (const [name, body] of forms) {
    assert.ok(body.includes("paymentFormState("), `${name} computes its state`);
    assert.ok(body.includes("submitRefusal("), `${name} reports a refused submit`);
    assert.ok(body.includes("onLoadError="), `${name} surfaces an element load failure`);
    assert.ok(body.includes("onReady={() => setElementReady(true)}"), `${name} waits for the element`);
    assert.ok(body.includes("useReadyCallback(state.ready, onReady)"), `${name} calls onReady`);
    assert.ok(/<SubmitArea disabled=\{state\.disabled\}>/.test(body), `${name} disables its own submit`);
    assert.ok(!/if \(!stripe \|\| !elements \|\| submitting\) return;/.test(body), `${name}: no silent early return`);
  }
  assert.ok(/<fieldset disabled=\{disabled\}/.test(src), "the submit area is a disabling fieldset");
});
