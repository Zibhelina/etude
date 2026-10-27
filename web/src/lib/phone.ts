// Phones get their own layout (the "Score" language in docs/mobile-design.md), not a squeezed desktop.
// The breakpoint matches the tab bar: below md (768 px) is a phone.
import { useEffect, useRef, useState } from "react";

const Q = "(max-width: 767px)";

export function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(Q).matches);
  useEffect(() => {
    const m = window.matchMedia(Q);
    const h = () => setPhone(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return phone;
}

/**
 * Press and hold on touch: calls `onHold` after `ms` unless the finger moves (a scroll) or lifts.
 * Spread the returned handlers on the element; `held()` tells a click handler to skip the tap that ends a hold.
 */
export function useLongPress(onHold: () => void, ms = 450) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    held: () => {
      const f = fired.current;
      fired.current = false;
      return f;
    },
    handlers: {
      onPointerDown(e: React.PointerEvent) {
        if (e.pointerType === "mouse") return;
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clear();
        timer.current = window.setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(8);
          onHold();
        }, ms);
      },
      onPointerMove(e: React.PointerEvent) {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onContextMenu(e: React.MouseEvent) {
        // Android fires contextmenu on a long press; the hold already handled it.
        if (fired.current || timer.current) e.preventDefault();
      },
    },
  };
}
