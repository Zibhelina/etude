// The engine: one object that owns the database and every operation on it.
// The HTTP server and the CLI are thin layers over this class.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, type Row } from "./db.ts";
import {
  DEFAULT_PRESET,
  type CardRow,
  type CardTypeDef,
  type Deck,
  type Grade,
  type Item,
  type Prepared,
  type Preset,
  type PresetConfig,
  type Rating,
  type Verdict,
} from "./model.ts";
import { initSandbox, runScript, ScriptError } from "./sandbox.ts";
import { fieldDefaults, loadBuiltinTypes, validateFields, validateType, TYPE_ID } from "./types.ts";
import * as sched from "./scheduler.ts";
import { compile, QueryError } from "./query.ts";
import { aiFeedback, aiVerdict, AiError, DEFAULT_AI, type AiSettings, type GradingContext } from "./ai.ts";

export class EtudeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILTIN_TYPES_DIR = join(ROOT, "types");

const now = () => new Date();
const iso = (d = now()) => d.toISOString();
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const deckParts = (name: string) => name.split("::").map((s) => s.trim()).filter(Boolean);
export const normDeck = (name: string) => deckParts(name).join("::");
export const normTag = (t: string) => t.trim().replace(/\s+/g, "-").split("::").filter(Boolean).join("::");

export interface Settings {
  ai: AiSettings;
  /** Hour (local time) at which a new study day starts. */
  dayStartHour: number;
  /** Learning cards due within this many minutes are shown when nothing else is left. */
  learnAheadMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = { ai: DEFAULT_AI, dayStartHour: 4, learnAheadMinutes: 20 };

export interface StudyScope {
  deck?: string;
  query?: string;
}

export interface StudyCard {
  cardId: number;
  itemId: string;
  face: string;
  type: string;
  typeVersion: string;
  deck: string;
  tags: string[];
  source: string;
  state: number;
  seed: number;
  view: Record<string, unknown>;
  intervals: Record<Rating, string>;
  /** How this card is graded: "self" cards show a reveal button instead of Submit. */
  grader: string;
  generated: boolean;
  /** One-line plain-text label (for lists and summaries). */
  title: string;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Etude {
  readonly db: Db;
  readonly mediaDir: string;
  readonly path: string;
  private typeCache = new Map<string, CardTypeDef>();

  private constructor(db: Db, mediaDir: string, path: string) {
    this.db = db;
    this.mediaDir = mediaDir;
    this.path = path;
  }

  static async open(path: string, opts: { builtinTypesDir?: string } = {}): Promise<Etude> {
    await initSandbox();
    const db = new Db(path);
    const media = path === ":memory:" ? join(process.env.TMPDIR ?? "/tmp", `etude-media-${process.pid}`) : join(dirname(path), "media");
    const e = new Etude(db, media, path);
    e.syncBuiltinTypes(opts.builtinTypesDir ?? BUILTIN_TYPES_DIR);
    return e;
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- settings

  settings(): Settings {
    const s = this.db.setting<Partial<Settings>>("settings", {});
    return { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_AI, ...(s.ai ?? {}) } };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const cur = this.settings();
    const next: Settings = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai ?? {}) } };
    if (!(next.dayStartHour >= 0 && next.dayStartHour < 24)) throw new EtudeError("dayStartHour must be 0 to 23");
    this.db.setSetting("settings", next);
    return next;
  }

  /** Start of the current study day, in local time. */
  dayStart(at = now()): Date {
    const h = this.settings().dayStartHour;
    const d = new Date(at);
    d.setHours(h, 0, 0, 0);
    if (d > at) d.setDate(d.getDate() - 1);
    return d;
  }

  // ------------------------------------------------------------------- types

  private syncBuiltinTypes(dir: string) {
    const ts = iso();
    this.db.tx(() => {
      for (const def of loadBuiltinTypes(dir)) {
        const row = this.db.get("SELECT builtin FROM types WHERE id = ?", def.id);
        // A built-in the user has edited (builtin = 0) is theirs now; leave it alone.
        if (row && row.builtin === 0) continue;
        this.db.run(
          "INSERT INTO types (id, def, builtin, updated) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, updated = CASE WHEN types.def = excluded.def THEN types.updated ELSE excluded.updated END",
          def.id,
          json(def),
          ts,
        );
      }
    });
    this.typeCache.clear();
    this.builtinDir = dir;
  }
  private builtinDir = BUILTIN_TYPES_DIR;

  listTypes() {
    return this.db
      .all("SELECT t.id, t.def, t.builtin, t.updated, (SELECT COUNT(*) FROM items i WHERE i.type = t.id AND i.archived = 0) AS items FROM types t ORDER BY t.builtin DESC, t.id")
      .map((r) => {
        const def = parse<CardTypeDef>(r.def, {} as CardTypeDef);
        return { id: r.id, name: def.name, description: def.description ?? "", builtin: !!r.builtin, edited: false, updated: r.updated, items: r.items, grader: def.grader?.kind };
      });
  }

  type(id: string): CardTypeDef & { updated: string; builtin: boolean } {
    const row = this.db.get("SELECT def, updated, builtin FROM types WHERE id = ?", id);
    if (!row) throw new EtudeError(`unknown type "${id}"`, 404);
    const cached = this.typeCache.get(id);
    if (cached && (cached as any).updated === row.updated) return cached as any;
    const def = { ...parse<CardTypeDef>(row.def, {} as CardTypeDef), updated: row.updated, builtin: !!row.builtin };
    this.typeCache.set(id, def);
    return def;
  }

  saveType(def: CardTypeDef): CardTypeDef {
    const errors = validateType(def);
    if (errors.length) throw new EtudeError(`invalid type: ${errors.join("; ")}`);
    const clean: CardTypeDef = {
      id: def.id,
      name: def.name,
      description: def.description ?? "",
      ...(def.faces ? { faces: def.faces } : {}),
      fields: def.fields,
      ...(def.prepare ? { prepare: def.prepare } : {}),
      template: { html: def.template.html, css: def.template.css ?? "", js: def.template.js ?? "" },
      grader: def.grader,
      ...(def.instructions ? { instructions: def.instructions } : {}),
    };
    const old = this.db.get("SELECT def FROM types WHERE id = ?", def.id);
    if (old && old.def === json(clean)) return clean;
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO types (id, def, builtin, updated) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, builtin = 0, updated = excluded.updated",
        clean.id,
        json(clean),
        iso(),
      );
      this.ensureCardsForType(clean.id);
    });
    this.typeCache.delete(def.id);
    return clean;
  }

  /** Restores a built-in type that was edited back to the shipped version. */
  resetType(id: string) {
    const shipped = loadBuiltinTypes(this.builtinDir).find((t) => t.id === id);
    if (!shipped) throw new EtudeError(`"${id}" is not a built-in type`);
    this.db.run("UPDATE types SET def = ?, builtin = 1, updated = ? WHERE id = ?", json(shipped), iso(), id);
    this.typeCache.delete(id);
  }

  deleteType(id: string) {
    const used = this.db.get("SELECT COUNT(*) AS n FROM items WHERE type = ?", id)!.n;
    if (used) throw new EtudeError(`type "${id}" is used by ${used} item(s)`);
    const row = this.db.get("SELECT builtin FROM types WHERE id = ?", id);
    if (row?.builtin) throw new EtudeError("built-in types can't be deleted");
    this.db.run("DELETE FROM types WHERE id = ?", id);
    this.typeCache.delete(id);
  }

  private ensureCardsForType(typeId: string) {
    const faces = this.type(typeId).faces ?? ["main"];
    const items = this.db.all("SELECT id FROM items WHERE type = ?", typeId);
    for (const it of items) this.ensureCards(it.id, faces);
  }

  private ensureCards(itemId: string, faces: string[]) {
    const ts = iso();
    for (const face of faces) this.db.run("INSERT OR IGNORE INTO cards (item_id, face, due) VALUES (?, ?, ?)", itemId, face, ts);
  }

  // ----------------------------------------------------------- decks/presets

  ensureDeck(name: string): number {
    const parts = deckParts(name);
    if (!parts.length) throw new EtudeError("deck name is empty");
    let id = 0;
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("::");
      const row = this.db.get("SELECT id FROM decks WHERE name = ?", path);
      id = row ? row.id : Number(this.db.run("INSERT INTO decks (name) VALUES (?)", path).lastInsertRowid);
    }
    return id;
  }

  private deckRow(nameOrId: string | number): Row {
    const row =
      typeof nameOrId === "number" ? this.db.get("SELECT * FROM decks WHERE id = ?", nameOrId) : this.db.get("SELECT * FROM decks WHERE name = ? COLLATE NOCASE", normDeck(nameOrId));
    if (!row) throw new EtudeError(`unknown deck "${nameOrId}"`, 404);
    return row;
  }

  deck(nameOrId: string | number): Deck & { resolved: PresetConfig; inherited: PresetConfig; presetBase: PresetConfig } {
    const r = this.deckRow(nameOrId);
    return {
      ...this.deckFromRow(r),
      resolved: this.configFor(r.name),
      /** What applies before this deck's own overrides (parents and its preset). */
      inherited: this.configFor(r.name, { excludeOwn: true }),
      /** What applies before this deck's preset (parents only). */
      presetBase: this.configFor(r.name, { excludeOwn: true, excludePreset: true }),
    };
  }

  private deckFromRow(r: Row): Deck {
    return { id: r.id, name: r.name, presetId: r.preset_id, config: parse(r.config, {}), description: r.description, instructions: r.instructions, archived: !!r.archived };
  }

  updateDeck(nameOrId: string | number, patch: Partial<Pick<Deck, "presetId" | "config" | "description" | "instructions" | "archived">> & { name?: string }) {
    const r = this.deckRow(nameOrId);
    if (patch.config) {
      const e = sched.validateConfig(patch.config);
      if (e.length) throw new EtudeError(e.join("; "));
    }
    if (patch.presetId) this.preset(patch.presetId);
    this.db.tx(() => {
      if (patch.name !== undefined && normDeck(patch.name) !== r.name) this.renameDeck(r.name, patch.name);
      this.db.run(
        "UPDATE decks SET preset_id = ?, config = ?, description = ?, instructions = ?, archived = ? WHERE id = ?",
        patch.presetId !== undefined ? patch.presetId : r.preset_id,
        patch.config !== undefined ? json(patch.config) : r.config,
        patch.description ?? r.description,
        patch.instructions ?? r.instructions,
        patch.archived !== undefined ? Number(patch.archived) : r.archived,
        r.id,
      );
    });
    return this.deck(r.id);
  }

  renameDeck(from: string, to: string) {
    const src = this.deckRow(from).name;
    const dst = normDeck(to);
    if (!dst) throw new EtudeError("deck name is empty");
    if (dst === src) return;
    if (dst.startsWith(src + "::")) throw new EtudeError("can't move a deck inside itself");
    this.db.tx(() => {
      const rows = this.db.all("SELECT id, name FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\'", src, src.replace(/[\\%_]/g, "\\$&") + "::%");
      for (const r of rows) {
        const name = dst + r.name.slice(src.length);
        const clash = this.db.get("SELECT id FROM decks WHERE name = ?", name);
        if (clash && clash.id !== r.id) {
          // Merge into the existing deck.
          this.db.run("UPDATE items SET deck_id = ? WHERE deck_id = ?", clash.id, r.id);
          this.db.run("DELETE FROM decks WHERE id = ?", r.id);
        } else this.db.run("UPDATE decks SET name = ? WHERE id = ?", name, r.id);
      }
      const parent = deckParts(dst).slice(0, -1).join("::");
      if (parent) this.ensureDeck(parent);
    });
  }

  /** Deletes a deck only when it and its children hold no items. Archive decks that have content. */
  deleteDeck(name: string) {
    const src = this.deckRow(name).name;
    const like = src.replace(/[\\%_]/g, "\\$&") + "::%";
    const n = this.db.get("SELECT COUNT(*) AS n FROM items i JOIN decks d ON d.id = i.deck_id WHERE d.name = ? OR d.name LIKE ? ESCAPE '\\'", src, like)!.n;
    if (n) throw new EtudeError(`deck "${src}" holds ${n} item(s); move or archive them first`);
    this.db.run("DELETE FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\'", src, like);
  }

  listPresets(): Preset[] {
    return this.db.all("SELECT * FROM presets ORDER BY name").map((r) => ({ id: r.id, name: r.name, config: parse(r.config, {}) }));
  }

  preset(id: string): Preset {
    const r = this.db.get("SELECT * FROM presets WHERE id = ?", id);
    if (!r) throw new EtudeError(`unknown preset "${id}"`, 404);
    return { id: r.id, name: r.name, config: parse(r.config, {}) };
  }

  savePreset(p: Preset): Preset {
    if (!TYPE_ID.test(p.id ?? "")) throw new EtudeError("preset id must be a lowercase slug");
    const e = sched.validateConfig(p.config ?? {});
    if (e.length) throw new EtudeError(e.join("; "));
    this.db.run(
      "INSERT INTO presets (id, name, config) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config",
      p.id,
      p.name || p.id,
      json(p.config ?? {}),
    );
    return this.preset(p.id);
  }

  /** Settings for a deck: defaults, then each ancestor's preset and own overrides, root first. */
  configFor(deckName: string, opts: { excludeOwn?: boolean; excludePreset?: boolean } = {}): PresetConfig {
    const parts = deckParts(deckName);
    const layers: Partial<PresetConfig>[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const r = this.db.get("SELECT preset_id, config FROM decks WHERE name = ?", parts.slice(0, i).join("::"));
      if (!r) continue;
      const own = i === parts.length;
      if (r.preset_id && !(own && opts.excludePreset)) {
        const p = this.db.get("SELECT config FROM presets WHERE id = ?", r.preset_id);
        if (p) layers.push(parse(p.config, {}));
      }
      if (!(own && opts.excludeOwn)) layers.push(parse(r.config, {}));
    }
    return sched.resolveConfig(...layers);
  }

  // ---------------------------------------------------------------- tags

  listTags() {
    return this.db.all(
      "SELECT t.tag, COUNT(*) AS items, m.instructions, m.description FROM item_tags t JOIN items i ON i.id = t.item_id AND i.archived = 0 LEFT JOIN tag_meta m ON m.tag = t.tag GROUP BY t.tag ORDER BY t.tag",
    );
  }

  setTagMeta(tag: string, meta: { instructions?: string; description?: string }) {
    const t = normTag(tag);
    this.db.run(
      "INSERT INTO tag_meta (tag, instructions, description) VALUES (?, ?, ?) ON CONFLICT(tag) DO UPDATE SET instructions = excluded.instructions, description = excluded.description",
      t,
      meta.instructions ?? "",
      meta.description ?? "",
    );
  }

  /** Renames a tag and every tag below it. */
  renameTag(from: string, to: string) {
    const src = normTag(from), dst = normTag(to);
    this.db.tx(() => {
      const rows = this.db.all("SELECT item_id, tag FROM item_tags WHERE tag = ? OR tag LIKE ? ESCAPE '\\'", src, src.replace(/[\\%_]/g, "\\$&") + "::%");
      for (const r of rows) {
        const tag = dst + r.tag.slice(src.length);
        const item = this.db.get("SELECT tags FROM items WHERE id = ?", r.item_id)!;
        const tags = [...new Set(parse<string[]>(item.tags, []).map((t) => (t === r.tag ? tag : t)))];
        this.db.run("UPDATE items SET tags = ? WHERE id = ?", json(tags), r.item_id);
        this.db.run("DELETE FROM item_tags WHERE item_id = ? AND tag = ?", r.item_id, r.tag);
        this.db.run("INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)", r.item_id, tag);
      }
    });
  }

  // ------------------------------------------------------------------ items

  private itemFromRow(r: Row): Item {
    return {
      id: r.id,
      type: r.type,
      deck: r.deck,
      fields: parse(r.fields, {}),
      tags: parse(r.tags, []),
      source: r.source,
      notes: r.notes,
      archived: !!r.archived,
      created: r.created,
      updated: r.updated,
    };
  }

  item(id: string) {
    const r = this.db.get("SELECT i.*, d.name AS deck FROM items i JOIN decks d ON d.id = i.deck_id WHERE i.id = ?", id);
    if (!r) throw new EtudeError(`unknown item "${id}"`, 404);
    const cards = this.db.all<CardRow>("SELECT * FROM cards WHERE item_id = ? ORDER BY id", id);
    const cfg = this.configFor(r.deck);
    const t = now();
    return {
      ...this.itemFromRow(r),
      cards: cards.map((c) => ({ ...c, retrievability: sched.retrievability(c, t, cfg) })),
      reviews: this.db.all(
        "SELECT r.id, r.card_id, r.ts, r.rating, r.state, r.due_after, r.duration_ms, r.score, r.practice FROM reviews r JOIN cards c ON c.id = r.card_id WHERE c.item_id = ? ORDER BY r.ts DESC LIMIT 200",
        id,
      ),
      attempts: this.db
        .all("SELECT a.id, a.card_id, a.ts, a.answer, a.grade, a.practice FROM attempts a JOIN cards c ON c.id = a.card_id WHERE c.item_id = ? ORDER BY a.ts DESC LIMIT 50", id)
        .map((a) => ({ ...a, answer: parse(a.answer, null), grade: parse(a.grade, null) })),
    };
  }

  /** Creates or updates one item. Returns what happened. */
  upsertItem(input: Partial<Item> & { id: string; type: string; deck: string; fields: Record<string, unknown> }, opts: { ord?: number } = {}): "created" | "updated" | "unchanged" {
    if (!input.id || !/^[A-Za-z0-9][\w.:-]{0,199}$/.test(input.id)) throw new EtudeError(`invalid item id "${input.id}"`);
    const def = this.type(input.type);
    const fields = { ...fieldDefaults(def), ...(input.fields ?? {}) };
    const errs = validateFields(def, fields);
    if (errs.length && typeof fields.generator !== "string") throw new EtudeError(`${input.id}: ${errs.join("; ")}`);
    if (typeof fields.generator === "string") {
      // A generated item must produce valid fields; try a few seeds now so mistakes surface at import.
      for (const seed of [1, 2, 3]) {
        const gen = this.generate(fields, seed, input.id);
        const e = validateFields(def, gen);
        if (e.length) throw new EtudeError(`${input.id}: generator output (seed ${seed}): ${e.join("; ")}`);
      }
    }
    const deckId = this.ensureDeck(input.deck);
    const tags = [...new Set((input.tags ?? []).map(normTag).filter(Boolean))];
    const old = this.db.get("SELECT * FROM items WHERE id = ?", input.id);
    const ts = iso();
    const next = { type: input.type, deck_id: deckId, fields: json(fields), tags: json(tags), source: input.source ?? "", notes: input.notes ?? "", archived: Number(input.archived ?? false) };
    let result: "created" | "updated" | "unchanged";
    this.db.tx(() => {
      if (!old) {
        const ord = opts.ord ?? (this.db.get("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM items")!.n as number);
        this.db.run(
          "INSERT INTO items (id, type, deck_id, fields, tags, source, notes, archived, created, updated, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          input.id, next.type, next.deck_id, next.fields, next.tags, next.source, next.notes, next.archived, ts, ts, ord,
        );
        result = "created";
      } else {
        const same = old.type === next.type && old.deck_id === next.deck_id && old.fields === next.fields && old.tags === next.tags && old.source === next.source && old.notes === next.notes && old.archived === next.archived;
        if (same) {
          result = "unchanged";
          return;
        }
        this.db.run(
          "UPDATE items SET type = ?, deck_id = ?, fields = ?, tags = ?, source = ?, notes = ?, archived = ?, updated = ? WHERE id = ?",
          next.type, next.deck_id, next.fields, next.tags, next.source, next.notes, next.archived, ts, input.id,
        );
        result = "updated";
      }
      this.db.run("DELETE FROM item_tags WHERE item_id = ?", input.id);
      for (const t of tags) this.db.run("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)", input.id, t);
      this.ensureCards(input.id, def.faces ?? ["main"]);
    });
    return result!;
  }

  setArchived(ids: string[], archived: boolean) {
    this.db.tx(() => {
      for (const id of ids) this.db.run("UPDATE items SET archived = ?, updated = ? WHERE id = ?", Number(archived), iso(), id);
    });
  }

  /** Permanently deletes items with their cards and history. Prefer archiving for real content. */
  deleteItems(ids: string[]) {
    this.db.tx(() => {
      for (const id of ids) this.db.run("DELETE FROM items WHERE id = ?", id);
    });
  }

  moveItems(ids: string[], deck: string) {
    const deckId = this.ensureDeck(deck);
    this.db.tx(() => {
      for (const id of ids) this.db.run("UPDATE items SET deck_id = ?, updated = ? WHERE id = ?", deckId, iso(), id);
    });
  }

  tagItems(ids: string[], add: string[], remove: string[] = []) {
    const addN = add.map(normTag).filter(Boolean);
    const rmN = new Set(remove.map(normTag));
    this.db.tx(() => {
      for (const id of ids) {
        const r = this.db.get("SELECT tags FROM items WHERE id = ?", id);
        if (!r) continue;
        const tags = [...new Set([...parse<string[]>(r.tags, []).filter((t) => !rmN.has(t)), ...addN])];
        this.db.run("UPDATE items SET tags = ?, updated = ? WHERE id = ?", json(tags), iso(), id);
        this.db.run("DELETE FROM item_tags WHERE item_id = ?", id);
        for (const t of tags) this.db.run("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)", id, t);
      }
    });
  }

  setSuspended(cardIds: number[], suspended: boolean) {
    this.db.tx(() => {
      for (const id of cardIds) this.db.run("UPDATE cards SET suspended = ? WHERE id = ?", Number(suspended), id);
    });
  }

  /** Forgets scheduling for cards (they become new again). History stays. */
  resetCards(cardIds: number[]) {
    const ts = iso();
    this.db.tx(() => {
      for (const id of cardIds)
        this.db.run(
          "UPDATE cards SET state = 0, due = ?, stability = 0, difficulty = 0, elapsed_days = 0, scheduled_days = 0, reps = 0, lapses = 0, learning_steps = 0, last_review = NULL, buried_until = NULL WHERE id = ?",
          ts,
          id,
        );
    });
  }

  /** Browse: cards matching a search, with their item. */
  search(query: string, opts: { limit?: number; offset?: number; order?: string } = {}) {
    let c;
    try {
      c = compile(query);
    } catch (e) {
      if (e instanceof QueryError) throw new EtudeError(`search: ${e.message}`);
      throw e;
    }
    const orders: Record<string, string> = {
      added: "i.ord, c.id",
      due: "CASE WHEN c.state = 0 THEN 1 ELSE 0 END, c.due",
      deck: "d.name, i.ord",
      lapses: "c.lapses DESC, i.ord",
      difficulty: "c.difficulty DESC, i.ord",
      updated: "i.updated DESC",
    };
    const order = orders[opts.order ?? "added"] ?? orders.added;
    const from = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const total = this.db.get(`SELECT COUNT(*) AS n ${from} WHERE ${c.where}`, ...c.params)!.n;
    const rows = this.db.all(
      `SELECT c.*, i.type, i.fields, i.tags, i.source, i.archived, d.name AS deck ${from} WHERE ${c.where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...c.params,
      opts.limit ?? 100,
      opts.offset ?? 0,
    );
    const t = now();
    const cfgs = new Map<string, PresetConfig>();
    return {
      total,
      rows: rows.map((r) => {
        if (!cfgs.has(r.deck)) cfgs.set(r.deck, this.configFor(r.deck));
        const fields = parse<Record<string, unknown>>(r.fields, {});
        return {
          cardId: r.id,
          itemId: r.item_id,
          face: r.face,
          type: r.type,
          deck: r.deck,
          tags: parse(r.tags, []),
          title: this.titleOf(r.type, fields),
          state: r.state,
          due: r.due,
          reps: r.reps,
          lapses: r.lapses,
          stability: r.stability,
          difficulty: r.difficulty,
          suspended: !!r.suspended,
          archived: !!r.archived,
          generated: typeof fields.generator === "string",
          retrievability: sched.retrievability(r as CardRow, t, cfgs.get(r.deck)!),
        };
      }),
    };
  }

  /** A one-line label for lists: the first markdown field, stripped. */
  titleOf(typeId: string, fields: Record<string, unknown>): string {
    let def: CardTypeDef | null = null;
    try {
      def = this.type(typeId);
    } catch {}
    const name = def?.fields.find((f) => f.kind === "markdown" && !f.private && typeof fields[f.name] === "string")?.name;
    const text = String((name ? fields[name] : Object.values(fields).find((v) => typeof v === "string")) ?? "");
    return text
      .replace(/```[\s\S]*?```/g, " [code] ")
      .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
      .replace(/[*_`#>|]/g, "")
      .replace(/\{\{([^}|:]+)[^}]*\}\}/g, "[$1]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  // ------------------------------------------------------------ preparation

  private generate(fields: Record<string, unknown>, seed: number, where: string): Record<string, unknown> {
    if (typeof fields.generator !== "string") return fields;
    const out = runScript<Record<string, unknown>>(fields.generator, { params: ["rng"], args: {}, seed, where: `${where}/generator` });
    if (!out || typeof out !== "object" || Array.isArray(out)) throw new EtudeError(`${where}: generator must return an object of fields`);
    const merged = { ...fields, ...out };
    delete merged.generator;
    return merged;
  }

  /** Turns an item into what one face of its card shows (`view`) and what grading needs (`key`). */
  prepare(itemId: string, face: string, seed: number): Prepared & { fields: Record<string, unknown> } {
    const r = this.db.get("SELECT type, fields FROM items WHERE id = ?", itemId);
    if (!r) throw new EtudeError(`unknown item "${itemId}"`, 404);
    const def = this.type(r.type);
    const fields = this.generate({ ...fieldDefaults(def), ...parse(r.fields, {}) }, seed, itemId);
    if (def.prepare) {
      const out = runScript<{ view?: Record<string, unknown>; key?: Record<string, unknown> }>(def.prepare, {
        params: ["fields", "face", "rng"],
        args: { fields, face },
        seed: hashString(`${seed}:${itemId}:${face}`),
        where: `${def.id}/prepare`,
      });
      return { view: out?.view ?? {}, key: out?.key ?? {}, seed, fields };
    }
    const priv = new Set(def.fields.filter((f) => f.private).map((f) => f.name));
    const view: Record<string, unknown> = {};
    const key: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) (priv.has(k) ? key : view)[k] = v;
    return { view, key, seed, fields };
  }

  /**
   * Runs a type definition that may not be saved yet against sample fields: what the type editor
   * uses for its live preview. Nothing is stored.
   */
  async previewType(def: CardTypeDef, fields: Record<string, unknown>, opts: { seed?: number; face?: string; answer?: unknown } = {}) {
    const errors = validateType(def);
    if (errors.length) return { errors };
    const seed = opts.seed ?? 1;
    const face = opts.face ?? def.faces?.[0] ?? "main";
    let merged: Record<string, unknown>;
    let view: Record<string, unknown> = {}, key: Record<string, unknown> = {};
    try {
      merged = this.generate({ ...fieldDefaults(def), ...fields }, seed, "preview");
      if (def.prepare) {
        const out = runScript<any>(def.prepare, { params: ["fields", "face", "rng"], args: { fields: merged, face }, seed: hashString(`${seed}:preview:${face}`), where: `${def.id}/prepare` });
        view = out?.view ?? {};
        key = out?.key ?? {};
      } else {
        const priv = new Set(def.fields.filter((f) => f.private).map((f) => f.name));
        for (const [k, v] of Object.entries(merged)) (priv.has(k) ? key : view)[k] = v;
      }
    } catch (e) {
      return { errors: [(e as Error).message] };
    }
    const fieldErrors = validateFields(def, merged);
    let grade: Grade | null = null;
    if (opts.answer !== undefined) {
      const g = def.grader;
      if (g.kind === "script" || g.kind === "hybrid") {
        try {
          const out = runScript<any>((g as { code: string }).code, { params: ["answer", "view", "key", "fields"], args: { answer: opts.answer, view, key, fields: merged }, where: `${def.id}/grade`, timeoutMs: 1000 });
          const score = out?.score == null ? null : Math.max(0, Math.min(1, Number(out.score)));
          grade = { score, verdict: this.verdictOf(score), details: out?.details, feedback: out?.feedback, suggested: null, grader: { kind: "script" } };
        } catch (e) {
          return { errors: [(e as Error).message], view, key };
        }
      } else grade = { score: null, verdict: "ungraded", suggested: null, grader: { kind: g.kind } };
    }
    return { errors: fieldErrors, view, key, grade, seed };
  }

  // ----------------------------------------------------------------- study

  private scopeWhere(scope: StudyScope): { where: string; params: any[]; cfg: PresetConfig } {
    const parts: string[] = ["i.archived = 0", "c.suspended = 0"];
    const params: any[] = [];
    let cfg: PresetConfig;
    if (scope.deck) {
      const d = this.deckRow(scope.deck);
      parts.push("(d.name = ? OR d.name LIKE ? ESCAPE '\\')");
      params.push(d.name, d.name.replace(/[\\%_]/g, "\\$&") + "::%");
      cfg = this.configFor(d.name);
    } else cfg = sched.resolveConfig({ newPerDay: 1e9, reviewsPerDay: 1e9 });
    if (scope.query?.trim()) {
      try {
        const c = compile(scope.query);
        parts.push(`(${c.where})`);
        params.push(...c.params);
      } catch (e) {
        if (e instanceof QueryError) throw new EtudeError(`search: ${e.message}`);
        throw e;
      }
    }
    return { where: parts.join(" AND "), params, cfg };
  }

  /** The queue for a deck or search right now: learning, due reviews and today's new cards, in order. */
  queue(scope: StudyScope) {
    const t = now();
    const { where, params, cfg } = this.scopeWhere(scope);
    const from = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const rows = this.db.all(
      `SELECT c.*, i.ord, d.name AS deck ${from} WHERE ${where} AND (c.buried_until IS NULL OR c.buried_until <= ?)`,
      ...params,
      iso(t),
    ) as (CardRow & { ord: number; deck: string })[];
    const dayStart = iso(this.dayStart(t));
    const done = this.db.get(
      `SELECT SUM(r.state = 0) AS new, SUM(r.state = 2) AS rev FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE r.practice = 0 AND r.ts >= ? AND ${where}`,
      dayStart,
      ...params,
    )!;
    const doneNew = Number(done.new ?? 0), doneRev = Number(done.rev ?? 0);
    const nowIso = iso(t);
    const aheadIso = iso(new Date(t.getTime() + this.settings().learnAheadMinutes * 60_000));

    const learning = rows.filter((c) => (c.state === 1 || c.state === 3) && c.due <= aheadIso).sort((a, b) => a.due.localeCompare(b.due));
    let reviews = rows.filter((c) => c.state === 2 && c.due <= nowIso);
    if (cfg.reviewOrder === "retrievability") {
      const R = new Map(reviews.map((c) => [c.id, sched.retrievability(c, t, cfg) ?? 1]));
      reviews.sort((a, b) => R.get(a.id)! - R.get(b.id)!);
    } else if (cfg.reviewOrder === "random") {
      const day = dayStart.slice(0, 10);
      reviews.sort((a, b) => hashString(day + a.id) - hashString(day + b.id));
    } else reviews.sort((a, b) => a.due.localeCompare(b.due));
    reviews = reviews.slice(0, Math.max(0, cfg.reviewsPerDay - doneRev));

    let news = rows.filter((c) => c.state === 0);
    if (cfg.newOrder === "random") {
      const day = dayStart.slice(0, 10);
      news.sort((a, b) => hashString(day + a.id) - hashString(day + b.id));
    } else if (cfg.newOrder === "deck") news.sort((a, b) => a.deck.localeCompare(b.deck) || a.ord - b.ord || a.id - b.id);
    else news.sort((a, b) => a.ord - b.ord || a.id - b.id);
    news = news.slice(0, Math.max(0, cfg.newPerDay - doneNew));

    const nextLater = rows
      .filter((c) => c.state !== 0 && c.due > aheadIso)
      .reduce<string | null>((m, c) => (!m || c.due < m ? c.due : m), null);
    return { learning, reviews, news, doneNew, doneRev, cfg, nowIso, nextLater };
  }

  counts(scope: StudyScope) {
    const q = this.queue(scope);
    return {
      new: q.news.length,
      learning: q.learning.filter((c) => c.due <= q.nowIso).length,
      learningSoon: q.learning.length,
      review: q.reviews.length,
      doneToday: q.doneNew + q.doneRev,
      nextDue: q.nextLater,
    };
  }

  /** Chooses the next card. `exclude` avoids showing the card that was just answered twice in a row. */
  next(scope: StudyScope, opts: { exclude?: number } = {}): { card: StudyCard | null; counts: ReturnType<Etude["counts"]> } {
    const q = this.queue(scope);
    const counts = {
      new: q.news.length,
      learning: q.learning.filter((c) => c.due <= q.nowIso).length,
      learningSoon: q.learning.length,
      review: q.reviews.length,
      doneToday: q.doneNew + q.doneRev,
      nextDue: q.nextLater,
    };
    const not = (list: CardRow[]) => list.filter((c) => c.id !== opts.exclude);
    const learningNow = not(q.learning.filter((c) => c.due <= q.nowIso));
    const reviews = not(q.reviews);
    const news = not(q.news);
    let pick: CardRow | undefined = learningNow[0];
    if (!pick && (reviews.length || news.length)) {
      if (!news.length) pick = reviews[0];
      else if (!reviews.length) pick = news[0];
      else if (q.cfg.newMix === "first") pick = news[0];
      else if (q.cfg.newMix === "last") pick = reviews[0];
      else {
        // Interleave so both piles finish together.
        const newProgress = q.doneNew / (q.doneNew + news.length);
        const revProgress = q.doneRev / (q.doneRev + reviews.length);
        pick = newProgress < revProgress ? news[0] : reviews[0];
      }
    }
    pick ??= not(q.learning)[0];
    // Only the excluded card is left: show it rather than nothing.
    pick ??= q.learning[0] ?? q.reviews[0] ?? q.news[0];
    if (!pick) return { card: null, counts };
    return { card: this.present(pick.id), counts };
  }

  /** Prepares a specific card for display. A new seed gives a new variant of generated items. */
  present(cardId: number, seed?: number): StudyCard {
    const c = this.db.get<CardRow & { type: string; deck: string; tags: string; source: string }>(
      "SELECT c.*, i.type, i.tags, i.source, d.name AS deck FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE c.id = ?",
      cardId,
    );
    if (!c) throw new EtudeError(`unknown card ${cardId}`, 404);
    const s = seed ?? Math.floor(Math.random() * 2 ** 31);
    const p = this.prepare(c.item_id, c.face, s);
    const def = this.type(c.type);
    return {
      cardId: c.id,
      itemId: c.item_id,
      face: c.face,
      type: c.type,
      typeVersion: def.updated,
      deck: c.deck,
      tags: parse(c.tags, []),
      source: c.source,
      state: c.state,
      seed: s,
      view: p.view,
      intervals: sched.preview(c, now(), this.configFor(c.deck)),
      grader: def.grader.kind,
      generated: typeof p.fields.generator === "string" || typeof parse<Record<string, unknown>>(this.db.get("SELECT fields FROM items WHERE id = ?", c.item_id)!.fields, {}).generator === "string",
      title: this.titleOf(c.type, p.fields),
    };
  }

  private cardWithDeck(cardId: number) {
    const c = this.db.get<CardRow & { deck: string; type: string; tags: string; item_fields: string }>(
      "SELECT c.*, d.name AS deck, i.type, i.tags, i.fields AS item_fields FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE c.id = ?",
      cardId,
    );
    if (!c) throw new EtudeError(`unknown card ${cardId}`, 404);
    return c;
  }

  private gradingContext(c: { item_id: string; deck: string; type: string; tags: string }, prep: Prepared & { fields: Record<string, unknown> }, answer: unknown): GradingContext {
    const def = this.type(c.type);
    const card: GradingContext["card"] = [];
    const shown = new Set<string>();
    for (const f of def.fields) {
      const v = prep.fields[f.name];
      if (v === undefined || v === null || v === "" || f.name === "generator") continue;
      shown.add(f.name);
      const text = typeof v === "string" ? v : JSON.stringify(v, null, 1);
      card.push({ label: `${f.label ?? f.name}${f.private ? " (hidden from the student)" : ""}`, text });
    }
    const instructions: GradingContext["instructions"] = [];
    const tags = parse<string[]>(c.tags, []);
    for (const t of tags) {
      // Most specific tag first: a::b::c, then a::b, then a.
      const parts = t.split("::");
      for (let i = parts.length; i >= 1; i--) {
        const m = this.db.get("SELECT instructions FROM tag_meta WHERE tag = ?", parts.slice(0, i).join("::"));
        if (m?.instructions && !instructions.some((x) => x.text === m.instructions)) instructions.push({ from: `tag ${parts.slice(0, i).join("::")}`, text: m.instructions });
      }
    }
    const dp = deckParts(c.deck);
    for (let i = dp.length; i >= 1; i--) {
      const r = this.db.get("SELECT instructions FROM decks WHERE name = ?", dp.slice(0, i).join("::"));
      if (r?.instructions) instructions.push({ from: `deck ${dp.slice(0, i).join("::")}`, text: r.instructions });
    }
    if (def.instructions) instructions.push({ from: `type ${def.id}`, text: def.instructions });
    let answerText: string | null = null;
    let answerImage: string | null = null;
    if (typeof answer === "string") answerText = answer;
    else if (answer && typeof answer === "object" && typeof (answer as any).image === "string") answerImage = (answer as any).image;
    else if (answer != null) answerText = JSON.stringify(answer);
    return { card, instructions, answerText, answerImage };
  }

  private verdictOf(score: number | null): Verdict {
    if (score == null) return "ungraded";
    if (score >= 0.999) return "correct";
    if (score <= 0.001) return "incorrect";
    return "partial";
  }

  /** Grades an answer and stores the attempt. Scheduling waits for `rate`. */
  async submit(cardId: number, seed: number, answer: unknown, opts: { practice?: boolean } = {}) {
    const c = this.cardWithDeck(cardId);
    const def = this.type(c.type);
    const cfg = this.configFor(c.deck);
    const prep = this.prepare(c.item_id, c.face, seed);
    const g = def.grader;
    let grade: Grade;
    const t0 = Date.now();
    const scripted = () => {
      const out = runScript<{ score?: number | null; details?: unknown; feedback?: string; defer?: boolean }>((g as { code: string }).code, {
        params: ["answer", "view", "key", "fields"],
        args: { answer, view: prep.view, key: prep.key, fields: prep.fields },
        where: `${def.id}/grade`,
        timeoutMs: 1000,
      });
      return out ?? {};
    };
    try {
      if (g.kind === "self") grade = { score: null, verdict: "ungraded", suggested: null, grader: { kind: "self" } };
      else if (g.kind === "script" || (g.kind === "hybrid" && !scriptedDeferred())) {
        const out = scripted();
        const score = out.score == null ? null : Math.max(0, Math.min(1, Number(out.score)));
        grade = { score, verdict: this.verdictOf(score), feedback: out.feedback, details: out.details, suggested: sched.suggestRating(score, cfg), grader: { kind: "script", ms: Date.now() - t0 } };
      } else {
        const ctx = this.gradingContext(c, prep, answer);
        const v = await aiVerdict(this.settings().ai, ctx, { vision: !!(g as { vision?: boolean }).vision });
        grade = {
          score: v.score,
          verdict: v.verdict,
          feedback: v.feedback,
          confidence: v.confidence,
          suggested: v.verdict === "correct" ? 3 : v.verdict === "partial" ? 2 : 1,
          grader: { kind: "ai", model: v.model, ms: v.ms, cost: v.cost },
        };
      }
    } catch (e) {
      if (!(e instanceof ScriptError || e instanceof AiError || e instanceof EtudeError)) throw e;
      // Grading failed: let the learner rate themselves rather than lose the answer.
      grade = { score: null, verdict: "ungraded", suggested: null, grader: { kind: g.kind, error: (e as Error).message } };
    }
    function scriptedDeferred() {
      if (g.kind !== "hybrid") return false;
      const out = scripted();
      return out.defer === true || out.score == null;
    }
    const stored = this.storeAnswer(answer, cardId);
    const id = Number(
      this.db.run("INSERT INTO attempts (card_id, ts, seed, view, answer, grade, practice) VALUES (?, ?, ?, ?, ?, ?, ?)", cardId, iso(), seed, json(prep.view), json(stored), json(grade), Number(!!opts.practice))
        .lastInsertRowid,
    );
    const wantsFeedback = !grade.feedback && grade.grader.kind === "ai" && !grade.grader.error && this.settings().ai.autoFeedback !== "never";
    return { attemptId: id, grade, key: prep.key, wantsFeedback: wantsFeedback || (this.settings().ai.autoFeedback === "always" && !grade.feedback) };
  }

  /** Drawings go to disk next to the database, not into it. */
  private storeAnswer(answer: unknown, cardId: number): unknown {
    if (answer && typeof answer === "object" && typeof (answer as any).image === "string" && (answer as any).image.startsWith("data:image/png;base64,")) {
      const b64 = (answer as any).image.slice("data:image/png;base64,".length);
      const buf = Buffer.from(b64, "base64");
      if (buf.length > 8 * 1024 * 1024) throw new EtudeError("drawing is too large");
      if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new EtudeError("drawing is not a PNG");
      mkdirSync(join(this.mediaDir, "answers"), { recursive: true });
      const name = `answers/${cardId}-${Date.now()}.png`;
      writeFileSync(join(this.mediaDir, name), buf);
      return { ...(answer as object), image: `media:${name}` };
    }
    return answer;
  }

  private loadAnswer(stored: unknown): unknown {
    if (stored && typeof stored === "object" && typeof (stored as any).image === "string" && (stored as any).image.startsWith("media:")) {
      const buf = readFileSync(join(this.mediaDir, (stored as any).image.slice(6)));
      return { ...(stored as object), image: "data:image/png;base64," + buf.toString("base64") };
    }
    return stored;
  }

  /** Writes AI feedback for an attempt (on demand, or right after an AI verdict). */
  async feedback(attemptId: number) {
    const a = this.db.get("SELECT * FROM attempts WHERE id = ?", attemptId);
    if (!a) throw new EtudeError(`unknown attempt ${attemptId}`, 404);
    const grade = parse<Grade>(a.grade, {} as Grade);
    if (grade.feedback) return { feedback: grade.feedback, cached: true };
    const c = this.cardWithDeck(a.card_id);
    const prep = this.prepare(c.item_id, c.face, a.seed);
    const answer = this.loadAnswer(parse(a.answer, null));
    const ctx = this.gradingContext(c, prep, answer);
    ctx.verdict = grade.verdict;
    ctx.score = grade.score;
    let out;
    try {
      out = await aiFeedback(this.settings().ai, ctx);
    } catch (e) {
      if (e instanceof AiError) throw new EtudeError(`feedback failed: ${e.message}`, 502);
      throw e;
    }
    grade.feedback = out.feedback;
    grade.grader = { ...grade.grader, model: grade.grader.model ? `${grade.grader.model} + ${out.model}` : out.model, cost: (grade.grader.cost ?? 0) + (out.cost ?? 0) };
    this.db.run("UPDATE attempts SET grade = ? WHERE id = ?", json(grade), attemptId);
    return { feedback: out.feedback, model: out.model, ms: out.ms, cost: out.cost };
  }

  /** Grades a fixed sample answer with the configured providers, to check keys and models. */
  async testAi() {
    const ctx: GradingContext = {
      card: [
        { label: "prompt", text: "What does HTTP stand for?" },
        { label: "reference (hidden from the student)", text: "HyperText Transfer Protocol" },
      ],
      instructions: [],
      answerText: "hypertext transfer protocol",
      answerImage: null,
    };
    const ai = this.settings().ai;
    const out: Record<string, unknown> = {};
    try {
      const v = await aiVerdict(ai, ctx);
      out.verdict = v;
      ctx.verdict = v.verdict;
      ctx.score = v.score;
    } catch (e) {
      out.verdictError = (e as Error).message;
    }
    try {
      out.feedback = await aiFeedback(ai, ctx);
    } catch (e) {
      out.feedbackError = (e as Error).message;
    }
    return out;
  }

  /** Records a rating and reschedules the card. Practice ratings are logged but don't move the schedule. */
  rate(cardId: number, rating: Rating, opts: { attemptId?: number; durationMs?: number; practice?: boolean; at?: Date } = {}) {
    if (![1, 2, 3, 4].includes(rating)) throw new EtudeError("rating must be 1 (again), 2 (hard), 3 (good) or 4 (easy)");
    const c = this.cardWithDeck(cardId);
    const t = opts.at ?? now();
    const cfg = this.configFor(c.deck);
    const before: CardRow = { ...c };
    for (const k of ["deck", "type", "tags", "item_fields"]) delete (before as any)[k];
    let score: number | null = null;
    if (opts.attemptId) {
      const a = this.db.get("SELECT grade, card_id, review_id FROM attempts WHERE id = ?", opts.attemptId);
      if (!a || a.card_id !== cardId) throw new EtudeError("attempt does not belong to this card");
      if (a.review_id) throw new EtudeError("this attempt was already rated", 409);
      score = parse<Grade>(a.grade, {} as Grade).score ?? null;
    }
    return this.db.tx(() => {
      let dueAfter = c.due;
      if (!opts.practice) {
        const { next } = sched.schedule(c, rating, t, cfg);
        dueAfter = next.due;
        this.db.run(
          "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ? WHERE id = ?",
          next.state, next.due, next.stability, next.difficulty, next.elapsed_days, next.scheduled_days, next.reps, next.lapses, next.learning_steps, next.last_review, cardId,
        );
        if (cfg.burySiblings) {
          const tomorrow = new Date(this.dayStart(t).getTime() + 86400_000);
          this.db.run("UPDATE cards SET buried_until = ? WHERE item_id = ? AND id != ? AND state = 0", iso(tomorrow), c.item_id, cardId);
        }
      }
      const rid = Number(
        this.db.run(
          "INSERT INTO reviews (card_id, attempt_id, ts, rating, state, card_before, due_after, duration_ms, score, practice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          cardId, opts.attemptId ?? null, iso(t), rating, c.state, json(before), dueAfter, opts.durationMs ?? null, score, Number(!!opts.practice),
        ).lastInsertRowid,
      );
      if (opts.attemptId) this.db.run("UPDATE attempts SET review_id = ? WHERE id = ?", rid, opts.attemptId);
      return { reviewId: rid, due: dueAfter, state: opts.practice ? c.state : this.db.get("SELECT state FROM cards WHERE id = ?", cardId)!.state };
    });
  }

  /** Undoes the most recent review: the card returns to exactly its previous state. */
  undo(): { cardId: number; itemId: string } | null {
    const r = this.db.get("SELECT * FROM reviews ORDER BY id DESC LIMIT 1");
    if (!r) return null;
    return this.db.tx(() => {
      if (!r.practice) {
        const b = parse<CardRow>(r.card_before, {} as CardRow);
        this.db.run(
          "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ? WHERE id = ?",
          b.state, b.due, b.stability, b.difficulty, b.elapsed_days, b.scheduled_days, b.reps, b.lapses, b.learning_steps, b.last_review, r.card_id,
        );
        const item = this.db.get("SELECT item_id FROM cards WHERE id = ?", r.card_id)!.item_id;
        this.db.run("UPDATE cards SET buried_until = NULL WHERE item_id = ? AND id != ?", item, r.card_id);
      }
      this.db.run("UPDATE attempts SET review_id = NULL WHERE review_id = ?", r.id);
      this.db.run("DELETE FROM reviews WHERE id = ?", r.id);
      return { cardId: r.card_id, itemId: this.db.get("SELECT item_id FROM cards WHERE id = ?", r.card_id)!.item_id };
    });
  }

  /** Recomputes cards from their review history with the current settings, e.g. after changing retention. */
  reschedule(scope: StudyScope = {}) {
    const { where, params } = this.scopeWhere({ ...scope });
    const cards = this.db.all(`SELECT c.id, c.item_id, d.name AS deck, i.created FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${where.replace("c.suspended = 0", "1")}`, ...params);
    let n = 0;
    this.db.tx(() => {
      for (const c of cards) {
        const reviews = this.db.all<{ ts: string; rating: number }>("SELECT ts, rating FROM reviews WHERE card_id = ? AND practice = 0 ORDER BY ts", c.id);
        if (!reviews.length) continue;
        const s = sched.replay(reviews, new Date(c.created), this.configFor(c.deck));
        this.db.run(
          "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ? WHERE id = ?",
          s.state, s.due, s.stability, s.difficulty, s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.learning_steps, s.last_review, c.id,
        );
        n++;
      }
    });
    return { rescheduled: n };
  }

  // ------------------------------------------------------------- overview

  deckTree() {
    const decks = this.db.all("SELECT * FROM decks WHERE archived = 0 ORDER BY name");
    const t = now();
    const totals = new Map(
      this.db
        .all("SELECT i.deck_id, COUNT(*) AS cards, SUM(c.state = 0) AS new, SUM(c.suspended) AS suspended FROM cards c JOIN items i ON i.id = c.item_id WHERE i.archived = 0 GROUP BY i.deck_id")
        .map((r) => [r.deck_id, r]),
    );
    return decks.map((d) => {
      const prefix = d.name + "::";
      let cards = 0, unseen = 0;
      for (const o of decks) if (o.name === d.name || o.name.startsWith(prefix)) {
        const tt = totals.get(o.id);
        cards += Number(tt?.cards ?? 0);
        unseen += Number(tt?.new ?? 0);
      }
      const counts = cards ? this.counts({ deck: d.name }) : { new: 0, learning: 0, learningSoon: 0, review: 0, doneToday: 0, nextDue: null };
      return { ...this.deckFromRow(d), depth: deckParts(d.name).length - 1, cards, unseen, ...counts, deadline: this.configFor(d.name).deadline ?? null, at: iso(t) };
    });
  }

  stats(scope: StudyScope = {}, days = 30) {
    const { where, params, cfg } = this.scopeWhere(scope);
    const from = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const t = now();
    const states = this.db.get(
      `SELECT COUNT(*) AS total, SUM(c.state = 0) AS new, SUM(c.state IN (1, 3)) AS learning, SUM(c.state = 2) AS review, SUM(c.state = 2 AND c.stability >= 21) AS mature ${from} WHERE ${where}`,
      ...params,
    )!;
    const since = new Date(this.dayStart(t).getTime() - (days - 1) * 86400_000);
    const rv = this.db.all(`SELECT r.ts, r.rating, r.state, r.duration_ms, r.score FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE r.ts >= ? AND r.practice = 0 AND ${where}`, iso(since), ...params);
    const byDay = new Map<string, { reviews: number; again: number; ms: number }>();
    const dayKey = (ts: string) => {
      const d = new Date(ts);
      const ds = this.dayStart(d);
      return `${ds.getFullYear()}-${String(ds.getMonth() + 1).padStart(2, "0")}-${String(ds.getDate()).padStart(2, "0")}`;
    };
    let reviewed = 0, passed = 0;
    for (const r of rv) {
      const k = dayKey(r.ts);
      const e = byDay.get(k) ?? { reviews: 0, again: 0, ms: 0 };
      e.reviews++;
      if (r.rating === 1) e.again++;
      e.ms += r.duration_ms ?? 0;
      byDay.set(k, e);
      if (r.state === 2) {
        reviewed++;
        if (r.rating > 1) passed++;
      }
    }
    const forecast: { day: string; due: number }[] = [];
    const dueRows = this.db.all(`SELECT c.due ${from} WHERE ${where} AND c.state != 0`, ...params);
    const start = this.dayStart(t).getTime();
    const buckets = new Array(30).fill(0);
    for (const r of dueRows) {
      const idx = Math.max(0, Math.floor((new Date(r.due).getTime() - start) / 86400_000));
      if (idx < 30) buckets[idx]++;
    }
    for (let i = 0; i < 30; i++) forecast.push({ day: dayKey(new Date(start + i * 86400_000 + 3600_000).toISOString()), due: buckets[i] });
    // Mean predicted recall across seen cards, per tag and overall.
    const seen = this.db.all<CardRow & { deck: string; tags: string }>(`SELECT c.*, d.name AS deck, i.tags ${from} WHERE ${where} AND c.state != 0`, ...params);
    const byTag = new Map<string, { n: number; r: number }>();
    let rSum = 0;
    for (const c of seen) {
      const r = sched.retrievability(c, t, cfg) ?? 0;
      rSum += r;
      for (const tag of parse<string[]>(c.tags, [])) {
        const e = byTag.get(tag) ?? { n: 0, r: 0 };
        e.n++;
        e.r += r;
        byTag.set(tag, e);
      }
    }
    return {
      cards: { total: Number(states.total ?? 0), new: Number(states.new ?? 0), learning: Number(states.learning ?? 0), review: Number(states.review ?? 0), mature: Number(states.mature ?? 0) },
      retention: reviewed ? passed / reviewed : null,
      recall: seen.length ? rSum / seen.length : null,
      days: [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v })),
      forecast,
      tags: [...byTag.entries()].map(([tag, v]) => ({ tag, cards: v.n, recall: v.r / v.n })).sort((a, b) => a.tag.localeCompare(b.tag)),
    };
  }

  // ------------------------------------------------------------- packs

  importPack(pack: any, opts: { dryRun?: boolean } = {}) {
    if (!pack || pack.etude !== "pack/1") throw new EtudeError('not an Etude pack (expected "etude": "pack/1")');
    const report = { presets: 0, decks: 0, types: { created: 0, updated: 0, unchanged: 0 }, items: { created: 0, updated: 0, unchanged: 0 }, tags: 0, errors: [] as string[] };
    const run = () => {
      for (const p of pack.presets ?? []) {
        this.savePreset({ id: p.id, name: p.name ?? p.id, config: p.config ?? {} });
        report.presets++;
      }
      for (const t of pack.types ?? []) {
        const existed = this.db.get("SELECT def FROM types WHERE id = ?", t.id);
        const saved = this.saveType(t);
        if (!existed) report.types.created++;
        else if (existed.def === json(saved)) report.types.unchanged++;
        else report.types.updated++;
      }
      for (const d of pack.decks ?? []) {
        this.ensureDeck(d.name);
        const patch: any = {};
        if (d.preset !== undefined) patch.presetId = d.preset;
        if (d.config !== undefined) patch.config = d.config;
        if (d.description !== undefined) patch.description = d.description;
        if (d.instructions !== undefined) patch.instructions = d.instructions;
        this.updateDeck(d.name, patch);
        report.decks++;
      }
      for (const t of pack.tags ?? []) {
        this.setTagMeta(t.name, t);
        report.tags++;
      }
      const base = (this.db.get("SELECT COALESCE(MAX(ord), 0) AS n FROM items")!.n as number) + 1;
      (pack.items ?? []).forEach((it: any, i: number) => {
        try {
          const r = this.upsertItem({ id: it.id, type: it.type, deck: it.deck, fields: it.fields ?? {}, tags: it.tags ?? [], source: it.source ?? "", notes: it.notes ?? "", archived: !!it.archived }, { ord: base + i });
          report.items[r]++;
        } catch (e) {
          report.errors.push(`${it?.id ?? `item #${i}`}: ${(e as Error).message}`);
        }
      });
      if (report.errors.length) throw new EtudeError(`import failed:\n${report.errors.join("\n")}`);
    };
    try {
      this.db.tx(() => {
        run();
        if (opts.dryRun) throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    return report;
  }

  exportPack(scope: StudyScope & { name?: string } = {}) {
    const { where, params } = this.scopeWhere(scope);
    const items = this.db.all(
      `SELECT DISTINCT i.*, d.name AS deck FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${where.replace("c.suspended = 0", "1")} ORDER BY i.ord`,
      ...params,
    );
    const deckNames = new Set<string>();
    for (const it of items) {
      const p = deckParts(it.deck);
      for (let i = 1; i <= p.length; i++) deckNames.add(p.slice(0, i).join("::"));
    }
    const decks = [...deckNames].sort().map((n) => this.deckFromRow(this.deckRow(n)));
    const presetIds = new Set(decks.map((d) => d.presetId).filter(Boolean) as string[]);
    const typeIds = new Set(items.map((i) => i.type));
    const custom = this.db.all("SELECT id, def FROM types WHERE builtin = 0").filter((t) => typeIds.has(t.id)).map((t) => parse(t.def, {}));
    const tagSet = new Set(items.flatMap((i) => parse<string[]>(i.tags, [])));
    const tags = this.db.all("SELECT * FROM tag_meta").filter((t) => tagSet.has(t.tag) && (t.instructions || t.description));
    return {
      etude: "pack/1",
      name: scope.name ?? scope.deck ?? "Etude export",
      exported: iso(),
      presets: [...presetIds].map((id) => this.preset(id)),
      decks: decks.map((d) => ({ name: d.name, ...(d.presetId ? { preset: d.presetId } : {}), ...(Object.keys(d.config).length ? { config: d.config } : {}), description: d.description, instructions: d.instructions })),
      tags: tags.map((t) => ({ name: t.tag, instructions: t.instructions, description: t.description })),
      types: custom,
      items: items.map((i) => ({ id: i.id, type: i.type, deck: i.deck, tags: parse(i.tags, []), fields: parse(i.fields, {}), source: i.source, notes: i.notes, ...(i.archived ? { archived: true } : {}) })),
    };
  }
}

class DryRun extends Error {}

export { DEFAULT_PRESET };
