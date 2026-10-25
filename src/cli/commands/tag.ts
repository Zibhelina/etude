import { normTag } from "../../core/engine.ts";
import { command, group, CliError } from "../registry.ts";
import { textInput } from "../input.ts";
import { LIMIT_FLAG, OFFSET_FLAG } from "../common.ts";

group({ name: "tag", summary: "Tags: hierarchical labels (a::b), with grading instructions and descriptions", defaultVerb: "list" });

const meta = (e: any, tag: string) => e.db.get("SELECT instructions, description FROM tag_meta WHERE tag = ?", normTag(tag)) ?? { instructions: "", description: "" };
const affected = (e: any, tag: string) =>
  e.db.all("SELECT DISTINCT tag FROM item_tags WHERE tag = ? OR tag LIKE ? ESCAPE '\\' ORDER BY tag", tag, tag.replace(/[\\%_]/g, "\\$&") + "::%").map((r: any) => r.tag as string);

command({
  name: "tag list",
  summary: "Tags in use, with item counts, instructions and descriptions.",
  flags: [{ name: "prefix", type: "string", description: "Only this tag and the tags below it." }],
  output: "array of { tag, items, instructions, description }",
  run(ctx) {
    const rows = ctx.e.listTags() as { tag: string }[];
    const p = ctx.flags.prefix ? normTag(ctx.flags.prefix) : null;
    return p ? rows.filter((r) => r.tag === p || r.tag.startsWith(p + "::")) : rows;
  },
});

command({
  name: "tag show",
  summary: "A tag's instructions, description, item count and subtags.",
  args: [{ name: "tag", description: "Tag.", required: true }],
  output: "{ tag, items, instructions, description, subtags }",
  run(ctx) {
    const t = normTag(ctx.args.tag);
    const m = meta(ctx.e, t);
    const items = ctx.e.db.get("SELECT COUNT(DISTINCT t.item_id) AS n FROM item_tags t JOIN items i ON i.id = t.item_id AND i.archived = 0 WHERE t.tag = ? OR t.tag LIKE ? ESCAPE '\\'", t, t.replace(/[\\%_]/g, "\\$&") + "::%")!.n;
    return { tag: t, items, instructions: m.instructions, description: m.description, subtags: affected(ctx.e, t).filter((x: string) => x !== t) };
  },
});

command({
  name: "tag rename",
  summary: "Rename a tag on every item, with every tag below it (a::b → c::b).",
  args: [
    { name: "from", description: "Current tag.", required: true },
    { name: "to", description: "New tag.", required: true },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude tag rename delay net::delay"],
  output: "{ from, to, tags: [{ from, to }] }",
  run(ctx) {
    const from = normTag(ctx.args.from), to = normTag(ctx.args.to);
    if (!from || !to) throw new CliError("tags can't be empty");
    const like = from.replace(/[\\%_]/g, "\\$&") + "::%";
    const metaOnly = ctx.e.db.all("SELECT tag FROM tag_meta WHERE tag = ? OR tag LIKE ? ESCAPE '\\'", from, like).map((r: any) => r.tag as string);
    const tags = [...new Set([...affected(ctx.e, from), ...metaOnly])].sort();
    if (!tags.length) throw new CliError(`no item or tag setting uses "${from}"`, "not_found");
    ctx.e.renameTag(from, to);
    // Keep instructions and descriptions with the renamed tags.
    for (const t of tags) {
      const m = ctx.e.db.get("SELECT instructions, description FROM tag_meta WHERE tag = ?", t);
      if (m && (m.instructions || m.description)) {
        ctx.e.setTagMeta(to + t.slice(from.length), m);
        ctx.e.db.run("DELETE FROM tag_meta WHERE tag = ?", t);
      }
    }
    return { from, to, tags: tags.map((t: string) => ({ from: t, to: to + t.slice(from.length) })) };
  },
});

for (const field of ["instructions", "description"] as const) {
  command({
    name: `tag ${field}`,
    summary: field === "instructions" ? "Get or set a tag's AI grading instructions (apply to every item with the tag or a tag below it)." : "Get or set a tag's description.",
    args: [
      { name: "tag", description: "Tag.", required: true },
      { name: "text", description: "New text; `-` reads stdin. Omit to print the current value." },
    ],
    flags: [
      { name: "file", type: "string", description: "Read the text from a file.", placeholder: "PATH" },
      { name: "clear", type: "boolean", description: "Set it to empty." },
    ],
    writes: true,
    dryRun: true,
    examples: [`etude tag ${field} net::delay${field === "instructions" ? ' "Accept ms or s when the conversion is right."' : ""}`],
    output: `{ tag, ${field} }`,
    run(ctx) {
      const t = normTag(ctx.args.tag);
      const m = meta(ctx.e, t);
      const text = ctx.flags.clear ? "" : textInput(ctx, ctx.args.text, ctx.flags.file);
      if (text === undefined) return { tag: t, [field]: m[field] ?? "" };
      ctx.e.setTagMeta(t, { ...m, [field]: text });
      return { tag: t, [field]: text };
    },
  });
}

command({
  name: "tag items",
  summary: "Items with a tag (or a tag below it).",
  args: [{ name: "tag", description: "Tag.", required: true }],
  flags: [LIMIT_FLAG, OFFSET_FLAG, { name: "ids", type: "boolean", description: "Print only item ids." }],
  output: "same as `item list`",
  run(ctx) {
    const r = ctx.e.searchItems(`tag:"${normTag(ctx.args.tag)}"`, { limit: ctx.flags.limit, offset: ctx.flags.offset });
    return ctx.flags.ids ? r.rows.map((x) => x.id).join("\n") : r;
  },
});
