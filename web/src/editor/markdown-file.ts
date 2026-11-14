// A Markdown file open in the Notebook: the live preview of markdown-editor.ts at page size, with the things a
// folder of notes uses on top of plain Markdown: [[links]] and ![[embeds]], pictures shown in place, ==marks==,
// %%comments%%, #tags, to-dos you can tick, callouts, tables drawn as tables, and the properties block at the top.
// The file's text is never rewritten on its own: what's saved is what was typed.
import { Compartment, EditorSelection, Prec, type Extension } from "@codemirror/state";
import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import { search, searchKeymap } from "@codemirror/search";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import type { SyntaxNodeRef } from "@lezer/common";
import { createMarkdownEditor, mdNodes, type Katex, type MdBuild } from "./markdown-editor";
import { loadVim, replaceKeymap, saveOf, type FileEditorHandle } from "./file-editor";

export interface MarkdownFileOptions {
  value: string;
  katex: Katex;
  vim?: boolean;
  readOnly?: boolean;
  onChange?(value: string): void;
  /** Ctrl/⌘+S, and :w in Vim. */
  onSave?(): void;
  onVimMode?(mode: string | null): void;
  /** A link was clicked: a [[wiki]] target, a path in the folder, or a web address. */
  onLink?(link: { kind: "wiki" | "href"; target: string }, newTab: boolean): void;
  /** Where a picture named in the file loads from (null: it can't be shown here). */
  imageUrl?(target: string): string | null;
  /** A table's Markdown as safe HTML. */
  renderTable?(markdown: string): string;
  /** The file's name as a title above the text, the way a page has one (left out: no title is drawn). Asked each time it's drawn. */
  title?: () => string;
  /** The title was changed. */
  onTitle?(title: string): void;
}

// ---------------------------------------------------------------- grammar

const BANG = 33, HASH = 35, PERCENT = 37, EQUALS = 61, OPEN = 91, CLOSE = 93, NEWLINE = 10;
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/** `[[…]]` from `pos`, where the opening brackets are: the end of the closing ones, or -1. */
function wikiEnd(cx: InlineContext, pos: number): number {
  for (let i = pos + 2; i < cx.end - 1; i++) {
    const c = cx.char(i);
    if (c === NEWLINE || c === OPEN) return -1;
    if (c === CLOSE) return cx.char(i + 1) === CLOSE && i > pos + 2 ? i + 2 : -1;
  }
  return -1;
}
const tagChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 47 || c > 127;

const noteSyntax: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink" }, { name: "WikiEmbed" }, { name: "WikiMark" }, { name: "Highlight" }, { name: "HighlightMark" }, { name: "NoteComment" }, { name: "HashTag" }],
  parseInline: [
    {
      name: "WikiEmbed",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== BANG || cx.char(pos + 1) !== OPEN || cx.char(pos + 2) !== OPEN) return -1;
        const end = wikiEnd(cx, pos + 1);
        return end < 0 ? -1 : cx.addElement(cx.elt("WikiEmbed", pos, end, [cx.elt("WikiMark", pos, pos + 3), cx.elt("WikiMark", end - 2, end)]));
      },
    },
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;
        const end = wikiEnd(cx, pos);
        return end < 0 ? -1 : cx.addElement(cx.elt("WikiLink", pos, end, [cx.elt("WikiMark", pos, pos + 2), cx.elt("WikiMark", end - 2, end)]));
      },
    },
    {
      // ==marked text==, with other formatting allowed inside, the way ~~strikethrough~~ works.
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
      },
    },
    {
      name: "NoteComment",
      parse(cx, next, pos) {
        if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) if (cx.char(i) === PERCENT && cx.char(i + 1) === PERCENT) return cx.addElement(cx.elt("NoteComment", pos, i + 2));
        return -1;
      },
    },
    {
      // #tag and #nested/tag: after a space or at the start, with a letter somewhere in it (#123 is a number).
      name: "HashTag",
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        const prev = pos > cx.offset ? cx.char(pos - 1) : -1;
        if (prev !== -1 && prev !== 32 && prev !== 9 && prev !== NEWLINE && prev !== 40) return -1;
        let i = pos + 1;
        let letter = false;
        for (; i < cx.end && tagChar(cx.char(i)); i++) if (!(cx.char(i) >= 48 && cx.char(i) <= 57)) letter = true;
        return i > pos + 1 && letter ? cx.addElement(cx.elt("HashTag", pos, i)) : -1;
      },
    },
  ],
};

// ---------------------------------------------------------------- widgets

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: number | null, readonly block: boolean) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt && o.width === this.width && o.block === this.block;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement(this.block ? "div" : "span");
    wrap.className = this.block ? "cm-md-img cm-md-img-block" : "cm-md-img";
    const img = document.createElement("img");
    img.alt = this.alt;
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    // The picture arrives after the line was measured: the editor measures again, or clicks and arrow keys below
    // it would land a few lines off.
    img.onload = () => view.requestMeasure();
    // A picture that isn't there shows its name, the way the file names it.
    img.onerror = () => {
      wrap.classList.add("is-missing");
      wrap.textContent = this.alt || "Picture not found";
      view.requestMeasure();
    };
    img.src = this.src;
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class ChipWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string, readonly attrs: Record<string, string> = {}) {
    super();
  }
  eq(o: ChipWidget) {
    return o.text === this.text && o.cls === this.cls && JSON.stringify(o.attrs) === JSON.stringify(this.attrs);
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    for (const [k, v] of Object.entries(this.attrs)) el.setAttribute(k, v);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckWidget extends WidgetType {
  constructor(readonly on: boolean, readonly at: number) {
    super();
  }
  eq(o: CheckWidget) {
    return o.on === this.on && o.at === this.at;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.on;
    box.className = "cm-md-check";
    box.setAttribute("aria-label", this.on ? "Done" : "To do");
    box.onmousedown = (e) => e.preventDefault();
    box.onclick = (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      // The mark may have moved since this box was drawn: find it again from where the box sits.
      const pos = view.posAtDOM(box);
      const text = view.state.doc.sliceString(pos, pos + 3);
      if (/^\[[ xX]\]$/.test(text)) view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " } });
    };
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class HtmlWidget extends WidgetType {
  constructor(readonly html: string, readonly cls: string) {
    super();
  }
  eq(o: HtmlWidget) {
    return o.html === this.html && o.cls === this.cls;
  }
  toDOM() {
    // The space around the block is padding on an outer box: the editor measures boxes, and can't see margins.
    const box = document.createElement("div");
    box.className = "cm-md-block";
    const el = document.createElement("div");
    el.className = this.cls;
    el.innerHTML = this.html;
    // A link in here would take the whole window to its address: it becomes one the editor follows (a [[link]]
    // arrives as #wiki:name, see tableSource).
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      a.removeAttribute("href");
      if (href.startsWith(WIKI_HREF)) a.setAttribute("data-md-wiki", decodeURIComponent(href.slice(WIKI_HREF.length)));
      else a.setAttribute("data-md-href", href);
      a.classList.add("cm-md-link");
    }
    box.appendChild(el);
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class PropsWidget extends WidgetType {
  constructor(readonly rows: [string, string][]) {
    super();
  }
  eq(o: PropsWidget) {
    return JSON.stringify(o.rows) === JSON.stringify(this.rows);
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-md-block cm-md-props-box";
    const el = document.createElement("div");
    el.className = "cm-md-props";
    box.appendChild(el);
    for (const [k, v] of this.rows) {
      const key = document.createElement("span");
      key.className = "cm-md-props-key";
      key.textContent = k;
      const val = document.createElement("span");
      val.className = "cm-md-props-val";
      val.textContent = v;
      el.append(key, val);
    }
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

/** The file's name as the page's title: typed over like a page's, and the file is renamed when it's left. */
class TitleWidget extends WidgetType {
  constructor(readonly title: string, readonly readOnly: boolean, readonly commit: ((t: string) => void) | undefined) {
    super();
  }
  eq(o: TitleWidget) {
    return o.title === this.title && o.readOnly === this.readOnly;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-md-title-box";
    const el = document.createElement("textarea");
    el.className = "note-title cm-md-title";
    el.rows = 1;
    el.value = this.title;
    el.readOnly = this.readOnly || !this.commit;
    el.spellcheck = false;
    el.setAttribute("aria-label", "Title");
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      view.requestMeasure();
    };
    const done = () => {
      const t = el.value.replace(/[\r\n]+/g, " ").trim();
      if (!t) el.value = this.title;
      else if (t !== this.title) this.commit?.(t);
    };
    el.addEventListener("input", fit);
    el.addEventListener("blur", done);
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || (e.key === "ArrowDown" && el.selectionStart === el.value.length)) {
        e.preventDefault();
        view.focus();
        view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      } else if (e.key === "Escape") {
        el.value = this.title;
        view.focus();
      }
    });
    box.appendChild(el);
    // Its height is only known once it's on the page.
    requestAnimationFrame(fit);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------------------------------------------------------------- drawing

const hide = Decoration.replace({});
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const WIKI_HREF = "#wiki:";
/** A table's Markdown with its [[links]] (and ![[pictures]]) as plain Markdown ones, which the table renderer knows. */
function tableSource(src: string, image: (target: string) => string | null): string {
  return src.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (all, bang: string, inner: string) => {
    // In a table cell the bar between a link's name and its alias is escaped.
    const [target, alias] = inner.split(/\\?\|/).map((x) => x.trim());
    if (!target) return all;
    if (bang) {
      const url = IMAGE.test(target) ? image(target) : null;
      return url ? `![${target}](<${url}>)` : `[${target}](<${WIKI_HREF}${encodeURIComponent(target)}>)`;
    }
    return `[${alias || target}](<${WIKI_HREF}${encodeURIComponent(target)}>)`;
  });
}
const CALLOUT = /^(\s*>\s*)\[!([A-Za-z-]+)\]([+-]?)[ \t]*/;

/** The page's side padding, and how far each level of a list steps in. */
const GUTTER = "32px";
const INDENT_EM = 1.5;
/**
 * How wide a list marker and the space after it are drawn, in em: a bullet, "12." by its digits, a to-do's box.
 * The same places a page puts them (its lists step in 1.5em and the text sits 0.15em further).
 */
const markWidth = (ordered: boolean, chars: number, task: boolean) => (task || !ordered ? 1.65 : Math.max(1.65, 0.62 * chars + 0.45));
/** Lines that are code, where an empty line is part of the code. */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "CodeText", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock"]);

/** Where the properties block ends (after its closing ---), or 0 when the file doesn't start with one. */
function propsEnd(cx: MdBuild): number {
  const doc = cx.doc;
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return 0;
  for (let n = 2; n <= Math.min(doc.lines, 200); n++) {
    const t = doc.line(n).text.trimEnd();
    if (t === "---" || t === "...") return doc.line(n).to;
  }
  return 0;
}

/** `key: value` lines as rows; a list under a key joins its items. Anything deeper shows as written. */
function propRows(lines: string[]): [string, string][] {
  const rows: [string, string][] = [];
  for (const line of lines) {
    const m = /^([A-Za-z0-9_ -]+):\s*(.*)$/.exec(line);
    if (m) rows.push([m[1].trim(), m[2].trim().replace(/^(["'])(.*)\1$/, "$2")]);
    else if (rows.length && /^\s+-\s+/.test(line)) rows[rows.length - 1][1] += `${rows[rows.length - 1][1] ? ", " : ""}${line.replace(/^\s+-\s+/, "").trim()}`;
    else if (rows.length && line.trim()) rows[rows.length - 1][1] += ` ${line.trim()}`;
  }
  return rows;
}

function drawing(opts: MarkdownFileOptions) {
  const ends = new WeakMap<object, number>();
  const image = (target: string) => (/^(https?:|data:image\/)/i.test(target) ? target : opts.imageUrl?.(target) ?? null);
  return (node: SyntaxNodeRef, cx: MdBuild): boolean | void => {
    const { from, to, name } = node;
    const doc = cx.doc;
    if (name === "Document") {
      const end = propsEnd(cx);
      ends.set(doc, end);
      if (opts.title) cx.push(Decoration.widget({ widget: new TitleWidget(opts.title(), cx.state.readOnly, opts.onTitle), block: true, side: -1 }).range(0));
      // An empty line between two blocks is the space between them, as tall as a page leaves there. In code it's code.
      const tree = syntaxTree(cx.state);
      for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        if (line.length || line.from < end) continue;
        let inCode = false;
        for (let at: { name: string; parent: unknown } | null = tree.resolveInner(line.from, 1); at; at = at.parent as typeof at) if (CODE_NODES.has(at.name)) inCode = true;
        if (!inCode) cx.push(Decoration.line({ class: "cm-md-blank" }).range(line.from));
      }
      if (!end) return;
      const last = doc.lineAt(end);
      if (!cx.touches(0, end)) {
        const lines: string[] = [];
        for (let n = 2; n < last.number; n++) lines.push(doc.line(n).text);
        cx.push(Decoration.replace({ widget: new PropsWidget(propRows(lines)), block: true }).range(0, end));
      } else for (let n = 1; n <= last.number; n++) cx.push(Decoration.line({ class: `cm-md-fm${n === 1 ? " cm-md-fm-first" : n === last.number ? " cm-md-fm-last" : ""}` }).range(doc.line(n).from));
      return;
    }
    // Inside the properties block nothing is Markdown (its last line would read as a heading's underline).
    if (from < (ends.get(doc) ?? 0)) return false;
    switch (name) {
      case "WikiLink": {
        const inner = doc.sliceString(from + 2, to - 2);
        const bar = inner.indexOf("|");
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
        if (cx.touches(from, to)) {
          cx.push(Decoration.mark({ class: "cm-md-mark" }).range(from, from + 2), Decoration.mark({ class: "cm-md-link", attributes: { "data-md-wiki": target, "data-md-raw": "" } }).range(from + 2, to - 2), Decoration.mark({ class: "cm-md-mark" }).range(to - 2, to));
          return false;
        }
        const shown = bar < 0 ? from + 2 : from + 2 + bar + 1;
        cx.push(hide.range(from, shown), Decoration.mark({ class: "cm-md-link cm-md-wiki", attributes: { "data-md-wiki": target } }).range(shown, to - 2), hide.range(to - 2, to));
        return false;
      }
      case "WikiEmbed": {
        const inner = doc.sliceString(from + 3, to - 2);
        const [target, size] = inner.split("|").map((s) => s.trim());
        const width = /^\d+/.test(size ?? "") ? parseInt(size, 10) : null;
        const src = IMAGE.test(target.split("#")[0]) ? image(target) : null;
        if (cx.touches(from, to)) {
          cx.push(Decoration.mark({ class: "cm-md-mark" }).range(from, to));
          if (src) cx.push(Decoration.widget({ widget: new ImageWidget(src, target, width, true), block: true, side: 1 }).range(doc.lineAt(to).to));
          return false;
        }
        if (src) cx.push(Decoration.replace({ widget: new ImageWidget(src, target, width, false) }).range(from, to));
        else cx.push(Decoration.replace({ widget: new ChipWidget(target, "cm-md-embed", { "data-md-wiki": target }) }).range(from, to));
        return false;
      }
      case "Image": {
        let url = "";
        for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "URL") url = doc.sliceString(c.from, c.to);
        const text = doc.sliceString(from, to);
        const alt = /^!\[([^\]]*)\]/.exec(text)?.[1] ?? "";
        const width = /\|(\d+)/.exec(alt)?.[1];
        const src = url ? image(url.replace(/^<|>$/g, "")) : null;
        if (!src) return;
        const w = width ? parseInt(width, 10) : null;
        if (cx.touches(from, to)) {
          cx.push(Decoration.widget({ widget: new ImageWidget(src, alt, w, true), block: true, side: 1 }).range(doc.lineAt(to).to));
          return;
        }
        cx.push(Decoration.replace({ widget: new ImageWidget(src, alt.replace(/\|\d+.*$/, ""), w, false) }).range(from, to));
        return false;
      }
      case "Link": {
        let url = "";
        for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "URL") url = doc.sliceString(c.from, c.to);
        if (url) cx.push(Decoration.mark({ attributes: { "data-md-href": url.replace(/^<|>$/g, ""), ...(cx.touches(from, to) ? { "data-md-raw": "" } : {}) } }).range(from, to));
        return;
      }
      case "URL":
      case "Autolink": {
        const parent = node.node.parent?.name;
        if (name === "URL" && (parent === "Link" || parent === "Image" || parent === "Autolink")) return;
        const url = doc.sliceString(from, to).replace(/^<|>$/g, "");
        if (/^(https?:\/\/|mailto:|www\.)/i.test(url)) cx.push(Decoration.mark({ class: "cm-md-link", attributes: { "data-md-href": /^www\./i.test(url) ? `https://${url}` : url, ...(cx.touches(from, to) ? { "data-md-raw": "" } : {}) } }).range(from, to));
        return;
      }
      case "Highlight":
        cx.push(Decoration.mark({ class: "cm-md-hl" }).range(from, to));
        return;
      case "HighlightMark": {
        const p = node.node.parent;
        cx.push(p && !cx.touches(p.from, p.to) ? hide.range(from, to) : Decoration.mark({ class: "cm-md-mark" }).range(from, to));
        return;
      }
      case "NoteComment":
        cx.push(Decoration.mark({ class: "cm-md-comment" }).range(from, to));
        return false;
      case "HashTag":
        cx.push(Decoration.mark({ class: "cm-md-tag" }).range(from, to));
        return false;
      case "ListItem": {
        // A long item wraps under its own text, not under its marker: the line is pushed in by the width of its
        // indent and marker and its first row pulled back by the same. Both have fixed widths, so this is exact.
        const line = doc.lineAt(from);
        const mark = node.node.firstChild;
        if (!mark || mark.name !== "ListMark" || mark.from < line.from || mark.from > line.to) return;
        let depth = 0;
        for (let p = node.node.parent; p; p = p.parent) if (p.name === "ListItem") depth++;
        const w = depth * INDENT_EM + markWidth(node.node.parent?.name === "OrderedList", mark.to - mark.from, mark.nextSibling?.name === "Task");
        cx.push(Decoration.line({ attributes: { style: `padding-left: calc(${GUTTER} + ${w}em); text-indent: -${w}em` } }).range(line.from));
        if (mark.from > line.from) cx.push(Decoration.mark({ class: "cm-md-indent", attributes: { style: `width: ${depth * INDENT_EM}em` } }).range(line.from, mark.from));
        return;
      }
      case "ListMark": {
        const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
        const ordered = node.node.parent?.parent?.name === "OrderedList";
        // A to-do's dash steps aside for its box.
        if (node.node.nextSibling?.name === "Task") cx.push(cx.lineActive(from) ? Decoration.mark({ class: "cm-md-listmark" }).range(from, to) : hide.range(from, end));
        else if (!ordered && !cx.lineActive(from)) {
          // A disc, and a ring for the lists inside it, as on a page.
          let depth = 0;
          for (let p = node.node.parent?.parent; p; p = p.parent) if (p.name === "ListItem") depth++;
          cx.push(Decoration.replace({ widget: new ChipWidget(depth ? "◦" : "•", "cm-md-lm cm-md-bullet") }).range(from, end));
        } else cx.push(Decoration.mark({ class: "cm-md-lm cm-md-listmark cm-md-num", attributes: { style: `width: ${markWidth(ordered, to - from, false)}em` } }).range(from, end));
        return true;
      }
      case "Task": {
        const marker = node.node.firstChild;
        if (marker?.name === "TaskMarker" && /x/i.test(doc.sliceString(marker.from, marker.to))) cx.push(Decoration.mark({ class: "cm-md-done" }).range(marker.to, to));
        return;
      }
      case "TaskMarker": {
        if (cx.lineActive(from)) return;
        // The box takes the space after it too, so the text starts where a bullet's does and wraps under itself.
        cx.push(Decoration.replace({ widget: new CheckWidget(/x/i.test(doc.sliceString(from, to)), from) }).range(from, doc.sliceString(to, to + 1) === " " ? to + 1 : to));
        return true;
      }
      case "Blockquote": {
        const first = doc.lineAt(from);
        const m = CALLOUT.exec(first.text);
        if (!m) return;
        const kind = m[2].toLowerCase();
        const last = doc.lineAt(to).number;
        for (let n = first.number; n <= last; n++) cx.push(Decoration.line({ class: `cm-md-callout cm-md-callout-${kind}${n === first.number ? " cm-md-callout-head" : ""}${n === last ? " cm-md-callout-last" : ""}` }).range(doc.line(n).from));
        if (!cx.lineActive(from)) {
          const at = first.from + m[1].length;
          const titled = first.text.slice(m[0].length).trim().length > 0;
          cx.push(Decoration.replace({ widget: new ChipWidget(titled ? "" : kind[0].toUpperCase() + kind.slice(1), "cm-md-callout-label") }).range(at, first.from + m[0].length));
        }
        return;
      }
      case "Table": {
        const first = doc.lineAt(from), last = doc.lineAt(to);
        if (!opts.renderTable || cx.touches(first.from, last.to)) return;
        cx.push(Decoration.replace({ widget: new HtmlWidget(opts.renderTable(tableSource(doc.sliceString(first.from, last.to), image)), "cm-md-table-view prose-etude"), block: true }).range(first.from, last.to));
        return false;
      }
    }
  };
}

// ---------------------------------------------------------------- look

// The look of a page (index.css, .note-sheet and .note-prose), measure for measure, so a Markdown file and a page
// read the same: the same column, sizes, list marks, to-do boxes, quote, code, table and links.
const MUTED_MARK = "color-mix(in oklab, var(--muted-foreground) 70%, transparent)";
const tint = (v: string, pct: number) => `color-mix(in oklab, var(${v}) ${pct}%, var(--background))`;
const pageTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "16.5px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-sans)", lineHeight: "1.7" },
  ".cm-content": { maxWidth: "720px", margin: "0 auto", padding: "40px 0 30vh", fontFamily: "var(--font-sans)", lineHeight: "1.7" },
  ".cm-line": { padding: `0 ${GUTTER}` },
  // Nothing drawn in the editor has a top or bottom margin: the editor measures boxes and can't see margins, and a
  // click or an arrow key below one would land lines away. Space around a block is padding.
  ".cm-md-title-box": { padding: `0 ${GUTTER} 26px` },
  ".cm-md-title": { margin: "0", fontFamily: "var(--font-sans)" },
  ".cm-md-blank": { fontSize: "0.45em" },
  ".cm-md-h": { fontWeight: "650", letterSpacing: "-0.015em" },
  ".cm-md-h1": { fontSize: "1.85em", fontWeight: "700", letterSpacing: "-0.02em", lineHeight: "1.25", paddingTop: "0.4em", paddingBottom: "0.15em" },
  ".cm-md-h2": { fontSize: "1.45em", lineHeight: "1.3", paddingTop: "0.4em", paddingBottom: "0.1em" },
  ".cm-md-h3": { fontSize: "1.2em", lineHeight: "1.35", paddingTop: "0.35em", paddingBottom: "0.05em" },
  ".cm-md-h4": { fontSize: "1.05em", paddingTop: "0.4em" },
  ".cm-md-h5, .cm-md-h6": { fontSize: "0.95em", color: "var(--muted-foreground)", paddingTop: "0.3em" },
  ".cm-md-strong": { fontWeight: "650" },
  ".cm-md-link": { color: "var(--foreground)", textDecoration: "underline", textDecorationColor: "color-mix(in oklab, var(--foreground) 35%, transparent)", textUnderlineOffset: "3px" },
  ".cm-md-link *, [data-md-href] *": { color: "inherit" },
  ".cm-md-wiki": { fontWeight: "550", textDecorationColor: "color-mix(in oklab, var(--foreground) 30%, transparent)", textDecorationThickness: "1px" },
  "[data-md-wiki]:not([data-md-raw]), [data-md-href]:not([data-md-raw])": { cursor: "pointer" },
  ".cm-md-code": { fontFamily: "var(--font-mono)", fontSize: "0.86em", backgroundColor: "var(--muted)", color: "color-mix(in oklab, var(--danger) 70%, var(--foreground))", padding: "0.12em 0.36em", borderRadius: "5px" },
  ".cm-md-embed": { display: "inline-flex", alignItems: "center", padding: "0.05em 0.5em", borderRadius: "6px", border: "1px solid var(--border)", fontSize: "0.92em" },
  ".cm-md-embed::before": { content: '"↗"', marginRight: "0.35em", opacity: "0.7" },
  ".cm-md-img img": { maxWidth: "100%", borderRadius: "8px", verticalAlign: "middle" },
  ".cm-md-img-block": { display: "block", padding: `0.3em ${GUTTER}` },
  ".cm-md-img.is-missing": { color: "var(--muted-foreground)", fontSize: "0.88em", fontStyle: "italic" },
  ".cm-md-hl": { backgroundColor: "color-mix(in oklab, var(--warning) 32%, transparent)", borderRadius: "3px", padding: "0 2px" },
  ".cm-md-comment": { color: "var(--muted-foreground)", opacity: "0.7" },
  ".cm-md-tag": { color: "var(--highlight)", backgroundColor: "color-mix(in oklab, var(--highlight) 12%, transparent)", borderRadius: "999px", padding: "0.08em 0.5em", fontSize: "0.9em" },
  // What sits in a line keeps its own text where it is: only the line itself is pulled back for a hanging indent.
  ".cm-line > *": { textIndent: "0" },
  ".cm-md-lm": { display: "inline-block", whiteSpace: "pre", boxSizing: "border-box", textAlign: "right", fontVariantNumeric: "tabular-nums", fontStyle: "normal", fontWeight: "400", color: "var(--muted-foreground)" },
  ".cm-md-lm *": { fontStyle: "normal", fontWeight: "400", color: "inherit" },
  ".cm-md-bullet": { width: "1.65em", paddingRight: "0.6em" },
  ".cm-md-num": { paddingRight: "0.15em" },
  ".cm-md-indent": { display: "inline-block", whiteSpace: "pre", overflow: "hidden", verticalAlign: "bottom" },
  ".cm-md-done": { color: "var(--muted-foreground)", textDecoration: "line-through", textDecorationThickness: "1.5px", textDecorationColor: MUTED_MARK },
  ".cm-md-quote:not(.cm-md-callout)": { marginLeft: `calc(${GUTTER} + 0.1em)`, marginRight: GUTTER, borderLeft: "3px solid var(--foreground)", paddingLeft: "1em !important", paddingRight: "0 !important", color: "color-mix(in oklab, var(--foreground) 85%, transparent)" },
  ".cm-md-callout": { border: "0", backgroundColor: "var(--muted)", color: "var(--foreground)", marginLeft: GUTTER, marginRight: GUTTER, paddingLeft: "14px !important", paddingRight: "14px !important" },
  ".cm-md-callout-head": { fontWeight: "600", borderTopLeftRadius: "10px", borderTopRightRadius: "10px", paddingTop: "8px" },
  ".cm-md-callout-last": { borderBottomLeftRadius: "10px", borderBottomRightRadius: "10px", paddingBottom: "8px" },
  ".cm-md-callout-label": { fontWeight: "600" },
  ".cm-md-callout-tip, .cm-md-callout-hint, .cm-md-callout-success, .cm-md-callout-check, .cm-md-callout-done": { backgroundColor: tint("--success", 11) },
  ".cm-md-callout-warning, .cm-md-callout-caution, .cm-md-callout-attention": { backgroundColor: tint("--warning", 13) },
  ".cm-md-callout-danger, .cm-md-callout-error, .cm-md-callout-bug, .cm-md-callout-failure, .cm-md-callout-fail, .cm-md-callout-missing": { backgroundColor: tint("--danger", 11) },
  ".cm-md-callout-question, .cm-md-callout-help, .cm-md-callout-faq": { backgroundColor: tint("--easy", 11) },
  ".cm-md-fm": { fontFamily: "var(--font-mono)", fontSize: "0.82em", color: "var(--muted-foreground)", backgroundColor: "var(--muted)", marginLeft: GUTTER, marginRight: GUTTER, paddingLeft: "14px !important" },
  ".cm-md-fm-first": { borderTopLeftRadius: "10px", borderTopRightRadius: "10px", paddingTop: "0.3rem" },
  ".cm-md-fm-last": { borderBottomLeftRadius: "10px", borderBottomRightRadius: "10px", paddingBottom: "0.3rem" },
  ".cm-md-block": { padding: `0.35em ${GUTTER}`, cursor: "text" },
  ".cm-md-props-box": { padding: `0 ${GUTTER} 0.8em` },
  ".cm-md-props": { display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: "1.1rem", rowGap: "0.15rem", padding: "10px 14px", borderRadius: "10px", backgroundColor: "var(--muted)", fontSize: "0.82em" },
  ".cm-md-props-key": { color: "var(--muted-foreground)" },
  ".cm-md-props-val": { minWidth: "0", overflowWrap: "anywhere" },
  ".cm-md-table-view": { overflowX: "auto" },
  ".cm-md-table-view table, .cm-md-table-view > *": { margin: "0" },
  // A code block is a page's: the same box, the language named small in its top corner.
  ".cm-md-cb": { fontFamily: "var(--font-mono)", fontSize: "0.86em", lineHeight: "1.6", backgroundColor: "var(--muted)", marginLeft: GUTTER, marginRight: GUTTER, paddingLeft: "1.1em !important", paddingRight: "1.1em !important" },
  ".cm-md-cb-first": { borderTopLeftRadius: "10px", borderTopRightRadius: "10px", paddingTop: "0.5em" },
  ".cm-md-cb-last": { borderBottomLeftRadius: "10px", borderBottomRightRadius: "10px", paddingBottom: "0.7em" },
  ".cm-md-cb-fence.cm-md-cb-first": { fontSize: "11.5px", lineHeight: "2", paddingLeft: "12px !important", paddingTop: "4px", paddingBottom: "2px" },
  ".cm-md-cb-fence.cm-md-cb-last": { fontSize: "0.3em", lineHeight: "1", paddingBottom: "1em" },
  ".cm-md-cb-label": { fontFamily: "var(--font-sans)", fontWeight: "500", color: "var(--muted-foreground)", letterSpacing: "0" },
  ".cm-md-math-preview": { margin: `0 ${GUTTER}` },
  ".cm-panels-top": { borderBottom: "1px solid color-mix(in oklab, var(--border) 70%, transparent)", background: "var(--background)" },
  ".cm-fat-cursor": { background: "color-mix(in oklab, var(--foreground) 70%, transparent) !important", color: "var(--background) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid color-mix(in oklab, var(--foreground) 55%, transparent)", color: "transparent !important" },
});

/** Ctrl/⌘+B, I, E: the marks go around the selection, or come off when they're already there. Nothing selected: an empty pair to type in. */
function toggleMark(mark: string) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    const n = mark.length;
    view.dispatch(
      view.state.changeByRange((r) => {
        const doc = view.state.doc;
        const inside = doc.sliceString(r.from, r.to);
        if (inside.length >= 2 * n && inside.startsWith(mark) && inside.endsWith(mark)) return { changes: [{ from: r.from, to: r.from + n }, { from: r.to - n, to: r.to }], range: EditorSelection.range(r.from, r.to - 2 * n) };
        if (r.from >= n && doc.sliceString(r.from - n, r.from) === mark && doc.sliceString(r.to, r.to + n) === mark) return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
        return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + n, r.to + n) };
      }),
      { scrollIntoView: true, userEvent: "input" },
    );
    return true;
  };
}
/** Tab and Shift+Tab step a list item in and out. Anywhere else Tab is left alone (it moves the focus, as in the rest of the app). */
function inList(run: (view: EditorView) => boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (state.readOnly) return false;
    const line = state.doc.lineAt(state.selection.main.head);
    if (!/^\s*(?:[-*+]|\d+[.)])\s/.test(line.text)) return false;
    return run(view);
  };
}
const editKeys = keymap.of([
  { key: "Mod-b", preventDefault: true, run: toggleMark("**") },
  { key: "Mod-i", preventDefault: true, run: toggleMark("*") },
  { key: "Mod-e", preventDefault: true, run: toggleMark("`") },
  { key: "Tab", run: inList(indentMore) },
  { key: "Shift-Tab", run: inList(indentLess) },
]);

/** A plain click follows a link drawn as a link; with its markup showing (the cursor is in it), Ctrl/⌘+click does. */
function linkClicks(opts: MarkdownFileOptions): Extension {
  const follow = (e: MouseEvent, newTab: boolean): boolean => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-md-wiki],[data-md-href]");
    if (!el || !opts.onLink) return false;
    const mod = e.ctrlKey || e.metaKey;
    if (el.hasAttribute("data-md-raw") && !mod && !newTab) return false;
    e.preventDefault();
    const wiki = el.getAttribute("data-md-wiki");
    opts.onLink(wiki !== null ? { kind: "wiki", target: wiki } : { kind: "href", target: el.getAttribute("data-md-href") ?? "" }, newTab || mod);
    return true;
  };
  return EditorView.domEventHandlers({
    mousedown: (e) => (e.button === 0 ? follow(e, false) : e.button === 1 ? follow(e, true) : false),
    // The middle button's own click would paste (Linux) or scroll.
    auxclick: (e) => (e.button === 1 && !!(e.target as Element | null)?.closest?.("[data-md-wiki],[data-md-href]") ? (e.preventDefault(), true) : false),
  });
}

export function createMarkdownFileEditor(parent: HTMLElement, opts: MarkdownFileOptions): FileEditorHandle {
  const vimC = new Compartment();
  const save = () => opts.onSave?.();
  const h = createMarkdownEditor(parent, {
    value: opts.value,
    katex: opts.katex,
    readOnly: opts.readOnly,
    minLines: 1,
    onChange: opts.onChange,
    syntax: [noteSyntax],
    extensions: [
      // Vim has to see keys before the other keymaps do.
      Prec.highest(vimC.of([])),
      Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save(), true) }])),
      mdNodes.of(drawing(opts)),
      Prec.high(editKeys),
      search({ top: true }),
      keymap.of([...replaceKeymap, ...searchKeymap]),
      linkClicks(opts),
      Prec.highest(pageTheme),
      EditorView.contentAttributes.of({ "aria-label": "Markdown file" }),
    ],
  });
  const view = h.view;
  saveOf.set(view, save);
  let vimOn = false;
  const handle: FileEditorHandle = {
    view,
    value: h.value,
    set: h.set,
    focus: h.focus,
    setName() {},
    async setVim(on) {
      vimOn = on;
      if (!on) {
        view.dispatch({ effects: vimC.reconfigure([]) });
        return opts.onVimMode?.(null);
      }
      const m = await loadVim();
      if (!vimOn) return;
      view.dispatch({ effects: vimC.reconfigure(m.vim({ status: false })) });
      const cm = m.getCM(view) as any;
      if (cm && !cm.__etudeMode) {
        cm.__etudeMode = true;
        cm.on("vim-mode-change", (e: { mode: string; subMode?: string }) => opts.onVimMode?.(vimOn ? (e.subMode === "linewise" ? `${e.mode} line` : e.subMode === "blockwise" ? `${e.mode} block` : e.mode) : null));
      }
      opts.onVimMode?.("normal");
    },
    // Prose always wraps.
    setWrap() {},
    destroy: h.destroy,
  };
  if (opts.vim) void handle.setVim(true);
  return handle;
}
