// Turning shell arguments into values: text from flags, files or stdin; key=value pairs;
// id lists; dates and durations.
import { existsSync, readFileSync } from "node:fs";
import { CliError, type Ctx } from "./registry.ts";
import type { FieldSpec } from "../core/model.ts";

/** Reads a path, or stdin for "-". */
export function readSource(ctx: Ctx, path: string): string {
  if (path === "-") return ctx.stdin();
  if (!existsSync(path)) throw new CliError(`no such file: ${path}`, "not_found");
  return readFileSync(path, "utf8");
}

/** A text value given inline (`-` means stdin) or as `--x-file` (`-` means stdin too). */
export function textInput(ctx: Ctx, inline: string | undefined, file: string | undefined): string | undefined {
  if (inline !== undefined && file !== undefined) throw new CliError("give the value inline or as a file, not both");
  if (file !== undefined) return readSource(ctx, file);
  if (inline === "-") return ctx.stdin();
  return inline;
}

export function parseJson(text: string, what: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${what} is not valid JSON: ${(e as Error).message}`, "validation");
  }
}

/** JSON when it parses, the raw string otherwise: `0.1` → 0.1, `'["a"]'` → ["a"], `hello` → "hello". */
export function looseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

/**
 * A learner's answer: JSON only when it is structured (an array, an object or a quoted string),
 * so "80" or "true" stay the text that was typed.
 */
export function answerValue(raw: string): unknown {
  const t = raw.trim();
  if (!/^[\[{"]/.test(t)) return raw;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

/** Splits `key=value`. */
export function splitPair(s: string, flag = "--set"): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw new CliError(`${flag} expects key=value, got "${s}"`);
  return [s.slice(0, i).trim(), s.slice(i + 1)];
}

/** Coerces a value to what a field of this kind stores. */
export function coerceField(spec: FieldSpec | undefined, raw: string, parsed = looseValue(raw)): unknown {
  if (!spec) return parsed;
  switch (spec.kind) {
    case "markdown":
    case "text":
    case "code":
      return raw;
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new CliError(`field "${spec.name}" needs a number, got "${raw}"`, "validation");
      return n;
    }
    case "boolean":
      if (/^(true|yes|1)$/i.test(raw)) return true;
      if (/^(false|no|0)$/i.test(raw)) return false;
      throw new CliError(`field "${spec.name}" needs true or false, got "${raw}"`, "validation");
    case "list":
      if (Array.isArray(parsed)) return parsed;
      return [raw];
    default:
      return parsed;
  }
}

/** Sets `a.b.c` inside an object, creating plain objects on the way. */
export function deepSet(obj: Record<string, any>, path: string, value: unknown) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== "object" || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)!] = value;
}

export function deepGet(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function deepDelete(obj: Record<string, any>, path: string): boolean {
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
  if (parent == null || typeof parent !== "object" || !(keys.at(-1)! in parent)) return false;
  delete parent[keys.at(-1)!];
  return true;
}

/** Positional ids, plus one per line from stdin when an argument is "-". */
export function idList(ctx: Ctx, args: string[] | undefined): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    if (a === "-") out.push(...ctx.stdin().split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    else out.push(a);
  }
  return [...new Set(out)];
}

const UNITS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "3d", "12h", "90m", "2w", "1.5d"; a leading "-" goes back in time. */
export function parseDuration(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i.exec(s.trim());
  if (!m) throw new CliError(`bad duration "${s}" (use e.g. 30m, 12h, 3d, 2w)`, "validation");
  return Number(m[1]) * UNITS[m[2].toLowerCase()];
}

/**
 * A moment from `--date` (ISO date or date-time), `--in` (duration from now) or `--now`.
 * A bare date means the start of that study day (local time, at `dayStartHour`).
 */
export function parseMoment(opts: { date?: string; in?: string; now?: boolean }, dayStartHour: number, now = new Date()): Date {
  const given = [opts.date !== undefined, opts.in !== undefined, !!opts.now].filter(Boolean).length;
  if (given !== 1) throw new CliError("give exactly one of --date, --in or --now");
  if (opts.now) return now;
  if (opts.in !== undefined) return new Date(now.getTime() + parseDuration(opts.in));
  const d = opts.date!.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, mo, da] = d.split("-").map(Number);
    return new Date(y, mo - 1, da, dayStartHour, 0, 0, 0);
  }
  if (/^(today|tomorrow)$/i.test(d)) {
    const t = new Date(now);
    if (t.getHours() < dayStartHour) t.setDate(t.getDate() - 1);
    t.setHours(dayStartHour, 0, 0, 0);
    if (/tomorrow/i.test(d)) t.setDate(t.getDate() + 1);
    return t;
  }
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) throw new CliError(`bad date "${d}" (use 2026-10-22 or an ISO date-time)`, "validation");
  return t;
}

/** "1".."4" or again/hard/good/easy. */
export function parseRating(s: string): 1 | 2 | 3 | 4 {
  const names: Record<string, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 };
  const r = names[s.toLowerCase()] ?? (/^[1-4]$/.test(s) ? (Number(s) as 1 | 2 | 3 | 4) : undefined);
  if (!r) throw new CliError(`rating must be 1-4 or again, hard, good, easy (got "${s}")`, "validation");
  return r;
}

/** "3m", "2h", "4d" between two moments, for humans reading interval previews. */
export function humanSpan(fromMs: number, toMs: number): string {
  const m = Math.max(1, Math.round((toMs - fromMs) / 60000));
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d * 10) / 10}d`.replace(".0d", "d");
  const mo = d / 30.4;
  if (mo < 12) return `${Math.round(mo * 10) / 10}mo`.replace(".0mo", "mo");
  return `${Math.round((d / 365) * 10) / 10}y`.replace(".0y", "y");
}

export const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "item";
