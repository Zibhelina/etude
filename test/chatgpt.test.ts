import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginChatGptLogin,
  buildAuthorizeUrl,
  chatGptEndpoints,
  chatGptLogout,
  chatGptPaths,
  chatGptResponses,
  chatGptStatus,
  clearChatGptCaches,
  getChatGptCredentials,
  importChatGptCredentials,
  listChatGptModels,
  readChatGptCredentials,
  saveChatGptCredentials,
  verifyIdToken,
  ChatGptError,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_SCOPES,
  type ChatGptEndpoints,
  type ChatGptLoginSession,
} from "../src/core/chatgpt.ts";
import { aiVerdict } from "../src/core/ai.ts";
import { Etude } from "../src/core/engine.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";

// ---------------------------------------------------------------- fake OpenAI

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => b64url(createHash("sha256").update(s).digest());

interface Fake {
  base: string;
  endpoints: ChatGptEndpoints;
  mode: "text" | "json" | "usage-limit" | "not-eligible" | "no-completed";
  bodies: any[];
  tokens: { grant: string; refresh?: string }[];
  /** Everything the browser would have sent back from /authorize. */
  pending: { challenge: string; nonce: string; state: string; redirectUri: string } | null;
  registerAuthorize(url: string): void;
  approve(clientId: string): { code: string; state: string };
  mint(claims: Record<string, unknown>): string;
  usedRefreshTokens: Set<string>;
  revoked: Set<string>;
  close(): Promise<void>;
}

async function fakeOpenAi(): Promise<Fake> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key-1";
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; clientId: string }>();
  const refreshTokens = new Set<string>();
  const usedRefreshTokens = new Set<string>();
  const revoked = new Set<string>();
  let serial = 0;

  const fake = {
    base: "",
    mode: "text" as Fake["mode"],
    bodies: [] as any[],
    tokens: [] as { grant: string; refresh?: string }[],
    pending: null as Fake["pending"],
    usedRefreshTokens,
    revoked,
  } as unknown as Fake;

  const mint = (claims: Record<string, unknown>) => {
    const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${sig.toString("base64url")}`;
  };
  fake.mint = mint;

  const issueTokens = (clientId: string, nonce: string) => {
    serial += 1;
    const n = serial;
    const access = `access-${n}`;
    const refresh = `refresh-${n}`;
    refreshTokens.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: mint({
        iss: "https://auth.openai.com",
        sub: "user-abc",
        aud: clientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce,
        email: "joao@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
      token_type: "Bearer",
      expires_in: 3600,
      scope: CHATGPT_SCOPES.join(" "),
      earliest_refresh_at: new Date(Date.now() + 500).toISOString(),
    };
  };

  const readBody = async (req: any) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/jwks") return json(200, { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, { issuer: "https://auth.openai.com", jwks_uri: `${fake.base}/jwks`, revocation_endpoint: `${fake.base}/revoke` });
    if (url.pathname === "/revoke") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("token")) revoked.add(form.get("token")!);
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === "/v1/models") {
      return json(200, {
        models: [
          { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
          { slug: "gpt-hidden", display_name: "Hidden", visibility: "hidden" },
        ],
      });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type") ?? "";
      fake.tokens.push({ grant, refresh: form.get("refresh_token") ?? undefined });
      if (grant === "authorization_code") {
        const rec = codes.get(form.get("code") ?? "");
        if (!rec) return json(400, { error: "invalid_grant", error_description: "unknown code" });
        if (form.get("client_id") !== rec.clientId) return json(400, { error: "invalid_client" });
        if (form.get("redirect_uri") !== rec.redirectUri) return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        if (sha256(form.get("code_verifier") ?? "") !== rec.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        codes.delete(form.get("code")!);
        return json(200, issueTokens(rec.clientId, rec.nonce));
      }
      if (grant === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        if (revoked.has(rt) || usedRefreshTokens.has(rt) || !refreshTokens.has(rt))
          return json(400, { error: "invalid_grant", error_description: "refresh token is not usable" });
        usedRefreshTokens.add(rt);
        refreshTokens.delete(rt);
        return json(200, issueTokens(form.get("client_id") ?? "", fake.pending?.nonce ?? ""));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/v1/responses" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      fake.bodies.push(body);
      if (fake.mode === "not-eligible")
        return json(403, { error: { code: "subscription_sharing_user_not_eligible", message: "not eligible" } });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { model: body.model } });
      if (fake.mode === "usage-limit") {
        send({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit reached" } } });
        return res.end();
      }
      if (fake.mode === "no-completed") {
        send({ type: "response.output_text.delta", delta: "half" });
        return res.end();
      }
      const text = fake.mode === "json" ? '{"verdict":"correct","score":1,"feedback":"Right: HTTP is HyperText Transfer Protocol."}' : "Hello, world!";
      for (const part of [text.slice(0, 5), text.slice(5)]) send({ type: "response.output_text.delta", delta: part });
      send({ type: "response.completed", response: { model: body.model, output: [{ type: "message", content: [{ type: "output_text", text }] }] } });
      return res.end();
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.base = base;
  fake.endpoints = chatGptEndpoints({
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    issuer: "https://auth.openai.com",
    discovery: `${base}/.well-known/openid-configuration`,
    jwks: `${base}/jwks`,
    models: `${base}/v1/models`,
    responses: `${base}/v1/responses`,
  });
  fake.registerAuthorize = (authorizeUrl: string) => {
    const q = new URL(authorizeUrl).searchParams;
    fake.pending = {
      challenge: q.get("code_challenge") ?? "",
      nonce: q.get("nonce") ?? "",
      state: q.get("state") ?? "",
      redirectUri: q.get("redirect_uri") ?? "",
    };
  };
  fake.approve = (clientId: string) => {
    assert.ok(fake.pending, "call registerAuthorize first");
    const code = `code-${++serial}`;
    codes.set(code, { challenge: fake.pending!.challenge, nonce: fake.pending!.nonce, redirectUri: fake.pending!.redirectUri, clientId });
    return { code, state: fake.pending!.state };
  };
  fake.close = () => new Promise<void>((res) => server.close(() => res()));
  clearChatGptCaches();
  return fake;
}

const tempHome = () => mkdtempSync(join(tmpdir(), "etude-chatgpt-"));

/** Simulates the browser hitting the loopback callback; returns the completion page status. */
async function callback(session: ChatGptLoginSession, params: Record<string, string>): Promise<number> {
  const u = new URL(session.redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u);
  await res.text();
  return res.status;
}

async function signIn(fake: Fake, home: string, clientId = "oaiapp_test") {
  const session = await beginChatGptLogin({ home, endpoints: fake.endpoints, timeoutMs: 5000 });
  fake.registerAuthorize(session.url);
  const { code, state } = fake.approve(clientId);
  assert.equal(await callback(session, { code, state, client_id: clientId }), 200);
  const creds = await session.wait;
  return { session, creds };
}

// ---------------------------------------------------------------------- tests

test("the authorize URL carries every documented parameter", () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      state: "st",
      nonce: "no",
      challenge: "ch",
      hostId: "urn:uuid:11111111-1111-1111-1111-111111111111",
      clientId: "dynamic_agent_client",
      agentNameHint: "Etude",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/api/accounts/authorize");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "dynamic_agent_client");
  assert.equal(q.get("agent_name_hint"), "Etude");
  assert.equal(q.get("ext_agent_host_id"), "urn:uuid:11111111-1111-1111-1111-111111111111");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(q.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(q.get("resource"), "https://api.openai.com/v1");
  assert.equal(q.get("state"), "st");
  assert.equal(q.get("nonce"), "no");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("code_challenge"), "ch");

  const returning = new URL(
    buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:9/auth/callback",
      state: "s",
      nonce: "n",
      challenge: "c",
      hostId: "urn:uuid:11111111-1111-1111-1111-111111111111",
      clientId: "oaiapp_saved",
      idTokenHint: "id-token",
      emailHint: "joao@example.com",
    }),
  ).searchParams;
  assert.equal(returning.get("client_id"), "oaiapp_saved");
  assert.equal(returning.get("agent_name_hint"), null);
  assert.equal(returning.get("id_token_hint"), "id-token");
  assert.equal(returning.get("login_hint"), "joao@example.com");
});

test("sign-in exchanges the code, validates the ID token and stores 0600 credentials", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    const session = await beginChatGptLogin({ home, endpoints: fake.endpoints, timeoutMs: 5000 });
    fake.registerAuthorize(session.url);
    const q = new URL(session.url).searchParams;
    assert.equal(q.get("client_id"), "dynamic_agent_client");
    assert.equal(q.get("agent_name_hint"), "Etude");
    assert.match(q.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
    const { code, state } = fake.approve("oaiapp_test");
    assert.equal(await callback(session, { code, state, client_id: "oaiapp_test" }), 200);

    const creds = await session.wait;
    assert.equal(creds.email, "joao@example.com");
    assert.equal(creds.client_id, "oaiapp_test");
    assert.equal(creds.subject, "user-abc");
    assert.equal(creds.plan_type, "plus");
    assert.ok(creds.scopes.includes(CHATGPT_PLAN_SCOPE));
    assert.equal(fake.tokens[0].grant, "authorization_code");

    const paths = chatGptPaths(home);
    assert.equal(statSync(paths.credentials).mode & 0o777, 0o600);
    assert.equal(statSync(paths.hostId).mode & 0o777, 0o600);
    const onDisk = JSON.parse(readFileSync(paths.credentials, "utf8"));
    assert.equal(onDisk.refresh_token, creds.refresh_token);
    assert.equal(onDisk.ext_agent_host_id, creds.ext_agent_host_id);

    const status = chatGptStatus(home);
    assert.equal(status.signedIn, true);
    assert.equal(status.plan, "enabled");

    // A later sign-in reuses the issued client id, drops the name hint and sends the hints.
    const again = await beginChatGptLogin({ home, endpoints: fake.endpoints, timeoutMs: 5000 });
    const q2 = new URL(again.url).searchParams;
    assert.equal(q2.get("client_id"), "oaiapp_test");
    assert.equal(q2.get("agent_name_hint"), null);
    // The URL is printed and opened, so it must not carry the retained ID token.
    assert.equal(q2.get("id_token_hint"), null);
    assert.equal(q2.get("login_hint"), "joao@example.com");
    assert.equal(q2.get("ext_agent_host_id"), creds.ext_agent_host_id);
    again.cancel();
    await assert.rejects(again.wait, /cancelled/);
  } finally {
    await fake.close();
  }
});

test("the callback refuses a mismatched state and saves nothing", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    const session = await beginChatGptLogin({ home, endpoints: fake.endpoints, timeoutMs: 5000 });
    fake.registerAuthorize(session.url);
    const { code, state } = fake.approve("oaiapp_test");
    const status = await callback(session, { code, state: state + "x", client_id: "oaiapp_test" });
    assert.equal(status, 400);
    await assert.rejects(session.wait, (e: unknown) => e instanceof ChatGptError && e.code === "state_mismatch");
    assert.equal(readChatGptCredentials(home), null);
  } finally {
    await fake.close();
  }
});

test("a declined consent fails without exchanging the code", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    const session = await beginChatGptLogin({ home, endpoints: fake.endpoints, timeoutMs: 5000 });
    fake.registerAuthorize(session.url);
    const { state } = fake.approve("oaiapp_test");
    assert.equal(await callback(session, { error: "access_denied", state }), 400);
    await assert.rejects(session.wait, /declined/);
    assert.equal(fake.tokens.length, 0);
  } finally {
    await fake.close();
  }
});

test("ID token validation checks the signature, issuer, audience, expiry and nonce", async () => {
  const fake = await fakeOpenAi();
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: "https://auth.openai.com", sub: "u1", aud: "oaiapp_test", exp: now + 600, iat: now, nonce: "nonce-1", email: "a@b.c" };
  const opts = { audience: "oaiapp_test", nonce: "nonce-1", jwksUrl: fake.endpoints.jwks, issuer: fake.endpoints.issuer };
  try {
    assert.equal((await verifyIdToken(fake.mint(base), opts)).sub, "u1");

    const tampered = fake.mint(base).split(".");
    tampered[1] = b64url(JSON.stringify({ ...base, sub: "someone-else" }));
    await assert.rejects(verifyIdToken(tampered.join("."), opts), /signature/);

    await assert.rejects(verifyIdToken(fake.mint({ ...base, aud: "oaiapp_other" }), opts), /another client/);
    await assert.rejects(verifyIdToken(fake.mint({ ...base, iss: "https://evil.example" }), opts), /issued by/);
    await assert.rejects(verifyIdToken(fake.mint({ ...base, exp: now - 3600 }), opts), /expired/);
    await assert.rejects(verifyIdToken(fake.mint({ ...base, nonce: "other" }), opts), /nonce/);
  } finally {
    await fake.close();
  }
});

test("refresh rotates the token pair once and clears credentials when the token is refused", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    const { creds } = await signIn(fake, home);
    const expire = () =>
      saveChatGptCredentials(home, {
        ...readChatGptCredentials(home)!,
        saved_at: new Date(Date.now() - 7200_000).toISOString(),
        expires_in: 3600,
        earliest_refresh_at: null,
      });
    expire();

    const [a, b] = await Promise.all([getChatGptCredentials(home, fake.endpoints), getChatGptCredentials(home, fake.endpoints)]);
    assert.equal(a.refresh_token, b.refresh_token);
    assert.notEqual(a.refresh_token, creds.refresh_token);
    assert.equal(fake.tokens.filter((t) => t.grant === "refresh_token").length, 1, "one refresh for two concurrent calls");

    // The old refresh token is spent; putting it back is a terminal error.
    expire();
    saveChatGptCredentials(home, { ...readChatGptCredentials(home)!, refresh_token: creds.refresh_token });
    await assert.rejects(getChatGptCredentials(home, fake.endpoints), (e: unknown) => e instanceof ChatGptError && e.code === "reauth_required");
    const cleared = readChatGptCredentials(home)!;
    assert.equal(cleared.access_token, null);
    assert.equal(cleared.refresh_token, null);
    assert.equal(cleared.needs_reauth, true);
    assert.equal(cleared.client_id, "oaiapp_test");
  } finally {
    await fake.close();
  }
});

test("logout revokes the session and keeps the registration", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    const { creds } = await signIn(fake, home);
    const out = await chatGptLogout(home, fake.endpoints);
    assert.equal(out.revoked, true);
    assert.ok(fake.revoked.has(creds.refresh_token!));
    const after = readChatGptCredentials(home)!;
    assert.equal(after.access_token, null);
    assert.equal(after.client_id, creds.client_id);
    assert.equal(after.email, creds.email);
    assert.equal(chatGptStatus(home).signedIn, false);
  } finally {
    await fake.close();
  }
});

test("a streamed Responses call returns the final text and sends the preview body", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    await signIn(fake, home);
    const out = await chatGptResponses({ home, model: "gpt-6.1-sol", instructions: "Grade it.", input: "## prompt\nHTTP?", endpoints: fake.endpoints });
    assert.equal(out.text, "Hello, world!");
    const body = fake.bodies[0];
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "Grade it.");
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_output_tokens, undefined);
    assert.deepEqual(body.input[0].content, [{ type: "input_text", text: "## prompt\nHTTP?" }]);

    await chatGptResponses({
      home,
      model: "gpt-6.1-sol",
      instructions: "Grade it.",
      input: "answer",
      image: "data:image/png;base64,iVBORw0KGgo=",
      endpoints: fake.endpoints,
    });
    assert.deepEqual(fake.bodies[1].input[0].content[1], { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" });
  } finally {
    await fake.close();
  }
});

test("plan errors become plain messages", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    await signIn(fake, home);
    fake.mode = "usage-limit";
    await assert.rejects(chatGptResponses({ home, model: "m", instructions: "i", input: "x", endpoints: fake.endpoints }), /usage limit/i);
    fake.mode = "not-eligible";
    await assert.rejects(chatGptResponses({ home, model: "m", instructions: "i", input: "x", endpoints: fake.endpoints }), /Plus or Pro/);
    fake.mode = "no-completed";
    await assert.rejects(chatGptResponses({ home, model: "m", instructions: "i", input: "x", endpoints: fake.endpoints }), /ended without finishing/);
  } finally {
    await fake.close();
  }
});

test("the model list keeps only displayable models", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  try {
    await signIn(fake, home);
    assert.deepEqual(await listChatGptModels(home, fake.endpoints), [{ slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }]);
  } finally {
    await fake.close();
  }
});

test("grading with the ChatGPT plan is one call and needs no decision model", async () => {
  const fake = await fakeOpenAi();
  const home = tempHome();
  fake.mode = "json";
  const e = await Etude.open(":memory:", { home });
  try {
    const { creds } = await signIn(fake, home);
    assert.equal(creds.plan_type, "plus");
    const ai = {
      decision: null,
      feedback: { kind: "chatgpt" as const, model: "gpt-6.1-sol", baseUrl: fake.endpoints.responses, vision: true, timeoutMs: 10_000 },
      vision: null,
      autoFeedback: "never" as const,
      language: "English",
    };
    const ctx = {
      card: [{ label: "prompt", text: "What does HTTP stand for?" }],
      instructions: [],
      answerText: "hypertext transfer protocol",
      answerImage: null,
    };
    const v = await aiVerdict(ai, ctx, { home });
    assert.equal(v.verdict, "correct");
    assert.equal(v.score, 1);
    assert.match(v.feedback ?? "", /HyperText/);
    assert.equal(fake.bodies.length, 1, "verdict and feedback come from a single request");
  } finally {
    e.close();
    await fake.close();
  }
});

test("the CLI reports ChatGPT status without a database and resolves three-word commands", async () => {
  const home = tempHome();
  let out = "";
  let err = "";
  const code = await run(["settings", "chatgpt", "status"], {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    stdin: () => "",
    isTTY: false,
    env: { ETUDE_HOME: home },
  });
  assert.equal(code, 0, err);
  const body = JSON.parse(out);
  assert.equal(body.signedIn, false);
  assert.equal(body.plan, "none");
  assert.equal(body.hostId, null);
});

test("a credential file from another machine is adopted with a new host id", async () => {
  const fake = await fakeOpenAi();
  const laptop = tempHome();
  const server = tempHome();
  try {
    const { creds } = await signIn(fake, laptop);
    const imported = importChatGptCredentials(server, chatGptPaths(laptop).credentials);
    assert.equal(imported.signedIn, true);
    const onServer = readChatGptCredentials(server)!;
    assert.equal(onServer.client_id, creds.client_id);
    assert.equal(onServer.refresh_token, creds.refresh_token);
    assert.notEqual(onServer.ext_agent_host_id, creds.ext_agent_host_id);
    assert.equal(imported.hostId, onServer.ext_agent_host_id);
    assert.equal(statSync(chatGptPaths(server).credentials).mode & 0o777, 0o600);
    assert.equal(chatGptStatus(server).plan, "enabled");
    assert.throws(() => importChatGptCredentials(server, join(server, "missing.json")), /couldn't read/);
  } finally {
    await fake.close();
  }
});

test("the HTTP routes point a remote browser at the CLI", async () => {
  const home = tempHome();
  const e = await Etude.open(":memory:", { home });
  try {
    const app = createApp(e);
    const remote = await app.request("/api/chatgpt/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-host": "athanor.tailnet.example" },
      body: "{}",
    });
    assert.equal(remote.status, 200);
    const body = (await remote.json()) as any;
    assert.equal(body.remote, true);
    assert.equal(body.cli, "etude settings chatgpt login");

    const status = await app.request("/api/chatgpt/status", { headers: { "x-forwarded-host": "127.0.0.1:4610" } });
    const st = (await status.json()) as any;
    assert.equal(st.signedIn, false);
    assert.equal(st.login, null);
    assert.deepEqual(st.models, []);
  } finally {
    e.close();
  }
});
