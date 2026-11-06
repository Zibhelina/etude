// Two-step sign-in in the app: when the server answers the email code with `second_factor_required`, the account and
// Sync sign-ins return `secondStep` and keep the ticket; the authenticator code or a recovery code finishes signing in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Etude } from "../src/core/engine.ts";
import { accountFor } from "../src/core/account.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { AGENT_DENY } from "../src/core/agent.ts";
import { run } from "../src/cli/run.ts";
import "../src/cli/commands/index.ts";

/** etude-cloud's sign-in with two-step sign-in on: the email code gets a ticket, then 123456 or a recovery code. */
function cloud() {
  let tickets = 0;
  const live = new Map<string, number>();
  const seen: { path: string; auth?: string; body: any }[] = [];
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const p = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ path: p, auth: req.headers.authorization, body });
    const send = (status: number, data: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(data)));
    const account = { id: "acc_1", email: "a@example.test" };
    if (p === "/v1/server") return send(200, { billing: false, sync: { withoutPassword: false } });
    if (p === "/v1/auth/email/start") return send(200, { ok: true });
    if (p === "/v1/auth/email/verify") {
      const ticket = `mfa_ticket_${++tickets}`;
      live.set(ticket, 5);
      return send(401, { error: { code: "second_factor_required", message: "This account has two-step sign-in.", ticket, methods: ["authenticator", "recovery_code"], expiresIn: 600 } });
    }
    if (p === "/v1/auth/second-factor") {
      const left = live.get(body.ticket);
      if (!left) return send(401, { error: { code: "ticket_expired", message: "This sign-in has expired. Sign in by email again." } });
      if (body.code === "123456" || body.recoveryCode === "abcd-efgh-jkmn") {
        live.delete(body.ticket);
        return req.headers.authorization ? send(200, { reauth: true, account }) : send(200, { token: `etd_${body.ticket}`, created: false, account });
      }
      live.set(body.ticket, left - 1);
      if (left - 1 === 0) return (live.delete(body.ticket), send(401, { error: { code: "too_many_attempts", message: "Too many wrong codes. Sign in by email again." } }));
      return send(401, { error: { code: "invalid_code", message: `That code isn't right. ${left - 1} tries left.`, attemptsLeft: left - 1 } });
    }
    if (p === "/v1/vault") return send(200, { hasKeys: false });
    if (p === "/v1/me") return send(200, { ...account, twoFactor: { enabled: true, authenticator: true, recoveryCodesLeft: 10 } });
    return send(404, { error: { code: "not_found", message: "not found" } });
  });
  return {
    seen,
    async start() {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "two-factor-"));
  const c = cloud();
  const url = await c.start();
  const e = await Etude.open(join(dir, "etude.db"), { home: join(dir, "home") });
  t.after(async () => {
    e.close();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, c, url, e };
}

test("account: the email code returns secondStep; a wrong code says so, the authenticator code signs in", async (t) => {
  const { c, url, e } = await setup(t);
  const a = accountFor(e);
  a.setServer(url);
  await a.signin("a@example.test");
  const first = await a.verify("482913");
  assert.deepEqual(first.secondStep, { methods: ["authenticator", "recovery_code"] });
  assert.ok(!a.token(), "not signed in yet");
  await assert.rejects(a.secondStep({ code: "12345" }), /6-digit code/, "checked before asking the server");
  await assert.rejects(a.secondStep({ code: "111111" }), /isn't right\. 4 tries left/);
  const done = await a.secondStep({ code: "123 456" });
  assert.deepEqual(done, { reauth: false, email: "a@example.test" });
  assert.equal(a.token(), "etd_mfa_ticket_1");
  assert.equal(c.seen.findLast((r) => r.path === "/v1/auth/second-factor")?.body.code, "123456", "spaces dropped");
  await assert.rejects(a.secondStep({ code: "123456" }), /expired/, "the ticket is gone once used");
});

test("account: a recovery code works too, and a signed-in device confirming itself sends its token", async (t) => {
  const { c, url, e } = await setup(t);
  const a = accountFor(e);
  a.setServer(url);
  await a.signin("a@example.test");
  await a.verify("482913");
  await a.secondStep({ recoveryCode: " abcd-efgh-jkmn " });
  const token = a.token();
  await a.signin("a@example.test");
  assert.ok((await a.verify("482913")).secondStep);
  assert.deepEqual(await a.secondStep({ code: "123456" }), { reauth: true, email: "a@example.test" });
  assert.equal(c.seen.findLast((r) => r.path === "/v1/auth/second-factor")?.auth, `Bearer ${token}`);
  assert.equal(a.token(), token, "the same device");
});

test("account: too many wrong codes drop the ticket", async (t) => {
  const { url, e } = await setup(t);
  const a = accountFor(e);
  a.setServer(url);
  await a.signin("a@example.test");
  await a.verify("482913");
  for (let i = 0; i < 4; i++) await assert.rejects(a.secondStep({ code: "000000" }), /isn't right/);
  await assert.rejects(a.secondStep({ code: "000000" }), /Too many/);
  await assert.rejects(a.secondStep({ code: "123456" }), /sign in by email again/, "no ticket left to try");
});

test("Sync's own sign-in takes the second step too", async (t) => {
  const { url, e } = await setup(t);
  const s = syncFor(e);
  s.setup({ server: url });
  await s.signin("a@example.test");
  const v: any = await s.verify("482913");
  assert.deepEqual(v.secondStep, { methods: ["authenticator", "recovery_code"] });
  assert.equal(v.signedIn, false);
  await assert.rejects(s.secondStep({ code: "999999" }), /isn't right/);
  const done = await s.secondStep({ code: "123456" });
  assert.equal(done.signedIn, true);
  assert.equal(accountFor(e).token(), "etd_mfa_ticket_1", "shared with the account, like a plain sign-in");
});

test("CLI: `account verify` reports the second step; `account second-factor` finishes it, a recovery code on stdin", async (t) => {
  const { dir, url } = await setup(t);
  const env = { ...process.env, ETUDE_HOME: join(dir, "cli-home"), ETUDE_TELEMETRY: "0" };
  const cli = async (argv: string[], stdin = "") => {
    let out = "";
    let err = "";
    const code = await run(argv, { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s), stdin: () => stdin, isTTY: false, env });
    return { code, json: out ? JSON.parse(out) : null, err };
  };
  await cli(["account", "server", url]);
  await cli(["account", "signin", "a@example.test"]);
  const v = await cli(["account", "verify", "482913"]);
  assert.equal(v.code, 0, v.err);
  assert.deepEqual(v.json.secondStep, { methods: ["authenticator", "recovery_code"] });
  assert.notEqual((await cli(["account", "second-factor"])).code, 0, "a code or --recovery");
  const r = await cli(["account", "second-factor", "--recovery"], "abcd-efgh-jkmn\n");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.email, "a@example.test");
});

test("the in-app assistant can't take sign-in steps or change two-step sign-in", () => {
  for (const name of ["sync second-factor", "account second-factor", "account authenticator", "account authenticator-confirm", "account authenticator-remove", "account two-factor-on", "account two-factor-off", "account recovery-codes"]) assert.ok(AGENT_DENY.includes(name), name);
  assert.ok(!AGENT_DENY.includes("account two-factor"), "it may read whether it's on");
});
