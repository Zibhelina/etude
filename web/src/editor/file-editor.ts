// The editor for a file in Notes (main.py, report.tex): plain text, kept exactly as written, highlighted by the
// extension in the file's name. Line numbers, search (Ctrl/⌘+F), folding by brackets and indentation, and Vim
// keys when Settings → Keyboard turns them on (loaded only then, so the app doesn't carry them otherwise).
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { LanguageDescription, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { classHighlighter } from "@lezer/highlight";
import { editorTheme } from "./code-editor";

/** Extensions CodeMirror doesn't know by name, or knows as something else (.m is MATLAB here, not Mathematica). */
const BY_EXT: Record<string, string> = { m: "Octave", sty: "LaTeX", cls: "LaTeX", ltx: "LaTeX", bib: "LaTeX", ipy: "Python", pyi: "Python", mts: "TypeScript", cts: "TypeScript", jsonc: "JSON", zsh: "Shell", fish: "Shell", bash: "Shell", env: "Properties files", conf: "Properties files", cfg: "Properties files" };

/** The language a file's name says it is, or null for plain text. */
export function fileLanguage(name: string): LanguageDescription | null {
  const n = name.trim();
  const ext = /\.([^./]+)$/.exec(n)?.[1]?.toLowerCase() ?? "";
  const alias = BY_EXT[ext];
  if (alias) return LanguageDescription.matchLanguageName(languages, alias, false);
  return LanguageDescription.matchFilename(languages, n.split("/").pop() ?? n);
}

/** Indent unit by language: 4 spaces where that's the convention, 2 elsewhere, tabs for Go and Makefiles. */
function indentFor(name: string): string {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "go" || /(^|\/)makefile$/i.test(name)) return "\t";
  return ["py", "pyi", "ipy", "rs", "java", "kt", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "php", "swift", "m", "jl", "r", "sql"].includes(ext) ? "    " : "  ";
}

/** Prose-like files wrap by default; code scrolls sideways. */
export const wrapsByDefault = (name: string) => /\.(tex|sty|cls|ltx|bib|txt|text|rst|org|adoc|log|csv|tsv)$/i.test(name) || !/\./.test(name);

export interface FileEditorOptions {
  value: string;
  name: string;
  vim?: boolean;
  wrap?: boolean;
  onChange?(value: string): void;
  /** Ctrl/⌘+S, and :w in Vim. */
  onSave?(): void;
  /** Vim's mode as it changes ("normal", "insert", "visual", "visual line", "replace"), null with Vim off. */
  onVimMode?(mode: string | null): void;
}

export interface FileEditorHandle {
  readonly view: EditorView;
  value(): string;
  set(value: string): void;
  focus(): void;
  setName(name: string): void;
  setVim(on: boolean): Promise<void>;
  setWrap(on: boolean): void;
  destroy(): void;
}

let vimModule: Promise<typeof import("@replit/codemirror-vim")> | null = null;
/** What :w saves: the editor the command was typed in. */
const saveOf = new WeakMap<EditorView, () => void>();
function loadVim() {
  vimModule ??= import("@replit/codemirror-vim").then((m) => {
    // :w saves now (it saves on its own anyway); :wq and :x save too. Nothing to quit in a browser tab.
    const write = (cm: any) => saveOf.get(cm.cm6)?.();
    m.Vim.defineEx("write", "w", write);
    m.Vim.defineEx("wq", "wq", write);
    m.Vim.defineEx("xit", "x", write);
    return m;
  });
  return vimModule;
}

const fileTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13.5px" },
  ".cm-scroller": { lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "14px 0 40vh" },
  ".cm-line": { padding: "0 18px 0 12px" },
  ".cm-gutters": { borderRight: "none", paddingLeft: "6px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer", opacity: "0.55" },
  ".cm-foldGutter .cm-gutterElement:hover": { opacity: "1" },
  ".cm-foldPlaceholder": { background: "var(--muted)", border: "none", color: "var(--muted-foreground)", borderRadius: "4px", padding: "0 5px", margin: "0 2px" },
  "&.has-selection .cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--highlight) 14%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 26%, transparent)", outline: "1px solid color-mix(in oklab, var(--warning) 50%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--warning) 50%, transparent)" },
  // Vim: a block cursor in the theme's colour, and the mode line at the bottom.
  ".cm-fat-cursor": { background: "color-mix(in oklab, var(--foreground) 70%, transparent) !important", color: "var(--background) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid color-mix(in oklab, var(--foreground) 55%, transparent)", color: "transparent !important" },
});

/** While text is selected the active-line band steps aside, so it doesn't hide the selection under it. */
const selectionClass = EditorView.editorAttributes.compute(["selection"], (st) => ({ class: st.selection.ranges.some((r) => !r.empty) ? "has-selection" : "" }));

/** Wrapped lines keep their indent: the continuation rows start under the line's first character, not at column 0. */
const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      const tab = view.state.tabSize;
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          let cols = 0;
          for (const ch of line.text) {
            if (ch === " ") cols++;
            else if (ch === "\t") cols += tab - (cols % tab);
            else break;
          }
          if (cols && cols < line.length + tab) b.add(line.from, line.from, Decoration.line({ attributes: { style: `padding-left: calc(12px + ${cols}ch); text-indent: -${cols}ch` } }));
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export function createFileEditor(parent: HTMLElement, opts: FileEditorOptions): FileEditorHandle {
  const lang = new Compartment();
  const indent = new Compartment();
  const vimC = new Compartment();
  const wrapC = new Compartment();
  const indentExt = (name: string): Extension => {
    const unit = indentFor(name);
    return [indentUnit.of(unit), EditorState.tabSize.of(unit === "\t" ? 4 : unit.length)];
  };
  const save = () => opts.onSave?.();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value,
      extensions: [
        // Vim has to come before the other keymaps to see keys first.
        vimC.of([]),
        Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save(), true) }])),
        lineNumbers(),
        foldGutter({ openText: "▾", closedText: "▸" }),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        search({ top: true }),
        highlightSelectionMatches(),
        indent.of(indentExt(opts.name)),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        syntaxHighlighting(classHighlighter),
        editorTheme,
        fileTheme,
        wrapC.of(opts.wrap ? [EditorView.lineWrapping, hangingIndent] : []),
        selectionClass,
        lang.of([]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": "File", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
      ],
    }),
  });
  saveOf.set(view, save);
  let langName = "";
  const setLanguage = (name: string) => {
    const desc = fileLanguage(name);
    const key = desc?.name ?? "";
    if (key === langName) return;
    langName = key;
    if (!desc) return view.dispatch({ effects: lang.reconfigure([]) });
    desc.load().then(
      (support: LanguageSupport) => langName === key && view.dispatch({ effects: lang.reconfigure(support) }),
      () => {},
    );
  };
  setLanguage(opts.name);
  let vimOn = false;
  const handle: FileEditorHandle = {
    view,
    value: () => view.state.doc.toString(),
    set(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    focus: () => view.focus(),
    setName(name) {
      setLanguage(name);
      view.dispatch({ effects: indent.reconfigure(indentExt(name)) });
    },
    async setVim(on) {
      vimOn = on;
      if (!on) {
        view.dispatch({ effects: vimC.reconfigure([]) });
        return opts.onVimMode?.(null);
      }
      const m = await loadVim();
      if (!vimOn) return;
      // Vim's own panel only opens for the : and / prompts; the mode goes to the file's status line.
      view.dispatch({ effects: vimC.reconfigure(m.vim({ status: false })) });
      const cm = m.getCM(view) as any;
      if (cm && !cm.__etudeMode) {
        cm.__etudeMode = true;
        cm.on("vim-mode-change", (e: { mode: string; subMode?: string }) => opts.onVimMode?.(vimOn ? (e.subMode === "linewise" ? `${e.mode} line` : e.subMode === "blockwise" ? `${e.mode} block` : e.mode) : null));
      }
      opts.onVimMode?.("normal");
    },
    setWrap(on) {
      view.dispatch({ effects: wrapC.reconfigure(on ? [EditorView.lineWrapping, hangingIndent] : []) });
    },
    destroy: () => view.destroy(),
  };
  if (opts.vim) void handle.setVim(true);
  return handle;
}
