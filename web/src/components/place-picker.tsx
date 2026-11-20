// The command palette's second step: where something opens. A small map of the Notebook's panes as they are now;
// each pane takes it as a tab (its middle) or splits to a side (its edges), and a chat can also go to the Ask panel.
// Arrows walk the map (an edge, then the pane beyond it), Tab goes to the next pane, 1–4 picks a pane, ↵ opens.
// When the Notebook is on screen there's no map: the place is drawn on the real panes, like dragging a tab, and a
// tab can go anywhere in the strip (←/→ walk the gaps between tabs, the mouse picks one over the strip).
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeLayout, panes as layoutPanes, rects, MAX_PANES, type Side } from "@/lib/note-layout";
import { viewNow, type ViewPane } from "@/lib/view-remote";
import { cn } from "@/lib/utils";

/** `before`: as a tab, in front of that tab (null: at the end); left out, next to the page in front. */
export type Place = { pane: number; zone: "tab" | Side; before?: string | null } | { panel: true };
type Box = { x: number; y: number; w: number; h: number };
type MapPane = { n: number; focused: boolean; box: Box; tabs: string[]; front: number };

const SIDES: Side[] = ["left", "right", "top", "bottom"];
const EDGE = 0.26;

/** The Notebook's panes as the map draws them: from the open Notebook, or the layout it saved last time. */
function mapPanes(titleOf: (id: string) => string): MapPane[] {
  const now = viewNow();
  const live = now.panes.filter((p): p is ViewPane & { box: Box } => !!p.box);
  if (live.length)
    return live.map((p) => ({ n: p.n, focused: p.focused, box: p.box, tabs: p.tabs.map((t) => t.title), front: Math.max(0, p.tabs.findIndex((t) => t.id === p.front?.id)) }));
  let saved = null;
  try {
    saved = normalizeLayout(JSON.parse(localStorage.getItem("etude.notes.layout") ?? "null"));
  } catch {}
  if (!saved) return [{ n: 1, focused: true, box: { x: 0, y: 0, w: 1, h: 1 }, tabs: [], front: 0 }];
  const boxes = new Map(rects(saved.root).panes.map((r) => [r.id, r]));
  return layoutPanes(saved.root).map((p, i) => ({
    n: i + 1,
    focused: p.id === saved!.focus,
    box: boxes.get(p.id) ?? { x: 0, y: 0, w: 1, h: 1 },
    tabs: p.tabs.map(titleOf),
    front: Math.max(0, p.tabs.indexOf(p.active ?? "")),
  }));
}

/** The pane next to `from` in that direction (sharing some of that edge), nearest first. */
function neighbour(ps: MapPane[], from: MapPane, dir: Side): MapPane | undefined {
  const e = 0.002;
  const a = from.box;
  const over = (p0: number, p1: number, q0: number, q1: number) => Math.min(p1, q1) - Math.max(p0, q0) > e;
  const c = ps.filter((p) => {
    const b = p.box;
    if (p === from) return false;
    if (dir === "right") return b.x >= a.x + a.w - e && over(a.y, a.y + a.h, b.y, b.y + b.h);
    if (dir === "left") return b.x + b.w <= a.x + e && over(a.y, a.y + a.h, b.y, b.y + b.h);
    if (dir === "bottom") return b.y >= a.y + a.h - e && over(a.x, a.x + a.w, b.x, b.x + b.w);
    return b.y + b.h <= a.y + e && over(a.x, a.x + a.w, b.x, b.x + b.w);
  });
  const d = (p: MapPane) => Math.abs(dir === "right" || dir === "left" ? p.box.x - a.x : p.box.y - a.y);
  return c.sort((p, q) => d(p) - d(q))[0];
}
const opposite: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** The Notebook's panes on screen, in the order they're numbered; empty when the Notebook isn't showing. */
function paneEls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("section[data-pane]")];
}
/** Whether the place can be shown on the real panes (the Notebook is on screen, its panes match what it reported). */
export function canPlaceLive(): boolean {
  const n = viewNow().panes.filter((p) => p.box).length;
  return n > 0 && paneEls().length === n;
}
/** The part of a pane you can see, in viewport pixels (as the tab drag measures it). */
function seen(el: Element): Box {
  const r = (el.closest(".is-multi .note-pane-box") ?? el).getBoundingClientRect();
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  return { x: r.left, y: top, w: r.width, h: Math.max(0, bottom - top) };
}
/** The tabs a pane shows in its strip, in order (a folded group's tabs aren't there). */
function stripTabs(el: HTMLElement | undefined): HTMLElement[] {
  return el ? [...el.querySelectorAll<HTMLElement>(".note-topbar .note-tab[data-tab]")] : [];
}
/** Where a slot in the strip is: the gap in front of tab i (i = length: after the last). */
function slotLine(tabs: HTMLElement[], i: number): Box | null {
  const ref = tabs[Math.min(i, tabs.length - 1)];
  if (!ref) return null;
  const r = ref.getBoundingClientRect();
  const bar = ref.closest(".note-topbar")?.getBoundingClientRect() ?? r;
  return { x: i < tabs.length ? r.left - 2 : r.right + 1, y: bar.top + 8, w: 2, h: bar.height - 16 };
}
const slotOf = (tabs: HTMLElement[], before: string | null | undefined, fallback: number) =>
  before === undefined ? fallback : before === null ? tabs.length : Math.max(0, tabs.findIndex((t) => t.dataset.tab === before));
const inset = (z: Box): Box => ({ x: z.x + 6, y: z.y + 6, w: z.w - 12, h: z.h - 12 });
/** Where the Ask panel is, or where it would open (at its saved width, on the right). */
function panelBox(): Box {
  const el = document.querySelector<HTMLElement>("[data-agent-panel]");
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 40) return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  const w = Math.max(280, Math.min(Number(localStorage.getItem("etude.agent.width")) || 400, window.innerWidth * 0.5));
  return { x: window.innerWidth - w, y: 0, w, h: window.innerHeight };
}
function zoneBox(p: Place, els: HTMLElement[]): Box | null {
  if ("panel" in p) return inset(panelBox());
  const el = els[p.pane - 1];
  if (!el) return null;
  const R = seen(el);
  const z = p.zone === "tab" ? R : p.zone === "left" ? { ...R, w: R.w / 2 } : p.zone === "right" ? { ...R, x: R.x + R.w / 2, w: R.w / 2 } : p.zone === "top" ? { ...R, h: R.h / 2 } : { ...R, y: R.y + R.h / 2, h: R.h / 2 };
  return inset(z);
}

export function describePlace(p: Place, what: string, tabTitle?: (id: string) => string): string {
  if ("panel" in p) return `${what} in the Ask panel`;
  if (p.zone === "tab") {
    const at = p.before === undefined || !tabTitle ? "" : p.before === null ? ", at the end" : `, before ${tabTitle(p.before)}`;
    return `${what} as a tab in pane ${p.pane}${at}`;
  }
  return `${what} ${p.zone === "top" ? "above" : p.zone === "bottom" ? "below" : `to the ${p.zone} of`} pane ${p.pane}`;
}

export function PlacePicker({ what, panel, initial, slot = "next", live, titleOf, onPick, onBack }: {
  /** What's opening, for the line under the map ("New chat", a page's title). */
  what: string;
  /** A chat: the Ask panel is a place too. */
  panel?: boolean;
  initial?: "tab" | Side;
  /** Where in a pane's strip a tab starts out: next to the page in front, or at the end. */
  slot?: "next" | "end";
  /** Draw the place on the real panes (see canPlaceLive) instead of the map. */
  live?: boolean;
  titleOf(id: string): string;
  onPick(p: Place): void;
  onBack(): void;
}) {
  const ps = useMemo(() => mapPanes(titleOf), []); // eslint-disable-line react-hooks/exhaustive-deps
  const full = ps.length >= MAX_PANES;
  const start = ps.find((p) => p.focused) ?? ps[0];
  // On the live panes a tab's place names its gap in the strip; it starts next to the page in front (or at the end).
  const els = useMemo(() => (live ? paneEls() : []), [live]);
  const tabsIn = (n: number) => stripTabs(els[n - 1]);
  const startSlot = (n: number) => {
    const ts = tabsIn(n);
    const front = ts.findIndex((t) => t.getAttribute("aria-selected") === "true");
    return slot === "end" || front < 0 ? ts.length : front + 1;
  };
  const beforeAt = (n: number, i: number): string | null => tabsIn(n)[i]?.dataset.tab ?? null;
  const withSlot = (p: Place): Place =>
    live && !("panel" in p) && p.zone === "tab" && p.before === undefined && tabsIn(p.pane).length ? { ...p, before: beforeAt(p.pane, startSlot(p.pane)) } : p;
  const [sel, setSelRaw] = useState<Place>(() => withSlot({ pane: start.n, zone: full ? "tab" : (initial ?? "tab") }));
  const setSel = (v: Place | ((s: Place) => Place)) => setSelRaw((s) => withSlot(typeof v === "function" ? v(s) : v));
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);

  const at = (n: number) => ps.find((p) => p.n === n)!;
  const move = (dir: Side) =>
    setSel((s) => {
      if ("panel" in s) return dir === "left" ? { pane: ps.reduce((m, p) => (p.box.x + p.box.w > m.box.x + m.box.w - 0.002 ? p : m), ps[0]).n, zone: full ? "tab" : "right" } : s;
      const cur = at(s.pane);
      if (s.zone === opposite[dir]) return { pane: s.pane, zone: "tab" };
      if (s.zone === "tab" && !full) return { pane: s.pane, zone: dir };
      const next = neighbour(ps, cur, dir);
      if (next) return { pane: next.n, zone: full ? "tab" : opposite[dir] };
      if (dir === "right" && panel) return { panel: true };
      return s;
    });

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    const dir: Side | null = k === "ArrowLeft" ? "left" : k === "ArrowRight" ? "right" : k === "ArrowUp" ? "top" : k === "ArrowDown" ? "bottom" : null;
    // In a pane's strip, ← and → walk the gaps between its tabs first, then go on to that side.
    if (live && (dir === "left" || dir === "right") && !("panel" in sel) && sel.zone === "tab") {
      const ts = tabsIn(sel.pane);
      const j = slotOf(ts, sel.before, startSlot(sel.pane)) + (dir === "left" ? -1 : 1);
      if (ts.length && j >= 0 && j <= ts.length) return (e.preventDefault(), e.stopPropagation(), setSel({ ...sel, before: beforeAt(sel.pane, j) }));
    }
    if (dir) return (e.preventDefault(), e.stopPropagation(), move(dir));
    if (k === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const order: Place[] = [...ps.map((p) => ({ pane: p.n, zone: "tab" as const })), ...(panel ? [{ panel: true as const }] : [])];
      const i = order.findIndex((o) => ("panel" in o ? "panel" in sel : !("panel" in sel) && o.pane === sel.pane));
      return setSel(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
    }
    if (/^[1-4]$/.test(k) && at(Number(k))) return (e.preventDefault(), e.stopPropagation(), setSel({ pane: Number(k), zone: "tab" }));
    if ((k === "p" || k === "P") && panel) return (e.preventDefault(), e.stopPropagation(), setSel({ panel: true }));
    if (k === "Enter") return (e.preventDefault(), e.stopPropagation(), onPick(sel));
    if (k === "Escape" || (k === "Backspace" && !e.repeat)) return (e.preventDefault(), e.stopPropagation(), onBack());
  };

  // The mouse picks by where it is in a pane: its edges split, its middle takes a tab.
  const zoneAt = (p: MapPane, e: React.MouseEvent<HTMLElement>): "tab" | Side => {
    if (full) return "tab";
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
    const near = SIDES.reduce((m, s) => (d[s] < d[m] ? s : m), "left" as Side);
    return d[near] < EDGE ? near : "tab";
  };
  const gap = 4;

  if (live) {
    // The mouse picks like a dragged tab: a pane's edges split it, its middle takes a tab, the Ask panel takes a chat.
    const hit = (x: number, y: number): Place | null => {
      if (panel) {
        const b = panelBox();
        if (document.querySelector("[data-agent-panel]") && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { panel: true };
      }
      const i = els.findIndex((el) => {
        const r = seen(el);
        return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      });
      if (i < 0) return null;
      // Over the strip: the gap the pointer is nearest, like dropping a dragged tab there.
      const bar = els[i].querySelector(".note-topbar")?.getBoundingClientRect();
      const ts = tabsIn(i + 1);
      if (bar && ts.length && y >= bar.top && y <= bar.bottom) {
        const k = ts.findIndex((t) => {
          const r = t.getBoundingClientRect();
          return r.left + r.width / 2 > x;
        });
        return { pane: i + 1, zone: "tab", before: beforeAt(i + 1, k < 0 ? ts.length : k) };
      }
      // The middle of the pane keeps the gap already picked there.
      const kept = !("panel" in sel) && sel.pane === i + 1 && sel.zone === "tab" ? { before: sel.before } : {};
      if (full) return { pane: i + 1, zone: "tab", ...kept };
      const R = seen(els[i]);
      const d = { left: (x - R.x) / R.w, right: 1 - (x - R.x) / R.w, top: (y - R.y) / R.h, bottom: 1 - (y - R.y) / R.h };
      const near = SIDES.reduce((m, s2) => (d[s2] < d[m] ? s2 : m), "left" as Side);
      return d[near] < 0.32 ? { pane: i + 1, zone: near } : { pane: i + 1, zone: "tab", ...kept };
    };
    const same = (a: Place, b: Place) => ("panel" in a ? "panel" in b : !("panel" in b) && a.pane === b.pane && a.zone === b.zone && (a.zone !== "tab" || a.before === b.before));
    const z = zoneBox(sel, els);
    const line = !("panel" in sel) && sel.zone === "tab" ? slotLine(tabsIn(sel.pane), slotOf(tabsIn(sel.pane), sel.before, startSlot(sel.pane))) : null;
    const tabTitle = (id: string) => document.querySelector(`.note-tab[data-tab="${CSS.escape(id)}"]`)?.getAttribute("title")?.replace(/ \(pinned\)$/, "") || "that tab";
    return (
      <div
        ref={root}
        tabIndex={-1}
        onKeyDown={onKey}
        className="place-live fixed inset-0 outline-none"
        data-place-picker=""
        data-live=""
        onMouseMove={(e) => {
          const h = hit(e.clientX, e.clientY);
          if (h && !same(h, sel)) setSel(h);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const h = hit(e.clientX, e.clientY);
          if (h) onPick(h);
          else onBack();
        }}
      >
        {els.length > 1 && els.map((el, i) => {
          const r = seen(el);
          return <span key={i} className={cn("place-live-n", !("panel" in sel) && sel.pane === i + 1 && "is-here")} style={{ left: r.x + 12, top: r.y + 44 }}>{i + 1}</span>;
        })}
        {z && (
          <div className="note-drop-zone place-live-zone" style={{ left: z.x, top: z.y, width: z.w, height: z.h }}>
            <span>{what}</span>
          </div>
        )}
        {line && <div className="note-drop-tabline place-live-tabline" style={{ left: line.x, top: line.y, height: line.h }} />}
        <div className="place-live-bar" onClick={(e) => e.stopPropagation()}>
          <span className="min-w-0 truncate text-foreground/90">{describePlace(sel, what, tabTitle)}</span>
          <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
            <span><kbd className="deck-finder-kbd">←</kbd><kbd className="deck-finder-kbd">→</kbd><kbd className="deck-finder-kbd">↑</kbd><kbd className="deck-finder-kbd">↓</kbd> move</span>
            <span><kbd className="deck-finder-kbd">tab</kbd> pane</span>
            {panel && <span><kbd className="deck-finder-kbd">P</kbd> panel</span>}
            <span><kbd className="deck-finder-kbd">↵</kbd> open</span>
            <span><kbd className="deck-finder-kbd">esc</kbd> back</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKey} className="place-picker flex flex-col gap-2.5 px-3 pt-2.5 pb-3 outline-none" data-place-picker="">
      <div className="flex gap-2" style={{ height: 210 }}>
        <div className="relative min-w-0 flex-1">
          {ps.map((p) => {
            const here = !("panel" in sel) && sel.pane === p.n ? sel.zone : null;
            const b = p.box;
            return (
              <div
                key={p.n}
                className={cn("place-pane absolute flex flex-col overflow-hidden rounded-lg", here && "is-here")}
                style={{ left: `calc(${b.x * 100}% + ${gap / 2}px)`, top: `calc(${b.y * 100}% + ${gap / 2}px)`, width: `calc(${b.w * 100}% - ${gap}px)`, height: `calc(${b.h * 100}% - ${gap}px)` }}
                onMouseMove={(e) => {
                  const z = zoneAt(p, e);
                  if (here !== z) setSel({ pane: p.n, zone: z });
                }}
                onClick={(e) => onPick({ pane: p.n, zone: zoneAt(p, e) })}
              >
                <div className="flex h-[18px] shrink-0 items-end gap-[3px] overflow-hidden px-1.5">
                  {p.tabs.slice(0, 4).map((t, i) => (
                    <span key={i} className={cn("place-tab truncate", i === p.front && here !== "tab" && "is-front")}>{t || "Untitled"}</span>
                  ))}
                  {p.tabs.length > 4 && <span className="place-tab">+{p.tabs.length - 4}</span>}
                  {here === "tab" && <span className="place-tab is-new truncate">{what}</span>}
                </div>
                <div className="relative min-h-0 flex-1">
                  <span className="absolute top-1.5 left-2 text-[10.5px] text-muted-foreground/70 tabular-nums">{p.n}</span>
                  {/* What's there now moves to the half that keeps it when a side is taken. */}
                  <div className={cn("place-rest absolute flex items-center justify-center", here && here !== "tab" ? `is-${opposite[here]}` : "inset-0")}>
                    <span className="truncate px-2 text-[11.5px] text-muted-foreground">{here === "tab" ? what : p.tabs[p.front] || "New tab"}</span>
                  </div>
                  {here && here !== "tab" && <div className={cn("place-ghost absolute flex items-center justify-center", `is-${here}`)}><span className="truncate px-1.5 text-[11.5px] font-medium">{what}</span></div>}
                </div>
              </div>
            );
          })}
        </div>
        {panel && (
          <div
            className={cn("place-pane place-panel flex w-[17%] shrink-0 flex-col items-center justify-center gap-1 rounded-lg text-center", "panel" in sel && "is-here")}
            onMouseMove={() => !("panel" in sel) && setSel({ panel: true })}
            onClick={() => onPick({ panel: true })}
          >
            <span className="text-[11px] font-medium text-muted-foreground">Ask panel</span>
            {"panel" in sel && <span className="truncate px-1 text-[11px]">{what}</span>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-1 text-[12.5px]">
        <span className="min-w-0 flex-1 truncate text-foreground/85">{describePlace(sel, what)}</span>
      </div>
    </div>
  );
}
