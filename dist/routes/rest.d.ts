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
    /** Advertise the auth.md PRM discovery doc in the 401 WWW-Authenticate header
     *  (`resource_metadata="…"`) so agents can bootstrap. String or per-request. */
    resourceMetadata?: string | ((request: Request) => string);
}): (request: Request, ctx: {
    params: Promise<{
        tool: string;
    }>;
}) => Promise<Response>;
//# sourceMappingURL=rest.d.ts.map