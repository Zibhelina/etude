// Command definitions. Help, `etude commands` and docs/cli.md are all generated from this table.
import type { Etude } from "../core/engine.ts";

export type FlagType = "string" | "boolean" | "number" | "json";

export interface FlagSpec {
  name: string;
  type: FlagType;
  description: string;
  short?: string;
  /** Other long names accepted for this flag (old spellings). */
  alias?: string[];
  multiple?: boolean;
  default?: unknown;
  /** Allowed values, for help and validation. */
  values?: string[];
  placeholder?: string;
}

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Takes every remaining positional. */
  variadic?: boolean;
}

export interface Ctx {
  args: Record<string, any>;
  flags: Record<string, any>;
  dbPath: string;
  home: string;
  /** The environment the runner was given (process.env, or a test's). */
  env: Record<string, string | undefined>;
  dry: boolean;
  /** True when Ask Etude runs the command in-process rather than the user. */
  agent?: boolean;
  /** Undeclared `--name value` pairs, for commands with `dynamicFlags`. */
  extra: [string, string][];
  /** The open collection. Throws for commands marked `noDb`. */
  readonly e: Etude;
  /** Whole stdin as text. Only one input per command may read it. */
  stdin(): string;
  /** Progress or notes for humans; goes to stderr, never stdout. */
  note(msg: string): void;
}

export interface CommandSpec {
  /** "group verb", or a single word for top-level commands. */
  name: string;
  summary: string;
  description?: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  examples?: string[];
  /** Changes the database or files. */
  writes?: boolean;
  /** Accepts --dry-run. `true`: the runner wraps the command in a transaction it rolls back. `"self"`: the command handles it. */
  dryRun?: boolean | "self";
  /** Refuses to run without --yes. */
  confirm?: boolean;
  /** Old spelling kept working; listed in the catalog, hidden from help. */
  legacy?: boolean;
  aliasOf?: string;
  /** What stdout carries on success. */
  output?: string;
  /** Doesn't open the database. */
  noDb?: boolean;
  /** Also accepts `--<name> value` / `--<name>-file path` for names not declared (item fields). */
  dynamicFlags?: boolean;
  run(ctx: Ctx): unknown;
}

export interface GroupSpec {
  name: string;
  summary: string;
  /** Verb run by `etude <group>` alone. */
  defaultVerb?: string;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "db", type: "string", description: "Database file. Defaults to $ETUDE_DB, then $ETUDE_HOME/etude.db, then ~/.etude/etude.db.", placeholder: "PATH" },
  { name: "json", type: "boolean", description: "Use JSON output (also the default)." },
  { name: "pretty", type: "boolean", description: "Indent JSON output (the default when stdout is a terminal)." },
  { name: "compact", type: "boolean", description: "One-line JSON output (the default when stdout is not a terminal)." },
  { name: "format", type: "string", description: "Output format. `table` renders lists for humans.", values: ["json", "table"], default: "json" },
  { name: "help", type: "boolean", short: "h", description: "Show help for the command." },
];

export const DRY_RUN_FLAG: FlagSpec = { name: "dry-run", type: "boolean", description: "Show what would change without writing anything." };
export const YES_FLAG: FlagSpec = { name: "yes", type: "boolean", short: "y", description: "Confirm a destructive operation." };

export const EXIT_CODES = [
  { exit: 0, code: "ok", meaning: "Success." },
  { exit: 1, code: "internal", meaning: "Unexpected failure (a bug, or the database is unreadable)." },
  { exit: 2, code: "usage", meaning: "Bad arguments, unknown command, or a destructive command without --yes." },
  { exit: 3, code: "not_found", meaning: "A deck, item, card, type, preset or attempt doesn't exist." },
  { exit: 4, code: "validation", meaning: "Input was rejected (fields, settings, search syntax, a failing pack or type check)." },
  { exit: 5, code: "conflict", meaning: "The operation clashes with existing state (id taken, preset or type in use, already rated)." },
  { exit: 6, code: "external", meaning: "An AI provider or the network failed." },
] as const;

export type ErrorCode = (typeof EXIT_CODES)[number]["code"];

export class CliError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(message: string, code: ErrorCode = "usage", details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get exit(): number {
    return EXIT_CODES.find((c) => c.code === this.code)?.exit ?? 1;
  }
}

/** A result to print on stdout while still failing with this error (e.g. `pack check`). */
export class Failed {
  output: unknown;
  error: CliError;
  constructor(output: unknown, error: CliError) {
    this.output = output;
    this.error = error;
  }
}

/** Returned by long-running commands (serve) so the runner leaves the collection open. */
export const KEEP_OPEN = Symbol("keep-open");

export const GROUPS: GroupSpec[] = [];
export const COMMANDS: CommandSpec[] = [];

export function group(g: GroupSpec) {
  GROUPS.push(g);
}

export function command(c: CommandSpec) {
  if (COMMANDS.some((o) => o.name === c.name)) throw new Error(`command ${c.name} defined twice`);
  COMMANDS.push(c);
}

/** Every flag a command accepts, including the shared ones. */
export function flagsOf(c: CommandSpec): FlagSpec[] {
  return [...(c.flags ?? []), ...(c.dryRun ? [DRY_RUN_FLAG] : []), ...(c.confirm ? [YES_FLAG] : [])];
}

export function catalog(version: string) {
  return {
    etude: "cli/1",
    version,
    usage: "etude <group> <verb> [args] [flags]",
    globalFlags: GLOBAL_FLAGS.map(flagJson),
    exitCodes: EXIT_CODES,
    groups: GROUPS.map((g) => ({ ...g, commands: COMMANDS.filter((c) => c.name.startsWith(g.name + " ") && !c.legacy).map((c) => c.name) })),
    commands: COMMANDS.map((c) => ({
      name: c.name,
      summary: c.summary,
      ...(c.description ? { description: c.description } : {}),
      args: (c.args ?? []).map((a) => ({ name: a.name, description: a.description, required: !!a.required, variadic: !!a.variadic })),
      flags: flagsOf(c).map(flagJson),
      examples: c.examples ?? [],
      writes: !!c.writes,
      dryRun: !!c.dryRun,
      confirm: !!c.confirm,
      ...(c.output ? { output: c.output } : {}),
      ...(c.legacy ? { legacy: true, aliasOf: c.aliasOf } : {}),
    })),
  };
}

function flagJson(f: FlagSpec) {
  return {
    name: `--${f.name}`,
    type: f.type,
    description: f.description,
    ...(f.short ? { short: `-${f.short}` } : {}),
    ...(f.alias ? { alias: f.alias.map((a) => `--${a}`) } : {}),
    ...(f.multiple ? { multiple: true } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
    ...(f.values ? { values: f.values } : {}),
  };
}

/** Registers another spelling of a command: same args, flags and handler, hidden from help. */
export function alias(name: string, target: string, opts: { summary?: string; visible?: boolean } = {}) {
  const t = COMMANDS.find((c) => c.name === target);
  if (!t) throw new Error(`alias ${name}: no command ${target}`);
  if (opts.visible) command({ ...t, name, summary: opts.summary ?? t.summary, examples: (t.examples ?? []).map((x) => x.replace(`etude ${target}`, `etude ${name}`)) });
  else command({ ...t, name, summary: opts.summary ?? `Same as \`etude ${target}\`.`, legacy: true, aliasOf: target, examples: [] });
}
