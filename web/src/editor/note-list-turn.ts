// Markdown-style shortcuts that turn the list item you're typing in into another kind, in place:
//   [] or [ ] (or [x]) at the start of a bullet or numbered item makes it a to-do, as soon as the ] is typed;
//   "- " (or * +) at the start of a to-do or numbered item makes it a bullet, "1. " makes it a numbered item.
// "[]" at the start of a plain paragraph makes it a to-do too, like Notion. Backspace at the start of an item makes
// it plain text where it is, and the next one joins it to the line above (see backspaceAtStart). The / menu and the block menu use
// turnBlock, so "Turn into" on a nested item changes that item and nothing around it.
import { Extension, InputRule, type ChainedCommands, type Editor, type Range } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { backspaceAtStart, turnItem, wrapInTodo, type TurnKind } from "./list-turn";

/** Set by the "[]" rule: a space typed right after it (the habit from "[ ] ") is swallowed, not put before the text. */
const justTurned = new PluginKey<number | null>("listTurnSpace");

export const ListTurn = Extension.create({
  name: "listTurn",
  // Before the lists' own rules, which would wrap the line in a second list inside the item.
  priority: 1000,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]$/,
        // Backspace right after doesn't bring the "[]" back: it goes on to make the line plain text, like Notion.
        undoable: false,
        handler: ({ state, range, match }) => {
          const tr = state.tr;
          const checked = /x/i.test(match[1] ?? "");
          const $from = tr.doc.resolve(range.from);
          if ($from.parent.type.name !== "paragraph") return null;
          // A rule that returns null has its transaction thrown away, so trying is free.
          tr.delete(range.from, range.to);
          if (turnItem(tr, "taskList", { checked }) !== "done" && !wrapInTodo(tr, checked)) return null;
          tr.setMeta(justTurned, tr.selection.head);
        },
      }),
      ...([
        [/^\s*([-+*])\s$/, "bulletList"],
        [/^\s*(\d+)[.)]\s$/, "orderedList"],
      ] as const).map(
        ([find, kind]) =>
          new InputRule({
            find,
            undoable: false,
            handler: ({ state, range, match }) => {
              const tr = state.tr;
              if (tr.doc.resolve(range.from).parent.type.name !== "paragraph") return null;
              const start = kind === "orderedList" ? Number(match[1]) : undefined;
              tr.delete(range.from, range.to);
              if (turnItem(tr, kind, { start }) !== "done") return null;
            },
          }),
      ),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const tr = editor.state.tr;
        if (!backspaceAtStart(tr)) return false;
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
      Space: ({ editor }) => editor.state.selection.empty && justTurned.getState(editor.state) === editor.state.selection.head,
    };
  },
  addProseMirrorPlugins() {
    return [
      // Where the cursor was left by "[]": it holds while the cursor stays there (an empty line added at the end of
      // the page doesn't count), and anything typed or a click elsewhere ends it.
      new Plugin<number | null>({
        key: justTurned,
        state: {
          init: () => null,
          apply: (tr, was) => {
            const set = tr.getMeta(justTurned) as number | undefined;
            if (set !== undefined) return set;
            if (was === null) return null;
            const at = tr.mapping.map(was, -1);
            return tr.selection.empty && tr.selection.head === at ? at : null;
          },
        },
      }),
    ];
  },
});

/**
 * Turns the block under the cursor into `kind`. On a list item's own line that's the item alone, in place; anywhere
 * else it runs `otherwise` (the usual toggle). `range` (the "/word" typed) is removed first. `after` runs on the line
 * once it's text again (a heading, a quote).
 */
export function turnBlock(editor: Editor, kind: TurnKind, otherwise: (c: ChainedCommands) => ChainedCommands, range?: Range, after?: (c: ChainedCommands) => ChainedCommands) {
  if (range) editor.chain().focus().deleteRange(range).run();
  const tr = editor.state.tr;
  const done = turnItem(tr, kind);
  if (done === null) return void otherwise(editor.chain().focus()).run();
  if (done === "done") editor.view.dispatch(tr);
  if (after) after(editor.chain().focus()).run();
  else editor.commands.focus();
}
