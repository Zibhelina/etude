// "---" typed on a line of its own becomes a divider as soon as the third dash lands, whatever way the text got in.
// TipTap's own rule only runs from handleTextInput; with an input method on Linux (fcitx5 over Wayland) the dashes
// arrive through the DOM instead, the rule looked at the line one character late, and "---" only turned into a line
// once a space followed. This checks the document after each change instead; undo, paste and outside edits are left
// alone, so a "---" line that comes back from undo or from the file stays text.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

const DASHES = new Set(["---", "—-"]);
const skip = (tr: Transaction) =>
  tr.getMeta("etude-external") || tr.getMeta("history$") != null || tr.getMeta("uiEvent") === "paste" || tr.getMeta("uiEvent") === "drop" || tr.getMeta("addToHistory") === false;

/** The divider transaction when the cursor ends a plain paragraph that the user's typing just turned into "---". */
export function dividerFor(trs: readonly Transaction[], old: EditorState, state: EditorState): Transaction | null {
  if (!trs.some((t) => t.docChanged) || trs.some(skip)) return null;
  const $c = (state.selection as TextSelection).$cursor;
  if (!$c || $c.parent.type.name !== "paragraph" || $c.parentOffset !== $c.parent.content.size || !DASHES.has($c.parent.textContent)) return null;
  const hr = state.schema.nodes.horizontalRule;
  const at = $c.before();
  // Only a change made in this line: before it, the same line (mapped back) held something else.
  let back = at;
  for (let i = trs.length - 1; i >= 0; i--) back = trs[i].mapping.invert().map(back);
  const was = old.doc.nodeAt(back);
  if (was?.type.name === "paragraph" && was.textContent === $c.parent.textContent) return null;
  const parent = $c.node(-1), index = $c.index(-1);
  if (!hr || !parent.canReplaceWith(index, index, hr)) return null;
  const tr = state.tr.insert(at, hr.create());
  const p = at + 1; // the paragraph, now after the divider
  tr.delete(p + 1, p + 1 + $c.parent.content.size);
  tr.setSelection(TextSelection.create(tr.doc, p + 1));
  return tr.scrollIntoView();
}

export const DividerDashes = Extension.create({
  name: "dividerDashes",
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("dividerDashes"), appendTransaction: (trs, old, state) => dividerFor(trs, old, state) })];
  },
});
