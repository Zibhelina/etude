// Typed client for the Etude API.
import { apiToken, etudeFetch } from "./transport";
import type { NoteShare } from "./share";

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
  /** Own deck home ("queue" default, "catalog", `{ type }`, or custom template). Never inherited from parent decks. */
  home?: DeckHomeSpec;
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
  prerequisites: boolean;
  masteryStreak: number;
  masteryShare: number;
  conceptsInProgress: number;
  implicitReviews: boolean;
}

export interface ConceptRow {
  concept: string;
  depth: number;
  needs: string[];
  cards: number;
  mastered: number;
  inProgress: boolean;
  state: "mastered" | "in-progress" | "unlocked" | "locked";
  missing: string[];
}

export interface ConceptMap {
  deck: string;
  prerequisites: boolean;
  concepts: ConceptRow[];
  cycles: string[][];
  danglingNeeds: string[];
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

export type DeckHomeSpec = "queue" | "catalog" | { type: string } | { html: string; css?: string; js?: string };

export interface DeckHomeSubdeck {
  name: string;
  title: string;
  icon: string | null;
  description: string;
  home: "queue" | "catalog" | "custom";
  mode: "study" | "watch";
  cards: number;
  unseen: number;
  new: number;
  learning: number;
  review: number;
  doneToday: number;
}

export interface DeckHomeData {
  deck: {
    name: string;
    title: string;
    parent: string | null;
    description: string;
    icon: string | null;
    mode: "study" | "watch";
    home: "queue" | "catalog" | "custom";
    homeSource: "deck" | "type" | "default";
    typeId: string | null;
  };
  subdecks: DeckHomeSubdeck[];
  cards: {
    cardId: number;
    itemId: string;
    face: string;
    type: string;
    title: string;
    fields: Record<string, unknown>;
    tags: string[];
    state: number;
    due: string;
    reps: number;
    lapses: number;
    lastReview: string | null;
    progress: unknown;
    suspended: boolean;
    buried: boolean;
  }[];
  stats: {
    totalCards: number;
    dueCount: number;
    newCount: number;
    learningCount: number;
    reviewCount: number;
    doneToday: number;
    totalReps: number;
  };
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
  home?: "queue" | "catalog" | "custom";
  /** `art:<id>`, `emoji:<emoji>` or null. */
  icon: string | null;
}

/** An archived deck with its subdecks folded in (GET /api/decks/archive). */
export interface ArchivedDeck {
  id: number;
  name: string;
  icon: string | null;
  cards: number;
  studied: number;
  recall: number | null;
  lastReview: string | null;
  due: number;
  subdecks: { name: string; cards: number }[];
  curve: { days: number; recall: number }[];
}

export interface Counts {
  new: number;
  learning: number;
  learningSoon: number;
  review: number;
  doneToday: number;
  nextDue: string | null;
  /** New cards waiting for a needed concept (prerequisites on). */
  locked?: number;
  /** Due reviews left out because a dependent card's right answer exercised them. */
  credited?: number;
  /** The unmet concepts holding back the most locked cards. */
  unlockWith?: string[];
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
  /** The card fills one screen, like a game (the type's `fitScreen`): study shows it in focus mode. */
  fitScreen?: boolean;
  generated: boolean;
  title: string;
  /** Adaptive decks: when the learner estimates were taken; sent back on submit. */
  asOf?: string;
  /** The placement session this card was shown for. */
  placement?: string;
  quickCheck?: boolean;
  /** Scheduler-computed progress (`cards.sched_state`), replayed from its attempt log. */
  progress?: unknown;
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
  /** The card fills one screen, like a game: study shows it in focus mode. */
  fitScreen?: boolean;
  /** Faces whose new card comes first: the item's other new cards wait for it. */
  leadFaces?: string[];
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
  /** The cards each item makes (["main"] for one). */
  faces: string[];
  /** The type's own scheduler (e.g. "drill"), null for the deck's. */
  scheduler: string | null;
  /** false: the card shows its own result, without Correct / Not quite. */
  showVerdict: boolean;
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
  /** Days between reviews, for cards in review; null while new or learning. */
  interval: number | null;
  /** When the item was last edited. */
  updated: string;
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
  kind: "image" | "audio" | "video" | "document";
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
  /** Each deck's own cards (not its subdecks): FSRS states, recall over seen cards, due before tomorrow, script-scheduled cards. */
  decks?: StatsDeck[];
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

export interface StatsDeck {
  deck: string;
  cards: number;
  new: number;
  learning: number;
  review: number;
  mature: number;
  seen: number;
  recall: number | null;
  due: number;
  scripted: number;
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

/** A change to the Notebook or the app around it, asked from outside (`etude view`, an agent over MCP). Same shapes as src/core/view-remote.ts. */
export type ViewTarget = { pane: number } | { note: string } | { chat: true } | { panel: true };
type ViewSide = "left" | "right" | "top" | "bottom";
export type ViewCommand =
  | { action: "open"; note?: string; where: ViewSide | "tab" | "replace"; beside?: ViewTarget; before?: string | null }
  | { action: "close"; target: ViewTarget }
  | { action: "close-others"; tab: string }
  | { action: "focus"; target: ViewTarget }
  | { action: "pin"; tab: string; on: boolean }
  | { action: "icon"; tab: string; icon: string | null }
  | { action: "move"; tab: string; to: ViewTarget; before?: string | null; side?: ViewSide }
  | { action: "group"; tabs: string[]; group?: string; name?: string; color?: string }
  | { action: "group-edit"; group: string; name?: string; color?: string; collapsed?: boolean }
  | { action: "ungroup"; group?: string; tab?: string }
  | { action: "group-close"; group: string }
  | { action: "group-move"; group: string; to: ViewTarget; before?: string | null }
  | { action: "resize"; target: ViewTarget; size: number }
  | { action: "zoom"; target: ViewTarget; zoom: "in" | "out" | "reset" | number }
  | { action: "sidebar"; mode: "open" | "rail" | "none" }
  | { action: "pages"; open: boolean }
  | { action: "panel"; open: boolean }
  | { action: "go"; route: string };
export type ViewShell = { sidebar: "open" | "rail" | "none"; pages: boolean; panel: boolean };

async function call<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  // The server takes changes only as JSON (or bytes for uploads), so a change without a body sends {}.
  const json = raw || body !== undefined || method === "GET" || method === "HEAD" ? body : {};
  const headers: Record<string, string> = {};
  if (raw) headers["Content-Type"] = "application/octet-stream";
  else if (json !== undefined) headers["Content-Type"] = "application/json";
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

/** Activity (src/core/activity.ts): counts per hour and note id or screen; never text. */
export type ActivityKind = "page" | "file" | "pdf" | "canvas" | "kanban" | "web" | "chat" | "screen";
export interface ActivityEntry { kind: ActivityKind; ref: string; hour: number; ms: number; typed: number; pasted: number; deleted: number; words: number }
export interface ActivityStatus { on: boolean; keepDays: number; rows: number; since: string | null }
export interface ActivitySummary {
  on: boolean;
  keepDays: number;
  today: string;
  days: { day: string; ms: number; typed: number; words: number; pasted: number }[];
  totals: { ms: number; typed: number; pasted: number; deleted: number; words: number };
  kinds: { kind: ActivityKind; ms: number; typed: number; words: number }[];
  screens: { screen: string; ms: number }[];
  hours: { hour: number; ms: number; typed: number }[];
  top: { kind: ActivityKind; ref: string; title: string; path?: string; missing?: boolean; ms: number; typed: number; words: number; pasted: number; last: string }[];
}

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

/** Notes (beta): a page in the notes tree. */
/** A canvas's drawing: Excalidraw's elements, with pictures named by their media file. */
export interface CanvasScene {
  type: "excalidraw";
  version: 2;
  elements: Record<string, any>[];
  appState: { viewBackgroundColor?: string; gridSize?: number | null; gridModeEnabled?: boolean };
  files: Record<string, { mimeType: string; media: string; created?: number }>;
}
/** A canvas's drawing: Excalidraw's elements, with pictures named by their media file. */
export interface CanvasScene {
  type: "excalidraw";
  version: 2;
  elements: Record<string, any>[];
  appState: { viewBackgroundColor?: string; gridSize?: number | null; gridModeEnabled?: boolean };
  files: Record<string, { mimeType: string; media: string; created?: number }>;
}
export interface NoteSummary {
  /** A page you write in, a canvas you draw on, or a folder of pages. */
  id: string;
  /** A folder only holds pages; it has no body of its own. */
  kind?: "page" | "folder" | "canvas" | "pdf" | "file" | "web" | "kanban";
  parentId: string | null;
  title: string;
  icon: string | null;
  look: NoteLook;
  position: number;
  archived: boolean;
  created: string;
  updated: string;
  children: number;
  empty?: boolean;
  /** When it was pinned to the start page (null: not pinned). */
  pinned?: string | null;
  /** When the app last opened it (null: never). */
  opened?: string | null;
  /** Set for every note inside a shared folder or page. */
  share?: NoteShare;
  /** Set when it's a file or folder on this computer, in a folder open in the Notebook (its id starts "fs:"). */
  local?: LocalInfo;
}
/** Where a note that is a file on disk lives. Same shape as src/core/folders.ts. */
export interface LocalInfo {
  folder: string;
  /** Its path inside the open folder, with forward slashes ("" for the folder itself). */
  path: string;
  /** Its name on disk (a Markdown file's title leaves the extension out). */
  name: string;
  type: "dir" | "markdown" | "etude" | "web" | "text" | "pdf" | "image" | "audio" | "video" | "other";
  size: number;
  /** On the open folder's own row. */
  root?: { path: string; missing: boolean; /** Names that start with a dot show. */ hidden?: boolean };
  /** Text that can only be read here: too big to edit, or not UTF-8. */
  locked?: "large" | "encoding";
  /** A .etude file that couldn't be read as a page (why); it opens as its text. */
  broken?: string;
  /** A .etude file's own title, when the user gave it one (its name on disk is apart). Only on a note that was read whole. */
  pageTitle?: string;
  /** Sync carries it to the other devices: "root" on the folder that was marked, "inside" on what's in it. */
  synced?: "root" | "inside";
  /** On a folder: what's in it was put in an order by hand (it lists by name otherwise). */
  arranged?: true;
}
/** A folder Sync carries to the other devices, file by file. */
export interface SyncedFolder { syncId: string; name: string; home: string; created: string; files: number; bytes: number }
/** A synced folder that has a place on this computer. */
export interface FolderLink extends SyncedFolder { id: string; path: string; isHome: boolean; missing: boolean; paused: string | null }
/** A folder on this computer that the Notebook shows. */
export interface LocalFolder { id: string; name: string; path: string; trash: string; hidden: boolean; created: string; missing: boolean; elsewhere: boolean }
export interface FolderStamps { roots: string; dirs: Record<string, string>; /** Changes when a folder's own order does. */ order?: string; /** The synced folders here, as ids. */ synced?: string; /** Removals Sync is holding back, with why. */ held?: { syncId: string; name: string; why: string }[] }
/** True for the id of a file or folder on this computer. */
export const isFsId = (id: string | null | undefined): id is string => !!id && id.startsWith("fs:");
/** What a start-page card shows: a page's first blocks or a file's first lines (canvases and PDFs draw themselves). */
export interface NotePreview { id: string; kind: NonNullable<NoteSummary["kind"]>; blocks: NoteDoc[]; head: string | null }
export interface NoteLook {
  cover?: { kind: "preset"; id: string } | { kind: "image"; media: string; y: number };
  width?: "normal" | "wide" | "full";
  font?: "sans" | "serif" | "mono";
  size?: "small" | "normal" | "large";
  /** Show the icon in the sidebar list (off by default, like Obsidian). */
  showIcon?: boolean;
}
export interface NoteDoc { type: string; attrs?: Record<string, unknown>; content?: NoteDoc[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }
/** Notes as a graph: pages (and ghosts for links to pages that don't exist yet) and the lines between them. */
export interface NoteGraph {
  nodes: { id: string; kind: "page" | "folder" | "canvas" | "pdf" | "file" | "web" | "kanban" | "ghost"; title: string; icon: string | null; parentId: string | null; links: number; created: string | null; tags: string[] }[];
  links: { from: string; to: string; kind: "link" | "parent" }[];
}
export interface Note extends NoteSummary { /** A file on this computer: where its bytes are served from. */ src?: string | null; doc: NoteDoc; text: string; scene: CanvasScene | null; /** A PDF note's file in the media (files/<sha>.pdf). */ file: string | null; content: string | null; /** A kanban board's columns and cards. */ board?: KanbanBoard | null }
export type KanbanColor = "grey" | "red" | "orange" | "gold" | "green" | "teal" | "blue" | "purple" | "pink";
export const KANBAN_COLORS: KanbanColor[] = ["grey", "red", "orange", "gold", "green", "teal", "blue", "purple", "pink"];
export interface KanbanLabel { id: string; name: string; color: KanbanColor }
export interface KanbanColumn { id: string; name: string; color: KanbanColor; limit: number | null; done: boolean; cards: string[] }
export interface KanbanCard { id: string; title: string; labels: string[]; due: string | null; cover: KanbanColor | null; doc: NoteDoc; created: string; updated: string }
export interface KanbanBoard { type: "kanban"; version: 1; columns: KanbanColumn[]; cards: Record<string, KanbanCard>; labels: KanbanLabel[]; archived: string[] }

/** The catalog index the Market last read (its `generated` time), for the cover URLs. */
let marketRev = "";

export const api = {
  notes: (archived = false) => call<NoteSummary[]>("GET", `/api/notes${qs({ archived: archived ? 1 : undefined })}`),
  viewCommands: (after?: number) => call<{ seq: number; commands: (ViewCommand & { seq: number })[]; owner?: string | null }>("GET", `/api/view/commands${qs({ after })}`),
  /** This window was used last, of all the windows on every computer showing this collection. */
  viewOwner: (who: string) => call<{ owner: string }>("PUT", "/api/view/owner", { who }),
  viewState: (state: { route: string; panes: unknown[]; applied?: number; shell?: ViewShell; failed?: { seq: number; error: string } }) => call<{ ok: true }>("PUT", "/api/view/state", state),
  note: (id: string) => call<Note>("GET", `/api/notes/${encodeURIComponent(id)}`),
  searchNotes: (q: string, limit = 20) => call<(NoteSummary & { snippet: string })[]>("GET", `/api/notes/search${qs({ q, limit })}`),
  createNote: (input: { /** In a folder on this computer: a name already taken gets a number instead of an error. */ unique?: boolean; title?: string; parentId?: string | null; doc?: NoteDoc; icon?: string | null; after?: string | null; kind?: "page" | "folder" | "canvas" | "pdf" | "file" | "web" | "kanban"; scene?: CanvasScene; file?: string; content?: string; board?: KanbanBoard; template?: "basic" | "week" | "empty" }) => call<Note>("POST", "/api/notes", input),
  /** With `base` (the `updated` it last read), a body change refuses with 409 when the page was saved somewhere else since. */
  updateNote: (id: string, patch: { title?: string; pageTitle?: string | null; doc?: NoteDoc; icon?: string | null; look?: NoteLook; kind?: "page" | "folder"; scene?: CanvasScene; content?: string; board?: KanbanBoard; base?: string }) => call<Note>("PATCH", `/api/notes/${encodeURIComponent(id)}`, patch),
  noteStamp: (id: string) => call<{ updated: string }>("GET", `/api/notes/${encodeURIComponent(id)}/stamp`),
  /** The web app build the server hands out now (its entry script), to notice a new one. */
  notesTreeStamp: () => call<{ stamp: string }>("GET", "/api/notes/tree-stamp"),
  appBuild: () => call<{ entry: string | null }>("GET", "/api/app-build"),
  /** Opens a portal to a web file or canvas in a page (at the end, or before top-level block `at`). */
  addPortal: (pageId: string, note: string, opts: { at?: number; height?: number } = {}) => call<Note>("POST", `/api/notes/${encodeURIComponent(pageId)}/portal`, { note, ...opts }),
  /** A .excalidraw file (its text) as a new canvas. */
  importExcalidraw: (data: string, title: string, parentId: string | null = null) => call<Note>("POST", "/api/notes/import-excalidraw", { data, title, parentId }),
  moveNote: (id: string, parentId: string | null, index?: number) => call<Note>("POST", `/api/notes/${encodeURIComponent(id)}/move`, { parentId, index }),
  setNoteArchived: (id: string, archived: boolean) => call<{ ids: string[]; archived: boolean; /** A file on this computer: where it went in its folder's trash. */ trashed?: string }>("POST", `/api/notes/${encodeURIComponent(id)}/archive`, { archived }),
  noteGraph: () => call<NoteGraph>("GET", "/api/notes/graph"),
  noteBacklinks: (id: string) => call<(NoteSummary & { snippet: string })[]>("GET", `/api/notes/${encodeURIComponent(id)}/backlinks`),
  importNotes: (files: { path: string; text: string }[], media: Record<string, string>, parentId: string | null = null, pdfs: { path: string; file: string }[] = []) =>
    call<{ pages: number; folders: number; files?: number; links: number; unresolved: number; pdfs: number; root: string | null; ids: string[] }>("POST", "/api/notes/import", { files, media, parentId, pdfs }),
  noteExportUrl: (id: string, format: "md" | "html") => `/api/notes/${encodeURIComponent(id)}/export?format=${format}`,
  pinNote: (id: string, pinned: boolean) => call<NoteSummary>("POST", `/api/notes/${encodeURIComponent(id)}/pin`, { pinned }),
  noteOpened: (id: string) => call<NoteSummary>("POST", `/api/notes/${encodeURIComponent(id)}/opened`),
  /** What's pinned and what was opened last: the collection's notes and the files of folders on this computer. */
  pinnedNotes: () => call<NoteSummary[]>("GET", "/api/notes/pinned"),
  recentNotes: (limit = 10) => call<NoteSummary[]>("GET", `/api/notes/recent${qs({ limit })}`),
  notePreviews: (ids: string[]) => call<NotePreview[]>("GET", `/api/notes/previews${qs({ ids: ids.join(",") })}`),
  notesTutorial: (ifNew = false) => call<{ added: boolean; reason?: "seen" | "exists"; root: string | null; start: string | null; notes: number; items: number }>("POST", "/api/notes/tutorial", { ifNew }),
  deleteNote: (id: string) => call<{ ids: string[] }>("DELETE", `/api/notes/${encodeURIComponent(id)}`),
  // Folders on this computer, open in the Notebook (the desktop app and `etude serve`).
  folders: () => call<{ available: boolean; folders: LocalFolder[] }>("GET", "/api/folders"),
  openFolder: (path: string, opts: { name?: string; trash?: string; hidden?: boolean } = {}) => call<LocalFolder>("POST", "/api/folders", { path, ...opts }),
  editFolder: (id: string, patch: { name?: string; trash?: string; hidden?: boolean }) => call<LocalFolder>("PATCH", `/api/folders/${encodeURIComponent(id)}`, patch),
  closeFolder: (id: string) => call<LocalFolder>("DELETE", `/api/folders/${encodeURIComponent(id)}`),
  /** The open folders' rows, and what's right inside each of `dirs` (null for one that's gone). */
  folderEntries: (dirs: string[]) => call<{ available: boolean; roots: NoteSummary[]; dirs: Record<string, NoteSummary[] | null>; stamps: FolderStamps }>("POST", "/api/folders/entries", { dirs }),
  folderStamps: (dirs: string[]) => call<FolderStamps>("POST", "/api/folders/stamps", { dirs }),
  /** Files and folders on this computer, each into its folder and at its place there (`index` counts without the ones being placed). */
  /** Notes of the collection into a folder on this computer, as files (they go to the Archive). */
  takeNotes: (ids: string[], parentId: string) => call<{ moved: { id: string; title: string; kind: string; file: string }[] }>("POST", "/api/folders/take", { ids, parentId }),
  /** Files of a folder on this computer into the collection, as notes (the files go to their folder's trash). */
  bringFiles: (ids: string[], parentId: string | null, index?: number) =>
    call<{ moved: { file: string; id: string; title: string; kind: string }[]; trashed: { file: string; trashed: string }[] }>("POST", "/api/folders/bring", { ids, parentId, index }),
  placeFiles: (items: { id: string; parentId: string; index?: number }[]) => call<{ from: string; id: string }[]>("POST", "/api/folders/place", { items }),
  /** A folder's files back in the order of their names. */
  sortFolder: (id: string) => call<NoteSummary>("POST", "/api/folders/sort", { id }),
  /** The folders Sync carries: the ones with a place on this computer, and the ones other devices carry that aren't here yet. */
  folderSync: () => call<{ available: boolean; configured: boolean; here: FolderLink[]; elsewhere: SyncedFolder[] }>("GET", "/api/folders/sync"),
  /** What marking a folder would send. */
  folderSyncEstimate: (id: string) => call<{ id: string; path: string; files: number; bytes: number; tooBig: number }>("POST", "/api/folders/sync", { id, estimate: true }),
  folderSyncOn: (id: string) => call<FolderLink>("POST", "/api/folders/sync", { id }),
  /** Gives a folder another device carries a place on this computer. */
  folderSyncLink: (syncId: string, path: string) => call<FolderLink>("POST", "/api/folders/sync/link", { syncId, path }),
  folderSyncOff: (id: string, everywhere = false) => call<{ syncId: string; name: string; everywhere: boolean; path: string | null }>("POST", "/api/folders/sync/off", { id, everywhere }),
  /** Lets through the removals Sync held back. */
  folderSyncGo: (syncId: string) => call<FolderLink>("POST", "/api/folders/sync/go", { syncId }),
  resolveFolderLink: (from: string, target: string) => call<{ id: string | null }>("GET", `/api/folders/resolve${qs({ from, target })}`),
  restoreFromTrash: (id: string, trashed: string) => call<NoteSummary>("POST", "/api/folders/restore", { id, trashed }),
  uploadMedia: (file: File) => call<StoredMedia>("POST", `/api/media${qs({ name: file.name })}`, undefined, file),
  importMedia: (path: string) => call<StoredMedia>("POST", "/api/media/import", { path }),
  decks: (archived = false) => call<DeckNode[]>("GET", `/api/decks${qs({ archived: archived ? 1 : undefined })}`),
  archive: () => call<ArchivedDeck[]>("GET", "/api/decks/archive"),
  deckUsage: (name: string) => call<{ items: number; cards: number }>("GET", `/api/deck/usage${qs({ name })}`),
  setDeckArchived: (name: string, archived: boolean) => call<{ decks: string[]; archived: boolean }>("POST", `/api/deck/archive${qs({ name })}`, { archived, subdecks: true }),
  deck: (name: string) => call<DeckDetail>("GET", `/api/deck${qs({ name })}`),
  deckHome: (name: string) => call<DeckHomeData>("GET", `/api/decks/${encodeURIComponent(name)}/home`),
  /** The faces of the cards in a deck and its subdecks, with the types that make each and how many are new. */
  deckFaces: (name: string) => call<DeckFace[]>("GET", `/api/deck/faces${qs({ name })}`),
  createDeck: (name: string) => call("POST", "/api/decks", { name }),
  reorderDecks: (parent: string, order: string[]) => call<{ order: string[] }>("POST", "/api/decks/order", { parent, order }),
  moveDeck: (name: string, parent: string, index?: number) => call<DeckNode>("POST", "/api/decks/move", { name, parent, index }),
  updateDeck: (name: string, patch: Partial<{ name: string; presetId: string | null; config: Partial<PresetConfig>; description: string; instructions: string; archived: boolean; icon: string | null }>) =>
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
  typePrefs: (id: string) => call<Record<string, unknown>>("GET", `/api/types/${encodeURIComponent(id)}/prefs`),
  setTypePref: (id: string, key: string, value: unknown) => call<Record<string, unknown>>("PUT", `/api/types/${encodeURIComponent(id)}/prefs`, { key, value }),
  resetTypePrefs: (id: string) => call<Record<string, unknown>>("DELETE", `/api/types/${encodeURIComponent(id)}/prefs`),
  typeLeftover: (id: string) => call<LeftoverReport>("GET", `/api/types/${encodeURIComponent(id)}/leftover`),
  cleanup: () => call<CleanupReport>("GET", "/api/cleanup"),
  deleteLeftoverCards: (only: { type?: string; face?: string } = {}) => call<{ cards: number; reviews: number }>("POST", "/api/cleanup/cards", only),
  deleteUnusedMedia: () => call<{ files: number; bytes: number }>("POST", "/api/cleanup/media", {}),
  /** `items`: also delete the items using the type (archived ones too), with their cards and history. */
  deleteType: (id: string, opts: { items?: boolean } = {}) => call<{ ok: true; items: number; cards: number; reviews: number }>("DELETE", `/api/types/${encodeURIComponent(id)}`, opts),
  typeDecks: (id: string) => call<{ deck: string; items: number; cards: number }[]>("GET", `/api/types/${encodeURIComponent(id)}/decks`),
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

  search: (q: string, opts: { limit?: number; offset?: number; order?: string; reverse?: boolean } = {}) => call<{ total: number; rows: SearchRow[] }>("GET", `/api/items${qs({ q, ...opts, reverse: opts.reverse ? 1 : undefined })}`),
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
  recordRun: (cardId: number, seed: number, answer: unknown, opts: { durationMs?: number; practice?: boolean; asOf?: string } = {}) =>
    call<{ attemptId: number | null; reviewId: number | null; grade: Grade; progress: unknown; due: string; state: number }>("POST", "/api/study/record", {
      cardId,
      seed,
      answer,
      durationMs: opts.durationMs,
      practice: !!opts.practice,
      asOf: opts.asOf,
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
  concepts: (deck: string) => call<ConceptMap>("GET", `/api/stats/concepts${qs({ deck })}`),
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
  /** Anonymous error reports and usage counts (Settings → Privacy): whether this app sends them, and what waits. */
  telemetry: () => call<{ active: boolean; allowed: boolean; forced: boolean; prefs: { errorReports: boolean; usageStats: boolean }; pending: { errors: number; counters: number } }>("GET", "/api/telemetry"),
  telemetryReport: (r: { kind: string; message: string; stack?: string }) => call<{ queued: boolean }>("POST", "/api/telemetry/report", r),
  telemetryEvent: (name: string) => call<{ counted: boolean }>("POST", "/api/telemetry/event", { name }),
  /** Your own activity for Stats (Settings → Privacy → Activity): off unless turned on, kept on this device only. */
  activity: () => call<ActivityStatus>("GET", "/api/activity"),
  saveActivity: (p: { on?: boolean; keepDays?: number; deleteAll?: boolean }) => call<{ on: boolean; keepDays: number }>("PATCH", "/api/activity", p),
  recordActivity: (entries: ActivityEntry[]) => call<{ on: boolean; recorded: number }>("POST", "/api/activity", { entries }),
  clearActivity: () => call<{ deleted: number }>("DELETE", "/api/activity"),
  activitySummary: (days = 30) => call<ActivitySummary>("GET", `/api/activity/summary${qs({ days })}`),
  defaults: () => call<PresetConfig>("GET", "/api/defaults"),
  schedulers: () => call<SchedulerSummary[]>("GET", "/api/schedulers"),
  testAi: () => call<any>("POST", "/api/ai/test", {}),
  /** Your OK for each AI provider: grading sends nothing to one you haven't agreed to. */
  aiConsent: () => call<AiConsentStatus>("GET", "/api/ai/consent"),
  agreeToAi: (provider: string) => call<AiConsentStatus>("POST", "/api/ai/consent", { provider }),
  withdrawAiConsent: (provider: string) => call<AiConsentStatus>("POST", "/api/ai/consent/withdraw", { provider }),
  saveSettings: (patch: unknown) => call<any>("PATCH", "/api/settings", patch),
  /** Writes one API key to $ETUDE_HOME/.env on the server; the reply never carries the key. Empty removes it. */
  saveKey: (name: string, value: string) => call<{ name: string; set: boolean }>("POST", "/api/settings/key", { name, value }),
  onboarding: () => call<{ done: boolean; level: "simple" | "standard" | "tinker"; show: boolean; decks: number }>("GET", "/api/onboarding"),
  chatgptStatus: () => call<any>("GET", "/api/chatgpt/status"),
  chatgptLogin: () => call<any>("POST", "/api/chatgpt/login", {}),
  chatgptLogout: () => call<any>("POST", "/api/chatgpt/logout", {}),
  themes: () => call<{ selected: string; themes: (ThemeData & { builtin: boolean; selected: boolean })[] }>("GET", "/api/themes"),
  saveTheme: (t: ThemeData) => call<{ theme: ThemeData; removed: string[]; created: boolean }>("PUT", `/api/themes/${encodeURIComponent(t.id)}`, t),
  deleteTheme: (id: string) => call<{ deleted: string; selected: string }>("DELETE", `/api/themes/${encodeURIComponent(id)}`),
  selectTheme: (id: string) => call<ThemeData>("PUT", "/api/theme", { id }),

  updateStatus: (check = false, force = false) => call<UpdateStatus>("GET", `/api/update${qs({ check: check ? 1 : undefined, force: force ? 1 : undefined })}`),
  applyUpdate: () => call<{ result: "updated" | "current"; from: string; to: string; commits: UpdateCommit[]; restarting: boolean }>("POST", "/api/update", {}),

  market: (refresh = false) => call<MarketListing>("GET", `/api/market${refresh ? "?refresh=1" : ""}`).then((d) => ((marketRev = d.generated || marketRev), d)),
  marketEntry: (kind: MarketKind, id: string) => call<MarketFile>("GET", `/api/market/entry/${kind}/${encodeURIComponent(id)}`),
  marketInstall: (id: string, kind: MarketKind, opts: { use?: boolean; dryRun?: boolean } = {}) =>
    call<{ entry: MarketMeta; result: "created" | "updated" | "unchanged"; ids: string[]; report: any }>("POST", "/api/market/install", { id, kind, ...opts }),
  /** An <img> can't send the bearer token, so it rides in the query. */
  /** `v` is when the catalog's index was built, so a new cover shows at once instead of a cached old one. */
  marketCoverUrl: (kind: MarketKind, id: string) => `/api/market/cover/${kind}/${encodeURIComponent(id)}${qs({ v: marketRev || undefined, token: apiToken() || undefined })}`,
  /** Coming soon pictures: "cover" or a preview's position. */
  comingSoonUrl: (id: string, slot: "cover" | number) => `/api/market/coming-soon/${encodeURIComponent(id)}/${slot}${apiToken() ? `?token=${encodeURIComponent(apiToken()!)}` : ""}`,
  /** A paid deck's gallery: the catalog paths, and a URL for each by position. */
  paidMedia: (slug: string) => call<{ media: string[] }>("GET", `/api/market/paid-media/${encodeURIComponent(slug)}`),
  paidMediaUrl: (slug: string, i: number) => `/api/market/paid-media/${encodeURIComponent(slug)}/${i}${apiToken() ? `?token=${encodeURIComponent(apiToken()!)}` : ""}`,
  marketForget: (id: string) => call<{ forgot: boolean }>("POST", "/api/market/forget", { id }),
  /** Authors whose entries you hid: kept in your settings and synced. */
  hiddenAuthors: () => call<{ hiddenAuthors: { author: string; since: string }[] }>("GET", "/api/market/hidden-authors"),
  hideAuthor: (author: string) => call<{ author: string; hidden: boolean; hiddenAuthors: string[] }>("POST", "/api/market/hide-author", { author }),
  showAuthor: (author: string) => call<{ author: string; hidden: boolean; hiddenAuthors: string[] }>("POST", "/api/market/show-author", { author }),
  publishStatus: () => call<{ ok: boolean; login?: string; reason?: string; repo: string }>("GET", "/api/market/publish/status"),
  publish: (input: PublishInput & { dryRun?: boolean; full?: boolean }) => call<PublishResult>("POST", "/api/market/publish", input),

  plugins: () => call<{ plugins: InstalledPluginInfo[]; bundled: BundledPluginInfo[] }>("GET", "/api/plugins"),
  installBundledPlugin: (id: string, grant?: string[]) =>
    call<{ plugin: InstalledPluginInfo; status: string; pausedForPermissions: boolean }>("POST", "/api/plugins/install-bundled", { id, ...(grant ? { grant } : {}) }),
  updatePlugin: (id: string, patch: { enabled?: boolean; granted?: string[] }) =>
    call<InstalledPluginInfo>("PATCH", `/api/plugins/${encodeURIComponent(id)}`, patch),
  uninstallPlugin: (id: string) => call<{ removed: string }>("DELETE", `/api/plugins/${encodeURIComponent(id)}`),
  pluginKvGetAll: (id: string) => call<{ kv: Record<string, unknown> }>("GET", `/api/plugins/${encodeURIComponent(id)}/kv`),
  pluginKvGet: (id: string, key: string) => call<{ key: string; value: unknown }>("GET", `/api/plugins/${encodeURIComponent(id)}/kv/${encodeURIComponent(key)}`),
  pluginKvSet: (id: string, key: string, value: unknown) => call<{ key: string; value: unknown }>("PUT", `/api/plugins/${encodeURIComponent(id)}/kv/${encodeURIComponent(key)}`, { value }),
  pluginListEvents: (id: string, opts: { kind?: string; after?: number; limit?: number } = {}) =>
    call<{ events: { id: number; pluginId: string; ts: string; kind: string; payload: unknown }[] }>("GET", `/api/plugins/${encodeURIComponent(id)}/events${qs(opts)}`),
  pluginAppendEvent: (id: string, kind: string, payload: unknown) =>
    call<{ id: number; pluginId: string; ts: string; kind: string; payload: unknown }>("POST", `/api/plugins/${encodeURIComponent(id)}/events`, { kind, payload }),

  courses: () => call<{ courses: InstalledCourseInfo[] }>("GET", "/api/courses"),
  course: (id: string) => call<InstalledCourseInfo>("GET", `/api/courses/${encodeURIComponent(id)}`),
  importCourse: (payload: Record<string, unknown>) =>
    call<{ course: InstalledCourseInfo; status: "installed" | "updated" | "unchanged" }>("POST", "/api/courses/import", payload),
  exportCourse: (id: string) => call<{ manifest: CourseManifestInfo; html: string }>("GET", `/api/courses/${encodeURIComponent(id)}/export`),
  removeCourse: (id: string) => call<{ removed: string }>("DELETE", `/api/courses/${encodeURIComponent(id)}`),
  saveCourseProgress: (
    id: string,
    body: { state?: Record<string, unknown>; doneCount?: number; totalCount?: number; minsLeft?: number | null; currentId?: string | null; currentTitle?: string | null },
  ) => call<CourseProgressInfo>("PUT", `/api/courses/${encodeURIComponent(id)}/progress`, body),
  resetCourseProgress: (id: string) => call<{ reset: string }>("DELETE", `/api/courses/${encodeURIComponent(id)}/progress`),
  courseFrameUrl: (id: string) => `/frame-course/${encodeURIComponent(id)}${apiToken() ? `?token=${encodeURIComponent(apiToken()!)}` : ""}`,
};

export interface UpdateCommit {
  sha: string;
  subject: string;
  date: string;
}

export type UpdateStatus = { canRestart: boolean; checked: string | null; checkError?: string; version: string } & (
  | { kind: "git"; branch: string | null; upstream: string | null; commit: string; incoming: UpdateCommit[]; behind: number; ahead: number; dirty: string[]; kept?: string[]; clash?: string[]; blocked?: string }
  | { kind: "package"; latest: string | null; url: string }
  // The desktop app's own updates (see DesktopUpdateState); `ready` once a "self" update is downloaded.
  | { kind: "desktop"; mode: "self" | "link" | "system"; latest: string | null; ready: boolean; percent: number | null; url: string }
);

export type MarketKind = "theme" | "deck" | "type" | "plugin" | "course";

export interface CourseLessonOutlineInfo {
  id: string;
  title: string;
  unit?: string;
  minutes?: number;
}

export interface CourseManifestInfo {
  etude: "course/1";
  id: string;
  name: string;
  subtitle?: string;
  description?: string;
  author?: string;
  version: string;
  icon?: string;
  language?: string;
  tags?: string[];
  units?: string[];
  lessons?: CourseLessonOutlineInfo[];
  kit?: string;
}

export interface CourseProgressInfo {
  state: Record<string, unknown>;
  doneCount: number;
  totalCount: number;
  minsLeft: number | null;
  currentId: string | null;
  currentTitle: string | null;
  updatedAt: string | null;
}

export interface InstalledCourseInfo {
  id: string;
  manifest: CourseManifestInfo;
  hash: string;
  source: "local" | "market";
  installedAt: string;
  updatedAt: string;
  lastOpened: string | null;
  bytes: number;
  progress: CourseProgressInfo;
}

export interface PluginManifestInfo {
  etude: "plugin/1";
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  main: string;
  views?: Record<string, string>;
  permissions: string[];
  platforms: ("desktop" | "web")[];
}

export interface InstalledPluginInfo {
  id: string;
  manifest: PluginManifestInfo;
  hash: string;
  enabled: boolean;
  granted: string[];
  pendingPermissions: string[];
  source: "local" | "market" | "bundled";
  installedAt: string;
  updatedAt: string;
  bytes: number;
  fileCount: number;
  permissionLabels?: Record<string, string>;
}

export interface BundledPluginInfo {
  id: string;
  manifest: PluginManifestInfo;
  hash: string;
  installed: boolean;
  permissionLabels?: Record<string, string>;
}

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
  | { types: { id: string; name: string; description: string; grader: string; fields: string[] }[]; items: number; samples: string[] }
  | { plugin: { id: string; version: string; permissions: string[]; platforms: string[]; hash: string; files: number } }
  | { course: { id: string; subtitle?: string; version: string; lessons: number; units: string[]; lessonTitles: string[]; language?: string; kit?: string; hash: string } };

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
  /** Decks being made (the catalog's coming-soon.json); missing from older servers. */
  comingSoon?: ComingSoonEntry[];
  /** Authors you hid: the lists leave their entries out. Missing from older servers. */
  hiddenAuthors?: string[];
}

/** Who AI grading and Ask send to with the saved settings, and when you agreed to each (src/core/engine.ts aiConsentStatus). */
export interface AiConsentStatus {
  /** Whether this engine holds grading back until you agree: only in the iPhone app. */
  required: boolean;
  /** `for`: what uses the provider now (grading, the assistant's default profile). One OK covers both. `ready`: it can send now (key set, ChatGPT signed in). */
  providers: { id: string; name: string; for: ("grading" | "assistant")[]; ready: boolean; agreed: string | null }[];
  agreed: Record<string, string>;
}

/** A deck on the Coming soon shelf: pictures and words, nothing to install or buy (src/core/market.ts). */
export interface ComingSoonEntry {
  id: string;
  kind: "deck";
  name: string;
  tagline: string;
  description: string;
  tags: string[];
  facts: { label: string; value: string }[];
  parts: string[];
  cover?: string;
  media: string[];
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
