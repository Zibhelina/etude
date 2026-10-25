// FSRS-6 scheduling with per-deck presets, exam deadlines and replayable history.
import { fsrs, generatorParameters, type Card as FsrsCard, type Grade as FsrsGrade, type FSRS } from "ts-fsrs";
import { DEFAULT_PRESET, type CardRow, type PresetConfig, type Rating } from "./model.ts";

export function engine(cfg: PresetConfig): FSRS {
  return fsrs(
    generatorParameters({
      request_retention: cfg.desiredRetention,
      maximum_interval: cfg.maximumInterval,
      enable_fuzz: cfg.enableFuzz,
      enable_short_term: cfg.enableShortTerm,
      learning_steps: cfg.learningSteps as `${number}${"m" | "h" | "d"}`[],
      relearning_steps: cfg.relearningSteps as `${number}${"m" | "h" | "d"}`[],
      ...(cfg.weights?.length ? { w: cfg.weights } : {}),
    }),
  );
}

export function toFsrs(row: CardRow): FsrsCard {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    learning_steps: row.learning_steps,
    state: row.state,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

export function fromFsrs(card: FsrsCard): Pick<
  CardRow,
  "state" | "due" | "stability" | "difficulty" | "elapsed_days" | "scheduled_days" | "reps" | "lapses" | "learning_steps" | "last_review"
> {
  return {
    state: card.state,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    learning_steps: card.learning_steps,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

/**
 * Exam mode: nothing may come back after the deadline. A card that would be due later is pulled
 * in to `deadline - margin`, but never earlier than its next learning step would put it.
 */
export function capToDeadline(due: Date, now: Date, cfg: PresetConfig): Date {
  if (!cfg.deadline) return due;
  const deadline = new Date(cfg.deadline);
  if (Number.isNaN(deadline.getTime()) || deadline <= now) return due;
  const latest = new Date(deadline.getTime() - cfg.deadlineMargin * 3600_000);
  if (due <= latest) return due;
  // Split the time left in half so a well-known card still gets one more look before the exam.
  const half = new Date(now.getTime() + (deadline.getTime() - now.getTime()) / 2);
  return latest > now ? (half < latest ? half : latest) : half;
}

export interface ScheduleResult {
  next: ReturnType<typeof fromFsrs>;
  dueUncapped: string;
}

export function schedule(row: CardRow, rating: Rating, now: Date, cfg: PresetConfig): ScheduleResult {
  const f = engine(cfg);
  const out = f.next(toFsrs(row), now, rating as FsrsGrade);
  const dueUncapped = out.card.due;
  out.card.due = capToDeadline(out.card.due, now, cfg);
  return { next: fromFsrs(out.card), dueUncapped: dueUncapped.toISOString() };
}

/** What each rating would do right now, for the rating buttons. */
export function preview(row: CardRow, now: Date, cfg: PresetConfig): Record<Rating, string> {
  const f = engine(cfg);
  const all = f.repeat(toFsrs(row), now);
  const out = {} as Record<Rating, string>;
  for (const r of [1, 2, 3, 4] as Rating[]) out[r] = capToDeadline(all[r].card.due, now, cfg).toISOString();
  return out;
}

export function retrievability(row: CardRow, now: Date, cfg: PresetConfig): number | null {
  if (row.state === 0 || !row.last_review) return null;
  return engine(cfg).get_retrievability(toFsrs(row), now, false) as number;
}

export function emptyCard(now: Date) {
  return {
    state: 0,
    due: now.toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    learning_steps: 0,
    last_review: null,
  };
}

/** Rebuilds a card's state from its review log, e.g. after changing a preset. */
export function replay(reviews: { ts: string; rating: number }[], created: Date, cfg: PresetConfig) {
  let card: FsrsCard = toFsrs({ ...emptyCard(created), id: 0, item_id: "", face: "", suspended: 0, buried_until: null });
  const f = engine({ ...cfg, enableFuzz: false });
  for (const r of [...reviews].sort((a, b) => a.ts.localeCompare(b.ts))) {
    card = f.next(card, new Date(r.ts), r.rating as FsrsGrade).card;
  }
  const now = new Date();
  card.due = capToDeadline(card.due, now, cfg);
  return fromFsrs(card);
}

export function resolveConfig(...layers: (Partial<PresetConfig> | undefined | null)[]): PresetConfig {
  const out: PresetConfig = { ...DEFAULT_PRESET, autoRate: { ...DEFAULT_PRESET.autoRate } };
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

export function suggestRating(score: number | null, cfg: PresetConfig): Rating | null {
  if (score == null) return null;
  if (score >= cfg.autoRate.good) return 3;
  if (score >= cfg.autoRate.hard) return 2;
  return 1;
}

export function validateConfig(c: Partial<PresetConfig>): string[] {
  const e: string[] = [];
  if (c.desiredRetention !== undefined && !(c.desiredRetention > 0.5 && c.desiredRetention < 1)) e.push("desiredRetention must be between 0.5 and 1");
  for (const k of ["learningSteps", "relearningSteps"] as const)
    if (c[k] !== undefined && (!Array.isArray(c[k]) || !c[k]!.every((s) => /^\d+(\.\d+)?[mhd]$/.test(s)))) e.push(`${k} must look like ["1m", "10m", "1d"]`);
  for (const k of ["newPerDay", "reviewsPerDay", "maximumInterval", "deadlineMargin"] as const)
    if (c[k] !== undefined && !(Number.isFinite(c[k]) && (c[k] as number) >= 0)) e.push(`${k} must be a non-negative number`);
  if (c.weights !== undefined && c.weights !== null && (!Array.isArray(c.weights) || ![17, 19, 21].includes(c.weights.length)))
    e.push("weights must have 17, 19 or 21 numbers");
  if (c.deadline && Number.isNaN(new Date(c.deadline).getTime())) e.push("deadline must be an ISO date");
  if (c.mode !== undefined && c.mode !== "study" && c.mode !== "watch") e.push('mode must be "study" or "watch"');
  return e;
}
