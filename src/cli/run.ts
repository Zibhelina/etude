// The command runner: finds the command, parses flags, opens the collection, prints JSON.
import { existsSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Etude, EtudeError } from "../core/engine.ts";
import { ScriptError } from "../core/sandbox.ts";
import { AiError } from "../core/ai.ts";
import { CliError, COMMANDS, Failed, GLOBAL_FLAGS, GROUPS, KEEP_OPEN, flagsOf, type CommandSpec, type Ctx, type FlagSpec } from "./registry.ts";
import { commandHelp, groupHelp, topHelp } from "./help.ts";
import { renderTable } from "./table.ts";
import "./commands/index.ts";
import { VERSION } from "./version.ts";

export { VERSION };

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  /** Reads all of stdin. */
  stdin(): string;
  isTTY: boolean;
  env: Record<string, string | undefined>;
}

class DryRunRollback extends Error {}

const findCommand = (name: string) => COMMANDS.find((c) => c.name === name);

/** Splits argv into global flags, the command words and the rest. */
function locate(argv: string[]): { cmd?: CommandSpec; group?: string; rest: string[]; pre: string[]; unknown?: string } {
  const pre: string[] = [];
  let i = 0;
  // Global flags may come before the command.
  while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "-") {
    const name = argv[i].replace(/^-+/, "").split("=")[0];
    const spec = GLOBAL_FLAGS.find((f) => f.name === name || f.short === name);
    pre.push(argv[i]);
    if (spec && spec.type !== "boolean" && !argv[i].includes("=")) pre.push(argv[++i] ?? "");
    i++;
  }
  const w1 = argv[i];
  if (w1 === undefined) return { rest: [], pre };
  const w2 = argv[i + 1];
  if (w2 !== undefined && !w2.startsWith("-")) {
    const two = findCommand(`${w1} ${w2}`);
    if (two) return { cmd: two, rest: argv.slice(i + 2), pre };
  }
  const isGroup = GROUPS.some((g) => g.name === w1);
  const one = findCommand(w1);
  if (isGroup) {
    const g = GROUPS.find((x) => x.name === w1)!;
    if (w2 !== undefined && !w2.startsWith("-") && !one) return { group: w1, rest: argv.slice(i + 1), pre, unknown: `${w1} ${w2}` };
    if (one && (w2 === undefined || w2.startsWith("-"))) return { cmd: one, rest: argv.slice(i + 1), pre };
    const def = g.defaultVerb ? findCommand(`${w1} ${g.defaultVerb}`) : undefined;
    const rest = argv.slice(i + 1);
    if (def && !rest.some((a) => a === "--help" || a === "-h")) return { cmd: def, rest, pre, group: w1 };
    return { group: w1, rest, pre };
  }
  if (one) return { cmd: one, rest: argv.slice(i + 1), pre };
  return { rest: argv.slice(i + 1), pre, unknown: w1 };
}

/** Rewrites `--flag value` as `--flag=value` for value flags, so values may start with "-". */
function normalize(args: string[], flags: FlagSpec[], dynamic: boolean): { args: string[]; extra: [string, string][] } {
  const out: string[] = [];
  const extra: [string, string][] = [];
  const byName = new Map<string, FlagSpec>();
  for (const f of flags) {
    byName.set(f.name, f);
    for (const a of f.alias ?? []) byName.set(a, f);
  }
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (positionalOnly || a === "-" || !a.startsWith("-")) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      positionalOnly = true;
      out.push(a);
      continue;
    }
    if (a.startsWith("--")) {
      const [rawName, ...v] = a.slice(2).split("=");
      const inline = v.length ? v.join("=") : undefined;
      const spec = byName.get(rawName);
      if (spec) {
        if (spec.type === "boolean") {
          if (inline !== undefined) throw new CliError(`--${rawName} doesn't take a value`);
          out.push(`--${spec.name}`);
        } else {
          const value = inline ?? args[++i];
          if (value === undefined) throw new CliError(`--${rawName} needs a value`);
          out.push(`--${spec.name}=${value}`);
        }
        continue;
      }
      if (dynamic) {
        const value = inline ?? args[++i];
        if (value === undefined) throw new CliError(`--${rawName} needs a value`);
        extra.push([rawName, value]);
        continue;
      }
      throw new CliError(`unknown flag --${rawName}`);
    }
    // Short flags: -n 5, -y, -o file.
    const short = a.slice(1, 2);
    const spec = flags.find((f) => f.short === short);
    if (!spec) throw new CliError(`unknown flag ${a}`);
    if (spec.type === "boolean") {
      if (a.length > 2) throw new CliError(`unknown flag ${a}`);
      out.push(`--${spec.name}`);
    } else {
      const value = a.length > 2 ? a.slice(2).replace(/^=/, "") : args[++i];
      if (value === undefined) throw new CliError(`-${short} needs a value`);
      out.push(`--${spec.name}=${value}`);
    }
  }
  return { args: out, extra };
}

function convert(spec: FlagSpec, raw: string): unknown {
  if (spec.type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) throw new CliError(`--${spec.name} needs a number, got "${raw}"`);
    return n;
  }
  if (spec.values && !spec.values.includes(raw)) throw new CliError(`--${spec.name} must be one of ${spec.values.join(", ")} (got "${raw}")`);
  return raw;
}

function parse(cmd: CommandSpec, rest: string[], pre: string[]) {
  const flags = [...flagsOf(cmd), ...GLOBAL_FLAGS];
  const { args, extra } = normalize([...pre, ...rest], flags, !!cmd.dynamicFlags);
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {};
  for (const f of flags) options[f.name] = { type: f.type === "boolean" ? "boolean" : "string", ...(f.multiple ? { multiple: true } : {}) };
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new CliError((e as Error).message.split("\n")[0]);
  }
  const values: Record<string, any> = {};
  for (const f of flags) {
    const v = (parsed.values as Record<string, any>)[f.name];
    if (v === undefined) {
      if (f.default !== undefined) values[f.name] = f.default;
      else if (f.multiple) values[f.name] = [];
      continue;
    }
    values[f.name] = f.type === "boolean" ? v : f.multiple ? (v as string[]).map((x) => convert(f, x)) : convert(f, v);
  }
  // Positionals to named args.
  const pos = parsed.positionals.filter((p) => p !== "--");
  const named: Record<string, any> = {};
  const specs = cmd.args ?? [];
  let k = 0;
  for (const a of specs) {
    if (a.variadic) {
      named[a.name] = pos.slice(k);
      k = pos.length;
    } else named[a.name] = pos[k++];
    if (a.required && (named[a.name] === undefined || (Array.isArray(named[a.name]) && !named[a.name].length)))
      throw new CliError(`missing <${a.name}>. Usage: ${usageLine(cmd)}`);
  }
  if (k < pos.length) throw new CliError(`unexpected argument "${pos[k]}". Usage: ${usageLine(cmd)}`);
  return { values, named, extra };
}

export function usageLine(c: CommandSpec): string {
  const args = (c.args ?? []).map((a) => (a.required ? `<${a.name}${a.variadic ? "..." : ""}>` : `[${a.name}${a.variadic ? "..." : ""}]`));
  return ["etude", c.name, ...args, flagsOf(c).length ? "[flags]" : ""].filter(Boolean).join(" ");
}

function errorCode(e: unknown): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof EtudeError) {
    const m = e.message;
    if (e.status === 404) return new CliError(m, "not_found");
    if (e.status === 409 || /is used by|already (exists|rated)|holds \d+ item|can't be deleted|inside itself/.test(m)) return new CliError(m, "conflict");
    if (e.status === 502 || /^feedback failed/.test(m)) return new CliError(m, "external");
    return new CliError(m, "validation");
  }
  if (e instanceof ScriptError) return new CliError(e.message, "validation");
  if (e instanceof AiError) return new CliError(e.message, "external");
  return new CliError((e as Error)?.message ?? String(e), "internal");
}

/** All of stdin. A pipe can be non-blocking and empty for a moment (EAGAIN) while the writer starts. */
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1 << 16);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(nap, 0, 0, 5);
        continue;
      }
      if (code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function defaultIo(): Io {
  let cached: string | undefined;
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    stdin: () => (cached ??= process.stdin.isTTY ? "" : readStdin()),
    isTTY: !!process.stdout.isTTY,
    env: process.env,
  };
}

/** Runs one invocation. Returns the exit code; the collection stays open only for `serve`. */
export async function run(argv: string[], io: Io = defaultIo()): Promise<number> {
  let etude: Etude | null = null;
  let keepOpen = false;
  let pretty = io.isTTY;
  try {
    const loc = locate(argv);
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    if (loc.unknown) throw new CliError(`unknown command "${loc.unknown}". Run \`etude --help\` or \`etude commands\`.`);
    if (!loc.cmd) {
      io.stdout(loc.group ? groupHelp(loc.group) : topHelp(VERSION));
      return 0;
    }
    const cmd = loc.cmd;
    if (wantsHelp && !argv.slice(0, argv.indexOf("--help") >= 0 ? argv.indexOf("--help") : argv.indexOf("-h")).includes("--")) {
      io.stdout(commandHelp(cmd));
      return 0;
    }
    const { values, named, extra } = parse(cmd, loc.rest, loc.pre);
    if (values.pretty) pretty = true;
    if (values.compact) pretty = false;
    if (cmd.confirm && !values.yes && !values["dry-run"]) throw new CliError(`\`etude ${cmd.name}\` is destructive; add --yes to confirm (or --dry-run to preview)`);

    const home = resolve(io.env.ETUDE_HOME ?? join(homedir(), ".etude"));
    const envFile = join(home, ".env");
    if (existsSync(envFile) && io.env === process.env) process.loadEnvFile(envFile);
    const dbPath = resolve(values.db ?? io.env.ETUDE_DB ?? join(home, "etude.db"));
    if (!cmd.noDb) etude = await Etude.open(dbPath);

    let stdinUsed = false;
    const ctx: Ctx = {
      args: named,
      flags: values,
      extra,
      dbPath,
      home,
      env: io.env,
      dry: !!values["dry-run"],
      get e() {
        if (!etude) throw new Error(`${cmd.name} has no database open`);
        return etude;
      },
      stdin() {
        if (stdinUsed) throw new CliError("stdin (-) can only be used for one input per command");
        stdinUsed = true;
        return io.stdin();
      },
      note: (msg) => io.stderr(msg + "\n"),
    };

    let result: unknown;
    if (ctx.dry && cmd.dryRun === true && etude) {
      const e = etude;
      try {
        e.db.tx(() => {
          const r = cmd.run(ctx);
          if (r instanceof Promise) throw new Error(`${cmd.name}: async commands can't use the generic dry run`);
          result = r;
          throw new DryRunRollback();
        });
      } catch (err) {
        if (!(err instanceof DryRunRollback)) throw err;
      }
      result = withDryRun(result);
    } else result = await cmd.run(ctx);

    if (result === KEEP_OPEN) {
      keepOpen = true;
      return 0;
    }
    if (result instanceof Failed) {
      if (result.output !== undefined) print(io, result.output, values.format, pretty);
      throw result.error;
    }
    if (result !== undefined) print(io, result, values.format, pretty);
    return 0;
  } catch (e) {
    const err = errorCode(e);
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.details !== undefined) body.details = err.details;
    if (err.code === "internal" && io.env.ETUDE_DEBUG) body.stack = (e as Error)?.stack;
    io.stderr(JSON.stringify(body) + "\n");
    return err.exit;
  } finally {
    if (etude && !keepOpen) etude.close();
  }
}

function withDryRun(r: unknown) {
  if (r && typeof r === "object" && !Array.isArray(r)) return { dryRun: true, ...(r as object) };
  return { dryRun: true, result: r };
}

function print(io: Io, v: unknown, format: string | undefined, pretty: boolean) {
  // Commands return a string when their output is plain text (id lists, scaffolds printed raw).
  if (typeof v === "string") {
    io.stdout(v.endsWith("\n") ? v : v + "\n");
    return;
  }
  if (format === "table") {
    const t = renderTable(v);
    if (t !== null) {
      io.stdout(t);
      return;
    }
  }
  io.stdout(JSON.stringify(v, null, pretty ? 2 : undefined) + "\n");
}
