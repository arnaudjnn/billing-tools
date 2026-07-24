import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare class ToolValidationError extends Error {
}
export type RegisterFn = (server: McpServer) => void;
export declare function createDispatcher(register: RegisterFn): {
    dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    getToolNames: () => string[];
};
//# sourceMappingURL=dispatch.d.ts.map