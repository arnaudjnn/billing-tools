import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// REST bridge: build a shadow MCP server, capture each tool's handler + zod
// validator by monkey-patching server.tool, and dispatch by name. The register
// callback is whatever the host passes (typically one that calls
// registerBillingTools + the host's own product tools).

type ToolHandler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

export class ToolValidationError extends Error {}

interface Registered {
  cb: ToolHandler;
  validator: z.ZodTypeAny | null;
  /** What server.tool() returned: the SDK's registered tool, whose
   *  `inputSchema` is what an MCP call is validated against. */
  tool: { inputSchema?: unknown } | null;
}

export type RegisterFn = (server: McpServer) => void;

function isSchema(v: unknown): v is z.ZodTypeAny {
  return !!v && typeof (v as { safeParse?: unknown }).safeParse === "function";
}

export function createDispatcher(register: RegisterFn) {
  let handlers: Map<string, Registered> | null = null;

  function init() {
    if (handlers) return;
    const map = new Map<string, Registered>();
    const server = new McpServer({ name: "rest-dispatch", version: "0.0.0" });
    const origTool = server.tool.bind(server) as (...a: unknown[]) => void;
    (server as unknown as { tool: (...a: unknown[]) => void }).tool = function (...args: unknown[]) {
      const name = args[0] as string;
      const cb = args[args.length - 1] as Function;
      let validator: z.ZodTypeAny | null = null;
      const shape = args.length >= 4 ? args[2] : null;
      if (shape && typeof shape === "object" && !Array.isArray(shape)) {
        try {
          validator = z.object(shape as z.ZodRawShape);
        } catch {
          validator = null;
        }
      }
      const tool = origTool(...args) as unknown as { inputSchema?: unknown } | undefined;
      if (typeof cb === "function" && typeof name === "string") {
        map.set(name, { cb: cb as ToolHandler, validator, tool: tool ?? null });
      }
      return tool;
    };
    register(server);
    handlers = map;
  }

  async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    init();
    const entry = handlers!.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);

    if (args && typeof args === "object") {
      args = Object.fromEntries(
        Object.entries(args).filter(([, v]) => v !== null && v !== undefined),
      );
    }
    let callArgs = args;
    // Validate the way the MCP server does: against the registered tool's own
    // inputSchema, read at CALL time. For a raw shape that is the SDK's object
    // of it — the same as `validator` — but a host may replace it after
    // registering (a passthrough object, so an argument the tool does not
    // declare reaches the handler and can be REPORTED rather than silently
    // stripped). Rebuilding z.object(shape) here made /api/v0 disagree with MCP.
    const validator = isSchema(entry.tool?.inputSchema) ? entry.tool!.inputSchema : entry.validator;
    if (validator) {
      const parsed = validator.safeParse(args ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new ToolValidationError(`Invalid arguments for ${name}: ${detail}`);
      }
      callArgs = parsed.data as Record<string, unknown>;
    }
    const extra = { _meta: {}, sendNotification: async () => {} };
    const result = await entry.cb(callArgs, extra as Record<string, unknown>);
    if (result?.isError) throw new Error(result.content?.[0]?.text || "Tool error");
    const text = result?.content?.[0]?.text;
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function getToolNames(): string[] {
    init();
    return Array.from(handlers!.keys());
  }

  return { dispatchTool, getToolNames };
}
