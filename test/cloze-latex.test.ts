import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import katex from "katex";
import { marked } from "marked";

const MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\d))/g;
const CODE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\4(?!`)/g;

function md(text: string): string {
  const stash: string[] = [];
  const code: string[] = [];
  const guarded = String(text ?? "").replace(CODE, (m) => `\u0001${code.push(m) - 1}\u0001`);
  const src = guarded.replace(MATH, (m) => {
    let display = false;
    let body = m;
    if (m.startsWith("$$")) (display = true), (body = m.slice(2, -2));
    else if (m.startsWith("\\[")) (display = true), (body = m.slice(2, -2));
    else if (m.startsWith("\\(")) body = m.slice(2, -2);
    else body = m.slice(1, -1);
    stash.push(katex.renderToString(body.trim(), { displayMode: display, throwOnError: false, strict: "ignore", output: "html" }));
    return `\u0000${stash.length - 1}\u0000`;
  });
  const restored = src.replace(/\u0001(\d+)\u0001/g, (_, i) => code[Number(i)]);
  const html = marked.parse(restored, { gfm: true, breaks: false }) as string;
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

function renderClozeHtml(fieldsText: string): string {
  const prepareSrc = readFileSync(join(process.cwd(), "types/cloze/prepare.js"), "utf8");
  const cardSrc = readFileSync(join(process.cwd(), "types/cloze/card.js"), "utf8");
  const prepared = new Function("fields", prepareSrc)({ text: fieldsText });
  const box = { innerHTML: "", textContent: "", classList: { add() {} }, querySelector: () => null };
  const etude = {
    view: prepared.view,
    answer: null,
    md,
    escape: (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
    $: () => box,
    $$: () => [],
    getAnswer() {},
    onResult() {},
    submit() {},
  };
  new Function("etude", cardSrc)(etude);
  return box.innerHTML;
}

describe("Issue #50: LaTeX cloze blanks", () => {
  it("replaces cloze blanks inside display and inline LaTeX instead of showing ETUDEBLANK0X", () => {
    const bayes = renderClozeHtml("Bayes' theorem: $$P(A \\mid B) = \\frac{P(B \\mid A) \\, {{P(A)}}}{{{P(B)}}}$$");
    assert.ok(!bayes.includes("ETUDEBLANK"), `rendered HTML must not leak ETUDEBLANK placeholder: ${bayes}`);
    assert.ok(bayes.includes('data-i="0"'), "first blank inside numerator must render as input");
    assert.ok(bayes.includes('data-i="1"'), "second blank inside denominator must render as input");
    assert.ok(bayes.includes("katex"), "LaTeX math must still render via KaTeX");
  });

  it("handles mixed plain text, inline math, exponents, and code spans", () => {
    const html = renderClozeHtml("The {{constant}} in $e^{{{i\\pi}}} + 1 = 0$ is written as `{{not_a_blank}}`? No, check {{zero::0}}.");
    assert.ok(!html.includes("ETUDEBLANK"), "no placeholder text should remain");
    assert.ok(html.includes('data-i="0"'));
    assert.ok(html.includes('data-i="1"'));
    assert.ok(html.includes('data-i="2"'));
  });
});
