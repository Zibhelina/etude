import { deckParts, type Etude } from "../../core/engine.ts";
import type { CardTypeDef, FieldSpec } from "../../core/model.ts";
import { alias, command, group, CliError, type Ctx } from "../registry.ts";
import { coerceField, looseValue, parseJson, readSource, slug, splitPair, textInput } from "../input.ts";
import { DECK_FLAG, FACE_FLAG, LIMIT_FLAG, OFFSET_FLAG, QUERY_FLAG, itemBrief, queryOf, resolveItems, stateName } from "../common.ts";

group({ name: "item", summary: "Items: the content (fields, tags, source) behind one or more cards", defaultVerb: "list" });

const PROPS = ["deck", "tags", "source", "notes", "type"] as const;

const TAG_FLAG = { name: "tag", type: "string" as const, short: "t", multiple: true, description: "A tag (repeatable; commas also split). `::` makes a hierarchy: course::week1." };
const FIELD_FLAGS = [
  { name: "fields", type: "string" as const, description: "Fields as a JSON object (`-` reads stdin).", placeholder: "JSON" },
  { name: "fields-file", type: "string" as const, description: "Read the fields JSON object from a file (`-` for stdin).", placeholder: "PATH" },
  { name: "set", type: "string" as const, multiple: true, description: "field=value; the value is parsed as the field's kind (numbers, lists, JSON). Prefix with `fields.` if a field shares a name with deck, tags, source or notes.", placeholder: "KEY=VALUE" },
  { name: "set-file", type: "string" as const, multiple: true, description: "field=path: read a field's text from a file (`-` for stdin).", placeholder: "KEY=PATH" },
];

const splitTags = (list: string[]) => list.flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);

function fieldSpec(def: CardTypeDef, name: string): FieldSpec | undefined {
  return def.fields.find((f) => f.name === name);
}

function knownField(def: CardTypeDef, name: string) {
  if (name === "generator") return true;
  return def.fields.some((f) => f.name === name);
}

function fieldValue(def: CardTypeDef, name: string, raw: string, fromFile = false): unknown {
  if (name === "generator") return raw;
  const spec = fieldSpec(def, name);
  if (fromFile && spec && (spec.kind === "markdown" || spec.kind === "text" || spec.kind === "code")) return raw;
  return coerceField(spec, raw);
}

/** Collects field values from --fields, --fields-file, --set, --set-file and --<field> flags. */
function collectFields(ctx: Ctx, def: CardTypeDef, base: Record<string, unknown>) {
  const fields: Record<string, unknown> = { ...base };
  const props: Record<string, unknown> = {};
  const json = textInput(ctx, ctx.flags.fields, ctx.flags["fields-file"]);
  if (json !== undefined) {
    const obj = parseJson(json, "--fields");
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new CliError("--fields must be a JSON object", "validation");
    Object.assign(fields, obj);
  }
  const unknownField = (name: string) =>
    new CliError(`"${name}" is not a field of type ${def.id} (fields: ${def.fields.map((f) => f.name).join(", ")}, generator)`, "validation");
  for (const [name, raw] of ctx.extra) {
    if (name.endsWith("-file") && knownField(def, name.slice(0, -5))) {
      const f = name.slice(0, -5);
      fields[f] = fieldValue(def, f, readSource(ctx, raw), true);
    } else if (knownField(def, name)) fields[name] = fieldValue(def, name, raw === "-" ? ctx.stdin() : raw);
    else throw new CliError(`unknown flag --${name}: ${unknownField(name).message}`);
  }
  const assign = (key: string, raw: string, fromFile: boolean) => {
    if (key.startsWith("fields.")) {
      const f = key.slice(7);
      if (!knownField(def, f)) throw unknownField(f);
      fields[f] = fieldValue(def, f, raw, fromFile);
    } else if (knownField(def, key)) fields[key] = fieldValue(def, key, raw, fromFile);
    else if ((PROPS as readonly string[]).includes(key)) props[key] = key === "tags" ? (Array.isArray(looseValue(raw)) ? looseValue(raw) : splitTags([raw])) : raw;
    else throw unknownField(key);
  };
  for (const p of ctx.flags.set ?? []) {
    const [k, v] = splitPair(p);
    assign(k, v, false);
  }
  for (const p of ctx.flags["set-file"] ?? []) {
    const [k, path] = splitPair(p, "--set-file");
    assign(k, readSource(ctx, path), true);
  }
  return { fields, props };
}

function newItemId(e: Etude, deck: string, type: string, fields: Record<string, unknown>): string {
  const base = deckParts(deck).map(slug).join(".");
  const title = slug(e.titleOf(type, fields)).split("-").slice(0, 6).join("-");
  let id = `${base}.${title}`.slice(0, 180);
  if (!e.db.get("SELECT 1 FROM items WHERE id = ?", id)) return id;
  let n = 2;
  while (e.db.get("SELECT 1 FROM items WHERE id = ?", `${id}-${n}`)) n++;
  return `${id}-${n}`;
}

const answerOut = (e: Etude, id: string, result: string) => ({ result, item: itemBrief(e, id) });

command({
  name: "item list",
  summary: "Items matching a search (one row per item, not per card).",
  args: [{ name: "query", description: "Search (see `Search language`); several words are joined.", variadic: true }],
  flags: [
    DECK_FLAG,
    { name: "order", type: "string", description: "Sort order (relevance: with free text, items whose title is or starts with a word first, otherwise the order added; due: soonest due card first, new cards last).", values: ["relevance", "added", "deck", "updated", "created", "due", "lapses", "id"], default: "relevance" },
    LIMIT_FLAG,
    OFFSET_FLAG,
    { name: "ids", type: "boolean", description: "Print only item ids, one per line (handy for piping into bulk commands)." },
  ],
  examples: ['etude item list deck:"Networks" tag:delay', "etude item list type:numeric --ids | etude item tag - -t numeric"],
  output: "{ total, rows: [{ id, type, deck, tags, title, source, cards, suspended, archived, generated, updated }] }",
  run(ctx) {
    const q = [queryOf({ deck: ctx.flags.deck }), ctx.args.query.join(" ")].filter(Boolean).join(" ");
    const r = ctx.e.searchItems(q, { limit: ctx.flags.limit, offset: ctx.flags.offset, order: ctx.flags.order });
    if (ctx.flags.ids) return r.rows.map((x) => x.id).join("\n");
    return r;
  },
});

command({
  name: "item show",
  summary: "An item with its fields, cards, scheduling, reviews and attempts.",
  args: [{ name: "id", description: "Item id.", required: true }],
  output: "{ id, type, deck, fields, tags, source, notes, archived, created, updated, cards: [...], reviews: [...], attempts: [...] }",
  run(ctx) {
    const it = ctx.e.item(ctx.args.id);
    return { ...it, cards: it.cards.map((c) => ({ ...c, stateName: stateName(c.state) })) };
  },
});

command({
  name: "item ai-edit",
  summary: "Ask the configured language model to propose changes to a card's content. Nothing is saved.",
  description: "Uses the language model configured for feedback. Pass --fields or --fields-file to work from an unsaved draft. Review the returned fields, then use `item edit --replace-fields --fields` to save them.",
  args: [{ name: "id", description: "Item id.", required: true }],
  flags: [
    { name: "instruction", type: "string", description: "Describe the change (`-` reads stdin).", placeholder: "TEXT" },
    { name: "instruction-file", type: "string", description: "Read the requested change from a file.", placeholder: "PATH" },
    ...FIELD_FLAGS.slice(0, 2),
  ],
  writes: false,
  dryRun: false,
  confirm: false,
  examples: ['etude item ai-edit net.router --instruction "Make the answer shorter and add an example"', 'etude item ai-edit sp.perro --instruction-file change.txt --fields-file draft.json'],
  output: "{ itemId, fields, changed: [fieldNames], model, ms, cost? }",
  async run(ctx) {
    const instruction = textInput(ctx, ctx.flags.instruction, ctx.flags["instruction-file"]);
    if (!instruction?.trim()) throw new CliError("--instruction or --instruction-file is required");
    const raw = textInput(ctx, ctx.flags.fields, ctx.flags["fields-file"]);
    const fields = raw === undefined ? undefined : parseJson(raw, "--fields");
    return ctx.e.suggestItemEdit(ctx.args.id, instruction, { fields });
  },
});

command({
  name: "item add",
  summary: "Add an item. Re-running with the same --id and content is a no-op.",
  description:
    "Fields come from --fields JSON, --fields-file, --set field=value, --set-file field=path, or a flag per field (`--front \"...\"`, `--back-file a.md`, `--answer 0.1`). Values are parsed by the field's kind: number fields need numbers, list fields take JSON arrays (or one string), json fields take JSON. Without --id an id is made from the deck and the first text field. If --id already exists with different content the command fails unless --upsert.",
  flags: [
    { name: "type", type: "string", description: "Card type id (see `etude type list`).", default: "basic" },
    { name: "deck", type: "string", description: "Deck path (created if missing).", placeholder: "NAME" },
    { name: "id", type: "string", description: "Stable item id, e.g. course.unit.topic-1. Generated when omitted." },
    ...FIELD_FLAGS,
    TAG_FLAG,
    { name: "source", type: "string", description: "Where the content comes from (shown after answering)." },
    { name: "notes", type: "string", description: "Private notes (`-` reads stdin)." },
    { name: "notes-file", type: "string", description: "Read notes from a file.", placeholder: "PATH" },
    { name: "upsert", type: "boolean", description: "Update the item when the id exists with different content." },
  ],
  dynamicFlags: true,
  writes: true,
  dryRun: true,
  examples: [
    'etude item add --deck "Spanish" --front "el perro" --back "the dog" -t vocab',
    'etude item add --type numeric --deck "Networks::Delay" --id net.dtrans-1 --prompt "1500 B on 10 Mbps: $d_{trans}$ in ms?" --answer 1.2 --unit ms',
    'etude item add --type mcq --deck Quiz --fields-file q.json',
    'cat prompt.md | etude item add --type free --deck Essays --prompt - --reference-file ref.md',
  ],
  output: "{ result: created|updated|unchanged, item: { id, type, deck, tags, title, cards: [{ cardId, face, state, due }] } }",
  run(ctx) {
    const e = ctx.e;
    const def = e.type(ctx.flags.type);
    const { fields, props } = collectFields(ctx, def, {});
    const deck = (props.deck as string) ?? ctx.flags.deck;
    if (!deck) throw new CliError("--deck is required");
    const tags = [...splitTags(ctx.flags.tag), ...((props.tags as string[]) ?? [])];
    const id = ctx.flags.id ?? newItemId(e, deck, def.id, fields);
    const notes = textInput(ctx, ctx.flags.notes ?? (props.notes as string), ctx.flags["notes-file"]) ?? "";
    const input = { id, type: def.id, deck, fields, tags, source: ctx.flags.source ?? (props.source as string) ?? "", notes };
    const exists = !!e.db.get("SELECT 1 FROM items WHERE id = ?", id);
    if (exists && !ctx.flags.upsert) {
      // Same content is fine (idempotent); different content needs --upsert.
      let result = "";
      e.db.tx(() => {
        result = e.upsertItem(input);
        if (result !== "unchanged") throw new CliError(`item "${id}" already exists with different content; use --upsert to update it or \`etude item edit\``, "conflict");
      });
      return answerOut(e, id, result);
    }
    return answerOut(e, id, e.upsertItem(input));
  },
});

command({
  name: "item edit",
  summary: "Change an item's fields, deck, tags, source, notes or type. Scheduling is kept.",
  description:
    "Field values merge into the existing ones; --unset removes a field; --replace-fields starts from an empty set. --tag replaces all tags; --add-tag / --remove-tag adjust them. A `--<field> VALUE` flag works like --set.",
  args: [{ name: "id", description: "Item id.", required: true }],
  flags: [
    ...FIELD_FLAGS,
    { name: "unset", type: "string", multiple: true, description: "Remove a field (back to its default)." },
    { name: "replace-fields", type: "boolean", description: "Discard existing fields first." },
    { name: "deck", type: "string", description: "Move to this deck." },
    { name: "type", type: "string", description: "Change the card type (fields must fit the new type)." },
    TAG_FLAG,
    { name: "add-tag", type: "string", multiple: true, description: "Add a tag." },
    { name: "remove-tag", type: "string", multiple: true, description: "Remove a tag." },
    { name: "source", type: "string", description: "New source." },
    { name: "notes", type: "string", description: "New notes (`-` reads stdin)." },
    { name: "notes-file", type: "string", description: "Read notes from a file.", placeholder: "PATH" },
  ],
  dynamicFlags: true,
  writes: true,
  dryRun: true,
  examples: ["etude item edit net.dtrans-1 --set answer=1.2 --set unit=ms", "etude item edit sp.perro --back-file back.md --add-tag review", 'etude item edit q1 --set tags=\'["a","b"]\' --unset extra'],
  output: "{ result, changed: [keys], item }",
  run(ctx) {
    const e = ctx.e;
    const cur = e.item(ctx.args.id);
    const def = e.type(ctx.flags.type ?? cur.type);
    const { fields, props } = collectFields(ctx, def, ctx.flags["replace-fields"] ? {} : cur.fields);
    for (const f of ctx.flags.unset) {
      if (!(f in fields)) throw new CliError(`item has no field "${f}"`, "validation");
      delete fields[f];
    }
    let tags = cur.tags;
    if (ctx.flags.tag.length || props.tags) tags = [...splitTags(ctx.flags.tag), ...((props.tags as string[]) ?? [])];
    const rm = new Set(splitTags(ctx.flags["remove-tag"]));
    tags = [...new Set([...tags.filter((t) => !rm.has(t)), ...splitTags(ctx.flags["add-tag"])])];
    const next = {
      id: cur.id,
      type: def.id,
      deck: ctx.flags.deck ?? (props.deck as string) ?? cur.deck,
      fields,
      tags,
      source: ctx.flags.source ?? (props.source as string) ?? cur.source,
      notes: textInput(ctx, ctx.flags.notes ?? (props.notes as string), ctx.flags["notes-file"]) ?? cur.notes,
      archived: cur.archived,
    };
    const changed = (["type", "deck", "source", "notes"] as const).filter((k) => next[k] !== cur[k]) as string[];
    if (JSON.stringify(next.tags) !== JSON.stringify(cur.tags)) changed.push("tags");
    for (const k of new Set([...Object.keys(cur.fields), ...Object.keys(fields)])) if (JSON.stringify(cur.fields[k]) !== JSON.stringify(fields[k])) changed.push(`fields.${k}`);
    const result = e.upsertItem(next);
    return { result, changed, item: itemBrief(e, cur.id) };
  },
});

const BULK = [DECK_FLAG, QUERY_FLAG];
const idsArg = { name: "ids", description: "Item ids; `-` reads ids from stdin, one per line. Or use --query / --deck.", variadic: true };

command({
  name: "item move",
  summary: "Move items to another deck.",
  args: [idsArg],
  flags: [{ name: "to", type: "string", description: "Destination deck (created if missing).", placeholder: "DECK" }, ...BULK],
  writes: true,
  dryRun: true,
  examples: ['etude item move q1 q2 --to "Networks::Review"', 'etude item move --query "tag:hard" --to "Hard ones"'],
  output: "{ count, ids, deck }",
  run(ctx) {
    if (!ctx.flags.to) throw new CliError("--to <deck> is required");
    const ids = resolveItems(ctx, ctx.args.ids);
    ctx.e.moveItems(ids, ctx.flags.to);
    return { count: ids.length, ids, deck: ctx.e.deck(ctx.flags.to).name };
  },
});

for (const verb of ["tag", "untag"] as const) {
  command({
    name: `item ${verb}`,
    summary: verb === "tag" ? "Add tags to items." : "Remove tags from items.",
    args: [idsArg],
    flags: [{ ...TAG_FLAG, description: `Tag to ${verb === "tag" ? "add" : "remove"} (repeatable; commas split).` }, ...BULK],
    writes: true,
    dryRun: true,
    examples: [`etude item ${verb} q1 q2 -t exam::core`, `etude item ${verb} --query "deck:Physics prop:lapses>=3" -t leech`],
    output: "{ count, ids, tags }",
    run(ctx) {
      const tags = splitTags(ctx.flags.tag);
      if (!tags.length) throw new CliError("give at least one -t <tag>");
      const ids = resolveItems(ctx, ctx.args.ids);
      if (verb === "tag") ctx.e.tagItems(ids, tags);
      else ctx.e.tagItems(ids, [], tags);
      return { count: ids.length, ids, tags };
    },
  });
}

for (const archived of [true, false]) {
  command({
    name: archived ? "item archive" : "item unarchive",
    summary: archived ? "Archive items: hidden from study and search, history kept. The safe way to remove content." : "Restore archived items.",
    args: [idsArg],
    flags: BULK,
    writes: true,
    dryRun: true,
    examples: [archived ? 'etude item archive --query "tag:outdated"' : "etude item unarchive q1"],
    output: "{ count, ids }",
    run(ctx) {
      const ids = resolveItems(ctx, ctx.args.ids, archived ? {} : { archived: "only" });
      ctx.e.setArchived(ids, archived);
      return { count: ids.length, ids };
    },
  });
}

command({
  name: "item delete",
  summary: "Permanently delete items with their cards and review history. Prefer `item archive`.",
  args: [idsArg],
  flags: [...BULK, { name: "archived", type: "boolean", description: "With --query: match archived items too." }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude item delete scratch.1 --yes", 'etude item delete --query "deck:Scratch" --archived --dry-run'],
  output: "{ count, ids }",
  run(ctx) {
    const ids = resolveItems(ctx, ctx.args.ids, ctx.flags.archived ? { archived: "include" } : {});
    ctx.e.deleteItems(ids);
    return { count: ids.length, ids };
  },
});

command({
  name: "item duplicate",
  summary: "Copy an item's content (not its scheduling) under a new id.",
  args: [{ name: "id", description: "Item to copy.", required: true }],
  flags: [
    { name: "id", type: "string", description: "Id for the copy. Default: <id>-2, -3, ...", alias: ["new-id"] },
    { name: "to", type: "string", description: "Put the copy in this deck.", placeholder: "DECK" },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude item duplicate net.dtrans-1", "etude item duplicate q1 --id q1-reverse --to Other"],
  output: "{ id, from, item }",
  run(ctx) {
    const e = ctx.e;
    const src = ctx.args.id;
    const id = e.duplicateItem(src, ctx.flags.id);
    if (ctx.flags.to) e.moveItems([id], ctx.flags.to);
    return { id, from: src, item: itemBrief(e, id) };
  },
});

command({
  name: "item preview",
  summary: "What a card of this item shows (view), for a seed. The answer key only with --with-key.",
  description: "Doesn't record anything. For generated items each seed is a different variant; the same seed always gives the same one.",
  args: [{ name: "id", description: "Item id.", required: true }],
  flags: [
    { name: "seed", type: "number", description: "Variant seed.", default: 1 },
    FACE_FLAG,
    { name: "with-key", type: "boolean", description: "Include the private answer key and the generated fields. Don't show these to a learner before they answer." },
  ],
  examples: ["etude item preview net.dtrans-1 --seed 7", "etude item preview q1 --with-key"],
  output: "{ itemId, face, seed, view, key?, fields? }",
  run(ctx) {
    const e = ctx.e;
    const it = e.item(ctx.args.id);
    const face = ctx.flags.face ?? it.cards[0]?.face ?? "main";
    const p = e.prepare(it.id, face, ctx.flags.seed);
    return { itemId: it.id, face, seed: p.seed, view: p.view, ...(ctx.flags["with-key"] ? { key: p.key, fields: p.fields } : {}) };
  },
});

command({
  name: "item variants",
  summary: "Sample a generated item's outputs over several seeds (with keys), to check a generator.",
  args: [{ name: "id", description: "Item id.", required: true }],
  flags: [
    { name: "count", type: "number", short: "n", description: "How many variants.", default: 5 },
    { name: "seed", type: "number", description: "First seed.", default: 1 },
    FACE_FLAG,
  ],
  examples: ["etude item variants net.dtrans-1 -n 10"],
  output: "{ itemId, generated, distinct, variants: [{ seed, view, key }] }",
  run(ctx) {
    const e = ctx.e;
    const it = e.item(ctx.args.id);
    const face = ctx.flags.face ?? it.cards[0]?.face ?? "main";
    const n = Math.max(1, Math.min(500, ctx.flags.count));
    const variants = Array.from({ length: n }, (_, i) => {
      const p = e.prepare(it.id, face, ctx.flags.seed + i);
      return { seed: p.seed, view: p.view, key: p.key };
    });
    return { itemId: it.id, generated: typeof it.fields.generator === "string", distinct: new Set(variants.map((v) => JSON.stringify(v.key))).size, variants };
  },
});

alias("item search", "item list");
alias("show", "item show", { summary: "Old spelling of `etude item show`." });
