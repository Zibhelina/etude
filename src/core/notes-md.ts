// Markdown in and out of note documents, and Obsidian-style vault import.
// In: CommonMark + GFM (marked's lexer) plus Obsidian's [[Page]], [[Page|alias]], [[Page#heading]] and
// ![[image.png]] embeds. Out: Markdown with [[Page]] links, or standalone HTML.
import { marked, type Token, type Tokens } from "marked";
import type { DocNode } from "./notes.ts";

type Mark = { type: string; attrs?: Record<string, unknown> };

/** How a [[link]] or an embedded image gets resolved while converting. */
export interface MdContext {
  /** A page id for a link target title (case-insensitive), or null to keep it as an unresolved link. */
  page?(title: string): string | null;
  /** A served media URL for an image path as written, or null when the file isn't available. */
  media?(path: string): string | null;
}

const WIKI = /(!?)\[\[([^\]\n|#]+)?(#[^\]\n|]*)?(\|[^\]\n]*)?\]\]/g;

function text(s: string, marks: Mark[]): DocNode[] {
  return s ? [{ type: "text", text: s, ...(marks.length ? { marks: marks.map((m) => ({ ...m })) } : {}) }] : [];
}

const MATH = /(?<![\\$\w])\$([^$\s](?:[^$]*?[^$\s])?)\$(?![\w$])/g;

/** Splits plain text on $inline math$, then on Obsidian links. */
function wikiText(s: string, marks: Mark[], ctx: MdContext): DocNode[] {
  if (marks.some((m) => m.type === "code") || !s.includes("$")) return linkText(s, marks, ctx);
  const out: DocNode[] = [];
  let last = 0;
  for (const m of s.matchAll(MATH)) {
    out.push(...linkText(s.slice(last, m.index), marks, ctx));
    out.push({ type: "mathInline", attrs: { latex: m[1] } });
    last = m.index! + m[0].length;
  }
  out.push(...linkText(s.slice(last), marks, ctx));
  return out;
}

/** Splits plain text on Obsidian links and embeds. */
function linkText(s: string, marks: Mark[], ctx: MdContext): DocNode[] {
  const out: DocNode[] = [];
  let last = 0;
  for (const m of s.matchAll(WIKI)) {
    out.push(...text(s.slice(last, m.index), marks));
    last = m.index! + m[0].length;
    const target = (m[2] ?? "").trim();
    const label = m[4] ? m[4].slice(1).trim() : "";
    if (m[1]) {
      const src = ctx.media?.(target) ?? null;
      if (src) out.push({ type: "image", attrs: { src, alt: label && !/^\d+(x\d+)?$/.test(label) ? label : target } });
      else out.push(...text(m[0], marks));
      continue;
    }
    if (!target) {
      out.push(...text(m[0], marks));
      continue;
    }
    const id = ctx.page?.(target) ?? null;
    out.push({ type: "noteLink", attrs: { id, title: target, label: label || null } });
  }
  out.push(...text(s.slice(last), marks));
  return out;
}

function inline(tokens: Token[] | undefined, marks: Mark[], ctx: MdContext): DocNode[] {
  const out: DocNode[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text":
      case "escape": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length && tt.tokens.some((k) => k.type !== "text")) out.push(...inline(tt.tokens, marks, ctx));
        else out.push(...wikiText(decode(tt.text), marks, ctx));
        break;
      }
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, [...marks, { type: "bold" }], ctx));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, [...marks, { type: "italic" }], ctx));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, [...marks, { type: "strike" }], ctx));
        break;
      case "codespan":
        out.push(...text(decode((t as Tokens.Codespan).text), [...marks, { type: "code" }]));
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "link": {
        const l = t as Tokens.Link;
        if (/^(https?:|mailto:)/i.test(l.href)) out.push(...inline(l.tokens, [...marks, { type: "link", attrs: { href: l.href } }], ctx));
        else {
          // A relative link to another markdown file is a page link.
          const target = decodeURIComponent(l.href.split("#")[0]).replace(/\.md$/i, "").split("/").pop() ?? "";
          if (target) out.push({ type: "noteLink", attrs: { id: ctx.page?.(target) ?? null, title: target, label: l.text !== target ? l.text : null } });
          else out.push(...inline(l.tokens, marks, ctx));
        }
        break;
      }
      case "image": {
        const im = t as Tokens.Image;
        const src = /^https?:/i.test(im.href) ? im.href : ctx.media?.(decodeURIComponent(im.href)) ?? null;
        if (src) out.push({ type: "image", attrs: { src, alt: im.text || null } });
        break;
      }
      case "html":
        out.push(...text(decode(t.raw.replace(/<[^>]*>/g, "")), marks));
        break;
      default:
        if ("tokens" in t && Array.isArray((t as any).tokens)) out.push(...inline((t as any).tokens, marks, ctx));
        else if ("text" in t) out.push(...text(decode(String((t as any).text)), marks));
    }
  }
  return out;
}

const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e as string]!);

/** Images can't sit inside a paragraph in the editor's schema: they become blocks of their own. */
function para(content: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  let run: DocNode[] = [];
  const flush = () => {
    if (run.some((n) => n.type !== "text" || n.text?.trim())) out.push({ type: "paragraph", content: run });
    run = [];
  };
  for (const n of content) {
    if (n.type === "image") {
      flush();
      out.push(n);
    } else run.push(n);
  }
  flush();
  return out;
}

function blocks(tokens: Token[], ctx: MdContext): DocNode[] {
  const out: DocNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({ type: "heading", attrs: { level: Math.min(3, h.depth) }, content: inline(h.tokens, [], ctx).filter((n) => n.type !== "image") });
        break;
      }
      case "paragraph": {
        const pt = t as Tokens.Paragraph;
        // $$ … $$ on its own is a block equation.
        const bm = /^\$\$([\s\S]+?)\$\$$/.exec(pt.text.trim());
        if (bm) out.push({ type: "mathBlock", attrs: { latex: bm[1].trim() } });
        else out.push(...para(inline(pt.tokens, [], ctx)));
        break;
      }
      case "text": {
        const tt = t as Tokens.Text;
        out.push(...para(tt.tokens ? inline(tt.tokens, [], ctx) : wikiText(decode(tt.text), [], ctx)));
        break;
      }
      case "blockquote": {
        const bq = t as Tokens.Blockquote;
        // Obsidian callouts: "> [!tip] Title" then the body.
        const cm = /^\s*\[!(\w+)\][+-]?[ \t]*([^\n]*)\n?([\s\S]*)$/.exec(bq.text);
        if (cm) {
          const kind = ({ note: "note", info: "note", abstract: "note", summary: "note", tldr: "note", tip: "tip", hint: "tip", success: "tip", check: "tip", done: "tip", important: "danger", warning: "warning", caution: "warning", attention: "warning", danger: "danger", error: "danger", bug: "danger", failure: "danger", question: "question", help: "question", faq: "question", example: "note", quote: "note" } as Record<string, string>)[cm[1].toLowerCase()] ?? "note";
          const body = blocks(marked.lexer(cm[3] ?? "", { gfm: true }), ctx);
          const head = cm[2].trim() ? [{ type: "paragraph", content: [{ type: "text", text: cm[2].trim(), marks: [{ type: "bold" }] }] }] : [];
          const content = [...head, ...body];
          out.push({ type: "callout", attrs: { kind }, content: content.length ? content : [{ type: "paragraph" }] });
          break;
        }
        const inner = blocks(bq.tokens, ctx);
        out.push({ type: "blockquote", content: inner.length ? inner : [{ type: "paragraph" }] });
        break;
      }
      case "code": {
        const c = t as Tokens.Code;
        out.push({ type: "codeBlock", attrs: { language: (c.lang ?? "").trim().split(/\s/)[0].toLowerCase() || null }, content: c.text ? [{ type: "text", text: c.text }] : [] });
        break;
      }
      case "hr":
        out.push({ type: "horizontalRule" });
        break;
      case "list": {
        const l = t as Tokens.List;
        const task = l.items.some((i) => i.task);
        const items = l.items.map((i) => {
          const body = blocks(i.tokens.filter((k) => k.type !== "checkbox"), ctx);
          const content = body.length && body[0].type === "paragraph" ? body : [{ type: "paragraph" }, ...body];
          return task ? { type: "taskItem", attrs: { checked: !!i.checked }, content } : { type: "listItem", content };
        });
        out.push(task ? { type: "taskList", content: items } : l.ordered ? { type: "orderedList", attrs: { start: Number(l.start) || 1 }, content: items } : { type: "bulletList", content: items });
        break;
      }
      case "table": {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean) => {
          const inner = inline(c.tokens, [], ctx).filter((n) => n.type !== "image");
          return { type: header ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content: inner }] };
        };
        out.push({ type: "table", content: [{ type: "tableRow", content: tb.header.map((c) => cell(c, true)) }, ...tb.rows.map((r) => ({ type: "tableRow", content: r.map((c) => cell(c, false)) }))] });
        break;
      }
      case "html": {
        const s = decode(t.raw.replace(/<[^>]*>/g, "").trim());
        if (s) out.push({ type: "paragraph", content: text(s, []) });
        break;
      }
      case "space":
        break;
      default:
        if ("tokens" in t && Array.isArray((t as any).tokens)) out.push(...para(inline((t as any).tokens, [], ctx)));
    }
  }
  return out;
}

/** Splits YAML front matter off a markdown file. */
export function frontMatter(md: string): { body: string; meta: Record<string, string> } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { body: md, meta: {} };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { body: md.slice(m[0].length), meta };
}

export function markdownToDoc(md: string, ctx: MdContext = {}): DocNode {
  const { body } = frontMatter(md.replace(/\r\n?/g, "\n"));
  // Obsidian comments (%% … %%) are private notes in the source; they don't show.
  const clean = body.replace(/%%[\s\S]*?%%/g, "");
  return { type: "doc", content: blocks(marked.lexer(clean, { gfm: true }), ctx) };
}

// ---------------------------------------------------------------- out

function inlineMd(nodes: DocNode[] | undefined): string {
  let s = "";
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") s += "  \n";
    else if (n.type === "mathInline") s += `$${n.attrs?.latex ?? ""}$`;
    else if (n.type === "noteLink") {
      const a = n.attrs ?? {};
      s += `[[${a.title}${a.label ? `|${a.label}` : ""}]]`;
    } else if (n.type === "text") {
      let t = n.text ?? "";
      const has = (m: string) => n.marks?.some((k) => k.type === m);
      if (has("code")) t = "`" + t + "`";
      else t = t.replace(/([\\*_`[\]])/g, "\\$1");
      if (has("strike")) t = `~~${t}~~`;
      if (has("italic")) t = `*${t}*`;
      if (has("bold")) t = `**${t}**`;
      const link = n.marks?.find((k) => k.type === "link");
      if (link) t = `[${t}](${link.attrs?.href})`;
      s += t;
    }
  }
  return s;
}

function blockMd(n: DocNode, indent = ""): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "heading":
      return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${inlineMd(kids)}`;
    case "paragraph":
      return inlineMd(kids);
    case "blockquote":
      return kids.map((k) => blockMd(k)).join("\n\n").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
    case "codeBlock":
      return "```" + (n.attrs?.language ?? "") + "\n" + kids.map((k) => k.text ?? "").join("") + "\n```";
    case "horizontalRule":
      return "---";
    case "image":
      return `![${n.attrs?.alt ?? ""}](${n.attrs?.src})`;
    case "canvasEmbed":
      return n.attrs?.title ? `[[${n.attrs.title}]]` : "";
    case "mathBlock":
      return `$$\n${n.attrs?.latex ?? ""}\n$$`;
    case "callout":
      return `> [!${n.attrs?.kind ?? "note"}]\n` + kids.map((k) => blockMd(k)).join("\n\n").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
    case "details": {
      const sum = kids.find((k) => k.type === "detailsSummary");
      const body = kids.find((k) => k.type === "detailsContent");
      return `<details>\n<summary>${inlineMd(sum?.content)}</summary>\n\n${(body?.content ?? []).map((k) => blockMd(k)).join("\n\n")}\n\n</details>`;
    }
    case "table": {
      const rows = kids.map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((p) => inlineMd(p.content)).join(" ").replace(/\|/g, "\\|")));
      if (!rows.length) return "";
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return [line(rows[0]), `|${" --- |".repeat(w)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return kids
        .map((li, i) => {
          const bullet = n.type === "orderedList" ? `${Number(n.attrs?.start ?? 1) + i}.` : n.type === "taskList" ? `- [${li.attrs?.checked ? "x" : " "}]` : "-";
          const parts = (li.content ?? []).map((k, j) => (j === 0 && k.type === "paragraph" ? inlineMd(k.content) : blockMd(k, indent + "  ")));
          const [first, ...rest] = parts;
          return [`${indent}${bullet} ${first ?? ""}`, ...rest.map((r) => (r.startsWith(indent + "  ") ? r : r.split("\n").map((l) => indent + "  " + l).join("\n")))].join("\n");
        })
        .join("\n");
    default:
      return kids.length ? kids.map((k) => blockMd(k, indent)).join("\n\n") : "";
  }
}

export function docToMarkdown(doc: DocNode, title?: string): string {
  const body = (doc.content ?? []).map((b) => blockMd(b)).join("\n\n");
  return (title ? `# ${title}\n\n` : "") + body + "\n";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function inlineHtml(nodes: DocNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === "hardBreak") return "<br>";
      if (n.type === "mathInline") return `<span class="math">\\(${esc(String(n.attrs?.latex ?? ""))}\\)</span>`;
      if (n.type === "noteLink") return `<a class="note-link" data-note="${esc(String(n.attrs?.id ?? ""))}">${esc(String(n.attrs?.label || n.attrs?.title || ""))}</a>`;
      if (n.type !== "text") return "";
      let t = esc(n.text ?? "");
      for (const m of n.marks ?? []) {
        if (m.type === "bold") t = `<strong>${t}</strong>`;
        else if (m.type === "italic") t = `<em>${t}</em>`;
        else if (m.type === "underline") t = `<u>${t}</u>`;
        else if (m.type === "strike") t = `<s>${t}</s>`;
        else if (m.type === "code") t = `<code>${t}</code>`;
        else if (m.type === "link" && /^(https?:|mailto:)/i.test(String(m.attrs?.href))) t = `<a href="${esc(String(m.attrs?.href))}">${t}</a>`;
        else if (m.type === "textStyle") {
          const st = styleOf(m.attrs);
          if (st) t = `<span style="${st}">${t}</span>`;
        }
      }
      return t;
    })
    .join("");
}

/** Note colours, fonts and sizes as plain CSS for an exported page (the editor stores them as named variables). */
const NC: Record<string, [string, string]> = { gray: ["#787774", "#ebebea"], brown: ["#9f6b53", "#f2e6df"], orange: ["#d9730d", "#fbeadb"], yellow: ["#b38a00", "#fbf1c8"], green: ["#2f8a4a", "#dff1e4"], blue: ["#2f6fbf", "#dde9f8"], purple: ["#8a4fbf", "#ece2f6"], pink: ["#c14c8a", "#f8e1ed"], red: ["#d44c47", "#fbe2e0"] };
const NF: Record<string, string> = { "var(--nf-sans)": "Inter,system-ui,sans-serif", "var(--nf-serif)": "Georgia,serif", "var(--nf-mono)": "'JetBrains Mono',monospace" };
const NS = new Set(["0.85em", "1.25em", "1.6em"]);
function styleOf(a: Record<string, unknown> | undefined): string {
  const out: string[] = [];
  const c = /^var\(--nc-(\w+)\)$/.exec(String(a?.color ?? ""));
  if (c && NC[c[1]]) out.push(`color:${NC[c[1]][0]}`);
  const b = /^var\(--nc-(\w+)-bg\)$/.exec(String(a?.backgroundColor ?? ""));
  if (b && NC[b[1]]) out.push(`background:${NC[b[1]][1]};border-radius:3px;padding:0 2px`);
  const f = NF[String(a?.fontFamily ?? "")];
  if (f) out.push(`font-family:${f}`);
  if (NS.has(String(a?.fontSize ?? ""))) out.push(`font-size:${a!.fontSize}`);
  return out.join(";");
}
const alignAttr = (n: DocNode) => (["center", "right", "justify"].includes(String(n.attrs?.textAlign)) ? ` style="text-align:${n.attrs!.textAlign}"` : "");

function blockHtml(n: DocNode): string {
  const kids = n.content ?? [];
  const inner = () => kids.map(blockHtml).join("");
  switch (n.type) {
    case "heading": {
      const l = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      return `<h${l}${alignAttr(n)}>${inlineHtml(kids)}</h${l}>`;
    }
    case "paragraph":
      return `<p${alignAttr(n)}>${inlineHtml(kids)}</p>`;
    case "columns":
      return `<div class="cols">${inner()}</div>`;
    case "column":
      return `<div>${inner()}</div>`;
    case "blockquote":
      return `<blockquote>${inner()}</blockquote>`;
    case "codeBlock":
      return `<pre><code${n.attrs?.language ? ` class="language-${esc(String(n.attrs.language))}"` : ""}>${esc(kids.map((k) => k.text ?? "").join(""))}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "image":
      return `<img src="${esc(String(n.attrs?.src ?? ""))}" alt="${esc(String(n.attrs?.alt ?? ""))}">`;
    case "canvasEmbed":
      return `<p class="canvas">🎨 ${esc(String(n.attrs?.title || "Canvas"))}</p>`;
    case "mathBlock":
      return `<div class="math">\\[${esc(String(n.attrs?.latex ?? ""))}\\]</div>`;
    case "callout":
      return `<aside class="callout ${esc(String(n.attrs?.kind ?? "note"))}">${inner()}</aside>`;
    case "details":
      return `<details open>${inner()}</details>`;
    case "detailsSummary":
      return `<summary>${inlineHtml(kids)}</summary>`;
    case "table":
      return `<table>${inner()}</table>`;
    case "tableRow":
      return `<tr>${inner()}</tr>`;
    case "tableHeader":
      return `<th>${inner()}</th>`;
    case "tableCell":
      return `<td>${inner()}</td>`;
    case "bulletList":
      return `<ul>${inner()}</ul>`;
    case "orderedList":
      return `<ol start="${Number(n.attrs?.start ?? 1)}">${inner()}</ol>`;
    case "taskList":
      return `<ul class="tasks">${inner()}</ul>`;
    case "listItem":
      return `<li>${inner()}</li>`;
    case "taskItem":
      return `<li><input type="checkbox" disabled${n.attrs?.checked ? " checked" : ""}> ${inner()}</li>`;
    default:
      return inner();
  }
}

export function docToHtml(doc: DocNode, title = ""): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"><script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script><script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body)"></script>
<style>body{font:16px/1.65 Inter,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#1b1b1a}pre{background:#f6f6f5;padding:1em;border-radius:8px;overflow-x:auto}code{font-family:"JetBrains Mono",monospace;font-size:.88em}blockquote{border-left:3px solid #1b1b1a;margin-left:0;padding-left:1em}ul.tasks{list-style:none;padding-left:.2em}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}.callout{background:#f6f6f5;border-radius:8px;padding:10px 14px}.note-link{text-decoration:underline}.cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:28px}</style>
</head><body>${title ? `<h1>${esc(title)}</h1>` : ""}${(doc.content ?? []).map(blockHtml).join("\n")}</body></html>
`;
}

/** The pages a document links to (ids), each once. */
export function docLinks(doc: DocNode): string[] {
  const out = new Set<string>();
  const walk = (n: DocNode) => {
    if (n.type === "noteLink" && typeof n.attrs?.id === "string" && n.attrs.id) out.add(n.attrs.id);
    n.content?.forEach(walk);
  };
  walk(doc);
  return [...out];
}

/** Gives every unresolved [[link]] whose title now names a page (`find`) that page's id. Returns how many changed. */
export function resolveLinks(doc: DocNode, find: (title: string) => string | null): number {
  let n = 0;
  const walk = (x: DocNode) => {
    if (x.type === "noteLink" && x.attrs && !x.attrs.id && typeof x.attrs.title === "string") {
      const id = find(x.attrs.title);
      if (id) (x.attrs.id = id), n++;
    }
    x.content?.forEach(walk);
  };
  walk(doc);
  return n;
}
