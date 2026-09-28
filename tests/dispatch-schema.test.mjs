// /api/v0 (createDispatcher) must validate a call the way the MCP server does:
// against the registered tool's own inputSchema. A host that replaces it after
// registering (a passthrough object, so unknown arguments can be reported) was
// overruled by the dispatcher's own z.object(shape), which stripped them.
import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";

const { createDispatcher } = await import(new URL("../dist/dispatch.js", import.meta.url).href);

const register = (passthrough) => (server) => {
  const shape = { q: z.string().optional() };
  const tool = server.tool("echo", "Echo the arguments", shape, async (args) => ({
    content: [{ type: "text", text: JSON.stringify(args) }],
  }));
  if (passthrough) tool.inputSchema = z.object(shape).passthrough();
};

test("a raw shape strips an undeclared argument, as MCP does", async () => {
  const d = createDispatcher(register(false));
  assert.deepEqual(await d.dispatchTool("echo", { q: "x", bogus: 1 }), { q: "x" });
});

test("a host's passthrough inputSchema reaches the handler with the undeclared argument", async () => {
  const d = createDispatcher(register(true));
  assert.deepEqual(await d.dispatchTool("echo", { q: "x", employees_minimum: 50 }), { q: "x", employees_minimum: 50 });
});

test("a wrong type is still refused against the host's schema", async () => {
  const d = createDispatcher(register(true));
  await assert.rejects(() => d.dispatchTool("echo", { q: 5 }), /Invalid arguments for echo/);
});
