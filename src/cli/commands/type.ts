import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CardTypeDef } from "../../core/model.ts";
import { resolveConfig, suggestRating } from "../../core/scheduler.ts";
import { loadTypeDir, validateType, TYPE_ID } from "../../core/types.ts";
import { alias, command, group, CliError, Failed, type Ctx } from "../registry.ts";
import { answerValue, looseValue, parseJson, readSource, textInput } from "../input.ts";

group({ name: "type", summary: "Card types: fields, template (HTML/CSS/JS), prepare script and grader", defaultVerb: "list" });

/** A type from a directory, a type.json / pack-style JSON file, or `-` (JSON on stdin). */
export function loadTypeSource(ctx: Ctx, src: string): CardTypeDef {
  if (src !== "-" && existsSync(src) && statSync(src).isDirectory()) {
    if (!existsSync(join(src, "type.json"))) throw new CliError(`${src} has no type.json`, "validation");
    return loadTypeDir(src);
  }
  const obj = parseJson(readSource(ctx, src), src === "-" ? "stdin" : src);
  // A pack with exactly one type is accepted too.
  if (obj?.etude === "pack/1") {
    if (obj.types?.length !== 1) throw new CliError("that pack has no single type to import; use `etude pack import`", "validation");
    return obj.types[0];
  }
  return obj;
}

const strip = (def: any): CardTypeDef => {
  const { updated, builtin, ...rest } = def;
  return rest;
};

export function writeTypeDir(def: CardTypeDef, dir: string) {
  mkdirSync(dir, { recursive: true });
  const { template, prepare, grader, ...meta } = strip(def) as any;
  const g = { ...grader };
  const files: string[] = ["type.json", "template.html"];
  if (g.code) {
    writeFileSync(join(dir, "grade.js"), g.code);
    files.push("grade.js");
    delete g.code;
  }
  writeFileSync(join(dir, "type.json"), JSON.stringify({ ...meta, grader: g }, null, 2) + "\n");
  writeFileSync(join(dir, "template.html"), template?.html ?? "");
  if (template?.css) writeFileSync(join(dir, "style.css"), template.css), files.push("style.css");
  if (template?.js) writeFileSync(join(dir, "card.js"), template.js), files.push("card.js");
  if (prepare) writeFileSync(join(dir, "prepare.js"), prepare), files.push("prepare.js");
  return files;
}

/** Sample fields for previews: --fields JSON, --item (an existing item's fields), or each field's default/example. */
function sampleFields(ctx: Ctx, def: CardTypeDef): Record<string, unknown> {
  const json = textInput(ctx, ctx.flags.fields, ctx.flags["fields-file"]);
  let fields: Record<string, unknown> = {};
  if (ctx.flags.item) fields = { ...ctx.e.item(ctx.flags.item).fields };
  if (json !== undefined) Object.assign(fields, parseJson(json, "--fields"));
  if (ctx.flags.item || json !== undefined) return fields;
  // Placeholder values so a template can be previewed with nothing given.
  for (const f of def.fields) {
    if (f.default !== undefined) continue;
    fields[f.name] = f.kind === "number" ? 1 : f.kind === "boolean" ? false : f.kind === "list" ? [`${f.name} 1`] : f.kind === "json" ? {} : `Sample ${f.name}`;
  }
  return fields;
}

const PREVIEW_FLAGS = [
  { name: "fields", type: "string" as const, description: "Sample fields as JSON (`-` reads stdin).", placeholder: "JSON" },
  { name: "fields-file", type: "string" as const, description: "Read sample fields from a file.", placeholder: "PATH" },
  { name: "item", type: "string" as const, description: "Use an existing item's fields as the sample." },
  { name: "seed", type: "number" as const, description: "Seed for prepare scripts and generators.", default: 1 },
  { name: "face", type: "string" as const, description: "Face to render (types with several faces)." },
  { name: "from", type: "string" as const, description: "Use an unsaved type from a directory or JSON file instead of the stored one.", placeholder: "DIR|FILE" },
];

const defFor = (ctx: Ctx): CardTypeDef => (ctx.flags.from ? loadTypeSource(ctx, ctx.flags.from) : strip(ctx.e.type(ctx.args.id)));

command({
  name: "type list",
  summary: "Card types with their grader, item count and whether they are shipped, edited or custom.",
  output: "array of { id, name, description, builtin, shipped, edited, updated, items, grader }",
  run: (ctx) => ctx.e.listTypes(),
});

command({
  name: "type show",
  summary: "A type's full definition: fields (with kinds, private flags, defaults), template, prepare and grader code.",
  args: [{ name: "id", description: "Type id.", required: true }],
  flags: [{ name: "fields-only", type: "boolean", description: "Only the field list (what an item of this type takes)." }],
  examples: ["etude type show numeric --fields-only"],
  run(ctx) {
    const def = ctx.e.type(ctx.args.id);
    return ctx.flags["fields-only"] ? { id: def.id, faces: def.faces ?? ["main"], grader: def.grader.kind, fields: def.fields } : def;
  },
});

command({
  name: "type export",
  summary: "Write a type as editable files (type.json, template.html, style.css, card.js, prepare.js, grade.js), or print it as JSON.",
  args: [{ name: "id", description: "Type id.", required: true }],
  flags: [
    { name: "out", type: "string", short: "o", description: "Directory to write. Default: ./<id>.", placeholder: "DIR" },
    { name: "json", type: "boolean", description: "Print the definition as one JSON object instead of writing files." },
  ],
  writes: true,
  examples: ["etude type export numeric -o my-numeric", "etude type export numeric --json > numeric.json"],
  output: "{ written: dir, files } or the definition with --json",
  run(ctx) {
    const def = strip(ctx.e.type(ctx.args.id));
    if (ctx.flags.json) return def;
    const dir = resolve(ctx.flags.out ?? def.id);
    return { written: dir, files: writeTypeDir(def, dir) };
  },
});

command({
  name: "type import",
  summary: "Create or update a type from a directory, a JSON file, or JSON on stdin (`-`). Saving an edited built-in makes it yours.",
  description: "The type is validated first (fields, grader, script syntax). Items of the type get cards for any new faces. Unchanged definitions are a no-op.",
  args: [{ name: "source", description: "Type directory, type.json / JSON file, or `-`.", required: true }],
  flags: [{ name: "id", type: "string", description: "Save under this id instead of the one in the source." }],
  writes: true,
  dryRun: true,
  examples: ["etude type import ./vocab", "etude type import vocab.json --dry-run", "etude type export basic --json | jq '.id=\"basic2\"' | etude type import -"],
  output: "{ result: created|updated|unchanged, type: { id, name, fields, grader } }",
  run(ctx) {
    const def = loadTypeSource(ctx, ctx.args.source);
    if (ctx.flags.id) def.id = ctx.flags.id;
    const errors = validateType(def);
    if (errors.length) throw new CliError(`invalid type: ${errors.join("; ")}`, "validation", { errors });
    const old = ctx.e.db.get("SELECT def FROM types WHERE id = ?", def.id);
    const saved = ctx.e.saveType(def);
    const result = !old ? "created" : old.def === JSON.stringify(saved) ? "unchanged" : "updated";
    return { result, type: { id: saved.id, name: saved.name, faces: saved.faces ?? ["main"], fields: saved.fields.map((f) => f.name), grader: saved.grader.kind } };
  },
});

alias("type create", "type import", { summary: "Same as `etude type import` (creates when the id is new)." });
alias("type update", "type import", { summary: "Same as `etude type import` (updates when the id exists)." });

command({
  name: "type validate",
  summary: "Check a type definition without saving it. Exits 4 when it has problems.",
  args: [{ name: "source", description: "Type directory, JSON file, `-`, or a stored type id.", required: true }],
  output: "{ id, ok, errors }",
  run(ctx) {
    const src = ctx.args.source;
    const def = existsSync(src) || src === "-" ? loadTypeSource(ctx, src) : strip(ctx.e.type(src));
    const errors = validateType(def);
    const out = { id: (def as any)?.id ?? null, ok: !errors.length, errors };
    return errors.length ? new Failed(out, new CliError(`invalid type: ${errors.length} problem(s)`, "validation")) : out;
  },
});

command({
  name: "type preview",
  summary: "Run a type on sample fields and show what the card gets (view) and what grading uses (key).",
  description: "Works on stored types or, with --from, on an unsaved directory. Placeholder values fill fields you don't give. Nothing is stored.",
  args: [{ name: "id", description: "Type id (ignored with --from).", required: false }],
  flags: PREVIEW_FLAGS,
  examples: ['etude type preview numeric --fields \'{"prompt":"2+2?","answer":4}\'', "etude type preview --from ./unit-circle --item showcase.unit-circle.mixed"],
  output: "{ errors, view, key, seed }",
  async run(ctx) {
    if (!ctx.flags.from && !ctx.args.id) throw new CliError("give a type id or --from <dir>");
    const def = defFor(ctx);
    const r = await ctx.e.previewType(def, sampleFields(ctx, def), { seed: ctx.flags.seed, face: ctx.flags.face });
    return { type: def.id, ...r };
  },
});

command({
  name: "type test-grade",
  summary: "Run a type's grader on an answer without saving anything.",
  description:
    "Script and hybrid graders run locally on sample fields (or --item's fields). AI graders need a real card: pass --item and the configured AI providers are called (no attempt is stored). Answers are JSON when they parse (`[\"1.2\"]`, `{\"l0\":\"r0\"}`), text otherwise.",
  args: [{ name: "id", description: "Type id (ignored with --from).", required: false }],
  flags: [
    ...PREVIEW_FLAGS,
    { name: "answer", type: "string", description: "The answer (`-` reads stdin).", placeholder: "VALUE" },
    { name: "answer-file", type: "string", description: "Read the answer from a file.", placeholder: "PATH" },
  ],
  examples: ['etude type test-grade typed --fields \'{"prompt":"Capital of France?","answers":["Paris"]}\' --answer paris', "etude type test-grade --item showcase.math.factor --answer \"(x-2)(x-3)\""],
  output: "{ grade: { score, verdict, details, feedback }, key }",
  async run(ctx) {
    const raw = textInput(ctx, ctx.flags.answer, ctx.flags["answer-file"]);
    if (raw === undefined) throw new CliError("--answer is required");
    const answer = answerValue(raw);
    let def: CardTypeDef;
    if (ctx.flags.from || ctx.args.id) def = defFor(ctx);
    else if (ctx.flags.item) def = strip(ctx.e.type(ctx.e.item(ctx.flags.item).type));
    else throw new CliError("give a type id, --from <dir> or --item <id>");
    const kind = def.grader.kind;
    if (kind === "ai" && !ctx.flags.from) {
      if (!ctx.flags.item) throw new CliError(`type ${def.id} is graded by AI; pass --item <id> to grade against a real card`);
      const it = ctx.e.item(ctx.flags.item);
      const card = it.cards.find((c) => !ctx.flags.face || c.face === ctx.flags.face) ?? it.cards[0];
      const { grade, prep } = await ctx.e.grade(card.id, ctx.flags.seed, answer);
      return { type: def.id, item: it.id, seed: ctx.flags.seed, answer, grade, key: prep.key };
    }
    const r = await ctx.e.previewType(def, sampleFields(ctx, def), { seed: ctx.flags.seed, face: ctx.flags.face, answer });
    if (r.errors?.length && !("grade" in r && r.grade)) return new Failed({ type: def.id, ...r }, new CliError(r.errors.join("; "), "validation"));
    const grade = (r as any).grade ?? null;
    // Previews have no deck, so the rating comes from the default thresholds.
    if (grade && grade.suggested == null && typeof grade.score === "number") grade.suggested = suggestRating(grade.score, resolveConfig({}));
    return { type: def.id, seed: ctx.flags.seed, answer, grade, key: (r as any).key, errors: r.errors };
  },
});

command({
  name: "type reset",
  summary: "Restore an edited built-in type to the shipped version.",
  args: [{ name: "id", description: "Built-in type id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude type reset numeric --yes"],
  run(ctx) {
    ctx.e.resetType(ctx.args.id);
    return { reset: ctx.args.id };
  },
});

command({
  name: "type delete",
  summary: "Delete a custom type no item uses (archived items count).",
  args: [{ name: "id", description: "Type id.", required: true }],
  writes: true,
  dryRun: true,
  confirm: true,
  examples: ["etude type delete my-old-type --yes"],
  run(ctx) {
    ctx.e.type(ctx.args.id);
    ctx.e.deleteType(ctx.args.id);
    return { deleted: ctx.args.id };
  },
});

command({
  name: "type copy",
  summary: "Copy a type (built-in or custom) under a new id, as a starting point.",
  args: [
    { name: "id", description: "Type to copy.", required: true },
    { name: "new-id", description: "Id for the copy.", required: true },
  ],
  flags: [{ name: "name", type: "string", description: "Display name for the copy." }],
  writes: true,
  dryRun: true,
  examples: ['etude type copy numeric numeric-units --name "Numeric with units"'],
  run(ctx) {
    if (ctx.e.db.get("SELECT 1 FROM types WHERE id = ?", ctx.args["new-id"])) throw new CliError(`type "${ctx.args["new-id"]}" already exists`, "conflict");
    const def = strip(ctx.e.type(ctx.args.id));
    const saved = ctx.e.saveType({ ...def, id: ctx.args["new-id"], name: ctx.flags.name ?? `${def.name} (copy)` });
    return { created: saved.id, from: ctx.args.id };
  },
});

const SCAFFOLD: Record<string, (id: string, name: string) => Record<string, string>> = {
  script: (id, name) => ({
    "type.json":
      JSON.stringify(
        {
          id,
          name,
          description: "Type a short answer; checked by script.",
          fields: [
            { name: "prompt", kind: "markdown", required: true, description: "The question." },
            { name: "answer", kind: "text", required: true, private: true, description: "The accepted answer." },
            { name: "explanation", kind: "markdown", private: true, description: "Shown after answering." },
          ],
          grader: { kind: "script" },
        },
        null,
        2,
      ) + "\n",
    "template.html": `<div class="prose">{{md:prompt}}</div>
<input class="e-input" id="answer" autocomplete="off" spellcheck="false" placeholder="Your answer" autofocus>
<template data-on="result">
  <div class="e-reveal">
    <div><div class="e-section-title">Answer</div><div class="prose e-answer">{{answer}}</div></div>
    {{#explanation}}<div class="prose">{{md:explanation}}</div>{{/explanation}}
  </div>
</template>
`,
    "card.js": `// Runs in the card's sandboxed frame. \`etude\` is the card API: view, getAnswer, submit, onResult, $, md, escape.
const input = etude.$("#answer");
if (etude.answer != null) input.value = etude.answer;
etude.getAnswer(() => input.value);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); etude.submit(); }
});
etude.onResult(({ grade }) => {
  input.disabled = true;
  input.classList.add(grade.score >= 1 ? "is-correct" : "is-wrong");
});
`,
    "prepare.js": `// Body of function (fields, face, rng): returns what the card shows (view) and what grading needs (key).
// Private fields belong in key, never in view.
return {
  view: { prompt: fields.prompt },
  key: { answer: fields.answer, explanation: fields.explanation ?? "" },
};
`,
    "grade.js": `// Body of function (answer, view, key, fields): returns { score: 0..1, details?, feedback? }.
// \`std\` has normalize, looseEqual, parseNumber, within, lis, round.
return { score: std.looseEqual(answer, key.answer) ? 1 : 0 };
`,
    "style.css": `/* Card styles. The runtime provides .prose, .e-input, .e-reveal, .e-section-title, .e-answer. */\n`,
  }),
  self: (id, name) => ({
    "type.json": JSON.stringify({ id, name, description: "Front and back, self-rated.", fields: [{ name: "front", kind: "markdown", required: true }, { name: "back", kind: "markdown", required: true, private: true }], grader: { kind: "self" } }, null, 2) + "\n",
    "template.html": `<div class="prose">{{md:front}}</div>\n<template data-on="result">\n  <div class="e-reveal"><div class="prose e-answer">{{md:back}}</div></div>\n</template>\n`,
  }),
  ai: (id, name) => ({
    "type.json":
      JSON.stringify(
        {
          id,
          name,
          description: "Open answer graded by AI against a reference.",
          fields: [
            { name: "prompt", kind: "markdown", required: true },
            { name: "reference", kind: "markdown", required: true, private: true },
            { name: "rubric", kind: "markdown", private: true },
          ],
          grader: { kind: "ai" },
          instructions: "Judge whether the answer shows the understanding the reference and rubric describe. Wording does not matter.",
        },
        null,
        2,
      ) + "\n",
    "template.html": `<div class="prose">{{md:prompt}}</div>\n<textarea class="e-input" id="answer" rows="5" placeholder="Your answer"></textarea>\n<template data-on="result">\n  <div class="e-reveal"><div><div class="e-section-title">Reference</div><div class="prose e-answer">{{md:reference}}</div></div></div>\n</template>\n`,
    "card.js": `const input = etude.$("#answer");\nif (etude.answer != null) input.value = etude.answer;\netude.getAnswer(() => input.value);\netude.onResult(() => { input.disabled = true; });\n`,
  }),
};

command({
  name: "type new",
  summary: "Scaffold a minimal working type directory to edit and then `etude type import`.",
  args: [{ name: "id", description: "New type id (lowercase slug).", required: true }],
  flags: [
    { name: "out", type: "string", short: "o", description: "Directory to create. Default: ./<id>.", placeholder: "DIR" },
    { name: "name", type: "string", description: "Display name." },
    { name: "grader", type: "string", description: "Starting grader.", values: ["script", "self", "ai"], default: "script" },
    { name: "force", type: "boolean", description: "Write into a non-empty directory." },
  ],
  writes: true,
  noDb: true,
  examples: ["etude type new vocab -o types/vocab && $EDITOR types/vocab/template.html && etude type import types/vocab"],
  output: "{ written: dir, files, next }",
  run(ctx) {
    const id = ctx.args.id;
    if (!TYPE_ID.test(id)) throw new CliError("type id must be a lowercase slug (a-z, 0-9, -)", "validation");
    const dir = resolve(ctx.flags.out ?? id);
    if (existsSync(dir) && readdirSync(dir).length && !ctx.flags.force) throw new CliError(`${dir} is not empty (use --force)`, "conflict");
    mkdirSync(dir, { recursive: true });
    const files = SCAFFOLD[ctx.flags.grader](id, ctx.flags.name ?? id.replace(/-/g, " ").replace(/^./, (c: string) => c.toUpperCase()));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return { written: dir, files: Object.keys(files), next: [`etude type validate ${dir}`, `etude type preview --from ${dir}`, `etude type import ${dir}`] };
  },
});

alias("types", "type list", { summary: "Old spelling of `etude type list`." });
command({
  name: "type-export",
  summary: "Old spelling of `etude type export`.",
  args: [{ name: "id", description: "Type id.", required: true }],
  flags: [{ name: "out", type: "string", short: "o", description: "Directory.", placeholder: "DIR" }],
  writes: true,
  legacy: true,
  aliasOf: "type export",
  run(ctx) {
    const def = strip(ctx.e.type(ctx.args.id));
    const dir = ctx.flags.out ?? def.id;
    writeTypeDir(def, dir);
    return { written: dir };
  },
});
command({
  name: "type-import",
  summary: "Old spelling of `etude type import`.",
  args: [{ name: "source", description: "Type directory or JSON file.", required: true }],
  writes: true,
  legacy: true,
  aliasOf: "type import",
  run: (ctx) => ctx.e.saveType(loadTypeSource(ctx, ctx.args.source)),
});

command({
  name: "type frame",
  summary: "The HTML document a card of this type renders in (what the app loads into its sandboxed iframe).",
  description: "Runtime and KaTeX assets load from --base, so open the file while `etude serve` runs. Useful to debug a template outside the app.",
  args: [{ name: "id", description: "Type id (ignored with --from).", required: false }],
  flags: [
    { name: "from", type: "string", description: "Use an unsaved type from a directory or JSON file.", placeholder: "DIR|FILE" },
    { name: "base", type: "string", description: "Server URL the frame loads its runtime from.", default: "http://127.0.0.1:4610/" },
    { name: "out", type: "string", short: "o", description: "Write the HTML to a file instead of stdout.", placeholder: "FILE" },
  ],
  examples: ["etude type frame numeric -o numeric.html"],
  output: "the HTML, or { written } with --out",
  async run(ctx) {
    if (!ctx.flags.from && !ctx.args.id) throw new CliError("give a type id or --from <dir>");
    const { cardFrame } = await import("../../server/frame.ts");
    const html = cardFrame(defFor(ctx), ctx.flags.base.endsWith("/") ? ctx.flags.base : ctx.flags.base + "/");
    if (!ctx.flags.out) return html;
    writeFileSync(resolve(ctx.flags.out), html);
    return { written: resolve(ctx.flags.out) };
  },
});
