// Zoom for one Notebook pane at a time: Ctrl/⌘ + and − (and 0 for 100%) make the focused pane's contents bigger
// or smaller and leave the rest of the window as it is. Most views just get CSS zoom; a view that draws itself
// at a size (a PDF re-renders its pages) takes the keys for its pane instead, through useOwnZoom.
import { createContext, useContext, useEffect, useRef } from "react";

export type ZoomBy = 1 | -1 | 0;
/** A pinch (or Ctrl + scroll) going on: the size so far, relative to where it started; `end` when the fingers lift; where the pointer is. */
export type Pinch = { scale: number; end: boolean; x: number; y: number };

/** The pane a view sits in; null outside the Notebook's panes. */
export const PaneIdCtx = createContext<string | null>(null);

type Own = (by: ZoomBy | Pinch) => void;
const own = new Map<string, Own>();

/** For a view that zooms itself: its pane's zoom keys come here. Says whether the view is in a pane. */
export function useOwnZoom(fn: Own): boolean {
  const pane = useContext(PaneIdCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!pane) return;
    const f: Own = (by) => ref.current(by);
    own.set(pane, f);
    return () => {
      if (own.get(pane) === f) own.delete(pane);
    };
  }, [pane]);
  return !!pane;
}
export const ownZoom = (pane: string): Own | undefined => own.get(pane);

/**
 * How much one wheel event zooms. A trackpad pinch comes as ctrl+wheel with deltaY = −100·ln(scale), so this gives
 * back the fingers' own scale; a mouse wheel's notch (50 and up, or a line) is one 10% step. Up (negative) is in.
 */
export function wheelFactor(deltaY: number, deltaMode = 0) {
  if (deltaMode === 1 || Math.abs(deltaY) >= 50) return deltaY < 0 ? 1.1 : 1 / 1.1;
  return Math.exp(-deltaY / 100);
}

/** A point on the screen tied to what's under it (a spot in a line of text, or in an element), to keep it under the pointer while the size changes. */
export type Anchor = { x: number; y: number; at: Range | Element; fx: number; fy: number };

export function anchorAt(x: number, y: number): Anchor | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  // In text, the line under the pointer (it reflows when the size changes, so an element's box would drift).
  const r = (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(x, y);
  if (r && r.startContainer.nodeType === Node.TEXT_NODE && el.contains(r.startContainer)) {
    const b = r.getBoundingClientRect();
    if (b.height > 0 && y >= b.top - 2 && y <= b.bottom + 2) return { x, y, at: r, fx: 0, fy: (y - b.top) / b.height };
  }
  const b = el.getBoundingClientRect();
  return { x, y, at: el, fx: (x - b.left) / (b.width || 1), fy: (y - b.top) / (b.height || 1) };
}

/** Scrolls what holds the anchor so its spot is back under the pointer. */
export function keepAnchor(a: Anchor | null) {
  if (!a) return;
  const node = a.at instanceof Range ? a.at.startContainer : a.at;
  if (!node.isConnected) return;
  const b = a.at.getBoundingClientRect();
  let dy = b.top + a.fy * b.height - a.y;
  let dx = a.at instanceof Range ? 0 : b.left + a.fx * b.width - a.x;
  for (let p = node.parentElement; p && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5); p = p.parentElement) {
    const cs = getComputedStyle(p);
    const sy = /auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight;
    const sx = /auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth;
    if (!sx && !sy) continue;
    const t = p.scrollTop, l = p.scrollLeft;
    if (sy) p.scrollTop += dy;
    if (sx) p.scrollLeft += dx;
    dy -= p.scrollTop - t;
    dx -= p.scrollLeft - l;
  }
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) window.scrollBy(dx, dy);
}

/** What a key press asks for: Ctrl/⌘ with + or = (in), − (out), 0 (back to 100%). */
export function zoomKey(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): ZoomBy | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return 1;
  if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return -1;
  if (e.key === "0" || e.code === "Numpad0") return 0;
  return null;
}

/** The CSS zoom an element is drawn at (a Notebook pane can have its own). Rects come zoomed, while lengths from
 * computed styles and the translate of an overlay inside the zoom are not, so they have to be scaled between. */
export function cssZoom(el: Element): number {
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (z) return z;
  const w = (el as HTMLElement).offsetWidth;
  return w ? el.getBoundingClientRect().width / w : 1;
}
