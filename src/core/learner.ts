// Learner estimates for adaptive decks. Everything here is computed from stored attempts and card
// state, so two devices with the same history agree and nothing new has to be synced.
import type { LevelSpec, PresetConfig } from "./model.ts";

/**
 * What this showing's answer will be used for, which decides how a type should pick its variant.
 * - `teach`: a new card's first showing. It's encoding, not recall: show the clearest version.
 * - `measure`: the answer is evidence about memory (FSRS reviews and learning steps, placement probes,
 *   quick checks). Show a version of the item's usual difficulty, whatever the learner's state, so the
 *   evidence stays comparable; vary the context, not the difficulty.
 * - `practice`: nothing measures memory (a scheduler without one, like drill). Aim at `target`.
 */
export type LearnerGoal = "teach" | "measure" | "practice";

/** What a card type's `prepare` and an item's generator receive as `learner` on an adaptive deck. */
export interface Learner {
  asOf: string;
  goal: LearnerGoal;
  /** Share of answers to aim for when practising: the deck's targetSuccess, else its desired retention. */
  target: number;
  /** The skill this card's face trains. */
  skill: string;
  /** Estimated ability per skill, on a logit scale: 0 is an even chance on a card of middling difficulty. */
  ability: Record<string, number>;
  /** Share of recent graded answers that were right, per skill. */
  success: Record<string, number>;
  /** Graded answers counted per skill. */
  answers: Record<string, number>;
  /** Where the learner stands on the deck's levels, per skill. Null when the deck has no levels. */
  level: Record<string, LevelState> | null;
  card: { state: "new" | "learning" | "review" | "relearning"; reps: number; lapses: number; stability: number; retrievability: number | null; scores: number[] };
  placement: boolean;
  quickCheck: boolean;
}

export interface LevelState {
  index: number;
  tag: string;
  /** Share of this level's cards that are stable. */
  progress: number;
  checkPassed: boolean;
  /** Every level is done. */
  done: boolean;
  /** The next level's new cards are mixed in. */
  nextOpen: boolean;
}

export interface GradedAttempt {
  cardId: number;
  /** Difficulty key: an item's variant, or the card itself. */
  key: string;
  skills: string[];
  score: number;
  /** Prior difficulty of the variant shown, 0 to 1. */
  prior?: number;
}

export interface SkillModel {
  ability: Record<string, number>;
  answers: Record<string, number>;
  success: Record<string, number>;
  difficulty: Map<string, number>;
}

const RECENT = 50;
export const KNOWN_STABILITY = 21;
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** A 0..1 difficulty on the logit scale the model uses (-2..2). */
export const toLogit = (d: number) => 4 * (clamp(d, 0, 1) - 0.5);
export const fromLogit = (b: number) => clamp(b / 4 + 0.5, 0, 1);
// Steps shrink as evidence accumulates, but never to zero, so the estimates keep following the learner.
const abilityStep = (n: number) => Math.max(0.08, 0.6 / Math.sqrt(1 + n / 8));
const itemStep = (n: number) => Math.max(0.1, 0.6 / Math.sqrt(1 + n));

/** Elo-style fit over graded attempts in time order: each answer moves the learner's skills and the difficulty of what was shown. */
export function fitSkills(attempts: GradedAttempt[]): SkillModel {
  const ability: Record<string, number> = {};
  const answers: Record<string, number> = {};
  const recent: Record<string, number[]> = {};
  const difficulty = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const a of attempts) {
    const b = difficulty.get(a.key) ?? (a.prior != null ? toLogit(a.prior) : 0);
    let first: number | null = null;
    for (const s of a.skills) {
      const theta = ability[s] ?? 0;
      const p = sigmoid(theta - b);
      first ??= p;
      ability[s] = theta + abilityStep(answers[s] ?? 0) * (a.score - p);
      answers[s] = (answers[s] ?? 0) + 1;
      (recent[s] ??= []).push(a.score);
      if (recent[s].length > RECENT) recent[s].shift();
    }
    const n = seen.get(a.key) ?? 0;
    difficulty.set(a.key, b - itemStep(n) * (a.score - (first ?? 0.5)));
    seen.set(a.key, n + 1);
  }
  const success = Object.fromEntries(Object.entries(recent).map(([s, xs]) => [s, xs.reduce((x, y) => x + y, 0) / xs.length]));
  return { ability, answers, success, difficulty };
}

export const targetOf = (cfg: PresetConfig) => cfg.targetSuccess ?? cfg.desiredRetention;

/** Young cards: in review with stability under this many days. Overload shows in them first. */
export const YOUNG_STABILITY = 21;

export interface PaceHistory {
  /** Days with at least one review in the window. */
  activeDays: number;
  /** Reviews of young cards, and how many weren't rated Again. */
  young: { reviews: number; passed: number };
  minutes: number;
  newCards: number;
}

export interface Pace {
  value: number;
  base: number;
  /** Share of young-card reviews not rated Again. */
  youngRetention: number | null;
  minutesPerDay: number | null;
  reason: string;
}

/**
 * Today's new-card limit from the last week. Its signal is what new cards cost: how well recently
 * learned cards hold (your ratings, against the deck's desired retention) and the time spent. All
 * reviews together say little, since FSRS keeps them near the desired retention by design. More new
 * cards only when young cards hold and time is left; fewer when either falls short.
 */
export function pace(cfg: PresetConfig, h: PaceHistory): Pace {
  const lo = cfg.newPerDayMin, hi = Math.max(cfg.newPerDayMin, cfg.newPerDayMax);
  if (h.young.reviews < 20 || h.activeDays === 0)
    return { value: clamp(Math.round(cfg.newPerDay), lo, hi), base: cfg.newPerDay, youngRetention: null, minutesPerDay: null, reason: "not enough reviews of recently learned cards yet" };
  const retention = h.young.passed / h.young.reviews;
  const goal = cfg.desiredRetention;
  const minutes = h.minutes / h.activeDays;
  const base = Math.max(h.newCards / h.activeDays, lo);
  const byMemory = clamp(1 + 3 * (retention - goal), 0.5, 1.5);
  const byTime = minutes > 0 ? clamp(cfg.minutesPerDay / minutes, 0.5, 1.5) : 1.5;
  // The stricter of the two decides.
  const value = clamp(Math.round(base * Math.min(byMemory, byTime)), lo, hi);
  const why = [
    retention >= goal + 0.03 ? "recent cards holding well" : retention <= goal - 0.03 ? "recent cards slipping" : "recent cards holding as planned",
    minutes > cfg.minutesPerDay * 1.1 ? "over the time budget" : minutes < cfg.minutesPerDay * 0.9 ? "time to spare" : "on the time budget",
  ];
  return { value, base: Math.round(base * 10) / 10, youngRetention: Math.round(retention * 1000) / 1000, minutesPerDay: Math.round(minutes * 10) / 10, reason: why.join(", ") };
}

export interface LevelCounts {
  total: number;
  stable: number;
  /** Check cards, and how many have a latest score at the target. */
  checks: number;
  checksPassed: number;
}

/** The first level that isn't done, given each level's counts for one skill. `floor` lifts it (a placement). */
export function levelState(levels: LevelSpec[], counts: LevelCounts[], cfg: PresetConfig, floor = 0): LevelState {
  const done = (i: number) => {
    const c = counts[i];
    if (!c || c.total === 0) return true;
    return c.stable / c.total >= cfg.levelAdvanceAt && c.checksPassed >= c.checks;
  };
  let i = Math.min(Math.max(0, floor), levels.length - 1);
  while (i < levels.length - 1 && done(i)) i++;
  const c = counts[i] ?? { total: 0, stable: 0, checks: 0, checksPassed: 0 };
  const progress = c.total ? c.stable / c.total : 1;
  return {
    index: i,
    tag: levels[i].tag,
    progress,
    checkPassed: c.checksPassed >= c.checks,
    done: i === levels.length - 1 && done(i),
    nextOpen: i < levels.length - 1 && progress >= cfg.levelAdvanceAt,
  };
}

export interface PlacementState {
  bands: number;
  probes: number;
  /** First band not shown to be known: every band below it was passed. */
  frontier: number;
  /** The band to probe next, or null when placement has settled. */
  next: number | null;
}

const PASS = 0.8;
// Three answers per band before it counts as passed or failed: two let a lucky streak skip a level.
const PER_BAND = 3;
const MAX_PROBES = 24;

/**
 * Bisection over difficulty bands from placement answers. Order-independent: a band with enough
 * answers passes or fails, a passed band implies the ones below it, and the next probe halves the
 * remaining gap.
 */
export function placementState(bands: number, probes: { band: number; score: number }[]): PlacementState {
  const by = new Map<number, number[]>();
  for (const p of probes) if (p.band >= 0 && p.band < bands) (by.get(p.band) ?? by.set(p.band, []).get(p.band)!).push(p.score);
  const verdict = (b: number) => {
    const xs = by.get(b);
    if (!xs || xs.length < PER_BAND) return null;
    return xs.reduce((x, y) => x + y, 0) / xs.length >= PASS;
  };
  let failed = bands;
  for (let b = 0; b < bands; b++) if (verdict(b) === false) { failed = b; break; }
  let passed = -1;
  for (let b = failed - 1; b >= 0; b--) if (verdict(b) === true) { passed = b; break; }
  const frontier = passed + 1;
  let next: number | null = null;
  if (probes.length < MAX_PROBES && frontier < failed) next = Math.floor((frontier + failed - 1) / 2);
  return { bands, probes: probes.length, frontier, next };
}

// Quick checks test a placement card by card. Well under PASS on enough of them means the placement
// was wrong for that band; lenient, because a wrong revision sends known cards back to be taught.
const CHECKS_MIN = 10;
const CHECKS_PASS = 0.6;

/**
 * The frontier after the quick checks, in the order answered: the first passed band whose share
 * right fell below CHECKS_PASS once it had CHECKS_MIN of them. A revision stands for the session.
 */
export function revisedFrontier(frontier: number, checks: Map<number, boolean[]>): number {
  for (let b = 0; b < frontier; b++) {
    let n = 0, ok = 0;
    for (const right of checks.get(b) ?? []) {
      n++;
      if (right) ok++;
      if (n >= CHECKS_MIN && ok / n < CHECKS_PASS) return b;
    }
  }
  return frontier;
}

/** Band of a card for placement: its level, or a tenth of the deck by position when the deck has no levels. */
export function bandOf(levels: LevelSpec[], tags: string[], rank: number, total: number): number {
  if (levels.length) return levelIndex(levels, tags);
  return total ? Math.min(9, Math.floor((rank / total) * 10)) : 0;
}

export function levelIndex(levels: LevelSpec[], tags: string[]): number {
  return levels.findIndex((l) => tags.some((t) => t === l.tag || t.startsWith(l.tag + "::")));
}

export const placementBands = (levels: LevelSpec[]) => (levels.length ? levels.length : 10);
