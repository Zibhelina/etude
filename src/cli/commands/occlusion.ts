import { command, group, CliError } from "../registry.ts";
import { parseJson, textInput } from "../input.ts";
import { parseBoxSpec, OcclusionError } from "../../core/occlusion.ts";

group({ name: "occlusion", summary: "Image occlusion: cover parts of an image, one card per box or group" });

command({
  name: "occlusion add",
  summary: "Make an image occlusion item from an image file and boxes.",
  description:
    "Copies the image into the collection's media (or reuses a `/media/...` URL) and creates an `occlusion` item. Each `--box` is `x,y,w,h=Label`: fractions of the image from 0 to 1, or pixels with --px. `x,y,w,h@group=Label` puts boxes in a group, asked together as one card; a label takes alternatives (`Aorta|aortic arch`); a box without a label is shown and self-graded. --boxes reads the same as JSON (`[{ x, y, w, h, label, group, id }]`). Without --id the id comes from the deck and the image's content, so running the same command twice is a no-op. To change an existing item later use `etude item edit <id> --set boxes='[...]'` or --upsert here.",
  args: [{ name: "image", description: "Image file (path or file:// URL), or a /media/... URL already in the collection.", required: true }],
  flags: [
    { name: "deck", type: "string", description: "Deck path (created if missing).", placeholder: "NAME" },
    { name: "box", type: "string", multiple: true, description: "One box, `x,y,w,h=Label` or `x,y,w,h@group=Label` (repeatable).", placeholder: "SPEC" },
    { name: "boxes", type: "string", description: "Boxes as a JSON array, or a path to a JSON file (`-` reads stdin).", placeholder: "JSON|PATH" },
    { name: "px", type: "boolean", description: "Box coordinates are pixels of the image; they're converted to fractions using its size." },
    { name: "mode", type: "string", description: "hide-all: every box covered, one asked. hide-one: only the asked box covered.", values: ["hide-all", "hide-one"], default: "hide-all" },
    { name: "header", type: "string", description: "Markdown shown above the image." },
    { name: "extra", type: "string", description: "Markdown shown after answering." },
    { name: "id", type: "string", description: "Item id. Generated from the deck and image when omitted." },
    { name: "tag", type: "string", short: "t", multiple: true, description: "A tag (repeatable; commas also split)." },
    { name: "source", type: "string", description: "Where the image comes from (shown after answering)." },
    { name: "upsert", type: "boolean", description: "Update the item when the id exists with different content." },
  ],
  writes: true,
  dryRun: "self",
  examples: [
    'etude occlusion add heart.png --deck Anatomy::Heart --box "0.12,0.30,0.10,0.05=Aorta|aortic arch" --box "0.55,0.28,0.12,0.06=Pulmonary trunk"',
    'etude occlusion add plate.jpg --deck Anatomy --px --box "120,340,90,40@atria=Right atrium" --box "410,330,90,40@atria=Left atrium"',
    "etude occlusion add slide.png --deck Bio --boxes boxes.json --mode hide-one --dry-run",
  ],
  output: "{ result: created|updated|unchanged, id, image, media: { file, bytes, created } | null, boxes: [...], cards: [{ face, label }], selfGraded: [faces], dryRun }",
  run(ctx) {
    if (!ctx.flags.deck) throw new CliError("--deck is required");
    const boxes: unknown[] = [];
    try {
      for (const spec of ctx.flags.box ?? []) boxes.push(parseBoxSpec(spec));
    } catch (e) {
      if (e instanceof OcclusionError) throw new CliError(e.message, "validation");
      throw e;
    }
    if (ctx.flags.boxes !== undefined) {
      const raw = String(ctx.flags.boxes).trim();
      const text = raw.startsWith("[") ? raw : textInput(ctx, undefined, raw);
      const list = parseJson(text ?? "", "--boxes");
      if (!Array.isArray(list)) throw new CliError("--boxes must be a JSON array of boxes", "validation");
      boxes.push(...list);
    }
    if (!boxes.length) throw new CliError("give at least one --box or --boxes");
    const tags = (ctx.flags.tag ?? []).flatMap((t: string) => t.split(",")).map((t: string) => t.trim()).filter(Boolean);
    return ctx.e.addOcclusion(
      { image: ctx.args.image, boxes, deck: ctx.flags.deck, id: ctx.flags.id, px: !!ctx.flags.px, mode: ctx.flags.mode, header: ctx.flags.header, extra: ctx.flags.extra, tags, source: ctx.flags.source, upsert: !!ctx.flags.upsert },
      { dryRun: ctx.dry },
    );
  },
});
