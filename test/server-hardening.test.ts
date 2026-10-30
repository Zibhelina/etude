import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, zstdCompressSync } from "node:zlib";
import { Etude } from "../src/core/engine.ts";
import { createApp, hostAllowed } from "../src/server/app.ts";
import { openPackage, ANKI_LIMITS } from "../src/core/anki/package.ts";

async function collection() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-hard-"));
  return Etude.open(join(dir, "etude.db"), { home: dir });
}

test("hostAllowed: loopback and tailnet names pass, anything else is refused", () => {
  for (const h of ["localhost:4610", "127.0.0.1:4610", "127.0.0.1", "[::1]:4610", "LOCALHOST", "app.localhost:4610", "athanor.taila36162.ts.net:10006", "athanor.taila36162.ts.net"])
    assert.ok(hostAllowed(h), h);
  for (const h of ["evil.example:4610", "evil.example", "127.0.0.1.evil.example", "localhost.evil.example:4610", "ts.net.evil.example", "10.0.0.5:4610", "0.0.0.0:4610", "[::ffff:7f00:1]:4610"])
    assert.ok(!hostAllowed(h), h);
  assert.ok(hostAllowed("etude.lan:4610", new Set(["etude.lan"])));
});

test("DNS rebinding: a foreign Host header gets 421 on API and pages; allowed names and tokens still work", async () => {
  const e = await collection();
  try {
    const app = createApp(e);
    const evil = { host: "evil.example:4610", origin: "http://evil.example:4610", "content-type": "application/json" };
    // The audit's repro: Origin equal to Host used to pass and create a deck.
    const post = await app.request("/api/decks", { method: "POST", headers: evil, body: JSON.stringify({ name: "Pwned" }) });
    assert.equal(post.status, 421);
    assert.ok(!e.db.get("SELECT 1 AS x FROM decks WHERE name = 'Pwned'"));
    assert.equal((await app.request("/api/export", { headers: { host: "evil.example:4610" } })).status, 421);
    assert.equal((await app.request("/api/settings", { headers: { host: "evil.example" } })).status, 421);
    assert.equal((await app.request("/", { headers: { host: "evil.example" } })).status, 421);

    assert.equal((await app.request("/api/settings", { headers: { host: "127.0.0.1:4610" } })).status, 200);
    assert.equal((await app.request("/api/settings", { headers: { host: "localhost:4610" } })).status, 200);
    assert.equal((await app.request("/api/settings", { headers: { host: "athanor.taila36162.ts.net:10006" } })).status, 200);

    const lan = createApp(e, { allowHosts: ["etude.lan"] });
    assert.equal((await lan.request("/api/settings", { headers: { host: "etude.lan:4610" } })).status, 200);
    assert.equal((await lan.request("/api/settings", { headers: { host: "evil.example" } })).status, 421);

    // With a token the bearer check is the gate, so any name (a LAN IP, a phone) works.
    const tok = createApp(e, { token: "s3cret" });
    assert.equal((await tok.request("/api/settings", { headers: { host: "192.168.1.9:4610", authorization: "Bearer s3cret" } })).status, 200);
    assert.equal((await tok.request("/api/settings", { headers: { host: "192.168.1.9:4610" } })).status, 401);

    // Listening on localhost only (the desktop app's engine), a foreign name is refused even with the token.
    const local = createApp(e, { token: "s3cret", localOnly: true });
    assert.equal((await local.request("/api/settings", { headers: { host: "127.0.0.1:4610", authorization: "Bearer s3cret" } })).status, 200);
    assert.equal((await local.request("/api/settings", { headers: { host: "127.0.0.1:4610" } })).status, 401);
    assert.equal((await local.request("/media/x.png", { headers: { host: "evil.example:4610" } })).status, 421);
    assert.equal((await local.request("/api/settings", { headers: { host: "athanor.taila36162.ts.net", authorization: "Bearer s3cret" } })).status, 200);
  } finally {
    e.close();
  }
});

/** A minimal zip with one deflated or stored entry per name. */
function zip(entries: Record<string, { data: Buffer; method?: 0 | 8 }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, { data, method = 8 }] of Object.entries(entries)) {
    const comp = method === 8 ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(Math.min(data.length, 0xffffffff), 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(Math.min(data.length, 0xffffffff), 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const sqliteHeader = () => Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(84)]);

test("Anki zip bomb: oversized collection and media are refused with a clear error, small ones still open", () => {
  const saved = { ...ANKI_LIMITS };
  try {
    ANKI_LIMITS.collection = 4 * 1024 ** 2;
    ANKI_LIMITS.media = 1024 ** 2;
    ANKI_LIMITS.total = 2 * 1024 ** 2;
    // 64 MiB of zeros deflates to ~64 KB: a collection that unpacks far past the cap.
    const bomb = zip({ "collection.anki21": { data: Buffer.concat([sqliteHeader(), Buffer.alloc(64 * 1024 ** 2)]) } });
    assert.ok(bomb.length < 200_000);
    assert.throws(() => openPackage(bomb), /unpacks to more than 4 MiB/);

    // The same through zstd (new format).
    const zbomb = zip({ "collection.anki21b": { data: zstdCompressSync(Buffer.concat([sqliteHeader(), Buffer.alloc(64 * 1024 ** 2)])), method: 0 } });
    assert.throws(() => openPackage(zbomb), /unpacks to more than 4 MiB/);

    // A media file over the per-file cap fails when it's loaded.
    const media = zip({
      "collection.anki21": { data: sqliteHeader() },
      media: { data: Buffer.from(JSON.stringify({ "0": "big.png", "1": "a.png", "2": "b.png", "3": "c.png" })) },
      "0": { data: Buffer.alloc(8 * 1024 ** 2) },
      "1": { data: Buffer.alloc(900 * 1024) },
      "2": { data: Buffer.alloc(900 * 1024) },
      "3": { data: Buffer.alloc(900 * 1024) },
    });
    const pkg = openPackage(media);
    assert.throws(() => pkg.media.get("big.png")!(), /unpacks to more than 1 MiB/);
    // Under the per-file cap, but together over the total.
    pkg.media.get("a.png")!();
    pkg.media.get("b.png")!();
    assert.throws(() => pkg.media.get("c.png")!(), /media unpacks to more than/);

    // A normal small package still opens.
    const ok = openPackage(zip({ "collection.anki21": { data: sqliteHeader() } }));
    assert.equal(ok.format, "legacy");
  } finally {
    Object.assign(ANKI_LIMITS, saved);
  }
});

test("Anki upload: a body declared over the cap is refused before it's read", async () => {
  const e = await collection();
  try {
    const app = createApp(e);
    const res = await app.request("/api/anki/import", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(3 * 1024 ** 3), host: "127.0.0.1:4610" },
      body: new Uint8Array(4),
    });
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as any).error, /2 GiB/);
  } finally {
    e.close();
  }
});
