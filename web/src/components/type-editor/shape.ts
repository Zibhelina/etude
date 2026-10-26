// What the type editor saves. No imports and no DOM, so the server's tests can check it too.

interface FieldShape {
  name: string;
  label?: string;
  description?: string;
  required?: boolean;
  private?: boolean;
  default?: unknown;
  editor?: string;
  language?: string;
}

interface TypeShape {
  description?: string;
  faces?: string[];
  facesWhen?: string;
  fields: FieldShape[];
  titleField?: string;
  prepare?: string;
  template: { html: string; css?: string; js?: string };
  grader: { kind: string };
  instructions?: string;
  updated?: string;
  builtin?: boolean;
  assetFiles?: unknown;
}

/**
 * The exact shape `saveType` and `PUT /api/types/:id` accept. Keys the editor has no control for
 * (`demo`, `metrics`, a field's `language`...) pass through, so saving never drops them.
 */
export function exportShape<T extends TypeShape>(def: T): T {
  const { updated: _u, builtin: _b, assetFiles: _a, ...rest } = def;
  const g: { kind: string; code?: string; vision?: boolean; instructions?: string } = { ...def.grader };
  if (g.kind === "self" || g.kind === "ai") delete g.code;
  if (g.kind === "self" || g.kind === "script") {
    delete g.vision;
    delete g.instructions;
  }
  const out = {
    ...rest,
    description: def.description ?? "",
    fields: def.fields.map(cleanField),
    template: { html: def.template.html, css: def.template.css ?? "", js: def.template.js ?? "" },
    grader: g,
  } as unknown as T;
  if (!def.faces?.length) delete out.faces;
  if (!def.facesWhen?.trim()) delete out.facesWhen;
  if (!def.titleField) delete out.titleField;
  if (!def.prepare?.trim()) delete out.prepare;
  if (!def.instructions?.trim()) delete out.instructions;
  return out;
}

/** A field without the empty values its form leaves behind. */
export function cleanField<F extends FieldShape>(f: F): F {
  const out = { ...f };
  if (!f.label?.trim()) delete out.label;
  if (!f.description?.trim()) delete out.description;
  if (!f.required) delete out.required;
  if (!f.private) delete out.private;
  if (f.default === undefined) delete out.default;
  if (!f.editor) delete out.editor;
  if (!f.language) delete out.language;
  return out;
}
