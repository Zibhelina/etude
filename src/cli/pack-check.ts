// Static checks for pack files: structure per built-in type, ids, and every generator over many seeds.
// Runs without a database; `etude pack check` and scripts/check-pack.ts both use it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltinTypes, validateType } from "../core/types.ts";
import { runScript } from "../core/sandbox.ts";
import math from "../../runtime/mathexpr.js";

type Json = any;

export interface PackCheck {
  file: string;
  ok: boolean;
  items: number;
  generated: number;
  types: Record<string, number>;
  errors: string[];
  warnings: string[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number) {
  const next = mulberry32(seed);
  return {
    seed,
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    float: (min: number, max: number, d = 2) => Number((min + next() * (max - min)).toFixed(d)),
    pick: <T>(arr: T[]) => arr[Math.floor(next() * arr.length)],
    shuffle: <T>(arr: T[]) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    bool: (p = 0.5) => next() < p,
  };
}

const isStr = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

const BUILTIN_TYPES = loadBuiltinTypes(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "types"));
export const BUILTIN_TYPE_IDS = BUILTIN_TYPES.map((t) => t.id);

function checkFields(err: (m: string) => void, warn: (m: string) => void, type: string, f: Json, customTypes: Map<string, Json>, knownTypes: Set<string>) {
  const need = (k: string, ok: (v: unknown) => boolean, what: string) => {
    if (!ok(f[k])) err(`field "${k}" must be ${what}`);
  };
  switch (type) {
    case "basic":
      need("front", isStr, "markdown");
      need("back", isStr, "markdown");
      break;
    case "typed":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.answers) || !f.answers.length || !f.answers.every(isStr)) err(`"answers" must be a non-empty string array`);
      if (f.match === "regex") for (const a of f.answers ?? []) try { new RegExp(a); } catch { err(`bad regex ${a}`); }
      break;
    case "numeric":
      need("prompt", isStr, "markdown");
      if (Array.isArray(f.parts)) {
        if (!f.parts.length) err("parts is empty");
        f.parts.forEach((p: Json, i: number) => {
          if (!isStr(p.label)) err(`parts[${i}].label missing`);
          if (!isNum(p.answer)) err(`parts[${i}].answer must be a finite number (got ${p.answer})`);
        });
      } else if (!isNum(f.answer)) err(`"answer" must be a finite number (got ${f.answer})`);
      break;
    case "mcq":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.options) || f.options.length < 2) { err("options needs 2+ entries"); break; }
      if (!f.options.every((o: Json) => isStr(o.text))) err("every option needs text");
      if (!f.options.some((o: Json) => o.correct === true)) err("no option is marked correct");
      break;
    case "order":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.steps) || f.steps.length < 3 || !f.steps.every(isStr)) err("steps needs 3+ markdown strings");
      if (new Set(f.steps).size !== f.steps?.length) err("steps must be distinct");
      break;
    case "match":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.pairs) || f.pairs.length < 3) err("pairs needs 3+ [left, right]");
      else if (!f.pairs.every((p: Json) => Array.isArray(p) && p.length === 2 && isStr(p[0]) && isStr(p[1]))) err("each pair is [left, right] strings");
      else if (new Set(f.pairs.map((p: Json) => p[1])).size !== f.pairs.length) err("right sides must be distinct");
      break;
    case "cloze": {
      need("text", isStr, "markdown");
      const n = (String(f.text ?? "").match(/\{\{[^}]+\}\}/g) ?? []).length;
      if (!n) err("cloze text has no {{blanks}}");
      break;
    }
    case "free":
      need("prompt", isStr, "markdown");
      need("reference", isStr, "markdown");
      if (!isStr(f.rubric)) warn("free item without a rubric grades less consistently");
      break;
    case "draw":
      need("prompt", isStr, "markdown");
      need("reference", isStr, "markdown");
      break;
    case "math":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.answers) || !f.answers.length || !f.answers.every(isStr)) err(`"answers" must be a non-empty string array`);
      else
        for (const a of f.answers) {
          try {
            math.parse(a);
          } catch (e) {
            err(`answer ${JSON.stringify(a)} can't be read: ${(e as Error).message}`);
          }
        }
      if (f.form !== undefined && !["any", "exact", "same"].includes(f.form)) err(`"form" must be any, exact or same`);
      break;
    case "code": {
      need("prompt", isStr, "markdown");
      if (f.tests === undefined) {
        if (!isStr(f.rubric) && !isStr(f.reference)) warn("code item without tests needs a reference or rubric for the AI grader");
        break;
      }
      if (!Array.isArray(f.tests) || !f.tests.length || !f.tests.every((t: Json) => Array.isArray(t) && t.length === 2 && isStr(t[0]))) {
        err(`"tests" must be [["expression", expected], ...]`);
        break;
      }
      const lang = String(f.language ?? "python").toLowerCase();
      if (!["js", "javascript", "node", "mjs", "ecmascript"].includes(lang)) warn(`tests only run for JavaScript; this ${lang} item will be graded by AI`);
      else if (isStr(f.reference)) {
        // The reference solution has to pass its own tests.
        const def = BUILTIN_TYPES.find((t) => t.id === "code")!;
        try {
          const out = runScript<{ score?: number; feedback?: string }>((def.grader as { code: string }).code, {
            params: ["answer", "view", "key", "fields"],
            args: { answer: f.reference, view: { language: f.language }, key: { tests: f.tests }, fields: f },
            where: "code/grade",
            timeoutMs: 2000,
          });
          if (out?.score !== 1) err(`the reference fails its tests: ${out?.feedback ?? "no result"}`);
        } catch (e) {
          err(`the reference couldn't be tested: ${(e as Error).message}`);
        }
      } else warn("add a reference solution so the tests can be checked against it");
      break;
    }
    default: {
      const builtin = BUILTIN_TYPES.find((t) => t.id === type);
      if (builtin) {
        for (const spec of builtin.fields) if (spec.required && (f[spec.name] === undefined || f[spec.name] === null || f[spec.name] === "")) err(`missing field "${spec.name}"`);
        break;
      }
      const def = customTypes.get(type);
      if (def) {
        for (const spec of def.fields ?? []) if (spec.required && (f[spec.name] === undefined || f[spec.name] === null || f[spec.name] === "")) err(`missing field "${spec.name}"`);
      } else if (!knownTypes.has(type)) err(`unknown type "${type}"`);
    }
  }
}

/**
 * Checks one parsed pack. `knownTypes`: type ids that exist outside the pack (e.g. custom types
 * already in the collection), so items using them aren't flagged.
 */
export function checkPack(pack: Json, file = "pack", opts: { knownTypes?: string[]; seeds?: number } = {}): PackCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seeds = opts.seeds ?? 200;
  const out: PackCheck = { file, ok: false, items: 0, generated: 0, types: {}, errors, warnings };
  if (!pack || typeof pack !== "object") {
    errors.push(`${file}: not a JSON object`);
    return out;
  }
  if (pack.etude !== "pack/1") errors.push(`${file}: "etude" must be "pack/1"`);
  const customTypes = new Map<string, Json>((pack.types ?? []).map((t: Json) => [t?.id, t]));
  for (const t of pack.types ?? []) for (const e of validateType(t)) errors.push(`${file} type ${t?.id ?? "?"}: ${e}`);
  const known = new Set([...BUILTIN_TYPE_IDS, ...(opts.knownTypes ?? [])]);
  const presetIds = new Set((pack.presets ?? []).map((p: Json) => p?.id));
  for (const d of pack.decks ?? []) {
    if (!isStr(d?.name)) errors.push(`${file}: a deck has no name`);
    if (d?.preset && !presetIds.has(d.preset)) warnings.push(`${file} deck ${d.name}: preset "${d.preset}" isn't in this pack (it must already exist where you import)`);
  }
  const ids = new Set<string>();
  for (const [i, item] of (pack.items ?? []).entries()) {
    const where = `${file} item ${item?.id ?? `#${i}`}`;
    const err = (m: string) => errors.push(`${where}: ${m}`);
    const warn = (m: string) => warnings.push(`${where}: ${m}`);
    if (!isStr(item.id) || !/^[a-z0-9][a-z0-9._:-]*$/.test(item.id)) err("id must be a lowercase dotted slug");
    if (ids.has(item.id)) err("duplicate id");
    ids.add(item.id);
    if (!isStr(item.deck)) err("deck missing");
    if (item.tags && !(Array.isArray(item.tags) && item.tags.every(isStr))) err("tags must be strings");
    out.types[item.type] = (out.types[item.type] ?? 0) + 1;
    const f = item.fields ?? {};
    checkFields(err, warn, item.type, f, customTypes, known);
    if (f.generator !== undefined) {
      out.generated++;
      let fn: Function;
      try {
        fn = new Function("rng", f.generator);
      } catch (e) {
        err(`generator does not compile: ${(e as Error).message}`);
        continue;
      }
      const seen = new Set<string>();
      for (let seed = 1; seed <= seeds; seed++) {
        let res: Json;
        try {
          res = fn(makeRng(seed));
        } catch (e) {
          err(`generator threw on seed ${seed}: ${(e as Error).message}`);
          break;
        }
        if (!res || typeof res !== "object") {
          err(`generator returned ${typeof res} on seed ${seed}`);
          break;
        }
        const merged = { ...f, ...res };
        delete merged.generator;
        const before = errors.length;
        checkFields((m) => errors.push(`${where} (seed ${seed}): ${m}`), () => {}, item.type, merged, customTypes, known);
        if (errors.length > before) break;
        seen.add(JSON.stringify(res));
      }
      if (seen.size < 5) warn(`generator produced only ${seen.size} distinct variants in ${seeds} seeds`);
    }
  }
  out.items = ids.size;
  out.ok = !errors.length;
  return out;
}
