// The Notebook's toggles: TipTap's details block, its title with a `level` for toggle headings, and Notion's shortcuts for them:
// "> " at the start of a heading makes it a toggle heading (taking in its section), "#", "##" or "### " at the start
// of a toggle's title makes it a toggle heading of that size. The turning itself is in toggle-turn.ts.
import { Extension, InputRule, type Editor, type Range } from "@tiptap/core";
import { DetailsSummary } from "@tiptap/extension-details";
import { blockToToggle, lineAt, setToggleLevel, toggleToBlock, type ToggleLevel } from "./toggle-turn.ts";

/**
 * The line the cursor is in becomes a toggle heading (or a toggle, `level` null), taking in its section. `range` (the
 * "/word" typed) goes first. Where a line can't become one (a list item), a toggle is made the usual way.
 */
export function turnLineToToggle(editor: Editor, level: ToggleLevel, range?: Range) {
  if (range) editor.chain().focus().deleteRange(range).run();
  const tr = editor.state.tr;
  const line = lineAt(tr);
  if (line && blockToToggle(tr, line.pos, level)) {
    editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
    return;
  }
  editor.chain().focus().setDetails().run();
  if (!level) return;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== "details") continue;
    const t = editor.state.tr;
    if (setToggleLevel(t, $from.before(d), level)) editor.view.dispatch(t);
    return;
  }
}

/** The toggle at `pos` becomes a plain line with its title (what was inside follows it), cursor at its end. */
export function untoggle(editor: Editor, pos: number): boolean {
  const tr = editor.state.tr;
  if (!toggleToBlock(tr, pos, (title) => editor.schema.nodes.paragraph.create(null, title))) return false;
  editor.view.dispatch(tr);
  return true;
}

/** The toggle at `pos` becomes a toggle heading of `level`, or a plain toggle. */
export function setToggleAt(editor: Editor, pos: number, level: ToggleLevel) {
  const tr = editor.state.tr;
  if (setToggleLevel(tr, pos, level)) editor.view.dispatch(tr);
  editor.commands.focus();
}

/** A toggle's title, with the heading level (1-3) of a toggle heading: `<summary data-level="2">`. */
export const NoteDetailsSummary = DetailsSummary.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      level: {
        default: null,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-level")) || null,
        renderHTML: (a: { level?: number | null }) => (a.level ? { "data-level": String(a.level) } : {}),
      },
    };
  },
});

export const ToggleTurn = Extension.create({
  name: "toggleTurn",
  // Before the quote's "> " and the headings' "# ", which would wrap the heading in a quote or fail in a toggle's title.
  priority: 1001,
  addInputRules() {
    return [
      new InputRule({
        find: /^>\s$/,
        undoable: false,
        handler: ({ state, range }) => {
          const tr = state.tr;
          const $from = tr.doc.resolve(range.from);
          if ($from.parent.type.name !== "heading") return null;
          const level = $from.parent.attrs.level as ToggleLevel;
          tr.delete(range.from, range.to);
          if (!blockToToggle(tr, tr.doc.resolve(range.from).before(), level)) return null;
        },
      }),
      new InputRule({
        find: /^(#{1,3})\s$/,
        undoable: false,
        handler: ({ state, range, match }) => {
          const tr = state.tr;
          const $from = tr.doc.resolve(range.from);
          if ($from.parent.type.name !== "detailsSummary") return null;
          tr.delete(range.from, range.to);
          if (!setToggleLevel(tr, $from.before($from.depth - 1), match[1].length as ToggleLevel)) return null;
        },
      }),
    ];
  },
});
