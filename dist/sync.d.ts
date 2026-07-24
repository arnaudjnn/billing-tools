import { type PlansConfig } from "./plans.js";
import type { Mirror, MirrorQuery } from "./mirror.js";
import type { WorkOSOrgAdapter } from "./adapters/workos-org.js";
/** Optional custom cursor persistence. By default the sync manages its own tiny
 *  cursor table via the `query` executor — the app declares nothing. */
export interface CursorStore {
    get(source: string): Promise<string | null>;
    set(source: string, cursor: string | null): Promise<void>;
}
export interface BillingSyncOptions {
    adapter: WorkOSOrgAdapter;
    plans: PlansConfig;
    /** DB executor (same one you pass to createMirror). The sync creates + uses
     *  its own `billing_sync_cursors` table through it — no app schema needed. */
    query: MirrorQuery;
    currency?: string;
    /** Override cursor persistence (advanced). Defaults to the query-backed table. */
    cursor?: CursorStore;
    /** Mirror of the WorkOS Organization (e.g. a workspaces table). */
    orgMirror?: Mirror;
    /** Mirror of the WorkOS User (e.g. a users table). */
    userMirror?: Mirror;
    hooks?: {
        /** Extra app-specific cleanup when a WorkOS user is deleted (the user
         *  mirror row is already removed). */
        onUserDeleted?(workosUserId: string): Promise<void>;
    };
}
export interface BillingSync {
    runOnce(): Promise<{
        stripe: number;
        workos: number;
    }>;
}
export declare function createBillingSync(opts: BillingSyncOptions): BillingSync;
//# sourceMappingURL=sync.d.ts.map