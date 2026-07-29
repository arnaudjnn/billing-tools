// MCP OAuth 2.1 proxy: lets a *dynamic* client (Claude Desktop, Claude.ai, any
// MCP client that speaks RFC 7591 Dynamic Client Registration) connect to a
// remote MCP server without a human pasting an API key.
//
// It is a proxy, not an authorization server: the user actually authenticates
// with WorkOS AuthKit, and we translate that into the OAuth shape MCP clients
// expect. Four endpoints, all framework-agnostic (Request → Response):
//
//   POST /oauth/register   RFC 7591 — client registers, gets a client_id
//   GET  /oauth/authorize  parks the client's request, redirects to AuthKit
//   GET  /oauth/callback   AuthKit returns; we mint OUR code, bounce to the client
//   POST /oauth/token      code → {access_token, refresh_token}; also refreshes
//
// The access token handed back is the WorkOS access token (short-lived, ~10 min).
// The refresh token is OUR HS256 JWT wrapping the WorkOS refresh token, so the
// client never holds WorkOS credentials directly and we can bind the token to
// the client_id that obtained it.
//
// Why this lives here and not in an app: it is pure protocol plumbing with one
// product-specific input (the WorkOS project). Two consumers already needed it,
// and the second one copying the first is how the fallback-secret bug below got
// duplicated in the first place.
//
// SECURITY — the refresh secret is REQUIRED. An earlier app-local version fell
// back to `WORKOS_CLIENT_ID`, which is a *public* OAuth identifier that appears
// in authorize URLs and discovery documents, so anyone who knew it could forge a
// 30-day refresh token. There is deliberately no fallback here: without
// REFRESH_TOKEN_SECRET the token endpoint returns server_error rather than
// signing with something guessable.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getWorkOS } from "../workos.js";

export interface ClaimGrantChain {
  type: string;
  handle: (params: Record<string, string>) => Promise<Response> | Response;
}

export interface OAuthProxyPaths {
  authorize?: string; // default "/oauth/authorize"
  register?: string; // default "/oauth/register"
  callback?: string; // default "/oauth/callback"
}

export interface OAuthProxyOptions {
  /** Absolute base URL for the AuthKit redirect_uri + advertised endpoints.
   *  String, per-request resolver, or omitted to derive from forwarded headers. */
  baseUrl?: string | ((request: Request) => string);
  /** WorkOS client id. Defaults to process.env.WORKOS_CLIENT_ID. */
  workosClientId?: string;
  /** HS256 key for the proxy's refresh tokens. Defaults to
   *  process.env.REFRESH_TOKEN_SECRET. No fallback — see the note above. */
  refreshSecret?: string;
  paths?: OAuthProxyPaths;
  /** Seconds/ms overrides. accessTokenTtl is what we *advertise* for the WorkOS
   *  access token; refreshTtl is how long our wrapper JWT stays valid. */
  ttl?: {
    clientMs?: number; // default 24h
    sessionMs?: number; // default 10m
    codeMs?: number; // default 5m
    accessTokenSeconds?: number; // default 600
    refreshSeconds?: number; // default 30d
  };
  /** Chain another grant type through the same /oauth/token route — e.g.
   *  auth.md's claim grant, so one route serves both. Pass a function when the
   *  handler isn't available yet at construction (createBilling builds the proxy
   *  first, because agent-auth needs its endpoints for discovery). */
  claimGrant?: ClaimGrantChain | (() => ClaimGrantChain | undefined);
}

interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: number;
}

interface AuthSession {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  created_at: number;
}

interface AuthCodeEntry {
  client_id: string;
  redirect_uri: string;
  access_token: string;
  refresh_token: string;
  code_challenge?: string;
  code_challenge_method?: string;
  used: boolean;
  created_at: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

function jsonError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status });
}

function baseUrlFromRequest(request: Request): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

/** RFC 7636. `plain` is accepted because the MCP spec still allows it, but S256
 *  is what every real client sends. */
function verifyCodeChallenge(verifier: string, challenge: string, method: string): boolean {
  if (method === "plain") return verifier === challenge;
  if (method === "S256") return createHash("sha256").update(verifier).digest("base64url") === challenge;
  return false;
}

export function createOAuthProxy(opts: OAuthProxyOptions = {}) {
  const paths: Required<OAuthProxyPaths> = {
    authorize: opts.paths?.authorize ?? "/oauth/authorize",
    register: opts.paths?.register ?? "/oauth/register",
    callback: opts.paths?.callback ?? "/oauth/callback",
  };
  const CLIENT_TTL = opts.ttl?.clientMs ?? 24 * 60 * 60 * 1000;
  const SESSION_TTL = opts.ttl?.sessionMs ?? 10 * 60 * 1000;
  const CODE_TTL = opts.ttl?.codeMs ?? 5 * 60 * 1000;
  const ACCESS_TTL = opts.ttl?.accessTokenSeconds ?? 600;
  const REFRESH_TTL = opts.ttl?.refreshSeconds ?? 30 * 24 * 60 * 60;

  // In-memory, single-process — same assumption as the default claim store.
  // Pruned on access rather than on a timer, so there is no dangling interval in
  // a serverless/edge build.
  const clients = new Map<string, RegisteredClient>();
  const sessions = new Map<string, AuthSession>();
  const codes = new Map<string, AuthCodeEntry>();

  function prune(): void {
    const now = Date.now();
    for (const [k, v] of clients) if (now - v.created_at > CLIENT_TTL) clients.delete(k);
    for (const [k, v] of sessions) if (now - v.created_at > SESSION_TTL) sessions.delete(k);
    for (const [k, v] of codes) if (now - v.created_at > CODE_TTL) codes.delete(k);
  }

  const baseUrlOf = (request: Request): string =>
    typeof opts.baseUrl === "function"
      ? opts.baseUrl(request)
      : (opts.baseUrl ?? baseUrlFromRequest(request));

  const workosClientId = () => opts.workosClientId ?? process.env.WORKOS_CLIENT_ID;

  /** Throws when unset — callers turn that into a 500 rather than signing with
   *  a guessable key. Read lazily so app boot never depends on it. */
  function refreshKey(): Buffer {
    const s = opts.refreshSecret ?? process.env.REFRESH_TOKEN_SECRET;
    if (!s) {
      throw new Error(
        "REFRESH_TOKEN_SECRET is not configured — the OAuth proxy refuses to sign refresh tokens without it",
      );
    }
    return Buffer.from(s, "utf8");
  }

  // HS256 JWT by hand: `jose` would be a dependency for ~15 lines, and the
  // format is wire-compatible with it (same header, same claims), so tokens
  // minted by an app's previous jose-based implementation still verify here.
  function signRefresh(workosRefreshToken: string, clientId: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const payload = b64url(
      Buffer.from(JSON.stringify({ wrt: workosRefreshToken, cid: clientId, iat: now, exp: now + REFRESH_TTL })),
    );
    const sig = b64url(createHmac("sha256", refreshKey()).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${sig}`;
  }

  /** Throws if the secret is missing (a 500 condition), returns null for a token
   *  that is simply invalid (a 400 condition). Conflating the two sent
   *  "invalid_grant" to a client whose token was fine while WE were misconfigured. */
  function verifyRefresh(token: string): { workosRefreshToken: string; clientId: string } | null {
    const expected = ((): Buffer | null => {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      return createHmac("sha256", refreshKey()).update(`${parts[0]}.${parts[1]}`).digest();
    })();
    if (!expected) return null;
    const parts = token.split(".");
    const [, payload, sig] = parts;
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        wrt?: string;
        cid?: string;
        exp?: number;
      };
      if (!claims.wrt || !claims.cid) return null;
      if (claims.exp && Math.floor(Date.now() / 1000) >= claims.exp) return null;
      return { workosRefreshToken: claims.wrt, clientId: claims.cid };
    } catch {
      return null;
    }
  }

  /** RFC 7591 dynamic client registration. Public clients only
   *  (token_endpoint_auth_method: none) — PKCE is what protects the exchange. */
  async function register(request: Request): Promise<Response> {
    prune();
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("invalid_client_metadata", "Invalid JSON body");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) {
      return jsonError("invalid_client_metadata", "redirect_uris is required and must be a non-empty array");
    }
    if (!uris.every((u) => typeof u === "string")) {
      return jsonError("invalid_client_metadata", "Each redirect_uri must be a string");
    }
    const client: RegisteredClient = {
      client_id: randomUUID(),
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: uris as string[],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      created_at: Date.now(),
    };
    clients.set(client.client_id, client);
    return Response.json(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
      },
      { status: 201 },
    );
  }

  /** Parks the client's request under a session id, then hands the user to
   *  AuthKit. The session id travels as WorkOS's `state`, so the callback can
   *  match the returning user back to the waiting client. */
  async function authorize(request: Request): Promise<Response> {
    prune();
    const q = new URL(request.url).searchParams;
    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    if (!clientId || !redirectUri || q.get("response_type") !== "code") {
      return jsonError(
        "invalid_request",
        "Missing or invalid required parameters (client_id, redirect_uri, response_type=code)",
      );
    }
    const client = clients.get(clientId);
    if (!client) return jsonError("invalid_client", "Unknown client_id");
    if (!client.redirect_uris.includes(redirectUri)) {
      return jsonError("invalid_request", "redirect_uri does not match registered URIs");
    }
    const wosClientId = workosClientId();
    if (!wosClientId) return jsonError("server_error", "WORKOS_CLIENT_ID is not configured", 500);

    const sessionId = randomUUID();
    sessions.set(sessionId, {
      client_id: clientId,
      redirect_uri: redirectUri,
      state: q.get("state") ?? undefined,
      code_challenge: q.get("code_challenge") ?? undefined,
      code_challenge_method: q.get("code_challenge_method") ?? undefined,
      created_at: Date.now(),
    });

    const url = new URL("https://api.workos.com/user_management/authorize");
    url.searchParams.set("client_id", wosClientId);
    url.searchParams.set("redirect_uri", `${baseUrlOf(request)}${paths.callback}`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("provider", "authkit");
    url.searchParams.set("state", sessionId);
    return Response.redirect(url.toString(), 302);
  }

  /** AuthKit's redirect target. Exchanges WorkOS's code for tokens, mints OUR
   *  single-use code, and bounces back to the client's redirect_uri. */
  async function callback(request: Request): Promise<Response> {
    prune();
    const q = new URL(request.url).searchParams;
    const workosCode = q.get("code");
    const sessionId = q.get("state");
    if (!workosCode || !sessionId) return jsonError("invalid_request", "Missing code or state parameter");

    const session = sessions.get(sessionId);
    if (!session) return jsonError("invalid_request", "Invalid or expired session");
    sessions.delete(sessionId);

    const wosClientId = workosClientId();
    if (!wosClientId) return jsonError("server_error", "WORKOS_CLIENT_ID is not configured", 500);

    let accessToken: string;
    let refreshToken: string;
    try {
      const auth = await getWorkOS().userManagement.authenticateWithCode({
        clientId: wosClientId,
        code: workosCode,
      });
      accessToken = auth.accessToken;
      refreshToken = auth.refreshToken;
    } catch (e) {
      console.error("[oauth-proxy] WorkOS code exchange failed:", e);
      return jsonError("server_error", "Failed to exchange authorization code with WorkOS", 500);
    }

    const code = randomUUID();
    codes.set(code, {
      client_id: session.client_id,
      redirect_uri: session.redirect_uri,
      access_token: accessToken,
      refresh_token: refreshToken,
      code_challenge: session.code_challenge,
      code_challenge_method: session.code_challenge_method,
      used: false,
      created_at: Date.now(),
    });

    const back = new URL(session.redirect_uri);
    back.searchParams.set("code", code);
    if (session.state) back.searchParams.set("state", session.state);
    return Response.redirect(back.toString(), 302);
  }

  async function handleAuthorizationCode(params: Record<string, string>): Promise<Response> {
    const { code, client_id, redirect_uri, code_verifier } = params;
    if (!code || !client_id) {
      return jsonError("invalid_request", "Missing required parameters (code, client_id)");
    }
    const entry = codes.get(code);
    if (!entry) return jsonError("invalid_grant", "Invalid or expired authorization code");
    if (entry.used) {
      // Replay: burn it. RFC 6749 §4.1.2 — a reused code must invalidate.
      codes.delete(code);
      return jsonError("invalid_grant", "Authorization code has already been used");
    }
    if (entry.client_id !== client_id) return jsonError("invalid_grant", "client_id does not match");
    if (redirect_uri && entry.redirect_uri !== redirect_uri) {
      return jsonError("invalid_grant", "redirect_uri does not match");
    }
    if (entry.code_challenge && entry.code_challenge_method) {
      if (!code_verifier) return jsonError("invalid_request", "code_verifier is required for PKCE");
      if (!verifyCodeChallenge(code_verifier, entry.code_challenge, entry.code_challenge_method)) {
        return jsonError("invalid_grant", "PKCE code_verifier verification failed");
      }
    }
    entry.used = true;

    let refresh: string;
    try {
      refresh = signRefresh(entry.refresh_token, entry.client_id);
    } catch (e) {
      console.error("[oauth-proxy]", e);
      return jsonError("server_error", "Refresh-token signing is not configured", 500);
    }
    return Response.json({
      access_token: entry.access_token,
      token_type: "bearer",
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
    });
  }

  async function handleRefreshToken(params: Record<string, string>): Promise<Response> {
    const { refresh_token, client_id } = params;
    if (!refresh_token || !client_id) {
      return jsonError("invalid_request", "Missing required parameters (refresh_token, client_id)");
    }
    let decoded: { workosRefreshToken: string; clientId: string } | null;
    try {
      decoded = verifyRefresh(refresh_token);
    } catch (e) {
      console.error("[oauth-proxy]", e);
      return jsonError("server_error", "Refresh-token verification is not configured", 500);
    }
    if (!decoded) return jsonError("invalid_grant", "Invalid or expired refresh token");
    if (decoded.clientId !== client_id) return jsonError("invalid_grant", "client_id does not match");

    const wosClientId = workosClientId();
    if (!wosClientId) return jsonError("server_error", "WORKOS_CLIENT_ID is not configured", 500);
    try {
      const auth = await getWorkOS().userManagement.authenticateWithRefreshToken({
        clientId: wosClientId,
        refreshToken: decoded.workosRefreshToken,
      });
      return Response.json({
        access_token: auth.accessToken,
        token_type: "bearer",
        expires_in: ACCESS_TTL,
        refresh_token: signRefresh(auth.refreshToken, client_id),
      });
    } catch (e) {
      console.error("[oauth-proxy] refresh exchange failed:", e);
      return jsonError("invalid_grant", "Refresh token is no longer valid. Please re-authenticate.");
    }
  }

  async function readBody(request: Request): Promise<Record<string, string> | null> {
    const ct = request.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await request.formData();
        const out: Record<string, string> = {};
        form.forEach((v, k) => {
          out[k] = String(v);
        });
        return out;
      }
      return (await request.json()) as Record<string, string>;
    } catch {
      return null;
    }
  }

  /** POST /oauth/token — authorization_code + refresh_token, plus whatever
   *  `claimGrant` chains in (auth.md's claim grant, in practice). */
  async function token(request: Request): Promise<Response> {
    prune();
    const params = await readBody(request);
    if (!params) return jsonError("invalid_request", "Invalid request body");
    if (params.grant_type === "authorization_code") return handleAuthorizationCode(params);
    if (params.grant_type === "refresh_token") return handleRefreshToken(params);
    const chained = typeof opts.claimGrant === "function" ? opts.claimGrant() : opts.claimGrant;
    if (chained && params.grant_type === chained.type) return chained.handle(params);
    const supported = ["authorization_code", "refresh_token", chained?.type]
      .filter(Boolean)
      .join(", ");
    return jsonError("unsupported_grant_type", `Supported grant types: ${supported}`);
  }

  return {
    register,
    authorize,
    callback,
    token,
    /** Grant types to advertise in AS metadata. */
    grantTypes: ["authorization_code", "refresh_token"] as const,
    /** AS-metadata fields this proxy adds — merge into the discovery document so
     *  the endpoints are only advertised where they actually exist. */
    asMetadata: (request: Request) => ({
      authorization_endpoint: `${baseUrlOf(request)}${paths.authorize}`,
      registration_endpoint: `${baseUrlOf(request)}${paths.register}`,
    }),
    paths,
  };
}

export type OAuthProxy = ReturnType<typeof createOAuthProxy>;
