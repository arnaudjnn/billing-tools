// Generic, table-agnostic DB mirror for WorkOS entities. WorkOS stays the
// source of truth; an app that keeps a database shadows each WorkOS org/user in
// a local row so it can join/query without a round-trip. This helper owns just
// two columns — the WorkOS id and a `workos_metadata` JSON blob — and leaves
// every other column on the table to the app.
//
// It's DB-free: you pass a `query` executor (e.g. a thin wrapper over `pg`), so
// billing-tools never depends on a database driver. Two conventional shapes:
//   - org mirror:  { workos_org_id, workos_metadata }
//   - user mirror: { workos_user_id, workos_metadata }
//
// `ensure` inserts a row from the id + metadata alone, so it only fits tables
// whose other columns are nullable/defaulted (e.g. a users table). For a table
// with required app columns (e.g. a workspaces table the app inserts itself),
// use `setMetadata` to update the blob on the already-created row.
// Identifiers are developer config (not user input), but validate anyway since
// they're interpolated into SQL.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function createMirror(opts) {
    const { table, idColumn, query } = opts;
    const meta = opts.metadataColumn ?? "workos_metadata";
    for (const ident of [table, idColumn, meta]) {
        if (!IDENTIFIER.test(ident)) {
            throw new Error(`createMirror: invalid SQL identifier "${ident}"`);
        }
    }
    return {
        async ensure(workosId, metadata = {}) {
            await query(`INSERT INTO ${table} (${idColumn}, ${meta}) VALUES ($1, $2)
         ON CONFLICT (${idColumn}) DO NOTHING`, [workosId, JSON.stringify(metadata)]);
        },
        async get(workosId) {
            const r = await query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [workosId]);
            return r.rows[0] ?? null;
        },
        async getMetadata(workosId) {
            const r = await query(`SELECT ${meta} AS metadata FROM ${table} WHERE ${idColumn} = $1`, [workosId]);
            return r.rows[0]?.metadata ?? null;
        },
        async setMetadata(workosId, metadata) {
            await query(`UPDATE ${table} SET ${meta} = $2 WHERE ${idColumn} = $1`, [
                workosId,
                JSON.stringify(metadata),
            ]);
        },
        async remove(workosId) {
            await query(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [workosId]);
        },
    };
}
//# sourceMappingURL=mirror.js.map