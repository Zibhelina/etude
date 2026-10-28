// Typed client for the Etude API.
import { etudeFetch } from "./transport";

export type Rating = 1 | 2 | 3 | 4;
export type Verdict = "correct" | "partial" | "incorrect" | "ungraded";

export interface Grade {
  score: number | null;
  verdict: Verdict;
  feedback?: string;
  details?: unknown;
  suggested: Rating | null;
  confidence?: number;
  /** `example`: a recorded grade shown in watch mode, not one made for this answer. */
  grader: { kind: string; model?: string; ms?: number; cost?: number; error?: string; example?: boolean };
  retry?: { hint: string };
  /** On adaptive decks: what was picked for this showing and why. */
  adaptive?: { asOf: string; skill: string; variant?: string; reason?: string; placement?: string | boolean; quickCheck?: boolean };
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
  /** A face's own daily limit for new cards, within newPerDay. `null` drops an inherited one. */
  newPerFace: Record<string, number | null>;
  reviewsPerDay: number;
  newOrder: "added" | "random" | "deck";
  reviewOrder: "due" | "retrievability" | "random";
  newMix: "mix" | "first" | "last";
  deadline?: string | null;
  deadlineMargin: number;
  autoRate: { good: number; hard: number };
  autoApply: boolean;
  burySiblings: boolean;
  /** "watch": a tour deck, shown card by card with example answers and never scheduled. */
  mode: "study" | "watch";
  /** Who decides when cards come back: "fsrs" or a scheduler id. */
  scheduler: string;
  schedulerOptions: Record<string, unknown>;
  adaptiveChallenge: boolean;
  adaptivePace: boolean;
  /** Practice aims for this share of right answers; null follows desiredRetention. */
  targetSuccess: number | null;
  minutesPerDay: number;
  newPerDayMin: number;
  newPerDayMax: number;
  levels: { tag: string; check?: string }[];
  levelAdvanceAt: number;
  levelMix: number;
  quickChecksPerDay: number;
}

export interface LevelState {
  index: number;
  tag: string;
  progress: number;
  checkPassed: boolean;
  done: boolean;
  nextOpen: boolean;
}

export type LearnerSummary =
  | { deck: string; adaptive: false }
  | {
      deck: string;
      adaptive: true;
      root: string;
      settings: { adaptiveChallenge: boolean; adaptivePace: boolean; targetSuccess: number; minutesPerDay: number; levels: { tag: string; check?: string }[] };
      skills: {
        skill: string;
        answers: number;
        success: number | null;
        ability: number | null;
        typical: number | null;
        level: LevelState | null;
        placement: { probes: number; done: boolean; frontier: string; revised: boolean; checks: { done: number; passed: number } } | null;
      }[];
      known: { items: number; assumed: number };
      pace: { value: number; base: number; youngRetention: number | null; minutesPerDay: number | null; reason: string } | null;
    };

export interface SchedulerOption {
  name: string;
  kind: "number" | "boolean" | "text";
  label?: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  suffix?: string;
}

/** A deck with its settings resolved, and the card types in it that pick their own scheduler. */
export type DeckDetail = DeckNode & {
  resolved: PresetConfig;
  inherited: PresetConfig;
  presetBase: PresetConfig;
  typeSchedulers: { type: string; name: string; scheduler: string; cards: number }[];
};

export interface SchedulerSummary {
  id: string;
  name: string;
  description: string;
  ratings: boolean;
  options: SchedulerOption[];
  builtin: boolean;
  script: boolean;
  decks: number;
}

export interface PracticeMetric {
  key: string;
  label: string;
  unit: string;
  better: "higher" | "lower";
  digits: number;
  first: number | null;
  last: number | null;
  best: number | null;
  mean: number | null;
  points: { at: string; value: number }[];
}

export interface PracticeCard {
  cardId: number;
  itemId: string;
  deck: string;
  type: string;
  title: string;
  scheduler: string;
  sessions: number;
  metrics: PracticeMetric[];
  days: { day: string; sessions: number }[];
}

export interface DeckNode {
  id: number;
  name: string;
  presetId: string | null;
  config: Partial<PresetConfig>;
  description: string;
  instructions: string;
  position: number | null;
  archived: boolean;
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
  mode: "study" | "watch";
}

export interface Counts {
  new: number;
  learning: number;
  learningSoon: number;
  review: number;
  doneToday: number;
  nextDue: string | null;
}

export interface WatchEntry {
  cardId: number;
  itemId: string;
  type: string;
  deck: string;
  title: string;
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
  scheduler: { id: string; name: string; ratings: boolean; next: string | null };
  grader: string;
  showVerdict: boolean;
  generated: boolean;
  title: string;
  /** Adaptive decks: when the learner estimates were taken; sent back on submit. */
  asOf?: string;
  /** The placement session this card was shown for. */
  placement?: string;
  quickCheck?: boolean;
}

export interface FieldSpec {
  name: string;
  kind: "markdown" | "text" | "number" | "boolean" | "list" | "json" | "code" | "html";
  label?: string;
  description?: string;
  required?: boolean;
  private?: boolean;
  default?: unknown;
  editor?: "choices" | "pairs" | "parts" | "occlusion";
  /** For `code` fields: the language to highlight, or `field:<name>` to read it from another field. */
  language?: string;
}

/** Cards on faces their type no longer makes, per type and face. */
export interface LeftoverReport {
  cards: number;
  reviewed: number;
  reviews: number;
  faces: { type: string; typeName: string; face: string; cards: number; reviews: number }[];
}

export interface CleanupReport {
  leftover: LeftoverReport;
  /** `files` lists the first 200. */
  media: { count: number; bytes: number; files: { path: string; bytes: number }[] };
}

export interface DeckFace {
  face: string;
  types: { id: string; name: string }[];
  cards: number;
  new: number;
}

export interface CardType {
  id: string;
  name: string;
  description?: string;
  faces?: string[];
  facesWhen?: string;
  fields: FieldSpec[];
  /** The field that names an item in lists; without it, the first public markdown field. */
  titleField?: string;
  prepare?: string;
  template: { html: string; css?: string; js?: string };
  grader: { kind: "self" } | { kind: "script"; code: string } | { kind: "ai"; vision?: boolean; instructions?: string } | { kind: "hybrid"; code: string; vision?: boolean; instructions?: string };
  instructions?: string;
  showVerdict?: boolean;
  /** Body of the script that makes watch mode's example answer. */
  demo?: string;
  /** Grader numbers worth tracking over time. */
  metrics?: { key: string; label?: string; unit?: string; better?: "higher" | "lower"; digits?: number }[];
  /** The scheduler this type's cards use when their deck doesn't pick one. */
  scheduler?: string;
  schedulerOptions?: Record<string, unknown>;
  updated?: string;
  builtin?: boolean;
  /** Files the type ships with (read-only here; packs and `etude type import` set them). */
  assetFiles?: { name: string; size: number; hash: string }[];
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
  /** Archived items using the type: hidden from its item count, but they keep it from being deleted. */
  archived: number;
  grader: string;
  /** Folder path in the Types page ("A::B"), "" when the type isn't in a folder. */
  folder: string;
  /** Asset files the type ships with. */
  assetFiles: { name: string; size: number }[];
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

export interface ItemEditProposal {
  itemId: string;
  fields: Record<string, unknown>;
  changed: string[];
  model: string;
  ms: number;
  cost?: number;
}

export interface StoredMedia {
  name: string;
  file: string;
  path: string;
  url: string;
  mime: string;
  kind: "image" | "audio" | "video";
  bytes: number;
  created: boolean;
  dryRun: boolean;
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
  /** `reviews` are rated answers; `runs` are a drill's unrated ones. */
  days: { day: string; reviews: number; again: number; runs: number; ms: number }[];
  forecast: { day: string; due: number }[];
  overdue: number;
  tags: { tag: string; cards: number; recall: number }[];
  /** Every tag with its ancestors; recall is over seen cards, null when none are seen. */
  tagTree: { tag: string; depth: number; direct: boolean; cards: number; seen: number; recall: number | null }[];
  today: { day: string; reviews: number; again: number; runs: number; ms: number; new: number };
  ratings: { again: number; hard: number; good: number; easy: number };
  verdicts: { correct: number; partial: number; incorrect: number; ungraded: number };
  streak: number;
  bestStreak: number;
  stability: { upTo: number | null; cards: number }[];
  recallBins: number[];
  difficulty: number[];
  curve: { days: number; recall: number }[];
  desiredRetention: number;
  hours: { hour: number; reviews: number; rated: number; passed: number }[];
  weeks: { reviews: number; reviewed: number; passed: number; ms: number; rate: number | null }[];
  window: { days: number; from: string; to: string };
  deadline: string | null;
  deadlineMargin: number;
  scheduler: string | null;
  schedulers: StatsScheduler[];
  practice: PracticeCard[];
}

/** One scheduler's cards in a Stats scope. */
export interface StatsScheduler {
  id: string;
  name: string;
  /** fsrs: memory model. rated: a script with Again/Hard/Good/Easy. drill: a script without ratings. */
  kind: "fsrs" | "rated" | "drill";
  decks: string[];
  cards: number;
  new: number;
  /** rated/fsrs: due before tomorrow. drill: ready right now. */
  due: number;
  answers: number;
  rated: number;
  passed: number;
  passRate: number | null;
  /** Cards counted by a value of the scheduler's state (its `stats.groupBy`), e.g. Leitner boxes. */
  groups: { label: string; bins: { key: string; cards: number }[]; other: number } | null;
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
  // The server takes changes only as JSON (or bytes for uploads), so a change without a body sends {}.
  const json = raw || body !== undefined || method === "GET" || method === "HEAD" ? body : {};
  const headers: Record<string, string> = {};
  if (raw) headers["Content-Type"] = "application/octet-stream";
  else if (json !== undefined) headers["Content-Type"] = "application/json";
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await etudeFetch(path, {
    method,
    headers,
    body: raw ?? (json !== undefined ? JSON.stringify(json) : undefined),
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
  /** Study ahead: nothing has to be due. */
  ahead?: boolean;
  /** Placement on an adaptive deck, by session: only probes that find the learner's level. */
  placement?: string;
}

export interface OptimizeResult {
  source: { kind: "preset"; id: string } | { kind: "deck"; name: string };
  decks: string[];
  cards: number;
  reviews: number;
  items: number;
  current: number[] | null;
  weights: number[];
  before: { logLoss: number; rmse: number };
  after: { logLoss: number; rmse: number };
  better: boolean;
  applied: boolean;
}

export const api = {
  uploadMedia: (file: File) => call<StoredMedia>("POST", `/api/media${qs({ name: file.name })}`, undefined, file),
  importMedia: (path: string) => call<StoredMedia>("POST", "/api/media/import", { path }),
  decks: (archived = false) => call<DeckNode[]>("GET", `/api/decks${qs({ archived: archived ? 1 : undefined })}`),
  deckUsage: (name: string) => call<{ items: number; cards: number }>("GET", `/api/deck/usage${qs({ name })}`),
  setDeckArchived: (name: string, archived: boolean) => call<{ decks: string[]; archived: boolean }>("POST", `/api/deck/archive${qs({ name })}`, { archived, subdecks: true }),
  deck: (name: string) => call<DeckDetail>("GET", `/api/deck${qs({ name })}`),
  /** The faces of the cards in a deck and its subdecks, with the types that make each and how many are new. */
  deckFaces: (name: string) => call<DeckFace[]>("GET", `/api/deck/faces${qs({ name })}`),
  createDeck: (name: string) => call("POST", "/api/decks", { name }),
  reorderDecks: (parent: string, order: string[]) => call<{ order: string[] }>("POST", "/api/decks/order", { parent, order }),
  moveDeck: (name: string, parent: string, index?: number) => call<DeckNode>("POST", "/api/decks/move", { name, parent, index }),
  updateDeck: (name: string, patch: Partial<{ name: string; presetId: string | null; config: Partial<PresetConfig>; description: string; instructions: string; archived: boolean }>) =>
    call<DeckNode & { resolved: PresetConfig }>("PATCH", `/api/deck${qs({ name })}`, patch),
  // Mutations must be JSON (the server refuses anything else), so body-less deletes send {}.
  deleteDeck: (name: string, items = false) => call("DELETE", `/api/deck${qs({ name })}`, { items }),
  presets: () => call<{ id: string; name: string; config: Partial<PresetConfig> }[]>("GET", "/api/presets"),
  savePreset: (id: string, name: string, config: Partial<PresetConfig>) => call<Preset>("PUT", `/api/presets/${encodeURIComponent(id)}`, { name, config }),
  deletePreset: (id: string) => call<{ ok: true }>("DELETE", `/api/presets/${encodeURIComponent(id)}`, {}),

  types: () => call<TypeSummary[]>("GET", "/api/types"),
  type: (id: string) => call<CardType>("GET", `/api/types/${encodeURIComponent(id)}`),
  /** `leftover`: cards on faces the saved type no longer makes (null when the definition didn't change). */
  saveType: (def: CardType) => call<CardType & { leftover: { cards: number; reviews: number } | null }>("PUT", `/api/types/${encodeURIComponent(def.id)}`, def),
  typeLeftover: (id: string) => call<LeftoverReport>("GET", `/api/types/${encodeURIComponent(id)}/leftover`),
  cleanup: () => call<CleanupReport>("GET", "/api/cleanup"),
  deleteLeftoverCards: (only: { type?: string; face?: string } = {}) => call<{ cards: number; reviews: number }>("POST", "/api/cleanup/cards", only),
  deleteUnusedMedia: () => call<{ files: number; bytes: number }>("POST", "/api/cleanup/media", {}),
  /** `items`: also delete the items using the type (archived ones too), with their cards and history. */
  deleteType: (id: string, opts: { items?: boolean } = {}) => call<{ ok: true; items: number; cards: number; reviews: number }>("DELETE", `/api/types/${encodeURIComponent(id)}`, opts),
  typeUsage: (id: string) => call<{ items: number; archived: number; cards: number; reviews: number }>("GET", `/api/types/${encodeURIComponent(id)}/usage`),
  typeFolders: () => call<string[]>("GET", "/api/type-folders"),
  createTypeFolder: (path: string) => call<{ path: string }>("POST", "/api/type-folders", { path }),
  renameTypeFolder: (from: string, to: string) => call<{ from: string; to: string }>("POST", "/api/type-folders/rename", { from, to }),
  deleteTypeFolder: (path: string) => call<{ deleted: string; moved: string[] }>("POST", "/api/type-folders/delete", { path }),
  moveType: (id: string, folder: string) => call<{ id: string; folder: string }>("POST", `/api/types/${encodeURIComponent(id)}/move`, { folder }),
  resetType: (id: string) => call<CardType>("POST", `/api/types/${encodeURIComponent(id)}/reset`, {}),
  previewType: (def: CardType, fields: Record<string, unknown>, opts: { seed?: number; face?: string; answer?: unknown } = {}) =>
    call<{ errors: string[]; view?: Record<string, unknown>; key?: Record<string, unknown>; grade?: Grade | null; seed?: number }>("POST", "/api/types-preview", { def, fields, ...opts }),
  frameHtml: (def: CardType) => call<{ html: string }>("POST", "/api/frame", { def }),
  frameDoc: (html: string) => call<{ url: string }>("POST", "/api/frame-doc", { html }),

  search: (q: string, opts: { limit?: number; offset?: number; order?: string } = {}) => call<{ total: number; rows: SearchRow[] }>("GET", `/api/items${qs({ q, ...opts })}`),
  item: (id: string) => call<ItemDetail>("GET", `/api/items/${encodeURIComponent(id)}`),
  saveItem: (id: string, item: { type: string; deck: string; fields: Record<string, unknown>; tags: string[]; source?: string; notes?: string; archived?: boolean }) =>
    call<{ result: string; item: ItemDetail }>("PUT", `/api/items/${encodeURIComponent(id)}`, item),
  suggestItemEdit: (id: string, instruction: string, fields: Record<string, unknown>) => call<ItemEditProposal>("POST", `/api/items/${encodeURIComponent(id)}/ai-edit`, { instruction, fields }),
  previewItem: (id: string, seed: number, face = "main") => call<{ view: Record<string, unknown>; key: Record<string, unknown>; seed: number }>("POST", `/api/items/${encodeURIComponent(id)}/preview`, { seed, face }),
  bulkItems: (action: string, ids: string[], extra: Record<string, unknown> = {}) => call("POST", "/api/items-bulk", { action, ids, ...extra }),
  bulkCards: (action: string, cardIds: number[]) => call("POST", "/api/cards-bulk", { action, cardIds }),
  /** Buries cards or whole notes; returns only newly buried ids so Undo preserves existing burials. */
  buryCards: (cardIds: number[], note: boolean) => call<{ count: number; cardIds: number[] }>("POST", "/api/cards-bulk", { action: note ? "bury-note" : "bury", cardIds }),
  suspendCards: (cardIds: number[], note: boolean) => call<{ count: number; cardIds: number[] }>("POST", "/api/cards-bulk", { action: note ? "suspend-note" : "suspend", cardIds }),

  counts: (s: Scope) => call<Counts>("GET", `/api/study/counts${qs({ deck: s.deck, q: s.q, ahead: s.ahead ? 1 : undefined })}`),
  next: (s: Scope, exclude?: number) =>
    call<{ card: StudyCard | null; counts: Counts }>("GET", `/api/study/next${qs({ deck: s.deck, q: s.q, ahead: s.ahead ? 1 : undefined, placement: s.placement || undefined, exclude })}`),
  card: (cardId: number, seed?: number) => call<StudyCard>("GET", `/api/study/card/${cardId}${qs({ seed })}`),
  submit: (card: Pick<StudyCard, "cardId" | "seed" | "asOf" | "placement">, answer: unknown, practice = false) =>
    call<{ attemptId: number | null; grade: Grade; key: Record<string, unknown>; wantsFeedback: boolean; retry: { hint: string; view: Record<string, unknown> } | null }>("POST", "/api/study/submit", {
      cardId: card.cardId,
      seed: card.seed,
      answer,
      practice,
      asOf: card.asOf,
      placement: card.placement,
    }),
  feedback: (attemptId: number) => call<{ feedback: string; model?: string; ms?: number }>("POST", "/api/study/feedback", { attemptId }),
  rate: (cardId: number, rating: Rating | 0, opts: { attemptId?: number; durationMs?: number; practice?: boolean } = {}) =>
    call<{ reviewId: number; due: string; state: number }>("POST", "/api/study/rate", { cardId, rating, ...opts }),
  watchList: (s: Scope) => call<{ cards: WatchEntry[] }>("GET", `/api/watch/list${qs({ deck: s.deck, q: s.q })}`),
  watchCard: (cardId: number, seed?: number) => call<{ card: StudyCard; demo: { answer: unknown; grade: Grade | null } }>("GET", `/api/watch/card/${cardId}${qs({ seed })}`),
  watchGrade: (cardId: number, seed: number, answer: unknown) => call<{ grade: Grade; key: Record<string, unknown> }>("POST", "/api/watch/grade", { cardId, seed, answer }),
  undo: () => call<{ cardId: number; itemId: string } | null>("POST", "/api/study/undo", {}),
  reschedule: (s: { deck?: string; query?: string }) => call<{ rescheduled: number }>("POST", "/api/reschedule", s),
  optimizeWeights: (deck: string) => call<OptimizeResult>("POST", "/api/optimize", { deck }),

  stats: (s: Scope, days = 30) => call<Stats>("GET", `/api/stats${qs({ deck: s.deck, q: s.q, days })}`),
  skills: (deck: string) => call<LearnerSummary>("GET", `/api/stats/skills${qs({ deck })}`),
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
  schedulers: () => call<SchedulerSummary[]>("GET", "/api/schedulers"),
  testAi: () => call<any>("POST", "/api/ai/test", {}),
  saveSettings: (patch: unknown) => call<any>("PATCH", "/api/settings", patch),
  chatgptStatus: () => call<any>("GET", "/api/chatgpt/status"),
  chatgptLogin: () => call<any>("POST", "/api/chatgpt/login", {}),
  chatgptLogout: () => call<any>("POST", "/api/chatgpt/logout", {}),
  themes: () => call<{ selected: string; themes: (ThemeData & { builtin: boolean; selected: boolean })[] }>("GET", "/api/themes"),
  saveTheme: (t: ThemeData) => call<{ theme: ThemeData; removed: string[]; created: boolean }>("PUT", `/api/themes/${encodeURIComponent(t.id)}`, t),
  deleteTheme: (id: string) => call<{ deleted: string; selected: string }>("DELETE", `/api/themes/${encodeURIComponent(id)}`),
  selectTheme: (id: string) => call<ThemeData>("PUT", "/api/theme", { id }),

  updateStatus: (check = false, force = false) => call<UpdateStatus>("GET", `/api/update${qs({ check: check ? 1 : undefined, force: force ? 1 : undefined })}`),
  applyUpdate: () => call<{ result: "updated" | "current"; from: string; to: string; commits: UpdateCommit[]; restarting: boolean }>("POST", "/api/update", {}),

  market: (refresh = false) => call<MarketListing>("GET", `/api/market${refresh ? "?refresh=1" : ""}`),
  marketEntry: (kind: MarketKind, id: string) => call<MarketFile>("GET", `/api/market/entry/${kind}/${encodeURIComponent(id)}`),
  marketInstall: (id: string, kind: MarketKind, opts: { use?: boolean; dryRun?: boolean } = {}) =>
    call<{ entry: MarketMeta; result: "created" | "updated" | "unchanged"; ids: string[]; report: any }>("POST", "/api/market/install", { id, kind, ...opts }),
  /** An <img> can't send the bearer token, so it rides in the query. */
  marketCoverUrl: (kind: MarketKind, id: string) => `/api/market/cover/${kind}/${encodeURIComponent(id)}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`,
  marketForget: (id: string) => call<{ forgot: boolean }>("POST", "/api/market/forget", { id }),
  publishStatus: () => call<{ ok: boolean; login?: string; reason?: string; repo: string }>("GET", "/api/market/publish/status"),
  publish: (input: PublishInput & { dryRun?: boolean; full?: boolean }) => call<PublishResult>("POST", "/api/market/publish", input),
};

export interface UpdateCommit {
  sha: string;
  subject: string;
  date: string;
}

export type UpdateStatus = { canRestart: boolean; checked: string | null; checkError?: string; version: string } & (
  | { kind: "git"; branch: string | null; upstream: string | null; commit: string; incoming: UpdateCommit[]; behind: number; ahead: number; dirty: string[]; blocked?: string }
  | { kind: "package"; latest: string | null; url: string }
);

export type MarketKind = "theme" | "deck" | "type";

export interface MarketMeta {
  id: string;
  kind: MarketKind;
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  updated: string;
}

export type MarketSummary =
  | { theme: ThemeData }
  | { decks: string[]; items: number; cardTypes: Record<string, number>; types: { id: string; name: string }[]; watch: boolean; samples: string[] }
  | { types: { id: string; name: string; description: string; grader: string; fields: string[] }[]; items: number; samples: string[] };

export interface MarketEntry extends MarketMeta {
  path: string;
  bytes: number;
  cover?: string;
  summary: MarketSummary;
  installed: "installed" | "update" | null;
  /** What the install put in this collection (theme id, decks, type ids). */
  installedIds: string[];
}

export interface MarketListing {
  url: string;
  repo: string;
  generated: string;
  selectedTheme: string;
  entries: MarketEntry[];
}

export interface MarketFile extends MarketMeta {
  etudeMarket: 1;
  content: any;
}

export interface PublishInput {
  kind: MarketKind;
  ref: string;
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  tags?: string[];
  version?: string;
  examples?: number;
}

export interface PublishResult {
  dryRun?: boolean;
  url?: string;
  number?: number;
  fork?: string | null;
  updated?: boolean;
  path: string;
  bytes: number;
  repo: string;
  manualUrl: string;
  entry: MarketMeta;
  summary: MarketSummary;
  file?: MarketFile;
}

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
