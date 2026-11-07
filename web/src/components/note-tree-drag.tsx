// Dragging pages in the Notes tree. Press a row and move: a line shows where it lands between pages,
// and the middle of a row puts it inside that page. Hovering a folded page opens it after a moment.
// Mouse and pen start after a few pixels (so a click still opens the page); touch starts after a long press.
// Esc cancels. After a move a toast offers Undo. Dragging one of several selected pages moves them all.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { NoteSummary } from "@/lib/api";
import { NoteIcon } from "@/editor/note-icon";
import { cn } from "@/lib/utils";

type Tree = Map<string | null, NoteSummary[]>;
export type NoteDrop = { kind: "line" | "into"; parent: string | null; index: number | undefined; target: string | null; line?: { x: number; y: number; w: number } };

const THRESHOLD = 4;
const LONG_PRESS = 380;
const OPEN_AFTER = 600;
const title = (n: { title: string }) => n.title.trim() || "Untitled";

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Where a page goes: its parent and its place among the parent's pages (none = the end). */
export type Placement = { id: string; parentId: string | null; index?: number };

type Box = { x: number; y: number; w: number; h: number };
/** Somewhere outside the tree that takes a dropped page (the open pages, for split view). */
export type OutsideDrop<D> = { hit(id: string, x: number, y: number): { drop: D; zone: Box | null; line: Box | null } | null; drop(id: string, d: D): void };

export function useNoteTreeDrag<D = unknown>({ list, tree, open, setOpen, place, selected, outside }: {
  outside?: OutsideDrop<D>;
  list: NoteSummary[] | null;
  tree: Tree;
  open: Set<string>;
  setOpen(id: string, on: boolean): void;
  /** Puts the pages there, in this order; resolves when the tree has reloaded. */
  place(items: Placement[]): Promise<void>;
  /** The pages selected right now (Shift+click), outermost only. */
  selected(): string[];
}) {
  const [drag, setDrag] = useState<{ id: string; count: number; x: number; y: number; drop: NoteDrop | null; out: { zone: Box | null; line: Box | null } | null } | null>(null);
  const live = useRef({ list, tree, open, setOpen, place, selected, outside });
  live.current = { list, tree, open, setOpen, place, selected, outside };
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const start = useCallback((n: NoteSummary, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, [role=menuitem]")) return;
    const row = e.currentTarget;
    const treeEl = row.closest<HTMLElement>("[role=tree]");
    if (!treeEl) return;
    const touch = e.pointerType === "touch";
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    let active = false, lastX = x0, lastY = y0, drop: NoteDrop | null = null;
    let press: ReturnType<typeof setTimeout> | undefined;
    let auto: ReturnType<typeof setInterval> | undefined;
    let hover: { id: string; t: number } | null = null;
    let out: { drop: D; zone: Box | null; line: Box | null } | null = null;
    const scroller = scrollParent(treeEl);

    // Pressing one of the selected pages drags the whole selection.
    const sel = live.current.selected();
    const moving = sel.length > 1 && sel.includes(n.id) ? sel : [n.id];
    const movingSet = new Set(moving);
    // The pages and every page under them can't be a target.
    const { tree: t0 } = live.current;
    const banned = new Set<string>(moving);
    const walk = (id: string) => (t0.get(id) ?? []).forEach((k) => (banned.add(k.id), walk(k.id)));
    moving.forEach(walk);
    const sibsOf = (parent: string | null) => (live.current.tree.get(parent) ?? []).filter((s) => !movingSet.has(s.id));
    const byId = (id: string) => live.current.list?.find((x) => x.id === id);
    const fromParent = n.parentId ?? null;
    const fromIndex = (live.current.tree.get(fromParent) ?? []).findIndex((s) => s.id === n.id);
    // Where each one was, for Undo.
    const before: Placement[] = moving.map((id) => {
      const x = byId(id);
      const p = x?.parentId ?? null;
      return { id, parentId: p, index: (t0.get(p) ?? []).findIndex((s) => s.id === id) };
    });

    const lineFor = (r: HTMLElement, y: number, depthPlus = 0) => {
      const box = r.getBoundingClientRect();
      const pad = parseFloat(r.style.paddingLeft || "0") + depthPlus * 16;
      return { x: box.left + pad, y, w: box.width - pad - 4 };
    };

    const dropAt = (y: number): NoteDrop | null => {
      const rows = [...treeEl.querySelectorAll<HTMLElement>("[data-note-row]")].filter((r) => !banned.has(r.dataset.noteRow!));
      if (!rows.length) return null;
      const first = rows[0].getBoundingClientRect();
      const lastEl = rows[rows.length - 1];
      if (y < first.top) {
        const f = byId(rows[0].dataset.noteRow!);
        return f ? { kind: "line", parent: f.parentId ?? null, index: sibsOf(f.parentId ?? null).findIndex((s) => s.id === f.id), target: null, line: lineFor(rows[0], first.top) } : null;
      }
      if (y > lastEl.getBoundingClientRect().bottom) {
        // Past the last page: the end of the top level.
        const r0 = rows.find((r) => byId(r.dataset.noteRow!)?.parentId == null) ?? rows[0];
        return { kind: "line", parent: null, index: sibsOf(null).length, target: null, line: { ...lineFor(r0, lastEl.getBoundingClientRect().bottom) } };
      }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], box = r.getBoundingClientRect();
        if (y < box.top || y > box.bottom) continue;
        const p = byId(r.dataset.noteRow!);
        if (!p) return null;
        const parent = p.parentId ?? null;
        const edge = Math.min(10, box.height * 0.3);
        const at = sibsOf(parent).findIndex((s) => s.id === p.id);
        if (y < box.top + edge) return { kind: "line", parent, index: at, target: null, line: lineFor(r, box.top) };
        if (y > box.bottom - edge) {
          // Under an open page that has pages showing: first one inside it.
          const kids = sibsOf(p.id);
          if (kids.length && live.current.open.has(p.id)) return { kind: "line", parent: p.id, index: 0, target: null, line: lineFor(r, box.bottom, 1) };
          return { kind: "line", parent, index: at + 1, target: null, line: lineFor(r, box.bottom) };
        }
        return { kind: "into", parent: p.id, index: undefined, target: p.id };
      }
      // In the gap between two rows: the line between them.
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].getBoundingClientRect(), b = rows[i].getBoundingClientRect();
        if (y > a.bottom && y < b.top) {
          const p = byId(rows[i].dataset.noteRow!);
          if (!p) return null;
          return { kind: "line", parent: p.parentId ?? null, index: sibsOf(p.parentId ?? null).findIndex((s) => s.id === p.id), target: null, line: lineFor(rows[i], (a.bottom + b.top) / 2) };
        }
      }
      return null;
    };
    const isNoop = (d: NoteDrop) => moving.length === 1 && d.parent === fromParent && (d.kind === "into" ? false : d.index === fromIndex);
    const sameParentInto = (d: NoteDrop) => moving.length === 1 && d.kind === "into" && d.parent === fromParent;

    const update = (x: number, y: number) => {
      lastX = x;
      lastY = y;
      // Off the tree, over the open pages: one page (not a folder) can open there.
      const offTree = !treeEl.contains(document.elementFromPoint(x, y)) && !(scroller ?? treeEl).contains(document.elementFromPoint(x, y));
      out = offTree && moving.length === 1 && n.kind !== "folder" ? (live.current.outside?.hit(n.id, x, y) ?? null) : null;
      if (offTree) {
        drop = null;
        hover = null;
        setDrag({ id: n.id, count: moving.length, x, y, drop: null, out: out && { zone: out.zone, line: out.line } });
        return;
      }
      drop = dropAt(y);
      if (drop && (isNoop(drop) || sameParentInto(drop))) drop = drop.kind === "into" ? null : { ...drop, line: undefined };
      if (drop?.kind === "into" && drop.target && !live.current.open.has(drop.target) && (live.current.tree.get(drop.target) ?? []).length) {
        if (hover?.id !== drop.target) hover = { id: drop.target, t: performance.now() };
        else if (performance.now() - hover.t > OPEN_AFTER) {
          live.current.setOpen(drop.target, true);
          hover = null;
        }
      } else hover = null;
      setDrag({ id: n.id, count: moving.length, x, y, drop, out: null });
    };

    const begin = () => {
      active = true;
      try { row.setPointerCapture(pid); } catch { /* the pointer may be gone */ }
      document.body.classList.add("note-dragging");
      navigator.vibrate?.(8);
      update(lastX, lastY);
      auto = setInterval(() => {
        if (out || !treeEl.contains(document.elementFromPoint(lastX, lastY))) return;
        const box = (scroller ?? document.documentElement).getBoundingClientRect();
        const top = scroller ? box.top : 0, bottom = scroller ? box.bottom : innerHeight;
        const edge = 48;
        const v = lastY < top + edge ? -Math.ceil((top + edge - lastY) / 3) : lastY > bottom - edge ? Math.ceil((lastY - (bottom - edge)) / 3) : 0;
        if (v) {
          if (scroller) scroller.scrollTop += v;
          else scrollBy(0, v);
          update(lastX, lastY);
        }
      }, 16);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!active) {
        const far = Math.hypot(ev.clientX - x0, ev.clientY - y0) > THRESHOLD;
        if (touch) {
          if (far) finish(false); // a scroll, not a drag
          return;
        }
        lastX = ev.clientX;
        lastY = ev.clientY;
        if (far) begin();
        return;
      }
      ev.preventDefault();
      update(ev.clientX, ev.clientY);
    };
    // While dragging on touch, the page must not scroll.
    const onTouchMove = (ev: TouchEvent) => active && ev.preventDefault();
    // The click that ends a drag must not open the page.
    const eatClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && active) {
        ev.preventDefault();
        finish(false);
      }
    };

    function finish(commit: boolean) {
      clearTimeout(press);
      clearInterval(auto);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("touchmove", onTouchMove);
      document.body.classList.remove("note-dragging");
      cleanup.current = null;
      if (active) {
        window.addEventListener("click", eatClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", eatClick, true), 0);
      }
      setDrag(null);
      if (commit && active && out) return void live.current.outside?.drop(n.id, out.drop);
      const d = drop;
      if (!commit || !active || !d || d.line === undefined && d.kind === "line") return;
      const to = d.parent;
      void (async () => {
        try {
          await live.current.place(moving.map((id, k) => ({ id, parentId: to, index: d.index === undefined ? undefined : d.index + k })));
          if (to) live.current.setOpen(to, true);
          const where = to ? `inside “${title(byId(to) ?? { title: "" })}”` : before.some((b) => b.parentId) ? "to the top level" : "";
          const what = moving.length > 1 ? `${moving.length} pages` : `“${title(n)}”`;
          toast(`Moved ${what}${where ? ` ${where}` : ""}`, {
            action: { label: "Undo", onClick: () => void live.current.place(before) },
          });
        } catch (err) {
          toast.error((err as Error).message);
        }
      })();
    }
    const onUp = (ev: PointerEvent) => ev.pointerId === pid && finish(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === pid && finish(false);

    cleanup.current?.();
    cleanup.current = () => finish(false);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    if (touch) press = setTimeout(begin, LONG_PRESS);
  }, []);

  const dragged = drag ? live.current.list?.find((x) => x.id === drag.id) : undefined;
  const overlay =
    drag &&
    createPortal(
      <>
        {drag.out?.zone && <div className="note-drop-zone" style={{ left: drag.out.zone.x, top: drag.out.zone.y, width: drag.out.zone.w, height: drag.out.zone.h }} aria-hidden />}
        {drag.out?.line && <div className="note-drop-tabline" style={{ left: drag.out.line.x, top: drag.out.line.y, height: drag.out.line.h }} aria-hidden />}
        {drag.drop?.line && (
          <div className="note-tree-line" style={{ left: drag.drop.line.x, top: drag.drop.line.y, width: drag.drop.line.w }} aria-hidden />
        )}
        {dragged && (
          <div className={cn("note-drag-chip", !drag.drop && !drag.out && "is-nowhere")} style={{ left: drag.x + 18, top: drag.y + 16 }} aria-hidden>
            <NoteIcon icon={dragged.icon} size={16} />
            <span className="truncate">{drag.count > 1 ? `${title(dragged)} and ${drag.count - 1} more` : title(dragged)}</span>
          </div>
        )}
      </>,
      document.body,
    );

  return { start, overlay, draggingId: drag?.id ?? null, draggingMany: (drag?.count ?? 0) > 1, targetId: drag?.drop?.kind === "into" ? drag.drop.target : null };
}
