// Table controls, like Notion's: hover a table and a + bar shows under it (new row) and at its right (new column).
// Hover a row or column and a small grip shows at its start: drag it to move the row or column, or click it for
// a menu (insert before/after, move, header, clear, delete). Tab still moves cell to cell and adds a row at the end.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { CellSelection, TableMap, moveTableColumn, moveTableRow } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Eraser, Heading, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Hover = { pos: number; el: HTMLTableElement; wrap: HTMLElement; row: number; col: number; rows: number; cols: number };
type Menu = { kind: "row" | "col"; index: number; x: number; y: number; pos: number };

const stop = (e: React.MouseEvent) => e.preventDefault();

/** The table's position in the document from its DOM element. */
function tablePos(editor: Editor, el: HTMLElement): number | null {
  try {
    const p = editor.view.posAtDOM(el, 0);
    const $p = editor.state.doc.resolve(p);
    for (let d = $p.depth; d >= 0; d--) if ($p.node(d).type.name === "table") return $p.before(d);
  } catch {}
  return null;
}

/** Puts the cursor in cell (row, col) of the table at `pos`, so the table commands act there. */
function focusCell(editor: Editor, pos: number, row: number, col: number) {
  const table = editor.state.doc.nodeAt(pos);
  if (!table) return false;
  const map = TableMap.get(table);
  const r = Math.max(0, Math.min(map.height - 1, row));
  const c = Math.max(0, Math.min(map.width - 1, col));
  const cell = pos + 1 + map.map[r * map.width + c];
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cell + 2)));
  return true;
}

/** Selects a whole row or column (shown highlighted while its menu is open). */
function selectLine(editor: Editor, pos: number, kind: "row" | "col", index: number) {
  const table = editor.state.doc.nodeAt(pos);
  if (!table) return;
  const map = TableMap.get(table);
  const at = (r: number, c: number) => editor.state.doc.resolve(pos + 1 + map.map[r * map.width + c]);
  const sel = kind === "row" ? CellSelection.create(editor.state.doc, at(index, 0).pos, at(index, map.width - 1).pos) : CellSelection.create(editor.state.doc, at(0, index).pos, at(map.height - 1, index).pos);
  editor.view.dispatch(editor.state.tr.setSelection(sel));
}

export function TableControls({ editor }: { editor: Editor }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<{ kind: "row" | "col"; from: number; to: number } | null>(null);
  const [, tick] = useState(0);
  const menuBox = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;

  // Which table, row and column the mouse is over.
  useEffect(() => {
    const root = editor.view.dom.parentElement;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const move = (e: MouseEvent) => {
      if (drag || menu) return;
      const t = e.target as HTMLElement;
      if (t.closest?.(".note-tbl-ui")) {
        if (timer) clearTimeout(timer);
        return;
      }
      const wrap = t.closest?.(".tableWrapper") as HTMLElement | null;
      const el = wrap?.querySelector("table") as HTMLTableElement | null;
      if (!wrap || !el) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setHover(null), 220);
        return;
      }
      if (timer) clearTimeout(timer);
      const pos = tablePos(editor, el);
      if (pos === null) return;
      const rows = [...el.rows];
      let row = rows.findIndex((r) => {
        const b = r.getBoundingClientRect();
        return e.clientY >= b.top && e.clientY < b.bottom;
      });
      const first = rows[0];
      const cells = first ? [...first.cells] : [];
      let col = cells.findIndex((c) => {
        const b = c.getBoundingClientRect();
        return e.clientX >= b.left && e.clientX < b.right;
      });
      const prev = hoverRef.current;
      if (row < 0) row = prev?.pos === pos ? prev.row : 0;
      if (col < 0) col = prev?.pos === pos ? prev.col : 0;
      setHover({ pos, el, wrap, row, col, rows: rows.length, cols: cells.length });
    };
    const leave = (e: MouseEvent) => {
      if ((e.relatedTarget as HTMLElement | null)?.closest?.(".note-tbl-ui")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => !drag && !menu && setHover(null), 220);
    };
    root.addEventListener("mousemove", move);
    root.addEventListener("mouseleave", leave);
    return () => {
      root.removeEventListener("mousemove", move);
      root.removeEventListener("mouseleave", leave);
      if (timer) clearTimeout(timer);
    };
  }, [editor, drag, menu]);

  // Redraw on edits and scroll (the table moves).
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    editor.on("transaction", f);
    window.addEventListener("scroll", f, true);
    window.addEventListener("resize", f);
    return () => {
      editor.off("transaction", f);
      window.removeEventListener("scroll", f, true);
      window.removeEventListener("resize", f);
    };
  }, [editor]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuBox.current?.contains(e.target as globalThis.Node) && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const addRow = useCallback(() => {
    const h = hoverRef.current;
    if (!h) return;
    focusCell(editor, h.pos, h.rows - 1, 0);
    editor.chain().focus().addRowAfter().run();
    const table = editor.state.doc.nodeAt(h.pos);
    if (table) focusCell(editor, h.pos, TableMap.get(table).height - 1, 0);
  }, [editor]);
  const addCol = useCallback(() => {
    const h = hoverRef.current;
    if (!h) return;
    focusCell(editor, h.pos, 0, h.cols - 1);
    editor.chain().focus().addColumnAfter().run();
    const table = editor.state.doc.nodeAt(h.pos);
    if (table) focusCell(editor, h.pos, 0, TableMap.get(table).width - 1);
  }, [editor]);

  // Dragging a row or column grip: follow the pointer, then move it.
  const startDrag = (kind: "row" | "col", from: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !hover) return;
    e.preventDefault();
    const h = hover;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let to = from;
    const lines = () => (kind === "row" ? [...h.el.rows].map((r) => r.getBoundingClientRect()) : [...(h.el.rows[0]?.cells ?? [])].map((c) => c.getBoundingClientRect()));
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true;
      const ls = lines();
      const v = kind === "row" ? ev.clientY : ev.clientX;
      to = ls.findIndex((b) => (kind === "row" ? v < b.top + b.height / 2 : v < b.left + b.width / 2));
      if (to < 0) to = ls.length;
      // `to` is a gap index (0..n); the target row index after removing `from`.
      setDrag({ kind, from, to });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!moved) {
        // A click: the menu.
        const g = (e.target as HTMLElement).getBoundingClientRect();
        selectLine(editor, h.pos, kind, from);
        setMenu({ kind, index: from, x: g.left, y: g.bottom + 6, pos: h.pos });
        return;
      }
      const target = to > from ? to - 1 : to;
      if (target === from) return;
      focusCell(editor, h.pos, kind === "row" ? from : 0, kind === "col" ? from : 0);
      const cmd = kind === "row" ? moveTableRow({ from, to: target, pos: h.pos + 1 }) : moveTableColumn({ from, to: target, pos: h.pos + 1 });
      cmd(editor.state, editor.view.dispatch);
      editor.commands.focus();
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  if (!hover || !hover.el.isConnected) return null;
  const tb = hover.el.getBoundingClientRect();
  const wb = hover.wrap.getBoundingClientRect();
  const right = Math.min(tb.right, wb.right);
  const rowEl = hover.el.rows[hover.row];
  const colEl = hover.el.rows[0]?.cells[hover.col];
  const rb = rowEl?.getBoundingClientRect();
  const cb = colEl?.getBoundingClientRect();
  // Drop marker while dragging.
  let marker: React.ReactNode = null;
  if (drag) {
    if (drag.kind === "row") {
      const rs = [...hover.el.rows].map((r) => r.getBoundingClientRect());
      const y = drag.to >= rs.length ? rs[rs.length - 1].bottom : rs[drag.to].top;
      marker = <div className="note-tbl-mark" style={{ left: tb.left, top: y - 1.5, width: right - tb.left, height: 3 }} />;
    } else {
      const cs = [...(hover.el.rows[0]?.cells ?? [])].map((c) => c.getBoundingClientRect());
      const x = drag.to >= cs.length ? cs[cs.length - 1].right : cs[drag.to].left;
      marker = <div className="note-tbl-mark" style={{ left: x - 1.5, top: tb.top, width: 3, height: tb.height }} />;
    }
  }
  const run = (f: () => void) => () => {
    f();
    setMenu(null);
    editor.commands.focus();
  };
  const at = (m: Menu, r: number, c: number) => focusCell(editor, m.pos, r, c);
  return createPortal(
    <div className="note-tbl-ui">
      {rb && (
        <button type="button" className={cn("note-tbl-grip is-row", drag?.kind === "row" && "is-drag")} style={{ left: tb.left - 9, top: rb.top + rb.height / 2 - 12 }} onMouseDown={stop} onPointerDown={startDrag("row", hover.row)} title="Drag to move the row · click for options" aria-label={`Row ${hover.row + 1} options`}>
          <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" /><circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" /><circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" /></g></svg>
        </button>
      )}
      {cb && (
        <button type="button" className={cn("note-tbl-grip is-col", drag?.kind === "col" && "is-drag")} style={{ left: cb.left + cb.width / 2 - 12, top: tb.top - 9 }} onMouseDown={stop} onPointerDown={startDrag("col", hover.col)} title="Drag to move the column · click for options" aria-label={`Column ${hover.col + 1} options`}>
          <svg viewBox="0 0 16 10" width="14" height="8" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="2.5" r="1.4" /><circle cx="8" cy="2.5" r="1.4" /><circle cx="13" cy="2.5" r="1.4" /><circle cx="3" cy="7.5" r="1.4" /><circle cx="8" cy="7.5" r="1.4" /><circle cx="13" cy="7.5" r="1.4" /></g></svg>
        </button>
      )}
      <button type="button" className="note-tbl-add is-row" style={{ left: tb.left, top: tb.bottom + 4, width: right - tb.left }} onMouseDown={stop} onClick={addRow} title="Add a row" aria-label="Add a row">
        <Plus className="size-3.5" />
      </button>
      <button type="button" className="note-tbl-add is-col" style={{ left: right + 4, top: tb.top, height: tb.height }} onMouseDown={stop} onClick={addCol} title="Add a column" aria-label="Add a column">
        <Plus className="size-3.5" />
      </button>
      {marker}
      {menu && (
        <div ref={menuBox} className="note-bm" style={{ left: menu.x, top: menu.y }} role="menu">
          {menu.kind === "row" ? (
            <>
              <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (at(menu, menu.index, 0), editor.chain().addRowBefore().run()))}><ArrowUp className="size-4" /> Insert above</button>
              <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (at(menu, menu.index, 0), editor.chain().addRowAfter().run()))}><ArrowDown className="size-4" /> Insert below</button>
              {menu.index > 0 && <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => moveTableRow({ from: menu.index, to: menu.index - 1, pos: menu.pos + 1 })(editor.state, editor.view.dispatch))}><ArrowUp className="size-4" /> Move up</button>}
              {menu.index < hover.rows - 1 && <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => moveTableRow({ from: menu.index, to: menu.index + 1, pos: menu.pos + 1 })(editor.state, editor.view.dispatch))}><ArrowDown className="size-4" /> Move down</button>}
              {menu.index === 0 && <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (at(menu, 0, 0), editor.chain().toggleHeaderRow().run()))}><Heading className="size-4" /> Header row on/off</button>}
            </>
          ) : (
            <>
              <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (at(menu, 0, menu.index), editor.chain().addColumnBefore().run()))}><ArrowLeft className="size-4" /> Insert left</button>
              <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (at(menu, 0, menu.index), editor.chain().addColumnAfter().run()))}><ArrowRight className="size-4" /> Insert right</button>
              {menu.index > 0 && <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => moveTableColumn({ from: menu.index, to: menu.index - 1, pos: menu.pos + 1 })(editor.state, editor.view.dispatch))}><ArrowLeft className="size-4" /> Move left</button>}
              {menu.index < hover.cols - 1 && <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => moveTableColumn({ from: menu.index, to: menu.index + 1, pos: menu.pos + 1 })(editor.state, editor.view.dispatch))}><ArrowRight className="size-4" /> Move right</button>}
              {menu.index === 0 && <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (at(menu, 0, 0), editor.chain().toggleHeaderColumn().run()))}><Heading className="size-4" /> Header column on/off</button>}
            </>
          )}
          <button type="button" className="note-bm-item" onMouseDown={stop} onClick={run(() => (selectLine(editor, menu.pos, menu.kind, menu.index), editor.chain().deleteSelection().run()))}><Eraser className="size-4" /> Clear</button>
          <div className="note-bm-sep" />
          <button type="button" className="note-bm-item is-danger" onMouseDown={stop} onClick={run(() => (at(menu, menu.kind === "row" ? menu.index : 0, menu.kind === "col" ? menu.index : 0), menu.kind === "row" ? editor.chain().deleteRow().run() : editor.chain().deleteColumn().run()))}><Trash2 className="size-4" /> Delete {menu.kind === "row" ? "row" : "column"}</button>
          <button type="button" className="note-bm-item is-danger" onMouseDown={stop} onClick={run(() => (at(menu, 0, 0), editor.chain().deleteTable().run()))}><Trash2 className="size-4" /> Delete table</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
