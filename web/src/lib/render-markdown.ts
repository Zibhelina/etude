// Markdown with KaTeX math for app-side text (deck descriptions, AI feedback, agent replies, previews).
// Kept free of React and CSS imports so tests can run it in Node with a jsdom-backed DOMPurify.
import { marked } from "marked";
import katex from "katex";
import type { DOMPurify } from "dompurify";
import { sanitizeHtml } from "./sanitize.ts";

const MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)(?:\\.|[^$\n\\])+?(?<!\s)\$(?!\d))/g;
const CODE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\4(?!`)/g;

// Math is rendered before Markdown and put back after sanitizing, through private-use placeholders
// (the HTML parser would turn NUL into U+FFFD).
const OPEN = "\uE000";
const CLOSE = "\uE001";
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
/** A serialized tag (attribute values are always double-quoted, with `"` escaped), or a run of text. */
const TOKEN = /<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g;

export function renderMarkdown(text: string, purify: DOMPurify): string {
  const stash: string[] = [];
  const code: string[] = [];
  // Code keeps its dollar signs: set it aside before looking for math. Placeholder lookalikes typed by
  // the user are dropped first so they can't point at another formula.
  const guarded = text.replace(/[\uE000\uE001\u0001]/g, "").replace(CODE, (m) => `\u0001${code.push(m) - 1}\u0001`);
  const src = guarded.replace(MATH, (m) => {
    const display = m.startsWith("$$") || m.startsWith("\\[");
    const body = m.startsWith("$$") || m.startsWith("\\[") || m.startsWith("\\(") ? m.slice(2, -2) : m.slice(1, -1);
    // trust: false (the default) keeps \href, \url and \html* commands from producing links or raw HTML.
    stash.push(katex.renderToString(body.trim(), { displayMode: display, throwOnError: false, strict: "ignore", trust: false }));
    return `${OPEN}${stash.length - 1}${CLOSE}`;
  });
  const html = marked.parse(src.replace(/\u0001(\d+)\u0001/g, (_, i) => code[Number(i)]), { gfm: true, async: false }) as string;
  // The text can come from a shared pack, an Anki deck or a model: sanitize before anything is inserted.
  const clean = sanitizeHtml(purify, html);
  // KaTeX's own markup goes back only where the placeholder sits in text; one that ended up inside a tag
  // (a link target, say) is dropped, so formula HTML never lands in an attribute.
  return clean.replace(TOKEN, (tok) => (tok.startsWith("<") ? tok.replace(SLOT, "") : tok.replace(SLOT, (_, i) => stash[Number(i)] ?? "")));
}
