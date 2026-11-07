// Notes (beta): pages you write in, in a tree of their own beside the decks.
// A page's body is a document tree (ProseMirror JSON, what the editor works in), never raw HTML, so it can be
// rendered safely, searched and later merged across devices. `text` is the plain text, for search and previews.
// Not synced yet (the notes table isn't in sync/log.ts TABLES); that comes with the Sync milestone.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { EtudeError, deckIcon } from "./engine.ts";
import { docLinks, markdownToDoc, resolveLinks, frontMatter } from "./notes-md.ts";
import { BANNER_PRESETS } from "./banner.ts";

export const NOTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id        TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  title     TEXT NOT NULL DEFAULT '',
  icon      TEXT,
  doc       TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
  text      TEXT NOT NULL DEFAULT '',
  position  INTEGER NOT NULL DEFAULT 0,
  archived  INTEGER NOT NULL DEFAULT 0,
  created   TEXT NOT NULL,
  updated   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_parent ON notes(parent_id, position);
-- [[links]] between pages: to_id when the target exists, to_title always (an unresolved link resolves when a page gets that title).
CREATE TABLE IF NOT EXISTS note_links (
  from_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id    TEXT,
  to_title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_links_from ON note_links(from_id);
CREATE INDEX IF NOT EXISTS note_links_to ON note_links(to_id);
CREATE INDEX IF NOT EXISTS note_links_title ON note_links(to_title COLLATE NOCASE);
`;

/** A document node as the editor stores it. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** A page you write in, or a folder that only holds pages (it has no body of its own). */
export type NoteKind = "page" | "folder" | "canvas";

export interface NoteSummary {
  id: string;
  kind: NoteKind;
  parentId: string | null;
  title: string;
  icon: string | null;
  /** How the page looks: cover, width, font and text size. */
  look: NoteLook;
  position: number;
  archived: boolean;
  created: string;
  updated: string;
  /** How many pages sit right under it (archived ones left out). */
  children: number;
  /** Nothing written in it yet (only an empty page can become a folder). */
  empty?: boolean;
}
export interface Note extends NoteSummary {
  doc: DocNode;
  text: string;
  /** A canvas's drawing (null on a page). */
  scene: CanvasScene | null;
}

/**
 * A canvas's drawing, in Excalidraw's own element format so nothing is lost going in and out of it.
 * Pictures aren't kept inline: each file points at the collection's media (files/<sha>.<ext>).
 */
export interface CanvasScene {
  type: "excalidraw";
  version: 2;
  elements: Record<string, unknown>[];
  appState: { viewBackgroundColor?: string; gridSize?: number | null; gridModeEnabled?: boolean };
  files: Record<string, { mimeType: string; media: string; created?: number }>;
}
export const emptyScene = (): CanvasScene => ({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });

const MEDIA_FILE = /^files\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif|bmp|svg)$/;

/** Checks a canvas's drawing from outside (API, CLI). Pictures must already be in the media. */
export function checkScene(v: unknown): CanvasScene {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new EtudeError("a canvas's scene must be an object: { elements: [...], appState, files }");
  const o = v as Record<string, unknown>;
  const json = JSON.stringify(o);
  if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw new EtudeError("that canvas is too big (5 MB at most; pictures go in the media, not inline)", 413);
  if (!Array.isArray(o.elements) || o.elements.some((e) => !e || typeof e !== "object" || typeof (e as any).type !== "string" || typeof (e as any).id !== "string")) throw new EtudeError("a canvas's elements must be a list of Excalidraw elements");
  const files: CanvasScene["files"] = {};
  if (o.files != null) {
    if (typeof o.files !== "object" || Array.isArray(o.files)) throw new EtudeError("a canvas's files must be an object");
    for (const [id, f] of Object.entries(o.files as Record<string, any>)) {
      const media = String(f?.media ?? "").replace(/^\/?media\//, "");
      if (!MEDIA_FILE.test(media)) throw new EtudeError(`canvas file ${id.slice(0, 40)}: a picture is a file in the collection's media (files/<sha256>.<ext>), not inline data`);
      files[id] = { mimeType: String(f.mimeType ?? "image/png").slice(0, 60), media, ...(Number.isFinite(f.created) ? { created: f.created } : {}) };
    }
  }
  const a = (o.appState && typeof o.appState === "object" ? o.appState : {}) as Record<string, unknown>;
  const appState: CanvasScene["appState"] = {};
  if (typeof a.viewBackgroundColor === "string" && a.viewBackgroundColor.length <= 40) appState.viewBackgroundColor = a.viewBackgroundColor;
  if (typeof a.gridSize === "number" && a.gridSize > 0 && a.gridSize < 1000) appState.gridSize = a.gridSize;
  if (typeof a.gridModeEnabled === "boolean") appState.gridModeEnabled = a.gridModeEnabled;
  const elements = (o.elements as Record<string, unknown>[]).filter((e) => !e.isDeleted);
  return { type: "excalidraw", version: 2, elements: JSON.parse(JSON.stringify(elements)), appState, files };
}

/** A canvas's words (its text elements), for search and previews. */
export function sceneText(s: CanvasScene): string {
  return s.elements
    .filter((e) => e.type === "text" && typeof e.text === "string" && !e.containerId)
    .concat(s.elements.filter((e) => e.type === "text" && typeof e.text === "string" && e.containerId))
    .map((e) => String(e.text).trim())
    .filter(Boolean)
    .join("\n");
}

/** A canvas as a standalone .excalidraw file (pictures inline as data: URLs, so it opens on excalidraw.com). */
export function sceneToExcalidraw(s: CanvasScene, read: (media: string) => Uint8Array | null): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const [id, f] of Object.entries(s.files)) {
    const data = read(f.media);
    if (data) files[id] = { id, mimeType: f.mimeType, dataURL: `data:${f.mimeType};base64,${Buffer.from(data).toString("base64")}`, created: f.created ?? Date.now() };
  }
  return { type: "excalidraw", version: 2, source: "https://etude.study", elements: s.elements, appState: s.appState, files };
}

/**
 * A .excalidraw file (what excalidraw.com and Obsidian's Excalidraw plugin save) as a canvas. Inline pictures
 * (data: URLs) go into the media through `store`; pictures it can't read are left out.
 */
export function sceneFromExcalidraw(raw: unknown, store: (name: string, data: Uint8Array) => { file: string }): CanvasScene {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, any>;
  if (!o || typeof o !== "object" || !Array.isArray(o.elements)) throw new EtudeError("that isn't an Excalidraw drawing (no elements)");
  const files: Record<string, any> = {};
  for (const [id, f] of Object.entries((o.files ?? {}) as Record<string, any>)) {
    if (typeof f?.media === "string") files[id] = f;
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(String(f?.dataURL ?? ""));
    if (!m) continue;
    const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" } as Record<string, string>)[m[1]];
    if (!ext) continue;
    const stored = store(`${id.slice(0, 24)}.${ext}`, Buffer.from(m[2], "base64"));
    files[id] = { mimeType: m[1], media: stored.file, created: f.created };
  }
  return checkScene({ elements: o.elements, appState: o.appState ?? {}, files });
}

/** A page's look. Every field is optional; a missing one is the default (no cover, normal width, the app font, normal size). */
export interface NoteLook {
  cover?: { kind: "preset"; id: string } | { kind: "image"; media: string; y: number };
  width?: "normal" | "wide" | "full";
  font?: "sans" | "serif" | "mono";
  size?: "small" | "normal" | "large";
}
const WIDTHS = ["normal", "wide", "full"];
const FONTS = ["sans", "serif", "mono"];
const SIZES = ["small", "normal", "large"];
const COVER_IMAGE = /^files\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|avif|bmp)$/;

/** Checks a page's look from outside. Unknown keys are an error, so a typo doesn't silently do nothing. */
export function normalizeLook(v: unknown): NoteLook {
  if (v == null || v === "") return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new EtudeError("a note's look must be an object like { width: \"wide\", font: \"serif\" }");
  const o = v as Record<string, unknown>;
  const out: NoteLook = {};
  for (const k of Object.keys(o)) if (!["cover", "width", "font", "size"].includes(k)) throw new EtudeError(`a note's look has no "${k.slice(0, 20)}" (it has cover, width, font, size)`);
  const pick = (k: "width" | "font" | "size", allowed: string[]) => {
    const x = o[k];
    if (x == null || x === "" || x === "default") return;
    if (typeof x !== "string" || !allowed.includes(x)) throw new EtudeError(`look.${k} is one of ${allowed.join(", ")}`);
    if (!(k === "width" && x === "normal") && !(k === "size" && x === "normal") && !(k === "font" && x === "sans")) (out as any)[k] = x;
  };
  pick("width", WIDTHS);
  pick("font", FONTS);
  pick("size", SIZES);
  const c = o.cover;
  if (c != null && c !== "" && c !== "none") {
    if (typeof c === "string") {
      if (c.startsWith("image:")) {
        const m = /^image:(?:media:)?(.+?)(?::(-?\d+(?:\.\d+)?))?$/.exec(c)!;
        out.cover = normalizeLook({ cover: { kind: "image", media: m[1], y: m[2] === undefined ? 50 : Number(m[2]) } }).cover;
      } else out.cover = normalizeLook({ cover: { kind: "preset", id: c.replace(/^preset:/, "") } }).cover;
    } else if (typeof c === "object" && !Array.isArray(c)) {
      const x = c as Record<string, unknown>;
      if (x.kind === "preset") {
        const id = String(x.id ?? "").trim().toLowerCase();
        if (!BANNER_PRESETS.some((p) => p.id === id)) throw new EtudeError(`no cover "${id.slice(0, 30)}" (covers: ${BANNER_PRESETS.map((p) => p.id).join(", ")})`);
        out.cover = { kind: "preset", id };
      } else if (x.kind === "image") {
        const media = String(x.media ?? "").trim().replace(/^media:/, "");
        if (!COVER_IMAGE.test(media)) throw new EtudeError("a cover image is a picture in the collection's media, files/<sha256>.<ext>");
        const y = x.y == null ? 50 : Number(x.y);
        if (!Number.isFinite(y) || y < 0 || y > 100) throw new EtudeError("a cover image's y is 0 (top) to 100 (bottom)");
        out.cover = { kind: "image", media, y: Math.round(y * 10) / 10 };
      } else throw new EtudeError("a cover is { kind: \"preset\", id } or { kind: \"image\", media, y }");
    } else throw new EtudeError("a cover is { kind: \"preset\", id } or { kind: \"image\", media, y }");
  }
  return out;
}
const lookOf = (s: unknown): NoteLook => {
  try {
    return typeof s === "string" && s ? normalizeLook(JSON.parse(s)) : {};
  } catch {
    return {};
  }
};

const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_TITLE = 300;
const BLOCKS = new Set(["image", "mathBlock", "detailsSummary", "tableCell", "tableHeader", "paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "horizontalRule"]);

/** The plain text of a document: blocks on their own lines. */
export function docText(doc: DocNode): string {
  const out: string[] = [];
  const walk = (n: DocNode, line: string[]): void => {
    if (n.type === "text") return void line.push(n.text ?? "");
    if (n.type === "hardBreak") return void line.push("\n");
    if (n.type === "noteLink") return void line.push(String(n.attrs?.label || n.attrs?.title || ""));
    if (n.type === "mathInline") return void line.push(String(n.attrs?.latex ?? ""));
    if (n.type === "mathBlock") return void out.push(String(n.attrs?.latex ?? ""));
    if (n.type === "canvasEmbed") return void (n.attrs?.title && out.push(String(n.attrs.title)));
    const kids = n.content ?? [];
    if (BLOCKS.has(n.type) && kids.every((k) => k.type === "text" || k.type === "hardBreak" || !BLOCKS.has(k.type))) {
      const l: string[] = [];
      for (const k of kids) walk(k, l);
      const s = l.join("");
      if (s.trim()) out.push(s);
      return;
    }
    for (const k of kids) walk(k, line);
  };
  walk(doc, []);
  return out.join("\n");
}

/** Checks the shape of a document from outside (API, CLI): a tree of typed nodes, not too big. */
export function checkDoc(doc: unknown): DocNode {
  if (!doc || typeof doc !== "object" || (doc as DocNode).type !== "doc") throw new EtudeError("a note's doc must be a document: { type: \"doc\", content: [...] }");
  const json = JSON.stringify(doc);
  if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw new EtudeError("that note is too big (5 MB at most)", 413);
  const bad = (n: unknown, depth: number): boolean => {
    if (depth > 200 || !n || typeof n !== "object") return true;
    const x = n as DocNode;
    if (typeof x.type !== "string" || !/^[A-Za-z][\w-]{0,40}$/.test(x.type)) return true;
    if (x.text !== undefined && typeof x.text !== "string") return true;
    if (x.content !== undefined && (!Array.isArray(x.content) || x.content.some((k) => bad(k, depth + 1)))) return true;
    return false;
  };
  if (bad(doc, 0)) throw new EtudeError("that note's doc isn't a valid document tree");
  return JSON.parse(json);
}

/** Plain text (one paragraph per line, `# ` headings, `- ` bullets, `[ ]` tasks) as a document. For the CLI and quick notes. */
export function docFromText(text: string): DocNode {
  const content: DocNode[] = [];
  const para = (s: string): DocNode => ({ type: "paragraph", content: s ? [{ type: "text", text: s }] : [] });
  let list: DocNode | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(raw);
    const bullet = !task && /^\s*[-*]\s+(.*)$/.exec(raw);
    if (task) {
      if (list?.type !== "taskList") content.push((list = { type: "taskList", content: [] }));
      list.content!.push({ type: "taskItem", attrs: { checked: task[1] !== " " }, content: [para(task[2])] });
      continue;
    }
    if (bullet) {
      if (list?.type !== "bulletList") content.push((list = { type: "bulletList", content: [] }));
      list.content!.push({ type: "listItem", content: [para(bullet[1])] });
      continue;
    }
    list = null;
    if (h) content.push({ type: "heading", attrs: { level: h[1].length }, content: h[2] ? [{ type: "text", text: h[2] }] : [] });
    else if (raw.trim() || content.length) content.push(para(raw));
  }
  while (content.length && content[content.length - 1].type === "paragraph" && !content[content.length - 1].content?.length) content.pop();
  return { type: "doc", content };
}

const now = () => new Date().toISOString();
function checkKind(k: unknown): NoteKind {
  if (k === undefined || k === null || k === "page") return "page";
  if (k === "folder") return "folder";
  if (k === "canvas") return "canvas";
  throw new EtudeError('a note is a "page", a "folder" or a "canvas"');
}
const kindOf = (k: unknown): NoteKind => (k === "folder" ? "folder" : k === "canvas" ? "canvas" : "page");
const row = (r: any): NoteSummary => ({
  id: r.id,
  kind: kindOf(r.kind),
  parentId: r.parent_id ?? null,
  title: r.title,
  icon: r.icon ?? null,
  look: lookOf(r.look),
  position: r.position,
  archived: !!r.archived,
  created: r.created,
  updated: r.updated,
  children: r.children ?? 0,
  ...(r.empty !== undefined ? { empty: !!r.empty } : typeof r.text === "string" ? { empty: !r.text.trim() } : {}),
});

export class Notes {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    db.sql.exec(NOTES_SCHEMA);
    const cols = db.all("PRAGMA table_info(notes)").map((c) => c.name);
    if (!cols.includes("look")) db.sql.exec("ALTER TABLE notes ADD COLUMN look TEXT");
    if (!cols.includes("kind")) db.sql.exec("ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'page'");
    if (!cols.includes("scene")) db.sql.exec("ALTER TABLE notes ADD COLUMN scene TEXT");
  }

  /** Every page, in tree order (parents before children, siblings by position). */
  list(opts: { archived?: boolean } = {}): NoteSummary[] {
    const rows = this.db.all(
      `SELECT n.id, n.kind, n.parent_id, n.title, n.icon, n.look, n.position, n.archived, n.created, n.updated,
              (SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id AND c.archived = 0) AS children, (trim(n.text) = '') AS empty
         FROM notes n WHERE n.archived = ? ORDER BY n.position, n.created`,
      opts.archived ? 1 : 0,
    ).map(row);
    if (opts.archived) return rows;
    const by = new Map<string | null, NoteSummary[]>();
    const ids = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      const p = r.parentId && ids.has(r.parentId) ? r.parentId : null;
      if (!by.has(p)) by.set(p, []);
      by.get(p)!.push(r);
    }
    const out: NoteSummary[] = [];
    const walk = (p: string | null) => {
      for (const r of by.get(p) ?? []) {
        out.push(r);
        walk(r.id);
      }
    };
    walk(null);
    return out;
  }

  get(id: string): Note {
    const r = this.db.get(
      "SELECT n.*, (SELECT COUNT(*) FROM notes c WHERE c.parent_id = n.id AND c.archived = 0) AS children FROM notes n WHERE n.id = ?",
      id,
    );
    if (!r) throw new EtudeError(`no note "${id}"`, 404);
    return { ...row(r), doc: JSON.parse(r.doc), text: r.text, scene: r.kind === "canvas" ? (r.scene ? JSON.parse(r.scene) : emptyScene()) : null };
  }

  /** Finds a page by id, or by exact title when exactly one page has it. */
  resolve(ref: string): Note {
    if (this.db.get("SELECT 1 FROM notes WHERE id = ?", ref)) return this.get(ref);
    const hits = this.db.all("SELECT id FROM notes WHERE title = ? AND archived = 0", ref);
    if (hits.length === 1) return this.get(hits[0].id);
    if (hits.length > 1) throw new EtudeError(`${hits.length} notes are called "${ref}": use the id`, 409);
    throw new EtudeError(`no note "${ref}"`, 404);
  }

  create(input: { title?: string; parentId?: string | null; doc?: unknown; icon?: string | null; look?: unknown; after?: string | null; kind?: NoteKind; scene?: unknown } = {}): Note {
    return this.db.tx(() => {
      const parent = input.parentId || null;
      if (parent) this.get(parent);
      const kind = checkKind(input.kind);
      if (kind === "folder" && input.doc !== undefined) throw new EtudeError("a folder holds pages; it has no body of its own");
      if (kind === "canvas" && input.doc !== undefined) throw new EtudeError("a canvas has a scene, not a doc");
      if (kind !== "canvas" && input.scene !== undefined) throw new EtudeError("only a canvas has a scene (make it with kind \"canvas\")");
      const scene = kind === "canvas" ? (input.scene === undefined ? emptyScene() : checkScene(input.scene)) : null;
      const doc = input.doc === undefined ? { type: "doc", content: [] } : checkDoc(input.doc);
      const id = randomUUID();
      const t = now();
      let position: number;
      const after = input.after ? this.db.get("SELECT position FROM notes WHERE id = ? AND parent_id IS ?", input.after, parent) : null;
      if (after) {
        this.db.run("UPDATE notes SET position = position + 1 WHERE parent_id IS ? AND position > ?", parent, after.position);
        position = after.position + 1;
      } else position = (this.db.get("SELECT MAX(position) AS p FROM notes WHERE parent_id IS ?", parent)?.p ?? -1) + 1;
      this.db.run(
        "INSERT INTO notes (id, kind, parent_id, title, icon, look, doc, scene, text, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, kind, parent, cleanTitle(input.title ?? ""), cleanIcon(input.icon ?? null), lookJson(input.look), JSON.stringify(doc), scene ? JSON.stringify(scene) : null, scene ? sceneText(scene) : docText(doc as DocNode), position, t, t,
      );
      this.writeLinks(id, doc as DocNode);
      this.claimLinks(id);
      return this.get(id);
    });
  }

  update(id: string, patch: { title?: string; doc?: unknown; icon?: string | null; look?: unknown; kind?: NoteKind; scene?: unknown }): Note {
    return this.db.tx(() => {
      const cur = this.get(id);
      if (patch.scene !== undefined && cur.kind !== "canvas") throw new EtudeError("only a canvas has a scene");
      if (patch.doc !== undefined && cur.kind === "canvas") throw new EtudeError("a canvas has a scene, not a doc");
      if (patch.kind !== undefined && (cur.kind === "canvas") !== (patch.kind === "canvas")) throw new EtudeError("a canvas stays a canvas");
      const sets: string[] = [];
      const vals: any[] = [];
      if (patch.kind !== undefined) {
        const kind = checkKind(patch.kind);
        // A page becomes a folder only when there's nothing written in it, so nothing gets hidden.
        if (kind === "folder" && cur.kind === "page" && (cur.text.trim() || patch.doc !== undefined)) throw new EtudeError("only an empty page can become a folder");
        if (kind !== cur.kind) sets.push("kind = ?"), vals.push(kind);
      }
      if (patch.doc !== undefined && (patch.kind ?? cur.kind) === "folder") throw new EtudeError("a folder holds pages; it has no body of its own");
      if (patch.title !== undefined) sets.push("title = ?"), vals.push(cleanTitle(patch.title));
      if (patch.icon !== undefined) sets.push("icon = ?"), vals.push(cleanIcon(patch.icon));
      if (patch.look !== undefined) sets.push("look = ?"), vals.push(lookJson(patch.look));
      if (patch.doc !== undefined) {
        const doc = checkDoc(patch.doc);
        sets.push("doc = ?", "text = ?");
        vals.push(JSON.stringify(doc), docText(doc));
      }
      if (patch.scene !== undefined) {
        const scene = checkScene(patch.scene);
        sets.push("scene = ?", "text = ?");
        vals.push(JSON.stringify(scene), sceneText(scene));
      }
      if (!sets.length) return this.get(id);
      sets.push("updated = ?");
      vals.push(now());
      this.db.run(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
      if (patch.doc !== undefined) this.writeLinks(id, JSON.parse(this.db.get("SELECT doc FROM notes WHERE id = ?", id)!.doc));
      if (patch.title !== undefined) this.claimLinks(id);
      return this.get(id);
    });
  }

  /** Puts a page under `parentId` (null: top level) at `index` among its new siblings (default last). */
  move(id: string, parentId: string | null, index?: number): Note {
    return this.db.tx(() => {
      const n = this.get(id);
      const parent = parentId || null;
      if (parent) {
        for (let p: string | null = parent; p; p = this.db.get("SELECT parent_id FROM notes WHERE id = ?", p)?.parent_id ?? null)
          if (p === id) throw new EtudeError("a page can't go inside itself");
      }
      const sibs = this.db.all<{ id: string }>("SELECT id FROM notes WHERE parent_id IS ? AND id != ? AND archived = 0 ORDER BY position, created", parent, id).map((r) => r.id);
      const at = index === undefined || !Number.isFinite(index) ? sibs.length : Math.max(0, Math.min(sibs.length, Math.trunc(index)));
      sibs.splice(at, 0, id);
      this.db.run("UPDATE notes SET parent_id = ? WHERE id = ?", parent, id);
      sibs.forEach((s, i) => this.db.run("UPDATE notes SET position = ? WHERE id = ?", i, s));
      if (n.parentId !== parent) this.db.run("UPDATE notes SET updated = ? WHERE id = ?", now(), id);
      return this.get(id);
    });
  }

  /** Archives (or brings back) a page and every page under it. Nothing is deleted. */
  setArchived(id: string, archived: boolean): { ids: string[]; archived: boolean } {
    return this.db.tx(() => {
      const n = this.get(id);
      const ids = [id, ...this.descendants(id)];
      for (const x of ids) this.db.run("UPDATE notes SET archived = ? WHERE id = ?", archived ? 1 : 0, x);
      // Back from the archive under a parent that's still archived: it comes back at the top level.
      if (!archived && n.parentId && this.db.get("SELECT archived FROM notes WHERE id = ?", n.parentId)?.archived) this.db.run("UPDATE notes SET parent_id = NULL WHERE id = ?", id);
      return { ids, archived };
    });
  }

  /** Deletes a page for good, with every page under it. */
  delete(id: string): { ids: string[] } {
    return this.db.tx(() => {
      this.get(id);
      const ids = [id, ...this.descendants(id)];
      this.db.run("DELETE FROM notes WHERE id = ?", id);
      return { ids };
    });
  }

  /** Pages whose title or text has every word of `q`, best (title) matches first. */
  search(q: string, limit = 20): (NoteSummary & { snippet: string })[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const like = (w: string) => `%${w.replace(/[\\%_]/g, "\\$&")}%`;
    const cond = words.map(() => "(lower(title) LIKE ? ESCAPE '\\' OR lower(text) LIKE ? ESCAPE '\\')").join(" AND ");
    const rows = this.db.all(`SELECT id, kind, parent_id, title, icon, look, position, archived, created, updated, text FROM notes WHERE archived = 0 AND kind != 'folder' AND ${cond}`, ...words.flatMap((w) => [like(w), like(w)]));
    const score = (r: any) => words.filter((w) => r.title.toLowerCase().includes(w)).length;
    return rows
      .sort((a, b) => score(b) - score(a) || b.updated.localeCompare(a.updated))
      .slice(0, limit)
      .map((r) => {
        const t = String(r.text);
        const at = Math.max(0, t.toLowerCase().indexOf(words[0]) - 40);
        return { ...row(r), snippet: (at ? "…" : "") + t.slice(at, at + 140).replace(/\s+/g, " ") };
      });
  }

  /** Records the [[links]] a page's document holds. */
  private writeLinks(id: string, doc: DocNode) {
    this.db.run("DELETE FROM note_links WHERE from_id = ?", id);
    const walk = (n: DocNode) => {
      if (n.type === "noteLink") this.db.run("INSERT INTO note_links (from_id, to_id, to_title) VALUES (?, ?, ?)", id, (n.attrs?.id as string) || null, String(n.attrs?.title ?? ""));
      // An embedded canvas counts as a link, so the canvas lists the pages it's in.
      if (n.type === "canvasEmbed" && typeof n.attrs?.id === "string" && n.attrs.id) this.db.run("INSERT INTO note_links (from_id, to_id, to_title) VALUES (?, ?, ?)", id, n.attrs.id, String(n.attrs?.title ?? ""));
      n.content?.forEach(walk);
    };
    walk(doc);
  }

  /** A page got its title: unresolved links elsewhere that name it now point at it, in their documents too. */
  private claimLinks(id: string) {
    const title = this.db.get("SELECT title FROM notes WHERE id = ?", id)?.title;
    if (!title) return;
    const from = this.db.all<{ from_id: string }>("SELECT DISTINCT from_id FROM note_links WHERE to_id IS NULL AND to_title = ? COLLATE NOCASE", title);
    for (const { from_id } of from) {
      const r = this.db.get("SELECT doc FROM notes WHERE id = ?", from_id);
      if (!r) continue;
      const doc = JSON.parse(r.doc) as DocNode;
      if (resolveLinks(doc, (t) => (t.toLowerCase() === title.toLowerCase() ? id : null))) {
        this.db.run("UPDATE notes SET doc = ? WHERE id = ?", JSON.stringify(doc), from_id);
        this.writeLinks(from_id, doc);
      }
    }
  }

  /**
   * Every page as a point and every [[link]] as a line, for the graph view. A link to a page that doesn't exist yet
   * becomes a ghost point named by its title; `parent` lines show the page tree.
   */
  graph(): { nodes: { id: string; kind: NoteKind | "ghost"; title: string; icon: string | null; parentId: string | null; links: number; created: string | null; tags: string[] }[]; links: { from: string; to: string; kind: "link" | "parent" }[] } {
    const pages = this.db.all("SELECT id, kind, parent_id, title, icon, created, text FROM notes WHERE archived = 0");
    // #tags written in a page, like Obsidian's: a word that starts with # (letters, digits, - _ /), not a heading or a number.
    const tagsOf = (t: string) => [...new Set([...String(t).matchAll(/(?:^|[\s(])#([\p{L}_][\p{L}\p{N}_\-/]*)/gu)].map((m) => m[1].toLowerCase()))].slice(0, 20);
    const ids = new Set(pages.map((p) => p.id as string));
    const byTitle = new Map(pages.filter((p) => p.title).map((p) => [String(p.title).toLowerCase(), p.id as string]));
    const ghosts = new Map<string, string>();
    const seen = new Set<string>();
    const links: { from: string; to: string; kind: "link" | "parent" }[] = [];
    for (const l of this.db.all<{ from_id: string; to_id: string | null; to_title: string }>("SELECT from_id, to_id, to_title FROM note_links")) {
      if (!ids.has(l.from_id)) continue;
      let to = l.to_id && ids.has(l.to_id) ? l.to_id : byTitle.get(l.to_title.toLowerCase()) ?? null;
      if (!to) {
        const t = l.to_title.trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (!ghosts.has(key)) ghosts.set(key, `ghost:${t}`);
        to = ghosts.get(key)!;
      }
      if (to === l.from_id) continue;
      const k = `${l.from_id}>${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ from: l.from_id, to, kind: "link" });
    }
    for (const p of pages) if (p.parent_id && ids.has(p.parent_id)) links.push({ from: p.parent_id, to: p.id, kind: "parent" });
    const degree = new Map<string, number>();
    for (const l of links) if (l.kind === "link") for (const e of [l.from, l.to]) degree.set(e, (degree.get(e) ?? 0) + 1);
    const nodes = [
      ...pages.map((p) => ({ id: p.id as string, kind: kindOf(p.kind), title: String(p.title), icon: (p.icon as string) ?? null, parentId: p.parent_id && ids.has(p.parent_id) ? (p.parent_id as string) : null, links: degree.get(p.id) ?? 0, created: (p.created as string) ?? null, tags: tagsOf(p.text as string) })),
      ...[...ghosts.values()].map((id) => ({ id, kind: "ghost" as const, title: id.slice(6), icon: null, parentId: null, links: degree.get(id) ?? 0, created: null, tags: [] as string[] })),
    ];
    return { nodes, links };
  }

  /** Pages that link here, with the line around the link. */
  backlinks(id: string): (NoteSummary & { snippet: string })[] {
    const n = this.get(id);
    const rows = this.db.all(
      `SELECT DISTINCT s.id, s.kind, s.parent_id, s.title, s.icon, s.look, s.position, s.archived, s.created, s.updated, s.text
         FROM note_links l JOIN notes s ON s.id = l.from_id
        WHERE s.archived = 0 AND s.id != ? AND (l.to_id = ? OR (l.to_id IS NULL AND l.to_title = ? COLLATE NOCASE))
        ORDER BY s.updated DESC`,
      id, id, n.title,
    );
    return rows.map((r) => {
      const line = String(r.text).split("\n").find((l) => l.toLowerCase().includes(n.title.toLowerCase())) ?? String(r.text).split("\n")[0] ?? "";
      return { ...row(r), snippet: line.slice(0, 160) };
    });
  }

  /** Page ids by title (case-insensitive), first one when several share it. */
  private byTitle(): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.db.all<{ id: string; title: string }>("SELECT id, title FROM notes WHERE archived = 0 ORDER BY created")) if (!m.has(r.title.toLowerCase())) m.set(r.title.toLowerCase(), r.id);
    return m;
  }

  /**
   * Imports markdown files as pages: one page per file, folders become pages that hold their files (an Obsidian
   * vault keeps its shape). [[Links]] between the files, and to pages you already have, become page links.
   * `media` maps an image path as the files write it (or its file name) to a served URL.
   */
  importMarkdown(files: { path: string; text: string }[], opts: { parentId?: string | null; media?: Record<string, string> } = {}): { pages: number; folders: number; links: number; unresolved: number; root: string | null; ids: string[] } {
    return this.db.tx(() => {
      const parent = opts.parentId || null;
      if (parent) this.get(parent);
      const md = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.path) && !f.path.split("/").some((p) => p.startsWith(".")));
      if (!md.length) throw new EtudeError("no markdown files to import");
      // Drop a common top folder (the vault's own name) only when there's more than one file.
      const parts = md.map((f) => f.path.replace(/\\/g, "/").split("/").filter(Boolean));
      let common = 0;
      if (parts.length > 1) while (parts.every((p) => p.length > common + 1 && p[common] === parts[0][common])) common++;
      const root = common ? parts[0].slice(0, common).join("/") : null;
      const folders = new Map<string, string>();
      const ids: string[] = [];
      let rootId = parent;
      if (root) {
        rootId = this.create({ title: root.split("/").pop()!, parentId: parent, kind: "folder" }).id;
        ids.push(rootId);
      }
      const folder = (segs: string[]): string | null => {
        if (!segs.length) return rootId;
        const key = segs.join("/");
        let fid = folders.get(key);
        if (!fid) {
          fid = this.create({ title: segs[segs.length - 1], parentId: folder(segs.slice(0, -1)), kind: "folder" }).id;
          folders.set(key, fid);
          ids.push(fid);
        }
        return fid;
      };
      const made: { id: string; text: string }[] = [];
      const pageIds = new Set<string>();
      const sorted = md.map((f, i) => ({ f, segs: parts[i].slice(common) })).sort((a, b) => a.segs.join("/").localeCompare(b.segs.join("/"), undefined, { numeric: true }));
      for (const { f, segs } of sorted) {
        const name = segs[segs.length - 1].replace(/\.(md|markdown|txt)$/i, "");
        const where = segs.slice(0, -1);
        const key = [...where, name].join("/");
        const title = frontMatter(f.text).meta.title || name;
        // A folder note (Folder/Folder.md) fills the folder's own page; a page next to a folder of its name
        // (A.md beside A/) holds that folder's pages, because it's registered under the folder's path.
        let id: string;
        if (where.length && where[where.length - 1] === name) id = folder(where)!;
        else if (folders.has(key)) id = folders.get(key)!;
        else {
          id = this.create({ title, parentId: folder(where) }).id;
          folders.set(key, id);
          ids.push(id);
          pageIds.add(id);
        }
        // A folder that got its own note (Folder/Folder.md, or A.md beside A/) is a page that holds pages.
        this.db.run("UPDATE notes SET kind = 'page' WHERE id = ?", id);
        made.push({ id, text: f.text });
      }
      const titles = this.byTitle();
      const media = opts.media ?? {};
      const mediaFor = (p: string) => media[p] ?? media[p.split("/").pop()!] ?? null;
      let links = 0, unresolved = 0;
      for (const m of made) {
        const doc = markdownToDoc(m.text, {
          page: (t) => {
            const id = titles.get(t.split("/").pop()!.toLowerCase()) ?? null;
            id ? links++ : unresolved++;
            return id;
          },
          media: mediaFor,
        });
        // A file that opens with its own name as a heading: the page title already says it.
        const first = doc.content?.[0];
        const own = this.db.get("SELECT title FROM notes WHERE id = ?", m.id)?.title ?? "";
        if (first?.type === "heading" && docText({ type: "doc", content: [first] }).trim().toLowerCase() === own.trim().toLowerCase()) doc.content!.shift();
        this.update(m.id, { doc });
      }
      return { pages: made.length, folders: ids.length - pageIds.size, links, unresolved, root: root ? rootId : null, ids };
    });
  }

  private descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (p: string) => {
      for (const r of this.db.all<{ id: string }>("SELECT id FROM notes WHERE parent_id = ?", p)) {
        out.push(r.id);
        walk(r.id);
      }
    };
    walk(id);
    return out;
  }
}

function lookJson(l: unknown): string | null {
  const n = normalizeLook(l);
  return Object.keys(n).length ? JSON.stringify(n) : null;
}
function cleanTitle(t: unknown): string {
  return String(t ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_TITLE);
}
/** A page icon: the same kinds as a deck's picture (art:<id>, emoji:<emoji>, media:files/<image>), or a bare emoji
 * (how the first pages stored it; kept as is). Empty clears it. */
function cleanIcon(i: unknown): string | null {
  if (i == null || i === "" || i === "none" || i === "default") return null;
  const s = String(i).trim();
  if (/^(art|emoji|media):/.test(s)) return deckIcon(s);
  // A bare emoji (or a short grapheme cluster).
  if (s.length > 16 || /[\s<>"'`:]/.test(s)) throw new EtudeError("a note icon is an emoji, art:<id>, emoji:<emoji> or media:files/<image>");
  return s;
}
