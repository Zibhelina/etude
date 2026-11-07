// One way to move every row that scrolls sideways (Market shelves, Featured, galleries, card types on a phone, chips):
// round arrows over the row's edges on anything with a mouse (hidden at the end they can't go to, and when nothing
// overflows), a fade at the side that has more (mouse and touch), drag with the mouse (snaps to a card on release; a drag never counts
// as a click), ← → when the row has focus. Touch keeps the browser's own swipe.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const smooth = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");

/** Left edge of every child, relative to the row's scroll origin (where each card snaps). */
function stops(r: HTMLElement): number[] {
  const pad = parseFloat(getComputedStyle(r).scrollPaddingInlineStart) || 0;
  const base = r.getBoundingClientRect().left - r.scrollLeft;
  return [...r.children].map((c) => Math.max(0, (c as HTMLElement).getBoundingClientRect().left - base - pad));
}

/** Index of the card nearest the row's start. */
export function nearestIndex(r: HTMLElement): number {
  const s = stops(r);
  let best = 0;
  s.forEach((x, i) => Math.abs(x - r.scrollLeft) < Math.abs(s[best] - r.scrollLeft) && (best = i));
  return r.scrollLeft + r.clientWidth >= r.scrollWidth - 4 ? s.length - 1 : best;
}

export function useHScroll<T extends HTMLElement>(ref: RefObject<T | null>, opts: { page?: "card" | "view"; /** Changes when the row appears, disappears or changes content. */ dep?: unknown } = {}) {
  const [edge, setEdge] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const r = ref.current;
    if (!r) return;
    // Arrows sit on the middle of the cards' picture (the first child's [data-hs-anchor], or the card), not the row.
    const wrap = r.parentElement;
    const anchor = (r.querySelector("[data-hs-anchor]") ?? r.firstElementChild) as HTMLElement | null;
    if (wrap && anchor) {
      const a = anchor.getBoundingClientRect();
      wrap.style.setProperty("--hs-y", `${Math.round(a.top - wrap.getBoundingClientRect().top + a.height / 2)}px`);
    }
    // "At the start" means at the first card's snap point: a row with inline padding snaps a few px in, so
    // scrollLeft is never 0 there (that showed the ‹ arrow on the very first card).
    const first = stops(r)[0] ?? 0;
    const start = r.scrollLeft <= first + 4;
    const end = r.scrollLeft + r.clientWidth >= r.scrollWidth - 4;
    // Fade only over a card the edge actually cuts, so cards fully on screen are never dimmed.
    const box = r.getBoundingClientRect();
    let fl = 0, fr = 0;
    for (const c of r.children) {
      const b = (c as HTMLElement).getBoundingClientRect();
      if (b.width < 1) continue;
      if (b.left < box.left - 2 && b.right > box.left + 8) fl = Math.max(fl, Math.min(40, b.right - box.left));
      if (b.right > box.right + 2 && b.left < box.right - 8) fr = Math.max(fr, Math.min(96, box.right - b.left));
    }
    r.style.setProperty("--hs-fl", `${start ? 0 : Math.round(fl)}px`);
    r.style.setProperty("--hs-fr", `${end ? 0 : Math.round(fr)}px`);
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, [ref]);

  /** Moves by one card, or by as many whole cards as fit (`view`), landing on a card's edge. */
  const page = useCallback((d: 1 | -1) => {
    const r = ref.current;
    if (!r) return;
    const s = stops(r);
    if (!s.length) return;
    const at = r.scrollLeft;
    const max = r.scrollWidth - r.clientWidth;
    let target: number;
    if (opts.page === "view") {
      target = d > 0 ? s.filter((x) => x <= at + r.clientWidth - 8).at(-1) ?? at + r.clientWidth : s.filter((x) => x >= at - r.clientWidth + 8 && x < at - 4)[0] ?? 0;
      if (d > 0 && target <= at + 4) target = s.find((x) => x > at + 4) ?? max;
    } else target = d > 0 ? s.find((x) => x > at + 4) ?? max : [...s].reverse().find((x) => x < at - 4) ?? 0;
    r.scrollTo({ left: Math.min(max, Math.max(0, target)), behavior: smooth() });
  }, [ref, opts.page]);

  const to = useCallback((i: number) => {
    const r = ref.current;
    if (!r) return;
    const s = stops(r);
    r.scrollTo({ left: Math.min(r.scrollWidth - r.clientWidth, s[Math.max(0, Math.min(s.length - 1, i))] ?? 0), behavior: smooth() });
  }, [ref]);

  const drag = useRef<{ x: number; left: number; moved: boolean; id: number } | null>(null);
  useEffect(() => {
    const r = ref.current;
    if (!r) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(r);
    for (const c of r.children) ro.observe(c);
    const mo = new MutationObserver(measure);
    mo.observe(r, { childList: true });

    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || r.scrollWidth <= r.clientWidth + 4) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], video, [data-no-drag]")) return;
      drag.current = { x: e.clientX, left: r.scrollLeft, moved: false, id: e.pointerId };
    };
    const move = (e: PointerEvent) => {
      const g = drag.current;
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      if (!g.moved && Math.abs(dx) < 6) return;
      if (!g.moved) {
        g.moved = true;
        r.setPointerCapture(e.pointerId);
        r.dataset.dragging = "";
      }
      r.scrollLeft = g.left - dx;
    };
    const up = (e: PointerEvent) => {
      const g = drag.current;
      if (!g || e.pointerId !== g.id) return;
      drag.current = null;
      if (!g.moved) return;
      delete r.dataset.dragging;
      // Land on the nearest card, a little biased the way it was thrown.
      const s = stops(r);
      const bias = (g.left - r.scrollLeft) > 0 ? -0.35 : 0.35;
      const w = (r.firstElementChild as HTMLElement | null)?.offsetWidth ?? r.clientWidth;
      const goal = r.scrollLeft + bias * w;
      const near = s.reduce((a, b) => (Math.abs(b - goal) < Math.abs(a - goal) ? b : a), s[0] ?? 0);
      r.scrollTo({ left: Math.min(r.scrollWidth - r.clientWidth, near), behavior: smooth() });
      // The click that ends a drag isn't a click on the card under it.
      const eat = (c: Event) => (c.stopPropagation(), c.preventDefault());
      r.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => r.removeEventListener("click", eat, { capture: true }), 0);
    };
    const nodrag = (e: DragEvent) => e.preventDefault();
    const key = (e: KeyboardEvent) => {
      if (e.target !== r || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      e.preventDefault();
      page(e.key === "ArrowRight" ? 1 : -1);
    };
    r.addEventListener("scroll", measure, { passive: true });
    r.addEventListener("pointerdown", down);
    r.addEventListener("pointermove", move);
    r.addEventListener("pointerup", up);
    r.addEventListener("pointercancel", up);
    r.addEventListener("dragstart", nodrag);
    r.addEventListener("keydown", key);
    return () => {
      ro.disconnect();
      mo.disconnect();
      r.removeEventListener("scroll", measure);
      r.removeEventListener("pointerdown", down);
      r.removeEventListener("pointermove", move);
      r.removeEventListener("pointerup", up);
      r.removeEventListener("pointercancel", up);
      r.removeEventListener("dragstart", nodrag);
      r.removeEventListener("keydown", key);
    };
  }, [ref, measure, page, opts.dep]);

  /** Spread on the scrolling element: the fade and the focusable row. */
  const rowProps = { "data-hs": "", "data-more-left": edge.start ? undefined : "", "data-more-right": edge.end ? undefined : "", tabIndex: edge.start && edge.end ? -1 : 0 } as const;
  return { edge, page, to, rowProps };
}

/** The two round arrows over a row's edges. Put them inside a `relative` box that also holds the row. */
export function HArrows({ edge, page, label = "more", className }: { edge: { start: boolean; end: boolean }; page(d: 1 | -1): void; label?: string; className?: string }) {
  if (edge.start && edge.end) return null;
  return (
    <>
      <button type="button" className={cn("hs-arrow left", edge.start && "gone", className)} aria-label={`Previous ${label}`} tabIndex={-1} onClick={() => page(-1)} data-hs-prev>
        <ChevronLeft className="size-5" />
      </button>
      <button type="button" className={cn("hs-arrow right", edge.end && "gone", className)} aria-label={`Next ${label}`} tabIndex={-1} onClick={() => page(1)} data-hs-next>
        <ChevronRight className="size-5" />
      </button>
    </>
  );
}
