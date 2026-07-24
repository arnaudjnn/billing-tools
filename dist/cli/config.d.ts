export interface CliOptions {
    configDir: string;
    envPrefix: string;
    defaultUrl: string;
}
export interface CliConfig {
    apiKey?: string;
    email?: string;
    baseUrl?: string;
}
export declare function configPath(opts: CliOptions): string;
export declare function readConfig(opts: CliOptions): CliConfig;
export declare function writeConfig(opts: CliOptions, c: CliConfig): void;
export declare function resolveBaseUrl(opts: CliOptions, cliUrl?: string): string;
export declare function resolveApiKey(opts: CliOptions, cliKey?: string): string | undefined;
//# sourceMappingURL=config.d.ts.map