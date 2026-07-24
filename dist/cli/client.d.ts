export interface ApiClientConfig {
    baseUrl: string;
    apiKey: string;
}
export declare function callTool(config: ApiClientConfig, tool: string, args?: Record<string, unknown>): Promise<unknown>;
export declare function listTools(config: ApiClientConfig): Promise<Array<{
    name: string;
    cost: number;
}>>;
//# sourceMappingURL=client.d.ts.map