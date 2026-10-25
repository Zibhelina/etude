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
  editor?: "choices" | "pairs" | "parts";
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
  /** Body of `function (fields, face, rng)` returning `{ view, key }`. Runs sandboxed on the server. */
  prepare?: string;
  template: Template;
  grader: GraderSpec;
  /** Default instructions for AI grading of this type (lowest layer of the cascade). */
  instructions?: string;
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
}

export const DEFAULT_PRESET: PresetConfig = {
  desiredRetention: 0.9,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
  maximumInterval: 36500,
  enableFuzz: true,
  enableShortTerm: true,
  newPerDay: 20,
  reviewsPerDay: 200,
  newOrder: "added",
  reviewOrder: "due",
  newMix: "mix",
  deadline: null,
  deadlineMargin: 12,
  autoRate: { good: 0.95, hard: 0.5 },
  autoApply: false,
  burySiblings: true,
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
  grader: { kind: string; model?: string; ms?: number; cost?: number; error?: string };
}

export interface Prepared {
  view: Record<string, unknown>;
  key: Record<string, unknown>;
  seed: number;
}
