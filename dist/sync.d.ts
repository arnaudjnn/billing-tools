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
        /** A subscription invoice failed to collect (dunning). The org's status is
         *  already set to `past_due`; use this to notify the user / gate access.
         *  Stripe Smart Retries + the card-updater keep retrying automatically. */
        onPaymentFailed?(orgId: string): Promise<void>;
    };
}
export interface BillingSync {
    /** Poll + reconcile once. Use this from a serverless cron route. */
    runOnce(): Promise<{
        stripe: number;
        workos: number;
    }>;
    /** Start an in-process interval scheduler (for a long-lived server — e.g.
     *  Next's instrumentation register()). Runs immediately, then every
     *  intervalMs (default 60s), never overlapping. Returns a stop() fn.
     *  For multi-instance deployments run it on one replica (or use runOnce via
     *  a single external cron) to avoid duplicate polling. */
    start(opts?: {
        intervalMs?: number;
        onError?: (e: unknown) => void;
    }): () => void;
}
export declare function createBillingSync(opts: BillingSyncOptions): BillingSync;
/** Web-standard (Request → Response) handler that runs one sync cycle — for a
 *  serverless cron trigger. Framework-agnostic: mount in a Next route
 *  (`export const GET = createSyncRoute(sync, { secret })`), Hono, Bun, etc.
 *  If `secret` is set, requests must send it as `Authorization: Bearer <secret>`
 *  (or an `x-cron-secret` header). */
export declare function createSyncRoute(sync: BillingSync, opts?: {
    secret?: string;
}): (request: Request) => Promise<Response>;
//# sourceMappingURL=sync.d.ts.map