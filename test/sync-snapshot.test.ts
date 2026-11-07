// Snapshots: a desktop device writes the vault's merged registers in parts; a new device merges them and pulls only
// the events after them, and ends exactly where a device that replays the whole log ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Etude } from "../src/core/engine.ts";
import { syncFor } from "../src/core/sync/client.ts";
import { rows } from "../src/core/sync/log.ts";
import { decryptSnapshotPart, encryptSnapshotPart, generateVaultKey, syncKeys } from "../src/core/sync/crypto.ts";
import { finishSnapshot, mergeSnapshotPart, snapshotParts } from "../src/core/sync/snapshot.ts";

const password = "a test Sync password";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Just enough of etude-cloud for these tests: sign-in, keys, paged events, blobs and the snapshot pointer. */
function cloud() {
  let keys: unknown = null;
  const events: { seq: number; id: string; ciphertext: string }[] = [];
  const blobs = new Map<string, Buffer>();
  let pointer: { v: 1; id: string; seq: number; parts: string[]; size: number } | null = null;
  let etag = 0;
  const c = {
    /** Requests seen, as "METHOD path?query". */
    log: [] as string[],
    /** Off: an older server, without the snapshot routes. */
    snapshots: true,
    /** Changes the pointer a device reads (the server lying), without changing the stored one. */
    serve: (p: NonNullable<typeof pointer>) => p,
    /** Drops the connection on these blob downloads, once each. */
    cut: new Set<string>(),
    /** Another device's snapshot lands between this device's read and its write. */
    raceOnce: false,
    get pointer() { return pointer; },
    blobs,
    events,
  };
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const x of req) chunks.push(x as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    c.log.push(`${req.method} ${p}${url.search}`);
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => (res.writeHead(status, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(data)));
    const err = (status: number, code: string) => send(status, { error: { code, message: code } });
    const body = raw.length && req.headers["content-type"]?.includes("json") ? JSON.parse(raw.toString()) : {};
    if (p === "/v1/server") return send(200, { sync: { withoutPassword: false } });
    if (p === "/v1/auth/email/start") return send(200, { ok: true });
    if (p === "/v1/auth/email/verify") return send(200, { token: "etd_" + randomBytes(8).toString("hex"), account: { id: "acc_1", email: "a@example.test" } });
    if (p === "/v1/vault") return send(200, { hasKeys: !!keys, mode: keys ? "password" : null, usedBytes: [...blobs.values()].reduce((n, b) => n + b.length, 0) });
    if (p === "/v1/vault/keys") {
      if (req.method === "GET") return keys ? send(200, keys, { etag: '"k"' }) : err(404, "no_keys");
      keys = body;
      return send(201, { ok: true, etag: '"k"' });
    }
    if (p === "/v1/vault/snapshot") {
      if (!c.snapshots) return err(404, "not_found");
      const current = () => `"s${etag}"`;
      if (req.method === "GET") return pointer ? send(200, c.serve(pointer), { etag: current() }) : err(404, "no_snapshot");
      if (c.raceOnce) {
        c.raceOnce = false;
        etag++;
      }
      if (pointer && req.headers["if-match"] !== current()) return err(412, "etag_mismatch");
      if (!pointer && req.headers["if-match"]) return err(412, "etag_mismatch");
      if (pointer && body.seq <= pointer.seq) return err(409, "not_newer");
      if (body.parts.some((h: string) => !blobs.has(h))) return err(422, "missing_part");
      const old = pointer?.parts ?? [];
      pointer = { v: 1, id: body.id, seq: body.seq, parts: body.parts, size: body.parts.reduce((n: number, h: string) => n + blobs.get(h)!.length, 0) };
      for (const h of old) if (!body.parts.includes(h)) blobs.delete(h);
      etag++;
      return send(200, { ok: true, etag: current() }, { etag: current() });
    }
    if (p === "/v1/sync/events" && req.method === "POST") {
      for (const e of body.events) if (!events.some((x) => x.id === e.id)) events.push({ seq: events.length + 1, id: e.id, ciphertext: e.ciphertext });
      return send(200, { accepted: body.events.length, duplicates: 0, lastSeq: events.length });
    }
    if (p === "/v1/sync/events") {
      const after = Number(url.searchParams.get("after") ?? 0), limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 50);
      const rest = events.filter((e) => e.seq > after), page = rest.slice(0, limit);
      return send(200, { events: page.map((e) => ({ ...e, at: new Date().toISOString() })), cursor: page.at(-1)?.seq ?? after, more: rest.length > page.length });
    }
    if (p.startsWith("/v1/blobs/")) {
      const name = p.slice("/v1/blobs/".length);
      if (req.method === "PUT") return blobs.set(name, raw), send(201, { ok: true, hash: name });
      if (req.method === "DELETE") {
        if (pointer?.parts.includes(name)) return err(409, "in_snapshot");
        return blobs.delete(name) ? send(200, { ok: true }) : err(404, "not_found");
      }
      if (c.cut.delete(name)) return req.socket.destroy();
      return blobs.has(name) ? (res.writeHead(200), res.end(blobs.get(name))) : err(404, "not_found");
    }
    return err(404, "not_found");
  });
  return Object.assign(c, {
    async start() {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  });
}

/** Runs fn with these environment variables, then puts them back. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-snapshot-"));
  const c = cloud();
  const open: Etude[] = [];
  let url = "";
  t.after(async () => {
    for (const e of open) e.close();
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    c,
    dir,
    async device(name: string) {
      url ||= await c.start();
      const e = await Etude.open(join(dir, `${name}.db`), { home: join(dir, name) });
      open.push(e);
      const s = syncFor(e);
      s.setup({ server: url });
      await s.signin("a@example.test");
      await s.verify("123456");
      await s.unlock({ password });
      const sync = () => s.now({ waitMedia: true });
      // The first sync pulls before it pushes, so a device's own events move its cursor on the next one.
      return { e, s, sync, twice: async () => (await sync(), sync()) };
    },
  };
}

/** A collection with history: items, reviews, a deleted item, a custom type with an asset, media, settings. */
function fill(e: Etude, n = 40) {
  for (let i = 0; i < n; i++) e.upsertItem({ id: `item-${i}`, deck: "Test", type: "basic", fields: { front: `front ${i}`, back: `back ${i}` }, tags: ["test"] });
  const cards = e.db.all("SELECT id FROM cards ORDER BY id LIMIT 12");
  cards.forEach((c, i) => e.rate(c.id, (1 + (i % 4)) as 1 | 2 | 3 | 4, { at: new Date(1800000000000 + i * 60000) }));
  e.deleteItems(["item-3"]);
  const def = e.type("basic");
  e.saveType({ ...def, id: "snap-basic", name: "Snapshot basic", assets: { "data.json": Buffer.from('{"asset":true}').toString("base64") } });
  e.upsertItem({ id: "custom", deck: "Other", type: "snap-basic", fields: { front: "custom", back: "back" } });
  e.storeMedia("pixel.png", Buffer.from("pixel bytes"));
  e.updateSettings({ dayStartHour: 5 });
}

function canonical(e: Etude) {
  const tables = ["presets", "decks", "types", "schedulers", "type_folders", "type_placement", "items", "cards", "attempts", "reviews", "tag_meta", "settings", "type_assets"];
  const out: any = {};
  for (const t of tables) out[t] = [...rows(e.db, t)].sort(([a], [b]) => a.localeCompare(b));
  out.state = e.db.all("SELECT item_id,face,state,due,stability,difficulty,reps,lapses,last_review,sched_state FROM cards ORDER BY item_id,face");
  out.items = e.db.all("SELECT id,fields FROM items ORDER BY id");
  return JSON.parse(JSON.stringify(out));
}
const registers = (e: Etude) => JSON.parse(JSON.stringify({
  registers: e.db.all("SELECT tbl,key,field,value,stamp FROM sync_registers ORDER BY tbl,key,field"),
  deleted: e.db.all("SELECT tbl,key,stamp FROM sync_deleted ORDER BY tbl,key"),
}));
const pulls = (log: string[]) => log.filter((l) => l.startsWith("GET /v1/sync/events")).map((l) => Number(new URL(l.split(" ")[1], "http://x").searchParams.get("after")));

test("a part opens only as the part it was written as: same snapshot, same seq, same place", async () => {
  const keys = await syncKeys(generateVaultKey());
  const ref = { id: "a".repeat(32), seq: 7 };
  const json = JSON.stringify({ v: 1, part: 1, last: true, registers: [["items", "x", "/front", '"hi"', "[1,0,\"d\"]"]], deleted: [] });
  const { hash, ciphertext } = await encryptSnapshotPart(keys, ref, 1, json);
  assert.equal(hash, sha(ciphertext));
  assert.ok(ciphertext.length < json.length + 64, "compressed");
  assert.equal(await decryptSnapshotPart(keys, ref, 1, ciphertext, hash), json);
  for (const [r, part] of [[ref, 0], [{ ...ref, seq: 8 }, 1], [{ ...ref, id: "b".repeat(32) }, 1]] as const) await assert.rejects(decryptSnapshotPart(keys, r, part, ciphertext), /decryption failed/);
  await assert.rejects(decryptSnapshotPart(keys, ref, 1, ciphertext, "0".repeat(64)), /hash mismatch/);
  await assert.rejects(decryptSnapshotPart(await syncKeys(generateVaultKey()), ref, 1, ciphertext), /decryption failed/);
});

test("parts merged into another collection give the same registers; a newer register there stays", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sync-snapshot-unit-"));
  const a = await Etude.open(join(dir, "a.db"), { home: join(dir, "a") }), b = await Etude.open(join(dir, "b.db"), { home: join(dir, "b") });
  t.after(() => (a.close(), b.close(), rmSync(dir, { recursive: true, force: true })));
  for (const e of [a, b]) syncFor(e).setup({ folder: join(dir, "folder") });
  fill(a, 25);
  const { drain } = await import("../src/core/sync/log.ts");
  drain(a.db);
  const parts = snapshotParts(a.db, 30);
  assert.ok(parts.length > 3, `${parts.length} parts`);
  assert.deepEqual(parts.map((p) => [JSON.parse(p).part, JSON.parse(p).last]), parts.map((_, i) => [i, i === parts.length - 1]));
  // b holds one register newer than a's, as if it had changed it later.
  const one = a.db.get("SELECT tbl,key,field,stamp FROM sync_registers WHERE tbl='items' AND field='/fields/front' LIMIT 1")!;
  const later = JSON.stringify([JSON.parse(one.stamp)[0] + 1, 0, "zz"]);
  b.db.run("INSERT INTO sync_registers VALUES(?,?,?,?,?)", one.tbl, one.key, one.field, '"changed later"', later);
  let merged = 0;
  b.db.tx(() => {
    for (const p of parts) merged += mergeSnapshotPart(b.db, p).registers;
    finishSnapshot(b.db);
  });
  assert.equal(merged, a.db.get("SELECT count(*) n FROM sync_registers")!.n);
  const expected = registers(a);
  const kept = expected.registers.findIndex((r: any) => r.tbl === one.tbl && r.key === one.key && r.field === one.field);
  expected.registers[kept] = { ...expected.registers[kept], value: '"changed later"', stamp: later };
  assert.deepEqual(registers(b), expected);
  // Merging the same parts again changes nothing.
  b.db.tx(() => parts.forEach((p) => mergeSnapshotPart(b.db, p)));
  assert.deepEqual(registers(b), expected);
  // The clock is past every merged stamp.
  const c = b.db.get("SELECT wall FROM sync_control")!;
  assert.ok(c.wall >= JSON.parse(later)[0]);
  assert.throws(() => b.db.tx(() => mergeSnapshotPart(b.db, JSON.stringify({ v: 1, part: 0, last: true, registers: [["future_table", "k", "/f", "1", later]], deleted: [] }))), /unsupported sync table/);
});

test("a new device starts from the snapshot, pulls only the events after it, and ends where replaying the whole log ends", async (t) => {
  const { c, device } = setup(t);
  const a = await device("a");
  fill(a.e);
  // A big enough log: the first device writes a snapshot in several parts.
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "1", ETUDE_SYNC_SNAPSHOT_PART: "40" }, a.twice);
  const first = c.pointer!;
  assert.ok(first, "a snapshot was made");
  assert.ok(first.parts.length > 3, `${first.parts.length} parts`);
  assert.equal(first.seq, c.events.length);
  // Events after the snapshot: the new device pulls these.
  a.e.upsertItem({ id: "item-1", deck: "Test", type: "basic", fields: { front: "edited after the snapshot", back: "b" } });
  a.e.deleteItems(["item-4"]);
  a.e.rate(a.e.db.get("SELECT id FROM cards ORDER BY id DESC LIMIT 1")!.id, 3, { at: new Date(1800001000000) });
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "1000000" }, a.sync);
  assert.equal(c.pointer!.id, first.id, "no new snapshot below the threshold");

  c.log.length = 0;
  const b = await device("b");
  await b.sync();
  assert.ok(c.log.includes("GET /v1/vault/snapshot"));
  for (const part of first.parts) assert.ok(c.log.includes(`GET /v1/blobs/${part}`), "every part downloaded");
  assert.equal(pulls(c.log)[0], first.seq, "events pulled from the snapshot's seq, not from the start");
  assert.equal(b.e.db.get("SELECT value FROM sync_meta WHERE key='snapshot_error'"), undefined);

  // A device that can't use snapshots replays the whole log.
  c.snapshots = false;
  c.log.length = 0;
  const full = await device("full");
  await full.sync();
  assert.equal(pulls(c.log)[0], 0);
  c.snapshots = true;

  assert.deepEqual(registers(b.e), registers(full.e));
  assert.deepEqual(registers(b.e), registers(a.e));
  assert.deepEqual(canonical(b.e), canonical(a.e));
  assert.deepEqual(canonical(full.e), canonical(a.e));
  assert.equal(b.e.item("item-1").fields.front, "edited after the snapshot");
  assert.equal(b.e.db.get("SELECT 1 FROM items WHERE id IN ('item-3','item-4')"), undefined);
  assert.equal(b.e.typeAsset("snap-basic", "data.json")!.size, 14);
  assert.ok(existsSync(join(b.e.mediaDir, a.e.storeMedia("pixel.png", Buffer.from("pixel bytes"), { dryRun: true }).file)));

  // The new device's own change wins over everything it merged, and reaches the others.
  b.e.upsertItem({ id: "item-1", deck: "Test", type: "basic", fields: { front: "from b", back: "b" } });
  await b.sync();
  await a.sync();
  await full.sync();
  assert.equal(a.e.item("item-1").fields.front, "from b");
  assert.deepEqual(canonical(a.e), canonical(b.e));
  assert.deepEqual(canonical(full.e), canonical(b.e));
});

test("a part out of order, from another snapshot or missing at the end: the device falls back to the whole log", async (t) => {
  const { c, device } = setup(t);
  const a = await device("a");
  fill(a.e, 30);
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "1", ETUDE_SYNC_SNAPSHOT_PART: "40" }, a.twice);
  const p = c.pointer!;
  const lies: [string, (x: typeof p) => typeof p][] = [
    ["swapped", (x) => ({ ...x, parts: [x.parts[1], x.parts[0], ...x.parts.slice(2)] })],
    ["claims a later seq", (x) => ({ ...x, seq: x.seq + 5 })],
    ["another id", (x) => ({ ...x, id: "f".repeat(32) })],
    ["last part dropped", (x) => ({ ...x, parts: x.parts.slice(0, -1) })],
  ];
  for (const [name, lie] of lies) {
    c.serve = lie;
    c.log.length = 0;
    const d = await device(`d-${name.replace(/\W/g, "-")}`);
    await d.sync();
    assert.ok(d.e.db.get("SELECT value FROM sync_meta WHERE key='snapshot_error'")?.value, `${name}: the error is kept`);
    assert.equal(pulls(c.log)[0], 0, `${name}: the whole log`);
    assert.deepEqual(canonical(d.e), canonical(a.e), name);
  }
});

test("a sync cut off in the middle of the snapshot goes on from the next part", async (t) => {
  const { c, device } = setup(t);
  const a = await device("a");
  fill(a.e, 30);
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "1", ETUDE_SYNC_SNAPSHOT_PART: "40" }, a.twice);
  const p = c.pointer!;
  c.cut.add(p.parts[2]);
  const b = await device("b");
  await assert.rejects(b.sync(), /fetch failed|network|socket|terminated/i);
  assert.deepEqual(JSON.parse(b.e.db.get("SELECT value FROM sync_meta WHERE key='snapshot_progress'")!.value), { id: p.id, done: 2 });
  c.log.length = 0;
  await b.sync();
  for (const part of p.parts.slice(0, 2)) assert.ok(!c.log.includes(`GET /v1/blobs/${part}`), "merged parts aren't downloaded again");
  assert.ok(c.log.includes(`GET /v1/blobs/${p.parts[2]}`));
  assert.equal(pulls(c.log)[0], p.seq);
  assert.deepEqual(canonical(b.e), canonical(a.e));
});

test("a newer snapshot replaces the old one; one that loses a race takes its parts away; an older server is left alone and asked again a day later", async (t) => {
  const { c, device } = setup(t);
  const a = await device("a");
  fill(a.e, 20);
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "1" }, a.twice);
  const first = c.pointer!;
  // Enough new events: the next snapshot replaces it and its parts go.
  for (let i = 0; i < 10; i++) a.e.upsertItem({ id: `more-${i}`, deck: "Test", type: "basic", fields: { front: "f", back: "b" } });
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.twice);
  assert.notEqual(c.pointer!.id, first.id);
  assert.ok(c.pointer!.seq > first.seq);
  for (const part of first.parts) assert.ok(!c.blobs.has(part));

  // Another device's snapshot lands first: this one's parts are removed and nothing else changes.
  for (let i = 0; i < 10; i++) a.e.upsertItem({ id: `race-${i}`, deck: "Test", type: "basic", fields: { front: "f", back: "b" } });
  const before = new Set(c.blobs.keys());
  c.raceOnce = true;
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.twice);
  assert.deepEqual(new Set(c.blobs.keys()), before, "its parts were taken away");
  assert.equal(a.e.db.get("SELECT value FROM sync_meta WHERE key='snapshot_uploads'")!.value, "[]");

  // A server without snapshots: no parts uploaded, and no new try until the log grows again.
  c.snapshots = false;
  for (let i = 0; i < 10; i++) a.e.upsertItem({ id: `old-${i}`, deck: "Test", type: "basic", fields: { front: "f", back: "b" } });
  const blobs = c.blobs.size;
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.twice);
  assert.equal(c.blobs.size, blobs);
  c.log.length = 0;
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.twice);
  assert.equal(c.log.filter((l) => l === "GET /v1/vault/snapshot").length, 0, "no new try without new events");
  // A new device on that server syncs from the whole log.
  const n = await device("n");
  await n.sync();
  assert.deepEqual(canonical(n.e), canonical(a.e));
  // A day later the server has snapshots: the desktop asks again and makes one, though the log barely grew.
  c.snapshots = true;
  const since = c.pointer!.seq;
  a.e.db.run("UPDATE sync_meta SET value=? WHERE key='snapshot_checked'", JSON.stringify(Date.now() - 25 * 3600_000));
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.twice);
  assert.ok(c.pointer!.seq > since, "a new snapshot");
  // An older app left only the event count behind (no check time): the next sync asks the server.
  for (let i = 0; i < 6; i++) a.e.upsertItem({ id: `later-${i}`, deck: "Test", type: "basic", fields: { front: "f", back: "b" } });
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.twice);
  const latest = c.pointer!.seq;
  a.e.db.run("DELETE FROM sync_meta WHERE key='snapshot_checked'");
  a.e.db.run("UPDATE sync_meta SET value=? WHERE key='snapshot'", JSON.stringify({ seq: c.events.length }));
  c.log.length = 0;
  await withEnv({ ETUDE_SYNC_SNAPSHOT_EVERY: "5" }, a.sync);
  assert.ok(c.log.includes("GET /v1/vault/snapshot"));
  assert.equal(JSON.parse(a.e.db.get("SELECT value FROM sync_meta WHERE key='snapshot'")!.value).seq, latest, "corrected from the server");
});
