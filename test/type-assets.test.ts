import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Etude } from "../src/core/engine.ts";
import { MAX_ASSET_BYTES, hashBytes, validateAssets } from "../src/core/assets.ts";
import { buildIndex, buildSubmission, checkEntry, entryJson, entryPath, installFile, MAX_ENTRY_BYTES } from "../src/core/market.ts";
import { createApp } from "../src/server/app.ts";
import { cardFrame } from "../src/server/frame.ts";
import { run } from "../src/cli/run.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const BUILTIN = fileURLToPath(new URL("../types", import.meta.url));
const tmp = (t: TestContext) => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "etude-assets-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

// Every byte value, so a lossy text round trip would show.
const BIN = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + (i >> 8)) & 255));
const JSON_ASSET = Buffer.from(JSON.stringify({ hello: "world" }));

const meshType = (assets?: Record<string, string>) => ({
  id: "mesh",
  name: "Mesh",
  fields: [{ name: "prompt", kind: "markdown" as const, required: true }],
  template: { html: "<div id=out></div>", js: "const r = await fetch(etude.asset('hello.json')); etude.$('#out').textContent = (await r.json()).hello;" },
  grader: { kind: "self" as const },
  ...(assets ? { assets } : {}),
});
const b64 = (b: Buffer) => b.toString("base64");

async function open(t: TestContext) {
  const e = await Etude.open(":memory:");
  t.after(() => e.close());
  return e;
}

function cli(home: string) {
  return async (args: string[], stdin = "") => {
    let out = "", err = "";
    const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: () => stdin, isTTY: false, env: { ETUDE_HOME: home } });
    let json: any = null;
    try {
      json = JSON.parse(out);
    } catch {}
    return { code, out, err, json };
  };
}

test("assets: validation of names, encoding and sizes", () => {
  assert.deepEqual(validateAssets(undefined), []);
  assert.deepEqual(validateAssets({ "mesh.bin": b64(BIN), "a_b-c.json": "" }), []);
  assert.match(validateAssets({ "../x": "AAAA" })[0], /asset name/);
  assert.match(validateAssets({ "a/b": "AAAA" })[0], /asset name/);
  assert.match(validateAssets({ x: "not base64!" })[0], /base64/);
  assert.match(validateAssets([])[0], /object/);
  assert.match(validateAssets({ big: "A".repeat(Math.ceil((MAX_ASSET_BYTES + 3) / 3) * 4) })[0], /at most 20 MiB/);
  const nine = "A".repeat(Math.ceil((9 * 1024 * 1024) / 3) * 4);
  const errs = validateAssets({ a: nine, b: nine, c: nine, d: nine, e: nine });
  assert.ok(errs.some((x) => /at most 40 MiB together/.test(x)));
  assert.equal(MAX_ENTRY_BYTES, 32 * 1024 * 1024);
});

test("assets: saving replaces the set, omitting assets keeps them, delete removes them", async (t) => {
  const e = await open(t);
  const r = e.saveTypeReport(meshType({ "hello.json": b64(JSON_ASSET), "mesh.bin": b64(BIN) }));
  assert.equal(r.result, "created");
  assert.deepEqual(r.assets, { files: 2, bytes: JSON_ASSET.length + BIN.length, created: 2, updated: 0, unchanged: 0, removed: 0 });
  assert.deepEqual(e.typeAssets("mesh"), [
    { name: "hello.json", size: JSON_ASSET.length, hash: hashBytes(JSON_ASSET) },
    { name: "mesh.bin", size: BIN.length, hash: hashBytes(BIN) },
  ]);
  assert.deepEqual(Buffer.from(e.typeAsset("mesh", "mesh.bin")!.bytes), BIN);
  // Not in the stored definition.
  assert.equal("assets" in e.type("mesh"), false);

  // A save without `assets` (the web editor) keeps them, even when the definition changes.
  const r2 = e.saveTypeReport({ ...meshType(), name: "Mesh 2" });
  assert.equal(r2.result, "updated");
  assert.equal(r2.assets, null);
  assert.equal(e.typeAssets("mesh").length, 2);

  // Identical assets: unchanged.
  const same = e.saveTypeReport({ ...meshType({ "hello.json": b64(JSON_ASSET), "mesh.bin": b64(BIN) }), name: "Mesh 2" });
  assert.equal(same.result, "unchanged");
  assert.equal(same.assets!.unchanged, 2);

  // Only the assets change: the type counts as updated and its version moves (frames reload).
  const before = e.type("mesh").updated;
  await new Promise((r) => setTimeout(r, 5));
  const r3 = e.saveTypeReport({ ...meshType({ "hello.json": b64(Buffer.from('{"hello":"again"}')) }), name: "Mesh 2" });
  assert.equal(r3.result, "updated");
  assert.deepEqual(r3.assets, { files: 1, bytes: 17, created: 0, updated: 1, unchanged: 0, removed: 1 });
  assert.notEqual(e.type("mesh").updated, before);
  assert.deepEqual(e.typeAssets("mesh").map((a) => a.name), ["hello.json"]);

  // An empty object removes them all.
  e.saveType({ ...meshType({}), name: "Mesh 2" });
  assert.deepEqual(e.typeAssets("mesh"), []);

  e.saveType(meshType({ "hello.json": b64(JSON_ASSET) }));
  e.deleteType("mesh");
  assert.equal(e.db.get("SELECT COUNT(*) AS n FROM type_assets")!.n, 0);

  assert.throws(() => e.saveType(meshType({ "bad name": "AAAA" })), /asset name/);
});

test("assets: list and type routes show names and sizes, never the bytes", async (t) => {
  const e = await open(t);
  e.saveType(meshType({ "hello.json": b64(JSON_ASSET), "mesh.bin": b64(BIN) }));
  const app = createApp(e, { webDist: null });
  const list: any = await (await app.request("/api/types")).json();
  assert.deepEqual(list.find((x: any) => x.id === "mesh").assetFiles, [{ name: "hello.json", size: JSON_ASSET.length }, { name: "mesh.bin", size: BIN.length }]);
  assert.deepEqual(list.find((x: any) => x.id === "basic").assetFiles, []);
  const one: any = await (await app.request("/api/types/mesh")).json();
  assert.equal(one.assets, undefined);
  assert.deepEqual(one.assetFiles.map((a: any) => a.name), ["hello.json", "mesh.bin"]);
  // The web editor saves what it loaded (with assetFiles, without assets): the files stay.
  const put = await app.request("/api/types/mesh", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...one, name: "Edited" }) });
  assert.equal(put.status, 200);
  assert.equal(e.type("mesh").name, "Edited");
  assert.equal(e.typeAssets("mesh").length, 2);
  // A PUT with assets replaces them.
  await app.request("/api/types/mesh", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...meshType({ "hello.json": b64(JSON_ASSET) }) }) });
  assert.deepEqual(e.typeAssets("mesh").map((a) => a.name), ["hello.json"]);
});

test("assets: served with CORS, nosniff, sandbox CSP, MIME by extension and a hash-keyed cache", async (t) => {
  const e = await open(t);
  e.saveType(meshType({ "hello.json": b64(JSON_ASSET), "mesh.bin": b64(BIN), "pic.png": b64(Buffer.from("png")) }));
  const app = createApp(e, { webDist: null });
  const h = hashBytes(BIN);
  const res = await app.request(`/type-assets/mesh/mesh.bin?h=${h}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), BIN);

  const stale = await app.request(`/type-assets/mesh/mesh.bin?h=deadbeef`);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("cache-control"), "no-cache");
  const bare = await app.request(`/type-assets/mesh/mesh.bin`);
  assert.equal(bare.headers.get("cache-control"), "no-cache");

  assert.equal((await app.request(`/type-assets/mesh/hello.json`)).headers.get("content-type"), "application/json");
  assert.equal((await app.request(`/type-assets/mesh/pic.png`)).headers.get("content-type"), "image/png");

  const etag = res.headers.get("etag")!;
  assert.equal((await app.request(`/type-assets/mesh/mesh.bin?h=${h}`, { headers: { "if-none-match": etag } })).status, 304);

  for (const url of ["/type-assets/mesh/nope.bin", "/type-assets/nope/mesh.bin", "/type-assets/mesh/..%2Fx"]) {
    const r = await app.request(url);
    assert.equal(r.status, 404, url);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  }
});

test("assets: the card frame hands the runtime each asset's hash", async (t) => {
  const e = await open(t);
  e.saveType(meshType({ "hello.json": b64(JSON_ASSET) }));
  const app = createApp(e, { webDist: null });
  const html = await (await app.request("/frame/mesh")).text();
  assert.ok(html.includes(`{"type":"mesh","files":{"hello.json":"${hashBytes(JSON_ASSET)}"}}`));
  // Unsaved previews of a stored type reach its stored assets.
  const preview: any = await (await app.request("/api/frame", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ def: meshType() }) })).json();
  assert.ok(preview.html.includes(hashBytes(JSON_ASSET)));
  assert.ok(cardFrame(meshType() as any, "http://x/").includes(`{"type":"mesh","files":{}}`));
  const runtime = readFileSync(new URL("../runtime/runtime.js", import.meta.url), "utf8");
  assert.match(runtime, /asset\(name\)/);
  assert.match(runtime, /unknown asset/);
});

test("assets: directory export and import round-trip binary files", async (t) => {
  const home = tmp(t);
  const sh = cli(home);
  const db = join(home, "etude.db");
  const src = join(home, "mesh");
  mkdirSync(join(src, "assets"), { recursive: true });
  const { assets: _a, template, grader, ...meta } = meshType();
  writeFileSync(join(src, "type.json"), JSON.stringify({ ...meta, grader }));
  writeFileSync(join(src, "template.html"), template.html);
  writeFileSync(join(src, "card.js"), template.js);
  writeFileSync(join(src, "assets", "mesh.bin"), BIN);
  writeFileSync(join(src, "assets", "hello.json"), JSON_ASSET);

  const imp = await sh(["--db", db, "type", "import", src]);
  assert.equal(imp.code, 0, imp.err);
  assert.equal(imp.json.result, "created");
  assert.deepEqual(imp.json.assets, { files: 2, bytes: BIN.length + JSON_ASSET.length, created: 2, updated: 0, unchanged: 0, removed: 0 });
  const again = await sh(["--db", db, "type", "import", src]);
  assert.equal(again.json.result, "unchanged");

  const show = await sh(["--db", db, "type", "show", "mesh"]);
  assert.deepEqual(show.json.assetFiles, [
    { name: "hello.json", size: JSON_ASSET.length, hash: hashBytes(JSON_ASSET) },
    { name: "mesh.bin", size: BIN.length, hash: hashBytes(BIN) },
  ]);
  assert.ok(!show.out.includes(b64(BIN).slice(0, 40)), "type show must not print base64");

  const out = join(home, "out");
  const exp = await sh(["--db", db, "type", "export", "mesh", "-o", out]);
  assert.equal(exp.code, 0, exp.err);
  assert.ok(exp.json.files.includes("assets/mesh.bin"));
  assert.deepEqual(readFileSync(join(out, "assets", "mesh.bin")), BIN);
  assert.deepEqual(readFileSync(join(out, "assets", "hello.json")), JSON_ASSET);
  assert.equal("assets" in JSON.parse(readFileSync(join(out, "type.json"), "utf8")), false);

  const js = await sh(["--db", db, "type", "export", "mesh", "--json"]);
  assert.equal(js.json.assets["mesh.bin"], b64(BIN));

  // Re-import of the exported directory is a no-op; dropping a file from assets/ removes it.
  assert.equal((await sh(["--db", db, "type", "import", out])).json.result, "unchanged");
  rmSync(join(out, "assets", "hello.json"));
  const less = await sh(["--db", db, "type", "import", out]);
  assert.equal(less.json.assets.removed, 1);
  // A directory with no assets/ folder keeps what's stored.
  rmSync(join(out, "assets"), { recursive: true });
  const none = await sh(["--db", db, "type", "import", out]);
  assert.equal(none.json.assets, null);
  assert.equal((await sh(["--db", db, "type", "show", "mesh"])).json.assetFiles.length, 1);

  // type copy brings the assets along.
  await sh(["--db", db, "type", "copy", "mesh", "mesh-two"]);
  assert.equal((await sh(["--db", db, "type", "show", "mesh-two"])).json.assetFiles.length, 1);
});

test("assets: packs carry them; re-importing identical assets reports unchanged; dry run writes nothing", async (t) => {
  const a = await open(t);
  a.saveType(meshType({ "hello.json": b64(JSON_ASSET), "mesh.bin": b64(BIN) }));
  a.upsertItem({ id: "m.1", type: "mesh", deck: "Anatomy", fields: { prompt: "Where?" } });
  const pack = JSON.parse(JSON.stringify(a.exportPack({ deck: "Anatomy" })));
  assert.equal(pack.types[0].assets["mesh.bin"], b64(BIN));

  const b = await open(t);
  const dry = b.importPack(pack, { dryRun: true });
  assert.deepEqual(dry.assets, { files: 2, bytes: BIN.length + JSON_ASSET.length, created: 2, updated: 0, unchanged: 0, removed: 0 });
  assert.equal(b.db.get("SELECT COUNT(*) AS n FROM type_assets")!.n, 0);

  const first = b.importPack(pack);
  assert.deepEqual(first.types, { created: 1, updated: 0, unchanged: 0 });
  assert.equal(first.assets.created, 2);
  assert.deepEqual(Buffer.from(b.typeAsset("mesh", "mesh.bin")!.bytes), BIN);

  const second = b.importPack(pack);
  assert.deepEqual(second.types, { created: 0, updated: 0, unchanged: 1 });
  assert.deepEqual(second.assets, { files: 2, bytes: BIN.length + JSON_ASSET.length, created: 0, updated: 0, unchanged: 2, removed: 0 });
  assert.deepEqual(second.items, { created: 0, updated: 0, unchanged: 1 });

  // Through the HTTP API, with a body well over the old 8 MB limit.
  const big = Buffer.alloc(15 * 1024 * 1024, 7);
  const bigPack = { ...pack, types: [{ ...pack.types[0], assets: { ...pack.types[0].assets, "big.bin": b64(big) } }] };
  const app = createApp(b, { webDist: null });
  const res = await app.request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bigPack) });
  assert.equal(res.status, 200, await res.clone().text());
  const rep: any = await res.json();
  assert.equal(rep.assets.created, 1);
  assert.equal(rep.assets.unchanged, 2);
  assert.equal(b.typeAsset("mesh", "big.bin")!.size, big.length);
});

test("assets: built-in types load assets from types/<id>/assets and reset restores them", async (t) => {
  const dir = tmp(t);
  const root = join(dir, "types");
  cpSync(BUILTIN, root, { recursive: true });
  mkdirSync(join(root, "basic", "assets"));
  writeFileSync(join(root, "basic", "assets", "hello.json"), JSON_ASSET);
  const e = await Etude.open(join(dir, "etude.db"), { builtinTypesDir: root, home: dir });
  assert.deepEqual(e.typeAssets("basic").map((a) => a.name), ["hello.json"]);
  assert.equal("assets" in e.type("basic"), false);
  // Edit the built-in, dropping its assets; reset brings them back.
  e.saveType({ ...e.typeWithAssets("basic"), assets: {} });
  assert.deepEqual(e.typeAssets("basic"), []);
  e.resetType("basic");
  assert.deepEqual(e.typeAssets("basic").map((a) => a.name), ["hello.json"]);
  // A shipped asset that changes updates on the next open.
  e.close();
  writeFileSync(join(root, "basic", "assets", "hello.json"), "{}");
  const e2 = await Etude.open(join(dir, "etude.db"), { builtinTypesDir: root, home: dir });
  try {
    assert.equal(e2.typeAssets("basic")[0].hash, hashBytes(Buffer.from("{}")));
  } finally {
    // Before the folder's cleanup hook: Windows can't delete an open database.
    e2.close();
  }
});

test("assets: market publish, check, index and install handle them", async (t) => {
  const e = await open(t);
  e.saveType(meshType({ "hello.json": b64(JSON_ASSET), "mesh.bin": b64(BIN) }));
  e.upsertItem({ id: "m.1", type: "mesh", deck: "Anatomy", fields: { prompt: "Where?" } });
  const typeEntry = buildSubmission(e, { kind: "type", ref: "mesh", author: "ana" });
  assert.equal(typeEntry.content.types[0].assets["mesh.bin"], b64(BIN));
  const deckEntry = buildSubmission(e, { kind: "deck", ref: "Anatomy", author: "ana" });
  assert.equal(deckEntry.content.types[0].assets["hello.json"], b64(JSON_ASSET));
  assert.deepEqual(checkEntry(typeEntry), []);
  const bad = JSON.parse(JSON.stringify(typeEntry));
  bad.content.types[0].assets = { "../evil": "AAAA" };
  assert.ok(checkEntry(bad).some((x) => /asset name/.test(x)));

  // `etude market check` in a fresh process.
  const dir = tmp(t);
  const file = join(dir, "mesh.json");
  writeFileSync(file, entryJson(typeEntry));
  const ok = spawnSync(process.execPath, [MAIN, "market", "check", file], { encoding: "utf8", env: { ...process.env, ETUDE_HOME: dir } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  const badFile = join(dir, "bad.json");
  writeFileSync(badFile, entryJson(bad));
  const no = spawnSync(process.execPath, [MAIN, "market", "check", badFile], { encoding: "utf8", env: { ...process.env, ETUDE_HOME: dir } });
  assert.equal(no.status, 4);

  // The index dry-run imports it and summarizes the assets.
  const root = join(dir, "market");
  for (const f of [typeEntry, deckEntry]) {
    mkdirSync(join(root, "entries", `${f.kind}s`), { recursive: true });
    writeFileSync(join(root, entryPath(f.kind, f.id)), entryJson(f));
  }
  const { index, problems } = await buildIndex(root, { dryRunInto: () => Etude.open(":memory:") });
  assert.deepEqual(problems, []);
  const t1 = index.entries.find((x) => x.kind === "type")!;
  assert.deepEqual((t1.summary as any).types[0].assets, { files: 2, bytes: BIN.length + JSON_ASSET.length });
  const idx = spawnSync(process.execPath, [MAIN, "market", "index", root, "--check"], { encoding: "utf8", env: { ...process.env, ETUDE_HOME: dir } });
  assert.equal(idx.status, 0, idx.stderr + idx.stdout);

  // Install into a clean collection, then again: unchanged.
  const fresh = await open(t);
  const inst = installFile(fresh, typeEntry);
  assert.equal(inst.result, "created");
  assert.equal(inst.report.assets.created, 2);
  assert.deepEqual(Buffer.from(fresh.typeAsset("mesh", "mesh.bin")!.bytes), BIN);
  const again = installFile(fresh, typeEntry);
  assert.equal(again.result, "unchanged");
  assert.equal(again.report.assets.unchanged, 2);
  assert.ok(!existsSync(join(dir, "nothing")));
});
