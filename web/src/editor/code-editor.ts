// A plain code editor for any language: line numbers, brackets, indentation, Tab to indent.
// Framework-free so card frames can use it; the app wraps it in a React component.
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as placeholderExt } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { classHighlighter } from "@lezer/highlight";
import { loadLanguage } from "./highlight";

export interface CodeEditorOptions {
  value?: string;
  language?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Mark the editor as the card's first focus target. */
  autofocus?: boolean;
  /** Minimum visible lines (default 6). */
  minLines?: number;
  lineNumbers?: boolean;
  /** Wrap long lines instead of scrolling sideways (default true: cards are narrow, often phones). */
  wrap?: boolean;
  /** Indent unit; defaults to 4 spaces for Python and 2 elsewhere. */
  indent?: string;
  onChange?(value: string): void;
  extensions?: Extension[];
}

export interface EditorHandle {
  readonly view: EditorView;
  value(): string;
  set(value: string): void;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

/** Shared look: transparent, theme variables, monospace. Colors of tokens come from `tok-*` CSS. */
export const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--foreground)", fontSize: "0.88rem" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--foreground)", padding: "0.6rem 0" },
  ".cm-line": { padding: "0 0.85rem" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", borderRight: "1px solid var(--border)", color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)", fontFamily: "var(--font-mono)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.6rem 0 0.75rem", minWidth: "2.2em" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--highlight) 28%, transparent) !important" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--highlight) 22%, transparent)", outline: "none" },
  ".cm-placeholder": { color: "var(--muted-foreground)", fontStyle: "normal" },
  ".cm-scroller": { lineHeight: "1.6", fontFamily: "var(--font-mono)" },
});

/** Mod-Enter belongs to the host (submit); stop CodeMirror from also inserting a line. */
export const leaveModEnter = Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => true }]));

export function createCodeEditor(parent: HTMLElement, opts: CodeEditorOptions = {}): EditorHandle {
  const lang = new Compartment();
  const ro = new Compartment();
  const language = (opts.language ?? "").toLowerCase();
  const unit = opts.indent ?? (language === "python" || language === "py" ? "    " : "  ");
  const minLines = opts.minLines ?? 6;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value ?? "",
      extensions: [
        leaveModEnter,
        opts.lineNumbers === false ? [] : [lineNumbers(), highlightActiveLineGutter()],
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        indentUnit.of(unit),
        EditorState.tabSize.of(unit.length || 4),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(classHighlighter),
        editorTheme,
        opts.wrap === false ? [] : EditorView.lineWrapping,
        EditorView.theme({ ".cm-content": { minHeight: `calc(${minLines} * 1.6em + 1.2rem)` } }),
        opts.placeholder ? placeholderExt(opts.placeholder) : [],
        lang.of([]),
        ro.of([EditorState.readOnly.of(!!opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": "Code", spellcheck: "false", autocapitalize: "off", autocorrect: "off", ...(opts.autofocus ? { autofocus: "" } : {}) }),
        ...(opts.extensions ?? []),
      ],
    }),
  });
  if (language)
    loadLanguage(language).then((support) => {
      if (support) view.dispatch({ effects: lang.reconfigure(support) });
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
