export interface Dispatcher {
    dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    getToolNames(): string[];
}
export declare function createToolListHandler(opts: {
    dispatcher: Dispatcher;
    toolCosts?: Record<string, number>;
}): (request: Request) => Promise<Response>;
export declare function createToolDispatchHandler(opts: {
    dispatcher: Dispatcher;
    realm?: string;
}): (request: Request, ctx: {
    params: Promise<{
        tool: string;
    }>;
}) => Promise<Response>;
//# sourceMappingURL=rest.d.ts.map