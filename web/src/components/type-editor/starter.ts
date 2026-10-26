// Starting points and small helpers for authoring card types.
import type { CardType } from "@/lib/api";

export const TYPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FIELD_NAME = /^[A-Za-z_]\w*$/;

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** A small type that works end to end: a prompt, a typed answer checked by script, an explanation. */
export function blankType(id: string, name: string): CardType {
  return {
    id,
    name,
    description: "",
    fields: [
      { name: "prompt", kind: "markdown", required: true },
      { name: "answer", kind: "text", required: true, private: true },
      { name: "explanation", kind: "markdown", private: true },
    ],
    template: {
      html: `<div class="prose">{{md:prompt}}</div>
<input class="e-input" id="answer" autocomplete="off" spellcheck="false" placeholder="Your answer" autofocus>
<template data-on="result">
  <div class="e-reveal">
    <div class="e-answer">{{answer}}</div>
    {{#explanation}}<div class="prose e-muted">{{md:explanation}}</div>{{/explanation}}
  </div>
</template>
`,
      css: "",
      js: `const input = etude.$("#answer");
etude.getAnswer(() => input.value);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); etude.submit(); }
});
etude.onResult(({ grade }) => {
  input.disabled = true;
  input.classList.add(grade.score >= 1 ? "is-correct" : "is-wrong");
});
`,
    },
    grader: { kind: "script", code: "return { score: std.looseEqual(answer, key.answer) ? 1 : 0 };\n" },
  };
}

export const BLANK_SAMPLE = { prompt: "What is the capital of **France**?", answer: "Paris", explanation: "Paris has been the capital since 987." };

export const PREPARE_EXAMPLE = `// Runs on the server before the card is shown. Whatever goes in \`view\` reaches the card;
// \`key\` stays on the server until the answer is graded.
return {
  view: { prompt: fields.prompt },
  key: { answer: fields.answer, explanation: fields.explanation ?? "" },
};
`;

export const GRADE_EXAMPLE = `// Return a score from 0 to 1. \`details\` reaches the card's onResult handler.
return { score: std.looseEqual(answer, key.answer) ? 1 : 0 };
`;

export { cleanField, exportShape } from "./shape";

export function fieldDefaults(def: CardType): Record<string, unknown> {
  return Object.fromEntries(def.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
}

export function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A type that hasn't been saved yet travels from the "new" dialog to the editor through sessionStorage, so a reload keeps it. */
export interface PendingType {
  def: CardType;
  sample?: Record<string, unknown>;
  /** The type it was copied from, used to pick sample data. */
  from?: string;
  /** Types-page folder to file it in once it's saved. */
  folder?: string;
}
const pendingKey = (id: string) => `etude.pendingType.${id}`;
export function stashPending(p: PendingType) {
  sessionStorage.setItem(pendingKey(p.def.id), JSON.stringify(p));
}
export function readPending(id: string): PendingType | null {
  try {
    const raw = sessionStorage.getItem(pendingKey(id));
    return raw ? (JSON.parse(raw) as PendingType) : null;
  } catch {
    return null;
  }
}
export function clearPending(id: string) {
  sessionStorage.removeItem(pendingKey(id));
}

export const GRADER_LABEL: Record<string, string> = { self: "Self-rated", script: "Script", ai: "AI", hybrid: "Hybrid" };

/** Pulls card types out of a dropped file: one type, a list of types, or a pack with `types`. */
export function typesFromJson(data: unknown): CardType[] {
  if (Array.isArray(data)) return data.filter(isTypeLike);
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.types)) return o.types.filter(isTypeLike);
    if (isTypeLike(o)) return [o as unknown as CardType];
  }
  return [];
}

function isTypeLike(x: unknown): boolean {
  return !!x && typeof x === "object" && typeof (x as any).id === "string" && typeof (x as any).template === "object";
}
