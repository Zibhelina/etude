// The Etude core in a Web Worker. Two ways in:
//  - { id, method, args }: calls a method on the open collection (the test harness uses this).
//  - { id, http: { method, url, headers, body } }: runs the request through the same Hono app the
//    desktop server uses and answers { status, headers, body }. A text/event-stream answer comes
//    back in pieces ({ id, chunk }) and ends with { id, end }.
import "./shims/globals.ts";
import { existsSync, filesUnder, flush, mkdirSync, mountOpfs, readFileSync, rmSync, writeFileSync } from "./shims/vfs.ts";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { Buffer } from "buffer";
import { localFrame } from "./frame-local.ts";

const DATA = "/etude/data";
let etude: any = null;
let app: { fetch(req: Request): Response | Promise<Response> } | null = null;

// Bytes lose their Buffer prototype crossing postMessage; the core reads them with Buffer methods.
const revive = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
const post = (msg: unknown, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);

// API keys (OPENROUTER_API_KEY=…): the desktop reads ~/.etude/.env; here the same file lives in the
// app's private storage and is written from Settings → AI grading.
const ENV_FILE = `${DATA}/home/.env`;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const line of String(readFileSync(ENV_FILE, "utf8")).split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) process.env[m[1]] = m[2];
  }
}

function setEnv(name: string, value: string | null) {
  if (!ENV_NAME.test(name)) throw new Error(`"${name}" isn't a variable name`);
  if (value != null && /[\r\n]/.test(value)) throw new Error("a key can't contain line breaks");
  const lines = existsSync(ENV_FILE) ? String(readFileSync(ENV_FILE, "utf8")).split("\n").filter((l) => l.trim() && !l.startsWith(`${name}=`)) : [];
  if (value) lines.push(`${name}=${value.trim()}`);
  mkdirSync(`${DATA}/home`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
  if (value) process.env[name] = value.trim();
  else delete process.env[name];
  return { name, set: !!value };
}

// A backup of the whole collection, for the browser edition where there's no file to copy: one zip
// with the SQLite database (cards, history, settings) and the media folder. API keys stay out.
const SQLITE_MAGIC = "SQLite format 3\u0000";

function backup(): Uint8Array {
  const zip: Zippable = {
    "etude-backup.json": new TextEncoder().encode(JSON.stringify({ etudeBackup: 1, created: new Date().toISOString() }) + "\n"),
    "etude.db": etude.db.sql.serialize(),
  };
  for (const [rel, data] of filesUnder(etude.mediaDir)) zip[`media/${rel}`] = [data, { level: 0 }];
  return zipSync(zip, { level: 6 });
}

/** Replaces the collection with a backup. The page reloads afterwards. Sync starts over: set it up again. */
async function restore(bytes: Uint8Array): Promise<{ media: number }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("that file isn't an Etude backup (not a zip)");
  }
  const image = files["etude.db"];
  if (!image || new TextDecoder().decode(image.subarray(0, 16)) !== SQLITE_MAGIC) throw new Error("that file isn't an Etude backup (no etude.db inside)");
  // Check it opens as a collection, and drop its sync state: this device would otherwise reuse the
  // identity of the one the backup came from.
  const { createWasmConnection, importOpfsImage } = await import("../core/sql-wasm.ts");
  const probe = await createWasmConnection({ bytes: image });
  let clean: Uint8Array;
  try {
    const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    if (!tables.includes("items") || !tables.includes("cards")) throw new Error("that backup has no Etude collection in it");
    for (const t of tables) if (t.startsWith("sync_")) probe.exec(`DELETE FROM "${t}"`);
    clean = probe.serialize!();
  } finally {
    probe.close();
  }
  const dbPath = `${DATA}/etude.db`;
  const mediaDir = etude.mediaDir as string;
  etude.close();
  etude = null;
  app = null;
  await importOpfsImage(dbPath, clean);
  rmSync(mediaDir, { recursive: true, force: true });
  mkdirSync(mediaDir);
  let media = 0;
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith("media/") || name.endsWith("/")) continue;
    const rel = name.slice("media/".length);
    if (rel.split("/").some((p) => p === ".." || p === "")) continue;
    const at = `${mediaDir}/${rel}`;
    mkdirSync(at.replace(/\/[^/]*$/, ""));
    writeFileSync(at, data);
    media++;
  }
  await flush();
  return { media };
}

async function boot() {
  const t0 = performance.now();
  await mountOpfs(DATA); // media, answers, agent files: mirrored to OPFS
  loadEnv();
  const { Etude } = await import("../core/engine.ts");
  etude = await Etude.open(`${DATA}/etude.db`, { home: `${DATA}/home` });
  const { createApp } = await import("../server/app.ts");
  app = createApp(etude);
  return { ms: Math.round(performance.now() - t0) };
}

const ready = boot();

async function http(id: number, r: { method: string; url: string; headers: Record<string, string>; body: ArrayBuffer | null }) {
  const res = await app!.fetch(new Request(r.url, { method: r.method, headers: r.headers, body: r.body && r.method !== "GET" && r.method !== "HEAD" ? r.body : undefined }));
  const headers = Object.fromEntries(res.headers.entries());
  if ((headers["content-type"] ?? "").includes("text/event-stream") && res.body) {
    post({ id, ok: true, value: { status: res.status, headers, stream: true } });
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      post({ id, chunk: value });
    }
    await flush();
    post({ id, end: true });
    return;
  }
  let body = await res.arrayBuffer();
  // Card frames: make them self-contained (see frame-local.ts).
  const path = new URL(r.url).pathname;
  if (res.ok && r.method === "GET" && path.startsWith("/frame/")) {
    body = new TextEncoder().encode(localFrame(new TextDecoder().decode(body))).buffer as ArrayBuffer;
    delete headers["content-length"];
  } else if (res.ok && r.method === "POST" && path === "/api/frame") {
    const j = JSON.parse(new TextDecoder().decode(body));
    j.html = localFrame(j.html);
    body = new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer;
    delete headers["content-length"];
  }
  await flush();
  post({ id, ok: true, value: { status: res.status, headers, body } }, [body]);
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, method } = ev.data ?? {};
  try {
    const info = await ready;
    if (ev.data?.http) return await http(id, ev.data.http);
    const args: unknown[] = (ev.data?.args ?? []).map(revive);
    let value: unknown;
    if (method === "_boot") value = info;
    else if (method === "_flush") value = await flush();
    else if (method === "_setEnv") value = setEnv(String(args[0]), args[1] == null ? null : String(args[1]));
    else if (method === "_media") value = existsSync(`${etude.mediaDir}/${args[0]}`);
    else if (method === "_sql") value = etude.db.all(args[0] as string, ...(args.slice(1) as any[]));
    else if (method === "_backup") {
      const zip = backup();
      post({ id, ok: true, value: zip }, [zip.buffer as ArrayBuffer]);
      return;
    } else if (method === "_restore") value = await restore(new Uint8Array(args[0] as ArrayBuffer));
    else if (typeof etude[method] === "function") value = await etude[method](...args);
    else throw new Error(`no such method: ${method}`);
    if (method !== "_flush") await flush();
    post({ id, ok: true, value });
  } catch (e) {
    post({ id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
};
