import { command, group } from "../registry.ts";

group({ name: "media", summary: "Media copied into the collection's own folder" });

command({
  name: "media path",
  summary: "Show the collection's media folder.",
  writes: false,
  examples: ["etude media path"],
  output: "{ path }",
  run: (ctx) => ({ path: ctx.e.mediaDir }),
});

command({
  name: "media add",
  summary: "Copy an image, audio or video file into the collection's media folder.",
  description: "The original stays intact. Identical files share a copy. Files may be up to 100 MiB. Insert the returned URL into a card field; the card then works even if the original is moved or deleted.",
  args: [{ name: "file", description: "Local path or file:// URL.", required: true }],
  writes: true,
  dryRun: "self",
  confirm: false,
  examples: ["etude media add ~/Pictures/diagram.png", "etude media add ./pronunciation.mp3 --dry-run"],
  output: "{ name, file, path, url, mime, kind, bytes, created, dryRun }",
  run: (ctx) => ctx.e.importMedia(ctx.args.file, { dryRun: ctx.dry }),
});
