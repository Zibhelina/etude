// Card types: loading the built-ins from disk, validating custom ones, storing both.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardTypeDef, FieldSpec, GraderSpec } from "./model.ts";
import { checkSyntax } from "./sandbox.ts";

export const TYPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_KINDS = new Set(["markdown", "text", "number", "boolean", "list", "json", "code"]);
const GRADER_KINDS = new Set(["self", "script", "ai", "hybrid"]);

const read = (dir: string, file: string) => {
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
};

/**
 * A type directory holds `type.json` plus optional `template.html`, `style.css`, `card.js`,
 * `prepare.js` and `grade.js`. Files win over the same keys inside type.json.
 */
export function loadTypeDir(dir: string): CardTypeDef {
  const meta = JSON.parse(readFileSync(join(dir, "type.json"), "utf8"));
  const grade = read(dir, "grade.js");
  const grader: GraderSpec = { ...(meta.grader ?? { kind: "self" }) };
  if (grade && (grader.kind === "script" || grader.kind === "hybrid")) (grader as { code: string }).code = grade;
  return {
    ...meta,
    prepare: read(dir, "prepare.js") ?? meta.prepare,
    template: {
      html: read(dir, "template.html") ?? meta.template?.html ?? "",
      css: read(dir, "style.css") ?? meta.template?.css ?? "",
      js: read(dir, "card.js") ?? meta.template?.js ?? "",
    },
    grader,
  };
}

export function loadBuiltinTypes(root: string): CardTypeDef[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "type.json")))
    .map((d) => loadTypeDir(join(root, d.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Returns a list of problems; empty means the type can be saved. */
export function validateType(def: unknown): string[] {
  const errors: string[] = [];
  const t = def as Partial<CardTypeDef>;
  if (!t || typeof t !== "object") return ["type must be an object"];
  if (typeof t.id !== "string" || !TYPE_ID.test(t.id)) errors.push("id must be a lowercase slug (a-z, 0-9, -)");
  if (typeof t.name !== "string" || !t.name.trim()) errors.push("name is required");
  if (!Array.isArray(t.fields)) errors.push("fields must be an array");
  else {
    const names = new Set<string>();
    t.fields.forEach((f: FieldSpec, i) => {
      if (!f || typeof f.name !== "string" || !/^[A-Za-z_][\w]*$/.test(f.name)) errors.push(`fields[${i}].name must be an identifier`);
      else if (names.has(f.name)) errors.push(`field ${f.name} is defined twice`);
      else names.add(f.name);
      if (!FIELD_KINDS.has(f?.kind)) errors.push(`fields[${i}].kind must be one of ${[...FIELD_KINDS].join(", ")}`);
    });
  }
  if (t.faces !== undefined && (!Array.isArray(t.faces) || !t.faces.length || !t.faces.every((f) => typeof f === "string" && /^[\w-]+$/.test(f))))
    errors.push("faces must be a non-empty list of simple names");
  if (!t.template || typeof t.template.html !== "string") errors.push("template.html is required");
  const g = t.grader as GraderSpec | undefined;
  if (!g || !GRADER_KINDS.has(g.kind)) errors.push(`grader.kind must be one of ${[...GRADER_KINDS].join(", ")}`);
  else if ((g.kind === "script" || g.kind === "hybrid") && typeof g.code !== "string") errors.push("script graders need grader.code");
  if (errors.length) return errors;
  if (t.prepare) {
    const e = checkSyntax(t.prepare, ["fields", "face", "rng"], `${t.id}/prepare`);
    if (e) errors.push(e);
  }
  if (g && "code" in g && g.code) {
    const e = checkSyntax(g.code, ["answer", "view", "key", "fields"], `${t.id}/grade`);
    if (e) errors.push(e);
  }
  if (t.template?.js) {
    try {
      // Card scripts run in the browser, as the body of an async function.
      new Function(`return async function (etude) {\n${t.template.js}\n}`);
    } catch (e) {
      errors.push(`${t.id}/card.js: ${(e as Error).message}`);
    }
  }
  return errors;
}

export function fieldDefaults(def: CardTypeDef): Record<string, unknown> {
  return Object.fromEntries(def.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
}

/** Checks an item's fields against its type: required fields present, kinds roughly right. */
export function validateFields(def: CardTypeDef, fields: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of def.fields) {
    const v = fields[f.name];
    if (v === undefined || v === null || v === "") {
      if (f.required) errors.push(`missing field "${f.name}"`);
      continue;
    }
    const bad =
      (f.kind === "number" && typeof v !== "number") ||
      (f.kind === "boolean" && typeof v !== "boolean") ||
      (f.kind === "list" && !Array.isArray(v)) ||
      ((f.kind === "markdown" || f.kind === "text" || f.kind === "code") && typeof v !== "string");
    if (bad) errors.push(`field "${f.name}" should be ${f.kind}`);
  }
  return errors;
}
