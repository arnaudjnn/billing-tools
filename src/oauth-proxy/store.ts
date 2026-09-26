// State for the MCP OAuth proxy, behind a pluggable interface.
//
// Three kinds of record, with very different lifetimes:
//   client   RFC 7591 registration. A connector (claude.ai, ChatGPT, Claude Code)
//            registers ONCE and keeps its client_id for as long as the user keeps
//            the connector — weeks, months. Losing it answers every later
//            authorize with `invalid_client`, and the only cure is the user
//            removing and re-adding the connector.
//   session  the client's parked /authorize request, while the user is at AuthKit
//            (minutes).
//   code     our authorization code, between the callback and /token (minutes),
//            and SINGLE-USE.
//
// The default store is a Map in this process, which is right for one long-lived
// process and wrong for everything else: a redeploy forgets every registered
// client, and behind two replicas a code minted by one is unknown to the other.
// A deployment with either inject a persistent `store`.
//
// Keys are opaque to the store. The proxy already hashes the bearer ones (session
// ids, codes) before they get here and seals the tokens inside a code record, so a
// store holds nothing that can be replayed from its rows alone.

export interface OAuthClientRecord {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: number;
  /** When the TTL was last extended — see `touchClient` in the proxy. */
  refreshed_at?: number;
}

export interface OAuthSessionRecord {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  created_at: number;
}

export interface OAuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  /** The WorkOS access + refresh tokens, AES-256-GCM sealed with a key derived
   *  from the code itself — only the holder of the code can open them. */
  sealed_tokens: string;
  created_at: number;
}

export interface OAuthStoreRecords {
  client: OAuthClientRecord;
  session: OAuthSessionRecord;
  code: OAuthCodeRecord;
}

export type OAuthRecordKind = keyof OAuthStoreRecords;

/**
 * Persistence for the OAuth proxy. Values are plain JSON-serialisable objects.
 *
 * TTL: `set` takes the lifetime in ms, or `null` for an entry that never expires.
 * An expired entry must read as absent (`get` and `take` return null) — whether
 * it is also physically removed then or later is the store's business.
 *
 * `take` is the single-use primitive: it returns the entry AND removes it, and
 * two concurrent `take`s of one key must not both receive it (a Postgres
 * `DELETE … RETURNING`, a Redis `GETDEL`). This is what makes an authorization
 * code single-use across instances; a get-then-delete would let two replicas
 * redeem the same code.
 */
export interface OAuthStore {
  get<K extends OAuthRecordKind>(kind: K, key: string): Promise<OAuthStoreRecords[K] | null>;
  set<K extends OAuthRecordKind>(
    kind: K,
    key: string,
    value: OAuthStoreRecords[K],
    ttlMs: number | null,
  ): Promise<void>;
  delete(kind: OAuthRecordKind, key: string): Promise<void>;
  take<K extends OAuthRecordKind>(kind: K, key: string): Promise<OAuthStoreRecords[K] | null>;
}

/** Default single-process store. Pruned on access rather than on a timer, so
 *  there is no dangling interval in a serverless/edge build. */
export function inMemoryOAuthStore(): OAuthStore {
  const entries = new Map<string, { value: unknown; expiresAt: number | null }>();
  const id = (kind: OAuthRecordKind, key: string) => `${kind}:${key}`;

  function prune(): void {
    const now = Date.now();
    for (const [k, e] of entries) if (e.expiresAt !== null && now >= e.expiresAt) entries.delete(k);
  }

  return {
    async get(kind, key) {
      prune();
      return (entries.get(id(kind, key))?.value ?? null) as never;
    },
    async set(kind, key, value, ttlMs) {
      prune();
      entries.set(id(kind, key), { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
    },
    async delete(kind, key) {
      entries.delete(id(kind, key));
    },
    async take(kind, key) {
      prune();
      const e = entries.get(id(kind, key));
      entries.delete(id(kind, key));
      return (e?.value ?? null) as never;
    },
  };
}
