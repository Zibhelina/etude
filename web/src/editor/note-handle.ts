// The block handle, like Notion's: hover a block and a ⋮⋮ grip shows on its left. Drag the
// grip to move the block (a line shows where it lands); click it for the block menu (turn into, colour, align,
// duplicate, delete); Blocks inside columns get their own handle.
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

export const BLOCK_MENU_EVENT = "etude:note-block-menu";
export interface BlockMenuDetail {
  pos: number;
  rect: DOMRect;
  view: EditorView;
}

const GRIP = `<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>`;

/** The block under a point: the outermost block, or one inside a column. Returns its start position. */
function blockAt(view: EditorView, x: number, y: number): { pos: number; dom: HTMLElement } | null {
  const box = view.dom.getBoundingClientRect();
  if (y < box.top || y > box.bottom) return null;
  // Probe a little inside the text column so the gutter on the left still finds the block beside it.
  const hit = view.posAtCoords({ left: Math.min(Math.max(x, box.left + 24), box.right - 8), top: y });
  if (!hit) return null;
  const $p = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  // The deepest block that sits in the page or in a column (a row of columns itself is moved from its edge).
  let depth = 0;
  for (let d = 1; d <= $p.depth; d++) {
    const parent = $p.node(d - 1).type.name;
    // Blocks of the page, and blocks in a row of columns that is itself in the page (not in a table or callout).
    if (parent === "doc" || (parent === "column" && d === 3)) depth = d;
  }
  if (!depth) {
    // Right on an atom at the top level (a picture, an equation, a card).
    const after = $p.nodeAfter;
    if ($p.depth === 0 && after) {
      const dom = view.nodeDOM($p.pos) as HTMLElement | null;
      return dom ? { pos: $p.pos, dom } : null;
    }
    return null;
  }
  // Left of a row of columns (in the gutter): the whole row.
  if ($p.depth >= 1 && $p.node(1).type.name === "columns") {
    const rowPos = $p.before(1);
    const rowDom = view.nodeDOM(rowPos) as HTMLElement | null;
    if (rowDom && x < rowDom.getBoundingClientRect().left + 2) return { pos: rowPos, dom: rowDom };
  }
  const pos = $p.before(depth);
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  return dom && dom.nodeType === 1 ? { pos, dom } : null;
}

/** The column (inside a row) around a DOM element, with its position. */
function columnOf(view: EditorView, el: Element | null): { pos: number; dom: HTMLElement; rowPos: number; count: number } | null {
  const col = el?.closest?.(".note-col") as HTMLElement | null;
  if (!col || !view.dom.contains(col)) return null;
  try {
    const $p = view.state.doc.resolve(view.posAtDOM(col, 0));
    // Only rows of columns that sit right in the page (doc > columns > column).
    if ($p.depth >= 2 && $p.node(2).type.name === "column") return { pos: $p.before(2), dom: col, rowPos: $p.before(1), count: $p.node(1).childCount };
  } catch {}
  return null;
}

// ---------------------------------------------------------------- moving blocks and columns

type Moving = { pos: number; node: PMNode; kind: "block" | "column" };
type Target = { kind: "between"; pos: number } | { kind: "sideCol"; pos: number; side: "left" | "right" } | { kind: "sideBlock"; pos: number; side: "left" | "right" };

/** The page after moving `src` to `tgt`, rebuilt from the old one. A column dropped between blocks becomes plain
 * blocks again (full width), a block dropped at a side makes or joins a row of columns, and a row left with one
 * column turns back into its blocks. Untouched blocks keep their identity, so cards and equations don't reload. */
function moved(doc: PMNode, schema: Schema, src: Moving, tgt: Target): PMNode[] | null {
  const S = schema.nodes;
  const asBlocks = (): PMNode[] => (src.kind === "column" ? (src.node.content as any).content.slice() : [src.node]);
  const asColumn = (): PMNode => (src.kind === "column" ? src.node : S.column.create(null, src.node));
  const touches = (start: number, size: number) => {
    const end = start + size;
    const inside = (p: number) => p > start && p < end;
    return inside(src.pos) || inside(tgt.pos) || (tgt.kind === "between" && tgt.pos === end - 1);
  };
  const kids = (container: PMNode, start: number): PMNode[] => {
    const out: PMNode[] = [];
    let p = start;
    container.forEach((child) => {
      const cp = p;
      p += child.nodeSize;
      if (tgt.kind === "between" && tgt.pos === cp) out.push(...asBlocks());
      if (cp === src.pos) return;
      let c = child;
      if (child.type.name === "columns") {
        if (touches(cp, child.nodeSize)) {
          const cols = kids(child, cp + 1).filter((k) => k.childCount > 0);
          if (cols.length >= 2) out.push(child.type.create(child.attrs, cols));
          else if (cols.length === 1) cols[0].forEach((b) => void out.push(b));
          return;
        }
      } else if (child.type.name === "column") {
        if (touches(cp, child.nodeSize)) c = child.type.create(child.attrs, kids(child, cp + 1));
        if (tgt.kind === "sideCol" && tgt.pos === cp) return void out.push(...(tgt.side === "left" ? [asColumn(), c] : [c, asColumn()]));
        return void out.push(c);
      }
      if (tgt.kind === "sideBlock" && tgt.pos === cp) {
        const pair = [asColumn(), S.column.create(null, c)];
        return void out.push(S.columns.create(null, tgt.side === "left" ? pair : pair.reverse()));
      }
      out.push(c);
    });
    if (tgt.kind === "between" && tgt.pos === p) out.push(...asBlocks());
    return out;
  };
  const top = kids(doc, 0);
  // What was dragged has to have left its old place exactly once, or nothing moves.
  let seen = 0;
  const want = src.kind === "column" ? src.node.firstChild : src.node;
  for (const n of top) n.descendants((d) => void (d === want && seen++)), n === want && seen++;
  if (seen !== 1) return null;
  try {
    doc.type.createChecked(doc.attrs, top.length ? top : [S.paragraph.create()]);
  } catch {
    return null;
  }
  return top.length ? top : [S.paragraph.create()];
}

/** Where something dragged would land at a point: at the side of a column or a block (making columns), or
 * between blocks. `line` is where to draw the marker, in client coordinates. */
function targetAt(view: EditorView, x: number, y: number, src: Moving): { tgt: Target; line: { left: number; top: number; width: number; height: number } } | null {
  const doc = view.state.doc;
  const b = blockAt(view, x, y);
  if (!b) return null;
  const node = doc.nodeAt(b.pos);
  if (!node) return null;
  const isRow = src.node.type.name === "columns";
  const r = b.dom.getBoundingClientRect();
  const $b = doc.resolve(b.pos);
  const inColumn = $b.parent.type.name === "column";
  // Only right at an edge (or past it) makes columns, so an ordinary drag up or down never does by accident.
  const zone = (w: number) => Math.min(26, w * 0.1);
  // Sides: beside a column (join its row) or beside a top-level block (make a row).
  if (!isRow) {
    const col = inColumn ? columnOf(view, b.dom) : null;
    if (col) {
      const cr = col.dom.getBoundingClientRect();
      const sameRow = src.kind === "column" && doc.resolve(src.pos).before() === col.rowPos;
      const full = col.count >= 4 && !sameRow;
      const side = x < cr.left + zone(cr.width) ? "left" : x > cr.right - zone(cr.width) ? "right" : null;
      if (side && !full && col.pos !== src.pos) return { tgt: { kind: "sideCol", pos: col.pos, side }, line: { left: side === "left" ? cr.left - 14 : cr.right + 11, top: cr.top, width: 3, height: cr.height } };
    } else if (node.type.name !== "columns" && b.pos !== src.pos) {
      const side = x < r.left + zone(r.width) ? "left" : x > r.right - zone(r.width) ? "right" : null;
      if (side) return { tgt: { kind: "sideBlock", pos: b.pos, side }, line: { left: side === "left" ? r.left - 4 : r.right + 1, top: r.top, width: 3, height: r.height } };
    }
  }
  // Between blocks (a whole row only lands between top-level blocks).
  let pos = b.pos;
  let dom = b.dom;
  let n = node;
  if (isRow && inColumn) {
    pos = $b.before(1);
    n = doc.nodeAt(pos)!;
    dom = view.nodeDOM(pos) as HTMLElement;
  }
  const rr = dom.getBoundingClientRect();
  const after = y > rr.top + rr.height / 2;
  return { tgt: { kind: "between", pos: after ? pos + n.nodeSize : pos }, line: { left: rr.left, top: after ? rr.bottom - 1.5 : rr.top - 1.5, width: rr.width, height: 3 } };
}

function applyMove(view: EditorView, src: Moving, tgt: Target) {
  const doc = view.state.doc;
  // Dropping a block right before or after itself changes nothing.
  if (tgt.kind === "between" && tgt.pos >= src.pos && tgt.pos <= src.pos + src.node.nodeSize && src.kind === "block") return;
  const next = moved(doc, view.state.schema, src, tgt);
  if (!next) return;
  const tr = view.state.tr.replaceWith(0, doc.content.size, Fragment.from(next));
  // Select what moved (its first block, for a column that became blocks).
  const want = src.kind === "column" ? src.node.firstChild : src.node;
  let at = -1;
  tr.doc.descendants((n, p) => {
    if (at >= 0) return false;
    if (n === want) at = p;
    return true;
  });
  try {
    tr.setSelection(at >= 0 ? NodeSelection.create(tr.doc, at) : Selection.atStart(tr.doc));
  } catch {}
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export const BlockHandle = Extension.create({
  name: "noteBlockHandle",
  addProseMirrorPlugins() {
    let dragFrom: number | null = null;
    let moving: Moving | null = null;
    // While a grip is pressed, the pointer leaving it must not hide it (that would cancel the drag).
    let pressing = false;
    return [
      new Plugin({
        key: new PluginKey("noteBlockHandle"),
        view(view) {
          const host = view.dom.parentElement!;
          host.classList.add("note-handle-host");
          const el = document.createElement("div");
          el.className = "note-handle";
          el.contentEditable = "false";
          el.innerHTML = `<button type="button" class="note-handle-grip" draggable="true" aria-label="Drag to move, click for options" title="Drag to move · click for options">${GRIP}</button>`;
          const line = document.createElement("div");
          line.className = "note-drop-line";
          // A column's own grip, centred over its top: drag the column like a block.
          const colGrip = document.createElement("button");
          colGrip.type = "button";
          colGrip.className = "note-colgrip";
          colGrip.draggable = true;
          colGrip.contentEditable = "false";
          colGrip.title = "Drag the column · drop it between blocks to make it full width";
          colGrip.setAttribute("aria-label", "Drag the column");
          colGrip.innerHTML = `<svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="2.5" r="1.4"/><circle cx="8" cy="2.5" r="1.4"/><circle cx="13" cy="2.5" r="1.4"/><circle cx="3" cy="7.5" r="1.4"/><circle cx="8" cy="7.5" r="1.4"/><circle cx="13" cy="7.5" r="1.4"/></g></svg>`;
          host.append(el, line, colGrip);
          let col: { pos: number; dom: HTMLElement } | null = null;
          const placeCol = (c: { pos: number; dom: HTMLElement } | null) => {
            col = c;
            if (!c) return void colGrip.classList.remove("is-on");
            const hr = host.getBoundingClientRect();
            const r = c.dom.getBoundingClientRect();
            colGrip.style.transform = `translate(${r.left - hr.left + r.width / 2 - 14}px, ${r.top - hr.top - 17}px)`;
            colGrip.classList.add("is-on");
          };
          let at: { pos: number; dom: HTMLElement } | null = null;
          let hideTimer: ReturnType<typeof setTimeout> | null = null;

          const place = (b: { pos: number; dom: HTMLElement }) => {
            at = b;
            const hr = host.getBoundingClientRect();
            const r = b.dom.getBoundingClientRect();
            // Line up with the first line of text: half a line from the top, or the middle of a short block.
            const cs = getComputedStyle(b.dom);
            const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6 || 26;
            const pad = parseFloat(cs.paddingTop) || 0;
            const mid = Math.min(r.height, lh) / 2 + (r.height > lh ? pad : 0);
            el.style.transform = `translate(${r.left - hr.left - 28}px, ${r.top - hr.top + mid - 13}px)`;
            el.classList.add("is-on");
          };
          const hide = () => {
            el.classList.remove("is-on");
            at = null;
            placeCol(null);
          };
          const onMove = (e: MouseEvent) => {
            if (dragFrom !== null || pressing || !view.editable) return;
            if (hideTimer) clearTimeout(hideTimer);
            if (el.contains(e.target as globalThis.Node) || e.target === colGrip || colGrip.contains(e.target as globalThis.Node)) return;
            const b = blockAt(view, e.clientX, e.clientY);
            if (b) place(b);
            else hideTimer = setTimeout(hide, 250);
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const c = columnOf(view, under);
            if (c) placeCol(c);
            else if (!(under && colGrip.contains(under))) placeCol(null);
          };
          const onLeave = (e: MouseEvent) => {
            if (el.contains(e.relatedTarget as globalThis.Node) || colGrip.contains(e.relatedTarget as globalThis.Node)) return;
            hideTimer = setTimeout(hide, 250);
          };
          host.addEventListener("mousemove", onMove);
          host.addEventListener("mouseleave", onLeave);
          const onKey = () => hide();
          view.dom.addEventListener("keydown", onKey);

          const grip = el.querySelector<HTMLButtonElement>(".note-handle-grip")!;
          const press = () => {
            pressing = true;
            window.addEventListener("mouseup", () => (pressing = false), { once: true });
          };
          grip.addEventListener("mousedown", (e) => (e.stopPropagation(), press()));
          grip.addEventListener("click", (e) => {
            e.preventDefault();
            if (!at) return;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.pos)));
            view.focus();
            window.dispatchEvent(new CustomEvent<BlockMenuDetail>(BLOCK_MENU_EVENT, { detail: { pos: at.pos, rect: grip.getBoundingClientRect(), view } }));
          });
          grip.addEventListener("dragstart", (e) => {
            if (!at || !e.dataTransfer) return;
            const sel = NodeSelection.create(view.state.doc, at.pos);
            view.dispatch(view.state.tr.setSelection(sel));
            dragFrom = at.pos;
            moving = { pos: at.pos, node: view.state.doc.nodeAt(at.pos)!, kind: "block" };
            const slice = sel.content();
            const { dom, text } = view.serializeForClipboard(slice);
            e.dataTransfer.clearData();
            e.dataTransfer.setData("text/html", dom.innerHTML);
            e.dataTransfer.setData("text/plain", text);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setDragImage(at.dom, 0, 12);
            at.dom.classList.add("note-dragging");
            view.dragging = { slice, move: true, node: sel } as any;
            el.classList.add("is-drag");
          });
          colGrip.addEventListener("mousedown", (e) => (e.stopPropagation(), press()));
          colGrip.addEventListener("dragstart", (e) => {
            if (!col || !e.dataTransfer) return;
            const node = view.state.doc.nodeAt(col.pos);
            if (!node) return;
            dragFrom = col.pos;
            moving = { pos: col.pos, node, kind: "column" };
            e.dataTransfer.clearData();
            e.dataTransfer.setData("text/plain", node.textContent);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setDragImage(col.dom, col.dom.getBoundingClientRect().width / 2, 10);
            col.dom.classList.add("note-dragging");
            view.dragging = { slice: view.state.doc.slice(col.pos, col.pos + node.nodeSize), move: true } as any;
            colGrip.classList.add("is-drag");
            el.classList.add("is-drag");
          });
          const endDrag = () => {
            pressing = false;
            view.dom.querySelectorAll(".note-dragging").forEach((n) => n.classList.remove("note-dragging"));
            dragFrom = null;
            moving = null;
            view.dragging = null;
            line.classList.remove("is-on");
            el.classList.remove("is-drag");
            colGrip.classList.remove("is-drag");
            hide();
          };
          grip.addEventListener("dragend", endDrag);
          colGrip.addEventListener("dragend", endDrag);
          const onDragOver = (e: DragEvent) => {
            if (!moving) return;
            e.preventDefault();
            const d = targetAt(view, e.clientX, e.clientY, moving);
            if (!d) return void line.classList.remove("is-on");
            const hr = host.getBoundingClientRect();
            line.style.transform = `translate(${d.line.left - hr.left}px, ${d.line.top - hr.top}px)`;
            line.style.width = `${d.line.width}px`;
            line.style.height = `${d.line.height}px`;
            line.classList.add("is-on");
          };
          const onDrop = (e: DragEvent) => {
            if (!moving) return;
            e.preventDefault();
            e.stopPropagation();
            const m = moving;
            const d = targetAt(view, e.clientX, e.clientY, m);
            endDrag();
            if (d) applyMove(view, m, d.tgt);
          };
          // Capture, so ProseMirror's own drop (which would paste the slice under the pointer) doesn't run too.
          host.addEventListener("dragover", onDragOver);
          host.addEventListener("drop", onDrop, true);
          return {
            destroy() {
              host.removeEventListener("mousemove", onMove);
              host.removeEventListener("mouseleave", onLeave);
              host.removeEventListener("drop", onDrop, true);
              host.removeEventListener("dragover", onDragOver);
              view.dom.removeEventListener("keydown", onKey);
              el.remove();
              line.remove();
              colGrip.remove();
            },
          };
        },
      }),
    ];
  },
});
