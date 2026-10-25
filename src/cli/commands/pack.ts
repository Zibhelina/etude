import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initSandbox } from "../../core/sandbox.ts";
import { Etude } from "../../core/engine.ts";
import { command, group, CliError, Failed } from "../registry.ts";
import { parseJson, readSource } from "../input.ts";
import { DECK_FLAG, QUERY_FLAG } from "../common.ts";
import { checkPack } from "../pack-check.ts";

group({ name: "pack", summary: "Packs: JSON files with decks, presets, tags, types and items (import, export, check, scaffold)" });

command({
  name: "pack import",
  summary: "Add or update everything in one or more packs. Idempotent: items match by id and keep their scheduling.",
  description:
    "Each pack runs in one transaction: if any item fails, nothing from that pack is written. With --dry-run the import runs and is rolled back, so the report shows exactly what would be created, updated or left unchanged. Run `etude pack check` first for generator and field checks across many seeds.",
  args: [{ name: "files", description: "Pack files; `-` reads one pack from stdin.", required: true, variadic: true }],
  writes: true,
  dryRun: "self",
  examples: ["etude pack import course.pack.json --dry-run", "etude pack import course.pack.json"],
  output: "array of { file, presets, decks, types: { created, updated, unchanged }, items: { created, updated, unchanged }, tags, errors }; with --dry-run, { dryRun: true, reports: [that array] }",
  run(ctx) {
    const reports = ctx.args.files.map((f: string) => ({ file: f, ...ctx.e.importPack(parseJson(readSource(ctx, f), f), { dryRun: ctx.dry }) }));
    return ctx.dry ? { dryRun: true, reports } : reports;
  },
});

command({
  name: "pack export",
  summary: "Write a pack of the items in a scope, with their decks, presets, tag instructions and custom types. Scheduling is not included.",
  flags: [
    DECK_FLAG,
    QUERY_FLAG,
    { name: "name", type: "string", description: "Pack name." },
    { name: "out", type: "string", short: "o", description: "Write to this file instead of stdout.", placeholder: "FILE" },
    { name: "force", type: "boolean", description: "Overwrite an existing --out file." },
  ],
  writes: true,
  examples: ['etude pack export --deck "Networks" -o net.pack.json', "etude pack export > everything.pack.json"],
  output: "the pack, or { written, items, decks, types } with --out",
  run(ctx) {
    const pack = ctx.e.exportPack({ deck: ctx.flags.deck, query: ctx.flags.query, name: ctx.flags.name });
    if (!ctx.flags.out) return pack;
    const path = resolve(ctx.flags.out);
    if (existsSync(path) && !ctx.flags.force) throw new CliError(`${path} exists (use --force)`, "conflict");
    writeFileSync(path, JSON.stringify(pack, null, 1) + "\n");
    return { written: path, items: pack.items.length, decks: pack.decks.length, types: pack.types.length };
  },
});

command({
  name: "pack check",
  summary: "Validate pack files without a database: structure per type, ids, and every generator over many seeds. Exits 4 on errors.",
  description: "Custom types defined in the pack are validated too. Items of types that exist only in your collection are accepted with --known-types (or --with-db).",
  args: [{ name: "files", description: "Pack files (`-` for stdin).", required: true, variadic: true }],
  flags: [
    { name: "seeds", type: "number", description: "Seeds to run each generator with.", default: 200 },
    { name: "known-types", type: "string", multiple: true, description: "Type ids that exist outside the pack." },
    { name: "with-db", type: "boolean", description: "Also accept every type in the collection." },
  ],
  noDb: true,
  examples: ["etude pack check course.pack.json", "etude pack check *.pack.json --seeds 1000"],
  output: "{ ok, files: [{ file, ok, items, generated, types, errors, warnings }] }",
  async run(ctx) {
    await initSandbox();
    let known: string[] = ctx.flags["known-types"];
    if (ctx.flags["with-db"]) {
      const e = await Etude.open(ctx.dbPath);
      known = [...known, ...e.listTypes().map((t) => t.id)];
      e.close();
    }
    const files = ctx.args.files.map((f: string) => {
      let pack: unknown;
      try {
        pack = JSON.parse(readSource(ctx, f));
      } catch (e) {
        if (e instanceof CliError) throw e;
        return { file: f, ok: false, items: 0, generated: 0, types: {}, errors: [`${f}: not valid JSON: ${(e as Error).message}`], warnings: [] };
      }
      return checkPack(pack, f, { knownTypes: known, seeds: ctx.flags.seeds });
    });
    const out = { ok: files.every((f: any) => f.ok), files };
    if (!out.ok) return new Failed(out, new CliError(`${files.reduce((n: number, f: any) => n + f.errors.length, 0)} error(s) in pack`, "validation"));
    return out;
  },
});

/** One small item of each built-in type, valid as is. */
export function samplePack(name: string, deck: string, prefix: string) {
  const d = (s: string) => `${deck}::${s}`;
  return {
    etude: "pack/1",
    name,
    description: "Starter pack: one item of each built-in card type. Edit, then `etude pack check` and `etude pack import`.",
    presets: [{ id: `${prefix}-default`, name: `${name} defaults`, config: { newPerDay: 20, desiredRetention: 0.9 } }],
    decks: [{ name: deck, preset: `${prefix}-default`, description: "", instructions: "Grade fairly: a correct idea in different words is correct." }],
    tags: [{ name: `${prefix}::numbers`, instructions: "Accept equivalent units when the conversion is right." }],
    types: [],
    items: [
      { id: `${prefix}.basic.1`, type: "basic", deck: d("Recall"), tags: [prefix], fields: { front: "What does **FSRS** schedule?", back: "When to review each card, from a model of memory stability and difficulty." }, source: "" },
      { id: `${prefix}.typed.1`, type: "typed", deck: d("Recall"), tags: [prefix], fields: { prompt: "Chemical symbol for **gold**?", answers: ["Au"], explanation: "From Latin *aurum*." } },
      {
        id: `${prefix}.numeric.1`,
        type: "numeric",
        deck: d("Numbers"),
        tags: [prefix, `${prefix}::numbers`],
        fields: {
          prompt: "A 1000-byte packet on a 10 Mbps link. Transmission delay in ms?",
          answer: 0.8,
          unit: "ms",
          explanation: "$d = L/R = 8000 / 10^7$ s $= 0.8$ ms",
          generator:
            "const L = rng.pick([500, 1000, 1500, 2000]); const R = rng.pick([1, 10, 100]); const ms = Number((L * 8 / (R * 1e6) * 1e3).toPrecision(6)); return { prompt: `A ${L}-byte packet on a ${R} Mbps link. Transmission delay in ms?`, answer: ms, explanation: `$d = L/R = ${L * 8} / ${R}\\\\times10^6$ s $= ${ms}$ ms` };",
        },
      },
      { id: `${prefix}.mcq.1`, type: "mcq", deck: d("Choice"), tags: [prefix], fields: { prompt: "Which of these is a **prime** number?", options: [{ text: "21" }, { text: "29", correct: true, why: "Only divisible by 1 and 29." }, { text: "33" }, { text: "39" }] } },
      { id: `${prefix}.order.1`, type: "order", deck: d("Choice"), tags: [prefix], fields: { prompt: "Order from **smallest** to **largest**.", steps: ["byte", "kilobyte", "megabyte", "gigabyte"] } },
      { id: `${prefix}.match.1`, type: "match", deck: d("Choice"), tags: [prefix], fields: { prompt: "Match each layer to its unit of data.", pairs: [["transport", "segment"], ["network", "datagram"], ["link", "frame"]] } },
      { id: `${prefix}.cloze.1`, type: "cloze", deck: d("Recall"), tags: [prefix], fields: { text: "Light travels about {{300000|300,000|3e5}} km per second, and HTTP uses port {{80::web}} by default." } },
      { id: `${prefix}.free.1`, type: "free", deck: d("Explain"), tags: [prefix], fields: { prompt: "Why does spaced repetition beat cramming for long-term retention?", reference: "Each review just before forgetting strengthens memory more than massed repetition (the spacing effect), so spreading reviews out keeps recall high with fewer total reviews.", rubric: "Must mention spacing / reviewing near the point of forgetting. Mentioning testing effect is a bonus." } },
      { id: `${prefix}.draw.1`, type: "draw", deck: d("Explain"), tags: [prefix], fields: { prompt: "Sketch a forgetting curve and show where a review resets it.", reference: "Recall probability starts at 100% and decays; a review jumps it back up, and the next decay is slower.", background: "grid" } },
    ],
  };
}

command({
  name: "pack new",
  summary: "Write a starter pack with one valid item of each built-in type, to edit.",
  args: [{ name: "file", description: "Output file (default: stdout)." }],
  flags: [
    { name: "name", type: "string", description: "Pack name.", default: "My pack" },
    { name: "deck", type: "string", description: "Top deck.", default: "My pack" },
    { name: "prefix", type: "string", description: "Item id and tag prefix.", default: "mypack" },
    { name: "force", type: "boolean", description: "Overwrite the file." },
  ],
  writes: true,
  noDb: true,
  examples: ['etude pack new physics.pack.json --deck "Physics" --prefix phys'],
  run(ctx) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(ctx.flags.prefix)) throw new CliError("--prefix must be a lowercase slug", "validation");
    const pack = samplePack(ctx.flags.name, ctx.flags.deck, ctx.flags.prefix);
    if (!ctx.args.file) return pack;
    const path = resolve(ctx.args.file);
    if (existsSync(path) && !ctx.flags.force) throw new CliError(`${path} exists (use --force)`, "conflict");
    writeFileSync(path, JSON.stringify(pack, null, 2) + "\n");
    return { written: path, items: pack.items.length, next: [`etude pack check ${ctx.args.file}`, `etude pack import ${ctx.args.file} --dry-run`] };
  },
});

command({
  name: "import",
  summary: "Old spelling of `etude pack import`.",
  args: [{ name: "files", description: "Pack files.", required: true, variadic: true }],
  writes: true,
  dryRun: "self",
  legacy: true,
  aliasOf: "pack import",
  run(ctx) {
    const reports = ctx.args.files.map((f: string) => ({ file: f, ...ctx.e.importPack(parseJson(readSource(ctx, f), f), { dryRun: ctx.dry }) }));
    return ctx.dry ? { dryRun: true, reports } : reports;
  },
});

command({
  name: "export",
  summary: "Old spelling of `etude pack export`.",
  flags: [DECK_FLAG, QUERY_FLAG, { name: "out", type: "string", short: "o", description: "Output file." }],
  writes: true,
  legacy: true,
  aliasOf: "pack export",
  run(ctx) {
    const pack = ctx.e.exportPack({ deck: ctx.flags.deck, query: ctx.flags.query });
    if (!ctx.flags.out) return pack;
    writeFileSync(ctx.flags.out, JSON.stringify(pack, null, 1) + "\n");
    return { written: ctx.flags.out, items: pack.items.length };
  },
});
