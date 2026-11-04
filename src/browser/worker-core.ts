// The Etude core in a Web Worker, loaded by worker.ts (the worker's entry). Two ways in:
//  - { id, method, args }: calls a method on the open collection (the test harness uses this).
//  - { id, http: { method, url, headers, body } }: runs the request through the same Hono app the
//    desktop server uses and answers { status, headers, body }. A text/event-stream answer comes
//    back in pieces ({ id, chunk }) and ends with { id, end }.
import "./shims/globals.ts";
import { existsSync, filesUnder, flush, mkdirSync, mountOpfs, readFileSync, rmSync, writeFileSync } from "./shims/vfs.ts";
import { zipSync, type Zippable } from "fflate";
import { Buffer } from "buffer";
import { localFrame } from "./frame-local.ts";
import { readBackup } from "./backup-zip.ts";
import { keyNameProblem } from "../core/env-names.ts";

const DATA = "/etude/data";
let etude: any = null;
let app: { fetch(req: Request): Response | Promise<Response> } | null = null;

// Bytes lose their Buffer prototype crossing postMessage; the core reads them with Buffer methods.
const revive = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
const post = (msg: unknown, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);

// API keys (OPENROUTER_API_KEY=…): the desktop reads ~/.etude/.env; here the same file lives in the
// app's private storage and is written from Settings → AI grading.
// Only API-key names, as on the desktop: never ETUDE_* or anything else the core reads as configuration.
const ENV_FILE = `${DATA}/home/.env`;

function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const line of String(readFileSync(ENV_FILE, "utf8")).split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !keyNameProblem(m[1])) process.env[m[1]] = m[2];
  }
}

function setEnv(name: string, value: string | null) {
  const problem = keyNameProblem(name);
  if (problem) throw new Error(problem);
  if (value != null && /[\r\n\0]/.test(value)) throw new Error("a key can't contain line breaks");
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
  const files = readBackup(bytes);
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

const counts = ((self as any).__etudeEvals ??= { entry: 0, core: 0 });
counts.core++;
const ready = boot();

// ------------------------------------------------- native host (phone apps)
// The main thread answers these with the EtudeAuth plugin (native-chatgpt.ts).
const nat = {
  nid: 0,
  waits: new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(),
  // The page's first message says whether it brought a native host; every later message waits for it.
  ready: Promise.resolve(),
};
function nativeCall<T = unknown>(op: string, args: unknown = {}): Promise<T> {
  const n = ++nat.nid;
  return new Promise<T>((resolve, reject) => {
    nat.waits.set(n, { resolve, reject });
    post({ native: { nid: n, op, args } });
  });
}

/** "cancelled: …" from the plugin becomes a ChatGptError with that code. */
function nativeFailure(ChatGptError: any, e: unknown) {
  const m = /^([a-z_]+): (.*)$/s.exec((e as Error).message ?? String(e));
  return m ? new ChatGptError(m[2] || m[1], m[1]) : e;
}

const CREDENTIAL_FILES = ["chatgpt.json", "chatgpt-host-id"];

async function installNativeHost() {
  const { setChatGptNativeHost, ChatGptError } = await import("../core/chatgpt.ts");
  const cache = new Map<string, string | null>();
  for (const name of CREDENTIAL_FILES) cache.set(name, await nativeCall<string | null>("store.get", { name }));
  // Writes reach the Keychain in order; the core reads the copy here right away.
  let writes = Promise.resolve();
  const wrap = <T>(p: Promise<T>) => p.catch((e) => Promise.reject(nativeFailure(ChatGptError, e)));
  setChatGptNativeHost({
    http: (req) => wrap(nativeCall("http", req)),
    store: {
      read: (name) => cache.get(name) ?? null,
      write: (name, text) => {
        cache.set(name, text);
        writes = writes.then(() => nativeCall<void>("store.set", { name, value: text })).catch((e) => console.warn("Keychain write failed:", e));
      },
    },
    login: {
      listen: (port) => wrap(nativeCall("login.listen", { port })),
      next: () => wrap(nativeCall("login.next")),
      open: (url) => wrap(nativeCall("login.open", { url })),
      finish: () => wrap(nativeCall("login.finish")),
    },
  });
}


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

async function handle(ev: MessageEvent) {
  if (ev.data?.nativeReply) {
    const w = nat.waits.get(ev.data.nativeReply);
    nat.waits.delete(ev.data.nativeReply);
    if (ev.data.ok) w?.resolve(ev.data.value);
    else w?.reject(new Error(ev.data.error));
    return;
  }
  if (ev.data?.hello) {
    if (ev.data.hello.native) nat.ready = installNativeHost().catch((e) => console.warn("native host:", e));
    // Before any request is answered, so the app's first look at /api/telemetry sees it running.
    telemetryStarted = startWorkerTelemetry(ev.data.hello);
    return;
  }
  const { id, method } = ev.data ?? {};
  // How many times the entry and this module ran in this worker (once each; see worker.ts).
  if (method === "_evals") return post({ id, ok: true, value: { ...counts } });
  try {
    const info = await ready;
    await nat.ready;
    await telemetryStarted;
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
}

// ------------------------------------------------- telemetry
// Anonymous error reports and usage counts from the browser and phone apps (Settings → Privacy, src/core/telemetry.ts).
// The page says where it runs; a dev build or an automated browser sends nothing.
let telemetryStarted: Promise<void> = Promise.resolve();
async function startWorkerTelemetry(hello: { platform?: string; automated?: boolean }) {
  if (import.meta.env.DEV) return;
  try {
    await ready;
    const { startTelemetry, osFromUserAgent } = await import("../core/telemetry.ts");
    const platform = hello.platform === "ios" || hello.platform === "android" ? hello.platform : "web";
    startTelemetry(etude, { platform, os: osFromUserAgent(navigator.userAgent), automated: !!hello.automated });
  } catch (e) {
    console.warn("telemetry:", e);
  }
}
const reportWorker = (kind: string, err: unknown) => {
  if (!etude) return;
  void import("../core/telemetry.ts").then(({ telemetryFor }) => {
    const e = err as { name?: string; message?: string; stack?: string } | undefined;
    telemetryFor(etude).report({ kind, message: e?.message ? `${e.name ?? "Error"}: ${e.message}` : String(err), stack: e?.stack ?? "" });
  });
};
self.addEventListener("error", (ev) => reportWorker("worker.error", (ev as ErrorEvent).error ?? (ev as ErrorEvent).message));
self.addEventListener("unhandledrejection", (ev) => reportWorker("worker.rejection", (ev as PromiseRejectionEvent).reason));

/** Called once by worker.ts with the messages that came in while this module loaded, in order. */
export function start(queued: MessageEvent[]) {
  self.onmessage = handle;
  for (const ev of queued) void handle(ev);
}
