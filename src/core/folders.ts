// Folders on this computer, open in the Notebook. A folder is read where it is: nothing is copied into the
// collection, and a file changed here is the file on disk. Desktop and `etude serve` only (a browser has no disk).
// Entries look like notes to the app, with ids that say where they are: "fs:<folder id>/<path inside it>".
// A file keeps the format it has. Markdown and text are edited as text; an .html file is a web file, shown live;
// a .etude file is one of Etude's own kinds kept as a file (PAGE_EXT below): a page, a canvas or a kanban board.
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Db } from "./db.ts";
import { EtudeError } from "./engine.ts";
import { checkDoc, checkScene, docText, emptyScene, normalizeLook, type CanvasScene, type DocNode, type Note, type NoteLook, type NoteSummary } from "./notes.ts";
import { boardText, checkBoard, emptyBoard, type KanbanBoard } from "./kanban.ts";
import { isTextFile } from "./text-files.ts";

export const FS_PREFIX = "fs:";
export const isFsId = (id: unknown): id is string => typeof id === "string" && id.startsWith(FS_PREFIX);
export const fsId = (folder: string, rel = ""): string => (rel ? `${FS_PREFIX}${folder}/${rel}` : `${FS_PREFIX}${folder}`);
export function parseFsId(id: string): { folder: string; rel: string } {
  const s = id.slice(FS_PREFIX.length);
  const i = s.indexOf("/");
  return i < 0 ? { folder: s, rel: "" } : { folder: s.slice(0, i), rel: s.slice(i + 1) };
}

/** A folder on this computer that the Notebook shows. */
export interface LocalFolder {
  id: string;
  /** What the Notebook calls it (the folder's own name unless changed). */
  name: string;
  path: string;
  /** Where removed files go, inside the folder (".trash" unless changed). */
  trash: string;
  /** Show names that start with a dot. */
  hidden: boolean;
  created: string;
  /** The path isn't a folder right now (a drive not plugged in, or it was moved). */
  missing: boolean;
  /** It was opened on another computer (a backup restored here): shown, never read. */
  elsewhere: boolean;
}

export type LocalType = "dir" | "markdown" | "etude" | "web" | "text" | "pdf" | "image" | "audio" | "video" | "other";

/**
 * One of Etude's own kinds as a file: its name is the title, and inside is JSON that says which kind it is and
 * holds its body (a page's document tree, a canvas's drawing, a board's columns and cards).
 */
export const PAGE_EXT = ".etude";
const PAGE = /\.etude$/i;
/** The file's format number, so a later Etude can still read what this one wrote. */
const PAGE_FORMAT = 1;
/** Extensions a title leaves out, and a new name keeps. */
const TITLED = /\.(md|markdown|etude)$/i;
export type NativeKind = "page" | "canvas" | "kanban";
const NATIVE: NativeKind[] = ["page", "canvas", "kanban"];
export interface PageFile {
  /** The title the user gave the page (its name on disk is apart; null when none was given). */
  title?: string | null;
  icon: string | null;
  look: NoteLook;
  doc: DocNode;
}
export interface NativeFile {
  kind: NativeKind;
  /** The title the user gave it. Its name on disk is apart, and the app only suggests that name as a title. */
  title?: string | null;
  icon: string | null;
  look: NoteLook;
  /** A page's. */
  doc?: DocNode;
  /** A canvas's. */
  scene?: CanvasScene;
  /** A kanban board's. */
  board?: KanbanBoard;
}
/** What goes in the file: readable, the kind said first, the same bytes for the same note. */
export function nativeToText(f: NativeFile): string {
  const body = f.kind === "canvas" ? { scene: f.scene ?? emptyScene() } : f.kind === "kanban" ? { board: f.board ?? emptyBoard() } : { doc: f.doc ?? { type: "doc", content: [] } };
  return `${JSON.stringify({ etude: PAGE_FORMAT, kind: f.kind, ...(f.title ? { title: f.title } : {}), ...(f.icon ? { icon: f.icon } : {}), ...(Object.keys(f.look).length ? { look: f.look } : {}), ...body }, null, 1)}\n`;
}
/** Reads a .etude file. Throws when it isn't one this Etude can read. */
export function nativeFromText(text: string): NativeFile {
  let v: any;
  try {
    v = JSON.parse(text.trim() || `{"etude":${PAGE_FORMAT},"kind":"page","doc":{"type":"doc","content":[]}}`);
  } catch {
    throw new EtudeError("this isn't an Etude page: its file isn't JSON");
  }
  if (!v || typeof v !== "object" || typeof v.etude !== "number") throw new EtudeError("this isn't an Etude page: its file doesn't say so");
  if (v.etude > PAGE_FORMAT) throw new EtudeError("this page was written by a newer Etude: update Etude to open it");
  const kind: NativeKind = v.kind === undefined ? "page" : v.kind;
  if (!NATIVE.includes(kind)) throw new EtudeError(`this Etude can't open a "${String(v.kind).slice(0, 20)}" kept as a file yet`);
  const head = { kind, title: cleanTitle(v.title), icon: typeof v.icon === "string" && v.icon ? v.icon : null, look: normalizeLook(v.look ?? {}) };
  if (kind === "canvas") return { ...head, scene: checkScene(v.scene ?? emptyScene()) };
  if (kind === "kanban") return { ...head, board: checkBoard(v.board ?? emptyBoard(), checkDoc) };
  return { ...head, doc: checkDoc(v.doc ?? { type: "doc", content: [] }) };
}
export const pageToText = (p: PageFile): string => nativeToText({ kind: "page", ...p });
/** Reads a page's file. Throws when it isn't a page this Etude can read. */
export function pageFromText(text: string): PageFile {
  const f = nativeFromText(text);
  if (f.kind !== "page") throw new EtudeError(`this is a ${f.kind === "kanban" ? "kanban board" : f.kind}, not a page`);
  return { title: f.title ?? null, icon: f.icon, look: f.look, doc: f.doc! };
}
/** A page's own title: one line, at most 500 characters, null when there's none. */
export function cleanTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  return t || null;
}
/** Which kind a .etude file says it is, from its first bytes (the kind is written first), without reading it whole. */
function peekKind(path: string): NativeKind {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, "r");
    const buf = Buffer.alloc(160);
    const n = fs.readSync(fd, buf, 0, 160, 0);
    const kind = /"kind"\s*:\s*"(page|canvas|kanban)"/.exec(buf.toString("utf8", 0, n))?.[1];
    return (kind as NativeKind | undefined) ?? "page";
  } catch {
    return "page";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
/** A web file: its HTML is the file. */
const WEB = /\.html?$/i;

/** Where a note that is a file on disk lives. */
export interface LocalInfo {
  folder: string;
  /** Its path inside the folder, with forward slashes ("" for the folder itself). */
  path: string;
  /** Its name on disk (a Markdown file's title leaves the extension out). */
  name: string;
  type: LocalType;
  size: number;
  /** On the folder's own row: where it is on disk, and whether it's there. */
  root?: { path: string; missing: boolean; hidden: boolean };
  /** Text that can only be read here: too big to edit, or not UTF-8. */
  locked?: "large" | "encoding";
  /** A .etude file that couldn't be read as a page (why); it opens as its text. */
  broken?: string;
  /** A .etude file's own title, when the user gave it one (read with the file, not in the tree's rows). */
  pageTitle?: string;
  /** Sync carries it to the other devices: "root" on the folder that was marked, "inside" on what's in it. */
  synced?: "root" | "inside";
  /** On a folder: what's in it was put in an order by hand (it lists by name otherwise). */
  arranged?: true;
}

export interface LocalSummary extends NoteSummary {
  local: LocalInfo;
}
export interface LocalNote extends Note {
  local: LocalInfo;
  /** Where the file's bytes are served from (null for a folder). */
  src: string | null;
}

// The browser build stands in for node:os and says so.
const HERE = (os.platform() as string) !== "browser";
const MARKDOWN = /\.(md|markdown)$/i;
const TYPES: [LocalType, RegExp][] = [
  ["markdown", MARKDOWN],
  ["etude", PAGE],
  ["web", WEB],
  ["pdf", /\.pdf$/i],
  ["image", /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i],
  ["audio", /\.(mp3|wav|m4a|ogg|oga|flac|opus|aac)$/i],
  ["video", /\.(mp4|webm|mov|mkv|ogv|m4v)$/i],
];
export function localType(name: string): LocalType {
  for (const [t, re] of TYPES) if (re.test(name)) return t;
  return isTextFile(name) || /\.(mdx|canvas|excalidraw|base|gitignore|editorconfig|lock)$/i.test(name) ? "text" : "other";
}
const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", opus: "audio/ogg", aac: "audio/aac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", ogv: "video/ogg", m4v: "video/mp4",
};
const extOf = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** The most text the editor takes in one file. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** A file with no known extension is read as text when it's small and reads as text. */
const SNIFF_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const SKIP_NAMES = new Set(["Thumbs.db", "desktop.ini", ".DS_Store"]);
/** Never walked when looking for a file by name or by its words. */
export const HEAVY = ["node_modules", "__pycache__"];
const EMPTY_DOC = { type: "doc", content: [] };
const iso = (ms: number) => new Date(Math.round(ms)).toISOString();
const parentRel = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** Text as it's matched: lowercase, accents off (most paths are plain ASCII and only need the first). */
const key = (s: string) => (/[^\x00-\x7f]/.test(s) ? fold(s) : s.toLowerCase());

/** UTF-8 text, or null for bytes that aren't (a NUL counts as binary). A leading BOM is dropped. */
export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
const hasBom = (b: Uint8Array) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
/** Windows line ends throughout: kept that way on a save. */
const isCrlf = (text: string) => text.includes("\r\n") && !/(^|[^\r])\n/.test(text);

/** A file or folder name the disk takes. */
function cleanName(raw: unknown, what = "name"): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new EtudeError(`give a ${what}`);
  if (name === "." || name === ".." || /[/\0]/.test(name) || (sep === "\\" && /[\\:*?"<>|]/.test(name))) throw new EtudeError(`"${name.slice(0, 60)}" can't be a file name`);
  if (new TextEncoder().encode(name).length > 255) throw new EtudeError("that name is too long for a file");
  return name;
}

export class Folders {
  private readonly db: Db;
  private readonly mediaDir: string;
  private ready = false;
  /** Set by the collection: how Sync stands for a path (src/core/sync/folder-files.ts), and a say before a folder closes. */
  syncState: ((id: string) => "root" | "inside" | null) | null = null;
  beforeClose: ((folderId: string) => void) | null = null;
  /** Told when a file or folder was renamed or moved from here (`to` null: to the trash), so a synced folder's place follows it. */
  afterMove: ((from: string, to: string | null) => void) | null = null;
  private names = new Map<string, { at: number; files: string[]; partial: boolean; building?: Promise<void>; drop?: ReturnType<typeof setTimeout> }>();

  constructor(db: Db, opts: { mediaDir: string }) {
    this.db = db;
    this.mediaDir = opts.mediaDir;
  }

  /** False where there's no disk to open (the web edition, the phone apps). */
  get available(): boolean {
    return HERE;
  }

  private schema() {
    if (this.ready) return;
    this.db.sql.exec(`CREATE TABLE IF NOT EXISTS local_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', trash TEXT NOT NULL DEFAULT '.trash', hidden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_marks (id TEXT PRIMARY KEY, pinned TEXT, opened TEXT);
      CREATE TABLE IF NOT EXISTS local_order (dir TEXT PRIMARY KEY, names TEXT NOT NULL);`);
    this.ready = true;
  }

  // ---------------------------------------------------------------- the folders

  list(): LocalFolder[] {
    if (!HERE) return [];
    this.schema();
    const host = os.hostname();
    return this.db.all("SELECT * FROM local_folders ORDER BY position, created").map((r) => {
      const elsewhere = !!r.host && r.host !== host;
      return { id: String(r.id), name: String(r.name), path: String(r.path), trash: String(r.trash), hidden: !!r.hidden, created: String(r.created), elsewhere, missing: elsewhere || !isDir(String(r.path)) };
    });
  }

  folder(ref: string): LocalFolder {
    const all = this.list();
    const f = all.find((x) => x.id === ref) ?? all.find((x) => x.name === ref) ?? all.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!f) throw new EtudeError(`no folder "${ref}" is open in the Notebook`, 404);
    return f;
  }

  /** Opens a folder on this computer in the Notebook. Nothing in it is read until it's looked at. */
  open(path: string, opts: { name?: string; trash?: string; hidden?: boolean } = {}): LocalFolder {
    if (!HERE) throw new EtudeError("a folder can only be opened in the desktop app or `etude serve`");
    this.schema();
    let p = String(path ?? "").trim();
    if (!p) throw new EtudeError("give the folder's path");
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = join(os.homedir(), p.slice(2));
    p = resolve(p);
    if (!isDir(p)) throw new EtudeError(`${p} isn't a folder on this computer`, 404);
    p = fs.realpathSync(p);
    const media = resolve(this.mediaDir);
    if (p === media || p.startsWith(media + sep)) throw new EtudeError("that's where Etude keeps the collection's own media");
    const all = this.list();
    const same = all.find((f) => !f.elsewhere && f.path === p);
    if (same) throw new EtudeError(`${p} is already open as "${same.name}"`, 409);
    const base = (opts.name ?? "").trim() || basename(p) || p;
    let name = base;
    for (let i = 2; all.some((f) => f.name.toLowerCase() === name.toLowerCase()); i++) name = `${base} ${i}`;
    const trash = this.cleanTrash(opts.trash);
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.run("INSERT INTO local_folders (id, name, path, host, trash, hidden, position, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, name, p, os.hostname(), trash, opts.hidden ? 1 : 0, all.length, new Date().toISOString());
    return this.folder(id);
  }

  private cleanTrash(raw: unknown): string {
    const t = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || ".trash";
    if (t.split("/").some((part) => part === "" || part === "." || part === "..")) throw new EtudeError("the trash is a folder inside the folder, like .trash or trash");
    return t;
  }

  /** Changes what the Notebook calls a folder, where its removed files go, or whether dot-names show. */
  edit(ref: string, patch: { name?: string; trash?: string; hidden?: boolean }): LocalFolder {
    const f = this.folder(ref);
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new EtudeError("give a name");
      if (this.list().some((x) => x.id !== f.id && x.name.toLowerCase() === name.toLowerCase())) throw new EtudeError(`another folder is already called "${name}"`, 409);
      this.db.run("UPDATE local_folders SET name = ? WHERE id = ?", name, f.id);
    }
    if (patch.trash !== undefined) this.db.run("UPDATE local_folders SET trash = ? WHERE id = ?", this.cleanTrash(patch.trash), f.id);
    if (patch.hidden !== undefined) this.db.run("UPDATE local_folders SET hidden = ? WHERE id = ?", patch.hidden ? 1 : 0, f.id);
    this.names.delete(f.id);
    return this.folder(f.id);
  }

  /** Takes a folder out of the Notebook. The folder and everything in it stay on disk as they are. */
  close(ref: string): LocalFolder {
    const f = this.folder(ref);
    this.beforeClose?.(f.id);
    this.db.tx(() => {
      this.db.run("DELETE FROM local_folders WHERE id = ?", f.id);
      this.db.run("DELETE FROM local_marks WHERE id = ? OR id LIKE ? ESCAPE '\\'", fsId(f.id), likePrefix(fsId(f.id) + "/"));
      this.db.run("DELETE FROM local_order WHERE dir = ? OR dir LIKE ? ESCAPE '\\'", fsId(f.id), likePrefix(fsId(f.id) + "/"));
    });
    this.names.delete(f.id);
    return f;
  }

  // ---------------------------------------------------------------- where things are

  /**
   * A note id as a place on disk. Refuses anything that would leave the folder, and anything under a name that
   * starts with a dot unless the folder shows those (so .git or .env can't be read or written through an id made
   * up by hand). `inner` is for the app's own moves into and out of the trash.
   */
  private at(id: string, inner = false): { folder: LocalFolder; rel: string; full: string } {
    if (!isFsId(id)) throw new EtudeError(`"${id}" isn't a file in a folder`, 404);
    const { folder: fid, rel: raw } = parseFsId(id);
    const folder = this.folder(fid);
    if (folder.elsewhere) throw new EtudeError(`"${folder.name}" was opened on another computer`, 404);
    const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.some((p) => p === ".." || p.includes("\0") || (sep === "\\" && p.includes("\\")))) throw new EtudeError("that path leaves the folder", 400);
    if (!inner && !folder.hidden && parts.some((p) => p.startsWith("."))) throw new EtudeError(`"${folder.name}" doesn't show names that start with a dot`, 404);
    const root = resolve(folder.path);
    const full = resolve(root, ...parts);
    const realRoot = (() => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    })();
    const insideDir = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
    if (!insideDir(full, root)) throw new EtudeError("that path leaves the folder", 400);
    // Symlink containment: resolve the deepest existing ancestor (and full itself if present) to ensure symlinks cannot escape root.
    let probe = full;
    for (;;) {
      try {
        const realProbe = fs.realpathSync(probe);
        if (!insideDir(realProbe, realRoot)) throw new EtudeError("that path leaves the folder", 400);
        break;
      } catch (e) {
        if (e instanceof EtudeError) throw e;
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return { folder, rel: parts.join("/"), full };
  }

  /** Where a file is on disk. */
  pathOf(id: string): string {
    return this.at(id).full;
  }

  /** The id of a path on disk that sits in an open folder, or null. */
  idOf(path: string): string | null {
    const p = resolve(path);
    for (const f of this.list()) {
      if (f.elsewhere) continue;
      const root = resolve(f.path);
      if (p === root) return fsId(f.id);
      if (p.startsWith(root + sep)) return fsId(f.id, p.slice(root.length + 1).split(sep).join("/"));
    }
    return null;
  }

  /** A file named the ways a person or an agent would: its id, "Folder name/path/inside", or its path on disk. */
  ref(ref: string): string {
    const r = String(ref ?? "").trim();
    if (!r) throw new EtudeError("give a file: \"Folder/path/inside\", a path on disk, or an fs: id");
    if (r.startsWith(FS_PREFIX)) return fsId(this.at(r).folder.id, this.at(r).rel);
    const onDisk = /^(~|\/|[A-Za-z]:[\\/])/.test(r) ? this.idOf(r === "~" || r.startsWith("~/") ? join(os.homedir(), r.slice(2)) : r) : null;
    if (onDisk) return onDisk;
    const parts = r.replace(/\\/g, "/").split("/").filter(Boolean);
    const all = this.list();
    // The longest folder name that starts the path wins ("Notes 2/x" is in "Notes 2", not in "Notes").
    const f = all.filter((x) => parts[0]?.toLowerCase() === x.name.toLowerCase())[0];
    if (!f) throw new EtudeError(`no folder "${parts[0] ?? r}" is open in the Notebook${all.length ? ` (open: ${all.map((x) => x.name).join(", ")})` : ""}`, 404);
    const id = fsId(f.id, parts.slice(1).join("/"));
    this.at(id);
    return id;
  }

  private marks(ids: string[]): Map<string, { pinned: string | null; opened: string | null }> {
    const out = new Map<string, { pinned: string | null; opened: string | null }>();
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      for (const r of this.db.all(`SELECT id, pinned, opened FROM local_marks WHERE id IN (${part.map(() => "?").join(",")})`, ...part)) out.set(String(r.id), { pinned: (r.pinned as string) ?? null, opened: (r.opened as string) ?? null });
    }
    return out;
  }

  private row(folder: LocalFolder, rel: string, st: fs.Stats | null, position: number, children = 0): LocalSummary {
    const name = rel ? rel.slice(rel.lastIndexOf("/") + 1) : folder.name;
    const dir = !rel || !!st?.isDirectory();
    const type: LocalType = dir ? "dir" : localType(name);
    const at = st ? st.mtimeMs : 0;
    return {
      id: fsId(folder.id, rel),
      kind: dir ? "folder" : type === "pdf" ? "pdf" : type === "web" ? "web" : type === "etude" ? (st ? peekKind(rel ? join(resolve(folder.path), ...rel.split("/")) : folder.path) : "page") : "file",
      parentId: rel ? fsId(folder.id, parentRel(rel)) : null,
      title: type === "markdown" || type === "etude" ? name.replace(TITLED, "") : name,
      icon: null,
      look: {},
      position,
      archived: false,
      created: iso(st ? st.birthtimeMs || st.ctimeMs || at : 0),
      updated: iso(at),
      children,
      ...(dir ? {} : { empty: st?.size === 0 }),
      pinned: null,
      opened: null,
      local: { folder: folder.id, path: rel, name: rel ? name : basename(folder.path) || folder.path, type, size: dir || !st ? 0 : st.size, ...(rel ? {} : { root: { path: folder.path, missing: folder.missing, hidden: folder.hidden } }) },
    };
  }

  private withMarks<T extends LocalSummary>(rows: T[]): T[] {
    const m = this.marks(rows.map((r) => r.id));
    for (const r of rows) {
      const k = m.get(r.id);
      if (k) (r.pinned = k.pinned), (r.opened = k.opened);
      const synced = this.syncState?.(r.id);
      if (synced) r.local.synced = synced;
    }
    if (rows.some((r) => r.local.type === "dir")) {
      const arranged = new Set(this.db.all("SELECT dir FROM local_order").map((r) => String(r.dir)));
      for (const r of rows) if (r.local.type === "dir" && arranged.has(r.id)) r.local.arranged = true;
    }
    return rows;
  }

  /** Whether a name shows in the Notebook: not the system's own droppings, and not a dot-name unless the folder shows those. */
  shown(folder: LocalFolder, name: string): boolean {
    if (SKIP_NAMES.has(name) || name.endsWith(".etude-tmp")) return false;
    return folder.hidden || !name.startsWith(".");
  }

  /** The open folders as the tree's top rows. */
  roots(): LocalSummary[] {
    return this.withMarks(
      this.list().map((f, i) => {
        const st = f.missing ? null : statOrNull(f.path);
        return this.row(f, "", st, 1_000_000 + i, st ? this.count(f, f.path) : 0);
      }),
    );
  }

  private count(folder: LocalFolder, full: string): number {
    try {
      return fs.readdirSync(full).filter((n) => this.shown(folder, String(n))).length;
    } catch {
      return 0;
    }
  }

  /** What's right inside a folder: folders first, then files, by name. */
  children(dirId: string): LocalSummary[] {
    const { folder, rel, full } = this.at(dirId);
    const kept = this.listed(folder, rel, full).slice(0, MAX_ENTRIES);
    // Counting what's inside each folder costs a read apiece: skipped in a folder of very many folders (-1 = not counted).
    const counted = kept.filter((x) => x.dir).length <= 300;
    return this.withMarks(kept.map((x, i) => this.row(folder, rel ? `${rel}/${x.name}` : x.name, x.st, i, x.dir ? (counted ? this.count(folder, join(full, x.name)) : -1) : 0)));
  }

  /**
   * What's right inside a folder, in the order it shows: folders first and by name, unless the folder was put in an
   * order by hand (`arrange`). Then the names in that order come first, and anything it doesn't know (a file made
   * since) follows, by name.
   */
  private listed(folder: LocalFolder, rel: string, full: string): { name: string; st: fs.Stats; dir: boolean }[] {
    let names: string[];
    try {
      names = fs.readdirSync(full).map(String);
    } catch (e) {
      throw new EtudeError(`can't read ${rel || folder.name}: ${reason(e)}`, 404);
    }
    const found: { name: string; st: fs.Stats; dir: boolean }[] = [];
    for (const name of names) {
      if (!this.shown(folder, name)) continue;
      const st = statOrNull(join(full, name));
      if (st) found.push({ name, st, dir: st.isDirectory() });
    }
    found.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || (a.name < b.name ? -1 : 1));
    const order = this.orderOf(fsId(folder.id, rel));
    if (!order) return found;
    const place = new Map(order.map((n, i) => [n, i]));
    const at = (name: string) => place.get(name) ?? order.length;
    // The sort keeps what ties as it was, so the ones the order doesn't know stay by name.
    return found.sort((a, b) => at(a.name) - at(b.name));
  }
  private orderOf(dirId: string): string[] | null {
    this.schema();
    const r = this.db.get("SELECT names FROM local_order WHERE dir = ?", dirId);
    if (!r) return null;
    try {
      const v = JSON.parse(String(r.names));
      return Array.isArray(v) ? v.map(String) : null;
    } catch {
      return null;
    }
  }

  /**
   * Puts things of one folder in an order of your own: `names` go at `index` among the rest (left out: the end),
   * in the order given. A disk has no order, so it's kept in the collection, per folder, on this computer.
   */
  arrange(dirId: string, names: string[], index?: number): void {
    const { folder, rel, full } = this.at(dirId);
    if (!isDir(full)) throw new EtudeError(`${rel || folder.name} isn't a folder`, 404);
    const moving = new Set(names);
    const rest = this.listed(folder, rel, full).map((x) => x.name).filter((n) => !moving.has(n));
    const here = names.filter((n, i) => names.indexOf(n) === i && fs.existsSync(join(full, n)));
    const at = index === undefined || !Number.isFinite(index) ? rest.length : Math.max(0, Math.min(rest.length, Math.trunc(index)));
    rest.splice(at, 0, ...here);
    this.db.run("INSERT INTO local_order (dir, names) VALUES (?, ?) ON CONFLICT(dir) DO UPDATE SET names = excluded.names", fsId(folder.id, rel), JSON.stringify(rest));
  }
  /** Whether a folder's files were put in an order by hand. */
  isArranged(dirId: string): boolean {
    return !!this.orderOf(dirId);
  }
  /** One value that changes when any folder's own order does, for the tree's poll. */
  orderStamp(): string {
    if (!HERE) return "";
    this.schema();
    let h = 5381;
    for (const r of this.db.all("SELECT dir, names FROM local_order ORDER BY dir")) for (const ch of `${r.dir}\n${r.names}\n`) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
    return String(h >>> 0);
  }
  /** Back to the order of the names. */
  sortByName(dirId: string): LocalSummary {
    const { folder, rel, full } = this.at(dirId);
    if (!isDir(full)) throw new EtudeError(`${rel || folder.name} isn't a folder`, 404);
    this.db.run("DELETE FROM local_order WHERE dir = ?", fsId(folder.id, rel));
    return this.summary(fsId(folder.id, rel));
  }
  /**
   * Puts several files and folders where they go in one step: each into its folder (moved on disk when that's
   * another one), and at its place there when it has one. `index` counts among what's in the folder without the
   * ones being placed. Returns where each one is now.
   */
  place(items: { id: string; parentId: string; index?: number }[]): { from: string; id: string }[] {
    const out: { from: string; id: string }[] = [];
    const spots = new Map<string, { name: string; index: number }[]>();
    for (const it of items) {
      const { folder, rel, full } = this.at(it.id);
      if (!rel) throw new EtudeError("an open folder stays at the top level");
      if (!isFsId(it.parentId)) throw new EtudeError("a file on this computer moves between folders on this computer; a page in the collection can't hold it");
      const to = this.at(it.parentId);
      const dir = fsId(to.folder.id, to.rel);
      const id = fsId(folder.id, parentRel(rel)) === dir ? fsId(folder.id, rel) : this.relocate(it.id, it.parentId, basename(full)).id;
      out.push({ from: it.id, id });
      if (it.index !== undefined && Number.isFinite(it.index)) spots.set(dir, [...(spots.get(dir) ?? []), { name: basename(full), index: Math.trunc(it.index) }]);
    }
    // Lowest place first, so each lands where it was asked among the ones already put down.
    for (const [dir, list] of spots) {
      const sorted = [...list].sort((a, b) => a.index - b.index);
      const run: string[] = [];
      let start = sorted[0].index;
      const flush = () => run.length && (this.arrange(dir, [...run], start), (run.length = 0));
      for (const s of sorted) {
        if (run.length && s.index !== start + run.length) flush();
        if (!run.length) start = s.index;
        run.push(s.name);
      }
      flush();
    }
    return out;
  }

  /** One row, for a tab whose folder isn't unfolded. */
  summary(id: string): LocalSummary {
    const { folder, rel, full } = this.at(id);
    if (!rel) return this.roots().find((r) => r.id === id)!;
    const st = statOrNull(full);
    if (!st) throw new EtudeError(`no file at ${rel} in "${folder.name}"`, 404);
    return this.withMarks([this.row(folder, rel, st, 0, st.isDirectory() ? this.count(folder, full) : 0)])[0];
  }

  /** A file with its text (when it's text Etude can show), or a folder. */
  get(id: string): LocalNote {
    const { full } = this.at(id);
    const row = this.summary(id);
    const base = { ...row, doc: EMPTY_DOC, text: "", scene: null, file: null, board: null };
    if (row.kind === "folder") return { ...base, content: null, src: null };
    const src = `/api/folders/raw?id=${encodeURIComponent(id)}`;
    const local = { ...row.local };
    let content: string | null = null;
    if (local.type === "etude") {
      // A page kept as a file. One that can't be read as a page opens as its text, so it can be seen and mended.
      const raw = local.size > MAX_TEXT_BYTES ? null : decodeText(fs.readFileSync(full));
      try {
        if (raw === null) throw new EtudeError(local.size > MAX_TEXT_BYTES ? "it's bigger than a page here can be (5 MB)" : "it isn't UTF-8 text");
        const f = nativeFromText(raw);
        if (f.title) local.pageTitle = f.title;
        const head = { ...base, kind: f.kind, local, icon: f.icon, look: f.look, content: null, src };
        if (f.kind === "canvas") return { ...head, scene: f.scene!, empty: !f.scene!.elements.length };
        if (f.kind === "kanban") return { ...head, board: f.board!, text: boardText(f.board!, docText), empty: !Object.keys(f.board!.cards).length };
        return { ...head, doc: f.doc!, text: docText(f.doc!), empty: !(f.doc!.content ?? []).length };
      } catch (e) {
        local.broken = (e as Error).message;
        local.type = "text";
        if (raw === null) local.locked = local.size > MAX_TEXT_BYTES ? "large" : "encoding";
        return { ...base, kind: "file", title: local.name, local, content: raw, src };
      }
    }
    if (local.type === "markdown" || local.type === "text" || local.type === "web") {
      if (local.size > MAX_TEXT_BYTES) local.locked = "large";
      else {
        content = decodeText(fs.readFileSync(full));
        if (content === null) local.locked = "encoding";
      }
    } else if (local.type === "other" && local.size <= SNIFF_BYTES) {
      content = decodeText(fs.readFileSync(full));
      if (content !== null) local.type = "text";
    }
    return { ...base, local, content, src };
  }

  /** When a file last changed on disk, and each folder's own stamp (it moves when something right inside is added, removed or renamed). */
  stamp(id: string): { updated: string } {
    const st = statOrNull(this.at(id).full);
    if (!st) throw new EtudeError("that file is gone", 404);
    return { updated: iso(st.mtimeMs) };
  }
  stamps(dirs: string[]): { roots: string; dirs: Record<string, string> } {
    const out: Record<string, string> = {};
    for (const d of dirs.slice(0, 2000)) {
      try {
        const st = statOrNull(this.at(d).full);
        out[d] = st ? String(st.mtimeMs) : "gone";
      } catch {
        out[d] = "gone";
      }
    }
    return { roots: this.list().map((f) => `${f.id}|${f.name}|${f.path}|${f.hidden}|${f.missing}`).join("\n"), dirs: out };
  }

  // ---------------------------------------------------------------- changing what's on disk

  /**
   * Saves a file's text. With `base` (the `updated` the editor read), a file that changed on disk since is
   * refused with 409, so nothing written there by another program is lost. Line ends and a BOM stay as they were.
   */
  write(id: string, content: unknown, opts: { base?: unknown } = {}): LocalNote {
    const { folder, rel, full } = this.at(id);
    if (typeof content !== "string") throw new EtudeError("a file's text is a string");
    const st = statOrNull(full);
    if (!st) throw new EtudeError(`no file at ${rel} in "${folder.name}"`, 404);
    if (st.isDirectory()) throw new EtudeError(`${rel || folder.name} is a folder`);
    // A page's file is written as a page (writePage), unless it's one that couldn't be read and is being mended as text.
    if (PAGE.test(full)) {
      let readable = true;
      try {
        nativeFromText(decodeText(fs.readFileSync(full)) ?? "\u0000");
      } catch {
        readable = false;
      }
      if (readable) {
        try {
          nativeFromText(String(content));
        } catch (e) {
          throw new EtudeError(`${basename(full)} is an Etude page: that text isn't one (${(e as Error).message})`);
        }
      }
    }
    if (st.size > MAX_TEXT_BYTES) throw new EtudeError(`${basename(full)} is too big to edit here (5 MB at most)`, 413);
    if (new TextEncoder().encode(content).length > MAX_TEXT_BYTES) throw new EtudeError("that's more text than a file here takes (5 MB)", 413);
    const bytes = fs.readFileSync(full);
    const current = decodeText(bytes);
    if (current === null) throw new EtudeError(`${basename(full)} isn't text Etude can edit`);
    let next = content.replace(/\r\n/g, "\n");
    if (isCrlf(current)) next = next.replace(/\n/g, "\r\n");
    if (next === current) return this.get(id);
    if (opts.base !== undefined && opts.base !== null && String(opts.base) !== iso(st.mtimeMs)) throw new EtudeError("the file changed on disk since it was opened", 409);
    writeWhole(full, (hasBom(bytes) ? "\uFEFF" : "") + next, st);
    return this.get(id);
  }

  /**
   * A new page (a .etude file), file or folder inside a folder. A name already taken gets a number when `unique` is
   * set (or no name was given), else it's refused.
   */
  create(parentId: string, input: { title?: unknown; kind?: unknown; content?: unknown; doc?: unknown; scene?: unknown; board?: unknown; template?: unknown; icon?: unknown; look?: unknown; unique?: boolean }): LocalNote {
    let { folder, rel, full } = this.at(parentId);
    // Asked for inside a page that is a file (a canvas drawn from the page, a page linked from it): it goes beside it.
    if (rel && statOrNull(full)?.isFile()) {
      rel = parentRel(rel);
      full = dirname(full);
    }
    if (!isDir(full)) throw new EtudeError(`${rel || folder.name} isn't a folder`, 404);
    const kind = String(input.kind ?? "page");
    if (!["page", "canvas", "kanban", "web", "file", "folder"].includes(kind)) throw new EtudeError(`a ${kind} can't be made in a folder on this computer: make a page, a canvas, a kanban board, a web file, a file or a folder`);
    const native = NATIVE.includes(kind as NativeKind);
    const given = String(input.title ?? "").trim();
    let name = given || { folder: "New folder", page: "Untitled", canvas: "Untitled canvas", kanban: "Untitled board", web: "Untitled.html", file: "untitled.txt" }[kind]!;
    if (native && !PAGE.test(name)) name += PAGE_EXT;
    if (kind === "web" && !WEB.test(name)) name += ".html";
    name = cleanName(name);
    if (!folder.hidden && name.startsWith(".")) throw new EtudeError(`"${folder.name}" doesn't show names that start with a dot`, 400);
    if (input.unique || !given) name = freeName(full, name);
    const target = join(full, name);
    if (fs.existsSync(target)) throw new EtudeError(`"${name}" is already there`, 409);
    if (kind === "folder") fs.mkdirSync(target);
    else if (native) {
      if (input.content !== undefined && input.content !== null) throw new EtudeError(`a ${kind === "kanban" ? "kanban board" : kind} isn't text: make a file for text (name.md, name.txt)`);
      const head = { icon: typeof input.icon === "string" && input.icon ? input.icon : null, look: normalizeLook(input.look ?? {}) };
      const file: NativeFile =
        kind === "canvas"
          ? { kind, ...head, scene: input.scene === undefined || input.scene === null ? emptyScene() : checkScene(input.scene) }
          : kind === "kanban"
            ? { kind, ...head, board: input.board === undefined || input.board === null ? emptyBoard(input.template as never) : checkBoard(input.board, checkDoc) }
            : { kind: "page", ...head, doc: checkDoc(input.doc ?? { type: "doc", content: [] }) };
      fs.writeFileSync(target, nativeToText(file), { flag: "wx" });
    } else {
      if (input.content !== undefined && input.content !== null && typeof input.content !== "string") throw new EtudeError("a file's text is a string");
      fs.writeFileSync(target, (input.content as string | undefined) ?? "", { flag: "wx" });
    }
    this.names.delete(folder.id);
    return this.get(fsId(folder.id, rel ? `${rel}/${name}` : name));
  }

  /**
   * Saves one of Etude's own kinds kept as a file: its body (a page's document, a canvas's drawing, a board), title,
   * icon or look, whichever is given. The title is the page's own; renaming the file is `rename`. With `base` (the `updated` the editor read), a body written over a file that changed
   * on disk since is refused with 409, and the editor puts the two together.
   */
  writePage(id: string, patch: { doc?: unknown; scene?: unknown; board?: unknown; title?: unknown; icon?: unknown; look?: unknown }, opts: { base?: unknown } = {}): LocalNote {
    const { folder, rel, full } = this.at(id);
    const st = statOrNull(full);
    if (!st || st.isDirectory()) throw new EtudeError(`no page at ${rel} in "${folder.name}"`, 404);
    if (!PAGE.test(full)) throw new EtudeError(`${basename(full)} isn't an Etude page: its text is what's saved`);
    const before = decodeText(fs.readFileSync(full));
    if (before === null) throw new EtudeError(`${basename(full)} isn't text`);
    const was = nativeFromText(before);
    if (patch.doc !== undefined && was.kind !== "page") throw new EtudeError(was.kind === "kanban" ? "a kanban board has a board (columns and cards), not a doc" : "a canvas has a scene, not a doc");
    if (patch.scene !== undefined && was.kind !== "canvas") throw new EtudeError("only a canvas has a scene");
    if (patch.board !== undefined && was.kind !== "kanban") throw new EtudeError("only a kanban board has a board");
    const next: NativeFile = {
      kind: was.kind,
      title: patch.title === undefined ? was.title : cleanTitle(patch.title),
      icon: patch.icon === undefined ? was.icon : typeof patch.icon === "string" && patch.icon ? patch.icon : null,
      look: patch.look === undefined ? was.look : normalizeLook(patch.look ?? {}),
      ...(was.kind === "canvas" ? { scene: patch.scene === undefined ? was.scene : checkScene(patch.scene) } : was.kind === "kanban" ? { board: patch.board === undefined ? was.board : checkBoard(patch.board, checkDoc) } : { doc: patch.doc === undefined ? was.doc : checkDoc(patch.doc) }),
    };
    const text = nativeToText(next);
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw new EtudeError("that's too big for one file (5 MB at most)", 413);
    if (text === before) return this.get(id);
    // Only a body is put together with what's on disk; a title, an icon or a look is one value, and the last one wins.
    const body = patch.doc !== undefined || patch.scene !== undefined || patch.board !== undefined;
    if (body && opts.base !== undefined && opts.base !== null && String(opts.base) !== iso(st.mtimeMs)) throw Object.assign(new EtudeError("this page was changed somewhere else since it was opened", 409), { code: "changed" });
    writeWhole(full, text, st);
    return this.get(id);
  }

  /** A new name in the same folder. A Markdown file keeps its extension when the new name leaves it out. */
  rename(id: string, title: unknown): LocalNote {
    const { folder, rel, full } = this.at(id);
    if (!rel) return this.get(fsId(this.edit(folder.id, { name: String(title ?? "") }).id));
    const old = basename(full);
    let name = cleanName(title);
    const ext = TITLED.exec(old)?.[0];
    if (ext && !TITLED.test(name)) name += ext;
    if (name === old) return this.get(id);
    return this.relocate(id, fsId(folder.id, parentRel(rel)), name);
  }

  /**
   * Into another folder (of the same open folder or another one), keeping its name. With `index`, at that place
   * among what's there (0 first), which also works inside the folder it's already in: that's how things are put
   * in an order of your own.
   */
  move(id: string, toDirId: string, index?: number): LocalNote {
    return this.get(this.place([{ id, parentId: toDirId, index }])[0].id);
  }

  /** To another folder and another name in one move. */
  relocate(id: string, toDirId: string, name: string): LocalNote {
    const from = this.at(id);
    const to = this.at(toDirId);
    if (!fs.existsSync(from.full)) throw new EtudeError("that file is gone", 404);
    if (!isDir(to.full)) throw new EtudeError(`${to.rel || to.folder.name} isn't a folder`, 404);
    const safeName = cleanName(name);
    if (!to.folder.hidden && safeName.startsWith(".")) throw new EtudeError(`"${to.folder.name}" doesn't show names that start with a dot`, 400);
    const next = fsId(to.folder.id, to.rel ? `${to.rel}/${safeName}` : safeName);
    const target = this.at(next).full;
    if (target === from.full) return this.get(id);
    if (target.startsWith(from.full + sep)) throw new EtudeError("a folder can't go inside itself");
    const there = statOrNull(target);
    // On a disk that ignores case, a new capital in the name is the same file: let it through.
    if (there && !(there.ino && there.ino === statOrNull(from.full)?.ino && target.toLowerCase() === from.full.toLowerCase())) throw new EtudeError(`"${safeName}" is already there`, 409);
    try {
      fs.renameSync(from.full, target);
    } catch (e) {
      throw new EtudeError(`couldn't move it: ${reason(e)}`);
    }
    this.remark(id, next);
    this.names.delete(from.folder.id);
    this.names.delete(to.folder.id);
    return this.get(next);
  }

  /** Pins and Jump back in follow a file to its new place (and everything inside a folder that moved). */
  private remark(from: string, to: string | null) {
    this.afterMove?.(from, to);
    if (to !== null) {
      this.db.tx(() => {
        // A folder's own order goes where the folder goes.
        for (const r of this.db.all("SELECT dir, names FROM local_order WHERE dir = ? OR dir LIKE ? ESCAPE '\\'", from, likePrefix(from + "/"))) {
          this.db.run("DELETE FROM local_order WHERE dir = ?", r.dir);
          this.db.run("INSERT OR REPLACE INTO local_order (dir, names) VALUES (?, ?)", to + String(r.dir).slice(from.length), r.names);
        }
        // Renamed where it is: it keeps its place.
        const a = parseFsId(from), b = parseFsId(to);
        if (a.folder === b.folder && parentRel(a.rel) === parentRel(b.rel)) {
          const dir = fsId(a.folder, parentRel(a.rel));
          const order = this.orderOf(dir);
          const was = a.rel.slice(a.rel.lastIndexOf("/") + 1), now = b.rel.slice(b.rel.lastIndexOf("/") + 1);
          if (order?.includes(was)) this.db.run("UPDATE local_order SET names = ? WHERE dir = ?", JSON.stringify(order.map((n) => (n === was ? now : n))), dir);
        }
      });
    }
    this.db.tx(() => {
      const rows = this.db.all("SELECT id, pinned, opened FROM local_marks WHERE id = ? OR id LIKE ? ESCAPE '\\'", from, likePrefix(from + "/"));
      for (const r of rows) {
        this.db.run("DELETE FROM local_marks WHERE id = ?", r.id);
        if (to !== null) this.db.run("INSERT OR REPLACE INTO local_marks (id, pinned, opened) VALUES (?, ?, ?)", to + String(r.id).slice(from.length), r.pinned ?? null, r.opened ?? null);
      }
    });
  }

  /** Moves a file or folder to the folder's trash (never deletes). Returns where it went, for Undo. */
  trash(id: string): { ids: string[]; archived: true; trashed: string } {
    const { folder, rel, full } = this.at(id);
    if (!rel) throw new EtudeError("that's the open folder itself: close it instead (it stays on disk)");
    if (!fs.existsSync(full)) throw new EtudeError("that file is gone", 404);
    const root = resolve(folder.path);
    const bin = resolve(root, ...folder.trash.split("/"));
    if (full === bin) throw new EtudeError("that's the trash itself");
    if (full.startsWith(bin + sep)) throw new EtudeError("it's already in the trash");
    if (bin.startsWith(full + sep)) throw new EtudeError("the trash is inside that folder");
    fs.mkdirSync(bin, { recursive: true });
    const name = freeName(bin, basename(full));
    try {
      fs.renameSync(full, join(bin, name));
    } catch (e) {
      throw new EtudeError(`couldn't move it to the trash: ${reason(e)}`);
    }
    this.remark(id, null);
    this.names.delete(folder.id);
    return { ids: [id], archived: true, trashed: `${folder.trash}/${name}` };
  }

  /** Puts something back from the trash where it was (Undo). */
  restore(id: string, trashed: string): LocalSummary {
    const { folder, rel, full } = this.at(id);
    const bin = folder.trash.split("/");
    const parts = String(trashed ?? "").split("/").filter(Boolean);
    if (parts.length <= bin.length || bin.some((b, i) => parts[i] !== b)) throw new EtudeError("that isn't in this folder's trash");
    const from = this.at(fsId(folder.id, parts.join("/")), true);
    if (!fs.existsSync(from.full)) throw new EtudeError("it isn't in the trash any more", 404);
    if (fs.existsSync(full)) throw new EtudeError(`something else is at ${rel} now`, 409);
    fs.mkdirSync(dirname(full), { recursive: true });
    fs.renameSync(from.full, full);
    this.names.delete(folder.id);
    return this.summary(id);
  }

  // ---------------------------------------------------------------- pins and Jump back in

  pin(id: string, on: boolean): LocalSummary {
    this.summary(id);
    if (on) this.db.run("INSERT INTO local_marks (id, pinned) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET pinned = COALESCE(local_marks.pinned, excluded.pinned)", id, new Date().toISOString());
    else this.db.run("UPDATE local_marks SET pinned = NULL WHERE id = ?", id);
    return this.summary(id);
  }
  markOpened(id: string): LocalSummary {
    const s = this.summary(id);
    if (s.kind !== "folder") this.db.run("INSERT INTO local_marks (id, opened) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET opened = excluded.opened", id, new Date().toISOString());
    return this.summary(id);
  }
  /** Pinned or lately opened files that are still there. */
  marked(which: "pinned" | "opened", limit = 50): LocalSummary[] {
    if (!HERE) return [];
    this.schema();
    const rows = this.db.all(`SELECT id FROM local_marks WHERE ${which} IS NOT NULL ORDER BY ${which} ${which === "opened" ? "DESC" : "ASC"} LIMIT ?`, Math.max(1, Math.min(200, limit)));
    const out: LocalSummary[] = [];
    for (const r of rows) {
      try {
        out.push(this.summary(String(r.id)));
      } catch {
        // Gone from disk, or its folder was closed: it comes back if the file does.
      }
    }
    return out;
  }

  /** What the start page's cards show: a text file's first lines (nothing for the rest, which draw themselves). */
  previews(ids: string[]): { id: string; kind: NoteSummary["kind"]; blocks: never[]; head: string | null }[] {
    const out: { id: string; kind: NoteSummary["kind"]; blocks: never[]; head: string | null }[] = [];
    for (const id of ids.slice(0, 40)) {
      try {
        const { full } = this.at(id);
        const row = this.summary(id);
        let head: string | null = null;
        if (row.local.type === "etude") {
          try {
            const n = this.get(id);
            if (n.kind === "page") {
              out.push({ id, kind: "page", blocks: ((n.doc.content ?? []) as never[]).slice(0, 6), head: null });
              continue;
            }
            if (n.kind === "canvas" || n.kind === "kanban") {
              out.push({ id, kind: n.kind, blocks: [], head: null });
              continue;
            }
          } catch {}
        }
        if (row.local.type === "markdown" || row.local.type === "text") {
          const buf = new Uint8Array(Math.min(row.local.size, 4096));
          const fd = fs.openSync(full, "r");
          try {
            fs.readSync(fd, buf, 0, buf.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          // A cut in the middle of a character at the end is dropped, not shown as a broken one.
          head = new TextDecoder("utf-8").decode(buf).replace(/\uFFFD+$/, "").split("\n").slice(0, 10).map((l) => l.slice(0, 160)).join("\n");
        }
        out.push({ id, kind: row.kind, blocks: [], head });
      } catch {
        // Gone: no card.
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the file itself

  /** What the server needs to send a file's bytes. */
  raw(id: string): { path: string; size: number; mime: string; name: string; mtime: number } {
    const { full } = this.at(id);
    const st = statOrNull(full);
    if (!st || st.isDirectory()) throw new EtudeError("no file there", 404);
    const name = basename(full);
    return { path: full, size: st.size, mime: MIME[extOf(name)] ?? (PAGE.test(name) ? "application/json; charset=utf-8" : ["markdown", "text", "web"].includes(localType(name)) ? "text/plain; charset=utf-8" : "application/octet-stream"), name, mtime: st.mtimeMs };
  }

  // ---------------------------------------------------------------- finding files

  /**
   * Every file in a folder, as paths inside it. Listed with ripgrep when it's installed, by walking otherwise.
   * Kept for half a minute (the old list answers while a new one is made) and dropped after ten minutes without
   * a search, so a very large folder doesn't sit in memory.
   */
  private async files(folder: LocalFolder): Promise<string[]> {
    let c = this.names.get(folder.id);
    if (!c) this.names.set(folder.id, (c = { at: 0, files: [], partial: false }));
    const cache = c;
    clearTimeout(cache.drop);
    cache.drop = setTimeout(() => this.names.get(folder.id) === cache && this.names.delete(folder.id), 10 * 60_000);
    (cache.drop as { unref?: () => void }).unref?.();
    if (!cache.building && Date.now() - cache.at >= 30_000)
      cache.building = listFiles(folder).then(
        (r) => void Object.assign(cache, { at: Date.now(), files: r.files, partial: r.partial, building: undefined }),
        () => void (cache.building = undefined),
      );
    if (!cache.at && cache.building) await cache.building;
    return cache.files;
  }

  /**
   * What a link in a Markdown file points at: a path beside the file, a path from the folder's top, or (as Obsidian
   * does for [[links]]) a file of that name anywhere in the folder, the nearest one first. Null when nothing fits.
   */
  async resolveLink(fromId: string, target: string): Promise<string | null> {
    const { folder, rel } = this.at(fromId);
    let t = String(target ?? "").trim();
    try {
      t = decodeURI(t);
    } catch {}
    t = t.split("|")[0].split("#")[0].trim().replace(/\\/g, "/");
    if (!t) return fromId;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
    const here = parentRel(rel);
    const tries: string[] = [];
    const add = (p: string) => {
      const parts: string[] = [];
      for (const s of p.split("/")) {
        if (s === "" || s === ".") continue;
        if (s === "..") {
          if (!parts.length) return;
          parts.pop();
        } else parts.push(s);
      }
      const clean = parts.join("/");
      if (clean) tries.push(clean, `${clean}.md`, `${clean}${PAGE_EXT}`);
    };
    if (!t.startsWith("/")) add(here ? `${here}/${t}` : t);
    add(t.replace(/^\/+/, ""));
    const root = resolve(folder.path);
    const realRoot = (() => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    })();
    const insideDir = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
    for (const p of tries) {
      const segs = p.split("/");
      if (!folder.hidden && segs.some((s) => s.startsWith("."))) continue;
      const cand = resolve(root, ...segs);
      const st = statOrNull(cand);
      if (st && !st.isDirectory()) {
        try {
          if (!insideDir(fs.realpathSync(cand), realRoot)) continue;
        } catch {
          continue;
        }
        return fsId(folder.id, p);
      }
    }
    const want = key(t.replace(/^\/+/, ""));
    let best: string | null = null;
    let bestScore = Infinity;
    for (const f of await this.files(folder)) {
      // The path ends with the name asked for (or that name + .md), at a folder boundary. Only the tail is compared.
      const ext = f.charCodeAt(f.length - 3) === 46 ? 3 : f.charCodeAt(f.length - 6) === 46 ? 6 : 0;
      const hit = endsWithName(f, want) || (ext > 0 && f.length > ext && /\.(md|etude)$/i.test(f) && endsWithName(f.slice(0, -ext), want));
      if (!hit) continue;
      // Nearest first: the same folder, then the fewest steps away, then the shortest path.
      const score = (parentRel(f) === here ? 0 : 1000 + distance(here, parentRel(f)) * 10) + f.length / 1000;
      if (score < bestScore) (best = f), (bestScore = score);
    }
    return best ? fsId(folder.id, best) : null;
  }

  /**
   * Hands `read` the text of every page, Markdown and web file in the open folders that has one of `needles` in it
   * (the collection's media URLs, `/media/<top folder>`), so `media prune` counts what they show as used: a page on
   * disk shows pictures from the collection's media folder, and once it left the collection (`folder take`) or was
   * made on disk, nothing in the database names them. Each folder's trash is read too, since a page can come back
   * from it. False when a folder on this computer isn't there right now (a drive not plugged in) or couldn't be read
   * in time: its pages are unknown, so nothing may count as unused.
   */
  mediaMentions(needles: string[], read: (text: string) => void): boolean {
    if (!HERE || !needles.length) return true;
    let complete = true;
    for (const folder of this.list()) {
      if (folder.elsewhere) continue;
      if (folder.missing) {
        complete = false;
        continue;
      }
      const found = mentioning(folder, needles);
      if (!found) {
        complete = false;
        continue;
      }
      for (const rel of found) {
        try {
          const full = resolve(folder.path, ...rel.split("/"));
          if (fs.statSync(full).size <= MAX_MENTION_BYTES) read(fs.readFileSync(full, "utf8"));
        } catch {}
      }
    }
    return complete;
  }

  /** The .etude files of the open folders that have any of these strings in them (a note's id, to follow it where it moved). */
  async referring(needles: string[]): Promise<string[]> {
    const want = [...new Set(needles.filter((n) => n.length >= 8))];
    if (!HERE || !want.length) return [];
    const out: string[] = [];
    for (const folder of this.list().filter((f) => !f.missing)) {
      const trashTop = folder.trash.split("/")[0];
      const found: string[] = [];
      // ripgrep takes a few hundred patterns at once; a file that has several is still listed once.
      let listed = true;
      for (let i = 0; i < want.length && listed; i += 200) {
        const args = ["-l", "-F", "--no-ignore", "--no-messages", ...(folder.hidden ? ["--hidden"] : []), ...HEAVY.flatMap((h) => ["-g", `!${h}`]), "-g", `!/${trashTop}`, "-g", `*${PAGE_EXT}`, ...want.slice(i, i + 200).flatMap((n) => ["-e", n]), "."];
        const r = await stream("rg", args, { cwd: folder.path, ms: 30_000, split: "\n" }, (line) => {
          const rel = line.trim().split(sep).join("/").replace(/^\.\//, "");
          if (rel) found.push(rel);
        });
        if (!r || r.cut) listed = false;
      }
      if (!listed) {
        found.length = 0;
        for (const rel of (await walk(folder)).files) {
          if (!PAGE.test(rel)) continue;
          try {
            const text = fs.readFileSync(resolve(folder.path, ...rel.split("/")), "utf8");
            if (want.some((n) => text.includes(n))) found.push(rel);
          } catch {}
        }
      }
      for (const rel of new Set(found)) out.push(fsId(folder.id, rel));
    }
    return out;
  }

  /** Files by name, then Markdown and text files by the words in them. */
  async search(q: string, limit = 20): Promise<(LocalSummary & { snippet: string })[]> {
    const query = String(q ?? "").trim();
    if (!HERE || !query) return [];
    const max = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const words = fold(query).split(/\s+/).filter(Boolean);
    const out: (LocalSummary & { snippet: string })[] = [];
    const seen = new Set<string>();
    const push = (folder: LocalFolder, rel: string, snippet: string) => {
      const id = fsId(folder.id, rel);
      if (seen.has(id) || out.length >= max) return;
      const st = statOrNull(resolve(folder.path, ...rel.split("/")));
      if (!st || st.isDirectory()) return;
      seen.add(id);
      out.push({ ...this.row(folder, rel, st, out.length), snippet });
    };
    const folders = this.list().filter((f) => !f.missing);
    for (const folder of folders) {
      const hits: { rel: string; score: number }[] = [];
      for (const rel of await this.files(folder)) {
        const name = key(rel.slice(rel.lastIndexOf("/") + 1));
        if (!name.includes(words[0]) || !words.every((w) => name.includes(w))) continue;
        hits.push({ rel, score: (name.startsWith(words[0]) ? 0 : 1) + (MARKDOWN.test(name) ? 0 : 0.5) + name.length / 200 + rel.length / 2000 });
      }
      hits.sort((a, b) => a.score - b.score);
      // A name match has no line to show: where the file is says enough.
      for (const h of hits.slice(0, max)) push(folder, h.rel, "");
    }
    if (out.length < max && query.length >= 2) {
      for (const folder of folders) for (const h of await grep(folder, query, (max - out.length) * 3)) push(folder, h.rel, h.line);
    }
    return this.withMarks(out);
  }
}

// ---------------------------------------------------------------- helpers

function statOrNull(path: string): fs.Stats | null {
  try {
    return fs.statSync(path);
  } catch {
    return null;
  }
}
const isDir = (path: string) => !!statOrNull(path)?.isDirectory();
const reason = (e: unknown) => String((e as { code?: string })?.code ?? (e as Error)?.message ?? e);
const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, "\\$&")}%`;

/** True when `path` is `want` or ends with "/" + `want`, ignoring case and accents (`want` already is a key). */
function endsWithName(path: string, want: string): boolean {
  // Accents can change a name's length ("é" as two code points), so a path that isn't plain ASCII is folded whole.
  if (/[^\x00-\x7f]/.test(path)) {
    const k = fold(path);
    return k === want || k.endsWith(`/${want}`);
  }
  const at = path.length - want.length;
  if (at < 0 || (at > 0 && path.charCodeAt(at - 1) !== 47)) return false;
  return (at ? path.slice(at) : path).toLowerCase() === want;
}

/** How many folders apart two places are. */
function distance(a: string, b: string): number {
  const x = a ? a.split("/") : [];
  const y = b ? b.split("/") : [];
  let same = 0;
  while (same < x.length && same < y.length && x[same] === y[same]) same++;
  return x.length - same + (y.length - same);
}

/** `name` if nothing in `dir` has it, else "name 1", "name 2"… before the extension. */
export function freeName(dir: string, name: string): string {
  if (!fs.existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const next = `${stem} ${i}${ext}`;
    if (!fs.existsSync(join(dir, next))) return next;
  }
  throw new EtudeError(`too many files called "${name}"`, 409);
}

/**
 * Replaces a file's contents in one step: written beside it and renamed over it, so a crash never leaves half a
 * file. A link keeps pointing where it did, and a file with hard links (or another owner) is written in place.
 */
function writeWhole(path: string, text: string, st: fs.Stats) {
  const real = fs.realpathSync(path);
  const mine = typeof process.getuid !== "function" || st.uid === process.getuid();
  if ((st.nlink ?? 1) > 1 || !mine) return fs.writeFileSync(real, text);
  const tmp = join(dirname(real), `.${basename(real)}.${randomUUID().slice(0, 8)}.etude-tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: st.mode & 0o777, flag: "wx" });
  } catch {
    // The folder doesn't take new files (read-only but for this one): write it where it is.
    return fs.writeFileSync(real, text);
  }
  try {
    fs.renameSync(tmp, real);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Runs a program and hands its output over piece by piece (split on `split`), so a long list never sits in memory
 * whole. `each` returns false to stop early. Resolves null when the program isn't there.
 */
function stream(cmd: string, args: string[], opts: { cwd: string; ms: number; split: string }, each: (piece: string) => boolean | void): Promise<{ cut: boolean } | null> {
  return new Promise((done) => {
    // ETUDE_RG=off: as on a computer without ripgrep.
    if (process.env.ETUDE_RG === "off") return done(null);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return done(null);
    }
    let rest = "";
    let cut = false;
    let over = false;
    const stop = () => {
      cut = true;
      child.kill();
    };
    const timer = setTimeout(stop, opts.ms);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      if (cut) return;
      const parts = (rest + d).split(opts.split);
      rest = parts.pop() ?? "";
      for (const p of parts) if (p && each(p) === false) return stop();
    });
    const end = (ok: boolean) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (ok && !cut && rest) each(rest);
      done(ok ? { cut } : null);
    };
    child.on("error", () => end(false));
    child.on("close", () => end(true));
  });
}

const MAX_LISTED = 600_000;
/** Kinds of file whose text can show the collection's media: pages, Markdown and web files. */
const MENTIONING = /\.(etude|md|markdown|html?)$/i;
const MAX_MENTION_BYTES = 32 * 1024 * 1024;

/**
 * The files of a folder (pages, Markdown, web files) with one of `needles` in them, the trash included, or null when
 * they couldn't all be read (ripgrep and the walk both gave up). Synchronous: `media prune` asks while it decides.
 */
function mentioning(folder: LocalFolder, needles: string[]): string[] | null {
  const root = resolve(folder.path);
  const trash = folder.trash.split("/")[0];
  const paths = ["."];
  // ripgrep skips dot-names unless asked, so a hidden trash is named on its own.
  if (!folder.hidden && trash.startsWith(".") && isDir(join(root, trash))) paths.push(trash);
  const r = spawnSync("rg", ["-l", "-F", "--no-ignore", "--no-messages", ...(folder.hidden ? ["--hidden", "-g", "!.git"] : []), ...HEAVY.flatMap((h) => ["-g", `!${h}`]),
    "-g", "*.{etude,md,markdown,html,htm}", "-g", "*.{ETUDE,MD,MARKDOWN,HTML,HTM}", ...needles.flatMap((n) => ["-e", n]), "--", ...paths], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  // 0: found some; 1: found none; 2: some files couldn't be read (they can't be read here either).
  if (!r.error && r.signal === null && (r.status === 0 || r.status === 1 || (r.status === 2 && r.stdout))) {
    const out = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      const rel = line.trim().split(sep).join("/").replace(/^\.\//, "");
      if (rel) out.add(rel);
    }
    return [...out];
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  // No ripgrep: walk it, the same way the tree shows it, plus the trash.
  const out: string[] = [];
  const todo = [""];
  const started = Date.now();
  while (todo.length) {
    if (Date.now() - started > 60_000) return null;
    const rel = todo.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(rel ? join(root, ...rel.split("/")) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of ents) {
      const name = String(d.name);
      if (name === ".git" || HEAVY.includes(name) || (!folder.hidden && name.startsWith(".") && !(!rel && name === trash))) continue;
      const p = rel ? `${rel}/${name}` : name;
      if (d.isDirectory()) todo.push(p);
      else if (d.isFile() && MENTIONING.test(name)) {
        try {
          const full = join(root, ...p.split("/"));
          if (fs.statSync(full).size <= MAX_MENTION_BYTES) {
            const text = fs.readFileSync(full, "utf8");
            if (needles.some((n) => text.includes(n))) out.push(p);
          }
        } catch {}
      }
    }
  }
  return out;
}

async function listFiles(folder: LocalFolder): Promise<{ files: string[]; partial: boolean }> {
  const trashTop = folder.trash.split("/")[0];
  const args = ["--files", "--no-ignore", "--no-messages", "--null", ...(folder.hidden ? ["--hidden", "-g", "!.git"] : []), ...HEAVY.flatMap((h) => ["-g", `!${h}`]), "-g", `!/${trashTop}`];
  const files: string[] = [];
  const r = await stream("rg", args, { cwd: folder.path, ms: 20_000, split: "\0" }, (f) => {
    files.push((sep === "\\" ? f.split(sep).join("/") : f).replace(/^\.\//, ""));
    return files.length < MAX_LISTED;
  });
  // ripgrep answered (an empty answer only counts for an empty folder): use it.
  if (r && (files.length || !fs.readdirSync(folder.path).length)) return { files, partial: r.cut };
  return walk(folder);
}

/** Without ripgrep: every file, folder by folder, giving the server a breath between batches. */
async function walk(folder: LocalFolder): Promise<{ files: string[]; partial: boolean }> {
  const root = resolve(folder.path);
  const files: string[] = [];
  const todo = [""];
  const trashTop = folder.trash.split("/")[0];
  let n = 0;
  while (todo.length) {
    const rel = todo.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(rel ? join(root, ...rel.split("/")) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of ents) {
      const name = String(d.name);
      if ((!folder.hidden && name.startsWith(".")) || name === ".git" || HEAVY.includes(name) || (!rel && name === trashTop)) continue;
      const p = rel ? `${rel}/${name}` : name;
      if (d.isDirectory()) todo.push(p);
      else if (d.isFile()) files.push(p);
      if (files.length >= MAX_LISTED) return { files, partial: true };
    }
    if (++n % 200 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { files, partial: false };
}

/** The line a search matched, as it reads: in a page's file the words sit in JSON (`"text": "…"`), shown without it. */
function snippetOf(rel: string, line: string): string {
  let t = line.trim();
  if (PAGE.test(rel)) {
    const m = /^"text":\s*("(?:[^"\\]|\\.)*")/.exec(t);
    if (m) {
      try {
        t = String(JSON.parse(m[1]));
      } catch {}
    }
  }
  return t.slice(0, 240);
}

/** Markdown and text files with the words in them, one line each. ripgrep when it's there; else the Markdown files are read, for a moment at most. */
async function grep(folder: LocalFolder, query: string, limit: number): Promise<{ rel: string; line: string }[]> {
  const trashTop = folder.trash.split("/")[0];
  const args = ["--json", "-i", "-F", "--max-count", "1", "--max-columns", "400", "--max-filesize", "2M", "--no-ignore", "--no-messages", ...HEAVY.flatMap((h) => ["-g", `!${h}`]), "-g", `!/${trashTop}`, "-g", "*.{md,markdown,txt,org,tex,rst,etude}", "-e", query, "."];
  const out: { rel: string; line: string }[] = [];
  const r = await stream("rg", args, { cwd: folder.path, ms: 4000, split: "\n" }, (row) => {
    if (!row.startsWith('{"type":"match"')) return;
    try {
      const m = JSON.parse(row).data;
      const rel = String(m.path?.text ?? "").split(sep).join("/").replace(/^\.\//, "");
      if (rel) out.push({ rel, line: snippetOf(rel, String(m.lines?.text ?? "")) });
    } catch {}
    return out.length < limit;
  });
  if (r) return out;
  const { files } = await walk(folder);
  const needle = query.toLowerCase();
  const until = Date.now() + 1500;
  for (const rel of files) {
    if (out.length >= limit || Date.now() > until) break;
    if (!MARKDOWN.test(rel) && !PAGE.test(rel)) continue;
    try {
      const full = resolve(folder.path, ...rel.split("/"));
      if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(full, "utf8");
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const from = text.lastIndexOf("\n", at) + 1;
      const to = text.indexOf("\n", at);
      out.push({ rel, line: snippetOf(rel, text.slice(from, to < 0 ? undefined : to)) });
    } catch {}
  }
  return out;
}
