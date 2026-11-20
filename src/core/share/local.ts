// Sharing's local side that needs only the collection: the tables, which notes sit in a shared space, the read-only
// guard Notes runs before the user's own writes, and a note's synced state. No network here, so every Etude (the CLI,
// an agent, the browser worker) gets the guard even when the share client never starts.
import { createHash } from "node:crypto";
import type { Db } from "../db.ts";
import { EtudeError } from "../engine.ts";
import type { DocNode, NoteKind, NoteLook, NoteShare, Notes } from "../notes.ts";

export const SHARE_SCHEMA = `
CREATE TABLE IF NOT EXISTS share_spaces (
  id          TEXT PRIMARY KEY,
  root_id     TEXT,
  role        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  owner_email TEXT,
  owner_name  TEXT,
  epoch       INTEGER NOT NULL DEFAULT 1,
  cursor      INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  last_sync   TEXT,
  error       TEXT,
  rotate      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS share_state (space_id TEXT NOT NULL, note_id TEXT NOT NULL, hash TEXT NOT NULL, base TEXT, PRIMARY KEY (space_id, note_id));
CREATE TABLE IF NOT EXISTS share_media (space_id TEXT NOT NULL, file TEXT NOT NULL, blob TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (space_id, file));
`;

/** Who changed each shared note last (a remote event's author, or this device's own push): "Edited by …". */
export const SHARE_AUTHOR_SCHEMA = "CREATE TABLE IF NOT EXISTS share_author (space_id TEXT NOT NULL, note_id TEXT NOT NULL, email TEXT, name TEXT, self INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (space_id, note_id))";

export const shareTables = (db: Db) => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'share_spaces'");
export function installShareTables(db: Db) {
  db.sql.exec(SHARE_SCHEMA);
}

type Row = { note: string; space: string; role: NoteShare["role"]; status: string; depth: number };
const share = (r: Row): NoteShare => ({ space: r.space, role: r.role, root: r.depth === 0, readonly: r.role === "view" || r.status !== "active", ...(r.status !== "active" ? { removed: true } : {}) });

/**
 * Which local space each note is in: every note under a space's root (archived ones too). With `ids`, only those, by
 * walking up from each; without, the whole subtree of every space.
 */
export function shareIndex(db: Db, ids?: string[]): Map<string, NoteShare> {
  const out = new Map<string, NoteShare>();
  if (!shareTables(db) || (ids && !ids.length)) return out;
  const rows = ids
    ? db.all<Row>(
        `WITH RECURSIVE up(id, start, depth) AS (
           SELECT id, id, 0 FROM notes WHERE id IN (${ids.map(() => "?").join(",")})
           UNION ALL SELECT n.parent_id, up.start, up.depth + 1 FROM notes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL)
         SELECT up.start AS note, s.id AS space, s.role, s.status, up.depth FROM up JOIN share_spaces s ON s.root_id = up.id ORDER BY up.depth DESC`,
        ...ids,
      )
    : db.all<Row>(
        `WITH RECURSIVE down(id, space, role, status, depth) AS (
           SELECT n.id, s.id, s.role, s.status, 0 FROM share_spaces s JOIN notes n ON n.id = s.root_id
           UNION ALL SELECT n.id, down.space, down.role, down.status, down.depth + 1 FROM notes n JOIN down ON n.parent_id = down.id)
         SELECT id AS note, space, role, status, depth FROM down ORDER BY depth DESC`,
      );
  // Spaces don't nest, but a later (nearer) row wins anyway.
  for (const r of rows) out.set(r.note, share(r));
  if (out.size && db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'share_author'")) {
    const authors = ids
      ? db.all(`SELECT space_id, note_id, email, name, self, at FROM share_author WHERE note_id IN (${[...out.keys()].map(() => "?").join(",")})`, ...out.keys())
      : db.all("SELECT space_id, note_id, email, name, self, at FROM share_author");
    for (const a of authors) {
      const s = out.get(a.note_id);
      if (s && s.space === a.space_id) s.lastEdit = { email: a.email ?? null, name: a.self ? "you" : (a.name ?? null), at: a.at, ...(a.self ? { you: true } : {}) };
    }
  }
  return out;
}

/** The notes of one space, root first, parents before children. */
export function spaceNotes(db: Db, rootId: string): string[] {
  return db
    .all<{ id: string }>(
      `WITH RECURSIVE down(id, depth, pos) AS (
         SELECT id, 0, '' FROM notes WHERE id = ?
         UNION ALL SELECT n.id, down.depth + 1, down.pos || printf('%08d', n.position) || n.id FROM notes n JOIN down ON n.parent_id = down.id)
       SELECT id FROM down ORDER BY depth, pos`,
      rootId,
    )
    .map((r) => r.id);
}

export const VIEW_ONLY = "this is shared with you as view only";

/**
 * Installs the read-only guard and the `share` annotation on a Notes store. The user's writes inside a view-only space
 * (or one whose access was removed) throw 403; a removed copy can still be archived or deleted, since nothing syncs it.
 */
export function installShareGuard(notes: Notes, db: Db) {
  notes.writeGuard = (ids, op) => {
    if (!shareTables(db)) return;
    for (const s of shareIndex(db, ids).values()) {
      if (!s.readonly) continue;
      const removed = !!s.removed;
      if (removed && (op === "delete" || op === "archive")) continue;
      throw new EtudeError(removed ? "you no longer have access to this shared folder: it's a read-only copy now" : VIEW_ONLY, 403);
    }
  };
  notes.shareOf = (ids) => shareIndex(db, ids ?? undefined);
}

// ── a note's synced state ──────────────────────────────────────
/** What travels for one note. `pinned` and `opened` stay on each device. */
export type NoteState = {
  kind: NoteKind;
  /** null for the space's root. */
  parent: string | null;
  title: string;
  icon: string | null;
  look: NoteLook;
  position: number;
  archived: boolean;
  doc: DocNode;
  scene: unknown;
  content: string | null;
  file: string | null;
  /** The media files the state names and the space blobs that hold them; filled in when sent, left out of the hash. */
  media?: Record<string, { blob: string; epoch: number }>;
};

const hasContent = (k: string) => k === "file" || k === "web";
const parse = (s: unknown, fallback: unknown) => {
  try {
    return typeof s === "string" && s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

/** A notes row as its state. The root has no parent and position 0 (both are each member's own). */
export function stateOf(r: any, rootId: string): NoteState {
  const kind = (r.kind ?? "page") as NoteKind;
  const root = r.id === rootId;
  return {
    kind,
    parent: root ? null : (r.parent_id ?? null),
    title: String(r.title ?? ""),
    icon: r.icon ?? null,
    look: parse(r.look, {}),
    position: root ? 0 : Number(r.position) || 0,
    archived: !!r.archived,
    doc: parse(r.doc, { type: "doc", content: [] }),
    // A kanban board lives in the scene column too.
    scene: kind === "canvas" || kind === "kanban" ? parse(r.scene, null) : null,
    content: hasContent(kind) ? String(r.text ?? "") : null,
    file: kind === "pdf" ? (r.file ?? null) : null,
  };
}

/** JSON with object keys sorted, so two devices hash the same state the same way. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function stateHash(s: NoteState): string {
  const { media: _, ...rest } = s;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

const MEDIA = /files\/[0-9a-f]{64}\.[A-Za-z0-9]{1,10}/g;
/** Every media file the state mentions: pictures in a page, a canvas's pictures, a cover, a PDF note's file. */
export function mediaOf(s: NoteState): string[] {
  const { media: _, ...rest } = s;
  return [...new Set(JSON.stringify(rest).match(MEDIA) ?? [])].sort();
}
