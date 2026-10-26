// The assistant's command cheat-sheet: the commands it uses most, with their exact arguments and
// flags, built from the CLI registry when first asked for so it never drifts from the real CLI.
// Pack examples come from the built-in types' own field lists, so they stay valid too.
import type { Etude } from "./engine.ts";

/** The commands the assistant reaches for in ordinary work, in the order they're listed. */
export const CHEATSHEET_COMMANDS = [
  "deck list",
  "deck show",
  "deck create",
  "deck rename",
  "deck move",
  "deck archive",
  "deck delete",
  "item list",
  "item show",
  "item add",
  "item edit",
  "item move",
  "item tag",
  "item delete",
  "search",
  "type list",
  "type show",
  "tag list",
  "tag rename",
  "theme list",
  "theme set",
  "theme create",
  "market list",
  "market install",
  "pack import",
  "pack export",
  "anki import",
  "media add",
  "stats overview",
  "stats weak",
];

/** Types with a short example item in the cheat-sheet. Only ones that exist get one. */
const EXAMPLE_TYPES = ["basic", "typed", "mcq", "cloze"];

const EXAMPLES: Record<string, Record<string, unknown>> = {
  basic: { front: "What does the mitochondrion do?", back: "Makes ATP by cellular respiration." },
  typed: { prompt: "Chemical symbol for sodium?", answers: ["Na"] },
  mcq: {
    prompt: "Which organelle holds the cell's DNA?",
    options: [
      { text: "Nucleus", correct: true },
      { text: "Ribosome", correct: false },
      { text: "Golgi apparatus", correct: false },
    ],
  },
  cloze: { text: "The {{nucleus}} holds the cell's {{DNA}}." },
  numeric: { prompt: "Speed of light in km/s?", answer: 299792, tolerance: 0.01 },
};

let cached: { key: string; text: string } | null = null;

const argUsage = (a: { name: string; required?: boolean; variadic?: boolean }) =>
  a.required ? `<${a.name}${a.variadic ? "..." : ""}>` : `[${a.name}${a.variadic ? "..." : ""}]`;

/** The cheat-sheet text for the system prompt. Rebuilt only when the set of types changes. */
export async function cheatSheet(e: Etude): Promise<string> {
  const { COMMANDS, flagsOf } = await import("../cli/registry.ts");
  await import("../cli/commands/index.ts");
  const types = new Map(e.listTypes().map((t) => [t.id, t]));
  const key = [...types.keys()].join(",");
  if (cached && cached.key === key) return cached.text;

  const lines: string[] = [];
  for (const name of CHEATSHEET_COMMANDS) {
    const c = COMMANDS.find((x) => x.name === name && !x.legacy);
    if (!c) continue;
    const args = (c.args ?? []).map(argUsage).join(" ");
    const flags = flagsOf(c)
      .filter((f) => f.name !== "yes")
      .map((f) => {
        const v = f.type === "boolean" ? "" : f.values ? ` ${f.values.join("|")}` : ` ${f.placeholder ?? f.type.toUpperCase()}`;
        return `--${f.name}${v}${f.multiple ? " (repeatable)" : ""}`;
      });
    const tags = [c.confirm && "asks the user", c.writes && !c.dryRun && "writes"].filter(Boolean);
    lines.push(`- ${c.name}${args ? " " + args : ""}${flags.length ? "  " + flags.join(" ") : ""}${tags.length ? `  [${tags.join(", ")}]` : ""}: ${c.summary.split(/(?<=\.)\s/)[0]}`);
  }

  // Field lists for the common built-in types, read from their definitions.
  const fieldLines: string[] = [];
  for (const id of EXAMPLE_TYPES) {
    const t = types.get(id);
    if (!t) continue;
    const def = e.type(id);
    const fields = def.fields.map((f) => `${f.name}${f.required ? "" : "?"}:${f.kind}`).join(", ");
    fieldLines.push(`- ${id}: ${fields}`);
  }

  // A minimal pack using those types; validated against the field lists above.
  const items = EXAMPLE_TYPES.filter((id) => types.has(id) && EXAMPLES[id]).map((id, i) => ({
    id: `cells.${i + 1}`,
    type: id,
    deck: "Biology::Cells",
    fields: EXAMPLES[id],
  }));
  const pack = { etude: "pack/1", name: "Cells", decks: [{ name: "Biology::Cells" }], items };

  const text = `Command cheat-sheet (exact syntax; argv words go in etude_run's argv array, flags after them). Use etude_help only for commands not listed here.
${lines.join("\n")}

Fields of common types (? = optional):
${fieldLines.join("\n")}

Making many cards: one call, etude_run with argv ["pack","import","-"] and the pack as the json argument (an object, not a string). A minimal valid pack:
${JSON.stringify(pack)}
Item ids: a short slug per deck plus a number (re-importing the same id updates that item). Decks named by items are created automatically. Add tags only when the material has sections worth filtering by. No --dry-run is needed for a new deck from the user's material; the user can undo.`;
  cached = { key, text };
  return text;
}
