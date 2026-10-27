// The engine: one object that owns the database and every operation on it.
// The HTTP server and the CLI are thin layers over this class.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, type Row } from "./db.ts";
import {
  DEFAULT_PRESET,
  type CardRow,
  type CardTypeDef,
  type Deck,
  type MetricSpec,
  type SchedulerDef,
  type Grade,
  type Item,
  type Prepared,
  type Preset,
  type PresetConfig,
  type Rating,
  type Verdict,
} from "./model.ts";
import { initSandbox, runScript, ScriptError } from "./sandbox.ts";
import { fieldDefaults, loadBuiltinTypes, validateFields, validateType, ITEM_ID, TITLE_KINDS, TYPE_ID } from "./types.ts";
import * as sched from "./scheduler.ts";
import {
  DAY_HORIZON,
  FSRS,
  FSRS_SUMMARY,
  loadBuiltinSchedulers,
  resolveOptions,
  runSchedule,
  SchedulerError,
  validateScheduler,
  type ScriptAttempt,
  type ScriptCard,
  type ScriptCtx,
} from "./schedulers.ts";
import { fitWeights, MIN_REVIEWS, OptimizerMissing, type Fit } from "./optimize.ts";
import { compile, isMediaRef, itemSearchText, QueryError, stripHtml, type Compiled } from "./query.ts";
import { AGENT_EFFORTS, aiEditFields, aiFeedback, aiVerdict, AiError, DEFAULT_AI, type AiSettings, type GradingContext } from "./ai.ts";
import {
  beginChatGptLogin,
  chatGptEndpoints,
  chatGptLogout,
  chatGptStatus,
  importChatGptCredentials,
  listChatGptModels,
  readChatGptCredentials,
  type ChatGptEndpoints,
  type ChatGptLoginOptions,
  type ChatGptLogoutResult,
  type ChatGptModel,
  type ChatGptStatus,
} from "./chatgpt.ts";
import { BUILTIN_THEMES, DEFAULT_THEME, MAX_CUSTOM_THEMES, ThemeError, builtinTheme, normalizeTheme, type Theme } from "./themes.ts";
import { openPackage } from "./anki/package.ts";
import { readCollection } from "./anki/collection.ts";
import { convertCollection, type PlannedCard } from "./anki/convert.ts";
import { collectFileNames, MAX_MEDIA_BYTES, mediaType } from "./media.ts";
import { decodeAssets, hashBytes, type AssetInfo } from "./assets.ts";
import { imagePixels, normalizeBoxes, OcclusionError } from "./occlusion.ts";

export class EtudeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILTIN_TYPES_DIR = join(ROOT, "types");
export const BUILTIN_SCHEDULERS_DIR = join(ROOT, "schedulers");

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
  /** Selected theme id: a built-in (see src/core/themes.ts) or one of `themes`. */
  theme: string;
  /** Custom themes. */
  themes: Theme[];
  /** Where the market is read from and published to; empty values mean the public market (src/core/market.ts). */
  market: { url: string; repo: string };
}

export const DEFAULT_SETTINGS: Settings = { ai: DEFAULT_AI, dayStartHour: 4, learnAheadMinutes: 20, theme: DEFAULT_THEME, themes: [], market: { url: "", repo: "" } };

/** A card on a face its item's type no longer makes. */
export interface LeftoverCard {
  cardId: number;
  itemId: string;
  type: string;
  face: string;
  reviews: number;
}

export interface LeftoverReport {
  cards: number;
  /** Cards with at least one review, and how many reviews they hold: history that goes with them. */
  reviewed: number;
  reviews: number;
  faces: { type: string; typeName: string; face: string; cards: number; reviews: number }[];
}

export interface StudyScope {
  deck?: string;
  query?: string;
  /** Study ahead: nothing has to be due. Every card in the scope is in the queue, soonest due first, with no daily limits. Ratings are real reviews. */
  ahead?: boolean;
}

export type WeightsSource = { kind: "preset"; id: string } | { kind: "deck"; name: string } | { kind: "defaults" };

export interface OptimizeResult {
  /** Where the weights live, and where `apply` saves them. */
  source: WeightsSource;
  /** Every deck that shares them, whose history was used. */
  decks: string[];
  cards: number;
  reviews: number;
  /** Training samples fsrs-rs built from the reviews. */
  items: number;
  current: number[] | null;
  weights: number[];
  before: Fit;
  after: Fit;
  better: boolean;
  applied: boolean;
  rescheduled?: number;
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
  /** Who decides when the card comes back. `ratings: false`: no Again/Hard/Good/Easy, the result is what's recorded and `next` is when it returns. */
  scheduler: { id: string; name: string; ratings: boolean; next: string | null };
  /** How this card is graded: "self" cards show a reveal button instead of Submit. */
  grader: string;
  /** Show the verdict and feedback after an answer (the type's `showVerdict`). */
  showVerdict: boolean;
  generated: boolean;
  /** One-line plain-text label (for lists and summaries). */
  title: string;
}

const TEX_SYMBOLS: Record<string, string> = { times: "×", cdot: "·", div: "÷", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", to: "→", rightarrow: "→", Rightarrow: "⇒", iff: "⇔", infty: "∞", partial: "∂", nabla: "∇", in: "∈", forall: "∀", exists: "∃", cup: "∪", cap: "∩", sum: "Σ", prod: "Π", int: "∫", sqrt: "√", ldots: "…", dots: "…", cdots: "⋯", circ: "°", deg: "°", flat: "♭", sharp: "♯", natural: "♮" };
const TEX_WORDS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "ln", "log", "exp", "lim", "max", "min", "det", "gcd", "mod"]);
const GREEK_LETTERS: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω" };
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "n": "ⁿ", "i": "ⁱ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋" };
const script = (s: string, map: Record<string, string>, mark: string) => ([...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : mark === "_" ? `_${s}` : `^${s.length > 1 ? `(${s})` : s}`);

/** One-line plain text from markdown with math: $x^3 \sin x$ reads x³ sin x, cloze blanks show their answer. */
export function plainLabel(text: string): string {
  // Anki imports keep their HTML.
  return stripHtml(text)
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^[ \t]*>+[ \t]?/gm, "")
    .replace(/\{\{([^}|:]+)[^}]*\}\}/g, "[$1]")
    .replace(/\\(?:text|mathrm|mathbf|operatorname|mathit)\{([^}]*)\}/g, "$1")
    .replace(/\\[dt]?frac\{((?:[^{}]|\{[^{}]*\})*)\}\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, a, b) => `${/^[\w\\]+$/.test(a) ? a : `(${a})`}/${/^[\w\\]+$/.test(b) ? b : `(${b})`}`)
    .replace(/\\sqrt\{([^{}]*)\}/g, (_, a) => `√${a.length > 1 ? `(${a})` : a}`)
    .replace(/\\(left|right|big|Big)\b/g, "")
    .replace(/\\(sum|prod|int)(_\{[^{}]*\}|_\w)?(\^\{[^{}]*\}|\^\w)?/g, (_, n) => TEX_SYMBOLS[n])
    .replace(/\\([a-zA-Z]+)/g, (_, n) => (TEX_WORDS.has(n) ? `${n} ` : GREEK_LETTERS[n] ?? TEX_SYMBOLS[n] ?? ""))
    .replace(/\^\{([^{}]*)\}|\^(\w)/g, (_, a, b) => script((a ?? b).trim(), SUP, "^"))
    .replace(/_\{([^{}]*)\}|_(\w)(?=\W|$)/g, (_, a, b) => script((a ?? b).trim(), SUB, "_"))
    .replace(/\\[,;! ]/g, " ")
    .replace(/[{}$]/g, "")
    .replace(/[*`#|]/g, "")
    .replace(/\s+([,.;:?!)])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * The one-line label lists show for an item: the type's `titleField`, else its first public markdown
 * field, then its other public text fields, in the type's order. Fields with a default are settings
 * (a mode, a language), never picked automatically. `withPrivate` lets private fields in (Browse and
 * Stats); a card being studied never gets one.
 */
export function itemTitle(def: CardTypeDef | null, fields: Record<string, unknown>, withPrivate: boolean): string {
  const label = (v: unknown) => {
    const t = typeof v === "string" ? plainLabel(v) : "";
    return t && !isMediaRef(t) ? t : "";
  };
  if (!def) return Object.values(fields).map(label).find(Boolean) ?? "";
  const allowed = def.fields.filter((f) => TITLE_KINDS.has(f.kind) && (withPrivate || !f.private));
  const content = allowed.filter((f) => f.default === undefined);
  const order = [
    ...allowed.filter((f) => f.name === def.titleField),
    ...content.filter((f) => !f.private && f.kind === "markdown"),
    ...content.filter((f) => !f.private),
    ...content,
  ];
  for (const f of order) {
    const t = label(fields[f.name]);
    if (t) return t;
  }
  return "";
}

/**
 * An item's cards on faces its type no longer makes. None when those faces are unknown (`null`, a
 * failing `facesWhen`) or when the item would be left without a card.
 */
function leftoversOf<T extends { face: string }>(cards: T[], faces: string[] | null): T[] {
  if (!faces) return [];
  const gone = cards.filter((c) => !faces.includes(c.face));
  return gone.length === cards.length ? [] : gone;
}

/** Bump when `itemTitle` or `itemSearchText` change, so collections rebuild the stored columns on open. */
const ITEM_INDEX_VERSION = "1";

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
  /** Where per-install files live (ChatGPT credentials): `$ETUDE_HOME`, default `~/.etude`. */
  readonly home: string;
  private typeCache = new Map<string, CardTypeDef>();
  private leftovers: { key: string; cards: LeftoverCard[] } | null = null;

  private constructor(db: Db, mediaDir: string, path: string, home: string) {
    this.db = db;
    this.mediaDir = mediaDir;
    this.path = path;
    this.home = home;
  }

  static async open(path: string, opts: { builtinTypesDir?: string; builtinSchedulersDir?: string; home?: string } = {}): Promise<Etude> {
    await initSandbox();
    const db = await Db.open(path);
    const media = path === ":memory:" ? join(process.env.TMPDIR ?? "/tmp", `etude-media-${process.pid}`) : join(dirname(path), "media");
    const home = resolve(opts.home ?? process.env.ETUDE_HOME ?? join(homedir(), ".etude"));
    const e = new Etude(db, media, path, home);
    e.syncBuiltinTypes(opts.builtinTypesDir ?? BUILTIN_TYPES_DIR);
    e.syncBuiltinSchedulers(opts.builtinSchedulersDir ?? BUILTIN_SCHEDULERS_DIR);
    // Rows saved by an older version (still running elsewhere, or restored) have blank titles and search text.
    e.reindexItems(db.get("SELECT value FROM meta WHERE key = 'item_index'")?.value === ITEM_INDEX_VERSION ? { blank: true } : {});
    return e;
  }

  close() {
    this.db.close();
  }

  /**
   * Drops in-memory caches and rebuilds the stored item columns, after the database was changed
   * underneath (an undo restore, which may come from a snapshot taken before those columns existed).
   */
  invalidateCaches() {
    this.typeCache.clear();
    this.leftovers = null;
    this.schedulerCache.clear();
    this.reindexItems();
  }

  /**
   * Rewrites the stored title and search text of every item (or only `type`'s items, or only blank
   * ones), for when what they derive from changed: a type's definition, or the derivation itself.
   */
  private reindexItems(scope: { type?: CardTypeDef; blank?: boolean } = {}) {
    const only = scope.type;
    const defs = new Map<string, CardTypeDef | null>(only ? [[only.id, only]] : []);
    const defFor = (id: string) => {
      if (!defs.has(id)) {
        let def: CardTypeDef | null = null;
        try {
          def = this.type(id);
        } catch {}
        defs.set(id, def);
      }
      return defs.get(id)!;
    };
    const rows = only
      ? this.db.all("SELECT id, type, fields, title, search FROM items WHERE type = ?", only.id)
      : this.db.all(`SELECT id, type, fields, title, search FROM items${scope.blank ? " WHERE title = '' AND search = ''" : ""}`);
    const changed: [string, string, string][] = [];
    for (const r of rows) {
      const fields = parse<Record<string, unknown>>(r.fields, {});
      const title = itemTitle(defFor(r.type), fields, true);
      const search = itemSearchText(fields);
      if (title !== r.title || search !== r.search) changed.push([title, search, r.id]);
    }
    const all = !only && !scope.blank;
    // Most opens change nothing; skip the write lock then.
    if (!changed.length && !all) return;
    this.db.tx(() => {
      for (const [title, search, id] of changed) this.db.run("UPDATE items SET title = ?, search = ? WHERE id = ?", title, search, id);
      if (all) this.db.run("INSERT INTO meta (key, value) VALUES ('item_index', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ITEM_INDEX_VERSION);
    });
  }

  /** Copies media into the collection. Identical content shares one file. */
  storeMedia(name: string, data: Uint8Array, opts: { dryRun?: boolean } = {}) {
    if (typeof name !== "string" || !name.trim()) throw new EtudeError("a media filename is required");
    const type = mediaType(name);
    if (!type) throw new EtudeError("unsupported media type; choose an image, audio or video file");
    if (!data.byteLength) throw new EtudeError("the media file is empty");
    if (data.byteLength > MAX_MEDIA_BYTES) throw new EtudeError("media files must be 100 MiB or smaller");
    const hash = createHash("sha256").update(data).digest("hex");
    const file = `files/${hash}${type.extension}`;
    const path = join(this.mediaDir, file);
    const created = !existsSync(path);
    if (created && !opts.dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      const temp = join(dirname(path), `.${hash}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, data, { flag: "wx" });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    return { name: basename(name), file, path, url: `/media/${file}`, mime: type.mime, kind: type.kind, bytes: data.byteLength, created, dryRun: !!opts.dryRun };
  }

  /**
   * Creates (or updates) an image occlusion item in one step: copies the image into media when it's
   * a local path, converts pixel boxes to fractions, then saves the item. `image` may also be an
   * existing `/media/...` URL. Dry runs store nothing.
   */
  addOcclusion(input: { image: string; boxes: unknown[]; deck: string; id?: string; px?: boolean; mode?: string; header?: string; extra?: string; tags?: string[]; source?: string; upsert?: boolean }, opts: { dryRun?: boolean } = {}) {
    if (!input || typeof input !== "object") throw new EtudeError("expected an object");
    if (typeof input.deck !== "string" || !input.deck.trim()) throw new EtudeError("a deck is required");
    if (!Array.isArray(input.boxes) || !input.boxes.length) throw new EtudeError("at least one box is required");
    if (input.mode !== undefined && input.mode !== "hide-all" && input.mode !== "hide-one") throw new EtudeError('mode must be "hide-all" or "hide-one"');
    const image = String(input.image ?? "").trim();
    if (!image) throw new EtudeError("an image is required");
    let url: string;
    let bytes: Buffer;
    let media: ReturnType<Etude["storeMedia"]> | null = null;
    if (image.startsWith("/media/")) {
      const full = resolve(this.mediaDir, image.slice("/media/".length));
      if (!full.startsWith(resolve(this.mediaDir) + "/") || !existsSync(full)) throw new EtudeError(`no media file at ${image}`, 404);
      url = image;
      bytes = readFileSync(full);
    } else {
      const local = this.readLocalMedia(image);
      if (mediaType(local.path)?.kind !== "image") throw new EtudeError("the occlusion image must be an image file");
      media = this.storeMedia(basename(local.path), local.data, opts);
      url = media.url;
      bytes = local.data;
    }
    let boxes;
    try {
      boxes = normalizeBoxes(input.boxes, input.px ? { px: imagePixels(bytes, image) } : {});
    } catch (e) {
      if (e instanceof OcclusionError) throw new EtudeError(e.message);
      throw e;
    }
    const fields: Record<string, unknown> = { image: url, boxes };
    if (input.mode && input.mode !== "hide-all") fields.mode = input.mode;
    if (input.header) fields.header = input.header;
    if (input.extra) fields.extra = input.extra;
    const id = input.id || `${deckParts(input.deck).map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean).join(".") || "occlusion"}.io-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
    const item = { id, type: "occlusion", deck: input.deck, fields, tags: input.tags ?? [], source: input.source ?? "" };
    let result: "created" | "updated" | "unchanged" = "created";
    let cards: { face: string; label: string }[] = [];
    const run = () => {
      const exists = !!this.db.get("SELECT 1 FROM items WHERE id = ?", id);
      result = this.upsertItem(item);
      if (exists && result === "updated" && !input.upsert) throw new EtudeError(`item "${id}" already exists with different content; pass upsert to update it`, 409);
      cards = this.db.all<{ face: string }>("SELECT face FROM cards WHERE item_id = ? ORDER BY id", id).map((c) => ({ face: c.face, label: boxes.filter((b) => (b.group || b.id) === c.face).map((b) => b.label).filter(Boolean).join(" / ") }));
    };
    try {
      this.db.tx(() => {
        run();
        if (opts.dryRun) throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    return { result, id, image: url, media: media ? { file: media.file, bytes: media.bytes, created: media.created } : null, boxes, cards, selfGraded: cards.filter((c) => !c.label).map((c) => c.face), dryRun: !!opts.dryRun };
  }

  /** Imports a local file or file URL; the source is left intact. */
  importMedia(input: string, opts: { dryRun?: boolean } = {}) {
    const { path, data } = this.readLocalMedia(input);
    return this.storeMedia(basename(path), data, opts);
  }

  /**
   * Files in the media folder that nothing in the collection names: no field, template, deck or tag
   * text, setting, past attempt or conversation. Hidden files, files without an extension, names
   * starting with `_` (Anki's mark for files a template loads itself) and files changed in the last hour
   * (a paste whose card isn't saved yet) are always kept.
   */
  unusedMedia(): { path: string; bytes: number }[] {
    if (!existsSync(this.mediaDir)) return [];
    const files = readdirSync(this.mediaDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => relative(this.mediaDir, join(d.parentPath, d.name)))
      .filter((rel) => !rel.split(/[\\/]/).some((part) => part.startsWith(".")) && extname(rel).length > 1 && !basename(rel).startsWith("_"));
    if (!files.length) return [];
    const exts = new Set(files.map((f) => extname(f).slice(1).toLowerCase()));
    const named = new Set<string>();
    const recent = Date.now() - 3600_000;
    const tables = this.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name);
    for (const t of tables)
      for (const row of this.db.sql.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).all() as Record<string, unknown>[])
        for (const v of Object.values(row)) {
          if (typeof v === "string") collectFileNames(v, exts, named);
          else if (v instanceof Uint8Array) collectFileNames(Buffer.from(v).toString("latin1"), exts, named);
        }
    return files
      .filter((f) => !named.has(basename(f).toLowerCase()))
      .map((f) => ({ f, stat: statSync(join(this.mediaDir, f)) }))
      .filter(({ stat }) => stat.mtimeMs < recent)
      .map(({ f, stat }) => ({ path: f.split("\\").join("/"), bytes: stat.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Deletes the media files `unusedMedia` finds. Nothing can bring them back: they aren't in database backups. */
  deleteUnusedMedia(): { files: number; bytes: number } {
    const doomed = this.unusedMedia();
    for (const f of doomed) rmSync(join(this.mediaDir, f.path), { force: true });
    return { files: doomed.length, bytes: doomed.reduce((n, f) => n + f.bytes, 0) };
  }

  private readLocalMedia(input: string): { path: string; data: Buffer } {
    if (typeof input !== "string" || !input.trim()) throw new EtudeError("a media file path is required");
    let path = input.trim();
    if (path.startsWith("file:")) {
      try { path = fileURLToPath(path); } catch { throw new EtudeError("invalid local file URL"); }
    }
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    path = resolve(path);
    if (!mediaType(path)) throw new EtudeError("unsupported media type; choose an image, audio or video file");
    let data: Buffer;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new EtudeError("the media path must point to a file");
      if (stat.size > MAX_MEDIA_BYTES) throw new EtudeError("media files must be 100 MiB or smaller");
      data = readFileSync(path);
    } catch (e) {
      if (e instanceof EtudeError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      throw new EtudeError(code === "ENOENT" ? `media file not found: ${path}` : `couldn't read media file: ${path}`, code === "ENOENT" ? 404 : 400);
    }
    return { path, data };
  }

  // ---------------------------------------------------------------- settings

  settings(): Settings {
    const s = this.db.setting<Partial<Settings>>("settings", {});
    return { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_AI, ...(s.ai ?? {}) }, market: { ...DEFAULT_SETTINGS.market, ...(s.market ?? {}) } };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const cur = this.settings();
    const next: Settings = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai ?? {}) }, market: { ...cur.market, ...(patch.market ?? {}) } };
    if (typeof next.market.url !== "string" || typeof next.market.repo !== "string") throw new EtudeError("market.url and market.repo must be text");
    if (next.market.repo && !/^[\w.-]+\/[\w.-]+$/.test(next.market.repo)) throw new EtudeError("market.repo must look like owner/name");
    if (!(next.dayStartHour >= 0 && next.dayStartHour < 24)) throw new EtudeError("dayStartHour must be 0 to 23");
    const effort = next.ai.agent?.effort;
    if (effort !== undefined && !AGENT_EFFORTS.includes(effort)) throw new EtudeError(`ai.agent.effort must be one of ${AGENT_EFFORTS.join(", ")}`);
    if (patch.themes !== undefined) next.themes = this.checkThemes(patch.themes);
    if (patch.theme !== undefined || patch.themes !== undefined) {
      if (typeof next.theme !== "string" || !this.findTheme(next.theme, next.themes)) throw new EtudeError(`unknown theme "${next.theme}"`, 404);
    }
    this.db.setSetting("settings", next);
    return next;
  }

  // ------------------------------------------------------------------ themes

  private findTheme(id: string, custom: Theme[]): Theme | undefined {
    return builtinTheme(id) ?? custom.find((t) => t.id === id);
  }

  private checkThemes(list: unknown): Theme[] {
    if (!Array.isArray(list)) throw new EtudeError("themes must be a list");
    if (list.length > MAX_CUSTOM_THEMES) throw new EtudeError(`at most ${MAX_CUSTOM_THEMES} custom themes`);
    const seen = new Set<string>();
    return list.map((raw) => {
      let t: Theme;
      try {
        t = normalizeTheme(raw).theme;
      } catch (e) {
        throw new EtudeError(e instanceof ThemeError ? e.message : String(e));
      }
      if (builtinTheme(t.id)) throw new EtudeError(`"${t.id}" is a built-in theme id; pick another`, 409);
      if (seen.has(t.id)) throw new EtudeError(`two themes share the id "${t.id}"`, 409);
      seen.add(t.id);
      return t;
    });
  }

  /** Built-in themes first, then custom ones. */
  listThemes(): (Theme & { builtin: boolean; selected: boolean })[] {
    const s = this.settings();
    return [...BUILTIN_THEMES.map((t) => ({ ...t, builtin: true })), ...s.themes.map((t) => ({ ...t, builtin: false }))].map((t) => ({ ...t, selected: t.id === s.theme }));
  }

  theme(id: string): Theme & { builtin: boolean } {
    const b = builtinTheme(id);
    if (b) return { ...structuredClone(b), builtin: true };
    const t = this.settings().themes.find((x) => x.id === id);
    if (!t) throw new EtudeError(`unknown theme "${id}"`, 404);
    return { ...t, builtin: false };
  }

  /** The theme the app should use: the selected one, or the default when it was deleted elsewhere. */
  currentTheme(): Theme {
    const s = this.settings();
    return this.findTheme(s.theme, s.themes) ?? builtinTheme(DEFAULT_THEME)!;
  }

  selectTheme(id: string): Theme {
    this.updateSettings({ theme: id });
    return this.currentTheme();
  }

  /** Creates or replaces a custom theme. Returns it as stored, with any CSS that was stripped. */
  saveTheme(input: unknown, opts: { create?: boolean } = {}): { theme: Theme; removed: string[]; created: boolean } {
    let res: { theme: Theme; removed: string[] };
    try {
      res = normalizeTheme(input);
    } catch (e) {
      throw new EtudeError(e instanceof ThemeError ? e.message : String(e));
    }
    if (builtinTheme(res.theme.id)) throw new EtudeError(`"${res.theme.id}" is a built-in theme; save a copy under another id`, 409);
    const list = this.settings().themes;
    const i = list.findIndex((t) => t.id === res.theme.id);
    if (i >= 0 && opts.create) throw new EtudeError(`theme "${res.theme.id}" already exists`, 409);
    const next = i >= 0 ? list.map((t, j) => (j === i ? res.theme : t)) : [...list, res.theme];
    this.updateSettings({ themes: next });
    return { ...res, created: i < 0 };
  }

  /** Removes a custom theme; the app falls back to the default if it was selected. */
  deleteTheme(id: string): { deleted: string; selected: string } {
    if (builtinTheme(id)) throw new EtudeError(`"${id}" is built in and can't be deleted`, 409);
    const s = this.settings();
    if (!s.themes.some((t) => t.id === id)) throw new EtudeError(`unknown theme "${id}"`, 404);
    const selected = s.theme === id ? DEFAULT_THEME : s.theme;
    this.updateSettings({ themes: s.themes.filter((t) => t.id !== id), theme: selected });
    return { deleted: id, selected };
  }

  /** Start of the current study day, in local time. */
  dayStart(at = now()): Date {
    const h = this.settings().dayStartHour;
    const d = new Date(at);
    d.setHours(h, 0, 0, 0);
    if (d > at) d.setDate(d.getDate() - 1);
    return d;
  }

  // -------------------------------------------------------------- schedulers
  // FSRS lives in scheduler.ts. Every other scheduler is a script stored here, like a card type.

  private syncBuiltinSchedulers(dir: string) {
    const defs = loadBuiltinSchedulers(dir);
    const stale = defs.filter((def) => {
      const row = this.db.get("SELECT def, builtin FROM schedulers WHERE id = ?", def.id);
      return !row || (row.builtin !== 0 && row.def !== json(def));
    });
    if (stale.length) this.db.tx(() => {
      for (const def of stale) {
        const row = this.db.get("SELECT builtin FROM schedulers WHERE id = ?", def.id);
        if (row && row.builtin === 0) continue;
        this.db.run(
          "INSERT INTO schedulers (id, def, builtin, updated) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, updated = excluded.updated",
          def.id,
          json(def),
          iso(),
        );
      }
    });
    this.schedulerCache.clear();
    this.builtinSchedulersDir = dir;
  }
  private builtinSchedulersDir = BUILTIN_SCHEDULERS_DIR;
  private schedulerCache = new Map<string, SchedulerDef & { builtin: boolean; updated: string }>();

  /** FSRS first, then every stored scheduler, with how many decks set each one. */
  listSchedulers() {
    const uses = new Map<string, number>();
    for (const d of this.db.all("SELECT name FROM decks WHERE archived = 0")) {
      const id = this.configFor(d.name).scheduler;
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    let shipped: Set<string>;
    try {
      shipped = new Set(loadBuiltinSchedulers(this.builtinSchedulersDir).map((s) => s.id));
    } catch {
      shipped = new Set();
    }
    const stored = this.db.all("SELECT id, def, builtin, updated FROM schedulers ORDER BY builtin DESC, id").map((r) => {
      const def = parse<SchedulerDef>(r.def, {} as SchedulerDef);
      return {
        id: r.id as string,
        name: def.name,
        description: def.description ?? "",
        ratings: def.ratings !== false,
        options: def.options ?? [],
        stats: def.stats ?? null,
        builtin: !!r.builtin,
        shipped: shipped.has(r.id),
        edited: shipped.has(r.id) && !r.builtin,
        script: true,
        updated: r.updated as string,
        decks: uses.get(r.id) ?? 0,
      };
    });
    return [{ ...FSRS_SUMMARY, shipped: true, edited: false, updated: null as string | null, decks: uses.get(FSRS) ?? 0 }, ...stored];
  }

  /** A script scheduler's definition. FSRS has no script; asking for it is an error. */
  scheduler(id: string): SchedulerDef & { builtin: boolean; updated: string } {
    const row = this.db.get("SELECT def, updated, builtin FROM schedulers WHERE id = ?", id);
    if (!row) throw new EtudeError(id === FSRS ? "FSRS is built in and has no script" : `unknown scheduler "${id}"`, 404);
    const cached = this.schedulerCache.get(id);
    if (cached && cached.updated === row.updated) return cached;
    const def = { ...parse<SchedulerDef>(row.def, {} as SchedulerDef), builtin: !!row.builtin, updated: row.updated as string };
    this.schedulerCache.set(id, def);
    return def;
  }

  saveScheduler(def: SchedulerDef): { result: "created" | "updated" | "unchanged"; scheduler: SchedulerDef } {
    const errors = validateScheduler(def);
    if (errors.length) throw new EtudeError(`invalid scheduler: ${errors.join("; ")}`);
    const clean: SchedulerDef = {
      id: def.id,
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      ratings: def.ratings !== false,
      ...(def.options?.length ? { options: def.options } : {}),
      ...(def.stats ? { stats: { groupBy: def.stats.groupBy, ...(def.stats.label ? { label: def.stats.label } : {}) } } : {}),
      schedule: def.schedule,
    };
    const old = this.db.get("SELECT def FROM schedulers WHERE id = ?", def.id);
    if (old && old.def === json(clean)) return { result: "unchanged", scheduler: clean };
    this.db.run(
      "INSERT INTO schedulers (id, def, builtin, updated) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, builtin = 0, updated = excluded.updated",
      clean.id,
      json(clean),
      iso(),
    );
    this.schedulerCache.delete(def.id);
    return { result: old ? "updated" : "created", scheduler: clean };
  }

  /** Puts an edited built-in scheduler back to the shipped version. */
  resetScheduler(id: string) {
    const shipped = loadBuiltinSchedulers(this.builtinSchedulersDir).find((s) => s.id === id);
    if (!shipped) throw new EtudeError(`"${id}" is not a built-in scheduler`);
    this.db.run("UPDATE schedulers SET def = ?, builtin = 1, updated = ? WHERE id = ?", json(shipped), iso(), id);
    this.schedulerCache.delete(id);
  }

  deleteScheduler(id: string) {
    const row = this.db.get("SELECT builtin FROM schedulers WHERE id = ?", id);
    if (!row) throw new EtudeError(`unknown scheduler "${id}"`, 404);
    if (row.builtin) throw new EtudeError("built-in schedulers can't be deleted");
    const users = [
      ...this.db.all("SELECT name, config FROM decks").filter((d) => parse<Partial<PresetConfig>>(d.config, {}).scheduler === id).map((d) => `deck ${d.name}`),
      ...this.db.all("SELECT id, config FROM presets").filter((p) => parse<Partial<PresetConfig>>(p.config, {}).scheduler === id).map((p) => `preset ${p.id}`),
    ];
    if (users.length) throw new EtudeError(`scheduler "${id}" is used by ${users.slice(0, 5).join(", ")}${users.length > 5 ? ", …" : ""}`, 409);
    this.db.run("DELETE FROM schedulers WHERE id = ?", id);
    this.schedulerCache.delete(id);
  }

  /** The script scheduler a config uses, or null for FSRS (and for a scheduler that no longer exists). */
  private scriptFor(cfg: PresetConfig): SchedulerDef | null {
    if (!cfg.scheduler || cfg.scheduler === FSRS) return null;
    try {
      return this.scheduler(cfg.scheduler);
    } catch {
      return null;
    }
  }

  private checkSchedulerRef(config: Partial<PresetConfig> | undefined) {
    const id = config?.scheduler;
    if (!id || id === FSRS) return;
    if (!this.db.get("SELECT 1 AS x FROM schedulers WHERE id = ?", id)) throw new EtudeError(`unknown scheduler "${id}" (see \`etude scheduler list\`)`);
  }

  /** Day starts from `at`'s study day onward: what a scheduler script gets as `ctx.day`. */
  private dayStarts(at: Date): string[] {
    const first = this.dayStart(at);
    const out: string[] = [];
    for (let i = 0; i <= DAY_HORIZON; i++) {
      const d = new Date(first);
      d.setDate(d.getDate() + i);
      out.push(d.toISOString());
    }
    return out;
  }

  /** Runs a card's script scheduler for one answer. */
  private runScheduler(def: SchedulerDef, cfg: PresetConfig, card: CardRow & { created?: string }, attempt: ScriptAttempt, t: Date) {
    const dayStart = iso(this.dayStart(t));
    const history = this.db
      .all<{ ts: string; rating: number; score: number | null }>("SELECT ts, rating, score FROM reviews WHERE card_id = ? AND practice = 0 AND ts <= ? ORDER BY ts DESC LIMIT 50", card.id, iso(t))
      .reverse();
    const doneToday = history.filter((h) => h.ts >= dayStart).length;
    const sc: ScriptCard = { state: parse(card.sched_state ?? null, null), reps: card.reps, due: card.due, lastReview: card.last_review, created: card.created ?? card.due };
    const ctx: ScriptCtx = { now: iso(t), day: this.dayStarts(t), doneToday, history: history.map((h) => ({ at: h.ts, rating: h.rating || null, score: h.score })) };
    try {
      return runSchedule(def, sc, attempt, resolveOptions(def, cfg.schedulerOptions), ctx);
    } catch (e) {
      if (e instanceof SchedulerError || e instanceof ScriptError) throw new EtudeError(`scheduler "${def.id}": ${e.message}`);
      throw e;
    }
  }

  /** What the rating buttons (or the single Next) would do for a card right now. */
  private previewFor(c: CardRow & { deck: string; created?: string }, cfg: PresetConfig, t: Date): { intervals: Record<Rating, string>; scheduler: StudyCard["scheduler"] } {
    const def = this.scriptFor(cfg);
    if (!def) return { intervals: sched.preview(c, t, cfg), scheduler: { id: FSRS, name: "FSRS", ratings: true, next: null } };
    const out = {} as Record<Rating, string>;
    let next: string | null = null;
    try {
      if (def.ratings !== false) for (const r of [1, 2, 3, 4] as Rating[]) out[r] = this.runScheduler(def, cfg, c, { rating: r, score: null, verdict: null, details: null, ms: null, at: iso(t) }, t).due;
      else {
        next = this.runScheduler(def, cfg, c, { rating: null, score: null, verdict: null, details: null, ms: null, at: iso(t) }, t).due;
        for (const r of [1, 2, 3, 4] as Rating[]) out[r] = next;
      }
    } catch {
      for (const r of [1, 2, 3, 4] as Rating[]) out[r] ??= iso(t);
    }
    return { intervals: out, scheduler: { id: def.id, name: def.name, ratings: def.ratings !== false, next } };
  }

  // ------------------------------------------------------------------- types

  private syncBuiltinTypes(dir: string) {
    const ts = iso();
    const defs = loadBuiltinTypes(dir).map(splitAssets);
    // Most opens change nothing; skip the write lock then.
    const stale = defs.filter(({ def, assets }) => {
      const row = this.db.get("SELECT def, builtin FROM types WHERE id = ?", def.id);
      return !row || (row.builtin !== 0 && (row.def !== json(def) || this.assetsDiffer(def.id, assets ?? {})));
    });
    if (stale.length) this.db.tx(() => {
      for (const { def, assets } of stale) {
        const row = this.db.get("SELECT builtin FROM types WHERE id = ?", def.id);
        // A built-in the user has edited (builtin = 0) is theirs now; leave it alone.
        if (row && row.builtin === 0) continue;
        const delta = this.writeAssets(def.id, assets ?? {});
        this.db.run(
          "INSERT INTO types (id, def, builtin, updated) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, updated = CASE WHEN types.def = excluded.def AND ? = 0 THEN types.updated ELSE excluded.updated END",
          def.id,
          json(def),
          ts,
          Number(assetsChanged(delta)),
        );
        this.reindexItems({ type: def });
      }
    });
    this.typeCache.clear();
    this.builtinDir = dir;
  }
  private builtinDir = BUILTIN_TYPES_DIR;

  /**
   * Every stored type. `shipped`: a type with this id ships in the built-in types directory.
   * `edited`: shipped, but the user saved their own version (builtin = 0), so it can be reset.
   */
  listTypes() {
    let shipped: Set<string>;
    try {
      shipped = new Set(loadBuiltinTypes(this.builtinDir, { assets: false }).map((t) => t.id));
    } catch {
      shipped = new Set();
    }
    const files = new Map<string, { name: string; size: number }[]>();
    for (const a of this.db.all("SELECT type_id, name, size FROM type_assets ORDER BY type_id, name")) {
      const list = files.get(a.type_id) ?? [];
      list.push({ name: a.name, size: a.size });
      files.set(a.type_id, list);
    }
    return this.db
      .all(
        "SELECT t.id, t.def, t.builtin, t.updated, (SELECT COUNT(*) FROM items i WHERE i.type = t.id AND i.archived = 0) AS items, (SELECT COUNT(*) FROM items i WHERE i.type = t.id AND i.archived = 1) AS archived, COALESCE(p.folder, '') AS folder FROM types t LEFT JOIN type_placement p ON p.type_id = t.id ORDER BY t.builtin DESC, t.id",
      )
      .map((r) => {
        const def = parse<CardTypeDef>(r.def, {} as CardTypeDef);
        const isShipped = shipped.has(r.id);
        return {
          id: r.id,
          name: def.name,
          description: def.description ?? "",
          builtin: !!r.builtin,
          shipped: isShipped,
          edited: isShipped && !r.builtin,
          updated: r.updated,
          items: r.items,
          archived: r.archived,
          grader: def.grader?.kind,
          folder: r.folder as string,
          assetFiles: files.get(r.id) ?? [],
        };
      });
  }

  // ------------------------------------------------------------ type folders
  // Folders only organize the Types page; they never change a type or its items.

  /** Every folder path, sorted, including the parents of nested ones. */
  listTypeFolders(): string[] {
    const paths = new Set<string>();
    const add = (p: string) => {
      const parts = deckParts(p);
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("::"));
    };
    for (const r of this.db.all("SELECT path FROM type_folders")) add(r.path);
    for (const r of this.db.all("SELECT folder FROM type_placement")) add(r.folder);
    return [...paths].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  /** Creates a folder (and its parents). Returns the normalized path. */
  createTypeFolder(path: string): string {
    const p = normDeck(path);
    if (!p) throw new EtudeError("folder name can't be empty");
    const parts = deckParts(p);
    this.db.tx(() => {
      for (let i = 1; i <= parts.length; i++) this.db.run("INSERT OR IGNORE INTO type_folders (path) VALUES (?)", parts.slice(0, i).join("::"));
    });
    return p;
  }

  /** Puts a type in a folder ("" takes it out of every folder). The folder is created if needed. */
  moveType(id: string, folder: string): string {
    if (!this.db.get("SELECT 1 AS x FROM types WHERE id = ?", id)) throw new EtudeError(`unknown type "${id}"`, 404);
    const f = normDeck(folder ?? "");
    this.db.tx(() => {
      if (!f) this.db.run("DELETE FROM type_placement WHERE type_id = ?", id);
      else {
        this.createTypeFolder(f);
        this.db.run("INSERT INTO type_placement (type_id, folder) VALUES (?, ?) ON CONFLICT(type_id) DO UPDATE SET folder = excluded.folder", id, f);
      }
    });
    return f;
  }

  private underFolder(path: string) {
    return { eq: path, like: path.replace(/[\\%_]/g, "\\$&") + "::%" };
  }

  /** Renames or moves a folder with everything inside it (A::B → C::B). */
  renameTypeFolder(from: string, to: string): { from: string; to: string; folders: number; types: number } {
    const src = normDeck(from), dst = normDeck(to);
    if (!src || !dst) throw new EtudeError("folder names can't be empty");
    if (!this.listTypeFolders().includes(src)) throw new EtudeError(`no folder "${src}"`, 404);
    if (dst === src) return { from: src, to: dst, folders: 0, types: 0 };
    if (dst.startsWith(src + "::")) throw new EtudeError("a folder can't move inside itself");
    const { eq, like } = this.underFolder(src);
    let folders = 0, types = 0;
    this.db.tx(() => {
      // Implied folders (only parents of placements) become real rows so they survive the move.
      for (const p of this.listTypeFolders()) if (p === src || p.startsWith(src + "::")) this.db.run("INSERT OR IGNORE INTO type_folders (path) VALUES (?)", p);
      for (const r of this.db.all("SELECT path FROM type_folders WHERE path = ? OR path LIKE ? ESCAPE '\\'", eq, like)) {
        this.db.run("DELETE FROM type_folders WHERE path = ?", r.path);
        this.db.run("INSERT OR IGNORE INTO type_folders (path) VALUES (?)", dst + r.path.slice(src.length));
        folders++;
      }
      for (const r of this.db.all("SELECT type_id, folder FROM type_placement WHERE folder = ? OR folder LIKE ? ESCAPE '\\'", eq, like)) {
        this.db.run("UPDATE type_placement SET folder = ? WHERE type_id = ?", dst + r.folder.slice(src.length), r.type_id);
        types++;
      }
      this.createTypeFolder(dst);
    });
    return { from: src, to: dst, folders, types };
  }

  /**
   * Deletes a folder and the folders inside it. Types are never deleted: everything that was
   * inside moves up to the deleted folder's parent.
   */
  deleteTypeFolder(path: string): { deleted: string; folders: number; moved: string[] } {
    const p = normDeck(path);
    if (!this.listTypeFolders().includes(p)) throw new EtudeError(`no folder "${p}"`, 404);
    const parent = deckParts(p).slice(0, -1).join("::");
    const { eq, like } = this.underFolder(p);
    const moved: string[] = [];
    let folders = 0;
    this.db.tx(() => {
      folders = this.listTypeFolders().filter((f) => f === p || f.startsWith(p + "::")).length;
      this.db.run("DELETE FROM type_folders WHERE path = ? OR path LIKE ? ESCAPE '\\'", eq, like);
      for (const r of this.db.all("SELECT type_id FROM type_placement WHERE folder = ? OR folder LIKE ? ESCAPE '\\'", eq, like)) {
        moved.push(r.type_id);
        if (parent) this.db.run("UPDATE type_placement SET folder = ? WHERE type_id = ?", parent, r.type_id);
        else this.db.run("DELETE FROM type_placement WHERE type_id = ?", r.type_id);
      }
      if (parent) this.createTypeFolder(parent);
    });
    return { deleted: p, folders, moved };
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
    return this.saveTypeReport(def).type;
  }

  /**
   * Saves a type and says what changed. `def.assets` replaces the type's asset set (names left out
   * are removed); without `assets` the stored assets stay as they are.
   */
  saveTypeReport(def: CardTypeDef): { type: CardTypeDef; result: "created" | "updated" | "unchanged"; assets: AssetDelta | null; leftover: { cards: number; reviews: number } | null } {
    const errors = validateType(def);
    if (errors.length) throw new EtudeError(`invalid type: ${errors.join("; ")}`);
    const clean: CardTypeDef = {
      id: def.id,
      name: def.name,
      description: def.description ?? "",
      ...(def.faces ? { faces: def.faces } : {}),
      ...(def.facesWhen ? { facesWhen: def.facesWhen } : {}),
      fields: def.fields,
      ...(def.titleField ? { titleField: def.titleField } : {}),
      ...(def.prepare ? { prepare: def.prepare } : {}),
      template: { html: def.template.html, css: def.template.css ?? "", js: def.template.js ?? "" },
      grader: def.grader,
      ...(def.instructions ? { instructions: def.instructions } : {}),
      ...(def.demo ? { demo: def.demo } : {}),
      ...(def.metrics?.length ? { metrics: def.metrics } : {}),
      ...(def.showVerdict === false ? { showVerdict: false } : {}),
    };
    const old = this.db.get("SELECT def FROM types WHERE id = ?", def.id);
    const sameDef = !!old && old.def === json(clean);
    if (sameDef && (def.assets === undefined || !this.assetsDiffer(def.id, def.assets))) {
      return { type: clean, result: "unchanged", assets: def.assets === undefined ? null : this.unchangedDelta(def.id), leftover: null };
    }
    let assets: AssetDelta | null = null;
    let leftover: { cards: number; reviews: number } | null = null;
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO types (id, def, builtin, updated) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, builtin = 0, updated = excluded.updated",
        clean.id,
        json(clean),
        iso(),
      );
      if (def.assets !== undefined) assets = this.writeAssets(clean.id, def.assets);
      if (!sameDef) {
        leftover = this.ensureCardsForType(clean.id);
        this.reindexItems({ type: clean });
      }
    });
    this.typeCache.delete(def.id);
    return { type: clean, result: old ? "updated" : "created", assets, leftover };
  }

  // ------------------------------------------------------------ type assets

  /** A type's asset files: name, size and content hash (never the bytes). */
  typeAssets(id: string): AssetInfo[] {
    return this.db.all("SELECT name, size, hash FROM type_assets WHERE type_id = ? ORDER BY name", id).map((r) => ({ name: r.name, size: r.size, hash: r.hash }));
  }

  /** One asset's bytes, or undefined. */
  typeAsset(id: string, name: string): { bytes: Uint8Array; hash: string; size: number } | undefined {
    return this.db.get("SELECT bytes, hash, size FROM type_assets WHERE type_id = ? AND name = ?", id, name) as any;
  }

  /** The type's assets in their JSON form, `{ name: base64 }`. */
  typeAssetData(id: string): Record<string, string> {
    return Object.fromEntries(this.db.all("SELECT name, bytes FROM type_assets WHERE type_id = ? ORDER BY name", id).map((r) => [r.name, Buffer.from(r.bytes).toString("base64")]));
  }

  /** The stored definition plus its assets as base64, the way packs, exports and the market carry it. */
  typeWithAssets(id: string): CardTypeDef {
    const { updated: _u, builtin: _b, ...def } = this.type(id) as CardTypeDef & { updated?: string; builtin?: boolean };
    const assets = this.typeAssetData(id);
    return Object.keys(assets).length ? { ...def, assets } : def;
  }

  private assetsDiffer(id: string, assets: Record<string, string>): boolean {
    const stored = new Map(this.db.all("SELECT name, hash FROM type_assets WHERE type_id = ?", id).map((r) => [r.name as string, r.hash as string]));
    const names = Object.keys(assets);
    if (names.length !== stored.size) return true;
    return names.some((n) => stored.get(n) !== hashBytes(Buffer.from(assets[n], "base64")));
  }

  private unchangedDelta(id: string): AssetDelta {
    const rows = this.typeAssets(id);
    return { files: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0), created: 0, updated: 0, unchanged: rows.length, removed: 0 };
  }

  /** Replaces a type's asset set with `assets`. */
  private writeAssets(id: string, assets: Record<string, string>): AssetDelta {
    const stored = new Map(this.db.all("SELECT name, hash FROM type_assets WHERE type_id = ?", id).map((r) => [r.name as string, r.hash as string]));
    const delta: AssetDelta = { files: 0, bytes: 0, created: 0, updated: 0, unchanged: 0, removed: 0 };
    for (const [name, bytes] of decodeAssets(assets)) {
      const hash = hashBytes(bytes);
      delta.files++;
      delta.bytes += bytes.length;
      const prev = stored.get(name);
      stored.delete(name);
      if (prev === hash) {
        delta.unchanged++;
        continue;
      }
      this.db.run(
        "INSERT INTO type_assets (type_id, name, hash, size, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(type_id, name) DO UPDATE SET hash = excluded.hash, size = excluded.size, bytes = excluded.bytes",
        id,
        name,
        hash,
        bytes.length,
        bytes,
      );
      if (prev === undefined) delta.created++;
      else delta.updated++;
    }
    for (const name of stored.keys()) {
      this.db.run("DELETE FROM type_assets WHERE type_id = ? AND name = ?", id, name);
      delta.removed++;
    }
    return delta;
  }

  /** Restores a built-in type that was edited back to the shipped version. */
  resetType(id: string) {
    const found = loadBuiltinTypes(this.builtinDir).find((t) => t.id === id);
    if (!found) throw new EtudeError(`"${id}" is not a built-in type`);
    const { def: shipped, assets } = splitAssets(found);
    this.db.tx(() => {
      this.db.run("UPDATE types SET def = ?, builtin = 1, updated = ? WHERE id = ?", json(shipped), iso(), id);
      this.writeAssets(id, assets ?? {});
      this.reindexItems({ type: shipped });
    });
    this.typeCache.delete(id);
  }

  /** The items using a type (archived ones among them), with their cards and reviews: what deleting it with its items takes. */
  typeUsage(id: string): { items: number; archived: number; cards: number; reviews: number } {
    const r = this.db.get<{ items: number; archived: number; cards: number; reviews: number }>(
      `SELECT COUNT(*) AS items, COALESCE(SUM(i.archived), 0) AS archived,
         (SELECT COUNT(*) FROM cards c JOIN items j ON j.id = c.item_id WHERE j.type = ?) AS cards,
         (SELECT COUNT(*) FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items j ON j.id = c.item_id WHERE j.type = ?) AS reviews
       FROM items i WHERE i.type = ?`,
      id,
      id,
      id,
    )!;
    return { items: r.items, archived: r.archived, cards: r.cards, reviews: r.reviews };
  }

  /**
   * Deletes a custom type. Items using it (archived ones count) stop it, unless `items` deletes them
   * too, with their cards and review history. Returns what went with it.
   */
  deleteType(id: string, opts: { items?: boolean } = {}): { items: number; cards: number; reviews: number } {
    const row = this.db.get("SELECT builtin FROM types WHERE id = ?", id);
    if (row?.builtin) throw new EtudeError("built-in types can't be deleted");
    const used = this.typeUsage(id);
    if (used.items && !opts.items)
      throw new EtudeError(`type "${id}" is used by ${used.items} item(s)${used.archived === used.items ? ", all archived" : used.archived ? `, ${used.archived} of them archived` : ""}`);
    this.db.tx(() => {
      // Cards, their attempts and reviews, and tags go with the items.
      if (opts.items) this.db.run("DELETE FROM items WHERE type = ?", id);
      this.db.run("DELETE FROM types WHERE id = ?", id);
      this.db.run("DELETE FROM type_placement WHERE type_id = ?", id);
      this.db.run("DELETE FROM type_assets WHERE type_id = ?", id);
    });
    this.typeCache.delete(id);
    return opts.items ? { items: used.items, cards: used.cards, reviews: used.reviews } : { items: 0, cards: 0, reviews: 0 };
  }

  /**
   * Creates the cards a type's items are missing, and counts the leftovers: cards on faces it no longer
   * makes, which stay until deleted (see `leftoverCards`).
   */
  private ensureCardsForType(typeId: string): { cards: number; reviews: number } {
    const def = this.type(typeId);
    const ts = iso();
    const gone: number[] = [];
    for (const it of this.db.all("SELECT id, fields, archived FROM items WHERE type = ?", typeId)) {
      const faces = this.facesMade(def, parse<Record<string, unknown>>(it.fields, {}));
      for (const face of faces ?? def.faces ?? ["main"]) this.db.run("INSERT OR IGNORE INTO cards (item_id, face, due) VALUES (?, ?, ?)", it.id, face, ts);
      if (!it.archived) for (const c of leftoversOf(this.db.all<{ id: number; face: string }>("SELECT id, face FROM cards WHERE item_id = ?", it.id), faces)) gone.push(c.id);
    }
    const reviews = gone.length ? this.reviewsPerCard() : new Map<number, number>();
    return { cards: gone.length, reviews: gone.reduce((n, id) => n + (reviews.get(id) ?? 0), 0) };
  }

  /**
   * The faces an item should have. Without `facesWhen` that's the type's `faces`; with it the script
   * is authoritative for the item, so it can leave faces out (an unused cloze) or add one (`c4` in a
   * note that gained a fourth cloze). Cards that already exist are never removed.
   */
  facesFor(def: CardTypeDef, fields: Record<string, unknown>): string[] {
    // A broken script must not stop items from being saved; fall back to every face.
    return this.facesMade(def, fields) ?? def.faces ?? ["main"];
  }

  /** The faces a type makes for an item, or null when its `facesWhen` fails or doesn't return a list. */
  private facesMade(def: CardTypeDef, fields: Record<string, unknown>): string[] | null {
    if (!def.facesWhen) return def.faces ?? ["main"];
    try {
      const out = runScript<string[]>(def.facesWhen!, { params: ["fields"], args: { fields }, where: `${def.id}/facesWhen` });
      return Array.isArray(out) ? [...new Set(out.filter((f) => typeof f === "string" && /^[\w-]+$/.test(f)))] : null;
    } catch {
      return null;
    }
  }

  /**
   * Cards on faces their item's type no longer makes, after its `faces` or `facesWhen` changed. Saving a
   * type never removes them, so their history isn't lost by accident. An item keeps every card when its
   * faces can't be worked out (a failing `facesWhen`) or when it would be left with none. Archived items
   * are left alone, like everywhere else: their cards never come up anyway.
   */
  leftoverCards(opts: { type?: string; face?: string } = {}): LeftoverCard[] {
    // Finding them runs facesWhen for every item, so the answer is kept until items, cards, reviews or types change.
    const key = this.db.get<{ k: string }>(
      "SELECT total_changes() || ':' || (SELECT data_version FROM pragma_data_version) AS k",
    )!.k;
    if (this.leftovers?.key !== key) this.leftovers = { key, cards: this.findLeftoverCards() };
    return this.leftovers.cards.filter((c) => (!opts.type || c.type === opts.type) && (!opts.face || c.face === opts.face));
  }

  private findLeftoverCards(): LeftoverCard[] {
    const rows = this.db.all<{ id: number; item_id: string; face: string; type: string; fields: string }>(
      "SELECT c.id, c.item_id, c.face, i.type, i.fields FROM cards c JOIN items i ON i.id = c.item_id WHERE i.archived = 0 ORDER BY i.ord, i.id, c.id",
    );
    const defs = new Map<string, CardTypeDef | null>();
    const defFor = (id: string) => {
      if (!defs.has(id)) {
        let def: CardTypeDef | null = null;
        try {
          def = this.type(id);
        } catch {}
        defs.set(id, def);
      }
      return defs.get(id)!;
    };
    const out: LeftoverCard[] = [];
    for (let i = 0; i < rows.length; ) {
      let j = i;
      while (j < rows.length && rows[j].item_id === rows[i].item_id) j++;
      const cards = rows.slice(i, j);
      i = j;
      const def = defFor(cards[0].type);
      if (!def) continue;
      for (const c of leftoversOf(cards, this.facesMade(def, parse<Record<string, unknown>>(cards[0].fields, {})))) out.push({ cardId: c.id, itemId: c.item_id, type: c.type, face: c.face, reviews: 0 });
    }
    if (out.length) {
      const reviews = this.reviewsPerCard();
      for (const c of out) c.reviews = reviews.get(c.cardId) ?? 0;
    }
    return out;
  }

  private reviewsPerCard(): Map<number, number> {
    return new Map(this.db.all<{ card_id: number; n: number }>("SELECT card_id, COUNT(*) AS n FROM reviews GROUP BY card_id").map((r) => [r.card_id, r.n]));
  }

  /** Leftover cards counted per type and face, with the history that would go with them. */
  leftoverReport(opts: { type?: string; face?: string } = {}): LeftoverReport {
    const cards = this.leftoverCards(opts);
    const faces = new Map<string, LeftoverReport["faces"][number]>();
    for (const c of cards) {
      const key = `${c.type}\u0000${c.face}`;
      let f = faces.get(key);
      if (!f) {
        let typeName = c.type;
        try {
          typeName = this.type(c.type).name;
        } catch {}
        faces.set(key, (f = { type: c.type, typeName, face: c.face, cards: 0, reviews: 0 }));
      }
      f.cards++;
      f.reviews += c.reviews;
    }
    return { cards: cards.length, reviewed: cards.filter((c) => c.reviews).length, reviews: cards.reduce((n, c) => n + c.reviews, 0), faces: [...faces.values()] };
  }

  /** Deletes leftover cards (every one, one type's, or one face's) with their review history. */
  deleteLeftoverCards(opts: { type?: string; face?: string } = {}): { cards: number; reviews: number } {
    const doomed = this.leftoverCards(opts);
    this.db.tx(() => {
      for (const c of doomed) this.db.run("DELETE FROM cards WHERE id = ?", c.cardId);
    });
    return { cards: doomed.length, reviews: doomed.reduce((n, c) => n + c.reviews, 0) };
  }

  private ensureCards(itemId: string, def: CardTypeDef, fields: Record<string, unknown>) {
    const ts = iso();
    for (const face of this.facesFor(def, fields)) this.db.run("INSERT OR IGNORE INTO cards (item_id, face, due) VALUES (?, ?, ?)", itemId, face, ts);
  }

  /** After a type change, moves cards on faces the new type lacks onto its unused faces, in order, so their history stays live. */
  private carryCards(itemId: string, faces: string[]) {
    const cards = this.db.all<{ id: number; face: string }>("SELECT id, face FROM cards WHERE item_id = ? ORDER BY id", itemId);
    const open = faces.filter((f) => !cards.some((c) => c.face === f));
    for (const c of cards) {
      if (!open.length) break;
      if (!faces.includes(c.face)) this.db.run("UPDATE cards SET face = ? WHERE id = ?", open.shift()!, c.id);
    }
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
    return { id: r.id, name: r.name, presetId: r.preset_id, config: parse(r.config, {}), description: r.description, instructions: r.instructions, archived: !!r.archived, position: r.position ?? null };
  }

  updateDeck(nameOrId: string | number, patch: Partial<Pick<Deck, "presetId" | "config" | "description" | "instructions" | "archived">> & { name?: string }) {
    const r = this.deckRow(nameOrId);
    if (patch.config) {
      const e = sched.validateConfig(patch.config);
      if (e.length) throw new EtudeError(e.join("; "));
      this.checkSchedulerRef(patch.config);
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

  /**
   * Moves a deck, with its subdecks, under `parent` ("" for the top level), keeping its own name,
   * and puts it at `index` among its new siblings (the end when left out). Refuses to merge: if
   * the new parent already has a deck of that name, rename one of them first.
   */
  moveDeck(name: string, parent: string, index?: number) {
    const src = this.deckRow(name).name;
    const p = normDeck(parent) ? this.deckRow(parent).name : "";
    if (p === src || p.startsWith(src + "::")) throw new EtudeError("can't move a deck inside itself");
    const leaf = deckParts(src).at(-1)!;
    const dst = p ? `${p}::${leaf}` : leaf;
    return this.db.tx(() => {
      if (dst.toLowerCase() !== src.toLowerCase()) {
        if (this.db.get("SELECT 1 FROM decks WHERE name = ? COLLATE NOCASE", dst)) throw new EtudeError(`${p ? `"${p}"` : "The top level"} already has a deck called "${leaf}"`, 409);
        this.renameDeck(src, dst);
      } else if (dst !== src) this.renameDeck(src, dst);
      const depth = deckParts(dst).length;
      const siblings = this.orderedDecks()
        .map((r) => r.name as string)
        .filter((n) => n !== dst && deckParts(n).length === depth && (!p || n.startsWith(p + "::")));
      const at = index === undefined || !Number.isFinite(index) ? siblings.length : Math.max(0, Math.min(siblings.length, Math.trunc(index)));
      siblings.splice(at, 0, dst);
      this.reorderDecks(p, siblings);
      return this.deck(dst);
    });
  }

  setDeckArchived(name: string, archived: boolean, opts: { subdecks?: boolean } = {}) {
    const src = this.deckRow(name).name;
    const names = this.db.all<{ name: string }>("SELECT name FROM decks WHERE name = ? OR (? AND name LIKE ? ESCAPE '\\') ORDER BY name", src, Number(!!opts.subdecks), src.replace(/[\\%_]/g, "\\$&") + "::%").map((r) => r.name);
    this.db.tx(() => {
      for (const n of names) this.db.run("UPDATE decks SET archived = ? WHERE name = ?", Number(archived), n);
    });
    return { decks: names, archived };
  }

  /** All content a deck deletion would remove, including archived items and subdecks. */
  deckUsage(name: string): { items: number; cards: number } {
    const src = this.deckRow(name).name;
    const like = src.replace(/[\\%_]/g, "\\$&") + "::%";
    const r = this.db.get<{ items: number; cards: number }>(
      "SELECT COUNT(DISTINCT i.id) AS items, COUNT(c.id) AS cards FROM items i JOIN decks d ON d.id = i.deck_id LEFT JOIN cards c ON c.item_id = i.id WHERE d.name = ? OR d.name LIKE ? ESCAPE '\\'", src, like,
    )!;
    return { items: r.items, cards: r.cards };
  }

  /** Deleting content requires an explicit opt-in; cards and history go with their items. */
  deleteDeck(name: string, opts: { items?: boolean } = {}) {
    const src = this.deckRow(name).name;
    const like = src.replace(/[\\%_]/g, "\\$&") + "::%";
    this.db.tx(() => {
      const n = this.deckUsage(src).items;
      if (n && !opts.items) throw new EtudeError(`deck "${src}" holds ${n} item(s); use --items to delete them too`);
      if (opts.items) this.db.run("DELETE FROM items WHERE deck_id IN (SELECT id FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\')", src, like);
      this.db.run("DELETE FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\'", src, like);
    });
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
    this.checkSchedulerRef(p.config);
    this.db.run(
      "INSERT INTO presets (id, name, config) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config",
      p.id,
      p.name || p.id,
      json(p.config ?? {}),
    );
    return this.preset(p.id);
  }

  /** Deletes a preset nobody uses. Decks (archived ones too) must be moved off it first. */
  deletePreset(id: string) {
    this.preset(id);
    const used = this.db.all("SELECT name FROM decks WHERE preset_id = ? ORDER BY name", id);
    if (used.length) throw new EtudeError(`preset "${id}" is used by ${used.length} deck(s): ${used.slice(0, 5).map((d) => d.name).join(", ")}${used.length > 5 ? ", …" : ""}`, 409);
    this.db.run("DELETE FROM presets WHERE id = ?", id);
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
      cards: cards.map((c) => ({ ...c, retrievability: this.scriptFor(cfg) ? null : sched.retrievability(c, t, cfg) })),
      reviews: this.db.all(
        "SELECT r.id, r.card_id, r.ts, r.rating, r.state, r.due_after, r.duration_ms, r.score, r.practice FROM reviews r JOIN cards c ON c.id = r.card_id WHERE c.item_id = ? ORDER BY r.ts DESC LIMIT 200",
        id,
      ),
      attempts: this.db
        .all("SELECT a.id, a.card_id, a.ts, a.answer, a.grade, a.practice FROM attempts a JOIN cards c ON c.id = a.card_id WHERE c.item_id = ? ORDER BY a.ts DESC LIMIT 50", id)
        .map((a) => ({ ...a, answer: parse(a.answer, null), grade: parse(a.grade, null) })),
    };
  }

  private checkItemFields(id: string, def: CardTypeDef, fields: Record<string, unknown>) {
    const errs = validateFields(def, fields);
    if (errs.length && typeof fields.generator !== "string") throw new EtudeError(`${id}: ${errs.join("; ")}`);
    if (typeof fields.generator === "string") {
      // A generated item must produce valid fields; try a few seeds now so mistakes surface at import.
      for (const seed of [1, 2, 3]) {
        const gen = this.generate(fields, seed, id);
        const e = validateFields(def, gen);
        if (e.length) throw new EtudeError(`${id}: generator output (seed ${seed}): ${e.join("; ")}`);
      }
    }
  }

  /** Returns a validated edit proposal without saving or changing scheduling. */
  async suggestItemEdit(id: string, instruction: string, opts: { fields?: Record<string, unknown> } = {}) {
    const item = this.item(id);
    if (typeof instruction !== "string" || !instruction.trim()) throw new EtudeError("describe how you want to change the card");
    const input = opts.fields === undefined ? item.fields : opts.fields;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new EtudeError("fields must be an object");
    const before = structuredClone(input);
    const def = this.type(item.type);
    try {
      const proposal = await aiEditFields(this.settings().ai, def, before, instruction.trim(), { home: this.home });
      const allowed = new Set([...def.fields.map((f) => f.name), ...Object.keys(before), "generator"]);
      let fields = { ...before };
      for (const [name, value] of Object.entries(proposal.changes)) {
        if (!allowed.has(name)) throw new AiError(`language model returned an unknown field "${name}"`);
        if (value === null) delete fields[name];
        else fields = { ...fields, [name]: value };
      }
      try {
        if (fields.generator !== undefined && typeof fields.generator !== "string") throw new EtudeError("generator should be code");
        this.checkItemFields(id, def, { ...fieldDefaults(def), ...fields });
      } catch (e) {
        throw new AiError(`proposed edit is invalid: ${(e as Error).message}`);
      }
      const changed = [...new Set([...Object.keys(before), ...Object.keys(fields)])].filter((name) => JSON.stringify(before[name]) !== JSON.stringify(fields[name]));
      return { itemId: id, fields, changed, model: proposal.model, ms: proposal.ms, ...(proposal.cost != null ? { cost: proposal.cost } : {}) };
    } catch (e) {
      if (e instanceof AiError) throw new EtudeError(`couldn't edit the card: ${e.message}`, 502);
      throw e;
    }
  }

  /** Creates or updates one item. Returns what happened. */
  upsertItem(input: Partial<Item> & { id: string; type: string; deck: string; fields: Record<string, unknown> }, opts: { ord?: number } = {}): "created" | "updated" | "unchanged" {
    if (!input.id || !ITEM_ID.test(input.id)) throw new EtudeError(`invalid item id "${input.id}"`);
    const def = this.type(input.type);
    const fields = { ...fieldDefaults(def), ...(input.fields ?? {}) };
    this.checkItemFields(input.id, def, fields);
    const deckId = this.ensureDeck(input.deck);
    const tags = [...new Set((input.tags ?? []).map(normTag).filter(Boolean))];
    const old = this.db.get("SELECT * FROM items WHERE id = ?", input.id);
    const ts = iso();
    const next = { type: input.type, deck_id: deckId, fields: json(fields), tags: json(tags), source: input.source ?? "", notes: input.notes ?? "", archived: Number(input.archived ?? false) };
    const title = itemTitle(def, fields, true);
    const search = itemSearchText(fields);
    let result: "created" | "updated" | "unchanged";
    this.db.tx(() => {
      if (!old) {
        const ord = opts.ord ?? (this.db.get("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM items")!.n as number);
        this.db.run(
          "INSERT INTO items (id, type, deck_id, fields, tags, source, notes, archived, created, updated, ord, title, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          input.id, next.type, next.deck_id, next.fields, next.tags, next.source, next.notes, next.archived, ts, ts, ord, title, search,
        );
        result = "created";
      } else {
        const same = old.type === next.type && old.deck_id === next.deck_id && old.fields === next.fields && old.tags === next.tags && old.source === next.source && old.notes === next.notes && old.archived === next.archived;
        if (same) {
          result = "unchanged";
          return;
        }
        this.db.run(
          "UPDATE items SET type = ?, deck_id = ?, fields = ?, tags = ?, source = ?, notes = ?, archived = ?, updated = ?, title = ?, search = ? WHERE id = ?",
          next.type, next.deck_id, next.fields, next.tags, next.source, next.notes, next.archived, ts, title, search, input.id,
        );
        result = "updated";
      }
      this.db.run("DELETE FROM item_tags WHERE item_id = ?", input.id);
      for (const t of tags) this.db.run("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)", input.id, t);
      if (old && old.type !== next.type) this.carryCards(input.id, this.facesFor(def, fields));
      this.ensureCards(input.id, def, fields);
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

  /** Suspends or unsuspends cards. Returns the ids that changed, so an undo leaves the others as they were. */
  setSuspended(cardIds: number[], suspended: boolean): number[] {
    const changed: number[] = [];
    this.db.tx(() => {
      for (const id of new Set(cardIds)) if (this.db.run("UPDATE cards SET suspended = ? WHERE id = ? AND suspended != ?", Number(suspended), id, Number(suspended)).changes) changed.push(id);
    });
    return changed;
  }

  /** Forgets scheduling for cards (they become new again). History stays. */
  resetCards(cardIds: number[]) {
    const ts = iso();
    this.db.tx(() => {
      for (const id of cardIds)
        this.db.run(
          "UPDATE cards SET state = 0, due = ?, stability = 0, difficulty = 0, elapsed_days = 0, scheduled_days = 0, reps = 0, lapses = 0, learning_steps = 0, last_review = NULL, buried_until = NULL, sched_state = NULL WHERE id = ?",
          ts,
          id,
        );
      if (this.db.get("SELECT 1 FROM sqlite_master WHERE name='sync_control'")) for (const id of cardIds) this.db.run("UPDATE cards SET sync_reset=?,sync_due=NULL,sync_due_at=NULL WHERE id=?",ts,id);
    });
  }

  /** Moves cards' due date without recording a review. New cards stay new and wait until then. */
  setDue(cardIds: number[], due: Date) {
    if (Number.isNaN(due.getTime())) throw new EtudeError("invalid due date");
    const ts = iso(due);
    this.db.tx(() => {
      for (const id of cardIds) {
        const c = this.db.get<CardRow>("SELECT * FROM cards WHERE id = ?", id);
        if (!c) throw new EtudeError(`unknown card ${id}`, 404);
        // Keep stability and difficulty; only the planned interval changes.
        const scheduled = c.last_review ? Math.max(0, Math.round((due.getTime() - new Date(c.last_review).getTime()) / 86400_000)) : c.scheduled_days;
        this.db.run("UPDATE cards SET due = ?, scheduled_days = ?, buried_until = NULL WHERE id = ?", ts, scheduled, id);
        if (this.db.get("SELECT 1 FROM sqlite_master WHERE name='sync_control'")) this.db.run("UPDATE cards SET sync_due=?,sync_due_at=? WHERE id=?",ts,iso(),id);
      }
    });
  }

  /** Hides cards until the next study day, or `until`; `null` unburies. Returns changed ids. */
  setBuried(cardIds: number[], until: Date | null = new Date(this.dayStart().getTime() + 86400_000), opts: { preserveExisting?: boolean } = {}) {
    const changed: number[] = [];
    const ts = iso();
    this.db.tx(() => {
      for (const id of new Set(cardIds)) {
        const r = this.db.run("UPDATE cards SET buried_until = ? WHERE id = ? AND (? = 0 OR buried_until IS NULL OR buried_until <= ?)", until ? iso(until) : null, id, Number(!!opts.preserveExisting), ts);
        if (r.changes) changed.push(id);
      }
    });
    return changed;
  }

  /** All cards belonging to the same items as the selected cards. */
  noteCards(cardIds: number[]): number[] {
    if (!cardIds.length) return [];
    return this.db.all<{ id: number }>(`SELECT id FROM cards WHERE item_id IN (SELECT item_id FROM cards WHERE id IN (${cardIds.map(() => "?").join(", ")})) ORDER BY id`, ...cardIds).map((r) => r.id);
  }

  /** A card's scheduling right now, with what each rating would do. */
  cardSchedule(cardId: number) {
    const c = this.cardWithDeck(cardId);
    const cfg = this.configFor(c.deck);
    const t = now();
    const row: CardRow = { ...c };
    return {
      cardId: c.id,
      itemId: c.item_id,
      face: c.face,
      deck: c.deck,
      state: c.state,
      due: c.due,
      stability: c.stability,
      difficulty: c.difficulty,
      reps: c.reps,
      lapses: c.lapses,
      lastReview: c.last_review,
      suspended: !!c.suspended,
      buriedUntil: c.buried_until && c.buried_until > iso(t) ? c.buried_until : null,
      ...(() => {
        const p = this.previewFor({ ...row, deck: c.deck }, cfg, t);
        return { scheduler: p.scheduler, retrievability: p.scheduler.id === FSRS ? sched.retrievability(row, t, cfg) : null, intervals: p.intervals, schedulerState: parse(c.sched_state ?? null, null) };
      })(),
      deadline: this.scriptFor(cfg) ? null : (cfg.deadline ?? null),
    };
  }

  /**
   * Compiles a search for SQL over `cards c JOIN items i JOIN decks d`. `key:` terms can name any
   * type's field, matched without case.
   */
  compileSearch(query: string): Compiled {
    const fieldNames = (key: string) => {
      const names = new Set<string>();
      for (const r of this.db.all("SELECT def FROM types")) for (const f of parse<CardTypeDef>(r.def, {} as CardTypeDef).fields ?? []) if (f.name.toLowerCase() === key.toLowerCase()) names.add(f.name);
      return [...names];
    };
    try {
      return compile(query, new Date(), { fieldNames, leftoverCards: () => this.leftoverCards().map((c) => c.cardId) });
    } catch (e) {
      if (e instanceof QueryError) throw new EtudeError(`search: ${e.message}`);
      throw e;
    }
  }

  /** Items (not cards) matching a search. "relevance" (the default) is collection order unless there's free text. */
  searchItems(query: string, opts: { limit?: number; offset?: number; order?: string } = {}) {
    const c = this.compileSearch(query);
    const orders: Record<string, string> = { deck: "d.name, i.ord", updated: "i.updated DESC", created: "i.created DESC", due: "MIN(CASE WHEN c.state = 0 THEN '9999' ELSE c.due END), i.ord", lapses: "MAX(c.lapses) DESC, i.ord", id: "i.id" };
    const ranked = (opts.order ?? "relevance") === "relevance" && c.rank;
    const order = ranked ? `${c.rank!.sql}, i.ord` : (orders[opts.order ?? ""] ?? "i.ord");
    const from = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const total = this.db.get(`SELECT COUNT(DISTINCT i.id) AS n ${from} WHERE ${c.where}`, ...c.params)!.n;
    const rows = this.db.all(
      `SELECT i.id, i.type, i.fields, i.tags, i.source, i.archived, i.updated, i.title, d.name AS deck, COUNT(c.id) AS cards, SUM(c.suspended) AS suspended ${from} WHERE ${c.where} GROUP BY i.id ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...c.params,
      ...(ranked ? c.rank!.params : []),
      opts.limit ?? 100,
      opts.offset ?? 0,
    );
    return {
      total,
      rows: rows.map((r) => {
        const fields = parse<Record<string, unknown>>(r.fields, {});
        return {
          id: r.id,
          type: r.type,
          deck: r.deck,
          tags: parse<string[]>(r.tags, []),
          title: r.title,
          source: r.source,
          cards: r.cards,
          suspended: Number(r.suspended ?? 0),
          archived: !!r.archived,
          generated: typeof fields.generator === "string",
          updated: r.updated,
        };
      }),
    };
  }

  /** Copies an item's content (not its scheduling) under a new id. */
  duplicateItem(id: string, newId?: string): string {
    const it = this.item(id);
    let target = newId;
    if (!target) {
      let n = 2;
      while (this.db.get("SELECT 1 FROM items WHERE id = ?", `${id}-${n}`)) n++;
      target = `${id}-${n}`;
    } else if (this.db.get("SELECT 1 FROM items WHERE id = ?", target)) throw new EtudeError(`item "${target}" already exists`, 409);
    this.upsertItem({ id: target, type: it.type, deck: it.deck, fields: it.fields, tags: it.tags, source: it.source, notes: it.notes });
    return target;
  }

  /** Browse: cards matching a search, with their item. "relevance" (the default) is the order added unless there's free text. */
  search(query: string, opts: { limit?: number; offset?: number; order?: string } = {}) {
    const c = this.compileSearch(query);
    const orders: Record<string, string> = {
      added: "i.ord, c.id",
      due: "CASE WHEN c.state = 0 THEN 1 ELSE 0 END, c.due",
      deck: "d.name, i.ord",
      lapses: "c.lapses DESC, i.ord",
      difficulty: "c.difficulty DESC, i.ord",
      updated: "i.updated DESC",
    };
    const ranked = (opts.order ?? "relevance") === "relevance" && c.rank;
    const order = ranked ? `${c.rank!.sql}, ${orders.added}` : (orders[opts.order ?? ""] ?? orders.added);
    const from = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const total = this.db.get(`SELECT COUNT(*) AS n ${from} WHERE ${c.where}`, ...c.params)!.n;
    const rows = this.db.all(
      `SELECT c.*, i.type, i.fields, i.tags, i.source, i.archived, i.title, d.name AS deck ${from} WHERE ${c.where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...c.params,
      ...(ranked ? c.rank!.params : []),
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
          title: r.title,
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

  /** A one-line label for an item (see `itemTitle`). Public fields only unless `private` is set. */
  titleOf(typeId: string, fields: Record<string, unknown>, opts: { private?: boolean } = {}): string {
    let def: CardTypeDef | null = null;
    try {
      def = this.type(typeId);
    } catch {}
    return itemTitle(def, fields, !!opts.private);
  }

  // ------------------------------------------------------------ preparation

  private generate(fields: Record<string, unknown>, seed: number, where: string): Record<string, unknown> {
    // An item's example answer for watch mode (`demo`, `demoGrade`) never reaches the card.
    if ("demo" in fields || "demoGrade" in fields) {
      fields = { ...fields };
      delete fields.demo;
      delete fields.demoGrade;
    }
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
      const out = runScript<{ view?: Record<string, unknown>; key?: Record<string, unknown>; grader?: string }>(def.prepare, {
        params: ["fields", "face", "rng"],
        args: { fields, face },
        seed: hashString(`${seed}:${itemId}:${face}`),
        where: `${def.id}/prepare`,
      });
      return { view: out?.view ?? {}, key: out?.key ?? {}, seed, fields, ...(out?.grader === "self" ? { selfGraded: true } : {}) };
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
    let selfGraded = false;
    try {
      merged = this.generate({ ...fieldDefaults(def), ...fields }, seed, "preview");
      if (def.prepare) {
        const out = runScript<any>(def.prepare, { params: ["fields", "face", "rng"], args: { fields: merged, face }, seed: hashString(`${seed}:preview:${face}`), where: `${def.id}/prepare` });
        view = out?.view ?? {};
        key = out?.key ?? {};
        if (out?.grader === "self") selfGraded = true;
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
      if ((g.kind === "script" || g.kind === "hybrid") && !selfGraded) {
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
    const parts: string[] = ["i.archived = 0", "d.archived = 0", "c.suspended = 0"];
    const params: any[] = [];
    let cfg: PresetConfig;
    if (scope.deck) {
      const d = this.deckRow(scope.deck);
      parts.push("(d.name = ? OR d.name LIKE ? ESCAPE '\\')");
      params.push(d.name, d.name.replace(/[\\%_]/g, "\\$&") + "::%");
      cfg = this.configFor(d.name);
    } else cfg = sched.resolveConfig({ newPerDay: 1e9, reviewsPerDay: 1e9 });
    if (scope.query?.trim()) {
      const c = this.compileSearch(scope.query);
      parts.push(`(${c.where})`);
      params.push(...c.params);
    }
    return { where: parts.join(" AND "), params, cfg };
  }

  /**
   * The faces of the cards in a deck and its subdecks, with the types that make each and how many of
   * its cards are new and not suspended: what `newPerFace` can limit.
   */
  deckFaces(name: string): { face: string; types: { id: string; name: string }[]; cards: number; new: number }[] {
    const d = this.deckRow(name);
    const rows = this.db.all<{ face: string; type: string; cards: number; new: number }>(
      `SELECT c.face, i.type, COUNT(*) AS cards, SUM(c.state = 0 AND c.suspended = 0) AS new FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id
       WHERE i.archived = 0 AND (d.name = ? OR d.name LIKE ? ESCAPE '\\') GROUP BY c.face, i.type ORDER BY c.face, i.type`,
      d.name,
      d.name.replace(/[\\%_]/g, "\\$&") + "::%",
    );
    const out = new Map<string, { face: string; types: { id: string; name: string }[]; cards: number; new: number }>();
    for (const r of rows) {
      const f = out.get(r.face) ?? { face: r.face, types: [], cards: 0, new: 0 };
      let typeName = r.type;
      try {
        typeName = this.type(r.type).name;
      } catch {}
      f.types.push({ id: r.type, name: typeName });
      f.cards += r.cards;
      f.new += r.new;
      out.set(r.face, f);
    }
    return [...out.values()];
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
    // Watch decks are tours, not study: their cards never enter the queue.
    const watching = new Map<string, boolean>();
    const watch = (deck: string) => {
      if (!watching.has(deck)) watching.set(deck, this.configFor(deck).mode === "watch");
      return watching.get(deck)!;
    };
    for (let i = rows.length - 1; i >= 0; i--) if (watch(rows[i].deck)) rows.splice(i, 1);
    const dayStart = iso(this.dayStart(t));
    const done = this.db.get(
      `SELECT SUM(r.state = 0) AS new, SUM(r.state = 2) AS rev FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE r.practice = 0 AND r.ts >= ? AND ${where}`,
      dayStart,
      ...params,
    )!;
    const doneNew = Number(done.new ?? 0), doneRev = Number(done.rev ?? 0);
    const nowIso = iso(t);
    const aheadIso = iso(new Date(t.getTime() + this.settings().learnAheadMinutes * 60_000));

    if (scope.ahead) {
      // Study ahead: everything in scope, soonest due first, no daily limits. FSRS scales the gain for an early review.
      const byDue = (a: CardRow, b: CardRow) => a.due.localeCompare(b.due);
      const learning = rows.filter((c) => c.state === 1 || c.state === 3).sort(byDue);
      const reviews = rows.filter((c) => c.state === 2).sort(byDue);
      const news = rows.filter((c) => c.state === 0).sort((a, b) => a.ord - b.ord || a.id - b.id);
      return { learning, reviews, news, doneNew, doneRev, cfg, nowIso, nextLater: null as string | null, ahead: true };
    }
    const learning = rows.filter((c) => (c.state === 1 || c.state === 3) && c.due <= aheadIso).sort((a, b) => a.due.localeCompare(b.due));
    let reviews = rows.filter((c) => c.state === 2 && c.due <= nowIso);
    if (cfg.reviewOrder === "retrievability") {
      // Cards on a script scheduler have no predicted recall; they sort after the weakest FSRS cards, by due.
      const R = new Map(reviews.map((c) => [c.id, this.scriptFor(this.configFor(c.deck)) ? 2 : (sched.retrievability(c, t, this.configFor(c.deck)) ?? 1)]));
      reviews.sort((a, b) => R.get(a.id)! - R.get(b.id)!);
    } else if (cfg.reviewOrder === "random") {
      const day = dayStart.slice(0, 10);
      reviews.sort((a, b) => hashString(day + a.id) - hashString(day + b.id));
    } else reviews.sort((a, b) => a.due.localeCompare(b.due));
    reviews = reviews.slice(0, Math.max(0, cfg.reviewsPerDay - doneRev));

    // A new card given a later due date (setDue) waits until then.
    let news = rows.filter((c) => c.state === 0 && c.due <= nowIso);
    if (cfg.newOrder === "random") {
      const day = dayStart.slice(0, 10);
      news.sort((a, b) => hashString(day + a.id) - hashString(day + b.id));
    } else if (cfg.newOrder === "deck") news.sort((a, b) => a.deck.localeCompare(b.deck) || a.ord - b.ord || a.id - b.id);
    else news.sort((a, b) => a.ord - b.ord || a.id - b.id);
    let room = Math.max(0, cfg.newPerDay - doneNew);
    if (Object.keys(cfg.newPerFace).length) {
      // Faces with their own limit take what's left of it today, in the same order; the rest share newPerDay.
      const left = new Map(Object.entries(cfg.newPerFace).map(([face, n]) => [face, n ?? Infinity]));
      for (const r of this.db.all<{ face: string; n: number }>(
        `SELECT c.face, COUNT(*) AS n FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE r.practice = 0 AND r.state = 0 AND r.ts >= ? AND ${where} GROUP BY c.face`,
        dayStart,
        ...params,
      ))
        if (left.has(r.face)) left.set(r.face, left.get(r.face)! - r.n);
      news = news.filter((c) => {
        if (room <= 0) return false;
        const n = left.get(c.face);
        if (n !== undefined) {
          if (n <= 0) return false;
          left.set(c.face, n - 1);
        }
        room--;
        return true;
      });
    } else news = news.slice(0, room);

    const nextLater = rows
      .filter((c) => (c.state !== 0 && c.due > aheadIso) || (c.state === 0 && c.due > nowIso))
      .reduce<string | null>((m, c) => (!m || c.due < m ? c.due : m), null);
    return { learning, reviews, news, doneNew, doneRev, cfg, nowIso, nextLater, ahead: false };
  }

  counts(scope: StudyScope) {
    const q = this.queue(scope);
    return {
      new: q.news.length,
      learning: q.ahead ? q.learning.length : q.learning.filter((c) => c.due <= q.nowIso).length,
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
      learning: q.ahead ? q.learning.length : q.learning.filter((c) => c.due <= q.nowIso).length,
      learningSoon: q.learning.length,
      review: q.reviews.length,
      doneToday: q.doneNew + q.doneRev,
      nextDue: q.nextLater,
    };
    const not = (list: CardRow[]) => list.filter((c) => c.id !== opts.exclude);
    const learningNow = not(q.ahead ? q.learning : q.learning.filter((c) => c.due <= q.nowIso));
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
      ...this.previewFor(c, this.configFor(c.deck), now()),
      grader: p.selfGraded ? "self" : def.grader.kind,
      showVerdict: def.showVerdict !== false,
      generated: typeof p.fields.generator === "string" || typeof parse<Record<string, unknown>>(this.db.get("SELECT fields FROM items WHERE id = ?", c.item_id)!.fields, {}).generator === "string",
      title: this.titleOf(c.type, p.fields),
    };
  }

  // ----------------------------------------------------------------- watch

  /**
   * The cards a watch session shows, in deck order: one per item (its first face), skipping
   * suspended and archived ones. Watching records nothing.
   */
  watchList(scope: StudyScope): { cardId: number; itemId: string; type: string; deck: string; title: string }[] {
    const { where, params } = this.scopeWhere(scope);
    const rows = this.db.all(
      `SELECT c.id, c.item_id, c.face, i.type, i.fields, d.name AS deck FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${where} ORDER BY d.name, i.ord, c.id`,
      ...params,
    );
    const seen = new Set<string>();
    const out: { cardId: number; itemId: string; type: string; deck: string; title: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.item_id)) continue;
      seen.add(r.item_id);
      out.push({ cardId: r.id, itemId: r.item_id, type: r.type, deck: r.deck, title: this.titleOf(r.type, parse(r.fields, {})) });
    }
    return out;
  }

  /**
   * A card for watch mode: what it shows plus an example answer. The answer is the item's own
   * `fields.demo` when it has one, otherwise what the type's `demo` script makes from the key.
   * `demoGrade` is a recorded grade an AI-graded item can show instead of calling a model.
   */
  watchCard(cardId: number, seed?: number): { card: StudyCard; demo: { answer: unknown; grade: Grade | null } } {
    const card = this.present(cardId, seed);
    const c = this.cardWithDeck(cardId);
    const raw = parse<Record<string, unknown>>(c.item_fields, {});
    const def = this.type(c.type);
    let answer: unknown = null;
    if (raw.demo !== undefined) answer = raw.demo;
    else if (def.demo) {
      const prep = this.prepare(c.item_id, c.face, card.seed);
      answer = runScript(def.demo, {
        params: ["view", "key", "fields", "rng"],
        args: { view: prep.view, key: prep.key, fields: prep.fields },
        seed: hashString(`${card.seed}:${c.item_id}:demo`),
        where: `${def.id}/demo`,
      }) ?? null;
    }
    const g = raw.demoGrade as Partial<Grade> | undefined;
    const grade: Grade | null = g && typeof g === "object"
      ? { score: g.score ?? null, verdict: g.verdict ?? this.verdictOf(g.score ?? null), feedback: g.feedback, suggested: null, grader: { kind: def.grader.kind, model: g.grader?.model, example: true } as Grade["grader"] }
      : null;
    return { card, demo: { answer, grade } };
  }

  /** Grades an answer in watch mode: nothing is stored, and AI is called only when `ai` is set. */
  async watchGrade(cardId: number, seed: number, answer: unknown, opts: { ai?: boolean } = {}) {
    const { grade, prep } = await this.grade(cardId, seed, answer, { noAi: !opts.ai });
    return { grade, key: prep.key };
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
    const { grade, prep } = await this.grade(cardId, seed, answer);
    const stored = this.storeAnswer(answer, cardId);
    const id = Number(
      this.db.run("INSERT INTO attempts (card_id, ts, seed, view, answer, grade, practice) VALUES (?, ?, ?, ?, ?, ?, ?)", cardId, iso(), seed, json(prep.view), json(stored), json(grade), Number(!!opts.practice))
        .lastInsertRowid,
    );
    const quiet = this.type(this.cardWithDeck(cardId).type).showVerdict === false;
    const wantsFeedback = !quiet && !grade.feedback && grade.grader.kind === "ai" && !grade.grader.error && this.settings().ai.autoFeedback !== "never";
    return { attemptId: id, grade, key: prep.key, wantsFeedback: wantsFeedback || (!quiet && this.settings().ai.autoFeedback === "always" && !grade.feedback) };
  }

  /** Grades an answer against a card variant without storing anything. */
  async grade(cardId: number, seed: number, answer: unknown, opts: { noAi?: boolean } = {}): Promise<{ grade: Grade; prep: Prepared & { fields: Record<string, unknown> } }> {
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
      if (g.kind === "self" || prep.selfGraded) grade = { score: null, verdict: "ungraded", suggested: null, grader: { kind: "self" } };
      else if (g.kind === "script" || (g.kind === "hybrid" && !scriptedDeferred())) {
        const out = scripted();
        const score = out.score == null ? null : Math.max(0, Math.min(1, Number(out.score)));
        grade = { score, verdict: this.verdictOf(score), feedback: out.feedback, details: out.details, suggested: sched.suggestRating(score, cfg), grader: { kind: "script", ms: Date.now() - t0 } };
      } else if (opts.noAi) {
        grade = { score: null, verdict: "ungraded", suggested: null, grader: { kind: "ai" } };
      } else {
        const ctx = this.gradingContext(c, prep, answer);
        const v = await aiVerdict(this.settings().ai, ctx, { vision: !!(g as { vision?: boolean }).vision, home: this.home });
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
    return { grade, prep };
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
      out = await aiFeedback(this.settings().ai, ctx, { home: this.home });
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
      const v = await aiVerdict(ai, ctx, { home: this.home });
      out.verdict = v;
      ctx.verdict = v.verdict;
      ctx.score = v.score;
    } catch (e) {
      out.verdictError = (e as Error).message;
    }
    try {
      out.feedback = await aiFeedback(ai, ctx, { home: this.home });
    } catch (e) {
      out.feedbackError = (e as Error).message;
    }
    return out;
  }

  // ------------------------------------------------------- ChatGPT plan

  /** Where ChatGPT-plan sign-in stands for this install. */
  chatgptStatus(): ChatGptStatus {
    return chatGptStatus(this.home);
  }

  /** Starts the sign-in loopback listener. The browser must be on this machine. */
  chatgptLogin(opts: Omit<ChatGptLoginOptions, "home"> = {}) {
    return beginChatGptLogin({ home: this.home, ...opts });
  }

  chatgptLogout(endpoints: Partial<ChatGptEndpoints> = {}): Promise<ChatGptLogoutResult> {
    return chatGptLogout(this.home, endpoints);
  }

  chatgptModels(endpoints: Partial<ChatGptEndpoints> = {}): Promise<ChatGptModel[]> {
    return listChatGptModels(this.home, endpoints);
  }

  /** Adopts a credential file from another machine, with a host id for this one. */
  chatgptImport(file: string) {
    return importChatGptCredentials(this.home, file);
  }

  /** The stored registration, for reauthorization hints (no network). */
  chatgptCredentials() {
    return readChatGptCredentials(this.home);
  }

  /** Records a rating and reschedules the card. Practice ratings are logged but don't move the schedule. */
  /**
   * Records a rating and reschedules the card. Practice ratings are logged but don't move the schedule.
   * A scheduler without ratings (a drill) takes `0`: the graded result is what's recorded.
   */
  rate(cardId: number, rating: Rating | 0, opts: { attemptId?: number; durationMs?: number; practice?: boolean; at?: Date } = {}) {
    const c = this.cardWithDeck(cardId);
    const t = opts.at ?? now();
    const cfg = this.configFor(c.deck);
    const script = this.scriptFor(cfg);
    const rated = !script || script.ratings !== false;
    if (rated && ![1, 2, 3, 4].includes(rating)) throw new EtudeError("rating must be 1 (again), 2 (hard), 3 (good) or 4 (easy)");
    if (!rated) rating = 0;
    const before: CardRow = { ...c };
    for (const k of ["deck", "type", "tags", "item_fields"]) delete (before as any)[k];
    let grade: Grade | null = null;
    if (opts.attemptId) {
      const a = this.db.get("SELECT grade, card_id, review_id FROM attempts WHERE id = ?", opts.attemptId);
      if (!a || a.card_id !== cardId) throw new EtudeError("attempt does not belong to this card");
      if (a.review_id) throw new EtudeError("this attempt was already rated", 409);
      grade = parse<Grade>(a.grade, {} as Grade);
    }
    const score = grade?.score ?? null;
    return this.db.tx(() => {
      let dueAfter = c.due;
      if (!opts.practice && script) {
        const created = this.db.get("SELECT created FROM items WHERE id = ?", c.item_id)?.created;
        const out = this.runScheduler(script, cfg, { ...c, created }, { rating: rating || null, score, verdict: grade?.verdict ?? null, details: grade?.details ?? null, ms: opts.durationMs ?? null, at: iso(t) }, t);
        dueAfter = out.due;
        const days = (a: string | null, b: string) => (a ? Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 86400_000) : 0);
        this.db.run(
          "UPDATE cards SET state = 2, due = ?, elapsed_days = ?, scheduled_days = ?, reps = reps + 1, lapses = lapses + ?, last_review = ?, sched_state = ? WHERE id = ?",
          out.due, days(c.last_review, iso(t)), days(iso(t), out.due), rating === 1 ? 1 : 0, iso(t), json(out.state), cardId,
        );
      } else if (!opts.practice) {
        const { next } = sched.schedule(c, rating as Rating, t, cfg);
        dueAfter = next.due;
        this.db.run(
          "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ?, sched_state = NULL WHERE id = ?",
          next.state, next.due, next.stability, next.difficulty, next.elapsed_days, next.scheduled_days, next.reps, next.lapses, next.learning_steps, next.last_review, cardId,
        );
      }
      if (!opts.practice) {
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
          "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ?, sched_state = ? WHERE id = ?",
          b.state, b.due, b.stability, b.difficulty, b.elapsed_days, b.scheduled_days, b.reps, b.lapses, b.learning_steps, b.last_review, b.sched_state ?? null, r.card_id,
        );
        const item = this.db.get("SELECT item_id FROM cards WHERE id = ?", r.card_id)!.item_id;
        this.db.run("UPDATE cards SET buried_until = NULL WHERE item_id = ? AND id != ?", item, r.card_id);
      }
      this.db.run("UPDATE attempts SET review_id = NULL WHERE review_id = ?", r.id);
      this.db.run("DELETE FROM reviews WHERE id = ?", r.id);
      return { cardId: r.card_id, itemId: this.db.get("SELECT item_id FROM cards WHERE id = ?", r.card_id)!.item_id };
    });
  }

  /** Canonical sync replay uses UTC study days, a stable review tie-break and no FSRS fuzz. */
  replaySyncedCards() {
    for (const c of this.db.all("SELECT c.*,i.created,d.name AS deck FROM cards c JOIN items i ON i.id=c.item_id JOIN decks d ON d.id=i.deck_id")) {
      const cfg = { ...this.configFor(c.deck), enableFuzz: false };
      const script = this.scriptFor(cfg);
      let row: any = { ...c, ...sched.emptyCard(new Date(c.sync_reset ?? c.created)), sched_state: null };
      const history: { at: string; rating: number | null; score: number | null }[] = [];
      const reviews = this.db.all("SELECT r.*,a.grade FROM reviews r LEFT JOIN attempts a ON a.id=r.attempt_id WHERE r.card_id=? ORDER BY r.ts,r.sync_id",c.id);
      for (const r of reviews) {
        const before = json(row);
        if (!r.practice && (!c.sync_reset || r.ts > c.sync_reset)) {
          if (script) {
            const g = parse<Grade | null>(r.grade,null);
            const start = new Date(r.ts);
            start.setUTCHours(this.settings().dayStartHour,0,0,0);
            if (start > new Date(r.ts)) start.setUTCDate(start.getUTCDate()-1);
            const day = Array.from({length:DAY_HORIZON+1},(_,i) => new Date(start.getTime()+i*86400_000).toISOString());
            const past = history.slice(-50);
            const out = runSchedule(script,{state:parse(row.sched_state,null),reps:row.reps,due:row.due,lastReview:row.last_review,created:c.created},{rating:script.ratings === false ? null : r.rating || null,score:r.score,verdict:g?.verdict ?? null,details:g?.details ?? null,ms:r.duration_ms,at:r.ts},resolveOptions(script,cfg.schedulerOptions),{now:r.ts,day,doneToday:past.filter(h=>h.at>=day[0]).length,history:past});
            row = {...row,state:2,due:out.due,reps:row.reps+1,lapses:row.lapses+(r.rating===1?1:0),last_review:r.ts,sched_state:json(out.state)};
          } else row = {...row,...sched.schedule(row,r.rating || sched.suggestRating(r.score,cfg) || 3,new Date(r.ts),cfg).next};
          history.push({at:r.ts,rating:r.rating || null,score:r.score});
        }
        this.db.run("UPDATE reviews SET state=?,card_before=?,due_after=? WHERE id=?",JSON.parse(before).state,before,row.due,r.id);
      }
      if (c.sync_due && (!row.last_review || c.sync_due_at >= row.last_review)) { row.due=c.sync_due;row.scheduled_days=row.last_review?Math.max(0,Math.round((Date.parse(c.sync_due)-Date.parse(row.last_review))/86400_000)):0; }
      this.db.run("UPDATE cards SET state=?,due=?,stability=?,difficulty=?,elapsed_days=?,scheduled_days=?,reps=?,lapses=?,learning_steps=?,last_review=?,sched_state=? WHERE id=?",row.state,row.due,row.stability,row.difficulty,row.elapsed_days,row.scheduled_days,row.reps,row.lapses,row.learning_steps,row.last_review,row.sched_state,c.id);
    }
  }

  /** Recomputes cards from their review history with the current settings, e.g. after changing retention. */
  reschedule(scope: StudyScope = {}) {
    const { where, params } = this.scopeWhere({ ...scope });
    return this.replayCards(this.db.all(`SELECT c.id, c.item_id, d.name AS deck, i.created FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE ${where.replace("c.suspended = 0", "1")}`, ...params));
  }

  private replayCards(cards: Row[]) {
    let n = 0;
    this.db.tx(() => {
      for (const c of cards) {
        const reviews = this.db.all<{ ts: string; rating: number; score: number | null; duration_ms: number | null; grade: string | null }>(
          "SELECT r.ts, r.rating, r.score, r.duration_ms, a.grade FROM reviews r LEFT JOIN attempts a ON a.id = r.attempt_id WHERE r.card_id = ? AND r.practice = 0 ORDER BY r.ts",
          c.id,
        );
        if (!reviews.length) continue;
        const cfg = this.configFor(c.deck);
        const script = this.scriptFor(cfg);
        if (script) {
          // Same script, same history: run it again answer by answer.
          let row: CardRow = { ...(sched.emptyCard(new Date(c.created)) as any), id: c.id, item_id: c.item_id, face: "", suspended: 0, buried_until: null, sched_state: null };
          // runScheduler reads earlier results from the table, so each step looks just before its own review.
          for (const r of reviews) {
            const g = parse<Grade | null>(r.grade, null);
            const at = new Date(r.ts);
            const out = this.runScheduler(script, cfg, { ...row, created: c.created }, { rating: script.ratings === false ? null : r.rating || null, score: r.score, verdict: g?.verdict ?? null, details: g?.details ?? null, ms: r.duration_ms, at: r.ts }, new Date(at.getTime() - 1));
            row = { ...row, state: 2, due: out.due, reps: row.reps + 1, lapses: row.lapses + (r.rating === 1 ? 1 : 0), last_review: r.ts, sched_state: json(out.state) };
          }
          this.db.run(
            "UPDATE cards SET state = 2, due = ?, stability = 0, difficulty = 0, elapsed_days = 0, scheduled_days = 0, reps = ?, lapses = ?, learning_steps = 0, last_review = ?, sched_state = ? WHERE id = ?",
            row.due, row.reps, row.lapses, row.last_review, row.sched_state ?? null, c.id,
          );
        } else {
          // A drill's unrated answers count as the rating their score suggests.
          const rated = reviews.map((r) => ({ ts: r.ts, rating: r.rating >= 1 ? r.rating : (sched.suggestRating(r.score, cfg) ?? 3) }));
          const s = sched.replay(rated, new Date(c.created), cfg);
          this.db.run(
            "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ?, sched_state = NULL WHERE id = ?",
            s.state, s.due, s.stability, s.difficulty, s.elapsed_days, s.scheduled_days, s.reps, s.lapses, s.learning_steps, s.last_review, c.id,
          );
        }
        n++;
      }
    });
    return { rescheduled: n };
  }

  /**
   * Where a deck's FSRS weights come from: the last preset or deck, root first, that sets them.
   * When none does, the deck shares the weights of its nearest preset (the defaults until that preset gets some).
   */
  weightsSource(deckName: string): WeightsSource {
    const parts = deckParts(deckName);
    let source: WeightsSource | null = null;
    let nearest: string | null = null;
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("::");
      const r = this.db.get("SELECT preset_id, config FROM decks WHERE name = ?", name);
      if (!r) continue;
      if (r.preset_id) {
        nearest = r.preset_id;
        const p = this.db.get("SELECT config FROM presets WHERE id = ?", r.preset_id);
        if (parse<Partial<PresetConfig>>(p?.config, {}).weights !== undefined) source = { kind: "preset", id: r.preset_id };
      }
      if (parse<Partial<PresetConfig>>(r.config, {}).weights !== undefined) source = { kind: "deck", name };
    }
    return source ?? (nearest ? { kind: "preset", id: nearest } : { kind: "defaults" });
  }

  /**
   * Fits FSRS weights to the review history of every deck that shares the target's weights, like Anki's
   * Optimize. `apply` saves them where they come from (the preset, or the deck that overrides them), and
   * only when they fit the history better than the current ones.
   */
  async optimizeWeights(target: { preset: string } | { deck: string }, opts: { apply?: boolean; reschedule?: boolean } = {}) {
    let source: WeightsSource;
    if ("preset" in target) {
      this.preset(target.preset);
      source = { kind: "preset", id: target.preset };
    } else source = this.weightsSource(this.deck(target.deck).name);
    if (source.kind === "defaults") throw new EtudeError("this deck uses no preset and no weights of its own: attach a preset first (etude deck preset)");
    const key = JSON.stringify(source);
    const decks = this.db
      .all<{ id: number; name: string }>("SELECT id, name FROM decks ORDER BY name")
      .filter((d) => JSON.stringify(this.weightsSource(d.name)) === key && !this.scriptFor(this.configFor(d.name)));
    if (!decks.length) throw new EtudeError(`no FSRS deck takes its weights from ${source.kind === "preset" ? `preset "${source.id}"` : `deck "${source.name}"`}`);
    const ids = decks.map((d) => d.id);
    const marks = ids.map(() => "?").join(", ");
    const reviews = this.db
      .all<{ card_id: number; ts: string; rating: number; state: number; duration_ms: number | null }>(
        `SELECT r.card_id, r.ts, r.rating, r.state, r.duration_ms FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id WHERE r.practice = 0 AND i.deck_id IN (${marks}) ORDER BY r.card_id, r.ts`,
        ...ids,
      )
      .map((r) => ({ cardId: r.card_id, ts: r.ts, rating: r.rating, state: r.state, durationMs: r.duration_ms }));
    if (reviews.length < MIN_REVIEWS) throw new EtudeError(`optimizing needs at least ${MIN_REVIEWS} reviews; ${decks.length === 1 ? "this deck has" : `these ${decks.length} decks have`} ${reviews.length}`);
    const cfg = this.configFor(decks[0].name);
    let fit;
    try {
      fit = await fitWeights(reviews, {
        current: cfg.weights,
        dayStartHour: this.settings().dayStartHour,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        enableShortTerm: cfg.enableShortTerm,
        relearningSteps: cfg.relearningSteps.length,
      });
    } catch (e) {
      if (e instanceof OptimizerMissing) throw new EtudeError(e.message, 501);
      throw new EtudeError(`optimizing failed: ${(e as Error).message}`);
    }
    const better = fit.after.rmse < fit.before.rmse;
    const out: OptimizeResult = {
      source,
      decks: decks.map((d) => d.name),
      cards: new Set(reviews.map((r) => r.cardId)).size,
      reviews: reviews.length,
      items: fit.items,
      current: cfg.weights ?? null,
      weights: fit.weights,
      before: fit.before,
      after: fit.after,
      better,
      applied: false,
    };
    if (opts.apply && better) {
      if (source.kind === "preset") {
        const p = this.preset(source.id);
        this.savePreset({ ...p, config: { ...p.config, weights: fit.weights } });
      } else {
        const d = this.deck(source.name);
        this.updateDeck(d.name, { config: { ...d.config, weights: fit.weights } });
      }
      out.applied = true;
      if (opts.reschedule) {
        out.rescheduled = this.replayCards(
          this.db.all(`SELECT c.id, c.item_id, d.name AS deck, i.created FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE d.id IN (${marks})`, ...ids),
        ).rescheduled;
      }
    }
    return out;
  }

  // ------------------------------------------------------------- overview

  /** Decks in tree order: parents before children, siblings by position, then name. */
  private orderedDecks(includeArchived = false): Row[] {
    const rows = this.db.all(includeArchived ? "SELECT * FROM decks" : "SELECT * FROM decks WHERE archived = 0");
    const byName = new Map(rows.map((r) => [r.name as string, r]));
    const key = (name: string) => {
      const parts = deckParts(name);
      return parts.map((leaf, i) => {
        const pos = byName.get(parts.slice(0, i + 1).join("::"))?.position;
        return { pos: pos == null ? Infinity : Number(pos), leaf: leaf.toLowerCase() };
      });
    };
    const keys = new Map(rows.map((r) => [r.name as string, key(r.name)]));
    return rows.sort((a, b) => {
      const ka = keys.get(a.name)!, kb = keys.get(b.name)!;
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        if (ka[i].pos !== kb[i].pos) return ka[i].pos < kb[i].pos ? -1 : 1;
        if (ka[i].leaf !== kb[i].leaf) return ka[i].leaf < kb[i].leaf ? -1 : 1;
      }
      return ka.length - kb.length;
    });
  }

  /**
   * Puts the subdecks of `parent` ("" for top level) in the given order. `order` holds full deck
   * names; siblings left out keep their current relative order after the listed ones.
   */
  reorderDecks(parent: string, order: string[]): string[] {
    const p = normDeck(parent);
    if (p) this.deckRow(p);
    const depth = p ? deckParts(p).length + 1 : 1;
    const isChild = (n: string) => deckParts(n).length === depth && (!p || n.startsWith(p + "::"));
    const current = this.db
      .all("SELECT id, name, position FROM decks")
      .filter((r) => isChild(r.name))
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.name.localeCompare(b.name));
    const ids = new Map(current.map((r) => [r.name.toLowerCase(), r]));
    const listed: Row[] = [];
    for (const raw of order) {
      const r = ids.get(normDeck(raw).toLowerCase());
      if (!r) throw new EtudeError(`"${raw}" isn't a subdeck of ${p ? `"${p}"` : "the top level"}`);
      if (!listed.includes(r)) listed.push(r);
    }
    const final = [...listed, ...current.filter((r) => !listed.includes(r))];
    this.db.tx(() => final.forEach((r, i) => this.db.run("UPDATE decks SET position = ? WHERE id = ?", i, r.id)));
    return final.map((r) => r.name);
  }

  deckTree(opts: { archived?: boolean } = {}) {
    const decks = this.orderedDecks(!!opts.archived);
    const t = now();
    const totals = new Map(
      this.db
        .all("SELECT i.deck_id, COUNT(*) AS cards, SUM(c.state = 0) AS new, SUM(c.suspended) AS suspended FROM cards c JOIN items i ON i.id = c.item_id WHERE i.archived = 0 GROUP BY i.deck_id")
        .map((r) => [r.deck_id, r]),
    );
    return decks.map((d) => {
      const prefix = d.name + "::";
      let cards = 0, unseen = 0;
      for (const o of decks) if ((!o.archived || d.archived) && (o.name === d.name || o.name.startsWith(prefix))) {
        const tt = totals.get(o.id);
        cards += Number(tt?.cards ?? 0);
        unseen += Number(tt?.new ?? 0);
      }
      const counts = cards ? this.counts({ deck: d.name }) : { new: 0, learning: 0, learningSoon: 0, review: 0, doneToday: 0, nextDue: null };
      const cfg = this.configFor(d.name);
      return { ...this.deckFromRow(d), depth: deckParts(d.name).length - 1, cards, unseen, ...counts, deadline: cfg.deadline ?? null, mode: cfg.mode, at: iso(t) };
    });
  }

  /**
   * Overview numbers for a deck or search. `days` sets the activity window (heatmap, ratings,
   * verdicts); true retention always looks at the last 30 days; the forecast covers 30 days.
   */
  stats(scope: StudyScope = {}, days = 30) {
    days = Math.max(1, Math.min(3660, Math.floor(Number(days) || 30)));
    const { where, params, cfg } = this.scopeWhere(scope);
    const from = "FROM cards c JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id";
    const t = now();
    const today = this.dayStart(t);
    // Each deck's scheduler decides what its numbers mean: FSRS has a memory model, a rated script
    // (Leitner) has ratings and due dates, a drill has neither and is measured by its results.
    const cfgs = new Map<string, PresetConfig>();
    const cfgOf = (deck: string) => {
      if (!cfgs.has(deck)) cfgs.set(deck, this.configFor(deck));
      return cfgs.get(deck)!;
    };
    const kinds = new Map<string, { kind: "fsrs" | "rated" | "drill"; def: SchedulerDef | null }>();
    const kindOf = (deck: string) => {
      if (!kinds.has(deck)) {
        const def = this.scriptFor(cfgOf(deck));
        kinds.set(deck, { kind: !def ? "fsrs" : def.ratings === false ? "drill" : "rated", def });
      }
      return kinds.get(deck)!;
    };
    const onScript = (deck: string) => kindOf(deck).kind !== "fsrs";
    const everything = this.db.all<CardRow & { deck: string; tags: string; item_id: string; type: string; fields: string }>(`SELECT c.*, d.name AS deck, i.tags, i.type, i.fields ${from} WHERE ${where}`, ...params);
    const all = everything.filter((c) => !onScript(c.deck));
    // Card states and maturity are FSRS's; a script scheduler's cards are counted in `schedulers`.
    const states = { total: all.length, new: 0, learning: 0, review: 0, mature: 0 };
    for (const c of all) {
      if (c.state === 0) states.new++;
      else if (c.state === 1 || c.state === 3) states.learning++;
      else if (c.state === 2) {
        states.review++;
        if (c.stability >= 21) states.mature++;
      }
    }
    const dayKey = (ts: string | Date) => {
      const ds = this.dayStart(new Date(ts));
      return `${ds.getFullYear()}-${String(ds.getMonth() + 1).padStart(2, "0")}-${String(ds.getDate()).padStart(2, "0")}`;
    };
    // Calendar days can be 23 or 25 hours long, so step by date, not by 24 h.
    const dayAt = (offset: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      return d;
    };
    const since = dayAt(-(days - 1));
    const since30 = dayAt(-29);
    const rvFrom = `FROM reviews r JOIN cards c ON c.id = r.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id`;
    const windowStart = since < since30 ? since : since30;
    const rv = this.db.all(`SELECT r.ts, r.rating, r.state, r.duration_ms, d.name AS deck ${rvFrom} WHERE r.ts >= ? AND r.practice = 0 AND ${where}`, iso(windowStart), ...params);
    // Pass rates only count rated reviews; a drill's answers (rating 0) are runs, measured in its own metrics.
    // Retention is FSRS's: a script scheduler's pass rate is reported per scheduler.
    const byDay = new Map<string, { reviews: number; again: number; runs: number; ms: number }>();
    const ratings = { again: 0, hard: 0, good: 0, easy: 0 };
    const RN = ["", "again", "hard", "good", "easy"] as const;
    const todayStats = { reviews: 0, again: 0, ms: 0, new: 0 };
    let reviewed = 0, passed = 0, reviewed30 = 0, passed30 = 0;
    const sinceIso = iso(since), since30Iso = iso(since30), todayIso = iso(today);
    const todayRuns = { runs: 0 };
    for (const r of rv) {
      const fsrs = kindOf(r.deck).kind === "fsrs";
      const run = r.rating === 0;
      if (fsrs && r.ts >= since30Iso && r.state === 2 && r.rating >= 1) {
        reviewed30++;
        if (r.rating > 1) passed30++;
      }
      if (r.ts >= todayIso) {
        if (run) todayRuns.runs++;
        else todayStats.reviews++;
        if (r.rating === 1) todayStats.again++;
        if (r.state === 0 && r.rating >= 1) todayStats.new++;
        todayStats.ms += r.duration_ms ?? 0;
      }
      if (r.ts < sinceIso) continue;
      const k = dayKey(r.ts);
      const e = byDay.get(k) ?? { reviews: 0, again: 0, runs: 0, ms: 0 };
      if (run) e.runs++;
      else e.reviews++;
      if (r.rating === 1) e.again++;
      e.ms += r.duration_ms ?? 0;
      byDay.set(k, e);
      if (r.rating >= 1 && r.rating <= 4) ratings[RN[r.rating] as keyof typeof ratings]++;
      if (fsrs && r.state === 2 && r.rating >= 1) {
        reviewed++;
        if (r.rating > 1) passed++;
      }
    }
    // Consecutive study days ending today (or yesterday, if today has nothing yet).
    let streak = 0;
    for (let i = byDay.has(dayKey(today)) ? 0 : -1; byDay.has(dayKey(dayAt(i))); i--) streak++;

    // Grading verdicts from answered attempts (practice included: a verdict is a verdict).
    const verdicts = { correct: 0, partial: 0, incorrect: 0, ungraded: 0 };
    const at = this.db.all(`SELECT a.grade FROM attempts a JOIN cards c ON c.id = a.card_id JOIN items i ON i.id = c.item_id JOIN decks d ON d.id = i.deck_id WHERE a.ts >= ? AND ${where}`, sinceIso, ...params);
    for (const a of at) {
      const v = parse<Grade>(a.grade, {} as Grade).verdict;
      if (v && v in verdicts) verdicts[v as keyof typeof verdicts]++;
    }

    // Forecast: overdue cards land on today. A drill is always ready by design, so it stays out:
    // it's counted as `ready` in its scheduler's summary instead.
    const forecast: { day: string; due: number }[] = [];
    const dueRows = everything.filter((c) => c.state !== 0 && kindOf(c.deck).kind !== "drill");
    const bounds = Array.from({ length: 31 }, (_, i) => dayAt(i).getTime());
    const buckets = new Array(30).fill(0);
    let overdue = 0;
    const nowMs = t.getTime();
    for (const r of dueRows) {
      const ms = new Date(r.due).getTime();
      if (ms <= nowMs) overdue++;
      if (ms < bounds[1]) buckets[0]++;
      else for (let i = 1; i < 30; i++) if (ms < bounds[i + 1]) { buckets[i]++; break; }
    }
    for (let i = 0; i < 30; i++) forecast.push({ day: dayKey(dayAt(i)), due: buckets[i] });

    // Predicted recall now, with each card's own deck settings (weights can differ per deck).
    // Recall, stability and the forgetting curve are FSRS's predictions; cards on another scheduler have none.
    const byTag = new Map<string, { n: number; r: number }>();
    const tree = new Map<string, { cards: number; seen: number; r: number; direct: boolean }>();
    let rSum = 0, seenN = 0;
    for (const c of all) {
      const r = c.state === 0 ? null : (sched.retrievability(c, t, cfgOf(c.deck)) ?? 0);
      if (r != null) {
        rSum += r;
        seenN++;
      }
      const tags = parse<string[]>(c.tags, []);
      const credited = new Set<string>();
      for (const tag of tags) {
        if (r != null) {
          const e = byTag.get(tag) ?? { n: 0, r: 0 };
          e.n++;
          e.r += r;
          byTag.set(tag, e);
        }
        const parts = tag.split("::");
        for (let i = 1; i <= parts.length; i++) {
          const key = parts.slice(0, i).join("::");
          const node = tree.get(key) ?? { cards: 0, seen: 0, r: 0, direct: false };
          if (i === parts.length) node.direct = true;
          // A card tagged a::b and a::c counts once under a.
          if (!credited.has(key)) {
            credited.add(key);
            node.cards++;
            if (r != null) {
              node.seen++;
              node.r += r;
            }
          }
          tree.set(key, node);
        }
      }
    }
    const tagTree = [...tree.entries()]
      .map(([tag, v]) => ({ tag, depth: tag.split("::").length - 1, direct: v.direct, cards: v.cards, seen: v.seen, recall: v.seen ? v.r / v.seen : null }))
      .sort((a, b) => a.tag.localeCompare(b.tag));

    // Memory: how strong the studied cards are now, and how recall would fall with no more reviews.
    const STAB = [1, 3, 7, 21, 60, 180, Infinity];
    const stability = STAB.map((upTo) => ({ upTo: Number.isFinite(upTo) ? upTo : null, cards: 0 }));
    const recallBins = new Array(10).fill(0);
    const difficulty = new Array(10).fill(0);
    const seenCards = all.filter((c) => c.state !== 0 && c.last_review);
    // One FSRS instance per deck: building one per card would dominate the cost on big collections.
    const engines = new Map<string, ReturnType<typeof sched.engine>>();
    const engOf = (deck: string) => {
      if (!engines.has(deck)) engines.set(deck, sched.engine(cfgOf(deck)));
      return engines.get(deck)!;
    };
    const fsrsCards = seenCards.map((c) => ({ deck: c.deck, card: sched.toFsrs(c) }));
    for (const c of seenCards) {
      stability[STAB.findIndex((u) => c.stability < u)].cards++;
      const r = sched.retrievability(c, t, cfgOf(c.deck)) ?? 0;
      recallBins[Math.min(9, Math.floor(r * 10))]++;
      if (c.difficulty > 0) difficulty[Math.min(9, Math.max(0, Math.floor(c.difficulty) - 1))]++;
    }
    const CURVE = [0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 15, 18, 21, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90];
    const curve = seenCards.length
      ? CURVE.map((d) => {
          const at = new Date(t.getTime() + d * 86400_000);
          let sum = 0;
          for (const f of fsrsCards) sum += engOf(f.deck).get_retrievability(f.card, at, false) as number;
          return { days: d, recall: sum / seenCards.length };
        })
      : [];

    // When the learner studies: reviews and pass rate per hour of the day, over the window.
    // `reviews` counts every answer; the pass rate is over `rated` ones (a drill run has no rating).
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, reviews: 0, rated: 0, passed: 0 }));
    // Weekly pass rate on review cards and weekly volume, oldest first.
    const weekCount = Math.ceil(days / 7);
    const weeks = Array.from({ length: weekCount }, () => ({ reviews: 0, reviewed: 0, passed: 0, ms: 0 }));
    const weekMs = 7 * 86400_000;
    const end = dayAt(1).getTime();
    for (const r of rv) {
      if (r.ts < sinceIso) continue;
      const at = new Date(r.ts);
      const h = hours[at.getHours()];
      h.reviews++;
      if (r.rating >= 1) {
        h.rated++;
        if (r.rating > 1) h.passed++;
      }
      const w = weekCount - 1 - Math.floor((end - 1 - at.getTime()) / weekMs);
      if (w < 0 || w >= weekCount) continue;
      weeks[w].reviews++;
      weeks[w].ms += r.duration_ms ?? 0;
      if (kindOf(r.deck).kind === "fsrs" && r.state === 2 && r.rating >= 1) {
        weeks[w].reviewed++;
        if (r.rating > 1) weeks[w].passed++;
      }
    }
    // Longest run of consecutive study days inside the window.
    let bestStreak = 0;
    for (let i = -(days - 1), run = 0; i <= 0; i++) {
      run = byDay.has(dayKey(dayAt(i))) ? run + 1 : 0;
      bestStreak = Math.max(bestStreak, run);
    }

    const schedulers = this.schedulerSummary(everything, rv, kindOf, t, sinceIso, dayAt(1));

    return {
      /** FSRS cards by state (a script scheduler's cards are in `schedulers`). */
      cards: states,
      /** Pass rate on review-state cards over the whole window. */
      retention: reviewed ? passed / reviewed : null,
      /** Pass rate on review-state cards over the last 30 days. */
      trueRetention: { days: 30, reviewed: reviewed30, passed: passed30, rate: reviewed30 ? passed30 / reviewed30 : null },
      recall: seenN ? rSum / seenN : null,
      days: [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v })),
      forecast,
      overdue,
      tags: [...byTag.entries()].map(([tag, v]) => ({ tag, cards: v.n, recall: v.r / v.n })).sort((a, b) => a.tag.localeCompare(b.tag)),
      /** Every tag with its ancestors: a card under a::b also counts toward a. */
      tagTree,
      today: { ...todayStats, ...todayRuns, day: dayKey(today) },
      ratings,
      verdicts,
      streak,
      bestStreak,
      /** Studied cards by stability (days; `upTo` is the exclusive upper bound, null = no bound). */
      stability,
      /** Studied cards by predicted recall now, in tenths: [0-10%, 10-20%, ...]. */
      recallBins,
      /** Studied cards by FSRS difficulty 1..10, one bucket per point. */
      difficulty,
      /** Mean predicted recall of the studied cards if nothing were reviewed for `days` more days. */
      curve,
      desiredRetention: cfg.desiredRetention,
      hours,
      /** Weekly volume and pass rate on review cards, oldest week first; the last week ends today. */
      weeks: weeks.map((w) => ({ ...w, rate: w.reviewed ? w.passed / w.reviewed : null })),
      window: { days, from: dayKey(since), to: dayKey(today) },
      deadline: scope.deck ? (cfg.deadline ?? null) : null,
      deadlineMargin: cfg.deadlineMargin,
      /** The scope's own scheduler (a deck's), or null for "all decks". */
      scheduler: scope.deck ? cfg.scheduler : null,
      /** Every scheduler with cards in scope, FSRS first: how many cards, what's due, and what its state says. */
      schedulers,
      /** Cards whose results are measurements: every graded attempt's numbers over time. */
      // Measured cards: drills, and any card whose type declares metrics. A rated script's cards (Leitner)
      // are reviews like FSRS's, not measurements, so they don't get a chart each.
      practice: this.practiceStats(everything.filter((c) => kindOf(c.deck).kind === "drill" || !!this.typeMetrics(c.type)), sinceIso),
    };
  }

  /**
   * One row per scheduler in scope. A rated script gets its pass rate and due cards; a drill gets how
   * many cards are ready now; a scheduler that declares `stats.groupBy` gets its cards counted by that
   * value of their state (Leitner: cards per box).
   */
  private schedulerSummary(
    cards: (CardRow & { deck: string })[],
    rv: Row[],
    kindOf: (deck: string) => { kind: "fsrs" | "rated" | "drill"; def: SchedulerDef | null },
    t: Date,
    sinceIso: string,
    tomorrow: Date,
  ) {
    type Summary = {
      id: string;
      name: string;
      kind: "fsrs" | "rated" | "drill";
      decks: string[];
      cards: number;
      new: number;
      /** Rated: due before tomorrow starts (overdue included). Drill: ready right now. */
      due: number;
      answers: number;
      rated: number;
      passed: number;
      passRate: number | null;
      groups: { label: string; bins: { key: string; cards: number }[]; other: number } | null;
    };
    const out = new Map<string, Summary & { values: Map<string, number>; deckSet: Set<string> }>();
    const idOf = (deck: string) => kindOf(deck).def?.id ?? FSRS;
    const pick = (obj: unknown, path: string): unknown => {
      let v: any = obj;
      for (const k of path.split(".")) v = v == null ? undefined : v[k];
      return v;
    };
    const nowMs = t.getTime(), tomorrowMs = tomorrow.getTime();
    for (const c of cards) {
      const { kind, def } = kindOf(c.deck);
      const id = idOf(c.deck);
      let e = out.get(id);
      if (!e) {
        e = { id, name: def?.name ?? "FSRS", kind, decks: [], cards: 0, new: 0, due: 0, answers: 0, rated: 0, passed: 0, passRate: null, groups: null, values: new Map(), deckSet: new Set() };
        out.set(id, e);
      }
      e.cards++;
      e.deckSet.add(c.deck);
      const due = new Date(c.due).getTime();
      if (c.state === 0) e.new++;
      else if (kind === "drill" ? due <= nowMs : due < tomorrowMs) e.due++;
      if (def?.stats && c.state !== 0) {
        const v = pick(parse(c.sched_state ?? null, null), def.stats.groupBy);
        const key = v == null || typeof v === "object" ? "" : String(v);
        e.values.set(key, (e.values.get(key) ?? 0) + 1);
      }
    }
    for (const r of rv) {
      if (r.ts < sinceIso) continue;
      const e = out.get(idOf(r.deck));
      if (!e) continue;
      e.answers++;
      if (r.rating >= 1) {
        e.rated++;
        if (r.rating > 1) e.passed++;
      }
    }
    return [...out.values()]
      .sort((a, b) => (a.id === FSRS ? -1 : b.id === FSRS ? 1 : b.cards - a.cards))
      .map(({ values, deckSet, ...e }) => {
        const def = kindOf([...deckSet][0]).def;
        let groups: Summary["groups"] = null;
        if (def?.stats) {
          const other = values.get("") ?? 0;
          values.delete("");
          const keys = [...values.keys()];
          const numeric = keys.length > 0 && keys.every((k) => /^-?\d+$/.test(k));
          let bins: { key: string; cards: number }[];
          if (numeric) {
            // Whole numbers (boxes, levels) get every step between the lowest and highest, empty ones too.
            const ns = keys.map(Number);
            const lo = Math.min(...ns), hi = Math.max(...ns);
            bins = hi - lo <= 60 ? Array.from({ length: hi - lo + 1 }, (_, i) => ({ key: String(lo + i), cards: values.get(String(lo + i)) ?? 0 })) : ns.sort((a, b) => a - b).map((n) => ({ key: String(n), cards: values.get(String(n))! }));
          } else bins = keys.sort((a, b) => a.localeCompare(b)).map((k) => ({ key: k, cards: values.get(k)! }));
          groups = { label: def.stats.label ?? def.stats.groupBy, bins, other };
        }
        return { ...e, decks: [...deckSet].sort(), passRate: e.rated ? e.passed / e.rated : null, groups };
      });
  }

  /** The metrics a type declares, or null when it declares none. */
  private typeMetrics(typeId: string): MetricSpec[] | null {
    try {
      const m = this.type(typeId).metrics;
      return m?.length ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * Per-card time series of the grader's numbers: what a drill is for. Each point is one graded
   * attempt (practice ones too: a result is a result). Metrics come from the type's `metrics`, or else
   * every top-level number the grader put in `details`, plus the score.
   */
  private practiceStats(cards: (CardRow & { deck: string; item_id: string; type: string; fields: string })[], sinceIso: string) {
    const out: {
      cardId: number;
      itemId: string;
      deck: string;
      type: string;
      title: string;
      scheduler: string;
      sessions: number;
      metrics: { key: string; label: string; unit: string; better: "higher" | "lower"; digits: number; first: number | null; last: number | null; best: number | null; mean: number | null; points: { at: string; value: number }[] }[];
      days: { day: string; sessions: number }[];
    }[] = [];
    const pick = (obj: unknown, path: string): number | null => {
      let v: any = obj;
      for (const k of path.split(".")) v = v == null ? undefined : v[k];
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    for (const c of cards.slice(0, 60)) {
      const attempts = this.db.all<{ ts: string; grade: string }>("SELECT ts, grade FROM attempts WHERE card_id = ? AND ts >= ? ORDER BY ts", c.id, sinceIso);
      if (!attempts.length) continue;
      const grades = attempts.map((a) => ({ at: a.ts, g: parse<Grade>(a.grade, {} as Grade) })).filter((x) => x.g && x.g.verdict !== "ungraded");
      if (!grades.length) continue;
      let specs = this.typeMetrics(c.type);
      if (!specs) {
        const keys = new Set<string>();
        for (const { g } of grades) if (g.details && typeof g.details === "object" && !Array.isArray(g.details)) for (const [k, v] of Object.entries(g.details)) if (typeof v === "number") keys.add(k);
        specs = [...keys].slice(0, 6).map((key) => ({ key }));
        specs.push({ key: "score", label: "Score", unit: "%" });
      }
      const metrics = specs.map((m) => {
        const points = grades
          .map(({ at, g }) => ({ at, value: m.key === "score" ? (g.score == null ? null : g.score * (m.unit === "%" ? 100 : 1)) : pick(g.details, m.key) }))
          .filter((p): p is { at: string; value: number } => p.value != null);
        const vals = points.map((p) => p.value);
        const better = m.better ?? "higher";
        return {
          key: m.key,
          label: m.label ?? m.key,
          unit: m.unit ?? "",
          better,
          digits: m.digits ?? (vals.some((v) => !Number.isInteger(v)) ? 1 : 0),
          first: vals.length ? vals[0] : null,
          last: vals.length ? vals[vals.length - 1] : null,
          best: vals.length ? (better === "lower" ? Math.min(...vals) : Math.max(...vals)) : null,
          mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
          points,
        };
      }).filter((m) => m.points.length);
      const byDay = new Map<string, number>();
      for (const { at } of grades) {
        const ds = this.dayStart(new Date(at));
        const k = `${ds.getFullYear()}-${String(ds.getMonth() + 1).padStart(2, "0")}-${String(ds.getDate()).padStart(2, "0")}`;
        byDay.set(k, (byDay.get(k) ?? 0) + 1);
      }
      out.push({
        cardId: c.id,
        itemId: c.item_id,
        deck: c.deck,
        type: c.type,
        title: this.titleOf(c.type, parse<Record<string, unknown>>(c.fields, {}), { private: true }),
        scheduler: this.configFor(c.deck).scheduler,
        sessions: grades.length,
        metrics,
        days: [...byDay.entries()].sort().map(([day, sessions]) => ({ day, sessions })),
      });
    }
    return out.sort((a, b) => b.sessions - a.sessions);
  }

  // ------------------------------------------------------------- packs

  /**
   * A pack can carry its own images: a field whose whole value is a base64 `data:` URL of a media
   * type is copied into the collection's media and replaced by its `/media/...` URL.
   */
  private unpackMedia(fields: Record<string, unknown>, dryRun: boolean): Record<string, unknown> {
    let out = fields;
    for (const [k, v] of Object.entries(fields)) {
      const m = typeof v === "string" ? /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v) : null;
      if (!m) continue;
      const ext = Object.entries({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "video/mp4": "mp4", "video/webm": "webm" }).find(([mime]) => mime === m[1])?.[1];
      if (!ext) continue;
      if (out === fields) out = { ...fields };
      out[k] = this.storeMedia(`${k}.${ext}`, Buffer.from(m[2], "base64"), { dryRun }).url;
    }
    return out;
  }

  importPack(pack: any, opts: { dryRun?: boolean } = {}) {
    if (!pack || pack.etude !== "pack/1") throw new EtudeError('not an Etude pack (expected "etude": "pack/1")');
    const report = {
      presets: 0,
      decks: 0,
      schedulers: { created: 0, updated: 0, unchanged: 0 },
      types: { created: 0, updated: 0, unchanged: 0 },
      /** Asset files the pack's types carry, and what importing did with them. */
      assets: { files: 0, bytes: 0, created: 0, updated: 0, unchanged: 0, removed: 0 } as AssetDelta,
      items: { created: 0, updated: 0, unchanged: 0 },
      tags: 0,
      errors: [] as string[],
    };
    const run = () => {
      // Schedulers first: presets and decks may name them.
      for (const sc of pack.schedulers ?? []) report.schedulers[this.saveScheduler(sc).result]++;
      for (const p of pack.presets ?? []) {
        this.savePreset({ id: p.id, name: p.name ?? p.id, config: p.config ?? {} });
        report.presets++;
      }
      for (const t of pack.types ?? []) {
        const r = this.saveTypeReport(t);
        report.types[r.result]++;
        if (r.assets) for (const k of Object.keys(report.assets) as (keyof AssetDelta)[]) report.assets[k] += r.assets[k];
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
          const fields = this.unpackMedia(it.fields ?? {}, !!opts.dryRun);
          const r = this.upsertItem({ id: it.id, type: it.type, deck: it.deck, fields, tags: it.tags ?? [], source: it.source ?? "", notes: it.notes ?? "", archived: !!it.archived }, { ord: base + i });
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

  /**
   * Imports an Anki package (.apkg/.colpkg, current or legacy format). Items are keyed by note guid,
   * so importing the same file again updates content instead of duplicating it; cards that already
   * have history keep their scheduling.
   */
  importAnki(source: string | Buffer, opts: { dryRun?: boolean; scheduling?: boolean; deckPrefix?: string } = {}) {
    const buf = typeof source === "string" ? readFileSync(source) : source;
    if (!buf?.length) throw new EtudeError("the Anki package is empty");
    let pkg;
    try {
      pkg = openPackage(buf);
    } catch (e) {
      throw new EtudeError(`not an Anki package: ${(e as Error).message}`);
    }
    const collection = readCollection(pkg.collection);
    const scheduling = opts.scheduling !== false;
    const prefix = opts.deckPrefix?.trim();
    if (prefix && !/^[\w .:&/-]+$/.test(prefix)) throw new EtudeError(`invalid deck prefix "${prefix}"`);
    const plan = convertCollection(collection, { deckPrefix: prefix || undefined, scheduling, media: pkg.media });

    const report = {
      format: pkg.format,
      dryRun: !!opts.dryRun,
      scheduling,
      types: { created: 0, updated: 0, unchanged: 0 },
      presets: { created: 0, updated: 0, unchanged: 0 },
      decks: 0,
      items: { created: 0, updated: 0, unchanged: 0 },
      cards: 0,
      reviews: 0,
      /** What the package held, before de-duplication (useful in a dry run). */
      read: { notes: plan.notes, cards: plan.cardsRead, reviews: plan.reviewsRead },
      media: { files: plan.media.length, bytes: 0 },
      skipped: plan.skipped,
    };

    const cardsByItem = new Map<string, PlannedCard[]>();
    for (const c of plan.cards) {
      const list = cardsByItem.get(c.itemId) ?? [];
      list.push(c);
      cardsByItem.set(c.itemId, list);
    }

    const run = () => {
      for (const p of plan.presets) {
        const existed = this.db.get<{ name: string; config: string }>("SELECT name, config FROM presets WHERE id = ?", p.id);
        if (existed && existed.name === p.name && canonical(existed.config) === canonical(p.config)) {
          report.presets.unchanged++;
          continue;
        }
        this.savePreset({ id: p.id, name: p.name, config: p.config });
        if (existed) report.presets.updated++;
        else report.presets.created++;
      }
      for (const t of plan.types) {
        const existed = this.db.get("SELECT def FROM types WHERE id = ?", t.id);
        const saved = this.saveType(t);
        if (!existed) report.types.created++;
        else if (existed.def === json(saved)) report.types.unchanged++;
        else report.types.updated++;
      }
      for (const d of plan.decks) {
        this.ensureDeck(d.name);
        const patch: { presetId?: string; description?: string } = {};
        if (d.presetId) patch.presetId = d.presetId;
        if (d.description) patch.description = d.description;
        this.updateDeck(d.name, patch);
        report.decks++;
      }
      plan.items.forEach((it, i) => {
        const r = this.upsertItem({ id: it.id, type: it.type, deck: it.deck, fields: it.fields, tags: it.tags, source: it.source }, { ord: i + 1 });
        report.items[r]++;
        for (const card of cardsByItem.get(it.id) ?? []) {
          const row = this.db.get<{ id: number; reviewed: number }>(
            "SELECT id, (SELECT COUNT(*) FROM reviews WHERE card_id = cards.id) AS reviewed FROM cards WHERE item_id = ? AND face = ?",
            it.id,
            card.face,
          );
          // A face the note no longer qualifies for (an unused cloze, an unfilled optional reverse).
          if (!row) continue;
          report.cards++;
          // Already studied here: keep the learner's progress rather than Anki's old state.
          if (row.reviewed > 0) continue;
          this.db.run(
            "UPDATE cards SET state = ?, due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, reps = ?, lapses = ?, learning_steps = ?, last_review = ?, suspended = ?, buried_until = ? WHERE id = ?",
            card.state,
            card.due,
            card.stability,
            card.difficulty,
            card.elapsedDays,
            card.scheduledDays,
            card.reps,
            card.lapses,
            card.learningSteps,
            card.lastReview,
            Number(card.suspended),
            card.buriedUntil,
            row.id,
          );
          for (const rev of card.reviews) {
            const res = this.db.run(
              "INSERT INTO reviews (card_id, ts, rating, state, card_before, due_after, duration_ms, practice) SELECT ?, ?, ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM reviews WHERE card_id = ? AND ts = ?)",
              row.id,
              rev.ts,
              rev.rating,
              rev.stateBefore,
              rev.cardBefore,
              rev.dueAfter,
              rev.durationMs,
              row.id,
              rev.ts,
            );
            report.reviews += Number(res.changes);
          }
        }
      });
    };

    try {
      this.db.tx(() => {
        run();
        if (opts.dryRun) throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    // Files aren't part of the transaction, so a dry run writes none.
    if (!opts.dryRun) {
      mkdirSync(join(this.mediaDir, "anki"), { recursive: true });
      for (const m of plan.media) {
        const data = m.load();
        writeFileSync(join(this.mediaDir, m.target), data);
        report.media.bytes += data.length;
      }
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
    const custom = this.db.all("SELECT id FROM types WHERE builtin = 0").filter((t) => typeIds.has(t.id)).map((t) => this.typeWithAssets(t.id));
    // Script schedulers the exported decks or presets use, unless they ship with Etude unchanged.
    const schedulerIds = new Set(
      [...decks.map((d) => d.config.scheduler), ...[...presetIds].map((id) => this.preset(id).config.scheduler)].filter((x): x is string => !!x && x !== FSRS),
    );
    const schedulers = this.db.all("SELECT id, def FROM schedulers WHERE builtin = 0").filter((r) => schedulerIds.has(r.id)).map((r) => parse(r.def, {}));
    const tagSet = new Set(items.flatMap((i) => parse<string[]>(i.tags, [])));
    const tags = this.db.all("SELECT * FROM tag_meta").filter((t) => tagSet.has(t.tag) && (t.instructions || t.description));
    return {
      etude: "pack/1",
      name: scope.name ?? scope.deck ?? "Etude export",
      exported: iso(),
      presets: [...presetIds].map((id) => this.preset(id)),
      decks: decks.map((d) => ({ name: d.name, ...(d.presetId ? { preset: d.presetId } : {}), ...(Object.keys(d.config).length ? { config: d.config } : {}), description: d.description, instructions: d.instructions })),
      tags: tags.map((t) => ({ name: t.tag, instructions: t.instructions, description: t.description })),
      ...(schedulers.length ? { schedulers } : {}),
      types: custom,
      items: items.map((i) => ({ id: i.id, type: i.type, deck: i.deck, tags: parse(i.tags, []), fields: parse(i.fields, {}), source: i.source, notes: i.notes, ...(i.archived ? { archived: true } : {}) })),
    };
  }
}

class DryRun extends Error {}

/** What saving a type's assets did. `files`/`bytes` describe the set that was saved. */
export interface AssetDelta {
  files: number;
  bytes: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
}

const assetsChanged = (d: AssetDelta | null) => !!d && d.created + d.updated + d.removed > 0;

/** A loaded type split into the definition that's stored as JSON and its assets. */
function splitAssets(t: CardTypeDef): { def: CardTypeDef; assets?: Record<string, string> } {
  const { assets, ...def } = t;
  return { def, assets };
}

/** JSON with sorted keys, so two encodings of the same settings compare equal. */
function canonical(value: unknown): string {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]));
    return v;
  };
  return JSON.stringify(walk(parsed ?? {}));
}

export { DEFAULT_PRESET };
