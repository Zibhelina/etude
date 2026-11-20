// Scrolling the page while something is dragged in it: with the pointer near the top or bottom of the pane (or past
// it, over the top bar or the tab strip), the page scrolls that way, faster the closer the pointer is to the edge,
// so a block can be carried to a part of the page that isn't on screen. The browser's own drag autoscroll can't be
// relied on: its edge band is a few pixels, the pane's sticky top bar covers the top one, and WebKit hardly does it.

/** The nearest ancestor that scrolls vertically; the document itself when none does (a single pane scrolls the window). */
export function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Pixels the page moves in one frame with the pointer at `y`, for a visible band from `top` to `bottom`. */
export function dragScrollStep(y: number, top: number, bottom: number, band = 72, max = 26): number {
  const h = bottom - top;
  if (h <= 0) return 0;
  const b = Math.min(band, h / 4);
  // 0 at the band's inner edge, 1 at the pane's edge, up to 1.6 past it.
  const at = (d: number) => Math.min(1.6, d / b);
  if (y < top + b) return -Math.round(max * at(top + b - y) ** 2) || -1;
  if (y > bottom - b) return Math.round(max * at(y - (bottom - b)) ** 2) || 1;
  return 0;
}

/**
 * Starts scrolling `scroller` with the drag's pointer; returns the function that stops it. `area` is the pane the
 * pointer has to be over (left to right); `topInset` is what covers the top of the scroller (its sticky bar), so the
 * band starts below it.
 */
export function startDragScroll(scroller: HTMLElement, area: HTMLElement, topInset: () => number = () => 0): () => void {
  const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
  let x = -1;
  let y = -1;
  let last = performance.now();
  let raf = 0;
  const onOver = (e: DragEvent) => {
    x = e.clientX;
    y = e.clientY;
    last = performance.now();
  };
  const tick = () => {
    raf = requestAnimationFrame(tick);
    // No dragover for a while: the pointer left the window, or the drag ended where nobody heard it.
    const idle = performance.now() - last;
    if (idle > 10_000) return stop();
    if (y < 0 || idle > 1000) return;
    const a = area.getBoundingClientRect();
    // Only for the pointer over this pane's column (another pane beside it scrolls on its own).
    if (x < a.left || x > a.right) return;
    // The window's scroller spans the viewport; a pane's spans its box.
    const r = isDoc ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
    const dy = dragScrollStep(y, r.top + topInset(), r.bottom);
    if (dy) scroller.scrollTop += dy;
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("dragover", onOver, true);
    window.removeEventListener("drop", stop, true);
    document.removeEventListener("dragend", stop, true);
  };
  window.addEventListener("dragover", onOver, true);
  // The drop lands in the document; dragend reaches it unless the dragged node left the page.
  window.addEventListener("drop", stop, true);
  document.addEventListener("dragend", stop, true);
  raf = requestAnimationFrame(tick);
  return stop;
}
