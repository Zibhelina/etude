// Looks for text in notes: colour, highlight, font and size on words, alignment on blocks, and columns.
// Colours are named (red, blue…) and stored as theme variables (var(--nc-red)), so a page reads well in light
// and dark and pasted styles from other sites don't come in. Only the values below are kept.
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { TextStyle } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";

export const COLORS = [
  { id: "gray", label: "Gray" },
  { id: "brown", label: "Brown" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Yellow" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
  { id: "red", label: "Red" },
] as const;
export const FONTS = [
  { id: "sans", label: "Sans", css: "var(--nf-sans)" },
  { id: "serif", label: "Serif", css: "var(--nf-serif)" },
  { id: "mono", label: "Mono", css: "var(--nf-mono)" },
] as const;
export const SIZES = [
  { id: "small", label: "Small", css: "0.85em" },
  { id: "large", label: "Large", css: "1.25em" },
  { id: "huge", label: "Huge", css: "1.6em" },
] as const;

const COLOR_RE = /^var\(--nc-(gray|brown|orange|yellow|green|blue|purple|pink|red)\)$/;
const BG_RE = /^var\(--nc-(gray|brown|orange|yellow|green|blue|purple|pink|red)-bg\)$/;
const FONT_SET = new Set<string>(FONTS.map((f) => f.css));
const SIZE_SET = new Set<string>(SIZES.map((s) => s.css));
const ok = (re: RegExp | Set<string>, v: string | null | undefined) => (v ? (re instanceof Set ? re.has(v) : re.test(v)) : false);
const clean = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, "");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteStyle: {
      setTextColor: (color: string | null) => ReturnType;
      setHighlightColor: (color: string | null) => ReturnType;
      setNoteFont: (font: string | null) => ReturnType;
      setNoteSize: (size: string | null) => ReturnType;
    };
    noteColumns: {
      insertColumns: (n?: number) => ReturnType;
      addColumn: () => ReturnType;
      removeColumn: () => ReturnType;
      unwrapColumns: () => ReturnType;
    };
  }
}

/** The style a run of text can carry, each value checked against the lists above. */
const StyleAttrs = Extension.create({
  name: "noteStyleAttrs",
  addGlobalAttributes() {
    const attr = (prop: string, check: RegExp | Set<string>) => ({
      default: null,
      parseHTML: (el: HTMLElement) => {
        const v = clean(el.style.getPropertyValue(prop));
        return ok(check, v) ? v : null;
      },
      renderHTML: (a: Record<string, string | null>) => {
        const v = a[camel(prop)];
        return ok(check, v) ? { style: `${prop}: ${v}` } : {};
      },
    });
    return [
      {
        types: ["textStyle"],
        attributes: {
          color: attr("color", COLOR_RE),
          backgroundColor: attr("background-color", BG_RE),
          fontFamily: attr("font-family", FONT_SET),
          fontSize: attr("font-size", SIZE_SET),
        },
      },
    ];
  },
  addCommands() {
    const set = (key: string) => (value: string | null) => ({ chain }: any) => chain().setMark("textStyle", { [key]: value }).removeEmptyTextStyle().run();
    return {
      setTextColor: (c) => set("color")(c ? `var(--nc-${c})` : null),
      setHighlightColor: (c) => set("backgroundColor")(c ? `var(--nc-${c}-bg)` : null),
      setNoteFont: (f) => set("fontFamily")(FONTS.find((x) => x.id === f)?.css ?? null),
      setNoteSize: (s) => set("fontSize")(SIZES.find((x) => x.id === s)?.css ?? null),
    };
  },
});
const camel = (p: string) => p.replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** A row of 2–4 columns, each holding blocks. "/" → Columns; the bar over them adds, removes or unwraps. */
export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  defining: true,
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-column": "", class: "note-col" }), 0],
});

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,4}",
  defining: true,
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-columns": node.childCount, class: "note-cols" }), 0],
  addCommands() {
    const findCols = (state: any): { pos: number; node: any; at: number } | null => {
      const { $from } = state.selection;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === "columns") return { pos: $from.before(d), node: $from.node(d), at: $from.index(d) };
      }
      return null;
    };
    return {
      insertColumns:
        (n = 2) =>
        ({ chain, state }) => {
          // The row goes where the cursor's block is; the cursor lands in the first column.
          const at = state.selection.$from.before(1);
          return chain()
            .insertContent({ type: "columns", content: Array.from({ length: Math.max(2, Math.min(4, n)) }, () => ({ type: "column", content: [{ type: "paragraph" }] })) })
            .command(({ tr }) => {
              let target = -1;
              tr.doc.nodesBetween(at, tr.doc.content.size, (node, pos) => {
                if (target >= 0) return false;
                if (node.type.name === "columns") target = pos + 3;
                return target < 0;
              });
              if (target >= 0) tr.setSelection(TextSelection.create(tr.doc, target));
              return true;
            })
            .run();
        },
      addColumn:
        () =>
        ({ state, tr, dispatch }) => {
          const c = findCols(state);
          if (!c || c.node.childCount >= 4) return false;
          if (dispatch) {
            const end = c.pos + c.node.nodeSize - 1;
            tr.insert(end, state.schema.nodes.column.create(null, state.schema.nodes.paragraph.create()));
          }
          return true;
        },
      removeColumn:
        () =>
        ({ state, tr, dispatch }) => {
          const c = findCols(state);
          if (!c) return false;
          if (dispatch) {
            // The column goes; what was written in it moves into the column beside it (nothing is lost).
            const cols: any[] = [];
            c.node.forEach((col: any) => cols.push(col));
            const gone = cols[c.at];
            const into = c.at > 0 ? c.at - 1 : 1;
            const keep = (b: any) => !(b.type.name === "paragraph" && b.content.size === 0);
            const moved = gone.content.content.filter(keep);
            const merged = cols.map((col: any, i: number) => (i === into ? col.type.create(col.attrs, into < c.at ? [...col.content.content, ...moved] : [...moved, ...col.content.content]) : col)).filter((_: any, i: number) => i !== c.at);
            if (merged.length < 2) {
              const blocks = merged.flatMap((col: any) => col.content.content);
              tr.replaceWith(c.pos, c.pos + c.node.nodeSize, blocks.length ? blocks : [state.schema.nodes.paragraph.create()]);
            } else tr.replaceWith(c.pos, c.pos + c.node.nodeSize, c.node.type.create(c.node.attrs, merged));
          }
          return true;
        },
      unwrapColumns:
        () =>
        ({ state, tr, dispatch }) => {
          const c = findCols(state);
          if (!c) return false;
          if (dispatch) {
            const blocks: any[] = [];
            c.node.forEach((col: any) => col.forEach((b: any) => blocks.push(b)));
            tr.replaceWith(c.pos, c.pos + c.node.nodeSize, blocks);
          }
          return true;
        },
    };
  },
});

export const NoteStyle = [TextStyle, StyleAttrs, TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }), Columns, Column];
