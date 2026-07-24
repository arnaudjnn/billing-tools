export type MirrorQueryResult = {
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
};
export type MirrorQuery = (sql: string, params: unknown[]) => Promise<MirrorQueryResult>;
export interface MirrorOptions {
    /** Table name (identifier — validated). */
    table: string;
    /** WorkOS id column, e.g. "workos_org_id" or "workos_user_id". */
    idColumn: string;
    /** JSON metadata column. Default "workos_metadata". */
    metadataColumn?: string;
    /** Query executor returning { rows, rowCount }. Keeps this package pg-free. */
    query: MirrorQuery;
}
export interface Mirror {
    /** Insert the row from id + metadata if absent (no-op if it exists). */
    ensure(workosId: string, metadata?: Record<string, unknown>): Promise<void>;
    /** Full row, or null. */
    get(workosId: string): Promise<Record<string, unknown> | null>;
    /** Just the metadata blob, or null if the row is absent. */
    getMetadata(workosId: string): Promise<Record<string, unknown> | null>;
    /** Overwrite the metadata blob on an existing row. */
    setMetadata(workosId: string, metadata: Record<string, unknown>): Promise<void>;
    /** Delete the row. */
    remove(workosId: string): Promise<void>;
}
export declare function createMirror(opts: MirrorOptions): Mirror;
//# sourceMappingURL=mirror.d.ts.map