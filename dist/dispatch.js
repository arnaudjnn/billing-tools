import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export class ToolValidationError extends Error {
}
export function createDispatcher(register) {
    let handlers = null;
    function init() {
        if (handlers)
            return;
        const map = new Map();
        const server = new McpServer({ name: "rest-dispatch", version: "0.0.0" });
        const origTool = server.tool.bind(server);
        server.tool = function (...args) {
            const name = args[0];
            const cb = args[args.length - 1];
            let validator = null;
            const shape = args.length >= 4 ? args[2] : null;
            if (shape && typeof shape === "object" && !Array.isArray(shape)) {
                try {
                    validator = z.object(shape);
                }
                catch {
                    validator = null;
                }
            }
            if (typeof cb === "function" && typeof name === "string") {
                map.set(name, { cb: cb, validator });
            }
            return origTool(...args);
        };
        register(server);
        handlers = map;
    }
    async function dispatchTool(name, args) {
        init();
        const entry = handlers.get(name);
        if (!entry)
            throw new Error(`Unknown tool: ${name}`);
        if (args && typeof args === "object") {
            args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
        }
        let callArgs = args;
        if (entry.validator) {
            const parsed = entry.validator.safeParse(args ?? {});
            if (!parsed.success) {
                const detail = parsed.error.issues
                    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                    .join("; ");
                throw new ToolValidationError(`Invalid arguments for ${name}: ${detail}`);
            }
            callArgs = parsed.data;
        }
        const extra = { _meta: {}, sendNotification: async () => { } };
        const result = await entry.cb(callArgs, extra);
        if (result?.isError)
            throw new Error(result.content?.[0]?.text || "Tool error");
        const text = result?.content?.[0]?.text;
        if (!text)
            return result;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    function getToolNames() {
        init();
        return Array.from(handlers.keys());
    }
    return { dispatchTool, getToolNames };
}
//# sourceMappingURL=dispatch.js.map