// Sync without a password: a vault whose key the server keeps opens on a new device after signing in, with no password.
// Adding a password makes it end-to-end (the server's copy goes in the same write); removing it hands the key back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { run } from "../src/cli/run.ts";
import "../src/cli/commands/index.ts";

/** Just enough of etude-cloud's vault for two devices: sign-in, keys (with the server slot), server key, events, blobs. */
function cloud(opts: { keepsKeys: boolean }) {
  const tokens = new Set<string>();
  let keys: Record<string, unknown> | null = null;
  let serverVk: string | null = null;
  let etag = 0;
  const events: { seq: number; id: string; device: string; ciphertext: string }[] = [];
  const blobs = new Map<string, Buffer>();
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(data)));
    const err = (status: number, code: string) => send(status, { error: { code, message: code } });
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const p = url.pathname;
    if (p === "/v1/server") return send(200, { billing: false, sync: { withoutPassword: opts.keepsKeys } });
    if (p === "/v1/auth/email/start") return send(200, { ok: true });
    if (p === "/v1/auth/email/verify") {
      const token = `etd_${tokens.size + 1}`;
      tokens.add(token);
      return send(200, { token, account: { id: "acc_1", email: "a@example.test" } });
    }
    if (!tokens.has(auth)) return err(401, "unauthorized");
    const body = raw.length && req.headers["content-type"]?.includes("json") ? JSON.parse(raw.toString()) : {};
    const ifMatch = req.headers["if-match"];
    const current = () => `"k${etag}"`;
    if (p === "/v1/vault") return send(200, { hasKeys: !!keys, mode: keys ? (keys.server ? "server" : "password") : null, usedBytes: 0 });
    if (p === "/v1/vault/keys" && req.method === "GET") return keys ? send(200, keys.server ? { ...keys, server: true } : keys, { etag: current() }) : err(404, "no_keys");
    if (p === "/v1/vault/keys" && req.method === "PUT") {
      if (keys && ifMatch !== current()) return err(412, "etag_mismatch");
      if (body.server) return err(422, "server_slot");
      const { server, ...slots } = body;
      if (server === null) serverVk = null;
      keys = serverVk ? { ...slots, server: { kept: true } } : slots;
      etag++;
      return send(200, { ok: true, etag: current() });
    }
    if (p === "/v1/vault/server-key" && req.method === "PUT") {
      if (!opts.keepsKeys) return err(503, "server_keys_off");
      if (keys && ifMatch !== current()) return err(keys && !ifMatch ? 428 : 412, "etag_mismatch");
      serverVk = body.vk;
      keys = { v: 1, server: { kept: true } };
      etag++;
      return send(200, { ok: true, etag: current() });
    }
    if (p === "/v1/vault/server-key" && req.method === "GET") return serverVk ? send(200, { vk: serverVk }) : err(404, "no_server_key");
    if (p === "/v1/sync/events" && req.method === "POST") {
      for (const e of body.events) if (!events.some((x) => x.id === e.id)) events.push({ seq: events.length + 1, id: e.id, device: auth, ciphertext: e.ciphertext });
      return send(200, { accepted: body.events.length, duplicates: 0, lastSeq: events.length });
    }
    if (p === "/v1/sync/events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const page = events.filter((e) => e.seq > after);
      return send(200, { events: page.map((e) => ({ ...e, at: new Date().toISOString() })), cursor: page.at(-1)?.seq ?? after, more: false });
    }
    if (p.startsWith("/v1/blobs/")) {
      const name = p.slice("/v1/blobs/".length);
      if (req.method === "PUT") return blobs.set(name, raw), send(201, { ok: true, hash: name });
      return blobs.has(name) ? (res.writeHead(200), res.end(blobs.get(name))) : err(404, "not_found");
    }
    return err(404, "not_found");
  });
  return {
    get keys() {
      return keys;
    },
    get serverVk() {
      return serverVk;
    },
    async start() {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function device(dir: string, name: string, url: string) {
  const e = await Etude.open(join(dir, `${name}.db`), { home: join(dir, name) });
  const s = syncFor(e);
  s.setup({ server: url });
  await s.signin("a@example.test");
  await s.verify("123456");
  return { e, s };
}

const pack = (deck: string) => ({ etude: "pack/1", name: deck, decks: [{ name: deck }], items: [{ id: `${deck}-1`, type: "basic", deck, fields: { front: "Q", back: "A" } }] });

test("no password: the first device starts Sync with none; a second one gets the key after signing in and the collection with it", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-nopw-"));
  const c = cloud({ keepsKeys: true });
  const url = await c.start();
  const laptop = await device(dir, "laptop", url);
  t.after(async () => {
    laptop.e.close();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(laptop.s.status().passwordOptional, true);
  const first = await laptop.s.unlock({});
  assert.equal(first.recoveryKey, undefined, "no recovery key to keep");
  assert.equal(first.status.mode, "server");
  assert.ok(c.serverVk, "the server keeps the key");
  laptop.e.importPack(pack("Physics"));
  await laptop.s.now();

  const phone = await device(dir, "phone", url);
  t.after(() => phone.e.close());
  assert.equal((await phone.s.unlock({})).status.unlocked, true, "no password asked");
  await phone.s.now();
  assert.ok(phone.e.db.get("SELECT 1 FROM decks WHERE name = 'Physics'"), "the collection arrived");
});

test("adding a password makes the vault end-to-end; a new device then needs it; removing it hands the key back", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-protect-"));
  const c = cloud({ keepsKeys: true });
  const url = await c.start();
  const laptop = await device(dir, "laptop", url);
  t.after(async () => {
    laptop.e.close();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await laptop.s.unlock({});
  await assert.rejects(laptop.s.protect("short"), /at least 8 characters/);
  const protectedVault = await laptop.s.protect("correct horse battery");
  assert.match(protectedVault.recoveryKey, /\S{4}(-\S{4})+/, "a recovery key, shown once");
  assert.equal(protectedVault.status.mode, "password");
  assert.equal(c.serverVk, null, "the server's copy is gone");
  assert.ok(c.keys?.password && c.keys?.recovery && !c.keys?.server);

  const tablet = await device(dir, "tablet", url);
  t.after(() => tablet.e.close());
  await assert.rejects(tablet.s.unlock({}), /Sync password or recovery key/);
  assert.equal((await tablet.s.unlock({ password: "correct horse battery" })).status.unlocked, true);

  const back = await laptop.s.unprotect();
  assert.equal(back.status.mode, "server");
  assert.ok(c.serverVk && !c.keys?.password, "the server keeps the key again and the password no longer opens the vault");
});

test("on a server that can't keep keys, a new vault still needs a password", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-needspw-"));
  const c = cloud({ keepsKeys: false });
  const url = await c.start();
  const laptop = await device(dir, "laptop", url);
  t.after(async () => {
    laptop.e.close();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(laptop.s.status().passwordOptional, false);
  await assert.rejects(laptop.s.unlock({}), /needs a Sync password/);
  const made = await laptop.s.unlock({ password: "correct horse battery" });
  assert.equal(made.status.mode, "password");
  assert.ok(made.recoveryKey);
  await assert.rejects(laptop.s.unprotect(), /can't keep vault keys/);
});

test("CLI: `sync unlock` with no stdin starts without a password; `sync unprotect` needs --yes", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-cli-nopw-"));
  const c = cloud({ keepsKeys: true });
  const url = await c.start();
  t.after(async () => {
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, ETUDE_HOME: join(dir, "home"), ETUDE_TELEMETRY: "0" };
  const cli = async (argv: string[], stdin = "") => {
    let out = "";
    let err = "";
    const code = await run(argv, { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s), stdin: () => stdin, isTTY: false, env });
    return { code, json: out ? JSON.parse(out) : null, err };
  };
  assert.equal((await cli(["sync", "setup", "--server", url])).code, 0);
  await cli(["sync", "signin", "--email", "a@example.test"]);
  await cli(["sync", "verify", "123456"]);
  const unlocked = await cli(["sync", "unlock"]);
  assert.equal(unlocked.code, 0, unlocked.err);
  assert.equal(unlocked.json.status.mode, "server");
  const pw = await cli(["sync", "protect"], "correct horse battery\n");
  assert.equal(pw.json.status.mode, "password");
  assert.ok(pw.json.recoveryKey);
  const refused = await cli(["sync", "unprotect"]);
  assert.notEqual(refused.code, 0, "removing the password asks for --yes");
  assert.equal((await cli(["sync", "unprotect", "--yes"])).json.status.mode, "server");
});
