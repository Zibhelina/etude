// Help text, generated from the registry.
import { COMMANDS, EXIT_CODES, GLOBAL_FLAGS, GROUPS, flagsOf, type CommandSpec, type FlagSpec } from "./registry.ts";

export function flagLabel(f: FlagSpec): string {
  const names = [f.short ? `-${f.short}` : null, `--${f.name}`].filter(Boolean).join(", ");
  const val = f.type === "boolean" ? "" : ` <${f.placeholder ?? (f.values ? f.values.join("|") : f.type === "number" ? "N" : f.type === "json" ? "JSON" : "VALUE")}>`;
  return `${names}${val}${f.multiple ? " (repeatable)" : ""}`;
}

export function argsLabel(c: CommandSpec): string {
  return (c.args ?? []).map((a) => (a.required ? `<${a.name}${a.variadic ? "..." : ""}>` : `[${a.name}${a.variadic ? "..." : ""}]`)).join(" ");
}

const pad = (rows: [string, string][], indent = "  ") => {
  const w = Math.min(34, Math.max(...rows.map((r) => r[0].length)));
  return rows.map(([a, b]) => (a.length > w ? `${indent}${a}\n${indent}${" ".repeat(w)}  ${b}` : `${indent}${a.padEnd(w)}  ${b}`)).join("\n");
};

const visible = () => COMMANDS.filter((c) => !c.legacy);

export function topHelp(version: string): string {
  const top = visible().filter((c) => !c.name.includes(" "));
  return `etude ${version}: spaced repetition with programmable card types and AI grading

Usage: etude <group> <verb> [args] [flags]

Groups:
${pad(GROUPS.map((g) => [g.name, g.summary]))}

Commands:
${pad(top.map((c) => [c.name, c.summary]))}

Global flags:
${pad(GLOBAL_FLAGS.map((f) => [flagLabel(f), f.description]))}

Output is JSON on stdout. Errors are {"error", "code"} on stderr with a non-zero exit:
${EXIT_CODES.map((c) => `${c.exit} ${c.code}`).join(", ")}.
Run \`etude <group> --help\` for a group, \`etude commands\` for the full machine-readable catalog.
`;
}

export function groupHelp(name: string): string {
  const g = GROUPS.find((x) => x.name === name)!;
  const cmds = visible().filter((c) => c.name.startsWith(name + " "));
  return `etude ${name}: ${g.summary}

Usage: etude ${name} <verb> [args] [flags]${g.defaultVerb ? `   (\`etude ${name}\` alone runs \`${g.defaultVerb}\`)` : ""}

Verbs:
${pad(cmds.map((c) => [`${c.name.slice(name.length + 1)} ${argsLabel(c)}`.trim(), c.summary + (c.writes ? "" : "")]))}

Run \`etude ${name} <verb> --help\` for flags and examples.
`;
}

export function commandHelp(c: CommandSpec): string {
  const flags = flagsOf(c);
  const out = [`etude ${c.name}${c.args?.length ? " " + argsLabel(c) : ""}${flags.length ? " [flags]" : ""}`, "", c.summary];
  if (c.description) out.push("", c.description.trim());
  if (c.args?.length) out.push("", "Arguments:", pad(c.args.map((a) => [`${a.name}${a.variadic ? "..." : ""}`, a.description + (a.required ? "" : " (optional)")])));
  if (flags.length) out.push("", "Flags:", pad(flags.map((f) => [flagLabel(f), f.description + (f.default !== undefined && f.default !== false ? ` Default: ${JSON.stringify(f.default)}.` : "")])));
  if (c.dynamicFlags) out.push("", "Any other --<field> VALUE or --<field>-file PATH sets that field of the item (see `etude type show <type>` for field names).");
  const traits = [c.writes ? "writes" : "read-only", c.dryRun ? "supports --dry-run" : null, c.confirm ? "needs --yes" : null].filter(Boolean);
  out.push("", `(${traits.join(", ")})`);
  if (c.output) out.push("", `Output: ${c.output}`);
  if (c.examples?.length) out.push("", "Examples:", ...c.examples.map((e) => `  ${e}`));
  return out.join("\n") + "\n";
}
