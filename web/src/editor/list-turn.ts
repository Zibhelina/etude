// Turning one list item into another kind, in place, like Notion: a bullet nested under another becomes a to-do
// (or a numbered item, or plain text) without leaving its spot, keeping its own sub-items. The items before and
// after it stay what they were, and a new list that ends up next to a list of the same kind joins it.
// Done with steps that leave the item's text where it is (cut the list around it, then swap its wrappers), so the
// cursor, undo and other people's cursors in a shared page all follow it exactly.
// Pure ProseMirror, so the tests run it without a browser.
import { ReplaceAroundStep, canJoin, findWrapping } from "@tiptap/pm/transform";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Fragment, Slice, type Node as PMNode, type NodeType } from "@tiptap/pm/model";

export type ListKind = "bulletList" | "orderedList" | "taskList";
export type TurnKind = ListKind | "text";
const ITEM_OF: Record<ListKind, string> = { bulletList: "listItem", orderedList: "listItem", taskList: "taskItem" };
const LISTS = new Set<string>(Object.keys(ITEM_OF));
const ITEMS = new Set(["listItem", "taskItem"]);

/** The list item whose own line (its first paragraph) holds the whole selection, or null. */
export function ownItem(tr: Transaction): { depth: number; list: PMNode; item: PMNode } | null {
  const { $from, $to } = tr.selection;
  if (!$from.sameParent($to) || $from.parent.type.name !== "paragraph" || $from.depth < 3) return null;
  const d = $from.depth - 1;
  const item = $from.node(d);
  const list = $from.node(d - 1);
  if (!ITEMS.has(item.type.name) || !LISTS.has(list.type.name) || $from.index(d) !== 0) return null;
  return { depth: d, list, item };
}

/** Same attributes where the new type has them (a to-do's tick, say), new ones from `extra`. */
function attrsFor(type: NodeType, from: Record<string, unknown>, extra?: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(type.spec.attrs ?? {})) if (k in from) out[k] = from[k];
  return { ...out, ...extra };
}

/** Joins the two lists of one kind that meet at `pos`, if they do. */
function joinLists(tr: Transaction, pos: number) {
  const $p = tr.doc.resolve(pos);
  const a = $p.nodeBefore;
  const b = $p.nodeAfter;
  if (a && b && a.type === b.type && LISTS.has(a.type.name) && canJoin(tr.doc, pos)) tr.join(pos);
}

/**
 * Turns the item under the selection into `kind`: "same" when it already is one, "done" after the change, null when
 * the selection isn't on an item's own line (the caller then does its usual thing). `checked` ticks a new to-do.
 */
export function turnItem(tr: Transaction, kind: TurnKind, opts: { checked?: boolean; start?: number } = {}): "same" | "done" | null {
  const own = ownItem(tr);
  if (!own) return null;
  const { depth: d, list, item } = own;
  if (kind === list.type.name) return "same";
  const schema = tr.doc.type.schema;
  const { $from } = tr.selection;
  const at = $from.index(d - 1);
  const L = kind === "text" ? null : schema.nodes[kind];
  const I = kind === "text" ? null : schema.nodes[ITEM_OF[kind]];
  if (kind === "text") {
    if (!$from.node(d - 2).canReplace($from.index(d - 2), $from.index(d - 2) + 1, item.content)) return null;
  } else if (!L || !I || !I.validContent(item.content)) return null;

  // 1. The list cut around the item, so it's alone in a list of its own. After the cut an ordered list starts at 1.
  const anchor = tr.selection.from;
  if (at < list.childCount - 1) tr.split($from.after(d), 1, [{ type: list.type, attrs: list.type.name === "orderedList" ? { ...list.attrs, start: 1 } : list.attrs }]);
  if (at > 0) tr.split($from.before(d), 1);

  // 2. Its list and item wrappers swapped for the new kind's (or taken off, for text), keeping what's inside.
  const $p = tr.doc.resolve(tr.mapping.map(anchor));
  const lp = $p.before(d - 1);
  const lEnd = $p.after(d - 1);
  const ip = $p.before(d);
  const iEnd = $p.after(d);
  if (kind === "text") {
    tr.step(new ReplaceAroundStep(lp, lEnd, ip + 1, iEnd - 1, Slice.empty, 0, true));
    joinLists(tr, lp + item.content.size);
  } else {
    const extra = kind === "taskList" ? { checked: !!opts.checked } : undefined;
    const wrap = L!.create(kind === "orderedList" && opts.start ? { start: opts.start } : null, I!.create(attrsFor(I!, item.attrs, extra)));
    tr.step(new ReplaceAroundStep(lp, lEnd, ip + 1, iEnd - 1, new Slice(Fragment.from(wrap), 0, 0), 2, true));
    // 3. A list of the same kind right after or right before takes it in (the later seam first).
    joinLists(tr, lp + item.content.size + 4);
  }
  joinLists(tr, lp);
  return "done";
}

/** A plain paragraph (not in a list) turned into a to-do, with its text kept. False when it can't be. */
export function wrapInTodo(tr: Transaction, checked: boolean): boolean {
  const { $from, $to } = tr.selection;
  if ($from.parent.type.name !== "paragraph" || !$from.sameParent($to)) return false;
  for (let d = $from.depth - 1; d > 0; d--) if (ITEMS.has($from.node(d).type.name)) return false;
  const range = $from.blockRange($to);
  const item = tr.doc.type.schema.nodes.taskItem;
  const wrap = range && item && findWrapping(range, item, { checked });
  if (!range || !wrap) return false;
  tr.wrap(range, wrap);
  return true;
}

/**
 * Backspace at the very start of a line, the way Notion does it, for lines in and around lists: on an item's own
 * line the item becomes plain text where it is; on a plain line inside an item or right under a list, the line joins
 * the end of the line above (an empty one just goes). False when it's none of those, so the editor does its usual
 * thing. A line never cycles through list kinds and depths.
 */
export function backspaceAtStart(tr: Transaction): boolean {
  const sel = tr.selection;
  if (!sel.empty || sel.$from.parentOffset !== 0) return false;
  if (ownItem(tr)) return turnItem(tr, "text") === "done";
  const $from = sel.$from;
  const para = $from.parent;
  if (para.type.name !== "paragraph" || $from.depth < 1) return false;
  const d = $from.depth;
  const container = $from.node(d - 1);
  const index = $from.index(d - 1);
  const inItem = ITEMS.has(container.type.name) && index > 0;
  const before = index > 0 ? container.child(index - 1) : null;
  if (!inItem && !(before && LISTS.has(before.type.name))) return false;
  const start = $from.before(d);
  const prev = Selection.findFrom(tr.doc.resolve(start), -1, true);
  if (!(prev instanceof TextSelection) || prev.from >= start) return false;
  const target = prev.$from;
  if (!target.parent.canReplace(target.parent.childCount, target.parent.childCount, para.content)) return false;
  const at = target.pos;
  tr.delete(start, start + para.nodeSize);
  joinLists(tr, start);
  if (para.content.size) tr.insert(at, para.content);
  tr.setSelection(TextSelection.create(tr.doc, at));
  return true;
}
