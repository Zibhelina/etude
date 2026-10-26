// Shared shapes for the engine, the server and the web client.

export type FieldKind = "markdown" | "text" | "number" | "boolean" | "list" | "json" | "code" | "html";

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  label?: string;
  description?: string;
  required?: boolean;
  /** Private fields never reach the card before an answer is graded. */
  private?: boolean;
  default?: unknown;
  /** Hint for editors: a structured form for common JSON shapes. */
  editor?: "choices" | "pairs" | "parts" | "occlusion";
  /** For `code` fields: the language to highlight, or `field:<name>` to read it from another field. */
  language?: string;
}

export interface Template {
  html: string;
  css?: string;
  js?: string;
}

/** How an answer becomes a score. */
export type GraderSpec =
  | { kind: "self" }
  | { kind: "script"; code: string }
  | { kind: "ai"; vision?: boolean; instructions?: string }
  | { kind: "hybrid"; code: string; vision?: boolean; instructions?: string };

export interface CardTypeDef {
  id: string;
  name: string;
  description?: string;
  /** Each face becomes its own scheduled card (e.g. forward and reverse). */
  faces?: string[];
  /**
   * Body of `function (fields)` returning the faces this item has, a subset of `faces`.
   * Without it every item gets every face.
   */
  facesWhen?: string;
  fields: FieldSpec[];
  /**
   * The field that names an item in lists (Browse, search results). Without it, the first public
   * markdown field, then the first other public text field without a default (one with a default is
   * a setting). Studying never shows a private one.
   */
  titleField?: string;
  /** Body of `function (fields, face, rng)` returning `{ view, key }`. Runs sandboxed on the server. */
  prepare?: string;
  template: Template;
  grader: GraderSpec;
  /** Default instructions for AI grading of this type (lowest layer of the cascade). */
  instructions?: string;
  /**
   * Body of `function (view, key, fields, rng)` returning an example answer, in the shape the
   * card's `getAnswer` produces. Watch mode shows it, graded, so a reader sees how the card works.
   */
  demo?: string;
  /**
   * Show "Correct / Not quite" and the grader's feedback after an answer. Default true. Off for cards
   * whose result is a measurement (a typing test), where the card's own result screen says it all.
   */
  showVerdict?: boolean;
  /**
   * Numbers the grader puts in `details` that are worth tracking over time (WPM, accuracy...).
   * Practice decks chart them. Without it, every top-level numeric detail is tracked.
   */
  metrics?: MetricSpec[];
  /**
   * Files shipped once with the type, `{ name: base64 }`. Cards load them with `etude.asset(name)`.
   * Stored apart from the definition; omitted on save means "keep the stored ones".
   */
  assets?: Record<string, string>;
}

export interface MetricSpec {
  /** Key in the grade's `details` (dots reach nested values), or `score`. */
  key: string;
  label?: string;
  unit?: string;
  /** Which way is progress. Default higher. */
  better?: "higher" | "lower";
  digits?: number;
}

/**
 * When a card comes back. FSRS is built in; any other scheduler is a script, like a grader.
 * `schedule` is the body of `function (card, attempt, options, ctx)` returning `{ due, state }`.
 */
export interface SchedulerDef {
  id: string;
  name: string;
  description?: string;
  /** Offer Again/Hard/Good/Easy after an answer. Off: the result itself is what's recorded, and the learner picks Again or Next. */
  ratings?: boolean;
  /** Settings a deck can give this scheduler, shown in the deck's Options. */
  options?: SchedulerOption[];
  /** What Stats can show about the cards' state: `groupBy` names a value in the state the script returns (dots reach nested ones), e.g. Leitner's `box`. */
  stats?: SchedulerStats;
  schedule: string;
}

export interface SchedulerStats {
  groupBy: string;
  /** What one group is called, e.g. "Box". */
  label?: string;
}

export interface SchedulerOption {
  name: string;
  kind: "number" | "boolean" | "text";
  label?: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  /** Unit shown after a number, e.g. "days". */
  suffix?: string;
}

export interface PresetConfig {
  desiredRetention: number;
  learningSteps: string[];
  relearningSteps: string[];
  maximumInterval: number;
  enableFuzz: boolean;
  enableShortTerm: boolean;
  /** FSRS-6 weights; omitted means the published defaults. */
  weights?: number[];
  newPerDay: number;
  /**
   * Separate daily limits for new cards on some faces, by face name, within `newPerDay`: `{ t1: 5 }`
   * introduces at most 5 new t1 cards a day. Faces without one share `newPerDay`. Layers merge face by
   * face; `null` drops a limit inherited from a preset or parent deck.
   */
  newPerFace: Record<string, number | null>;
  reviewsPerDay: number;
  newOrder: "added" | "random" | "deck";
  reviewOrder: "due" | "retrievability" | "random";
  /** Show new cards between reviews ("mix"), before them, or after them. */
  newMix: "mix" | "first" | "last";
  /** Exam mode: no card is scheduled past this moment minus `deadlineMargin` hours. */
  deadline?: string | null;
  deadlineMargin: number;
  /** Score thresholds that turn a graded score into a suggested rating. */
  autoRate: { good: number; hard: number };
  /** After grading, apply the suggested rating without waiting for confirmation. */
  autoApply: boolean;
  /** Hide a card's siblings (other faces of the same item) until tomorrow once one is reviewed. */
  burySiblings: boolean;
  /** "watch": a tour deck. Every card is shown once with an example answer and nothing is scheduled. */
  mode: "study" | "watch";
  /** Which scheduler decides when cards come back: "fsrs" (spaced repetition) or another scheduler's id. */
  scheduler: string;
  /** Settings for a non-FSRS scheduler, by option name. */
  schedulerOptions: Record<string, unknown>;
}

export const DEFAULT_PRESET: PresetConfig = {
  desiredRetention: 0.9,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
  maximumInterval: 36500,
  enableFuzz: true,
  enableShortTerm: true,
  newPerDay: 20,
  newPerFace: {},
  reviewsPerDay: 200,
  newOrder: "added",
  reviewOrder: "due",
  newMix: "mix",
  deadline: null,
  deadlineMargin: 12,
  autoRate: { good: 0.95, hard: 0.5 },
  autoApply: false,
  burySiblings: true,
  mode: "study",
  scheduler: "fsrs",
  schedulerOptions: {},
};

export interface Preset {
  id: string;
  name: string;
  config: Partial<PresetConfig>;
}

export interface Deck {
  id: number;
  name: string;
  presetId: string | null;
  config: Partial<PresetConfig>;
  description: string;
  instructions: string;
  archived: boolean;
  /** Order among sibling decks (null: unordered, after the ordered ones, by name). */
  position: number | null;
}

export interface Item {
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
}

export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const;
export type StateValue = (typeof State)[keyof typeof State];
export const STATE_NAMES = ["new", "learning", "review", "relearning"] as const;

export interface CardRow {
  id: number;
  item_id: string;
  face: string;
  state: number;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  last_review: string | null;
  suspended: number;
  buried_until: string | null;
  /** State owned by a non-FSRS scheduler (JSON), null for FSRS cards. */
  sched_state?: string | null;
}

export type Rating = 1 | 2 | 3 | 4;
export const RATING_NAMES: Record<Rating, string> = { 1: "again", 2: "hard", 3: "good", 4: "easy" };

export type Verdict = "correct" | "partial" | "incorrect" | "ungraded";

export interface Grade {
  /** 0..1, or null when the learner rates themselves. */
  score: number | null;
  verdict: Verdict;
  feedback?: string;
  /** Type-specific marks a template can show inline (per part, per option...). */
  details?: unknown;
  suggested: Rating | null;
  confidence?: number;
  /** `example`: a recorded grade shown in watch mode, not one made for this answer. */
  grader: { kind: string; model?: string; ms?: number; cost?: number; error?: string; example?: boolean };
}

export interface Prepared {
  view: Record<string, unknown>;
  key: Record<string, unknown>;
  seed: number;
  /** Set when prepare returned `grader: "self"`: this variant is revealed and self-rated, whatever the type's grader. */
  selfGraded?: boolean;
}
