// The dev webhook command reads the key from the dotenv file it writes to.
//
// `npx billing-tools dev` writes STRIPE_WEBHOOK_SECRET into .env.local — the
// app's own env file — and used to demand STRIPE_SECRET_KEY from the process
// environment anyway. So in the repo shape the command documents itself for
// (key in .env.local, nothing exported), it failed outright: "No
// STRIPE_SECRET_KEY". Measured on a consumer, which is what led here.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { readEnvVar, setEnvVar } from "../dist/dev/stripe-cli.js";

const dir = () => mkdtempSync(join(tmpdir(), "bt-dev-"));

test("a key is read out of a dotenv file, quotes and spacing tolerated", async () => {
  const file = join(dir(), ".env.local");
  writeFileSync(
    file,
    ['# a comment', 'STRIPE_SECRET_KEY = "sk_test_abc"', "OTHER=1", ""].join("\n"),
  );
  assert.equal(await readEnvVar(file, "STRIPE_SECRET_KEY"), "sk_test_abc");
  assert.equal(await readEnvVar(file, "OTHER"), "1");
});

test("a missing file, a missing key and an empty value all answer undefined", async () => {
  const file = join(dir(), ".env.local");
  assert.equal(await readEnvVar(file, "STRIPE_SECRET_KEY"), undefined);
  writeFileSync(file, "STRIPE_SECRET_KEY=\nOTHER=x\n");
  assert.equal(await readEnvVar(file, "STRIPE_SECRET_KEY"), undefined, "empty is not a key");
  assert.equal(await readEnvVar(file, "ABSENT"), undefined);
});

test("setEnvVar and readEnvVar round-trip, and rewriting leaves one line", async () => {
  const file = join(dir(), ".env.local");
  await setEnvVar(file, "STRIPE_WEBHOOK_SECRET", "whsec_1");
  assert.equal(await readEnvVar(file, "STRIPE_WEBHOOK_SECRET"), "whsec_1");
  await setEnvVar(file, "STRIPE_WEBHOOK_SECRET", "whsec_2");
  assert.equal(await readEnvVar(file, "STRIPE_WEBHOOK_SECRET"), "whsec_2");
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("STRIPE_WEBHOOK_SECRET="));
  assert.equal(lines.length, 1, "two definitions of one key is a debugging afternoon");
});
