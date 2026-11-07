// Resizing a block in a page (cards, decks): drag a side edge for the width (the block stays centred) and the
// bottom edge for the height (taller content scrolls inside). Both are kept on the block; double-click an edge
// to go back to automatic. Sizes are px; the width never goes past the page column.
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const RESIZE_ATTRS = {
  width: { default: null, parseHTML: (el: HTMLElement) => Number(el.dataset.width) || null, renderHTML: (a: any) => (a.width ? { "data-width": String(a.width) } : {}) },
  height: { default: null, parseHTML: (el: HTMLElement) => Number(el.dataset.height) || null, renderHTML: (a: any) => (a.height ? { "data-height": String(a.height) } : {}) },
};

const MIN_W = 280;
const MIN_H = 110;

/** The box's style: its width (centred) and, when set, a fixed height for the frame inside. */
export function useResizable(attrs: { width?: number | null; height?: number | null }, update: (a: { width?: number | null; height?: number | null }) => void) {
  const box = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<{ width?: number | null; height?: number | null } | null>(null);
  const width = live?.width !== undefined ? live.width : attrs.width ?? null;
  const height = live?.height !== undefined ? live.height : attrs.height ?? null;

  const start = (edge: "left" | "right" | "bottom") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = box.current;
    if (!el) return;
    const column = (el.parentElement?.getBoundingClientRect().width ?? 720) || 720;
    const r = el.getBoundingClientRect();
    const frameH = el.querySelector<HTMLElement>(".note-cards-frame")?.getBoundingClientRect().height ?? r.height;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = r.width;
    const h0 = frameH;
    let next: { width?: number | null; height?: number | null } = {};
    document.body.classList.add(edge === "bottom" ? "note-resizing-y" : "note-resizing-x");
    const move = (ev: PointerEvent) => {
      if (edge === "bottom") {
        next = { height: Math.round(Math.max(MIN_H, Math.min(2000, h0 + ev.clientY - y0))) };
      } else {
        // Centred, so each side moves by the drag and the width changes by twice that.
        const d = (edge === "right" ? ev.clientX - x0 : x0 - ev.clientX) * 2;
        const w = Math.round(Math.max(MIN_W, Math.min(column, w0 + d)));
        next = { width: w >= column - 4 ? null : w };
      }
      setLive(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("note-resizing-x", "note-resizing-y");
      if (Object.keys(next).length) update(next);
      setLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handles = (
    <>
      <span contentEditable={false} className="note-rs note-rs-l" onPointerDown={start("left")} onDoubleClick={() => update({ width: null })} title="Drag to resize · double-click for full width" />
      <span contentEditable={false} className="note-rs note-rs-r" onPointerDown={start("right")} onDoubleClick={() => update({ width: null })} title="Drag to resize · double-click for full width" />
      <span contentEditable={false} className={cn("note-rs note-rs-b", height && "is-set")} onPointerDown={start("bottom")} onDoubleClick={() => update({ height: null })} title="Drag to change the height · double-click to fit the card" />
    </>
  );
  return { box, width, height, handles, resizing: !!live };
}
