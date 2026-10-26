// Schedulers other than FSRS. A scheduler decides when a card comes back and what state it keeps;
// like a grader it's a script, so anyone can write one that fits the practice (a daily drill, a
// Leitner box, "every Monday"). FSRS stays built into the engine and is the default.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SchedulerDef, SchedulerOption } from "./model.ts";
import { checkSyntax, runScript } from "./sandbox.ts";

export const FSRS = "fsrs";
export const SCHEDULER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPTION_KINDS = new Set(["number", "boolean", "text"]);
export const SCHEDULE_PARAMS = ["card", "attempt", "options", "ctx"];
/** How many day starts a script gets in `ctx.day` (today is 0). */
export const DAY_HORIZON = 400;

/** What FSRS looks like in a list of schedulers, so the UI can offer it beside the scripts. */
export const FSRS_SUMMARY = {
  id: FSRS,
  name: "FSRS",
  description: "Spaced repetition: each card comes back right before you'd forget it. For things you want to remember.",
  ratings: true,
  options: [] as SchedulerOption[],
  stats: null,
  builtin: true,
  script: false,
};

/** A scheduler directory: `scheduler.json` plus `schedule.js` (which wins over a `schedule` key in the json). */
export function loadSchedulerDir(dir: string): SchedulerDef {
  const meta = JSON.parse(readFileSync(join(dir, "scheduler.json"), "utf8"));
  const file = join(dir, "schedule.js");
  return { ...meta, schedule: existsSync(file) ? readFileSync(file, "utf8") : meta.schedule };
}

export function loadBuiltinSchedulers(root: string): SchedulerDef[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "scheduler.json")))
    .map((d) => loadSchedulerDir(join(root, d.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function validateScheduler(def: unknown): string[] {
  const e: string[] = [];
  const s = def as Partial<SchedulerDef>;
  if (!s || typeof s !== "object") return ["scheduler must be an object"];
  if (typeof s.id !== "string" || !SCHEDULER_ID.test(s.id)) e.push("id must be a lowercase slug (a-z, 0-9, -)");
  else if (s.id === FSRS) e.push('"fsrs" is the built-in scheduler and can\'t be replaced');
  if (typeof s.name !== "string" || !s.name.trim()) e.push("name is required");
  if (s.ratings !== undefined && typeof s.ratings !== "boolean") e.push("ratings must be true or false");
  if (s.stats !== undefined) {
    const st = s.stats as Partial<SchedulerDef["stats"] & object>;
    if (!st || typeof st !== "object" || Array.isArray(st)) e.push("stats must be an object");
    else {
      if (typeof st.groupBy !== "string" || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(st.groupBy)) e.push("stats.groupBy must name a value in the state, e.g. \"box\"");
      if (st.label !== undefined && typeof st.label !== "string") e.push("stats.label must be text");
    }
  }
  if (s.options !== undefined) {
    if (!Array.isArray(s.options)) e.push("options must be an array");
    else {
      const seen = new Set<string>();
      s.options.forEach((o, i) => {
        if (!o || typeof o.name !== "string" || !/^[A-Za-z_]\w*$/.test(o.name)) e.push(`options[${i}].name must be an identifier`);
        else if (seen.has(o.name)) e.push(`option ${o.name} is defined twice`);
        else seen.add(o.name);
        if (!OPTION_KINDS.has(o?.kind)) e.push(`options[${i}].kind must be number, boolean or text`);
      });
    }
  }
  if (typeof s.schedule !== "string" || !s.schedule.trim()) e.push("schedule (the script) is required");
  else {
    const err = checkSyntax(s.schedule, SCHEDULE_PARAMS, `${s.id}/schedule`);
    if (err) e.push(err);
  }
  return e;
}

/** The deck's option values over the scheduler's defaults, coerced to each option's kind. */
export function resolveOptions(def: SchedulerDef, given: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of def.options ?? []) {
    let v = given && o.name in given ? given[o.name] : o.default;
    if (o.kind === "number") {
      v = Number(v);
      if (!Number.isFinite(v)) v = Number(o.default ?? 0);
      if (o.min !== undefined) v = Math.max(o.min, v as number);
      if (o.max !== undefined) v = Math.min(o.max, v as number);
    } else if (o.kind === "boolean") v = v === true || v === "true" || v === 1;
    else v = v == null ? "" : String(v);
    out[o.name] = v;
  }
  return out;
}

/** What a scheduler script sees about the card. */
export interface ScriptCard {
  /** The scheduler's own state from last time (whatever it returned), null before the first review. */
  state: unknown;
  /** Reviews so far, not counting this one. */
  reps: number;
  due: string;
  lastReview: string | null;
  created: string;
}

/** What a scheduler script sees about this answer. */
export interface ScriptAttempt {
  /** 1-4 when the scheduler asks for ratings, else null. */
  rating: number | null;
  /** The grader's score 0..1, null when self-rated or not graded. */
  score: number | null;
  verdict: string | null;
  /** Whatever the grader put in `details` (WPM, accuracy, per-part marks...). */
  details: unknown;
  /** Time spent on the card, ms. */
  ms: number | null;
  at: string;
}

export interface ScriptCtx {
  now: string;
  /** `day[n]`: the start of the study day n days from today, in the learner's time zone (`day[0]` is today). */
  day: string[];
  /** Reviews of this card since today started, not counting this one. */
  doneToday: number;
  /** Earlier results for this card, oldest first (at most 50). */
  history: { at: string; rating: number | null; score: number | null }[];
}

export class SchedulerError extends Error {}

/** Runs a scheduler script. Returns the next due date (ISO) and the state to keep. */
export function runSchedule(def: SchedulerDef, card: ScriptCard, attempt: ScriptAttempt, options: Record<string, unknown>, ctx: ScriptCtx): { due: string; state: unknown } {
  const out = runScript<{ due?: unknown; state?: unknown }>(def.schedule, {
    params: SCHEDULE_PARAMS,
    args: { card, attempt, options, ctx },
    where: `${def.id}/schedule`,
    timeoutMs: 500,
  });
  if (!out || typeof out !== "object") throw new SchedulerError(`${def.id}/schedule must return { due, state }`);
  let due: Date;
  if (typeof out.due === "number") due = new Date(out.due);
  else if (typeof out.due === "string") due = new Date(out.due);
  else if (out.due == null) due = new Date(ctx.now);
  else throw new SchedulerError(`${def.id}/schedule: due must be an ISO date or a timestamp`);
  if (Number.isNaN(due.getTime())) throw new SchedulerError(`${def.id}/schedule: due "${String(out.due)}" isn't a date`);
  return { due: due.toISOString(), state: out.state === undefined ? null : out.state };
}
