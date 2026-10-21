// Standalone pack checker for authors: node scripts/check-pack.ts pack.json [more.json]
// Validates structure per built-in type and runs every generator across many seeds.
import { readFileSync } from "node:fs";

type Json = any;
const errors: string[] = [];
const warnings: string[] = [];
const err = (where: string, msg: string) => errors.push(`${where}: ${msg}`);
const warn = (where: string, msg: string) => warnings.push(`${where}: ${msg}`);

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

function checkFields(where: string, type: string, f: Json, customTypes: Set<string>) {
  const need = (k: string, ok: (v: unknown) => boolean, what: string) => {
    if (!ok(f[k])) err(where, `field "${k}" must be ${what}`);
  };
  switch (type) {
    case "basic":
      need("front", isStr, "markdown");
      need("back", isStr, "markdown");
      break;
    case "typed":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.answers) || !f.answers.length || !f.answers.every(isStr)) err(where, `"answers" must be a non-empty string array`);
      if (f.match === "regex") for (const a of f.answers ?? []) try { new RegExp(a); } catch { err(where, `bad regex ${a}`); }
      break;
    case "numeric":
      need("prompt", isStr, "markdown");
      if (Array.isArray(f.parts)) {
        if (!f.parts.length) err(where, "parts is empty");
        f.parts.forEach((p: Json, i: number) => {
          if (!isStr(p.label)) err(where, `parts[${i}].label missing`);
          if (!isNum(p.answer)) err(where, `parts[${i}].answer must be a finite number (got ${p.answer})`);
        });
      } else if (!isNum(f.answer)) err(where, `"answer" must be a finite number (got ${f.answer})`);
      break;
    case "mcq": {
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.options) || f.options.length < 2) { err(where, "options needs 2+ entries"); break; }
      if (!f.options.every((o: Json) => isStr(o.text))) err(where, "every option needs text");
      if (!f.options.some((o: Json) => o.correct === true)) err(where, "no option is marked correct");
      break;
    }
    case "order":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.steps) || f.steps.length < 3 || !f.steps.every(isStr)) err(where, "steps needs 3+ markdown strings");
      if (new Set(f.steps).size !== f.steps?.length) err(where, "steps must be distinct");
      break;
    case "match":
      need("prompt", isStr, "markdown");
      if (!Array.isArray(f.pairs) || f.pairs.length < 3) err(where, "pairs needs 3+ [left, right]");
      else if (!f.pairs.every((p: Json) => Array.isArray(p) && p.length === 2 && isStr(p[0]) && isStr(p[1]))) err(where, "each pair is [left, right] strings");
      else if (new Set(f.pairs.map((p: Json) => p[1])).size !== f.pairs.length) err(where, "right sides must be distinct");
      break;
    case "cloze": {
      need("text", isStr, "markdown");
      const n = (String(f.text ?? "").match(/\{\{[^}]+\}\}/g) ?? []).length;
      if (!n) err(where, "cloze text has no {{blanks}}");
      break;
    }
    case "free":
      need("prompt", isStr, "markdown");
      need("reference", isStr, "markdown");
      if (!isStr(f.rubric)) warn(where, "free item without a rubric grades less consistently");
      break;
    case "draw":
      need("prompt", isStr, "markdown");
      need("reference", isStr, "markdown");
      break;
    default:
      if (!customTypes.has(type)) err(where, `unknown type "${type}"`);
  }
}

for (const path of process.argv.slice(2)) {
  let pack: Json;
  try {
    pack = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    err(path, `not valid JSON: ${(e as Error).message}`);
    continue;
  }
  if (pack.etude !== "pack/1") err(path, `"etude" must be "pack/1"`);
  const customTypes = new Set<string>((pack.types ?? []).map((t: Json) => t.id));
  const ids = new Set<string>();
  const byType: Record<string, number> = {};
  let generated = 0;
  for (const [i, item] of (pack.items ?? []).entries()) {
    const where = `${path} item ${item.id ?? `#${i}`}`;
    if (!isStr(item.id) || !/^[a-z0-9][a-z0-9._-]*$/.test(item.id)) err(where, "id must be a lowercase dotted slug");
    if (ids.has(item.id)) err(where, "duplicate id");
    ids.add(item.id);
    if (!isStr(item.deck)) err(where, "deck missing");
    if (item.tags && !(Array.isArray(item.tags) && item.tags.every(isStr))) err(where, "tags must be strings");
    byType[item.type] = (byType[item.type] ?? 0) + 1;
    const f = item.fields ?? {};
    checkFields(where, item.type, f, customTypes);
    if (f.generator !== undefined) {
      generated++;
      let fn: Function;
      try {
        fn = new Function("rng", f.generator);
      } catch (e) {
        err(where, `generator does not compile: ${(e as Error).message}`);
        continue;
      }
      const seen = new Set<string>();
      for (let seed = 1; seed <= 200; seed++) {
        let out: Json;
        try {
          out = fn(makeRng(seed));
        } catch (e) {
          err(where, `generator threw on seed ${seed}: ${(e as Error).message}`);
          break;
        }
        if (!out || typeof out !== "object") { err(where, `generator returned ${typeof out} on seed ${seed}`); break; }
        const merged = { ...f, ...out };
        delete merged.generator;
        const before = errors.length;
        checkFields(`${where} (seed ${seed})`, item.type, merged, customTypes);
        if (errors.length > before) break;
        seen.add(JSON.stringify(out));
      }
      if (seen.size < 5) warn(where, `generator produced only ${seen.size} distinct variants in 200 seeds`);
    }
  }
  console.log(`${path}: ${ids.size} items, ${generated} generated, types ${JSON.stringify(byType)}`);
}
for (const w of warnings) console.log(`warning  ${w}`);
for (const e of errors) console.log(`ERROR    ${e}`);
console.log(errors.length ? `${errors.length} error(s)` : "ok");
process.exit(errors.length ? 1 : 0);
