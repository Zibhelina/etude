// A kanban board: columns of cards you drag around, like Trello. The same component draws the board open on its
// own and inside a page's portal (compact). A card opens as a sheet over the board, and its body is a real page
// (the Notebook's editor), so it can hold to-dos (they show as n/m on the card), equations, code, canvases or
// study cards. The board is plain data (KanbanBoard); whoever shows it keeps it and saves it.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft, Archive, CalendarDays, Check, CheckSquare, Layers, MoreHorizontal, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { KANBAN_COLORS, type KanbanBoard, type KanbanCard, type KanbanColor, type KanbanColumn, type KanbanLabel, type NoteDoc } from "@/lib/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { playSound } from "@/lib/sounds";
import { cn } from "@/lib/utils";
import { NoteEditor } from "./note-editor";
import type { NoteLinkOptions } from "./note-link";

export const kanbanId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 8);
const nowIso = () => new Date().toISOString();
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sent with { id, board, from } whenever a board changes in this window, so every place showing it follows. */
export const KANBAN_CHANGED = "etude:kanban-changed";
const LATEST = new Map<string, KanbanBoard>();
/** The newest version of a board this window has seen (a view opened again starts from it, not from an older copy). */
export const latestBoard = (id: string): KanbanBoard | undefined => LATEST.get(id);
export const kanbanChanged = (id: string, board: KanbanBoard, from: string) => {
  LATEST.set(id, board);
  window.dispatchEvent(new CustomEvent(KANBAN_CHANGED, { detail: { id, board, from } }));
};

export const COLOR_NAME: Record<KanbanColor, string> = { grey: "Grey", red: "Red", orange: "Orange", gold: "Gold", green: "Green", teal: "Teal", blue: "Blue", purple: "Purple", pink: "Pink" };
export const colorVar = (c: KanbanColor | null | undefined) => `var(--kb-${c ?? "grey"})`;

// ---------------------------------------------------------------- small helpers

const today = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
/** A due day as a short word and how it reads: late, today/tomorrow, or done. */
export function dueInfo(due: string | null, done: boolean): { text: string; tone: "" | "soon" | "late" | "ok" } | null {
  if (!due) return null;
  const [y, m, d] = due.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const diff = Math.round((day.getTime() - today().getTime()) / 864e5);
  const text = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : day.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(day.getFullYear() !== today().getFullYear() ? { year: "numeric" } : {}) });
  return { text, tone: done ? "ok" : diff < 0 ? "late" : diff <= 1 ? "soon" : "" };
}
/** The to-dos on a card's page: how many, how many ticked. */
export function todosOf(doc: NoteDoc | undefined): { all: number; done: number } {
  let all = 0;
  let done = 0;
  const walk = (n: any) => {
    if (n?.type === "taskItem") {
      all++;
      if (n.attrs?.checked) done++;
    }
    n?.content?.forEach(walk);
  };
  walk(doc);
  return { all, done };
}
const hasBody = (doc: NoteDoc | undefined) => {
  const c = (doc as any)?.content as any[] | undefined;
  return !!c && c.some((b) => b.type !== "taskList" && (b.type !== "paragraph" || (b.content?.length ?? 0) > 0));
};
const hasStudy = (doc: NoteDoc | undefined) => JSON.stringify(doc ?? {}).includes('"noteCards"');
const colOfCard = (b: KanbanBoard, id: string) => b.columns.find((c) => c.cards.includes(id)) ?? null;
const clone = (b: KanbanBoard): KanbanBoard => ({ ...b, columns: b.columns.map((c) => ({ ...c, cards: [...c.cards] })), cards: { ...b.cards }, labels: [...b.labels], archived: [...b.archived] });

/** Moves a card to `col` at `index` (in the column without the card). */
function placed(b: KanbanBoard, id: string, col: string, index: number): KanbanBoard {
  const n = clone(b);
  for (const c of n.columns) c.cards = c.cards.filter((k) => k !== id);
  const to = n.columns.find((c) => c.id === col);
  if (to) to.cards.splice(Math.max(0, Math.min(index, to.cards.length)), 0, id);
  return n;
}
function placedCol(b: KanbanBoard, id: string, index: number): KanbanBoard {
  const n = clone(b);
  const c = n.columns.find((x) => x.id === id)!;
  n.columns = n.columns.filter((x) => x.id !== id);
  n.columns.splice(Math.max(0, Math.min(index, n.columns.length)), 0, c);
  return n;
}

export interface KanbanFilter {
  q: string;
  labels: Set<string>;
  due: boolean;
}
export const noFilter = (f?: KanbanFilter | null) => !f || (!f.q && !f.labels.size && !f.due);
function matches(b: KanbanBoard, card: KanbanCard, f: KanbanFilter | null | undefined, done: boolean): boolean {
  if (noFilter(f)) return true;
  const q = f!.q.trim().toLowerCase();
  if (q && !card.title.toLowerCase().includes(q) && !JSON.stringify(card.doc).toLowerCase().includes(q)) return false;
  if (f!.labels.size && !card.labels.some((l) => f!.labels.has(l))) return false;
  if (f!.due) {
    const d = dueInfo(card.due, done);
    if (!d || done || (d.tone !== "late" && d.tone !== "soon")) return false;
  }
  return true;
}

// ---------------------------------------------------------------- the card on the board

const CardFace = memo(function CardFace({ card, labels, done, ph, hidden, onOpen, stamp }: { card: KanbanCard; labels: Map<string, KanbanLabel>; done: boolean; ph?: boolean; hidden?: boolean; onOpen(): void; stamp?: boolean }) {
  const d = dueInfo(card.due, done);
  const t = todosOf(card.doc);
  const ls = card.labels.map((l) => labels.get(l)).filter(Boolean) as KanbanLabel[];
  return (
    <article
      className={cn("kb-card", done && "is-done", card.cover && "has-cover", ph && "is-ph", hidden && "is-hidden", stamp && "is-stamp")}
      data-kc={card.id}
      tabIndex={0}
      role="button"
      aria-label={card.title || "Untitled card"}
      onClick={onOpen}
    >
      {card.cover && <div className="kb-cover" style={{ ["--kc" as any]: colorVar(card.cover) }} />}
      {ls.length > 0 && (
        <div className="kb-labels">
          {ls.map((l) => (
            <span key={l.id} className="kb-label" style={{ ["--kc" as any]: colorVar(l.color) }}>{l.name || COLOR_NAME[l.color]}</span>
          ))}
        </div>
      )}
      <div className="kb-title">{card.title || <span className="kb-untitled">Untitled card</span>}</div>
      {(d || t.all > 0 || hasBody(card.doc) || hasStudy(card.doc)) && (
        <div className="kb-badges">
          {d && <span className={cn("kb-badge kb-due", d.tone && `is-${d.tone}`)}><CalendarDays />{d.text}</span>}
          {t.all > 0 && <span className={cn("kb-badge", t.done === t.all && "is-ok")}><CheckSquare />{t.done}/{t.all}</span>}
          {hasBody(card.doc) && <span className="kb-badge" title="Has notes"><AlignLeft /></span>}
          {hasStudy(card.doc) && <span className="kb-badge" title="Study cards inside"><Layers /></span>}
        </div>
      )}
      <span className="kb-stamp" aria-hidden><Check /></span>
    </article>
  );
});

// ---------------------------------------------------------------- inline add

function AddCard({ onAdd, onClose, autoFocus }: { onAdd(title: string): void; onClose(): void; autoFocus?: boolean }) {
  const [v, setV] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus !== false) ta.current?.focus({ preventScroll: false });
  }, []);
  const add = () => {
    const t = v.trim();
    if (!t) return ta.current?.focus();
    onAdd(t);
    setV("");
    ta.current?.focus();
  };
  return (
    <div className="kb-addf" onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ta}
        value={v}
        rows={2}
        placeholder="What needs doing?"
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), add());
          else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose());
        }}
        onBlur={() => !v.trim() && setTimeout(onClose, 120)}
      />
      <div className="kb-addf-row">
        <button type="button" className="kb-btn" onMouseDown={(e) => e.preventDefault()} onClick={add}>Add card</button>
        <button type="button" className="kb-btn is-ghost" onClick={onClose}>Cancel</button>
        <span className="kb-key">Enter ↵</span>
      </div>
    </div>
  );
}

function AddColumn({ onAdd }: { onAdd(name: string): void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => void (open && inp.current?.focus()), [open]);
  if (!open)
    return (
      <button type="button" className="kb-addcol" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Add column
      </button>
    );
  const add = () => {
    const t = v.trim();
    if (!t) return inp.current?.focus();
    onAdd(t);
    setV("");
    inp.current?.focus();
  };
  return (
    <div className="kb-addcolf" onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={inp}
        value={v}
        placeholder="Column name"
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.preventDefault(), add());
          else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setOpen(false));
        }}
        onBlur={() => !v.trim() && setTimeout(() => setOpen(false), 120)}
      />
      <div className="kb-addf-row">
        <button type="button" className="kb-btn" onMouseDown={(e) => e.preventDefault()} onClick={add}>Add column</button>
        <button type="button" className="kb-btn is-ghost" onClick={() => setOpen(false)}>Cancel</button>
        <span className="kb-key">Enter ↵</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a column's menu

function ColumnMenu({ col, onPatch, onSort, onArchive, onRename }: { col: KanbanColumn; onPatch(p: Partial<KanbanColumn>): void; onSort(): void; onArchive(): void; onRename(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("kb-icon kb-colmenu", open && "is-open")} aria-label="Column options" onPointerDown={(e) => e.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="kb-pop w-[268px] p-1.5">
        <div className="kb-pop-label">Limit</div>
        <div className="kb-stepper">
          <button type="button" aria-label="Fewer" onClick={() => onPatch({ limit: col.limit && col.limit > 1 ? col.limit - 1 : null })}>−</button>
          <span>{col.limit ? `${col.limit} card${col.limit === 1 ? "" : "s"}` : "No limit"}</span>
          <button type="button" aria-label="More" onClick={() => onPatch({ limit: Math.min(999, (col.limit ?? 0) + 1) })}>+</button>
        </div>
        <div className="kb-pop-label">Colour</div>
        <div className="kb-swatches">
          {KANBAN_COLORS.map((c) => (
            <button key={c} type="button" aria-label={COLOR_NAME[c]} title={COLOR_NAME[c]} className={cn("kb-swatch", col.color === c && "is-on")} style={{ ["--kc" as any]: colorVar(c) }} onClick={() => onPatch({ color: c })} />
          ))}
        </div>
        <div className="kb-pop-sep" />
        <button type="button" className="kb-pop-item" onClick={() => onPatch({ done: !col.done })}>
          <Check className="size-4" /> <span className="flex-1">Cards here are done</span>
          <span className={cn("kb-toggle", col.done && "is-on")} />
        </button>
        <button type="button" className="kb-pop-item" onClick={() => (setOpen(false), onRename())}>Rename <span className="kb-key ml-auto">double-click</span></button>
        <button type="button" className="kb-pop-item" onClick={() => (setOpen(false), onSort())}>Sort by due date</button>
        <button type="button" className="kb-pop-item is-danger" onClick={() => (setOpen(false), onArchive())}><Archive className="size-4" /> Archive column</button>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- the board

export interface KanbanViewProps {
  boardId: string;
  boardTitle: string;
  board: KanbanBoard;
  onChange(b: KanbanBoard): void;
  links: NoteLinkOptions;
  /** Inside a page's portal: narrower columns, the page scrolls around it. */
  compact?: boolean;
  filter?: KanbanFilter | null;
  /** The first column's "Add card" opens at once (a board just made). */
  startAdding?: boolean;
  /** Shared with you as view only: cards open to read, nothing moves or changes. */
  readOnly?: boolean;
}

type Drag = { kind: "card" | "col"; id: string; from: string | null; to: string | null; index: number; done: boolean };

export function KanbanView({ boardId, boardTitle, board, onChange, links, compact, filter, startAdding, readOnly }: KanbanViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [adding, setAdding] = useState<string | null>(startAdding && board.columns[0] ? board.columns[0].id : null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [stamp, setStamp] = useState<string | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  const change = useRef(onChange);
  // View only: nothing a click does here reaches the board (the card sheet included).
  change.current = readOnly ? () => {} : onChange;
  const labels = useMemo(() => new Map(board.labels.map((l) => [l.id, l])), [board.labels]);
  const filtering = !noFilter(filter);

  // What's drawn: the board, with the dragged card or column where it would land.
  const shown = useMemo(() => {
    if (!drag || drag.to === null) return board;
    return drag.kind === "card" ? placed(board, drag.id, drag.to, drag.index) : placedCol(board, drag.id, drag.index);
  }, [board, drag]);

  // FLIP: cards and columns glide to their new places when the drag moves the gap.
  const before = useRef<Map<string, DOMRect> | null>(null);
  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    root.current?.querySelectorAll<HTMLElement>("[data-kc],[data-kcol]").forEach((el) => {
      el.getAnimations().forEach((a) => a.cancel());
      m.set((el.dataset.kc ? "c:" + el.dataset.kc : "l:" + el.dataset.kcol)!, el.getBoundingClientRect());
    });
    before.current = m;
  };
  useLayoutEffect(() => {
    const m = before.current;
    before.current = null;
    if (!m || reduced()) return;
    root.current?.querySelectorAll<HTMLElement>("[data-kc],[data-kcol]").forEach((el) => {
      const a = m.get((el.dataset.kc ? "c:" + el.dataset.kc : "l:" + el.dataset.kcol)!);
      if (!a) return;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  });
  const setDragGlide = (d: Drag | null) => {
    snapshot();
    dragRef.current = d;
    setDrag(d);
  };

  // ---- dragging with the pointer (a long press on touch screens)
  const live = useRef<{ x0: number; y0: number; x: number; y: number; el: HTMLElement; ghost: HTMLElement | null; offX: number; offY: number; timer: number; raf: number; started: boolean; kind: "card" | "col"; id: string; touch: boolean } | null>(null);
  const suppressClick = useRef(0);

  const hitTest = useCallback(() => {
    const L = live.current;
    const d = dragRef.current;
    const r = root.current;
    if (!L || !d || !r) return;
    const br = r.getBoundingClientRect();
    if (L.y < br.top - 90 || L.y > br.bottom + 90) return;
    const cols = [...r.querySelectorAll<HTMLElement>("[data-kcol]")];
    if (d.kind === "card") {
      let best: HTMLElement | null = null;
      let bd = Infinity;
      for (const c of cols) {
        const cr = c.getBoundingClientRect();
        const dx = L.x < cr.left ? cr.left - L.x : L.x > cr.right ? L.x - cr.right : 0;
        if (dx < bd) (bd = dx), (best = c);
      }
      if (!best) return;
      const colId = best.dataset.kcol!;
      const cards = [...best.querySelectorAll<HTMLElement>("[data-kc]")].filter((k) => k.dataset.kc !== d.id && !k.classList.contains("is-hidden"));
      let index = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const cr = cards[i].getBoundingClientRect();
        if (L.y < cr.top + cr.height / 2) {
          index = i;
          break;
        }
      }
      // Index among every card of the column (hidden ones too), without the dragged one.
      const col = boardRef.current.columns.find((c) => c.id === colId)!;
      const without = col.cards.filter((k) => k !== d.id);
      const realIndex = index >= cards.length ? without.length : without.indexOf(cards[index].dataset.kc!);
      if (d.to === colId && d.index === realIndex) return;
      setDragGlide({ ...d, to: colId, index: realIndex, done: col.done });
    } else {
      const others = cols.filter((c) => c.dataset.kcol !== d.id);
      let index = others.length;
      for (let i = 0; i < others.length; i++) {
        const cr = others[i].getBoundingClientRect();
        if (L.x < cr.left + cr.width / 2) {
          index = i;
          break;
        }
      }
      if (d.index === index && d.to !== null) return;
      setDragGlide({ ...d, to: "", index });
    }
  }, []);

  const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
    for (let p = el?.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  };

  const tick = useCallback(() => {
    const L = live.current;
    const r = root.current;
    if (!L || !L.started || !r) return;
    const br = r.getBoundingClientRect();
    const edge = 60;
    let moved = false;
    if (L.x < br.left + edge && r.scrollLeft > 0) (r.scrollLeft -= 14), (moved = true);
    else if (L.x > br.right - edge && r.scrollLeft < r.scrollWidth - r.clientWidth) (r.scrollLeft += 14), (moved = true);
    if (dragRef.current?.kind === "card") {
      const list = r.querySelector<HTMLElement>(`[data-kcol="${dragRef.current.to ?? dragRef.current.from}"] .kb-list`);
      if (list) {
        const lr = list.getBoundingClientRect();
        if (L.y < lr.top + 40 && list.scrollTop > 0) (list.scrollTop -= 10), (moved = true);
        else if (L.y > lr.bottom - 40 && list.scrollTop < list.scrollHeight - list.clientHeight) (list.scrollTop += 10), (moved = true);
      }
      const page = scrollParent(r);
      if (page) {
        const pr = page.getBoundingClientRect();
        if (L.y < pr.top + 50) (page.scrollTop -= 12), (moved = true);
        else if (L.y > pr.bottom - 50) (page.scrollTop += 12), (moved = true);
      }
    }
    if (moved) hitTest();
    L.raf = requestAnimationFrame(tick);
  }, [hitTest]);

  const place = () => {
    const L = live.current!;
    if (L.ghost) L.ghost.style.transform = `translate(${L.x - L.offX}px, ${L.y - L.offY}px)`;
  };

  const begin = () => {
    const L = live.current!;
    const r = L.el.getBoundingClientRect();
    L.offX = L.x0 - r.left;
    L.offY = L.y0 - r.top;
    const g = L.el.cloneNode(true) as HTMLElement;
    g.classList.add("kb-ghost");
    g.removeAttribute("data-kc");
    g.removeAttribute("data-kcol");
    g.style.width = `${r.width}px`;
    if (L.kind === "col") g.style.height = `${r.height}px`;
    // The ghost lives on the body so nothing clips it; it keeps the board's colours through the class it copies.
    const host = document.createElement("div");
    host.className = "kb-ghost-host";
    host.appendChild(g);
    document.body.appendChild(host);
    L.ghost = host;
    const tilt = `rotate(${L.kind === "col" ? 1.6 : 2.5}deg) scale(${L.kind === "col" ? 1 : 1.03})`;
    g.style.transform = tilt;
    L.started = true;
    const col = L.kind === "card" ? colOfCard(boardRef.current, L.id) : null;
    const d: Drag = { kind: L.kind, id: L.id, from: col?.id ?? null, to: null, index: 0, done: !!col?.done };
    dragRef.current = d;
    setDrag(d);
    setAdding(null);
    document.body.classList.add("kb-dragging");
    place();
    if (!reduced()) g.animate([{ transform: "none" }, { transform: tilt }], { duration: 130, easing: "ease-out" });
    hitTest();
    L.raf = requestAnimationFrame(tick);
  };

  const finish = (cancel = false) => {
    const L = live.current;
    live.current = null;
    if (!L) return;
    clearTimeout(L.timer);
    cancelAnimationFrame(L.raf);
    if (!L.started) return;
    suppressClick.current = Date.now();
    document.body.classList.remove("kb-dragging");
    const d = dragRef.current;
    const host = L.ghost;
    const end = () => {
      host?.remove();
      dragRef.current = null;
      if (!d || cancel || d.to === null) return setDrag(null);
      const was = d.kind === "card" ? colOfCard(boardRef.current, d.id) : null;
      const next = d.kind === "card" ? placed(boardRef.current, d.id, d.to, d.index) : placedCol(boardRef.current, d.id, d.index);
      if (d.kind === "card") {
        const nowCol = next.columns.find((c) => c.id === d.to)!;
        if (nowCol.done && !was?.done) {
          setStamp(d.id);
          playSound("tick");
          setTimeout(() => setStamp((s) => (s === d.id ? null : s)), 900);
        }
        next.cards[d.id] = { ...next.cards[d.id], updated: nowIso() };
      }
      setDrag(null);
      change.current(next);
      if (L.touch === false && document.activeElement?.closest?.("[data-kc]")) requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-kc="${d.id}"]`)?.focus({ preventScroll: true }));
    };
    const target = d && root.current?.querySelector<HTMLElement>(d.kind === "card" ? `[data-kc="${d.id}"]` : `[data-kcol="${d.id}"]`);
    if (!host || !target || reduced() || cancel) return end();
    const t = target.getBoundingClientRect();
    const g = host.firstElementChild as HTMLElement;
    g.getAnimations().forEach((a) => a.cancel());
    host.style.transition = "transform 170ms cubic-bezier(.2,.8,.2,1)";
    host.style.transform = `translate(${t.left}px, ${t.top}px)`;
    g.style.transition = "transform 170ms cubic-bezier(.2,.8,.2,1)";
    g.style.transform = "none";
    setTimeout(end, 175);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const L = live.current;
      if (!L) return;
      L.x = e.clientX;
      L.y = e.clientY;
      const dist = Math.hypot(L.x - L.x0, L.y - L.y0);
      if (!L.started) {
        if (L.touch) {
          if (dist > 8) (clearTimeout(L.timer), (live.current = null));
          return;
        }
        if (dist < 5) return;
        begin();
      }
      e.preventDefault();
      place();
      hitTest();
    };
    const up = () => finish();
    const cancel = () => finish(true);
    const touch = (e: TouchEvent) => live.current?.started && e.preventDefault();
    const key = (e: KeyboardEvent) => e.key === "Escape" && live.current?.started && (e.preventDefault(), finish(true));
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", touch, { passive: false });
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", touch);
      window.removeEventListener("keydown", key, true);
    };
  }, [hitTest]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || filtering || readOnly) return;
    const t = e.target as HTMLElement;
    // Only controls inside the board count (the page around a portal is itself contenteditable).
    const ctl = t.closest("button, input, textarea, select, [contenteditable=true], .kb-addf, .kb-addcolf");
    if (ctl && root.current?.contains(ctl)) return;
    const card = t.closest<HTMLElement>("[data-kc]");
    const head = !card && t.closest<HTMLElement>(".kb-colhead");
    const el = card ?? (head ? head.closest<HTMLElement>("[data-kcol]") : null);
    if (!el) return;
    const touch = e.pointerType === "touch";
    live.current = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, el, ghost: null, offX: 0, offY: 0, timer: 0, raf: 0, started: false, kind: card ? "card" : "col", id: card ? card.dataset.kc! : el.dataset.kcol!, touch };
    if (touch) live.current.timer = window.setTimeout(() => live.current && !live.current.started && begin(), 260);
  };

  // ---- edits
  const commit = (b: KanbanBoard) => change.current(b);
  const patchCol = (id: string, p: Partial<KanbanColumn>) => commit({ ...board, columns: board.columns.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const addCard = (colId: string, title: string) => {
    const id = kanbanId();
    const t = nowIso();
    commit({ ...board, cards: { ...board.cards, [id]: { id, title, labels: [], due: null, cover: null, doc: { type: "doc", content: [] }, created: t, updated: t } }, columns: board.columns.map((c) => (c.id === colId ? { ...c, cards: [...c.cards, id] } : c)) });
    playSound("tick", { gain: 0.35 });
    requestAnimationFrame(() => {
      const l = root.current?.querySelector<HTMLElement>(`[data-kcol="${colId}"] .kb-list`);
      if (l) l.scrollTop = l.scrollHeight;
    });
  };
  const addColumn = (name: string) => {
    commit({ ...board, columns: [...board.columns, { id: kanbanId(), name, color: KANBAN_COLORS[(board.columns.length + 1) % KANBAN_COLORS.length], limit: null, done: false, cards: [] }] });
    requestAnimationFrame(() => root.current && (root.current.scrollLeft = root.current.scrollWidth));
  };
  const archiveColumn = (id: string) => {
    const col = board.columns.find((c) => c.id === id)!;
    const prev = board;
    commit({ ...board, columns: board.columns.filter((c) => c.id !== id), archived: [...col.cards, ...board.archived] });
    toast(`Archived “${col.name || "Untitled"}” with its ${col.cards.length} card${col.cards.length === 1 ? "" : "s"}`, { action: { label: "Undo", onClick: () => change.current(prev) } });
  };
  const sortColumn = (id: string) => {
    snapshot();
    commit({ ...board, columns: board.columns.map((c) => (c.id === id ? { ...c, cards: [...c.cards].sort((a, b) => (board.cards[a]?.due ?? "9999") .localeCompare(board.cards[b]?.due ?? "9999")) } : c)) });
  };

  // ---- the keyboard on a focused card: arrows move between cards, Ctrl/⌘+arrows move the card
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-kc]");
    if (!el || e.target !== el) return;
    const id = el.dataset.kc!;
    if (e.key === "Enter" || e.key === " ") return void (e.preventDefault(), (byKey.current = true), setOpen(id));
    const dir = (({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }) as Record<string, "up" | "down" | "left" | "right">)[e.key];
    if (!dir) return;
    e.preventDefault();
    const cols = board.columns;
    const ci = cols.findIndex((c) => c.cards.includes(id));
    if (ci < 0) return;
    const vis = (c: KanbanColumn) => c.cards.filter((k) => matches(board, board.cards[k], filter, c.done));
    const list = vis(cols[ci]);
    const i = list.indexOf(id);
    if (e.ctrlKey || e.metaKey) {
      if (filtering) return;
      const all = cols[ci].cards;
      const ai = all.indexOf(id);
      let next: KanbanBoard | null = null;
      if (dir === "up" && ai > 0) next = placed(board, id, cols[ci].id, ai - 1);
      else if (dir === "down" && ai < all.length - 1) next = placed(board, id, cols[ci].id, ai + 1);
      else if ((dir === "left" && ci > 0) || (dir === "right" && ci < cols.length - 1)) {
        const to = cols[ci + (dir === "left" ? -1 : 1)];
        next = placed(board, id, to.id, Math.min(ai, to.cards.length));
        if (to.done && !cols[ci].done) {
          setStamp(id);
          playSound("tick");
          setTimeout(() => setStamp((s) => (s === id ? null : s)), 900);
        }
      }
      if (next) {
        snapshot();
        commit(next);
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-kc="${id}"]`)?.focus({ preventScroll: false }));
      }
      return;
    }
    let target: string | undefined;
    if (dir === "up") target = list[i - 1];
    else if (dir === "down") target = list[i + 1];
    else {
      for (let j = ci + (dir === "left" ? -1 : 1); j >= 0 && j < cols.length; j += dir === "left" ? -1 : 1) {
        const v = vis(cols[j]);
        if (v.length) {
          target = v[Math.min(i, v.length - 1)];
          break;
        }
      }
    }
    if (target) {
      const t = root.current?.querySelector<HTMLElement>(`[data-kc="${target}"]`);
      t?.focus({ preventScroll: true });
      t?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const byKey = useRef(false);
  const openCard = useCallback((id: string) => {
    if (Date.now() - suppressClick.current < 120) return;
    byKey.current = false;
    setOpen(id);
  }, []);

  return (
    <>
      <div ref={root} className={cn("kb-board", compact && "is-compact", filtering && "is-filtered", drag && "is-dragging", readOnly && "is-readonly")} onPointerDown={onPointerDown} onKeyDown={onKeyDown} onDragStart={(e) => e.preventDefault()} data-board={boardId}>
        {shown.columns.map((col) => {
          const n = col.cards.length;
          const isPh = drag?.kind === "col" && drag.id === col.id && drag.to !== null;
          return (
            <section key={col.id} className={cn("kb-col", isPh && "is-ph")} data-kcol={col.id} style={{ ["--kc" as any]: colorVar(col.color) }}>
              <header className="kb-colhead" onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && setRenaming(col.id)}>
                <span className="kb-dot" />
                {renaming === col.id ? (
                  <input
                    className="kb-colname-in"
                    defaultValue={col.name}
                    autoFocus
                    spellCheck={false}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.preventDefault(), (e.currentTarget as HTMLInputElement).blur());
                      else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setRenaming(null));
                    }}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim();
                      setRenaming(null);
                      if (v && v !== col.name) patchCol(col.id, { name: v });
                    }}
                  />
                ) : (
                  <span className="kb-colname">{col.name || "Untitled"}</span>
                )}
                <span className={cn("kb-count", col.limit && n > col.limit && "is-over")} title={col.limit ? `Limit ${col.limit}` : undefined}>{col.limit ? `${n}/${col.limit}` : n}</span>
                {col.done && <span className="kb-donemark" title="Cards here count as done"><Check /></span>}
                <span className="flex-1" />
                <ColumnMenu col={col} onPatch={(p) => patchCol(col.id, p)} onSort={() => sortColumn(col.id)} onArchive={() => archiveColumn(col.id)} onRename={() => setRenaming(col.id)} />
              </header>
              <div className="kb-list">
                {col.cards.map((k) => {
                  const card = shown.cards[k];
                  if (!card) return null;
                  return <CardFace key={k} card={card} labels={labels} done={col.done} ph={drag?.kind === "card" && drag.id === k && drag.to !== null} hidden={!matches(shown, card, filter, col.done)} stamp={stamp === k} onOpen={() => openCard(k)} />;
                })}
              </div>
              {adding === col.id ? (
                <AddCard onAdd={(t) => addCard(col.id, t)} onClose={() => setAdding((a) => (a === col.id ? null : a))} />
              ) : (
                <button type="button" className="kb-add" onClick={() => setAdding(col.id)}>
                  <Plus className="size-4" /> Add card
                </button>
              )}
            </section>
          );
        })}
        <AddColumn onAdd={addColumn} />
      </div>
      {open && board.cards[open] && (
        <CardSheet
          key={open}
          board={board}
          boardId={boardId}
          boardTitle={boardTitle}
          cardId={open}
          links={links}
          onChange={commit}
          onClose={() => {
            const id = open;
            setOpen(null);
            // Back on the card when it was opened from the keyboard, so the arrows go on from there.
            if (byKey.current) requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-kc="${id}"]`)?.focus({ preventScroll: true }));
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- the card, open

function LabelPicker({ board, card, onBoard }: { board: KanbanBoard; card: KanbanCard; onBoard(b: KanbanBoard): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [col, setCol] = useState<KanbanColor>(KANBAN_COLORS[(board.labels.length + 1) % KANBAN_COLORS.length]);
  const toggle = (id: string) => {
    const has = card.labels.includes(id);
    onBoard({ ...board, cards: { ...board.cards, [card.id]: { ...card, labels: has ? card.labels.filter((l) => l !== id) : [...card.labels, id], updated: nowIso() } } });
  };
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const l: KanbanLabel = { id: kanbanId(), name: n, color: col };
    onBoard({ ...board, labels: [...board.labels, l], cards: { ...board.cards, [card.id]: { ...card, labels: [...card.labels, l.id], updated: nowIso() } } });
    setName("");
    setCol(KANBAN_COLORS[(board.labels.length + 2) % KANBAN_COLORS.length]);
  };
  const remove = (id: string) => {
    const cards = Object.fromEntries(Object.entries(board.cards).map(([k, c]) => [k, c.labels.includes(id) ? { ...c, labels: c.labels.filter((x) => x !== id) } : c]));
    onBoard({ ...board, labels: board.labels.filter((l) => l.id !== id), cards });
  };
  return (
    <div className="kb-lrow">
      {board.labels.map((l) => (
        <button key={l.id} type="button" className={cn("kb-chip", card.labels.includes(l.id) && "is-on")} style={{ ["--kc" as any]: colorVar(l.color) }} onClick={() => toggle(l.id)}>
          {l.name || COLOR_NAME[l.color]}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="kb-chip is-add" aria-label="Labels"><Plus className="size-3.5" />{board.labels.length ? "" : " Label"}</button>
        </PopoverTrigger>
        <PopoverContent align="start" className="kb-pop w-64 p-2">
          <div className="kb-pop-label">New label</div>
          <input
            className="kb-pop-input"
            value={name}
            placeholder="Name, then Enter"
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), create())}
          />
          <div className="kb-swatches mt-2">
            {KANBAN_COLORS.map((c) => (
              <button key={c} type="button" aria-label={COLOR_NAME[c]} title={COLOR_NAME[c]} className={cn("kb-swatch", col === c && "is-on")} style={{ ["--kc" as any]: colorVar(c) }} onClick={() => setCol(c)} />
            ))}
          </div>
          <button type="button" className="kb-btn mt-2 w-full justify-center" disabled={!name.trim()} onClick={create}>Add label</button>
          {board.labels.length > 0 && (
            <>
              <div className="kb-pop-sep" />
              <div className="kb-pop-label">On this board</div>
              {board.labels.map((l) => (
                <div key={l.id} className="kb-pop-item is-static">
                  <span className="kb-swatch is-small" style={{ ["--kc" as any]: colorVar(l.color) }} />
                  <span className="flex-1 truncate">{l.name || COLOR_NAME[l.color]}</span>
                  <button type="button" className="kb-icon" aria-label={`Delete ${l.name}`} title="Delete the label from the board" onClick={() => remove(l.id)}><X className="size-3.5" /></button>
                </div>
              ))}
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function CardSheet({ board, boardId, boardTitle, cardId, links, onChange, onClose }: { board: KanbanBoard; boardId: string; boardTitle: string; cardId: string; links: NoteLinkOptions; onChange(b: KanbanBoard): void; onClose(): void }) {
  const card = board.cards[cardId];
  const col = colOfCard(board, cardId);
  const [title, setTitle] = useState(card.title);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  const change = useRef(onChange);
  change.current = onChange;
  const patch = useCallback((p: Partial<KanbanCard>) => {
    const b = boardRef.current;
    const c = b.cards[cardId];
    if (!c) return;
    change.current({ ...b, cards: { ...b.cards, [cardId]: { ...c, ...p, updated: nowIso() } } });
  }, [cardId]);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);
  useEffect(() => {
    if (!card.title) titleRef.current?.focus();
    // Esc closes the card, unless a menu is open over it (the slash menu, a label or colour menu): that closes first.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".note-slash-host, [data-radix-popper-content-wrapper]")) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const saveTitle = () => {
    const t = title.replace(/\s+/g, " ").trim();
    if (t !== card.title) patch({ title: t });
  };
  const close = () => {
    saveTitle();
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const d = dueInfo(card.due, !!col?.done);
  const t = todosOf(card.doc);
  const moveTo = (id: string) => {
    const b = boardRef.current;
    const to = b.columns.find((c) => c.id === id)!;
    const next = placed(b, cardId, id, to.cards.filter((k) => k !== cardId).length);
    change.current({ ...next, cards: { ...next.cards, [cardId]: { ...next.cards[cardId], updated: nowIso() } } });
    if (to.done && !col?.done) playSound("tick");
  };
  const archive = () => {
    const prev = boardRef.current;
    const b = clone(prev);
    for (const c of b.columns) c.cards = c.cards.filter((k) => k !== cardId);
    b.archived = [cardId, ...b.archived.filter((k) => k !== cardId)];
    change.current(b);
    onClose();
    toast("Card archived", { action: { label: "Undo", onClick: () => change.current(prev) } });
  };
  const page = useMemo(() => ({ id: boardId, title: boardTitle }), [boardId, boardTitle]);
  const onDoc = useCallback((doc: NoteDoc) => patch({ doc }), [patch]);
  return createPortal(
    <div className="kb-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="kb-sheet" role="dialog" aria-label={card.title || "Card"}>
        {card.cover && <div className="kb-sheet-cover" style={{ ["--kc" as any]: colorVar(card.cover) }} />}
        <div className="kb-sheet-head">
          <textarea
            ref={titleRef}
            className="kb-sheet-title"
            value={title}
            rows={1}
            placeholder="Card title"
            spellCheck={false}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), saveTitle(), (e.currentTarget as HTMLTextAreaElement).blur())}
          />
          <button type="button" className="kb-icon" aria-label="Close (Esc)" title="Close (Esc)" onClick={close}><X className="size-4" /></button>
        </div>
        <div className="kb-sheet-sub">
          in
          <select value={col?.id ?? ""} onChange={(e) => moveTo(e.target.value)} aria-label="Column">
            {!col && <option value="">Archive</option>}
            {board.columns.map((c) => (
              <option key={c.id} value={c.id}>{c.name || "Untitled"}</option>
            ))}
          </select>
          on <span className="truncate">{boardTitle || "Untitled board"}</span>
        </div>
        <div className="kb-sheet-body">
          <div className="kb-props">
            <span className="kb-prop">Labels</span>
            <LabelPicker board={board} card={card} onBoard={(b) => change.current(b)} />
            <span className="kb-prop">Due</span>
            <div className="kb-due-row">
              <input type="date" value={card.due ?? ""} onChange={(e) => patch({ due: e.target.value || null })} aria-label="Due date" />
              {d && (d.tone || col?.done) && <span className={cn("kb-badge kb-due", d.tone && `is-${d.tone}`)}>{col?.done ? "Done" : d.tone === "late" ? "Late" : d.text}</span>}
              {card.due && <button type="button" className="kb-link" onClick={() => patch({ due: null })}>Clear</button>}
            </div>
            <span className="kb-prop">Cover</span>
            <div className="kb-swatches">
              <button type="button" aria-label="No cover" title="None" className={cn("kb-swatch is-none", !card.cover && "is-on")} onClick={() => patch({ cover: null })} />
              {KANBAN_COLORS.map((c) => (
                <button key={c} type="button" aria-label={COLOR_NAME[c]} title={COLOR_NAME[c]} className={cn("kb-swatch", card.cover === c && "is-on")} style={{ ["--kc" as any]: colorVar(c) }} onClick={() => patch({ cover: c })} />
              ))}
            </div>
          </div>
          {t.all > 0 && (
            <div className="kb-progress" aria-label={`${t.done} of ${t.all} to-dos done`}>
              <span className={cn("kb-progress-n", t.done === t.all && "is-ok")}>{t.done}/{t.all}</span>
              <span className="kb-progress-bar"><i style={{ width: `${(t.done / t.all) * 100}%` }} /></span>
            </div>
          )}
          <div className="kb-sheet-page note-body">
            <NoteEditor doc={card.doc} onChange={onDoc} links={links} page={page} />
          </div>
        </div>
        <div className="kb-sheet-foot">
          <button type="button" className="kb-btn is-ghost" onClick={archive}><Archive className="size-4" /> Archive</button>
          <span className="flex-1" />
          <span className="kb-key">To-dos ([] or /to-do) show as n/m on the card · Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Archived cards, to bring back (the board's ⋯ menu). */
export function ArchivedList({ board, onChange }: { board: KanbanBoard; onChange(b: KanbanBoard): void }) {
  if (!board.archived.length) return <div className="px-2 py-3 text-[13px] text-muted-foreground">Nothing archived.</div>;
  return (
    <div className="kb-archived">
      {board.archived.map((k) => {
        const c = board.cards[k];
        if (!c) return null;
        return (
          <div key={k} className="kb-pop-item is-static">
            <span className="flex-1 truncate">{c.title || "Untitled card"}</span>
            <button
              type="button"
              className="kb-link"
              disabled={!board.columns.length}
              onClick={() => {
                const b = clone(board);
                b.archived = b.archived.filter((x) => x !== k);
                b.columns[0].cards.push(k);
                onChange(b);
              }}
            >
              Restore
            </button>
          </div>
        );
      })}
    </div>
  );
}
