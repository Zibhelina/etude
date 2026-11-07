// A small menu that opens where the pointer is (a right-click), for places that aren't one Radix trigger:
// Minimi in the corner, and the empty page behind everything. Same look as the app's context menus.
// Closes on Esc, a click outside, scrolling, a resize or losing focus.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type PointMenuItem = { label: string; onSelect(): void };

export function PointMenu({ x, y, items, onClose }: { x: number; y: number; items: PointMenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  // Keep it inside the window: flip left/up when it would run off the edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    setAt({ left: x + w + 8 > vw ? Math.max(8, x - w) : x, top: y + h + 8 > vh ? Math.max(8, y - h) : y });
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const away = () => onClose();
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", key, true);
    addEventListener("scroll", away, true);
    addEventListener("resize", away);
    addEventListener("blur", away);
    return () => {
      removeEventListener("pointerdown", down, true);
      removeEventListener("keydown", key, true);
      removeEventListener("scroll", away, true);
      removeEventListener("resize", away);
      removeEventListener("blur", away);
    };
  }, [onClose]);
  // Portalled to the body: a transformed parent (Minimi is scaled on iPad) would move a fixed box.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-point-menu
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      // React events bubble through portals; keep presses here from reaching Minimi (who'd start a drag).
      onPointerDown={(e) => e.stopPropagation()}
      className="point-menu fixed z-[70] min-w-[9.5rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={at}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
            it.onSelect();
          }}
          className="flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
