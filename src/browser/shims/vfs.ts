/**
 * A synchronous file system with node:fs's shape, for the core in a browser.
 * Files under a mounted prefix are mirrored to OPFS (the browser's private disk). Opening lists them
 * without reading them: a file is read from disk when it's asked for (FileReaderSync, so reads stay
 * synchronous in the worker), and a file written here stays in memory and goes back to disk shortly after.
 * Everything else (the app's own files, temp dirs) lives only in memory.
 */
import { Buffer } from "buffer";

/** Workers only (the core runs in one): a Blob's bytes, synchronously. */
declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } };

/** Files in memory: written here, or not mounted. */
const files = new Map<string, Uint8Array>();
/** Files on disk that weren't read into memory: their size and time, and how to read them. */
type OnDisk = { size: number; mtime: number; read(): Uint8Array };
const onDisk = new Map<string, OnDisk>();
/**
 * Files on disk whose size and time are still on their way: opening a folder mounted with `later` doesn't wait
 * for them (tens of thousands of media files take seconds). Reading one before it's ready throws ENOTREADY and
 * notes the path, so the caller can `ready` it and ask again.
 */
const pending = new Map<string, { h: FileSystemFileHandle; file: (h: FileSystemFileHandle) => Promise<OnDisk> }>();
const missed = new Set<string>();
const isFile = (p: string) => files.has(p) || onDisk.has(p) || pending.has(p);
function notReady(p: string) {
  missed.add(p);
  return err("ENOTREADY", "open", p);
}
/** A file's bytes, from memory or read from disk now (not kept: a collection's media can be most of a gigabyte). */
const contents = (p: string): Uint8Array | undefined => {
  if (pending.has(p)) throw notReady(p);
  return files.get(p) ?? onDisk.get(p)?.read();
};

/** Paths a read wanted before they were ready, since the last call. */
export function takeMissed(): string[] {
  const out = [...missed];
  missed.clear();
  return out;
}
/** Makes these files ready now (each one's size and time), ahead of the rest. */
export async function ready(paths: Iterable<string>) {
  await Promise.all([...paths].map(norm).map(async (p) => {
    const w = pending.get(p);
    if (!w) return;
    const entry = await w.file(w.h);
    // Written or removed meanwhile: that wins.
    if (pending.get(p) === w) (pending.delete(p), onDisk.set(p, entry));
  }));
}
let everything: Promise<void> = Promise.resolve();
/** Resolves once every file is ready. */
export const allReady = () => everything;
const dirs = new Set<string>(["/"]);
const mounts: { prefix: string; root: FileSystemDirectoryHandle }[] = [];
const dirty = new Set<string>();
const removed = new Set<string>();
/** Modification times, as on disk: a file's when it is written, a folder's when an entry is added, removed or renamed in it. Anything older dates from when this page loaded. */
const times = new Map<string, number>();
const loaded = Date.now();
let clock = 0;
/** Strictly increasing, so two changes in the same millisecond still differ. */
const now = () => (clock = Math.max(clock + 0.001, Date.now()));
const changed = (...paths: string[]) => {
  const t = now();
  for (const p of paths) times.set(p, t);
};
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
    changed(p, parent(p));
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

/** Every file under `prefix`, with its path relative to it (for backups). */
export function filesUnder(prefix: string): [string, Uint8Array][] {
  const root = norm(prefix) + "/";
  return [...new Set([...files.keys(), ...onDisk.keys(), ...pending.keys()])].filter((p) => p.startsWith(root)).sort().map((p) => [p.slice(root.length), contents(p)!]);
}

/** Puts a file in memory without marking it for OPFS (the app's bundled files). */
export function preload(path: string, data: string | Uint8Array) {
  const p = norm(path);
  ensureDir(parent(p));
  files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
}

/** A file on disk, read synchronously when asked for. `getFile()` doesn't read the bytes, only its size and time. */
async function onDiskFile(h: FileSystemFileHandle): Promise<OnDisk> {
  const file = await h.getFile();
  return { size: file.size, mtime: file.lastModified, read: () => new Uint8Array(new FileReaderSync().readAsArrayBuffer(file)) };
}

async function walk(dir: FileSystemDirectoryHandle, at: string, found: [string, FileSystemFileHandle][]) {
  ensureDir(at);
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const p = at + "/" + name;
    if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, p, found);
    else if (!name.endsWith(".crswap")) found.push([p, h as FileSystemFileHandle]);
  }
}

/**
 * Mirrors `prefix` to the OPFS directory of the same name (or `root`), listing what is already there. `file`
 * makes the entry for a file found on disk (tests stand in for OPFS and FileReaderSync).
 */
export async function mountOpfs(prefix: string, opts: { root?: FileSystemDirectoryHandle; file?: (h: FileSystemFileHandle) => Promise<OnDisk>; later?: (path: string) => boolean } = {}) {
  prefix = norm(prefix);
  const file = opts.file ?? onDiskFile;
  let root = opts.root;
  if (!root) {
    root = await navigator.storage.getDirectory();
    for (const part of prefix.split("/").filter(Boolean)) root = await root.getDirectoryHandle(part, { create: true });
  }
  mounts.push({ prefix, root });
  const found: [string, FileSystemFileHandle][] = [];
  await walk(root, prefix, found);
  // Sizes and times take one round trip per file, a few dozen at a time. Files under `later` get theirs after opening.
  const now: [string, FileSystemFileHandle][] = [];
  for (const [p, h] of found) if (opts.later?.(p)) pending.set(p, { h, file });
  else now.push([p, h]);
  for (let i = 0; i < now.length; i += 64) {
    const batch = now.slice(i, i + 64);
    const entries = await Promise.all(batch.map(([, h]) => file(h)));
    batch.forEach(([p], k) => onDisk.set(p, entries[k]));
  }
  const rest = [...pending.keys()];
  everything = everything.then(async () => {
    for (let i = 0; i < rest.length; i += 64) await ready(rest.slice(i, i + 64));
  });
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
  return isFile(p) || dirs.has(p);
}

/** There are no symlinks here, so the real path is the normalized one. */
export function realpathSync(path: string) {
  const p = norm(path);
  if (!isFile(p) && !dirs.has(p)) throw err("ENOENT", "realpath", p);
  return p;
}

export function mkdirSync(path: string, _opts?: unknown) {
  ensureDir(path);
}

export function readFileSync(path: string | number, opts?: unknown): any {
  const p = typeof path === "number" ? fds.get(path)!.path : norm(path);
  const data = contents(p);
  if (!data) throw err(dirs.has(p) ? "EISDIR" : "ENOENT", "open", p);
  const enc = typeof opts === "string" ? opts : (opts as { encoding?: string } | undefined)?.encoding;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return enc ? buf.toString(enc as BufferEncoding) : buf;
}

export function writeFileSync(path: string, data: unknown, opts?: unknown) {
  const p = norm(path);
  pending.delete(p);
  const flag = typeof opts === "object" && opts ? (opts as { flag?: string }).flag : undefined;
  if (flag === "wx" && isFile(p)) throw err("EEXIST", "open", p);
  if (!dirs.has(parent(p))) throw err("ENOENT", "open", p);
  const added = !isFile(p);
  files.set(p, bytes(data).slice());
  onDisk.delete(p);
  if (added) changed(p, parent(p));
  else changed(p);
  touch(p);
}

export function renameSync(from: string, to: string) {
  const a = norm(from);
  const b = norm(to);
  const data = contents(a);
  if (!data) throw err("ENOENT", "rename", a);
  files.delete(a);
  onDisk.delete(a);
  files.set(b, data);
  onDisk.delete(b);
  pending.delete(b);
  times.set(b, times.get(a) ?? loaded);
  times.delete(a);
  changed(parent(a), parent(b));
  touch(a, true);
  touch(b);
}

export function rmSync(path: string, opts: { recursive?: boolean; force?: boolean } = {}) {
  const p = norm(path);
  if (files.delete(p) || onDisk.delete(p) || pending.delete(p)) {
    times.delete(p);
    changed(parent(p));
    return touch(p, true);
  }
  if (dirs.has(p)) {
    if (!opts.recursive) throw err("EISDIR", "rm", p);
    for (const f of [...files.keys()]) if (f.startsWith(p + "/")) files.delete(f);
    for (const f of [...onDisk.keys()]) if (f.startsWith(p + "/")) onDisk.delete(f);
    for (const f of [...pending.keys()]) if (f.startsWith(p + "/")) pending.delete(f);
    for (const d of [...dirs]) if (d === p || d.startsWith(p + "/")) dirs.delete(d);
    for (const t of [...times.keys()]) if (t === p || t.startsWith(p + "/")) times.delete(t);
    changed(parent(p));
    return touch(p, true);
  }
  if (!opts.force) throw err("ENOENT", "rm", p);
}
export const unlinkSync = (p: string) => rmSync(p);

export function statSync(path: string) {
  const p = norm(path);
  if (pending.has(p)) throw notReady(p);
  const f = files.get(p), d = onDisk.get(p);
  if (!f && !d && !dirs.has(p)) throw err("ENOENT", "stat", p);
  // A file on disk keeps its own time across page loads, so its hash stays known to sync.
  const mtimeMs = times.get(p) ?? d?.mtime ?? loaded;
  const file = !!(f || d);
  return { isFile: () => file, isDirectory: () => !file, size: f ? f.length : d ? d.size : 0, mtimeMs, mtime: new Date(mtimeMs) };
}

/** `recursive` lists subfolders too, with paths relative to `path` (and each entry's `parentPath`, as Node gives). */
export function readdirSync(path: string, opts?: { withFileTypes?: boolean; recursive?: boolean }) {
  const p = norm(path);
  if (!dirs.has(p)) throw err("ENOENT", "scandir", p);
  const pre = p === "/" ? "/" : p + "/";
  const names = new Map<string, boolean>();
  const take = (f: string, dir: boolean) => {
    if (!f.startsWith(pre) || f === p) return;
    const rel = f.slice(pre.length);
    if (opts?.recursive || !rel.includes("/")) names.set(rel, dir);
  };
  for (const f of files.keys()) take(f, false);
  for (const f of onDisk.keys()) take(f, false);
  for (const f of pending.keys()) take(f, false);
  for (const d of dirs) take(d, true);
  const sorted = [...names.keys()].sort();
  if (!opts?.withFileTypes) return sorted;
  return sorted.map((rel) => {
    const cut = rel.lastIndexOf("/");
    const name = rel.slice(cut + 1), parentPath = cut < 0 ? p : `${pre}${rel.slice(0, cut)}`;
    return { name, parentPath, path: parentPath, isDirectory: () => names.get(rel)!, isFile: () => !names.get(rel)!, isSymbolicLink: () => false };
  });
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

export default { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, unlinkSync, statSync, readdirSync, copyFileSync, mkdtempSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, readSync };
