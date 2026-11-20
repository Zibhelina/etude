// The notes tables, in a module of their own so Sync can make them before it installs its triggers on them.
import type { Db } from "./db.ts";

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

/** Makes the notes tables and adds the columns later versions brought. */
export function ensureNotesSchema(db: Db) {
  db.sql.exec(NOTES_SCHEMA);
  const cols = db.all("PRAGMA table_info(notes)").map((c) => c.name);
  if (!cols.includes("look")) db.sql.exec("ALTER TABLE notes ADD COLUMN look TEXT");
  if (!cols.includes("kind")) db.sql.exec("ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'page'");
  if (!cols.includes("scene")) db.sql.exec("ALTER TABLE notes ADD COLUMN scene TEXT");
  if (!cols.includes("file")) db.sql.exec("ALTER TABLE notes ADD COLUMN file TEXT");
  if (!cols.includes("pinned")) db.sql.exec("ALTER TABLE notes ADD COLUMN pinned TEXT");
  if (!cols.includes("opened")) db.sql.exec("ALTER TABLE notes ADD COLUMN opened TEXT");
}
