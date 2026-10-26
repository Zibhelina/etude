import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SchedulerDef } from "../../core/model.ts";
import { loadSchedulerDir, validateScheduler } from "../../core/schedulers.ts";
import { command, group, CliError, type Ctx } from "../registry.ts";
import { parseJson, readSource } from "../input.ts";

group({ name: "scheduler", summary: "Schedulers: who decides when a card comes back (FSRS, a drill, Leitner boxes, or your own script)", defaultVerb: "list" });

/** A scheduler from a directory (scheduler.json + schedule.js), a JSON file, or `-`. */
function loadSource(ctx: Ctx, src: string): SchedulerDef {
  if (src !== "-" && existsSync(src) && statSync(src).isDirectory()) {
    if (!existsSync(join(src, "scheduler.json"))) throw new CliError(`${src} has no scheduler.json`, "validation");
    return loadSchedulerDir(src);
  }
  return parseJson(readSource(ctx, src), src === "-" ? "stdin" : src);
}

const strip = (def: any): SchedulerDef => {
  const { updated, builtin, ...rest } = def;
  return rest;
};

command({
  name: "scheduler list",
  summary: "Every scheduler: FSRS (built in) and the script ones, with whether they ask for ratings, their options and how many decks use them.",
  output: "array of { id, name, description, ratings, options, builtin, shipped, edited, script, updated, decks }",
  run: (ctx) => ctx.e.listSchedulers(),
});

command({
  name: "scheduler show",
  summary: "A script scheduler's definition, including its schedule.js.",
  args: [{ name: "id", description: "Scheduler id.", required: true }],
  examples: ["etude scheduler show drill"],
  run(ctx) {
    if (ctx.args.id === "fsrs") return ctx.e.listSchedulers()[0];
    return ctx.e.scheduler(ctx.args.id);
  },
});

command({
  name: "scheduler export",
  summary: "Write a script scheduler as editable files (scheduler.json + schedule.js), or print it as JSON.",
  args: [{ name: "id", description: "Scheduler id.", required: true }],
  flags: [
    { name: "out", type: "string", short: "o", description: "Directory to write. Default: ./<id>.", placeholder: "DIR" },
    { name: "json", type: "boolean", description: "Print the definition as one JSON object instead of writing files." },
  ],
  writes: true,
  examples: ["etude scheduler export drill -o my-drill", "etude scheduler export leitner --json"],
  output: "{ written: dir, files } or the definition with --json",
  run(ctx) {
    const { schedule, ...meta } = strip(ctx.e.scheduler(ctx.args.id));
    if (ctx.flags.json) return { ...meta, schedule };
    const dir = resolve(ctx.flags.out ?? meta.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scheduler.json"), JSON.stringify(meta, null, 2) + "\n");
    writeFileSync(join(dir, "schedule.js"), schedule);
    return { written: dir, files: ["scheduler.json", "schedule.js"] };
  },
});

command({
  name: "scheduler import",
  summary: "Create or update a scheduler from a directory (scheduler.json + schedule.js), a JSON file, or `-`.",
  description:
    "schedule.js is the body of `function (card, attempt, options, ctx)` and returns `{ due, state }`. `card.state` is what it returned last time; `attempt` has the rating (when the scheduler asks for ratings), the grader's score and its `details`; `ctx.day[n]` is the start of the study day n days from today. See docs/schedulers.md.",
  args: [{ name: "source", description: "Directory, JSON file, or `-`.", required: true }],
  flags: [{ name: "id", type: "string", description: "Save under this id instead of the one in the source." }],
  writes: true,
  dryRun: true,
  examples: ["etude scheduler import ./every-monday", "etude scheduler export drill --json | jq '.id=\"drill2\"' | etude scheduler import -"],
  output: "{ result: created|updated|unchanged, scheduler: { id, name, ratings } }",
  run(ctx) {
    const def = loadSource(ctx, ctx.args.source);
    if (ctx.flags.id) def.id = ctx.flags.id;
    const errors = validateScheduler(def);
    if (errors.length) throw new CliError(`invalid scheduler: ${errors.join("; ")}`, "validation", { errors });
    const r = ctx.e.saveScheduler(def);
    return { result: r.result, scheduler: { id: r.scheduler.id, name: r.scheduler.name, ratings: r.scheduler.ratings !== false } };
  },
});

command({
  name: "scheduler validate",
  summary: "Check a scheduler definition without saving it. Exits 4 when it has problems.",
  args: [{ name: "source", description: "Directory, JSON file, or `-`.", required: true }],
  output: "{ id, ok, errors }",
  run(ctx) {
    const def = loadSource(ctx, ctx.args.source);
    const errors = validateScheduler(def);
    if (errors.length) throw new CliError(`invalid scheduler: ${errors.join("; ")}`, "validation", { id: def?.id, ok: false, errors });
    return { id: def.id, ok: true, errors: [] };
  },
});

command({
  name: "scheduler reset",
  summary: "Restore an edited built-in scheduler to the shipped version.",
  args: [{ name: "id", description: "Built-in scheduler id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude scheduler reset drill --yes"],
  run(ctx) {
    ctx.e.resetScheduler(ctx.args.id);
    return { reset: ctx.args.id };
  },
});

command({
  name: "scheduler delete",
  summary: "Delete a custom scheduler no deck or preset uses.",
  args: [{ name: "id", description: "Scheduler id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude scheduler delete every-monday --yes"],
  run(ctx) {
    ctx.e.deleteScheduler(ctx.args.id);
    return { deleted: ctx.args.id };
  },
});
