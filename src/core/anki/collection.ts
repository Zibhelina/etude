// Reads an Anki collection into one plain model, from either storage schema:
// legacy (JSON in `col.models`/`decks`/`dconf`) or the current one (protobuf rows in
// `notetypes`/`fields`/`templates`/`decks`/`deck_config`).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultDriver, type SqlConnection } from "../sql.ts";
import { openImageSync } from "../sql-wasm.ts";
import { protoFloats, protoMsg, protoNum, protoStr, readProto } from "./package.ts";

export interface AnkiField {
  name: string;
  ord: number;
}

export interface AnkiTemplate {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
}

export interface AnkiNotetype {
  id: number;
  name: string;
  /** Anki's notetype kind: 0 standard, 1 cloze. */
  cloze: boolean;
  css: string;
  fields: AnkiField[];
  templates: AnkiTemplate[];
}

export interface AnkiDeck {
  id: number;
  name: string;
  /** Deck config (preset) id for normal decks; null for filtered ones. */
  configId: number | null;
  description: string;
  /** A filtered deck: not imported as a deck, its cards go back to their home deck. */
  filtered: boolean;
}

export interface AnkiDeckConfig {
  id: number;
  name: string;
  /** Learning steps in minutes. */
  learnSteps: number[];
  relearnSteps: number[];
  newPerDay: number;
  reviewsPerDay: number;
  maximumInterval: number;
  desiredRetention: number | null;
  buryNew: boolean;
  buryReviews: boolean;
  fsrsWeights: number[];
}

export interface AnkiNote {
  id: number;
  guid: string;
  notetypeId: number;
  /** Field values, in the notetype's field order, as Anki stores them (HTML). */
  fields: string[];
  tags: string[];
}

export interface AnkiCard {
  id: number;
  noteId: number;
  deckId: number;
  /** Template ord, or (cloze notetypes) the cloze number minus one. */
  ord: number;
  type: number;
  queue: number;
  due: number;
  interval: number;
  reps: number;
  lapses: number;
  /** Learning steps left. */
  left: number;
  /** Original due/deck while the card sits in a filtered deck. */
  originalDue: number;
  originalDeckId: number;
  data: string;
}

export interface AnkiReview {
  id: number;
  cardId: number;
  /** 1 again, 2 hard, 3 good, 4 easy. */
  ease: number;
  /** Negative for learning steps, in seconds. */
  interval: number;
  /** 0 learn, 1 review, 2 relearn, 3 filtered, 4 manual. */
  type: number;
  /** Answer time in milliseconds. */
  time: number;
}

export interface AnkiCollection {
  /** Collection creation time (unix seconds); review-card due dates are day numbers from it. */
  created: number;
  notetypes: AnkiNotetype[];
  decks: AnkiDeck[];
  configs: AnkiDeckConfig[];
  notes: AnkiNote[];
  cards: AnkiCard[];
  reviews: AnkiReview[];
}

/** Anki's schema declares columns `COLLATE unicase`, which the bundled SQLite doesn't know. */
/** What reading a collection needs: node:sqlite's DatabaseSync and our WebAssembly connection both fit. */
type Reader = Pick<SqlConnection, "prepare">;

const UNICASE_PATCH = "UPDATE sqlite_master SET sql = replace(sql, 'COLLATE unicase', '') WHERE sql LIKE '%unicase%';";

function openCopy(buf: Buffer): { db: DatabaseSync | SqlConnection; close: () => void } {
  if (defaultDriver() === "wasm") {
    // No temp files (there are none in a browser): open the image in memory and patch it there.
    const db = openImageSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), UNICASE_PATCH);
    return { db, close: () => db.close() };
  }
  const dir = mkdtempSync(join(tmpdir(), "etude-anki-"));
  const file = join(dir, "collection.db");
  writeFileSync(file, buf);
  const patch = new DatabaseSync(file);
  patch.enableDefensive(false);
  patch.exec("PRAGMA writable_schema = ON");
  patch.prepare(UNICASE_PATCH).run();
  patch.exec("PRAGMA writable_schema = OFF");
  patch.close();
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    db,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const bytes = (v: unknown): Buffer => (v == null ? Buffer.alloc(0) : Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array));
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : v == null ? fallback : Number(v));

function hasTable(db: Reader, name: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function readCollection(collection: Buffer): AnkiCollection {
  const { db, close } = openCopy(collection);
  try {
    return hasTable(db, "notetypes") ? readCurrent(db) : readLegacy(db);
  } finally {
    close();
  }
}

// ------------------------------------------------------------------ current schema

function readCurrent(db: Reader): AnkiCollection {
  const notetypes: AnkiNotetype[] = [];
  for (const row of db.prepare("SELECT id, name, config FROM notetypes ORDER BY id").all() as any[]) {
    const cfg = readProto(bytes(row.config));
    const fields = (db.prepare("SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord").all(row.id) as any[]).map((f) => ({ ord: num(f.ord), name: String(f.name) }));
    const templates = (db.prepare("SELECT ord, name, config FROM templates WHERE ntid = ? ORDER BY ord").all(row.id) as any[]).map((t) => {
      const c = readProto(bytes(t.config));
      return { ord: num(t.ord), name: String(t.name), qfmt: protoStr(c, 1), afmt: protoStr(c, 2) };
    });
    notetypes.push({
      id: num(row.id),
      name: String(row.name),
      cloze: protoNum(cfg, 1) === 1,
      css: protoStr(cfg, 3),
      fields,
      templates,
    });
  }

  const decks: AnkiDeck[] = [];
  for (const row of db.prepare("SELECT id, name, kind FROM decks ORDER BY id").all() as any[]) {
    const kind = readProto(bytes(row.kind));
    // Deck.KindContainer: normal = 1, filtered = 2 (config_id = 1, description = 4 in normal).
    // Some exports store the Deck message itself, where normal = 6 and filtered = 7.
    const normal = protoMsg(kind, 1) ?? protoMsg(kind, 6);
    const filtered = protoMsg(kind, 2) ?? protoMsg(kind, 7);
    decks.push({
      id: num(row.id),
      name: String(row.name).split("\x1f").join("::"),
      configId: normal ? (protoNum(normal, 1) ?? null) : null,
      description: normal ? protoStr(normal, 4) : "",
      filtered: !!filtered,
    });
  }

  const configs: AnkiDeckConfig[] = [];
  for (const row of db.prepare("SELECT id, name, config FROM deck_config ORDER BY id").all() as any[]) {
    const c = readProto(bytes(row.config));
    const weights = [3, 5, 6].map((f) => protoFloats(c, f)).find((w) => w.length >= 17) ?? [];
    configs.push({
      id: num(row.id),
      name: String(row.name),
      learnSteps: protoFloats(c, 1),
      relearnSteps: protoFloats(c, 2),
      newPerDay: protoNum(c, 9) ?? 20,
      reviewsPerDay: protoNum(c, 10) ?? 200,
      maximumInterval: protoNum(c, 16) ?? 36500,
      desiredRetention: protoFloats(c, 37)[0] != null ? Math.round(protoFloats(c, 37)[0] * 1000) / 1000 : null,
      buryNew: protoNum(c, 27) === 1,
      buryReviews: protoNum(c, 28) === 1,
      fsrsWeights: [17, 19, 21].includes(weights.length) ? weights : [],
    });
  }

  const created = num((db.prepare("SELECT crt FROM col LIMIT 1").get() as any)?.crt, Math.floor(Date.now() / 1000));
  return { created, notetypes, decks, configs, ...readNotesCardsReviews(db) };
}

// ------------------------------------------------------------------- legacy schema

function readLegacy(db: Reader): AnkiCollection {
  const col = db.prepare("SELECT crt, models, decks, dconf FROM col LIMIT 1").get() as any;
  if (!col) throw new Error("the collection has no col row");
  const models = JSON.parse(col.models || "{}") as Record<string, any>;
  const decksJson = JSON.parse(col.decks || "{}") as Record<string, any>;
  const dconf = JSON.parse(col.dconf || "{}") as Record<string, any>;

  const notetypes: AnkiNotetype[] = Object.values(models).map((m) => ({
    id: num(m.id),
    name: String(m.name ?? ""),
    cloze: num(m.type) === 1,
    css: String(m.css ?? ""),
    fields: (m.flds ?? []).map((f: any, i: number) => ({ name: String(f.name), ord: num(f.ord, i) })).sort((a: AnkiField, b: AnkiField) => a.ord - b.ord),
    templates: (m.tmpls ?? [])
      .map((t: any, i: number) => ({ name: String(t.name ?? `Card ${i + 1}`), ord: num(t.ord, i), qfmt: String(t.qfmt ?? ""), afmt: String(t.afmt ?? "") }))
      .sort((a: AnkiTemplate, b: AnkiTemplate) => a.ord - b.ord),
  }));

  const decks: AnkiDeck[] = Object.values(decksJson).map((d) => ({
    id: num(d.id),
    name: String(d.name ?? ""),
    configId: num(d.dyn) ? null : (num(d.conf) || null),
    description: String(d.desc ?? ""),
    filtered: !!num(d.dyn),
  }));

  const configs: AnkiDeckConfig[] = Object.values(dconf).map((c) => ({
    id: num(c.id),
    name: String(c.name ?? ""),
    learnSteps: (c.new?.delays ?? []).map(Number),
    relearnSteps: (c.lapse?.delays ?? []).map(Number),
    newPerDay: num(c.new?.perDay, 20),
    reviewsPerDay: num(c.rev?.perDay, 200),
    maximumInterval: num(c.rev?.maxIvl, 36500),
    desiredRetention: typeof c.desiredRetention === "number" ? c.desiredRetention : null,
    buryNew: !!c.new?.bury,
    buryReviews: !!c.rev?.bury,
    fsrsWeights: [],
  }));

  return { created: num(col.crt, Math.floor(Date.now() / 1000)), notetypes, decks, configs, ...readNotesCardsReviews(db) };
}

function readNotesCardsReviews(db: Reader) {
  const notes: AnkiNote[] = (db.prepare("SELECT id, guid, mid, tags, flds FROM notes ORDER BY id").all() as any[]).map((n) => ({
    id: num(n.id),
    guid: String(n.guid ?? ""),
    notetypeId: num(n.mid),
    fields: String(n.flds ?? "").split("\x1f"),
    tags: String(n.tags ?? "").split(/\s+/).filter(Boolean),
  }));

  const cards: AnkiCard[] = (db.prepare("SELECT id, nid, did, ord, type, queue, due, ivl, reps, lapses, left, odue, odid, data FROM cards ORDER BY id").all() as any[]).map((c) => ({
    id: num(c.id),
    noteId: num(c.nid),
    deckId: num(c.did),
    ord: num(c.ord),
    type: num(c.type),
    queue: num(c.queue),
    due: num(c.due),
    interval: num(c.ivl),
    reps: num(c.reps),
    lapses: num(c.lapses),
    left: num(c.left),
    originalDue: num(c.odue),
    originalDeckId: num(c.odid),
    data: String(c.data ?? ""),
  }));

  const reviews: AnkiReview[] = (db.prepare("SELECT id, cid, ease, ivl, type, time FROM revlog ORDER BY id").all() as any[]).map((r) => ({
    id: num(r.id),
    cardId: num(r.cid),
    ease: num(r.ease),
    interval: num(r.ivl),
    type: num(r.type),
    time: num(r.time),
  }));

  return { notes, cards, reviews };
}
