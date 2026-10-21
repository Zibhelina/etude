// Markdown with live preview, the way Obsidian edits: formatting renders in place, math renders
// with KaTeX, code blocks are highlighted, and the raw markup comes back only where the cursor is.
// Framework-free so card frames can use it; the app wraps it in a React component.
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, placeholder as placeholderExt, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { classHighlighter } from "@lezer/highlight";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import { editorTheme, leaveModEnter, type EditorHandle } from "./code-editor";

/** The parts of KaTeX the editor needs; passed in so card frames can share the copy they already load. */
export interface Katex {
  render(tex: string, el: HTMLElement, opts: Record<string, unknown>): void;
}

export interface MarkdownEditorOptions {
  value?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Mark the editor as the card's first focus target. */
  autofocus?: boolean;
  /** Minimum visible lines (default 3). */
  minLines?: number;
  katex: Katex;
  onChange?(value: string): void;
  extensions?: Extension[];
}

// ---------------------------------------------------------------- math in the markdown grammar

const DOLLAR = 36, BACKSLASH = 92, NEWLINE = 10;
const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace = (c: number) => c === 32 || c === 9 || c === NEWLINE;

/** `$…$`, `$$…$$`, `\(…\)` and `\[…\]` inline; `$$` or `\[` blocks on their own lines. Same rules as the card renderer. */
const mathSyntax: MarkdownConfig = {
  defineNodes: [{ name: "BlockMath", block: true }, { name: "InlineMath" }, { name: "MathMark" }],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line) {
        if (line.indent >= 4) return false;
        const t = line.text.slice(line.pos);
        const open = t.startsWith("$$") ? "$$" : t.startsWith("\\[") ? "\\[" : null;
        if (!open) return false;
        const close = open === "$$" ? "$$" : "\\]";
        const from = cx.lineStart + line.pos;
        const marks = [cx.elt("MathMark", from, from + 2)];
        const same = t.indexOf(close, 2);
        if (same >= 0) {
          // Text after the closing mark makes it inline math in a paragraph instead.
          if (t.slice(same + 2).trim()) return false;
          const to = from + same + 2;
          marks.push(cx.elt("MathMark", to - 2, to));
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", from, to, marks));
          return true;
        }
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          const j = line.text.indexOf(close);
          if (j >= 0) {
            const end = cx.lineStart + j + 2;
            marks.push(cx.elt("MathMark", end - 2, end));
            to = end;
            cx.nextLine();
            break;
          }
          to = cx.lineStart + line.text.length;
        }
        cx.addElement(cx.elt("BlockMath", from, to, marks));
        return true;
      },
      endLeaf: (_cx: BlockContext, line: Line) => /^ {0,3}(\$\$|\\\[)/.test(line.text),
    },
  ],
  parseInline: [
    {
      // $…$ and $$…$$ come after InlineCode, so `$5` inside backticks stays code.
      name: "InlineMath",
      after: "InlineCode",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== DOLLAR) return -1;
        const add = (to: number, m: number) => {
          cx.addElement(cx.elt("InlineMath", pos, to, [cx.elt("MathMark", pos, pos + m), cx.elt("MathMark", to - m, to)]));
          return to;
        };
        if (cx.char(pos + 1) === DOLLAR) {
          for (let i = pos + 3; i < cx.end - 1; i++) if (cx.char(i) === DOLLAR && cx.char(i + 1) === DOLLAR) return add(i + 2, 2);
          return -1;
        }
        const prev = pos > cx.offset ? cx.char(pos - 1) : -1;
        if (prev === BACKSLASH || prev === DOLLAR || isWord(prev)) return -1;
        const first = cx.char(pos + 1);
        if (first < 0 || isSpace(first)) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === NEWLINE) return -1;
          if (c === BACKSLASH) { i++; continue; }
          if (c === DOLLAR) {
            if (isSpace(cx.char(i - 1))) return -1;
            const after = cx.char(i + 1);
            if (after >= 48 && after <= 57) return -1;
            return add(i + 1, 1);
          }
        }
        return -1;
      },
    },
    {
      // \(…\) and \[…\] have to beat Escape, which would otherwise eat the backslash.
      name: "InlineMathBackslash",
      before: "Escape",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== BACKSLASH) return -1;
        const n = cx.char(pos + 1);
        if (n !== 40 && n !== 91) return -1;
        const close = n === 40 ? 41 : 93;
        for (let i = pos + 2; i < cx.end - 1; i++)
          if (cx.char(i) === BACKSLASH && cx.char(i + 1) === close) {
            cx.addElement(cx.elt("InlineMath", pos, i + 2, [cx.elt("MathMark", pos, pos + 2), cx.elt("MathMark", i, i + 2)]));
            return i + 2;
          }
        return -1;
      },
    },
  ],
};

// ---------------------------------------------------------------- widgets

let katexImpl: Katex | null = null;

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly block: boolean, readonly preview = false) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display && o.block === this.block && o.preview === this.preview;
  }
  toDOM() {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = this.block ? `cm-md-math-block${this.preview ? " cm-md-math-preview" : ""}` : "cm-md-math";
    const tex = this.tex.trim();
    if (!tex) {
      el.textContent = this.preview ? "" : "$\u2009$";
      el.classList.add("cm-md-empty");
      return el;
    }
    try {
      katexImpl?.render(tex, el, { displayMode: this.display, throwOnError: false, strict: "ignore", output: "html" });
    } catch {
      el.textContent = tex;
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string) {
    super();
  }
  eq(o: TextWidget) {
    return o.text === this.text && o.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

// ---------------------------------------------------------------- decorations

const setFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) return e.value;
    return v;
  },
});

const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const lineDeco = (cls: string) => Decoration.line({ class: cls });

function mathSource(text: string): { tex: string; display: boolean; open: number } {
  const open = text.startsWith("$$") || text.startsWith("\\[") || text.startsWith("\\(") ? 2 : 1;
  const display = text.startsWith("$$") || text.startsWith("\\[");
  const closeMark = text.startsWith("$$") ? "$$" : text.startsWith("\\[") ? "\\]" : text.startsWith("\\(") ? "\\)" : "$";
  const closed = text.length >= open * 2 && text.endsWith(closeMark);
  return { tex: text.slice(open, closed ? text.length - closeMark.length : undefined), display, open };
}

function build(state: EditorState): DecorationSet {
  const focused = state.field(focusField);
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const touches = (from: number, to: number) => focused && ranges.some((r) => r.from <= to && r.to >= from);
  const lineActive = (pos: number) => {
    const l = doc.lineAt(pos);
    return touches(l.from, l.to);
  };
  const head = state.selection.main.head;
  const out: Range<Decoration>[] = [];
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);

  tree.iterate({
    enter(node) {
      const { from, to } = node;
      const name = node.name;
      const parent = node.node.parent;
      switch (name) {
        case "ATXHeading1": case "ATXHeading2": case "ATXHeading3": case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
          out.push(lineDeco(`cm-md-h cm-md-h${name.slice(-1)}`).range(doc.lineAt(from).from));
          break;
        case "HeaderMark":
          if (!lineActive(from)) {
            const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            out.push(hide.range(from, end));
          } else out.push(mark("cm-md-mark").range(from, to));
          break;
        case "Emphasis":
          out.push(mark("cm-md-em").range(from, to));
          break;
        case "StrongEmphasis":
          out.push(mark("cm-md-strong").range(from, to));
          break;
        case "Strikethrough":
          out.push(mark("cm-md-strike").range(from, to));
          break;
        case "EmphasisMark":
        case "StrikethroughMark":
          if (parent && !touches(parent.from, parent.to)) out.push(hide.range(from, to));
          else out.push(mark("cm-md-mark").range(from, to));
          break;
        case "InlineCode": {
          out.push(mark("cm-md-code").range(from, to));
          if (!touches(from, to)) {
            for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "CodeMark") out.push(hide.range(c.from, c.to));
          }
          return false;
        }
        case "FencedCode": {
          const first = doc.lineAt(from), last = doc.lineAt(to);
          const active = touches(first.from, last.to);
          let info = "";
          for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "CodeInfo") info = doc.sliceString(c.from, c.to);
          const closed = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
          for (let n = first.number; n <= last.number; n++) {
            const l = doc.line(n);
            const cls = ["cm-md-cb"];
            if (n === first.number) cls.push("cm-md-cb-first");
            if (n === last.number) cls.push("cm-md-cb-last");
            if ((n === first.number || (n === last.number && closed)) && !active) cls.push("cm-md-cb-fence");
            out.push(lineDeco(cls.join(" ")).range(l.from));
          }
          if (!active) {
            if (first.to > first.from) out.push(Decoration.replace({ widget: new TextWidget(info, "cm-md-cb-label") }).range(first.from, first.to));
            if (closed && last.to > last.from) out.push(hide.range(last.from, last.to));
          } else {
            out.push(mark("cm-md-mark").range(first.from, first.to));
            if (closed) out.push(mark("cm-md-mark").range(last.from, last.to));
          }
          return false;
        }
        case "Blockquote": {
          const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
          for (let n = a; n <= b; n++) out.push(lineDeco("cm-md-quote").range(doc.line(n).from));
          break;
        }
        case "QuoteMark":
          if (!lineActive(from)) {
            const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            out.push(hide.range(from, end));
          } else out.push(mark("cm-md-mark").range(from, to));
          break;
        case "ListMark": {
          const list = parent?.parent;
          if (list?.name === "BulletList" && !lineActive(from)) out.push(Decoration.replace({ widget: new TextWidget("•", "cm-md-bullet") }).range(from, to));
          else out.push(mark("cm-md-listmark").range(from, to));
          break;
        }
        case "TaskMarker":
          out.push(mark("cm-md-listmark").range(from, to));
          break;
        case "Link":
          out.push(mark("cm-md-link").range(from, to));
          break;
        case "LinkMark":
        case "URL":
        case "LinkTitle":
          if (parent?.name === "Link" || parent?.name === "Image") {
            // Away from the cursor a link shows only its text: hide "[", "](", the URL and ")".
            out.push(touches(parent.from, parent.to) ? mark("cm-md-mark").range(from, to) : hide.range(from, to));
          } else if (name === "URL") out.push(mark("cm-md-link").range(from, to));
          break;
        case "HorizontalRule":
          if (!lineActive(from)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
          break;
        case "Table": {
          const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
          for (let n = a; n <= b; n++) out.push(lineDeco("cm-md-table").range(doc.line(n).from));
          return false;
        }
        case "InlineMath": {
          const { tex, display } = mathSource(doc.sliceString(from, to));
          if (!touches(from, to)) out.push(Decoration.replace({ widget: new MathWidget(tex, display, false) }).range(from, to));
          else {
            out.push(mark("cm-md-math-src").range(from, to));
            // Live render under the line while the cursor is in it.
            if (focused && head >= from && head <= to) out.push(Decoration.widget({ widget: new MathWidget(tex, true, true, true), block: true, side: 1 }).range(doc.lineAt(to).to));
          }
          return false;
        }
        case "BlockMath": {
          const first = doc.lineAt(from), last = doc.lineAt(to);
          const { tex } = mathSource(doc.sliceString(from, to));
          if (!touches(first.from, last.to)) out.push(Decoration.replace({ widget: new MathWidget(tex, true, true), block: true }).range(first.from, last.to));
          else {
            for (let n = first.number; n <= last.number; n++) out.push(lineDeco("cm-md-mathline").range(doc.line(n).from));
            out.push(Decoration.widget({ widget: new MathWidget(tex, true, true, true), block: true, side: 1 }).range(last.to));
          }
          return false;
        }
      }
      return undefined;
    },
  });
  return Decoration.set(out, true);
}

const livePreview = StateField.define<DecorationSet>({
  create: (s) => build(s),
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return build(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const previewTheme = EditorView.theme({
  "&": { fontSize: "0.95rem" },
  ".cm-content": { fontFamily: "var(--font-sans)", lineHeight: "1.65" },
  ".cm-line": { padding: "0 0.8rem" },
  ".cm-md-h": { fontWeight: "650", letterSpacing: "-0.01em" },
  ".cm-md-h1": { fontSize: "1.45em", lineHeight: "1.4" },
  ".cm-md-h2": { fontSize: "1.25em", lineHeight: "1.45" },
  ".cm-md-h3": { fontSize: "1.1em" },
  ".cm-md-mark": { color: "var(--muted-foreground)", fontWeight: "400", fontStyle: "normal" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strong": { fontWeight: "650" },
  ".cm-md-strike": { textDecoration: "line-through", color: "var(--muted-foreground)" },
  ".cm-md-code": { fontFamily: "var(--font-mono)", fontSize: "0.86em", backgroundColor: "color-mix(in oklab, var(--foreground) 8%, transparent)", borderRadius: "4px", padding: "0.1em 0.3em" },
  ".cm-md-cb": { fontFamily: "var(--font-mono)", fontSize: "0.86em", lineHeight: "1.6", backgroundColor: "color-mix(in oklab, var(--foreground) 5%, transparent)", paddingLeft: "1.1rem !important" },
  ".cm-md-cb-first": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px", paddingTop: "0.15rem" },
  ".cm-md-cb-last": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px", paddingBottom: "0.15rem" },
  ".cm-md-cb-fence": { fontSize: "0.7em", lineHeight: "1.5" },
  ".cm-md-cb-label": { fontFamily: "var(--font-sans)", color: "var(--muted-foreground)", letterSpacing: "0.02em" },
  ".cm-md-quote": { borderLeft: "2px solid var(--border)", paddingLeft: "1.1rem !important", color: "var(--muted-foreground)" },
  ".cm-md-bullet": { color: "var(--muted-foreground)", display: "inline-block", width: "0.8em" },
  ".cm-md-listmark": { color: "var(--muted-foreground)" },
  ".cm-md-link": { color: "var(--highlight)", textDecoration: "underline", textUnderlineOffset: "2px", textDecorationColor: "color-mix(in oklab, var(--highlight) 45%, transparent)" },
  ".cm-md-hr": { display: "inline-block", width: "100%", verticalAlign: "middle", borderTop: "1px solid var(--border)" },
  ".cm-md-table": { fontFamily: "var(--font-mono)", fontSize: "0.86em" },
  ".cm-md-math": { padding: "0 0.05em", cursor: "text" },
  ".cm-md-math-block": { textAlign: "center", padding: "0.3rem 0", overflowX: "auto", overflowY: "hidden", cursor: "text" },
  ".cm-md-math-block .katex-display": { margin: "0" },
  ".cm-md-math-preview": { margin: "0.15rem 0.8rem 0.35rem", borderRadius: "6px", backgroundColor: "color-mix(in oklab, var(--highlight) 7%, transparent)" },
  ".cm-md-math-src, .cm-md-mathline": { fontFamily: "var(--font-mono)", fontSize: "0.86em", color: "color-mix(in oklab, var(--highlight) 80%, var(--foreground))" },
  ".cm-md-empty": { color: "var(--muted-foreground)" },
});

/** Mod-B / Mod-I wrap the selection the way most editors do. */
function wrap(marker: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((r) => ({
        changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }],
        range: EditorSelection.range(r.from + marker.length, r.to + marker.length),
      })),
    );
    return true;
  };
}

export function createMarkdownEditor(parent: HTMLElement, opts: MarkdownEditorOptions): EditorHandle {
  katexImpl = opts.katex;
  const minLines = opts.minLines ?? 3;
  const ro = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value ?? "",
      extensions: [
        leaveModEnter,
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [mathSyntax], addKeymap: true }),
        markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{"] } }),
        closeBrackets(),
        Prec.high(keymap.of([{ key: "Mod-b", run: wrap("**") }, { key: "Mod-i", run: wrap("*") }])),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(classHighlighter),
        focusField,
        livePreview,
        EditorView.focusChangeEffect.of((_s, focusing) => setFocus.of(focusing)),
        editorTheme,
        // Earlier extensions win, so the prose look has to outrank the shared code theme.
        Prec.high(previewTheme),
        EditorView.theme({ ".cm-content": { minHeight: `calc(${minLines} * 1.65em + 1.2rem)` } }),
        opts.placeholder ? placeholderExt(opts.placeholder) : [],
        ro.of([EditorState.readOnly.of(!!opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": "Markdown", "aria-multiline": "true", ...(opts.autofocus ? { autofocus: "" } : {}) }),
        ...(opts.extensions ?? []),
      ],
    }),
  });
  return {
    view,
    value: () => view.state.doc.toString(),
    set(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    focus: () => view.focus(),
    setReadOnly(readOnly) {
      view.dispatch({ effects: ro.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
    },
    destroy: () => view.destroy(),
  };
}
