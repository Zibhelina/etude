import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Etude } from "../src/core/engine.ts";
import { accountFor, AccountError, checkServerUrl, paidId, signInCode } from "../src/core/account.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { agentRefusal } from "../src/core/agent-guard.ts";
import { COMMANDS } from "../src/cli/registry.ts";
import { createVault } from "../src/core/sync/crypto.ts";
import "../src/cli/commands/index.ts";

/** Just enough of etude-cloud for the client: sign-in, me, library, pack download, deletion. */
function stub() {
  const tokens = new Set<string>();
  let pack: any = { etude: "pack/1", name: "Pharm", decks: [{ name: "Pharm" }], items: [{ id: "p1", type: "basic", deck: "Pharm", fields: { front: "ACE inhibitor ending", back: "-pril" } }] };
  let version = "1.0.0";
  const calls: string[] = [];
  const verifyBodies: any[] = [];
  let fresh = true;
  let vaultKeys: unknown = null;
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(data)));
    const path = (req.url ?? "").split("?")[0];
    calls.push(`${req.method} ${path}`);
    if (path === "/v1/server") return send(200, { billing: true, market: true, quotaBytes: 1024 ** 3, passkeys: { rpId: "localhost" } });
    if (path === "/v1/auth/email/start") return send(200, { ok: true });
    if (path === "/v1/auth/email/verify") {
      verifyBodies.push(body);
      const good = body.token === "good-code" || (body.email === "a@example.test" && body.code === "482913" && body.token === undefined);
      if (!good) return send(401, { error: body.code ? { code: "invalid_code", message: "That code isn't right. 4 tries left.", attemptsLeft: 4 } : { code: "invalid_token", message: "bad code" } });
      fresh = true;
      if (tokens.has(auth)) return send(200, { reauth: true, account: { id: "acc_1", email: "a@example.test" } });
      tokens.add("ecd_tok");
      return send(200, { token: "ecd_tok", account: { id: "acc_1", email: "a@example.test" } });
    }
    if (!tokens.has(auth)) return send(401, { error: { code: "unauthorized", message: "Sign in first" } });
    if (path === "/v1/me" && req.method === "GET") return send(200, { id: "acc_1", email: "a@example.test", device: { id: "dev_1" }, sync: { active: false, reason: "none" }, admin: false });
    if (path === "/v1/me" && req.method === "DELETE") return tokens.delete(auth), send(200, { ok: true, deleted: "acc_1" });
    if (path === "/v1/billing/sync") return send(200, { active: false, reason: "none", billing: true });
    if (path === "/v1/library") return send(200, { library: [{ listing: "lst_1", slug: "pharm", name: "Pharm", version, changelog: "", pack: "/v1/listings/lst_1/pack" }] });
    if (path === "/v1/listings/lst_1/pack") return send(200, pack, { "x-etude-version": version });
    if (path === "/v1/vault") return send(200, { hasKeys: !!vaultKeys });
    if (path === "/v1/vault/keys") {
      if (!fresh) return send(403, { error: { code: "reauth_required", message: "Sign in again on this device to read the vault's keys." } });
      return vaultKeys ? send(200, vaultKeys, { etag: '"keys"' }) : send(404, { error: { code: "no_keys", message: "none" } });
    }
    if (path === "/v1/auth/logout") return tokens.delete(auth), send(200, { ok: true });
    // A creator from before direct charges: no usable Stripe account until they set up again.
    if (path === "/v1/creator" && req.method === "GET") return send(200, { country: "CA", displayName: "Old", stripeAccount: null, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, setupRequired: true });
    if (path === "/v1/creator/onboarding-link" || path === "/v1/creator/dashboard-link") return send(409, { error: { code: "creator_setup_required", message: "Etude now sells through your own Stripe account. Set up selling again to create it (POST /v1/creator)." } });
    return send(404, { error: { code: "not_found", message: path } });
  });
  return {
    calls,
    verifyBodies,
    expireSignin() { fresh = false; },
    setVaultKeys(keys: unknown) { vaultKeys = keys; },
    bump(next: string) {
      version = next;
      pack = { ...pack, items: [...pack.items, { id: "p2", type: "basic", deck: "Pharm", fields: { front: "Beta blocker ending", back: "-olol" } }] };
    },
    async start() {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("sync: a stale shared sign-in probes metadata, asks for reauth on unlock and keeps the same device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-reauth-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("482913");
    const originalToken = a.token();
    s.setVaultKeys((await createVault("sync-password", { m: 1024, t: 1, p: 1 })).keys);
    s.expireSignin();
    const sy = syncFor(e);
    sy.setup({ server: url });
    const st = await sy.probe();
    assert.equal(st.hasKeys, true);
    assert.equal(st.error, null);
    assert.equal(s.calls.includes("GET /v1/vault/keys"), false, "probing never downloads key wraps");
    await assert.rejects(sy.unlock({ password: "sync-password" }), (err: AccountError) => err.status === 403 && err.code === "reauth_required");
    assert.equal(sy.status().unlocked, false);
    await sy.signin("a@example.test");
    const confirmed = await sy.verify("482913");
    assert.equal(a.token(), originalToken);
    assert.equal(confirmed.account, true, "a shared account token stays shared after reauth");
    assert.equal((await sy.unlock({ password: "sync-password" })).status.unlocked, true);
    await sy.signin("a@example.test");
    assert.equal((await sy.verify("482913")).unlocked, true, "reauth preserves the saved vault key");
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: sign in, token file 0600, purchased deck installs and updates through the pack importer, delete needs the typed email", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    assert.equal((await a.status()).signedIn, false);
    await a.signin("a@example.test");
    await assert.rejects(a.verify("bad-code"), (err: AccountError) => err.status === 401);
    assert.deepEqual(await a.verify("good-code"), { reauth: false, email: "a@example.test" });
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "home", "account.json")).mode & 0o777, 0o600);
    assert.equal((await a.verify("good-code")).reauth, true, "a second code re-confirms this device");
    assert.throws(() => a.setServer("https://other.example"), /sign out/);

    // Sync on the same server uses the account's device instead of asking for another code.
    syncFor(e).setup({ server: url });
    const st = await syncFor(e).probe();
    assert.equal(st.signedIn, true);
    assert.equal(st.account, true);

    const lib = await a.library();
    assert.equal(lib.library[0].installed, null);
    const r1 = await a.install("lst_1");
    assert.equal(r1.result, "created");
    assert.equal(e.db.get("SELECT count(*) AS n FROM items WHERE id = 'p1'")!.n, 1);
    assert.equal((await a.library()).library[0].installed, "installed");

    s.bump("1.1.0");
    assert.equal((await a.library()).library[0].installed, "update");
    const r2 = await a.install("pharm");
    assert.equal(r2.result, "updated");
    assert.equal(r2.entry.id, paidId("pharm"));
    assert.equal(e.db.get("SELECT count(*) AS n FROM items WHERE deck_id = (SELECT id FROM decks WHERE name = 'Pharm')")!.n, 2);

    await assert.rejects(a.deleteAccount("someone@else.test"), /type the account's email/);
    assert.ok(!s.calls.includes("DELETE /v1/me"));
    assert.equal((await a.deleteAccount("A@example.test")).ok, true);
    assert.equal(a.token(), undefined);
    assert.equal((await a.status()).signedIn, false);
    // Local data stays.
    assert.equal(e.db.get("SELECT count(*) AS n FROM items WHERE id = 'p1'")!.n, 1);
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account and sync: a 6-digit code (spaces allowed) goes as {email, code}, anything else as {token}", async () => {
  assert.equal(signInCode("482913"), "482913");
  assert.equal(signInCode(" 482 913 "), "482913");
  assert.equal(signInCode("48291"), null);
  assert.equal(signInCode("ml_abcdefghijklmnop"), null);
  assert.equal(signInCode("4829134"), null);
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-code-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  const e2 = await Etude.open(join(dir, "etude2.db"), { home: join(dir, "home2") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await assert.rejects(a.verify("482913"), (err: AccountError) => err.code === "invalid_email", "no pending sign-in: no address to send");
    await a.signin("a@example.test");
    await assert.rejects(a.verify("111 111"), (err: AccountError) => err.code === "invalid_code" && /4 tries left/.test(err.message));
    assert.deepEqual(s.verifyBodies.at(-1), { email: "a@example.test", code: "111111", deviceName: s.verifyBodies.at(-1).deviceName });
    assert.deepEqual(await a.verify("482 913"), { reauth: false, email: "a@example.test" });
    assert.equal(s.verifyBodies.at(-1).code, "482913");
    assert.equal(s.verifyBodies.at(-1).token, undefined);
    // The long token from the link still goes as {token}.
    assert.equal((await a.verify("good-code")).reauth, true);
    assert.deepEqual(Object.keys(s.verifyBodies.at(-1)).sort(), ["deviceName", "token"]);

    // Sync's own sign-in uses the address it was given in `signin`.
    const sy = syncFor(e2);
    sy.setup({ server: url });
    await sy.signin("a@example.test");
    // A wrong code is the server's 401 with its message (not a 500 from the app server).
    await assert.rejects(sy.verify("111111"), (err: AccountError) => err instanceof AccountError && err.status === 401 && err.code === "invalid_code" && /4 tries left/.test(err.message));
    const st = await sy.verify("482913");
    assert.equal(st.signedIn, true);
    assert.equal(s.verifyBodies.at(-1).email, "a@example.test");
    assert.equal(s.verifyBodies.at(-1).code, "482913");
    assert.equal(s.verifyBodies.at(-1).token, undefined);
  } finally {
    e.close();
    e2.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account: server URLs need https outside localhost", () => {
  assert.equal(checkServerUrl("https://sync.etude.study/"), "https://sync.etude.study");
  assert.equal(checkServerUrl("http://localhost:4870"), "http://localhost:4870");
  assert.throws(() => checkServerUrl("http://example.com"), /https/);
  assert.throws(() => checkServerUrl("https://u:p@example.com"), /user/);
});

test("account: Ask Etude may read the account but not buy, sell, sign in or delete", () => {
  const cmd = (name: string) => COMMANDS.find((c) => c.name === name)!;
  const g = (name: string) => agentRefusal({ cmd: cmd(name), values: {}, named: {}, attachmentDir: (process.env.TMPDIR ?? tmpdir()) });
  for (const ok of ["account status", "account library", "account sales"]) assert.equal(g(ok), null, ok);
  for (const no of ["account delete", "account buy", "account install", "account signin", "account list-deck", "account approve", "account revoke", "account server"]) assert.match(g(no) ?? "", /can't change the Etude account/, no);
});

test("account: a creator from before direct charges reads as setupRequired, and Stripe links say to set up again in plain words", async () => {
  const dir = mkdtempSync(join((process.env.TMPDIR ?? tmpdir()), "account-"));
  const s = stub();
  const url = await s.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  try {
    const a = accountFor(e);
    a.setServer(url);
    await a.signin("a@example.test");
    await a.verify("good-code");
    const cr: any = await a.creator();
    assert.equal(cr.setupRequired, true);
    assert.equal(cr.stripeAccount, null);
    for (const link of [a.onboardingLink, a.dashboardLink])
      await assert.rejects(link(), (err: AccountError) => err.status === 409 && err.code === "creator_setup_required" && /Market → Sell/.test(err.message) && !/POST/.test(err.message));
  } finally {
    e.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
