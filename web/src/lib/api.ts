// Typed client for the Etude API.

export type Rating = 1 | 2 | 3 | 4;
export type Verdict = "correct" | "partial" | "incorrect" | "ungraded";

export interface Grade {
  score: number | null;
  verdict: Verdict;
  feedback?: string;
  details?: unknown;
  suggested: Rating | null;
  confidence?: number;
  grader: { kind: string; model?: string; ms?: number; cost?: number; error?: string };
}

export interface PresetConfig {
  desiredRetention: number;
  learningSteps: string[];
  relearningSteps: string[];
  maximumInterval: number;
  enableFuzz: boolean;
  enableShortTerm: boolean;
  weights?: number[];
  newPerDay: number;
  reviewsPerDay: number;
  newOrder: "added" | "random" | "deck";
  reviewOrder: "due" | "retrievability" | "random";
  newMix: "mix" | "first" | "last";
  deadline?: string | null;
  deadlineMargin: number;
  autoRate: { good: number; hard: number };
  autoApply: boolean;
  burySiblings: boolean;
}

export interface DeckNode {
  id: number;
  name: string;
  presetId: string | null;
  config: Partial<PresetConfig>;
  description: string;
  instructions: string;
  depth: number;
  cards: number;
  unseen: number;
  new: number;
  learning: number;
  learningSoon: number;
  review: number;
  doneToday: number;
  nextDue: string | null;
  deadline: string | null;
}

export interface Counts {
  new: number;
  learning: number;
  learningSoon: number;
  review: number;
  doneToday: number;
  nextDue: string | null;
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
  grader: string;
  generated: boolean;
  title: string;
}

export interface FieldSpec {
  name: string;
  kind: "markdown" | "text" | "number" | "boolean" | "list" | "json" | "code" | "html";
  label?: string;
  description?: string;
  required?: boolean;
  private?: boolean;
  default?: unknown;
  editor?: "choices" | "pairs" | "parts";
  /** For `code` fields: the language to highlight, or `field:<name>` to read it from another field. */
  language?: string;
}

export interface CardType {
  id: string;
  name: string;
  description?: string;
  faces?: string[];
  facesWhen?: string;
  fields: FieldSpec[];
  prepare?: string;
  template: { html: string; css?: string; js?: string };
  grader: { kind: "self" } | { kind: "script"; code: string } | { kind: "ai"; vision?: boolean; instructions?: string } | { kind: "hybrid"; code: string; vision?: boolean; instructions?: string };
  instructions?: string;
  updated?: string;
  builtin?: boolean;
}

export interface TypeSummary {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** A type with this id ships with Etude. */
  shipped: boolean;
  /** Shipped, but replaced by the user's own version (can be reset). */
  edited: boolean;
  updated: string;
  items: number;
  grader: string;
  /** Folder path in the Types page ("A::B"), "" when the type isn't in a folder. */
  folder: string;
}

export interface SearchRow {
  cardId: number;
  itemId: string;
  face: string;
  type: string;
  deck: string;
  tags: string[];
  title: string;
  state: number;
  due: string;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  suspended: boolean;
  archived: boolean;
  generated: boolean;
  retrievability: number | null;
}

export interface ItemDetail {
  id: string;
  type: string;
  deck: string;
  fields: Record<string, unknown>;
  tags: string[];
  source: string;
  notes: string;
  archived: boolean;
  created: string;
  updated: string;
  cards: (Record<string, any> & { id: number; face: string; state: number; due: string; retrievability: number | null })[];
  reviews: { id: number; card_id: number; ts: string; rating: number; state: number; due_after: string; duration_ms: number | null; score: number | null; practice: number }[];
  attempts: { id: number; card_id: number; ts: string; answer: unknown; grade: Grade; practice: number }[];
}

export interface Stats {
  cards: { total: number; new: number; learning: number; review: number; mature: number };
  /** Pass rate on review-state cards over the requested window. */
  retention: number | null;
  /** Pass rate on review-state cards over the last 30 days. */
  trueRetention: { days: number; reviewed: number; passed: number; rate: number | null };
  recall: number | null;
  days: { day: string; reviews: number; again: number; ms: number }[];
  forecast: { day: string; due: number }[];
  overdue: number;
  tags: { tag: string; cards: number; recall: number }[];
  /** Every tag with its ancestors; recall is over seen cards, null when none are seen. */
  tagTree: { tag: string; depth: number; direct: boolean; cards: number; seen: number; recall: number | null }[];
  today: { day: string; reviews: number; again: number; ms: number; new: number };
  ratings: { again: number; hard: number; good: number; easy: number };
  verdicts: { correct: number; partial: number; incorrect: number; ungraded: number };
  streak: number;
  window: { days: number; from: string; to: string };
  deadline: string | null;
  deadlineMargin: number;
}

export interface Preset {
  id: string;
  name: string;
  config: Partial<PresetConfig>;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// A server started with --token needs it on every API call. Opening the app once with ?token=…
// stores it for this browser.
const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) localStorage.setItem("etude.token", fromUrl);
  return fromUrl ?? localStorage.getItem("etude.token");
})();

async function call<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const headers: Record<string, string> = {};
  if (raw) headers["Content-Type"] = "application/octet-stream";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(path, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status);
  return data as T;
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface AnkiImportReport {
  format: "new" | "legacy";
  dryRun: boolean;
  scheduling: boolean;
  types: { created: number; updated: number; unchanged: number };
  presets: { created: number; updated: number; unchanged: number };
  decks: number;
  items: { created: number; updated: number; unchanged: number };
  cards: number;
  reviews: number;
  read: { notes: number; cards: number; reviews: number };
  media: { files: number; bytes: number };
  skipped: { what: string; name: string; reason: string }[];
}

export interface Scope {
  deck?: string;
  q?: string;
}

export const api = {
  decks: () => call<DeckNode[]>("GET", "/api/decks"),
  deck: (name: string) => call<DeckNode & { resolved: PresetConfig; inherited: PresetConfig; presetBase: PresetConfig }>("GET", `/api/deck${qs({ name })}`),
  createDeck: (name: string) => call("POST", "/api/decks", { name }),
  updateDeck: (name: string, patch: Partial<{ name: string; presetId: string | null; config: Partial<PresetConfig>; description: string; instructions: string; archived: boolean }>) =>
    call<DeckNode & { resolved: PresetConfig }>("PATCH", `/api/deck${qs({ name })}`, patch),
  // Mutations must be JSON (the server refuses anything else), so body-less deletes send {}.
  deleteDeck: (name: string) => call("DELETE", `/api/deck${qs({ name })}`, {}),
  presets: () => call<{ id: string; name: string; config: Partial<PresetConfig> }[]>("GET", "/api/presets"),
  savePreset: (id: string, name: string, config: Partial<PresetConfig>) => call<Preset>("PUT", `/api/presets/${encodeURIComponent(id)}`, { name, config }),
  deletePreset: (id: string) => call<{ ok: true }>("DELETE", `/api/presets/${encodeURIComponent(id)}`, {}),

  types: () => call<TypeSummary[]>("GET", "/api/types"),
  type: (id: string) => call<CardType>("GET", `/api/types/${encodeURIComponent(id)}`),
  saveType: (def: CardType) => call<CardType>("PUT", `/api/types/${encodeURIComponent(def.id)}`, def),
  deleteType: (id: string) => call("DELETE", `/api/types/${encodeURIComponent(id)}`),
  typeFolders: () => call<string[]>("GET", "/api/type-folders"),
  createTypeFolder: (path: string) => call<{ path: string }>("POST", "/api/type-folders", { path }),
  renameTypeFolder: (from: string, to: string) => call<{ from: string; to: string }>("POST", "/api/type-folders/rename", { from, to }),
  deleteTypeFolder: (path: string) => call<{ deleted: string; moved: string[] }>("POST", "/api/type-folders/delete", { path }),
  moveType: (id: string, folder: string) => call<{ id: string; folder: string }>("POST", `/api/types/${encodeURIComponent(id)}/move`, { folder }),
  resetType: (id: string) => call<CardType>("POST", `/api/types/${encodeURIComponent(id)}/reset`, {}),
  previewType: (def: CardType, fields: Record<string, unknown>, opts: { seed?: number; face?: string; answer?: unknown } = {}) =>
    call<{ errors: string[]; view?: Record<string, unknown>; key?: Record<string, unknown>; grade?: Grade | null; seed?: number }>("POST", "/api/types-preview", { def, fields, ...opts }),
  frameHtml: (def: CardType) => call<{ html: string }>("POST", "/api/frame", { def }),

  search: (q: string, opts: { limit?: number; offset?: number; order?: string } = {}) => call<{ total: number; rows: SearchRow[] }>("GET", `/api/items${qs({ q, ...opts })}`),
  item: (id: string) => call<ItemDetail>("GET", `/api/items/${encodeURIComponent(id)}`),
  saveItem: (id: string, item: { type: string; deck: string; fields: Record<string, unknown>; tags: string[]; source?: string; notes?: string; archived?: boolean }) =>
    call<{ result: string; item: ItemDetail }>("PUT", `/api/items/${encodeURIComponent(id)}`, item),
  previewItem: (id: string, seed: number, face = "main") => call<{ view: Record<string, unknown>; key: Record<string, unknown>; seed: number }>("POST", `/api/items/${encodeURIComponent(id)}/preview`, { seed, face }),
  bulkItems: (action: string, ids: string[], extra: Record<string, unknown> = {}) => call("POST", "/api/items-bulk", { action, ids, ...extra }),
  bulkCards: (action: string, cardIds: number[]) => call("POST", "/api/cards-bulk", { action, cardIds }),

  counts: (s: Scope) => call<Counts>("GET", `/api/study/counts${qs({ deck: s.deck, q: s.q })}`),
  next: (s: Scope, exclude?: number) => call<{ card: StudyCard | null; counts: Counts }>("GET", `/api/study/next${qs({ deck: s.deck, q: s.q, exclude })}`),
  card: (cardId: number, seed?: number) => call<StudyCard>("GET", `/api/study/card/${cardId}${qs({ seed })}`),
  submit: (cardId: number, seed: number, answer: unknown, practice = false) =>
    call<{ attemptId: number; grade: Grade; key: Record<string, unknown>; wantsFeedback: boolean }>("POST", "/api/study/submit", { cardId, seed, answer, practice }),
  feedback: (attemptId: number) => call<{ feedback: string; model?: string; ms?: number }>("POST", "/api/study/feedback", { attemptId }),
  rate: (cardId: number, rating: Rating, opts: { attemptId?: number; durationMs?: number; practice?: boolean } = {}) =>
    call<{ reviewId: number; due: string; state: number }>("POST", "/api/study/rate", { cardId, rating, ...opts }),
  undo: () => call<{ cardId: number; itemId: string } | null>("POST", "/api/study/undo", {}),
  reschedule: (s: { deck?: string; query?: string }) => call<{ rescheduled: number }>("POST", "/api/reschedule", s),

  stats: (s: Scope, days = 30) => call<Stats>("GET", `/api/stats${qs({ deck: s.deck, q: s.q, days })}`),
  tags: () => call<{ tag: string; items: number; instructions: string | null; description: string | null }[]>("GET", "/api/tags"),
  saveTag: (tag: string, instructions: string, description = "") => call("PUT", "/api/tags", { tag, instructions, description }),
  renameTag: (from: string, to: string) => call("POST", "/api/tags/rename", { from, to }),
  importPack: (pack: unknown, dryRun = false) => call<any>("POST", `/api/import${dryRun ? "?dryRun=1" : ""}`, pack),
  /** The package is the request body; the flags ride in the query. */
  importAnki: (pkg: Blob, opts: { dryRun?: boolean; scheduling?: boolean; deckPrefix?: string } = {}) =>
    call<AnkiImportReport>(
      "POST",
      `/api/anki/import${qs({ dryRun: opts.dryRun ? 1 : undefined, scheduling: opts.scheduling === false ? 0 : undefined, deckPrefix: opts.deckPrefix })}`,
      undefined,
      pkg,
    ),
  exportUrl: (s: Scope) => `/api/export${qs({ deck: s.deck, q: s.q })}`,
  settings: () => call<any>("GET", "/api/settings"),
  defaults: () => call<PresetConfig>("GET", "/api/defaults"),
  testAi: () => call<any>("POST", "/api/ai/test", {}),
  saveSettings: (patch: unknown) => call<any>("PATCH", "/api/settings", patch),
  chatgptStatus: () => call<any>("GET", "/api/chatgpt/status"),
  chatgptLogin: () => call<any>("POST", "/api/chatgpt/login", {}),
  chatgptLogout: () => call<any>("POST", "/api/chatgpt/logout", {}),
  themes: () => call<{ selected: string; themes: (ThemeData & { builtin: boolean; selected: boolean })[] }>("GET", "/api/themes"),
  saveTheme: (t: ThemeData) => call<{ theme: ThemeData; removed: string[]; created: boolean }>("PUT", `/api/themes/${encodeURIComponent(t.id)}`, t),
  deleteTheme: (id: string) => call<{ deleted: string; selected: string }>("DELETE", `/api/themes/${encodeURIComponent(id)}`),
  selectTheme: (id: string) => call<ThemeData>("PUT", "/api/theme", { id }),
};

/** A theme as the server stores it (see src/core/themes.ts). */
export interface ThemeData {
  id: string;
  name: string;
  scheme: "dark" | "light";
  vars: Record<string, string>;
  css?: string;
  base?: string;
}

export const STATE_NAMES = ["New", "Learning", "Review", "Relearning"];
export const RATING_LABEL: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

/** "3m", "2h", "4d", "1.5mo" until the given date. */
export function humanInterval(toIso: string, from = new Date()): string {
  const ms = new Date(toIso).getTime() - from.getTime();
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)}d`.replace(".0d", "d");
  const mo = d / 30.4;
  if (mo < 12) return `${Math.round(mo * 10) / 10}mo`.replace(".0mo", "mo");
  return `${Math.round((d / 365) * 10) / 10}y`.replace(".0y", "y");
}

export function relative(iso: string, from = new Date()): string {
  const ms = new Date(iso).getTime() - from.getTime();
  const past = ms < 0;
  const s = humanInterval(new Date(from.getTime() + Math.abs(ms)).toISOString(), from);
  return past ? `${s} ago` : `in ${s}`;
}
