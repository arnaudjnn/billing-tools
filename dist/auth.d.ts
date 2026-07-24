import { AsyncLocalStorage } from "node:async_hooks";
import type { BillingAdapter, ResolvedConfig, ToolErrorResult } from "./types.js";
interface AuthStore {
    authHeader: string | null;
    orgId?: string;
}
export declare const authContext: AsyncLocalStorage<AuthStore>;
export declare function runWithAuth<T>(header: string | null, fn: () => T): T;
export declare function runWithResolvedOrg<T>(header: string | null, orgId: string, fn: () => T): T;
export declare function enforceAccess(adapter: BillingAdapter): Promise<{
    authorized: true;
    orgId: string;
} | ToolErrorResult>;
export declare function enforceTokens(adapter: BillingAdapter, config: ResolvedConfig, orgId: string, toolName: string, cost: number): Promise<ToolErrorResult | null>;
export {};
//# sourceMappingURL=auth.d.ts.map