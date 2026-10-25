import { existsSync } from "node:fs";
import { command, group, CliError } from "../registry.ts";

group({ name: "anki", summary: "Anki: bring an .apkg or .colpkg collection in (types, decks, items, cards, media, history)" });

command({
  name: "anki import",
  summary: "Import an Anki package: card types, presets, decks, items, cards, media and review history.",
  description:
    "Item ids come from the note guid, so importing the same package again updates its items instead of duplicating them: progress made in Etude is kept and reviews aren't imported twice. Each notetype becomes a card type (`anki-<name>`), each deck config a preset, and `::` in deck and tag names keeps its hierarchy. Imported cards keep Anki's due dates and FSRS memory state. With --dry-run the report says what would change and nothing is written. Filtered decks are skipped and their cards land in their home deck.",
  args: [{ name: "file", description: "An .apkg or .colpkg exported by Anki (legacy or current format).", required: true }],
  flags: [
    { name: "no-scheduling", type: "boolean", description: "Content only: every card starts new, with no review history or due dates." },
    { name: "deck-prefix", type: "string", description: "Nest every imported deck under this one.", placeholder: "DECK" },
  ],
  writes: true,
  dryRun: "self",
  examples: ["etude anki import spanish.apkg --dry-run", "etude anki import spanish.apkg", 'etude anki import backlog.colpkg --deck-prefix "Anki"'],
  output:
    "{ format, dryRun, scheduling, types: { created, updated, unchanged }, presets: { created, updated, unchanged }, decks, items: { created, updated, unchanged }, cards, reviews, read: { notes, cards, reviews }, media: { files, bytes }, skipped: [{ what, name, reason }] }",
  run(ctx) {
    const path = ctx.args.file;
    if (!existsSync(path)) throw new CliError(`no such file: ${path}`, "not_found");
    return ctx.e.importAnki(path, {
      dryRun: ctx.dry,
      scheduling: !ctx.flags["no-scheduling"],
      deckPrefix: ctx.flags["deck-prefix"],
    });
  },
});
