// Sign in with ChatGPT: the OAuth flow for the user's ChatGPT plan (public client, PKCE,
// loopback callback) and the Responses API call grading uses. Tokens live in one 0600 file.
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
// The OIDC discovery document names the jwks_uri; this is its published value.
export const CHATGPT_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CHATGPT_MODELS_URL = "https://api.openai.com/v1/models";
export const CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", CHATGPT_PLAN_SCOPE];
export const CHATGPT_AGENT_NAME = "Etude";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/** First entry in the documented example catalog; the model list endpoint has the real choices. */
export const DEFAULT_CHATGPT_MODEL = "gpt-6.1-sol";

export interface ChatGptEndpoints {
  authorize: string;
  token: string;
  issuer: string;
  discovery: string;
  jwks: string;
  models: string;
  responses: string;
  resource: string;
}

export function chatGptEndpoints(overrides: Partial<ChatGptEndpoints> = {}): ChatGptEndpoints {
  return {
    authorize: CHATGPT_AUTHORIZE_URL,
    token: CHATGPT_TOKEN_URL,
    issuer: CHATGPT_ISSUER,
    discovery: CHATGPT_DISCOVERY_URL,
    jwks: CHATGPT_JWKS_URL,
    models: CHATGPT_MODELS_URL,
    responses: CHATGPT_RESPONSES_URL,
    resource: CHATGPT_RESOURCE,
    ...overrides,
  };
}

export class ChatGptError extends Error {
  code: string;
  constructor(message: string, code = "chatgpt") {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ storage

/** Where a host keeps its credentials: `$ETUDE_HOME` (default `~/.etude`). */
export function chatGptHome(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.ETUDE_HOME ?? join(homedir(), ".etude"));
}

export interface ChatGptPaths {
  credentials: string;
  hostId: string;
}

export function chatGptPaths(home: string): ChatGptPaths {
  return { credentials: join(home, "chatgpt.json"), hostId: join(home, "chatgpt-host-id") };
}

/** The credential record saved after sign-in, shaped like the documented example. */
export interface ChatGptCredentials {
  email: string | null;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string;
  expires_in: number;
  scopes: string[];
  saved_at: string;
  earliest_refresh_at?: string | null;
  /** Plan tier when the ID token carries one; otherwise null. */
  plan_type?: string | null;
  /** Set when the refresh token was rejected: the account is known, the tokens are gone. */
  needs_reauth?: boolean;
}

/** Owner-only file write: temp file, fsync, rename. */
function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readChatGptCredentials(home: string): ChatGptCredentials | null {
  const path = chatGptPaths(home).credentials;
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as ChatGptCredentials;
    if (!c || typeof c.client_id !== "string") return null;
    return c;
  } catch {
    return null;
  }
}

export function saveChatGptCredentials(home: string, c: ChatGptCredentials) {
  writePrivate(chatGptPaths(home).credentials, JSON.stringify(c, null, 2) + "\n");
}

/** A stable opaque host id, generated once per host and reused across sign-ins. */
export function chatGptHostId(home: string): string {
  const existing = readChatGptHostId(home);
  if (existing) return existing;
  const id = `urn:uuid:${randomUUID()}`;
  writePrivate(chatGptPaths(home).hostId, id + "\n");
  return id;
}

/** The saved host id, or null before the first sign-in. Creates nothing. */
export function readChatGptHostId(home: string): string | null {
  const path = chatGptPaths(home).hostId;
  if (!existsSync(path)) return null;
  const v = readFileSync(path, "utf8").trim();
  return /^(urn:uuid:[0-9a-fA-F-]{36}|urn:ietf:params:oauth:jwk-thumbprint:.+|did:key:.+)$/.test(v) ? v : null;
}

const hasScope = (c: ChatGptCredentials, scope: string) => c.scopes.includes(scope);

export interface ChatGptStatus {
  signedIn: boolean;
  email: string | null;
  subject: string | null;
  clientId: string | null;
  /** "enabled" when the grant includes chatgpt.tokens.use.direct, "disabled" when signed in without it. */
  plan: "enabled" | "disabled" | "none";
  planType: string | null;
  expiresAt: string | null;
  needsReauth: boolean;
  usageUrl: string;
  credentialsPath: string;
}

export function chatGptStatus(home: string): ChatGptStatus {
  const c = readChatGptCredentials(home);
  const base = { usageUrl: CHATGPT_USAGE_URL, credentialsPath: chatGptPaths(home).credentials };
  if (!c) return { ...base, signedIn: false, email: null, subject: null, clientId: null, plan: "none", planType: null, expiresAt: null, needsReauth: false };
  const signedIn = !!c.access_token && !!c.refresh_token;
  return {
    ...base,
    signedIn,
    email: c.email,
    subject: c.subject,
    clientId: c.client_id,
    plan: hasScope(c, CHATGPT_PLAN_SCOPE) ? "enabled" : "disabled",
    planType: c.plan_type ?? null,
    expiresAt: c.saved_at ? new Date(Date.parse(c.saved_at) + (c.expires_in || 3600) * 1000).toISOString() : null,
    needsReauth: !!c.needs_reauth,
  };
}

// -------------------------------------------------------------------- PKCE

const b64url = (b: Buffer) => b.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  hostId: string;
  /** The issued client id, or `dynamic_agent_client` for a first registration. */
  clientId: string;
  agentNameHint?: string;
  idTokenHint?: string;
  emailHint?: string;
  endpoints?: Partial<ChatGptEndpoints>;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const ep = chatGptEndpoints(p.endpoints);
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    scope: CHATGPT_SCOPES.join(" "),
    resource: ep.resource,
    state: p.state,
    nonce: p.nonce,
    code_challenge_method: "S256",
    code_challenge: p.challenge,
    ext_agent_host_id: p.hostId,
  });
  if (p.agentNameHint) q.set("agent_name_hint", p.agentNameHint);
  if (p.idTokenHint) q.set("id_token_hint", p.idTokenHint);
  if (p.emailHint) q.set("login_hint", p.emailHint);
  return `${ep.authorize}?${q.toString()}`;
}

// ------------------------------------------------------- ID token validation

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  at: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();
const JWKS_TTL_MS = 10 * 60 * 1000;

async function fetchJwks(url: string, force = false): Promise<Jwk[]> {
  const hit = jwksCache.get(url);
  if (hit && !force && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e) => {
    throw new ChatGptError(`couldn't fetch OpenAI's signing keys: ${(e as Error).message}`, "network");
  });
  if (!res.ok) throw new ChatGptError(`couldn't fetch OpenAI's signing keys: HTTP ${res.status}`, "network");
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(url, { keys, at: Date.now() });
  return keys;
}

/** Test hook: forget cached signing keys. */
export function clearChatGptCaches() {
  jwksCache.clear();
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  [k: string]: unknown;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface VerifyIdTokenOptions {
  audience: string;
  nonce: string;
  issuer?: string;
  jwksUrl?: string;
  /** Allowed clock skew in seconds. */
  leewaySec?: number;
}

/** Verifies the RS256 signature against the published JWKS, then iss, aud, exp and nonce. */
export async function verifyIdToken(token: string, opts: VerifyIdTokenOptions): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ChatGptError("the ID token is malformed", "invalid_id_token");
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new ChatGptError("the ID token header is malformed", "invalid_id_token");
  }
  if (header.alg !== "RS256") throw new ChatGptError(`unsupported ID token algorithm ${header.alg ?? "(none)"}`, "invalid_id_token");
  if (!header.kid) throw new ChatGptError("the ID token has no key id", "invalid_id_token");

  const url = opts.jwksUrl ?? CHATGPT_JWKS_URL;
  let jwk = (await fetchJwks(url)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await fetchJwks(url, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new ChatGptError("the ID token was signed with an unknown key", "invalid_id_token");

  let key;
  try {
    key = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: "jwk" });
  } catch {
    throw new ChatGptError("OpenAI's signing key is malformed", "invalid_id_token");
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  if (!verifySignature("RSA-SHA256", signed, key, sig)) throw new ChatGptError("the ID token signature is invalid", "invalid_id_token");

  const claims = decodeJwtPayload(token) as IdTokenClaims | null;
  if (!claims) throw new ChatGptError("the ID token payload is malformed", "invalid_id_token");
  const issuer = opts.issuer ?? CHATGPT_ISSUER;
  if (claims.iss !== issuer) throw new ChatGptError(`the ID token was issued by ${claims.iss}, not ${issuer}`, "invalid_id_token");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new ChatGptError("the ID token was issued for another client", "invalid_id_token");
  const leeway = opts.leewaySec ?? 60;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - leeway * 1000)
    throw new ChatGptError("the ID token has expired", "invalid_id_token");
  if (typeof claims.nonce !== "string" || claims.nonce !== opts.nonce) throw new ChatGptError("the ID token nonce doesn't match this sign-in", "invalid_id_token");
  if (typeof claims.sub !== "string" || !claims.sub) throw new ChatGptError("the ID token has no subject", "invalid_id_token");
  return claims;
}

// ------------------------------------------------------------------ tokens

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: string;
}

async function tokenError(res: Response): Promise<ChatGptError> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: unknown; error_description?: string; message?: string };
    if (typeof j.error === "string") code = j.error;
    else if (j.error && typeof j.error === "object") {
      const o = j.error as { code?: string; message?: string };
      code = o.code;
      detail = o.message;
    }
    detail = j.error_description ?? detail ?? j.message;
  } catch {
    detail = text.slice(0, 200) || undefined;
  }
  const suffix = detail ? `: ${detail}` : "";
  if (res.status === 400 && code === "invalid_grant") return new ChatGptError(`OpenAI rejected the sign-in code (invalid_grant)${suffix}. Try again.`, "invalid_grant");
  if (code === "invalid_client") return new ChatGptError(`OpenAI rejected this client registration (invalid_client)${suffix}`, "invalid_client");
  return new ChatGptError(`OpenAI token endpoint returned HTTP ${res.status}${code ? ` (${code})` : ""}${suffix}`, code ?? "token_error");
}

async function postToken(ep: ChatGptEndpoints, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(ep.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw new ChatGptError(`couldn't reach OpenAI's token endpoint: ${(e as Error).message}`, "network");
  });
  if (!res.ok) throw await tokenError(res);
  return (await res.json()) as TokenResponse;
}

function credentialsFrom(tokens: TokenResponse, opts: { clientId: string; hostId: string; claims: IdTokenClaims; endpointIssuer: string }): ChatGptCredentials {
  const auth = opts.claims["https://api.openai.com/auth"] as { chatgpt_plan_type?: string } | undefined;
  const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null;
  return {
    email: typeof opts.claims.email === "string" ? opts.claims.email : null,
    issuer: opts.claims.iss ?? opts.endpointIssuer,
    subject: opts.claims.sub,
    client_id: opts.clientId,
    ext_agent_host_id: opts.hostId,
    id_token: tokens.id_token ?? null,
    access_token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? null,
    token_type: tokens.token_type ?? "Bearer",
    expires_in: Number(tokens.expires_in ?? 3600),
    scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
    saved_at: new Date().toISOString(),
    earliest_refresh_at: tokens.earliest_refresh_at ?? null,
    plan_type: planType,
    needs_reauth: false,
  };
}

function needsRefresh(c: ChatGptCredentials, skewMs = 60_000): boolean {
  if (!c.access_token) return true;
  const exp = Date.parse(c.saved_at) + (c.expires_in || 3600) * 1000;
  const earliest = c.earliest_refresh_at ? Date.parse(c.earliest_refresh_at) : NaN;
  let at = exp - skewMs;
  // Honor an earlier-than-expiry refresh window, but never postpone renewal past the token's life.
  if (Number.isFinite(earliest) && earliest < exp) at = Math.max(at, earliest);
  return Date.now() >= at;
}

const refreshes = new Map<string, Promise<ChatGptCredentials>>();
const REAUTH_CODES = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/** Refreshes and rotates the stored tokens; concurrent callers share one request. */
export function refreshChatGpt(home: string, endpoints: Partial<ChatGptEndpoints> = {}): Promise<ChatGptCredentials> {
  const path = chatGptPaths(home).credentials;
  const running = refreshes.get(path);
  if (running) return running;
  const p = doRefresh(home, chatGptEndpoints(endpoints)).finally(() => refreshes.delete(path));
  refreshes.set(path, p);
  return p;
}

async function doRefresh(home: string, ep: ChatGptEndpoints): Promise<ChatGptCredentials> {
  const cur = readChatGptCredentials(home);
  if (!cur || !cur.refresh_token) throw reauthError();
  let tokens: TokenResponse;
  try {
    tokens = await postToken(ep, { grant_type: "refresh_token", client_id: cur.client_id, refresh_token: cur.refresh_token, resource: ep.resource });
  } catch (e) {
    const code = e instanceof ChatGptError ? e.code : "";
    if (REAUTH_CODES.has(code)) {
      saveChatGptCredentials(home, { ...cur, access_token: null, refresh_token: null, id_token: null, needs_reauth: true });
      throw reauthError();
    }
    throw e;
  }
  const next: ChatGptCredentials = {
    ...cur,
    access_token: tokens.access_token ?? null,
    // The refresh token rotates: always keep the replacement.
    refresh_token: tokens.refresh_token ?? cur.refresh_token,
    id_token: tokens.id_token ?? cur.id_token,
    token_type: tokens.token_type ?? cur.token_type,
    expires_in: Number(tokens.expires_in ?? cur.expires_in),
    scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : cur.scopes,
    saved_at: new Date().toISOString(),
    earliest_refresh_at: tokens.earliest_refresh_at ?? null,
    needs_reauth: false,
  };
  saveChatGptCredentials(home, next);
  return next;
}

function reauthError() {
  return new ChatGptError("your ChatGPT sign-in has expired; sign in again with `etude settings chatgpt login`", "reauth_required");
}

/** The stored credentials, refreshed first when they are near expiry. */
export async function getChatGptCredentials(home: string, endpoints: Partial<ChatGptEndpoints> = {}): Promise<ChatGptCredentials> {
  const c = readChatGptCredentials(home);
  if (!c) throw new ChatGptError("not signed in to ChatGPT; run `etude settings chatgpt login`", "not_signed_in");
  if (c.needs_reauth || !c.refresh_token) throw reauthError();
  if (needsRefresh(c)) return refreshChatGpt(home, endpoints);
  return c;
}

/**
 * Takes a credential file saved on another machine (the documented self-hosted-VM path)
 * and adopts it for this host, which gets its own host id.
 */
export function importChatGptCredentials(home: string, file: string): { signedIn: boolean; email: string | null; hostId: string; credentialsPath: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ChatGptError(`couldn't read ${file}: ${(e as Error).message}`, "invalid_import");
  }
  const str = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : null);
  const clientId = str("client_id");
  const subject = str("subject");
  if (!clientId || !subject || !str("access_token") || !str("refresh_token"))
    throw new ChatGptError("that file isn't a ChatGPT credential record (client_id, subject, access_token and refresh_token are required)", "invalid_import");
  const hostId = chatGptHostId(home);
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.map(String) : String(raw.scope ?? "").split(/\s+/).filter(Boolean);
  const savedAt = str("saved_at");
  saveChatGptCredentials(home, {
    email: str("email"),
    issuer: str("issuer") ?? CHATGPT_ISSUER,
    subject,
    client_id: clientId,
    ext_agent_host_id: hostId,
    id_token: str("id_token"),
    access_token: str("access_token"),
    refresh_token: str("refresh_token"),
    token_type: str("token_type") ?? "Bearer",
    expires_in: Number(raw.expires_in ?? 3600) || 3600,
    scopes,
    saved_at: savedAt && !Number.isNaN(Date.parse(savedAt)) ? savedAt : new Date().toISOString(),
    earliest_refresh_at: str("earliest_refresh_at"),
    plan_type: str("plan_type"),
    needs_reauth: false,
  });
  return { signedIn: true, email: str("email"), hostId, credentialsPath: chatGptPaths(home).credentials };
}

// ------------------------------------------------------------------- login

export interface ChatGptLoginOptions {
  home: string;
  endpoints?: Partial<ChatGptEndpoints>;
  /** 0 picks a free port; the callback path is always /auth/callback on 127.0.0.1. */
  port?: number;
  timeoutMs?: number;
  /** A previous registration for the same account, to reuse its client id and hints. */
  existing?: ChatGptCredentials | null;
}

export interface ChatGptLoginSession {
  url: string;
  redirectUri: string;
  /** Resolves with the saved credentials after a validated callback. */
  wait: Promise<ChatGptCredentials>;
  cancel(): void;
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in to Etude</title>
<body style="font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1.5rem">
<h1 style="font-size:1.25rem">You're signed in to Etude</h1>
<p>You can close this window and return to the app.</p></body>`;

const errorPage = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1.5rem">
<h1 style="font-size:1.25rem">Sign-in failed</h1><p>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</p>
<p>You can close this window.</p></body>`;

/**
 * Starts the loopback listener and builds the authorize URL. The browser must run on this
 * machine: a 127.0.0.1 callback never reaches a server on another host.
 */
export async function beginChatGptLogin(opts: ChatGptLoginOptions): Promise<ChatGptLoginSession> {
  const ep = chatGptEndpoints(opts.endpoints);
  const paths = chatGptPaths(opts.home);
  const hostId = chatGptHostId(opts.home);
  const existing = opts.existing === undefined ? readChatGptCredentials(opts.home) : opts.existing;
  const returning = existing && existing.client_id ? existing : null;
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const { verifier, challenge } = pkcePair();

  let redirectUri = "";
  let settle: (c: ChatGptCredentials) => void = () => {};
  let fail: (e: Error) => void = () => {};
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<ChatGptCredentials>((res, rej) => {
    settle = (c) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      res(c);
    };
    fail = (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rej(e);
    };
  });
  // Nothing else may observe this rejection before the caller awaits it.
  wait.catch(() => {});

  const server = createServer(async (req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") return reply(404, "not found");
    if (settled) return reply(409, errorPage("This sign-in already finished."));
    const q = url.searchParams;
    const stateOk = q.get("state") === state;
    if (!stateOk) {
      reply(400, errorPage("This callback doesn't belong to the sign-in Etude started."));
      return fail(new ChatGptError("the callback state didn't match this sign-in", "state_mismatch"));
    }
    const oauthError = q.get("error");
    if (oauthError) {
      const desc = q.get("error_description");
      reply(400, errorPage(desc ?? oauthError));
      return fail(
        new ChatGptError(
          oauthError === "access_denied" ? "ChatGPT sign-in was declined. You can try again and allow access to your ChatGPT plan." : `ChatGPT sign-in failed: ${desc ?? oauthError}`,
          oauthError,
        ),
      );
    }
    const code = q.get("code");
    if (!code) {
      reply(400, errorPage("The callback carried no authorization code."));
      return fail(new ChatGptError("the callback carried no authorization code", "invalid_callback"));
    }
    const issued = q.get("client_id");
    if (returning) {
      if (issued && issued !== returning.client_id) {
        reply(400, errorPage("This sign-in returned a different app registration."));
        return fail(new ChatGptError("the callback returned a client id that doesn't match this account's registration", "client_mismatch"));
      }
    } else if (!issued) {
      reply(400, errorPage("OpenAI didn't finish registering Etude. Try again."));
      return fail(new ChatGptError("registration was incomplete: the callback carried no issued client id", "registration_incomplete"));
    }
    const clientId = issued ?? returning!.client_id;

    try {
      const tokens = await postToken(ep, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: ep.resource });
      if (!tokens.id_token) throw new ChatGptError("OpenAI returned no ID token", "invalid_id_token");
      if (!tokens.access_token || !tokens.refresh_token) throw new ChatGptError("OpenAI returned no access or refresh token", "invalid_grant");
      const claims = await verifyIdToken(tokens.id_token, { audience: clientId, nonce, issuer: ep.issuer, jwksUrl: ep.jwks });
      if (returning && returning.subject && claims.sub !== returning.subject)
        throw new ChatGptError("this sign-in belongs to a different ChatGPT account than the one saved", "account_mismatch");
      const creds = credentialsFrom(tokens, { clientId, hostId, claims, endpointIssuer: ep.issuer });
      saveChatGptCredentials(opts.home, creds);
      reply(200, SUCCESS_PAGE);
      settle(creds);
    } catch (e) {
      const message = (e as Error).message;
      reply(400, errorPage(message));
      fail(e instanceof Error ? e : new ChatGptError(String(e)));
    }
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", rej);
      res();
    });
  }).catch((e) => {
    throw new ChatGptError(`couldn't listen for the sign-in callback on 127.0.0.1: ${(e as Error).message}`, "listen_failed");
  });
  const port = (server.address() as AddressInfo).port;
  redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = buildAuthorizeUrl({
    endpoints: ep,
    redirectUri,
    state,
    nonce,
    challenge,
    hostId,
    clientId: returning ? returning.client_id : "dynamic_agent_client",
    agentNameHint: returning ? undefined : CHATGPT_AGENT_NAME,
    // The ID token hint would travel in a URL we print and open, so the email hint is used instead.
    emailHint: returning?.email ?? undefined,
  });

  const close = () => {
    if (!server.listening) return;
    server.closeAllConnections?.();
    server.close();
  };
  timer = setTimeout(() => {
    close();
    fail(new ChatGptError("timed out waiting for the ChatGPT sign-in to finish", "timeout"));
  }, opts.timeoutMs ?? 10 * 60 * 1000);
  timer.unref?.();
  wait.finally(close).catch(() => {});

  return {
    url,
    redirectUri,
    wait,
    cancel: () => {
      close();
      fail(new ChatGptError("ChatGPT sign-in was cancelled", "cancelled"));
    },
  };
}

/** Opens a URL in the system browser if the platform has a handler. */
export function openInBrowser(url: string): boolean {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ models

export interface ChatGptModel {
  slug: string;
  displayName: string;
}

export async function listChatGptModels(home: string, endpoints: Partial<ChatGptEndpoints> = {}): Promise<ChatGptModel[]> {
  const ep = chatGptEndpoints(endpoints);
  const creds = await getChatGptCredentials(home, ep);
  const res = await fetch(ep.models, {
    headers: { Authorization: `Bearer ${creds.access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new ChatGptError(`couldn't reach the model list: ${(e as Error).message}`, "network");
  });
  if (!res.ok) throw new ChatGptError(failureMessage({ status: res.status, detail: (await res.text()).slice(0, 200) }), "models_failed");
  const body = (await res.json()) as { models?: { slug?: string; id?: string; display_name?: string; visibility?: string }[] };
  const rows = Array.isArray(body.models) ? body.models : [];
  return rows
    .filter((m) => (m.visibility ?? "list") === "list" && (m.slug ?? m.id))
    .map((m) => ({ slug: (m.slug ?? m.id)!, displayName: m.display_name ?? (m.slug ?? m.id)! }));
}

// --------------------------------------------------------------- inference

export interface ResponsesRequest {
  home: string;
  model: string;
  /** Sent as `instructions`: system messages are rejected on this route. */
  instructions: string;
  input: string;
  image?: string | null;
  timeoutMs?: number;
  endpoints?: Partial<ChatGptEndpoints>;
}

export interface ResponsesResult {
  text: string;
  model: string;
  ms: number;
}

/** Plain messages for the documented ChatGPT-plan error codes. */
export function failureMessage(e: { code?: string; status?: number; detail?: string; param?: string }): string {
  const detail = e.detail?.trim();
  switch (e.code) {
    case "subscription_sharing_user_not_eligible":
      return "ChatGPT plan usage isn't available for this account (Plus or Pro is required, and the workspace or region may be restricted). Use another provider or a key in Settings → AI grading.";
    case "subscription_sharing_usage_limit_exceeded":
      return `Your ChatGPT plan usage limit is reached. Check usage at ${CHATGPT_USAGE_URL}, or use another provider.`;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "ChatGPT plan usage can't be checked right now. Try again in a moment.";
    case "subscription_sharing_unsupported_capability":
      return `ChatGPT plan usage doesn't support this request${e.param ? ` (${e.param})` : ""}. Try a different model or send text only.`;
    case "subscription_sharing_route_not_supported":
      return "ChatGPT plan usage doesn't allow this endpoint. Etude grades through the Responses API only.";
    case "subscription_sharing_invalid_user":
      return "ChatGPT couldn't validate this sign-in. Sign in again with `etude settings chatgpt login`.";
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "This sign-in isn't allowed to use the ChatGPT plan. Sign out and sign in again, allowing plan access.";
    default:
      break;
  }
  if (e.status === 401) return "ChatGPT rejected this sign-in. Sign in again with `etude settings chatgpt login`.";
  if (e.status === 403) return `ChatGPT plan usage is blocked for this account${detail ? `: ${detail}` : "."}`;
  if (e.status === 429) return `ChatGPT is rate limiting requests${detail ? `: ${detail}` : "."} Try again shortly.`;
  if (e.status === 503) return "ChatGPT plan usage is unavailable right now. Try again in a moment.";
  if (e.code) return `ChatGPT plan request failed (${e.code})${detail ? `: ${detail}` : ""}`;
  if (e.status) return `ChatGPT plan request failed: HTTP ${e.status}${detail ? `: ${detail}` : ""}`;
  return detail || "ChatGPT plan request failed";
}

async function readErrorBody(res: Response): Promise<ChatGptError> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  let detail: string | undefined;
  let param: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string; param?: string }; detail?: string; message?: string };
    if (j.error) {
      code = j.error.code;
      detail = j.error.message;
      param = j.error.param;
    } else detail = j.detail ?? j.message;
  } catch {
    detail = text.slice(0, 300) || undefined;
  }
  return new ChatGptError(failureMessage({ code, status: res.status, detail, param }), code ?? `http_${res.status}`);
}

/** One streamed Responses call on the user's ChatGPT plan; resolves with the final text. */
export async function chatGptResponses(req: ResponsesRequest): Promise<ResponsesResult> {
  const t0 = Date.now();
  const ep = chatGptEndpoints(req.endpoints);
  const creds = await getChatGptCredentials(req.home, ep);
  if (!hasScope(creds, CHATGPT_PLAN_SCOPE))
    throw new ChatGptError("this sign-in doesn't include ChatGPT plan usage; sign out and sign in again, allowing plan access", "plan_disabled");
  const content: Record<string, unknown>[] = [{ type: "input_text", text: req.input }];
  if (req.image) content.push({ type: "input_image", image_url: req.image });
  const res = await fetch(ep.responses, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ model: req.model || DEFAULT_CHATGPT_MODEL, instructions: req.instructions, input: [{ role: "user", content }], store: false, stream: true }),
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  }).catch((e) => {
    const timeout = (e as Error).name === "TimeoutError";
    throw new ChatGptError(timeout ? `ChatGPT plan request timed out after ${req.timeoutMs ?? 60_000} ms` : `couldn't reach ChatGPT: ${(e as Error).message}`, timeout ? "timeout" : "network");
  });
  if (!res.ok) throw await readErrorBody(res);
  if (!res.body) throw new ChatGptError("ChatGPT returned an empty response", "empty_stream");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = req.model;
  let completed = false;
  let failure: ChatGptError | null = null;
  const handle = (event: any) => {
    switch (event?.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") text += event.delta;
        break;
      case "response.completed":
        completed = true;
        if (event.response?.model) model = event.response.model;
        if (!text) text = textFromResponse(event.response);
        break;
      case "response.incomplete":
        throw new ChatGptError(`ChatGPT stopped before finishing${event.response?.incomplete_details?.reason ? ` (${event.response.incomplete_details.reason})` : ""}`, "incomplete");
      case "response.failed": {
        const err = event.response?.error ?? {};
        throw new ChatGptError(failureMessage({ code: err.code, detail: err.message, param: err.param }), err.code ?? "response_failed");
      }
      case "error":
        throw new ChatGptError(failureMessage({ code: event.code, detail: event.message, param: event.param }), event.code ?? "error");
      default:
        break;
    }
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + (buffer[cut] === "\r" ? 4 : 2));
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          handle(JSON.parse(payload));
        } catch (e) {
          if (e instanceof ChatGptError) failure = e;
          else failure = new ChatGptError(`couldn't read ChatGPT's stream: ${(e as Error).message}`, "bad_stream");
        }
      }
      if (failure) break;
    }
    if (failure || completed) break;
  }
  if (failure) throw failure;
  if (!completed) throw new ChatGptError("ChatGPT's stream ended without finishing the response", "incomplete_stream");
  if (!text.trim()) throw new ChatGptError("ChatGPT returned no text", "empty_response");
  return { text: text.trim(), model, ms: Date.now() - t0 };
}

function textFromResponse(response: any): string {
  const out = Array.isArray(response?.output) ? response.output : [];
  return out
    .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
    .map((part: any) => (part?.type === "output_text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

// ------------------------------------------------------------------ logout

export interface ChatGptLogoutResult {
  signedIn: false;
  revoked: boolean;
  warning?: string;
}

/** Revokes the renewable session, then clears the local tokens. The client id is kept for a later sign-in. */
export async function chatGptLogout(home: string, endpoints: Partial<ChatGptEndpoints> = {}): Promise<ChatGptLogoutResult> {
  const ep = chatGptEndpoints(endpoints);
  const cur = readChatGptCredentials(home);
  if (!cur) return { signedIn: false, revoked: true };
  let revoked = false;
  let warning: string | undefined;
  if (cur.refresh_token) {
    let revokeUrl: string | null = null;
    try {
      const res = await fetch(ep.discovery, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) revokeUrl = ((await res.json()) as { revocation_endpoint?: string }).revocation_endpoint ?? null;
    } catch {
      revokeUrl = null;
    }
    if (revokeUrl) {
      try {
        const res = await fetch(revokeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: cur.refresh_token, token_type_hint: "refresh_token", client_id: cur.client_id }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
        revoked = res.ok;
        if (!res.ok) warning = `OpenAI returned HTTP ${res.status} when revoking the session`;
      } catch (e) {
        warning = `couldn't reach OpenAI to revoke the session: ${(e as Error).message}`;
      }
    } else warning = "OpenAI's revocation endpoint wasn't reachable";
  } else revoked = true;
  saveChatGptCredentials(home, { ...cur, access_token: null, refresh_token: null, id_token: null, needs_reauth: true });
  return warning ? { signedIn: false, revoked, warning: `${warning}. Signed out locally; you can also disconnect Etude in ChatGPT settings.` } : { signedIn: false, revoked };
}
