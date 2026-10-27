// The Etude core in a Web Worker. Two ways in:
//  - { id, method, args }: calls a method on the open collection (the test harness uses this).
//  - { id, http: { method, url, headers, body } }: runs the request through the same Hono app the
//    desktop server uses and answers { status, headers, body }. A text/event-stream answer comes
//    back in pieces ({ id, chunk }) and ends with { id, end }.
import "./shims/globals.ts";
import { existsSync, flush, mkdirSync, mountOpfs, readFileSync, writeFileSync } from "./shims/vfs.ts";
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
    else if (typeof etude[method] === "function") value = await etude[method](...args);
    else throw new Error(`no such method: ${method}`);
    if (method !== "_flush") await flush();
    post({ id, ok: true, value });
  } catch (e) {
    post({ id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
};
