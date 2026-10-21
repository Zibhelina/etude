import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS decks (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  preset_id    TEXT REFERENCES presets(id) ON DELETE SET NULL,
  config       TEXT NOT NULL DEFAULT '{}',
  description  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  archived     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS types (
  id      TEXT PRIMARY KEY,
  def     TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL REFERENCES types(id),
  deck_id  INTEGER NOT NULL REFERENCES decks(id),
  fields   TEXT NOT NULL DEFAULT '{}',
  tags     TEXT NOT NULL DEFAULT '[]',
  source   TEXT NOT NULL DEFAULT '',
  notes    TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL,
  updated  TEXT NOT NULL,
  ord      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_deck ON items(deck_id);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag);

-- Per-tag grading instructions and notes. Tags themselves live on items.
CREATE TABLE IF NOT EXISTS tag_meta (
  tag          TEXT PRIMARY KEY,
  instructions TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cards (
  id             INTEGER PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  face           TEXT NOT NULL DEFAULT 'main',
  state          INTEGER NOT NULL DEFAULT 0,
  due            TEXT NOT NULL,
  stability      REAL NOT NULL DEFAULT 0,
  difficulty     REAL NOT NULL DEFAULT 0,
  elapsed_days   REAL NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  reps           INTEGER NOT NULL DEFAULT 0,
  lapses         INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  last_review    TEXT,
  suspended      INTEGER NOT NULL DEFAULT 0,
  buried_until   TEXT,
  UNIQUE (item_id, face)
);
CREATE INDEX IF NOT EXISTS cards_due ON cards(state, due);

-- An attempt is one graded answer. It becomes a review once a rating is applied.
CREATE TABLE IF NOT EXISTS attempts (
  id        INTEGER PRIMARY KEY,
  card_id   INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  seed      INTEGER NOT NULL,
  view      TEXT NOT NULL,
  answer    TEXT NOT NULL,
  grade     TEXT NOT NULL,
  practice  INTEGER NOT NULL DEFAULT 0,
  review_id INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  attempt_id  INTEGER,
  ts          TEXT NOT NULL,
  rating      INTEGER NOT NULL,
  state       INTEGER NOT NULL,
  card_before TEXT NOT NULL,
  due_after   TEXT NOT NULL,
  duration_ms INTEGER,
  score       REAL,
  practice    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id, ts);
CREATE INDEX IF NOT EXISTS reviews_ts ON reviews(ts);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type Row = Record<string, any>;

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    // The timeout lets the CLI and the server write at the same time: one waits instead of failing.
    this.sql = new DatabaseSync(path, { timeout: 5000 });
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
    const v = this.get("SELECT value FROM meta WHERE key = 'schema_version'");
    if (!v) this.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
  }

  all<T = Row>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T = Row>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SQLInputValue[]) {
    return this.sql.prepare(query).run(...params);
  }

  /** Runs `fn` in a transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  private depth = 0;

  setting<T>(key: string, fallback: T): T {
    const row = this.get("SELECT value FROM settings WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  close() {
    this.sql.close();
  }
}
