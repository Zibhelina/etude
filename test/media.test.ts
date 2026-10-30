import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Etude } from "../src/core/engine.ts";
import { MAX_MEDIA_BYTES } from "../src/core/media.ts";
import { createApp } from "../src/server/app.ts";
import { run } from "../src/cli/run.ts";
import { PasteRanges } from "../web/src/lib/paste-ranges.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lT8AAAAASUVORK5CYII=", "base64");

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "etude-media-test-"));
  const db = join(dir, "collection", "etude.db");
  const e = await Etude.open(db, { home: dir });
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  const original = join(dir, "a picture with spaces.png");
  writeFileSync(original, PNG);
  return { e, dir, db, original };
}

test("media imports are independent copies in the collection's own folder", async (t) => {
  const { e, original, dir } = await setup(t);
  const r = e.importMedia(pathToFileURL(original).href);
  assert.equal(e.mediaDir, join(dir, "collection", "media"));
  assert.ok(r.path.startsWith(join(e.mediaDir, "files") + sep));
  assert.match(r.url, /^\/media\/files\/[a-f0-9]{64}\.png$/);
  assert.equal(r.kind, "image");
  assert.equal(r.mime, "image/png");
  assert.equal(r.name, "a picture with spaces.png");
  assert.equal(r.created, true);
  assert.equal(r.bytes, PNG.length);
  assert.deepEqual(readFileSync(original), PNG);
  rmSync(original);
  assert.deepEqual(readFileSync(r.path), PNG);
  const response = await createApp(e, { webDist: null }).request(r.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("content-security-policy")!, /sandbox/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
});

test("media storage deduplicates content and never overwrites a different file", async (t) => {
  const { e, original } = await setup(t);
  const first = e.importMedia(original);
  const same = e.storeMedia("another name.PNG", PNG);
  assert.equal(same.url, first.url);
  assert.equal(same.created, false);
  const different = e.storeMedia("another name.png", Buffer.concat([PNG, Buffer.from("different")]));
  assert.notEqual(different.url, first.url);
  assert.deepEqual(readFileSync(first.path), PNG);
  assert.equal(readdirSync(join(e.mediaDir, "files")).length, 2);
  const jpeg = e.storeMedia("photo.jpeg", Buffer.from("jpeg bytes"));
  assert.equal(e.storeMedia("photo.jpg", Buffer.from("jpeg bytes")).url, jpeg.url);
});

test("media dry runs, invalid files and directories do not write anything", async (t) => {
  const { e, dir, original } = await setup(t);
  const r = e.importMedia(original, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(existsSync(e.mediaDir), false);
  assert.throws(() => e.storeMedia("script.html", PNG), /unsupported media/);
  assert.throws(() => e.storeMedia("empty.png", Buffer.alloc(0)), /empty/);
  assert.throws(() => e.importMedia(join(dir, "missing.png")), /not found/);
  // On Windows that is a network share (\\another-computer\picture.png), so the read fails instead.
  assert.throws(() => e.importMedia("file://another-computer/picture.png"), process.platform === "win32" ? /couldn't read media file/ : /invalid local file URL/);
  const folder = join(dir, "folder.png");
  mkdirSync(folder);
  assert.throws(() => e.importMedia(folder), /point to a file/);
  const large = join(dir, "large.mp4");
  writeFileSync(large, ""); truncateSync(large, MAX_MEDIA_BYTES + 1);
  assert.throws(() => e.importMedia(large), /100 MiB/);
  assert.equal(existsSync(e.mediaDir), false);
});

test("media uploads and local imports return usable URLs and retain API protections", async (t) => {
  const { e, original } = await setup(t);
  const app = createApp(e, { webDist: null });
  const uploaded = await app.request("/api/media?name=clipboard.png", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: PNG });
  assert.equal(uploaded.status, 200);
  const info = await uploaded.json() as any;
  assert.deepEqual(readFileSync(info.path), PNG);
  const imported = await app.request("/api/media/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: original }) });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json() as any).url, info.url);
  for (const [name, mime, kind] of [["voice.mp3", "audio/mpeg", "audio"], ["movie.webm", "video/webm", "video"]]) {
    const media = e.storeMedia(name, Buffer.from(name));
    const response = await app.request(media.url);
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(media.kind, kind);
  }
  assert.equal((await app.request("/api/media?name=x.png", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 415);
  assert.equal((await app.request("/api/media?name=x.png", { method: "POST", headers: { "content-type": "application/octet-stream", origin: "https://other.example", host: "localhost" }, body: PNG })).status, 403);
  assert.equal((await createApp(e, { token: "secret", webDist: null }).request("/api/media?name=x.png", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: PNG })).status, 401);
  assert.equal((await app.request("/media/..%2F..%2Fetude.db")).status, 404);
});

test("oversized media streams are canceled before writing a file", async (t) => {
  const { e } = await setup(t);
  let canceled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); }, cancel() { canceled = true; } });
  const response = await createApp(e, { webDist: null }).request("/api/media?name=large.mp4", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: stream, duplex: "half" } as RequestInit);
  assert.equal(response.status, 413);
  assert.equal(canceled, true);
  assert.equal(existsSync(e.mediaDir), false);
});

test("media add and media path expose media storage through the CLI", async (t) => {
  const { e, dir, db, original } = await setup(t);
  const cli = async (...args: string[]) => {
    let stdout = "", stderr = "";
    const code = await run(["--db", db, "media", ...args], { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, stdin: () => "", isTTY: false, env: { ETUDE_HOME: dir } });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  assert.deepEqual(await cli("path"), { path: e.mediaDir });
  assert.equal((await cli("add", original, "--dry-run")).dryRun, true);
  assert.equal(existsSync(e.mediaDir), false);
  const r = await cli("add", original);
  assert.deepEqual(readFileSync(r.path), PNG);
  assert.equal(existsSync(original), true);
  assert.equal((await cli("add", original)).created, false);
});

test("pending media paste positions track typing and preserve concurrent edits", () => {
  const ranges = new PasteRanges("before after");
  const first = ranges.add(7, 7);
  ranges.update("before typed after");
  assert.deepEqual(ranges.finish(first, "IMAGE"), { from: 7, to: 7, insert: "IMAGE" });
  const selected = ranges.add(7, 12);
  ranges.update("before changed after");
  const result = ranges.finish(selected, "IMAGE")!;
  assert.equal(result.from, result.to, "changed selection must not be overwritten");
  const canceled = ranges.add(0, 0);
  ranges.cancel();
  assert.equal(ranges.finish(canceled, "IMAGE"), null);
});
