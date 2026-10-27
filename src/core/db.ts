import { openSql, type SqlConnection, type SqlDriver, type SqlValue } from "./sql.ts";
import { registerSearchFunctions } from "./query.ts";

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
  archived     INTEGER NOT NULL DEFAULT 0,
  -- Order among sibling decks; NULL sorts after positioned decks, by name.
  position     INTEGER
);

CREATE TABLE IF NOT EXISTS types (
  id      TEXT PRIMARY KEY,
  def     TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL
);

-- Schedulers other than FSRS: scripts that decide when a card comes back.
CREATE TABLE IF NOT EXISTS schedulers (
  id      TEXT PRIMARY KEY,
  def     TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL
);

-- Folders that organize card types in the Types page. A path is "A::B", like a deck name.
-- Folders exist on their own (they can be empty); a type sits in at most one folder.
CREATE TABLE IF NOT EXISTS type_folders (
  path TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS type_placement (
  type_id TEXT PRIMARY KEY,
  folder  TEXT NOT NULL
);

-- Files a card type ships with (meshes, data, images), served to its cards at /type-assets/<type>/<name>.
CREATE TABLE IF NOT EXISTS type_assets (
  type_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  hash    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  bytes   BLOB NOT NULL,
  PRIMARY KEY (type_id, name)
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
  ord      INTEGER NOT NULL DEFAULT 0,
  -- Derived from the fields on save (see Etude.reindexItems): the label lists show, and what free-text search matches.
  title    TEXT NOT NULL DEFAULT '',
  search   TEXT NOT NULL DEFAULT ''
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
  -- State a non-FSRS scheduler keeps for this card (JSON). NULL for FSRS.
  sched_state    TEXT,
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
  readonly sql: SqlConnection;

  /** Opens a collection file (or ":memory:") on node:sqlite or the WebAssembly build. */
  static async open(path: string, driver?: SqlDriver): Promise<Db> {
    return new Db(await openSql(path, driver));
  }

  constructor(sql: SqlConnection) {
    this.sql = sql;
    this.sql.exec("PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
    // Columns added after a table first shipped.
    if (!this.all("PRAGMA table_info(decks)").some((c) => c.name === "position")) this.sql.exec("ALTER TABLE decks ADD COLUMN position INTEGER");
    if (!this.all("PRAGMA table_info(cards)").some((c) => c.name === "sched_state")) this.sql.exec("ALTER TABLE cards ADD COLUMN sched_state TEXT");
    const itemCols = new Set(this.all("PRAGMA table_info(items)").map((c) => c.name));
    if (!itemCols.has("title")) this.sql.exec("ALTER TABLE items ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    if (!itemCols.has("search")) this.sql.exec("ALTER TABLE items ADD COLUMN search TEXT NOT NULL DEFAULT ''");
    registerSearchFunctions(this.sql);
    const v = this.get("SELECT value FROM meta WHERE key = 'schema_version'");
    if (!v) this.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
  }

  all<T = Row>(query: string, ...params: SqlValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T = Row>(query: string, ...params: SqlValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SqlValue[]) {
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
