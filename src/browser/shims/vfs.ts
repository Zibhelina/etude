/**
 * A synchronous in-memory file system with node:fs's shape, for the core in a browser.
 * Files under a mounted prefix are mirrored to OPFS (the browser's private disk): loaded once at
 * boot, written back shortly after they change. Everything else (the app's own files, temp dirs)
 * lives only in memory.
 */
import { Buffer } from "buffer";

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>(["/"]);
const mounts: { prefix: string; root: FileSystemDirectoryHandle }[] = [];
const dirty = new Set<string>();
const removed = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> = Promise.resolve();

export const norm = (p: string) => {
  const out: string[] = [];
  for (const part of String(p).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
};
const parent = (p: string) => norm(p).replace(/\/[^/]*$/, "") || "/";

function err(code: string, syscall: string, path: string): Error {
  const e = new Error(`${code}: ${syscall} '${path}'`) as Error & { code: string; syscall: string; path: string };
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

function ensureDir(p: string) {
  p = norm(p);
  while (!dirs.has(p)) {
    dirs.add(p);
    p = parent(p);
  }
}

function mountOf(p: string) {
  return mounts.find((m) => p === m.prefix || p.startsWith(m.prefix + "/"));
}
function touch(p: string, gone = false) {
  if (!mountOf(p)) return;
  (gone ? removed : dirty).add(p);
  (gone ? dirty : removed).delete(p);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), 150);
}

/** Puts a file in memory without marking it for OPFS (the app's bundled files). */
export function preload(path: string, data: string | Uint8Array) {
  const p = norm(path);
  ensureDir(parent(p));
  files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
}

async function walk(dir: FileSystemDirectoryHandle, at: string) {
  ensureDir(at);
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const p = at + "/" + name;
    if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, p);
    else if (!name.endsWith(".crswap")) files.set(p, new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer()));
  }
}

/** Mirrors `prefix` to the OPFS directory of the same name, loading what is already there. */
export async function mountOpfs(prefix: string) {
  prefix = norm(prefix);
  let root = await navigator.storage.getDirectory();
  for (const part of prefix.split("/").filter(Boolean)) root = await root.getDirectoryHandle(part, { create: true });
  mounts.push({ prefix, root });
  await walk(root, prefix);
}

async function handleFor(p: string, create: boolean): Promise<[FileSystemDirectoryHandle, string] | null> {
  const m = mountOf(p);
  if (!m) return null;
  const parts = p.slice(m.prefix.length).split("/").filter(Boolean);
  const name = parts.pop()!;
  let d = m.root;
  try {
    for (const part of parts) d = await d.getDirectoryHandle(part, { create });
  } catch {
    return null;
  }
  return [d, name];
}

/** Writes changed files to OPFS now. Resolves when they are on disk. */
export function flush(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const write = [...dirty];
  const gone = [...removed];
  dirty.clear();
  removed.clear();
  flushing = flushing.then(async () => {
    for (const p of gone) {
      const h = await handleFor(p, false);
      if (h) await h[0].removeEntry(h[1], { recursive: true }).catch(() => {});
    }
    for (const p of write) {
      const data = files.get(p);
      if (!data) continue;
      const h = await handleFor(p, true);
      if (!h) continue;
      const fh = await h[0].getFileHandle(h[1], { create: true });
      const w = await (fh as any).createWritable();
      await w.write(data);
      await w.close();
    }
  });
  return flushing;
}

const bytes = (data: unknown): Uint8Array =>
  typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength) : new Uint8Array(data as ArrayBuffer);

export function existsSync(path: string) {
  const p = norm(path);
  return files.has(p) || dirs.has(p);
}

export function mkdirSync(path: string, _opts?: unknown) {
  ensureDir(path);
}

export function readFileSync(path: string | number, opts?: unknown): any {
  const p = typeof path === "number" ? fds.get(path)!.path : norm(path);
  const data = files.get(p);
  if (!data) throw err(dirs.has(p) ? "EISDIR" : "ENOENT", "open", p);
  const enc = typeof opts === "string" ? opts : (opts as { encoding?: string } | undefined)?.encoding;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return enc ? buf.toString(enc as BufferEncoding) : buf;
}

export function writeFileSync(path: string, data: unknown, opts?: unknown) {
  const p = norm(path);
  const flag = typeof opts === "object" && opts ? (opts as { flag?: string }).flag : undefined;
  if (flag === "wx" && files.has(p)) throw err("EEXIST", "open", p);
  if (!dirs.has(parent(p))) throw err("ENOENT", "open", p);
  files.set(p, bytes(data).slice());
  touch(p);
}

export function renameSync(from: string, to: string) {
  const a = norm(from);
  const b = norm(to);
  const data = files.get(a);
  if (!data) throw err("ENOENT", "rename", a);
  files.delete(a);
  files.set(b, data);
  touch(a, true);
  touch(b);
}

export function rmSync(path: string, opts: { recursive?: boolean; force?: boolean } = {}) {
  const p = norm(path);
  if (files.delete(p)) return touch(p, true);
  if (dirs.has(p)) {
    if (!opts.recursive) throw err("EISDIR", "rm", p);
    for (const f of [...files.keys()]) if (f.startsWith(p + "/")) files.delete(f);
    for (const d of [...dirs]) if (d === p || d.startsWith(p + "/")) dirs.delete(d);
    return touch(p, true);
  }
  if (!opts.force) throw err("ENOENT", "rm", p);
}
export const unlinkSync = (p: string) => rmSync(p);

export function statSync(path: string) {
  const p = norm(path);
  const f = files.get(p);
  if (!f && !dirs.has(p)) throw err("ENOENT", "stat", p);
  return { isFile: () => !!f, isDirectory: () => !f, size: f ? f.length : 0, mtimeMs: Date.now(), mtime: new Date() };
}

export function readdirSync(path: string, opts?: { withFileTypes?: boolean }) {
  const p = norm(path);
  if (!dirs.has(p)) throw err("ENOENT", "scandir", p);
  const pre = p === "/" ? "/" : p + "/";
  const names = new Map<string, boolean>();
  for (const f of files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) names.set(f.slice(pre.length), false);
  for (const d of dirs) if (d.startsWith(pre) && d !== p && !d.slice(pre.length).includes("/")) names.set(d.slice(pre.length), true);
  const sorted = [...names.keys()].sort();
  if (!opts?.withFileTypes) return sorted;
  return sorted.map((name) => ({ name, isDirectory: () => names.get(name)!, isFile: () => !names.get(name)! }));
}

export function copyFileSync(from: string, to: string) {
  writeFileSync(to, readFileSync(from));
}

let tmpCount = 0;
export function mkdtempSync(prefix: string) {
  const p = `${prefix}${Date.now().toString(36)}${(tmpCount++).toString(36)}`;
  ensureDir(p);
  return norm(p);
}

export const chmodSync = () => {};

const fds = new Map<number, { path: string; chunks: Uint8Array[] }>();
let nextFd = 3;
export function openSync(path: string, _flags?: unknown) {
  const fd = nextFd++;
  fds.set(fd, { path: norm(path), chunks: [] });
  return fd;
}
export function writeSync(fd: number, data: unknown) {
  const b = bytes(data);
  fds.get(fd)!.chunks.push(b);
  return b.length;
}
export const fsyncSync = () => {};
/** Reading stdin (the CLI's interactive prompts): there is none in a browser. */
export const readSync = () => 0;
export function closeSync(fd: number) {
  const f = fds.get(fd);
  fds.delete(fd);
  if (!f || !f.chunks.length) return;
  const all = new Uint8Array(f.chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of f.chunks) {
    all.set(c, o);
    o += c.length;
  }
  writeFileSync(f.path, all);
}

export default { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, unlinkSync, statSync, readdirSync, copyFileSync, mkdtempSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, readSync };
