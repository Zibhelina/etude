import { normDeck } from "../../core/engine.ts";
import { resolveConfig } from "../../core/scheduler.ts";
import { alias, command, group, CliError } from "../registry.ts";
import { textInput } from "../input.ts";
import { applyConfigPairs, configSources, diffConfig, needsReschedule, optimizeCommand, unsetConfigKeys, CONFIG_KEYS, OPTIMIZE_DESCRIPTION, OPTIMIZE_FLAGS, OPTIMIZE_OUTPUT } from "../common.ts";

group({ name: "deck", summary: "Decks: the tree, settings inheritance, presets, description and grading instructions", defaultVerb: "list" });

command({
  name: "deck list",
  summary: "The deck tree with due counts.",
  description: "Each row has the deck's name, depth, card totals and today's queue (new, learning, review). Archived decks are hidden unless --archived.",
  flags: [{ name: "archived", type: "boolean", description: "Include archived decks." }],
  examples: ["etude deck list", "etude deck list --format table"],
  output: "array of decks: { name, depth, presetId, cards, unseen, new, learning, review, doneToday, nextDue, deadline, archived }",
  run(ctx) {
    const e = ctx.e;
    const rows = e.deckTree().map(({ at, config, description, instructions, ...d }) => ({ ...d, overrides: Object.keys(config) }));
    if (!ctx.flags.archived) return rows;
    const archived = e.db.all("SELECT name FROM decks WHERE archived = 1 ORDER BY name").map((r) => {
      const d = e.deck(r.name);
      return { id: d.id, name: d.name, presetId: d.presetId, archived: true, depth: d.name.split("::").length - 1, overrides: Object.keys(d.config) };
    });
    return [...rows, ...archived].sort((a, b) => a.name.localeCompare(b.name));
  },
});

command({
  name: "deck show",
  summary: "A deck with its effective settings and where each one comes from.",
  description:
    "`resolved` is what applies to the deck's cards. `config` is the deck's own overrides, `inherited` what applies without them (parents and preset), `presetBase` what applies without the preset. `sources` names, per setting, the layer it comes from: default, parent-preset, parent, preset or deck.",
  args: [{ name: "deck", description: "Deck name; `::` separates levels.", required: true }],
  examples: ['etude deck show "Networks::Week 1"'],
  run(ctx) {
    const e = ctx.e;
    const d = e.deck(ctx.args.deck);
    const node = e.deckTree().find((x) => x.id === d.id);
    const children = e.db.all("SELECT name FROM decks WHERE name LIKE ? ESCAPE '\\' ORDER BY name", d.name.replace(/[\\%_]/g, "\\$&") + "::%").map((r) => r.name);
    return {
      ...d,
      sources: configSources(e, d.name),
      counts: node ? { cards: node.cards, unseen: node.unseen, new: node.new, learning: node.learning, review: node.review, doneToday: node.doneToday, nextDue: node.nextDue } : null,
      subdecks: children,
    };
  },
});

command({
  name: "deck create",
  summary: "Create a deck (and any missing parents).",
  args: [{ name: "deck", description: "Full deck path, e.g. `Course::Unit 1`.", required: true }],
  flags: [
    { name: "preset", type: "string", description: "Use this preset." },
    { name: "description", type: "string", description: "Markdown description (`-` reads stdin)." },
    { name: "description-file", type: "string", description: "Read the description from a file (`-` for stdin).", placeholder: "PATH" },
    { name: "instructions", type: "string", description: "AI grading instructions for every card in the deck (`-` reads stdin)." },
    { name: "instructions-file", type: "string", description: "Read the instructions from a file.", placeholder: "PATH" },
    { name: "set", type: "string", multiple: true, description: "Own setting override, key=value (see `deck set`).", placeholder: "KEY=VALUE" },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude deck create "Physics::Waves" --preset exam --instructions "Units must be right."'],
  output: "{ created: bool, deck } with the deck as `deck show` returns it",
  run(ctx) {
    const e = ctx.e;
    const name = normDeck(ctx.args.deck);
    if (!name) throw new CliError("deck name is empty");
    const existed = !!e.db.get("SELECT 1 FROM decks WHERE name = ? COLLATE NOCASE", name);
    e.ensureDeck(name);
    const patch: Record<string, unknown> = {};
    if (ctx.flags.preset) patch.presetId = ctx.flags.preset;
    const desc = textInput(ctx, ctx.flags.description, ctx.flags["description-file"]);
    const instr = textInput(ctx, ctx.flags.instructions, ctx.flags["instructions-file"]);
    if (desc !== undefined) patch.description = desc;
    if (instr !== undefined) patch.instructions = instr;
    if (ctx.flags.set.length) patch.config = applyConfigPairs(e.deck(name).config, ctx.flags.set, e.configFor(name, { excludeOwn: true }));
    const d = Object.keys(patch).length ? e.updateDeck(name, patch) : e.deck(name);
    return { created: !existed, deck: d };
  },
});

command({
  name: "deck rename",
  summary: "Rename or move a deck, with its subdecks. Merges into an existing deck of the same name.",
  args: [
    { name: "from", description: "Current deck name.", required: true },
    { name: "to", description: "New full path. `A::B` → `C::B` moves it under C.", required: true },
  ],
  writes: true,
  dryRun: true,
  examples: ['etude deck rename "Physics::Waves" "Physics::Oscillations and waves"', 'etude deck move "Inbox::Networking" "Networks::Transport"'],
  output: "{ from, to, decks: [{ from, to }] }",
  run(ctx) {
    const e = ctx.e;
    const src = e.deck(ctx.args.from).name;
    const before = e.db.all("SELECT id, name FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\'", src, src.replace(/[\\%_]/g, "\\$&") + "::%");
    e.renameDeck(src, ctx.args.to);
    const dst = normDeck(ctx.args.to);
    return { from: src, to: dst, decks: before.map((r) => ({ from: r.name, to: dst + r.name.slice(src.length) })) };
  },
});

alias("deck move", "deck rename");

command({
  name: "deck reorder",
  summary: "Set the order of sibling decks in the deck list.",
  description:
    "Give two or more decks under the same parent (or all top level) in the order you want. Siblings you leave out keep their order after the listed ones. Subdecks move with their deck. Without an order, decks sort by name.",
  args: [{ name: "decks", description: "Full deck names, in the new order.", required: true, variadic: true }],
  writes: true,
  dryRun: true,
  examples: ['etude deck reorder "Morse code" "Networks"', 'etude deck reorder "Networks::Week 2" "Networks::Week 1"'],
  output: "{ parent, order: [full names of every sibling, in the new order] }",
  run(ctx) {
    const e = ctx.e;
    const names = (ctx.args.decks as string[]).map((n) => e.deck(n).name);
    const parents = new Set(names.map((n) => n.split("::").slice(0, -1).join("::")));
    if (parents.size > 1) throw new CliError("decks to reorder must share a parent");
    const parent = [...parents][0] ?? "";
    return { parent, order: e.reorderDecks(parent, names) };
  },
});

for (const archived of [true, false]) {
  command({
    name: archived ? "deck archive" : "deck unarchive",
    summary: archived ? "Hide a deck from the deck list and study. Cards and history are kept." : "Bring an archived deck back.",
    args: [{ name: "deck", description: "Deck name.", required: true }],
    flags: [{ name: "subdecks", type: "boolean", description: `Also ${archived ? "archive" : "unarchive"} every deck below it.` }],
    writes: true,
    dryRun: true,
    examples: [`etude deck ${archived ? "archive" : "unarchive"} "Old course" --subdecks`],
    output: "{ decks: [names changed], archived }",
    run(ctx) {
      const e = ctx.e;
      const d = e.deck(ctx.args.deck);
      const names = [d.name];
      if (ctx.flags.subdecks) names.push(...e.db.all("SELECT name FROM decks WHERE name LIKE ? ESCAPE '\\' ORDER BY name", d.name.replace(/[\\%_]/g, "\\$&") + "::%").map((r) => r.name));
      for (const n of names) e.updateDeck(n, { archived });
      return { decks: names, archived };
    },
  });
}

command({
  name: "deck delete",
  summary: "Delete an empty deck and its empty subdecks. Decks holding items can't be deleted: move or archive them.",
  args: [{ name: "deck", description: "Deck name.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ['etude deck delete "Scratch" --yes'],
  output: "{ deleted: [names] }",
  run(ctx) {
    const e = ctx.e;
    const d = e.deck(ctx.args.deck);
    const names = e.db.all("SELECT name FROM decks WHERE name = ? OR name LIKE ? ESCAPE '\\' ORDER BY name", d.name, d.name.replace(/[\\%_]/g, "\\$&") + "::%").map((r) => r.name);
    e.deleteDeck(d.name);
    return { deleted: names };
  },
});

for (const field of ["description", "instructions"] as const) {
  command({
    name: `deck ${field}`,
    summary: field === "description" ? "Get or set a deck's markdown description." : "Get or set a deck's AI grading instructions (they apply to its subdecks too).",
    description:
      field === "instructions"
        ? "The AI grader reads instructions from most to least specific: the item's rubric, its tags (deepest first), the deck and each parent deck, then the card type."
        : undefined,
    args: [
      { name: "deck", description: "Deck name.", required: true },
      { name: "text", description: "New text; `-` reads stdin. Omit to print the current value." },
    ],
    flags: [
      { name: "file", type: "string", description: "Read the new text from a file.", placeholder: "PATH" },
      { name: "clear", type: "boolean", description: "Set it to empty." },
    ],
    writes: true,
    dryRun: true,
    examples: [`etude deck ${field} "Networks"`, `etude deck ${field} "Networks" --file notes.md`],
    output: `{ deck, ${field} }`,
    run(ctx) {
      const e = ctx.e;
      const d = e.deck(ctx.args.deck);
      let text = ctx.flags.clear ? "" : textInput(ctx, ctx.args.text, ctx.flags.file);
      if (text === undefined) return { deck: d.name, [field]: d[field] };
      e.updateDeck(d.name, { [field]: text });
      return { deck: d.name, [field]: e.deck(d.name)[field], changed: d[field] !== text };
    },
  });
}

const RESCHEDULE_FLAG = { name: "reschedule", type: "boolean" as const, description: "Replay the deck's review history with the new settings afterwards (what the app offers after changing retention, steps or a deadline)." };

command({
  name: "deck set",
  summary: "Override settings on this deck (they win over its preset and parents).",
  description: `Values are JSON when they parse, text otherwise. Steps accept "1m 10m" or '["1m","10m"]'. Dates accept anything Date can read. Keys: ${CONFIG_KEYS.join(", ")}; also autoRate.good and autoRate.hard.`,
  args: [
    { name: "deck", description: "Deck name.", required: true },
    { name: "pairs", description: "key=value pairs.", required: true, variadic: true },
  ],
  flags: [
    { name: "to-preset", type: "boolean", description: "Write the values into the deck's preset instead (every deck using it changes) and drop this deck's own overrides of those keys, like “Save to preset” in the app." },
    RESCHEDULE_FLAG,
  ],
  writes: true,
  dryRun: true,
  examples: [
    'etude deck set "Networks" deadline=2026-10-23T16:30:00-07:00 desiredRetention=0.92 --reschedule',
    'etude deck set "Spanish" newPerDay=30 learningSteps="1m 10m 1h"',
    'etude deck set "Networks" newPerDay=40 --to-preset',
    'etude deck set "Typing" scheduler=drill schedulerOptions.perDay=3',
  ],
  output: "{ deck, config (own overrides), changed: { key: { from, to } } (effective values), rescheduled? }",
  run(ctx) {
    const e = ctx.e;
    const d = e.deck(ctx.args.deck);
    let after;
    const out: Record<string, unknown> = { deck: d.name };
    if (ctx.flags["to-preset"]) {
      if (!d.presetId) {
        const parts = d.name.split("::");
        const owner = parts.slice(0, -1).map((_, i) => parts.slice(0, parts.length - 1 - i).join("::")).map((n) => e.deck(n)).find((p) => p.presetId);
        const hint = owner ? ` (its settings come from "${owner.name}", which uses preset "${owner.presetId}": run this on that deck, or \`etude preset set ${owner.presetId} ...\`)` : "; attach one with `etude deck preset` or create one with `etude preset create <id> --from-deck`";
        throw new CliError(`deck "${d.name}" has no preset of its own${hint}`, "validation");
      }
      const p = e.preset(d.presetId);
      const pconfig = applyConfigPairs(p.config, ctx.args.pairs, resolveConfig(p.config));
      e.savePreset({ ...p, config: pconfig });
      const keys = ctx.args.pairs.map((x: string) => x.split("=")[0].split(".")[0]);
      const { config, removed } = unsetConfigKeys(d.config, keys.filter((k: string) => k in d.config));
      after = e.updateDeck(d.name, { config });
      Object.assign(out, { preset: d.presetId, presetConfig: pconfig, removedOverrides: removed });
    } else after = e.updateDeck(d.name, { config: applyConfigPairs(d.config, ctx.args.pairs, d.inherited) });
    const changed = diffConfig(d.resolved, after.resolved);
    Object.assign(out, { config: after.config, changed });
    if (ctx.flags.reschedule) out.rescheduled = e.reschedule({ deck: d.name }).rescheduled;
    else if (needsReschedule(changed)) out.hint = `scheduling settings changed; run \`etude card reschedule --deck "${d.name}"\` to apply them to cards already studied`;
    return out;
  },
});

command({
  name: "deck unset",
  summary: "Remove this deck's own overrides so the values are inherited again.",
  args: [
    { name: "deck", description: "Deck name.", required: true },
    { name: "keys", description: "Setting names. Omit with --all.", variadic: true },
  ],
  flags: [{ name: "all", type: "boolean", description: "Remove every override." }, RESCHEDULE_FLAG],
  writes: true,
  dryRun: true,
  examples: ['etude deck unset "Networks" deadline', 'etude deck unset "Networks" --all'],
  output: "{ deck, removed, config, changed }",
  run(ctx) {
    const e = ctx.e;
    const d = e.deck(ctx.args.deck);
    const keys: string[] = ctx.flags.all ? Object.keys(d.config) : ctx.args.keys;
    if (!keys.length && !ctx.flags.all) throw new CliError("name the settings to reset, or --all");
    const { config, removed } = unsetConfigKeys(d.config, keys);
    const after = e.updateDeck(d.name, { config });
    const changed = diffConfig(d.resolved, after.resolved);
    const out: Record<string, unknown> = { deck: d.name, removed, config: after.config, changed };
    if (ctx.flags.reschedule) out.rescheduled = e.reschedule({ deck: d.name }).rescheduled;
    else if (needsReschedule(changed)) out.hint = `run \`etude card reschedule --deck "${d.name}"\` to apply the change to studied cards`;
    return out;
  },
});

command({
  name: "deck optimize",
  summary: "Fit the FSRS weights this deck uses to the history of every deck sharing them (Anki's Optimize).",
  description: `The weights belong to the deck's preset, or to the deck itself when it overrides them, and --apply saves them there. ${OPTIMIZE_DESCRIPTION}`,
  args: [{ name: "deck", description: "Deck name.", required: true }],
  flags: OPTIMIZE_FLAGS,
  writes: true,
  dryRun: "self",
  examples: ['etude deck optimize "Networks"', 'etude deck optimize "Networks" --apply --reschedule'],
  output: OPTIMIZE_OUTPUT,
  run: (ctx) => optimizeCommand(ctx, { deck: ctx.args.deck }),
});

command({
  name: "deck preset",
  summary: "Attach a preset to a deck, or detach it with `none`.",
  args: [
    { name: "deck", description: "Deck name.", required: true },
    { name: "preset", description: "Preset id, or `none`.", required: true },
  ],
  flags: [{ name: "clear-overrides", type: "boolean", description: "Also drop the deck's own overrides so the preset fully applies." }, RESCHEDULE_FLAG],
  writes: true,
  dryRun: true,
  examples: ['etude deck preset "Networks" exam', 'etude deck preset "Networks" none'],
  output: "{ deck, presetId, changed }",
  run(ctx) {
    const e = ctx.e;
    const d = e.deck(ctx.args.deck);
    const id = /^(none|null|-)$/i.test(ctx.args.preset) ? null : ctx.args.preset;
    const after = e.updateDeck(d.name, { presetId: id, ...(ctx.flags["clear-overrides"] ? { config: {} } : {}) });
    const changed = diffConfig(d.resolved, after.resolved);
    const out: Record<string, unknown> = { deck: d.name, presetId: after.presetId, changed };
    if (ctx.flags.reschedule) out.rescheduled = e.reschedule({ deck: d.name }).rescheduled;
    else if (needsReschedule(changed)) out.hint = `run \`etude card reschedule --deck "${d.name}"\` to apply the change to studied cards`;
    return out;
  },
});
