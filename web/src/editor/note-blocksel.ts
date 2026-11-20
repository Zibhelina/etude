// Selecting several blocks at once, like Notion. A selection that reaches into a second line (shift-click, a drag,
// Shift+↑/↓, or Shift+click on a grip) takes the whole lines it touches and shows them as selected blocks; then
// they act together: Tab / Shift+Tab indent and outdent them (also under a list of another kind just above, so
// to-dos go under a bullet), Ctrl/⌘+Shift+↑/↓ move them, and the grip of any of them drags them all.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { Fragment, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { liftListItem, sinkListItem } from "@tiptap/pm/schema-list";

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
const ITEMS = new Set(["listItem", "taskItem"]);
const CELLS = new Set(["tableCell", "tableHeader"]);
const isList = (n: PMNode | null | undefined) => !!n && LISTS.has(n.type.name);
const isItem = (n: PMNode | null | undefined) => !!n && ITEMS.has(n.type.name);
const inCell = ($p: ResolvedPos) => {
  for (let d = $p.depth; d > 0; d--) if (CELLS.has($p.node(d).type.name)) return true;
  return false;
};

/** True when the selection covers two or more lines of text (outside tables, which select cells their own way). */
export function spansBlocks(state: EditorState): boolean {
  const s = state.selection;
  if (!(s instanceof TextSelection) || s.empty) return false;
  if (s.$from.start() === s.$to.start()) return false;
  return !inCell(s.$from) && !inCell(s.$to);
}

/** The siblings the selection covers: list items of one list, or blocks of the page or of a column. */
export interface Units {
  parent: PMNode;
  depth: number;
  start: number;
  end: number;
  startIndex: number;
  endIndex: number;
  nodes: PMNode[];
  items: boolean;
}

export function selectedUnits(state: EditorState): Units | null {
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (n) => isList(n) || n.type.name === "doc" || n.type.name === "column");
  if (!range) return null;
  const nodes: PMNode[] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) nodes.push(range.parent.child(i));
  return { parent: range.parent, depth: range.depth, start: range.start, end: range.end, startIndex: range.startIndex, endIndex: range.endIndex, nodes, items: isList(range.parent) };
}

/** The selected blocks the grip at `pos` belongs to, when several are selected and it's one of them. */
export function groupAt(state: EditorState, pos: number): Units | null {
  if (!spansBlocks(state)) return null;
  const u = selectedUnits(state);
  if (!u || u.nodes.length < 2) return null;
  let p = u.start;
  for (const n of u.nodes) {
    if (p === pos) return u;
    p += n.nodeSize;
  }
  return null;
}

/** Selects whole lines from the first text in [a, b] to the last one. */
export function selectLines(tr: Transaction, a: number, b: number): Transaction {
  let first = -1;
  let last = -1;
  tr.doc.nodesBetween(Math.max(0, a), Math.min(b, tr.doc.content.size), (n, p) => {
    if (!n.isTextblock) return true;
    if (first < 0) first = p + 1;
    last = p + n.nodeSize - 1;
    return false;
  });
  if (first >= 0) tr.setSelection(TextSelection.create(tr.doc, first, last));
  return tr;
}

/** Extends the selection to the block at `pos` (Shift+click on its grip). */
export function extendTo(view: EditorView, pos: number) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  const s = state.selection;
  const fwd = pos >= s.from;
  const anchor = fwd ? s.from : s.to;
  const tr = state.tr;
  let head = -1;
  node.descendants((n, p) => {
    if (!n.isTextblock) return true;
    const at = pos + 1 + p;
    if (fwd) head = at + n.nodeSize - 1;
    else if (head < 0) head = at + 1;
    return false;
  });
  if (node.isTextblock) head = fwd ? pos + node.nodeSize - 1 : pos + 1;
  if (head < 0) return;
  view.dispatch(tr.setSelection(TextSelection.create(state.doc, anchor, head)));
}

/** A selection across lines, widened to the whole lines it touches. */
function wholeLines(state: EditorState): Transaction | null {
  if (!spansBlocks(state)) return null;
  const s = state.selection;
  const fwd = s.anchor < s.head;
  const a = fwd ? s.$anchor.start() : s.$anchor.end();
  const h = fwd ? s.$head.end() : s.$head.start();
  if (a === s.anchor && h === s.head) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, a, h));
}

/** What gets the selected-block tint: each list item whose own line is selected (with what's nested in it, since it
 * moves with it), or each line of text outside lists. */
function tinted(state: EditorState): Decoration[] {
  if (!spansBlocks(state)) return [];
  const { from, to } = state.selection;
  const out: Decoration[] = [];
  state.doc.nodesBetween(from, to, (n, p) => {
    if (isItem(n)) {
      const line = n.firstChild;
      const a = p + 1;
      const b = a + (line ? line.nodeSize : 0);
      if (from < b && to > a) {
        out.push(Decoration.node(p, p + n.nodeSize, { class: "note-block-sel" }));
        return false;
      }
      return true;
    }
    if (n.isTextblock || (n.isBlock && n.isAtom)) {
      out.push(Decoration.node(p, p + n.nodeSize, { class: "note-block-sel" }));
      return false;
    }
    return true;
  });
  return out;
}

// ---------------------------------------------------------------- indent, outdent, move

type Group = { listPos: number; list: PMNode; i: number; j: number };

/** The list items the selection covers, list by list (several when it runs across lists side by side). */
function groups(state: EditorState): Group[] | null {
  const u = selectedUnits(state);
  if (!u) return null;
  const { $from, $to } = state.selection;
  if (u.items) return [{ listPos: $from.before(u.depth), list: u.parent, i: u.startIndex, j: u.endIndex }];
  if (!u.nodes.every(isList)) return null;
  const out: Group[] = [];
  let p = u.start;
  u.nodes.forEach((list, k) => {
    const i = k === 0 ? $from.index(u.depth + 1) : 0;
    const j = k === u.nodes.length - 1 ? $to.index(u.depth + 1) + 1 : list.childCount;
    out.push({ listPos: p, list, i, j });
    p += list.nodeSize;
  });
  return out;
}

const itemPos = (g: Group, k: number) => {
  let p = g.listPos + 1;
  for (let x = 0; x < k; x++) p += g.list.child(x).nodeSize;
  return p;
};

/** Tab: the selected items go one level in, under the item just above them. That item can be in a list of another
 * kind (to-dos under a bullet); each moved item keeps its own kind. */
function indent(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const gs = groups(state);
  if (!gs || !gs.length) return false;
  const first = gs[0];
  // One list with an item above: ProseMirror's own sink does it.
  if (gs.length === 1 && first.i > 0) return sinkListItem(first.list.child(first.i).type)(state, dispatch);
  let D: PMNode;
  let Dpos: number;
  if (first.i > 0) {
    D = first.list.child(first.i - 1);
    Dpos = itemPos(first, first.i - 1);
  } else {
    const prev = state.doc.resolve(first.listPos).nodeBefore;
    if (!isList(prev) || !prev!.lastChild) return false;
    D = prev!.lastChild;
    Dpos = first.listPos - 1 - D.nodeSize;
  }
  const lists = gs.map((g) => {
    const items: PMNode[] = [];
    for (let k = g.i; k < g.j; k++) items.push(g.list.child(k));
    return g.list.type.create(g.list.attrs, items);
  });
  if (!lists.every((l) => D.type.validContent(D.content.append(Fragment.from(l))))) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  for (const g of gs.slice().reverse()) {
    if (g.i === 0 && g.j === g.list.childCount) tr.delete(g.listPos, g.listPos + g.list.nodeSize);
    else tr.delete(itemPos(g, g.i), itemPos(g, g.j));
  }
  const Dend = Dpos + D.nodeSize - 1;
  let start = Dend;
  let pos = Dend;
  let rest = lists;
  if (D.lastChild && D.lastChild.type === lists[0].type) {
    start = Dend - 1;
    tr.insert(start, lists[0].content);
    pos = Dend + lists[0].content.size;
    rest = lists.slice(1);
  }
  const restFrag = Fragment.fromArray(rest);
  if (rest.length) tr.insert(pos, restFrag);
  selectLines(tr, start, pos + restFrag.size);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Shift+Tab out of a list that sits in an item of another kind (to-dos under a bullet): the selected items come back
 * out as a list of their own right under that item, and the ones after them nest under the last one, like Notion. */
function outdent(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const u = selectedUnits(state);
  if (!u || !u.items || u.depth < 2) return false;
  const { $from } = state.selection;
  const P = $from.node(u.depth - 1);
  const L = $from.node(u.depth - 2);
  if (!isItem(P) || !isList(L)) return false;
  // Same kind: ProseMirror's own lift does it.
  if (P.type === u.nodes[0].type) return false;
  if (!dispatch) return true;
  const N = u.parent;
  const moved = u.nodes.slice();
  const trailing: PMNode[] = [];
  for (let k = u.endIndex; k < N.childCount; k++) trailing.push(N.child(k));
  if (trailing.length) {
    const last = moved[moved.length - 1];
    const sub = last.lastChild && last.lastChild.type === N.type ? last.lastChild : null;
    const content = sub ? last.content.replaceChild(last.childCount - 1, sub.copy(sub.content.append(Fragment.fromArray(trailing)))) : last.content.addToEnd(N.type.create(N.attrs, trailing));
    moved[moved.length - 1] = last.copy(content);
  }
  const keptN: PMNode[] = [];
  for (let k = 0; k < u.startIndex; k++) keptN.push(N.child(k));
  const nIndex = $from.index(u.depth - 1);
  const kids: PMNode[] = [];
  P.forEach((c, _, i) => void (i !== nIndex ? kids.push(c) : keptN.length && kids.push(N.copy(Fragment.fromArray(keptN)))));
  const newP = P.copy(Fragment.fromArray(kids));
  const M = N.type.create(N.attrs, moved);
  const pIndex = $from.index(u.depth - 2);
  const before: PMNode[] = [];
  const after: PMNode[] = [];
  L.forEach((c, _, i) => void (i < pIndex ? before.push(c) : i > pIndex ? after.push(c) : null));
  const L1 = L.copy(Fragment.fromArray([...before, newP]));
  const out = [L1, M, ...(after.length ? [L.copy(Fragment.fromArray(after))] : [])];
  const Lpos = $from.before(u.depth - 2);
  const tr = state.tr.replaceWith(Lpos, Lpos + L.nodeSize, Fragment.fromArray(out));
  const mStart = Lpos + L1.nodeSize;
  // Select the lines that moved (not the ones that came along under the last).
  let endLine = mStart + 1;
  for (let k = 0; k < u.nodes.length; k++) endLine += moved[k].nodeSize;
  const lastMoved = moved[u.nodes.length - 1];
  selectLines(tr, mStart, endLine - lastMoved.nodeSize + 1 + (lastMoved.firstChild?.nodeSize ?? 0));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Ctrl/⌘+Shift+↑/↓: the selected blocks (or the one with the cursor) swap places with the one above or below. */
function move(dir: -1 | 1) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const u = selectedUnits(state);
    if (!u) return false;
    const other = dir < 0 ? (u.startIndex > 0 ? u.parent.child(u.startIndex - 1) : null) : u.endIndex < u.parent.childCount ? u.parent.child(u.endIndex) : null;
    // At the top or bottom of its list or the page: nothing to do, but the key is still ours.
    if (!other) return true;
    if (!dispatch) return true;
    const s = state.selection;
    const frag = Fragment.fromArray(u.nodes);
    const tr = state.tr;
    if (dir < 0) tr.replaceWith(u.start - other.nodeSize, u.end, frag.addToEnd(other));
    else tr.replaceWith(u.start, u.end + other.nodeSize, Fragment.from(other).append(frag));
    const d = dir * other.nodeSize;
    tr.setSelection(TextSelection.create(tr.doc, s.anchor + d, s.head + d));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Moves the selected blocks, by their grip, to `pos`. `wrap`: they were list items and land between blocks, so they
 * become a list of their own. */
export function moveGroup(view: EditorView, u: Units, pos: number, wrap: boolean) {
  if (pos >= u.start && pos <= u.end) return;
  const { state } = view;
  const tr = state.tr;
  const $s = state.doc.resolve(u.start);
  if (u.items && u.parent.childCount === u.nodes.length) tr.delete($s.before(), $s.after());
  else tr.delete(u.start, u.end);
  const at = tr.mapping.map(pos, pos > u.start ? 1 : -1);
  const frag = Fragment.fromArray(u.nodes);
  const ins = wrap && u.items ? Fragment.from(u.parent.type.create(u.parent.attrs, frag)) : frag;
  try {
    tr.insert(at, ins);
  } catch {
    return;
  }
  selectLines(tr, at, at + ins.size);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Deletes or duplicates the selected blocks (the block menu, with several selected). */
export function deleteGroup(view: EditorView, u: Units) {
  const tr = view.state.tr;
  const $s = view.state.doc.resolve(u.start);
  if (u.items && u.parent.childCount === u.nodes.length) tr.delete($s.before(), $s.after());
  else tr.delete(u.start, u.end);
  const p = Math.min(u.start, tr.doc.content.size);
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(p)));
  } catch {}
  view.dispatch(tr);
}

export function duplicateGroup(view: EditorView, u: Units) {
  const frag = Fragment.fromArray(u.nodes.map((n) => n.copy(n.content)));
  const tr = view.state.tr.insert(u.end, frag);
  selectLines(tr, u.end, u.end + frag.size);
  view.dispatch(tr);
}

export const BlockSelection = Extension.create({
  name: "noteBlockSelection",
  // Before the lists' own Tab and Shift+Tab, so several items and lists of different kinds are handled here.
  priority: 1000,
  addKeyboardShortcuts() {
    const run = (f: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => () => f(this.editor.state, (tr) => this.editor.view.dispatch(tr));
    return {
      Tab: () => {
        const ok = run(indent)();
        // With several blocks selected the key never leaves the page (the browser would move focus away).
        return ok || spansBlocks(this.editor.state);
      },
      "Shift-Tab": () => run(outdent)() || false,
      "Mod-Shift-ArrowUp": run(move(-1)),
      "Mod-Shift-ArrowDown": run(move(1)),
    };
  },
  addProseMirrorPlugins() {
    let pointing = false;
    return [
      new Plugin({
        key: new PluginKey("noteBlockSelection"),
        // While the mouse is down the selection follows it freely; on release it takes whole lines.
        appendTransaction(trs, _old, state) {
          if (pointing || !trs.some((t) => t.selectionSet)) return null;
          return wholeLines(state);
        },
        view(view) {
          const down = (e: MouseEvent) => {
            if (e.button !== 0) return;
            pointing = true;
            window.addEventListener(
              "mouseup",
              () => {
                pointing = false;
                // After ProseMirror has read the final selection from the page.
                setTimeout(() => {
                  if (view.isDestroyed) return;
                  const tr = wholeLines(view.state);
                  if (tr) view.dispatch(tr);
                }, 0);
              },
              { once: true },
            );
          };
          view.dom.addEventListener("mousedown", down);
          return { destroy: () => view.dom.removeEventListener("mousedown", down) };
        },
        props: {
          decorations: (state) => {
            const d = tinted(state);
            return d.length ? DecorationSet.create(state.doc, d) : null;
          },
          attributes: (state): Record<string, string> => (spansBlocks(state) ? { class: "has-block-sel" } : {}),
        },
      }),
    ];
  },
});
