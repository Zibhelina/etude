import { TYPE_ID } from "../../core/types.ts";
import { resolveConfig } from "../../core/scheduler.ts";
import { DEFAULT_PRESET } from "../../core/model.ts";
import { command, group, CliError } from "../registry.ts";
import { applyConfigPairs, optimizeCommand, unsetConfigKeys, CONFIG_KEYS, OPTIMIZE_DESCRIPTION, OPTIMIZE_FLAGS, OPTIMIZE_OUTPUT } from "../common.ts";
import { slug as slugOf } from "../input.ts";

group({ name: "preset", summary: "Presets: named settings shared by several decks", defaultVerb: "list" });

const users = (e: any, id: string) => e.db.all("SELECT name, archived FROM decks WHERE preset_id = ? ORDER BY name", id).map((r: any) => ({ deck: r.name, archived: !!r.archived }));

command({
  name: "preset list",
  summary: "Every preset with the decks that use it.",
  output: "array of { id, name, config, decks: [names] }",
  run(ctx) {
    return ctx.e.listPresets().map((p) => ({ ...p, decks: users(ctx.e, p.id).map((u: any) => u.deck) }));
  },
});

command({
  name: "preset show",
  summary: "A preset: its own values, the full settings it produces on a top-level deck, and its decks.",
  args: [{ name: "id", description: "Preset id.", required: true }],
  output: "{ id, name, config, resolved, decks: [{ deck, archived }] }",
  run(ctx) {
    const p = ctx.e.preset(ctx.args.id);
    return { ...p, resolved: resolveConfig(p.config), decks: users(ctx.e, p.id) };
  },
});

command({
  name: "preset create",
  summary: "Create a preset from key=value pairs, or copy a deck's effective settings with --from-deck.",
  description:
    "With --from-deck the preset captures every setting the deck uses now (what the app's “New preset from these settings” does). Add --apply to attach it to that deck and move the deck's own overrides into it.",
  args: [
    { name: "id", description: "Lowercase slug (a-z, 0-9, -).", required: true },
    { name: "pairs", description: "key=value settings.", variadic: true },
  ],
  flags: [
    { name: "name", type: "string", description: "Display name. Defaults to the id." },
    { name: "from-deck", type: "string", description: "Start from this deck's effective settings.", placeholder: "DECK" },
    { name: "apply", type: "boolean", description: "With --from-deck: use the new preset on that deck and clear its own overrides." },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude preset create exam --name \"Exam cram\" desiredRetention=0.92 deadline=2026-10-23T16:30-07:00 newPerDay=50", 'etude preset create net --from-deck "Networks" --apply'],
  output: "{ preset, applied? }",
  run(ctx) {
    const e = ctx.e;
    const id = ctx.args.id;
    if (!TYPE_ID.test(id)) throw new CliError(`preset id must be a lowercase slug, e.g. "${slugOf(id)}"`, "validation");
    if (e.db.get("SELECT 1 FROM presets WHERE id = ?", id)) throw new CliError(`preset "${id}" already exists; use \`etude preset set\``, "conflict");
    let base: Record<string, any> = {};
    if (ctx.flags["from-deck"]) {
      base = { ...e.deck(ctx.flags["from-deck"]).resolved };
      if (base.weights == null) delete base.weights;
      if (base.deadline == null) delete base.deadline;
    } else if (ctx.flags.apply) throw new CliError("--apply needs --from-deck");
    const config = applyConfigPairs(base, ctx.args.pairs, resolveConfig(base));
    const preset = e.savePreset({ id, name: ctx.flags.name ?? id, config });
    const out: Record<string, unknown> = { preset };
    if (ctx.flags.apply) {
      e.updateDeck(ctx.flags["from-deck"], { presetId: id, config: {} });
      out.applied = e.deck(ctx.flags["from-deck"]).name;
    }
    return out;
  },
});

command({
  name: "preset set",
  summary: "Change settings in a preset. Every deck using it is affected.",
  description: `Keys: ${CONFIG_KEYS.join(", ")}; also autoRate.good / autoRate.hard. Use \`--name\` to rename.`,
  args: [
    { name: "id", description: "Preset id.", required: true },
    { name: "pairs", description: "key=value pairs.", variadic: true },
  ],
  flags: [
    { name: "name", type: "string", description: "New display name." },
    { name: "reschedule", type: "boolean", description: "Replay review history for every deck using the preset." },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude preset set exam desiredRetention=0.95", "etude preset set exam --name \"Final exam\""],
  output: "{ preset, decks, rescheduled? }",
  run(ctx) {
    const e = ctx.e;
    const p = e.preset(ctx.args.id);
    if (!ctx.args.pairs.length && ctx.flags.name === undefined) throw new CliError("give key=value pairs or --name");
    const config = applyConfigPairs(p.config, ctx.args.pairs, resolveConfig(p.config));
    const preset = e.savePreset({ id: p.id, name: ctx.flags.name ?? p.name, config });
    const decks = users(e, p.id).map((u: any) => u.deck);
    const out: Record<string, unknown> = { preset, decks };
    if (ctx.flags.reschedule) out.rescheduled = decks.reduce((n: number, d: string) => n + e.reschedule({ deck: d }).rescheduled, 0);
    return out;
  },
});

command({
  name: "preset unset",
  summary: "Remove keys from a preset so they fall back to the defaults (or the deck's parents).",
  args: [
    { name: "id", description: "Preset id.", required: true },
    { name: "keys", description: "Setting names.", required: true, variadic: true },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude preset unset exam deadline"],
  output: "{ preset, removed }",
  run(ctx) {
    const e = ctx.e;
    const p = e.preset(ctx.args.id);
    const { config, removed } = unsetConfigKeys(p.config, ctx.args.keys);
    return { preset: e.savePreset({ ...p, config }), removed };
  },
});

command({
  name: "preset rename",
  summary: "Change a preset's display name (the id stays).",
  args: [
    { name: "id", description: "Preset id.", required: true },
    { name: "name", description: "New display name.", required: true },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude preset rename exam "Midterm cram"'],
  run(ctx) {
    const p = ctx.e.preset(ctx.args.id);
    return { preset: ctx.e.savePreset({ ...p, name: ctx.args.name }) };
  },
});

command({
  name: "preset delete",
  summary: "Delete a preset no deck uses (archived decks count).",
  args: [{ name: "id", description: "Preset id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude preset delete old-exam --yes"],
  output: "{ deleted: id }",
  run(ctx) {
    ctx.e.deletePreset(ctx.args.id);
    return { deleted: ctx.args.id };
  },
});

command({
  name: "preset decks",
  summary: "Decks that use a preset.",
  args: [{ name: "id", description: "Preset id.", required: true }],
  output: "array of { deck, archived }",
  run(ctx) {
    ctx.e.preset(ctx.args.id);
    return users(ctx.e, ctx.args.id);
  },
});

command({
  name: "preset optimize",
  summary: "Fit the preset's FSRS weights to the review history of the decks using it (Anki's Optimize).",
  description: OPTIMIZE_DESCRIPTION,
  args: [{ name: "id", description: "Preset id.", required: true }],
  flags: OPTIMIZE_FLAGS,
  writes: true,
  dryRun: "self",
  examples: ["etude preset optimize exam", "etude preset optimize exam --apply --reschedule"],
  output: OPTIMIZE_OUTPUT,
  run: (ctx) => optimizeCommand(ctx, { preset: ctx.args.id }),
});

command({
  name: "preset defaults",
  summary: "The built-in default for every scheduling setting (what applies when no deck or preset sets it).",
  noDb: true,
  output: "the default settings object",
  run: () => DEFAULT_PRESET,
});
