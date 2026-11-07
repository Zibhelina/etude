// Minimi, Etude's mascot, in the corner (Fun mode, desktop and iPad). He sits reading; on hover he looks up
// with "Ask me"; a click opens Ask Etude. He can be dragged anywhere in the window: he lifts and tilts while
// carried, squashes a little when dropped, and stays where he was put (per device size). Dropping him near
// his corner sends him home. While his mini chat is open he looks up at you.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import read from "@/assets/minimi/read.webp";
import down from "@/assets/minimi/down.webp";
import look from "@/assets/minimi/look.webp";
import { cn } from "@/lib/utils";

import { useMinimiFaces } from "@/components/minimi-faces";

const W = 84;
const H = 124;
const MARGIN = 12;
// The page's own box, without a classic scrollbar, so he never hides under one.
const view = () => [document.documentElement.clientWidth, document.documentElement.clientHeight] as const;
const deviceKey = () => `etude.minimi.pos.${view()[0] >= 1024 ? "desktop" : "tablet"}`;

type Pos = { fx: number; fy: number } | null;
const loadPos = (): Pos => {
  try {
    return JSON.parse(localStorage.getItem(deviceKey()) ?? "null");
  } catch {
    return null;
  }
};
const savePos = (p: Pos) => {
  try {
    p ? localStorage.setItem(deviceKey(), JSON.stringify(p)) : localStorage.removeItem(deviceKey());
  } catch {}
};

export function MinimiCorner({ onOpen, shortcut, rightOffset = "0px", talking = false }: { onOpen(): void; shortcut: string; rightOffset?: string; talking?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [page, setPage] = useState(false);
  const [drag, setDrag] = useState<null | { near: boolean }>(null);
  const [land, setLand] = useState(false);
  const faces = useMinimiFaces();

  // Free space for his top-left corner, inside the window.
  const room = () => [Math.max(1, view()[0] - W), Math.max(1, view()[1] - H)] as const;
  const place = useCallback(() => {
    const p = loadPos();
    if (!p) return setPos(null);
    const [w, h] = room();
    setPos({ x: Math.min(w, Math.max(0, p.fx * w)), y: Math.min(h, Math.max(0, p.fy * h)) });
  }, []);
  useLayoutEffect(place, [place]);
  // A window resize, or the page's own box changing (a scrollbar appearing once content loads doesn't fire resize).
  useEffect(() => {
    const ro = new ResizeObserver(place);
    ro.observe(document.documentElement);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  // Idle: he turns a page every few seconds.
  useEffect(() => {
    const t = setInterval(() => setPage((p) => !p), 2600);
    return () => clearInterval(t);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    faces.onPointerDown(e);
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const home = { x: view()[0] - W - MARGIN, y: view()[1] - H - MARGIN };
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      // Held long enough that his faces fanned out: the finger is choosing a face, not carrying him.
      if (!moved && document.querySelector("[data-minimi-faces] .mf-face")) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      const [w, h] = room();
      const x = Math.min(w, Math.max(0, r.left + dx)), y = Math.min(h, Math.max(0, r.top + dy));
      setPos({ x, y });
      setDrag({ near: Math.hypot(x - home.x, y - home.y) < 44 });
      document.body.classList.add("minimi-dragging");
    };
    const up = (ev: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      document.body.classList.remove("minimi-dragging");
      if (!moved) return;
      const [w, h] = room();
      const x = Math.min(w, Math.max(0, r.left + ev.clientX - sx)), y = Math.min(h, Math.max(0, r.top + ev.clientY - sy));
      if (Math.hypot(x - home.x, y - home.y) < 44) {
        savePos(null);
        setPos(null);
      } else savePos({ fx: x / w, fy: y / h });
      setDrag(null);
      setLand(true);
      setTimeout(() => setLand(false), 340);
      // The click that ends a drag isn't a tap.
      const kill = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      addEventListener("click", kill, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", kill, { capture: true }), 60);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const tipBelow = pos ? pos.y < 70 : false;
  return (
    <div
      ref={ref}
      data-minimi
      onPointerDown={onPointerDown}
      onContextMenu={faces.onContextMenu}
      className={cn("minimi group fixed z-30 touch-none select-none", drag ? "cursor-grabbing" : "cursor-grab", drag && "is-drag", drag?.near && "is-near", land && "is-land", talking && "is-talk")}
      style={pos ? { left: pos.x, top: pos.y, width: W, height: H } : { right: `calc(${MARGIN}px + ${rightOffset})`, bottom: MARGIN, width: W, height: H }}
    >
      <div role="tooltip" className={cn("minimi-tip pointer-events-none absolute right-0 rounded-xl bg-card px-3 py-2 text-[13.5px] leading-snug whitespace-nowrap text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_22px_rgb(0_0_0/0.10)] ring-1 ring-border", tipBelow ? "top-[calc(100%+6px)]" : "bottom-[128px] rounded-br-sm")}>
        Hm?
        <br />
        <b className="font-semibold">Ask me</b> <kbd className="ml-1 rounded-[5px] bg-muted px-1.5 py-px text-muted-foreground">{shortcut}</kbd>
        <span className="mt-0.5 block text-[11.5px] text-muted-foreground/70">drag me, or hold to change my face</span>
      </div>
      <button type="button" onClick={onOpen} aria-label={`Ask Minimi · ${shortcut}`} aria-expanded={talking} data-agent-launcher className="minimi-btn relative block size-full rounded-2xl outline-ring focus-visible:outline-2">
        <img src={read} alt="" draggable={false} className={cn("minimi-fr", !page && "on")} />
        <img src={down} alt="" draggable={false} className={cn("minimi-fr", page && "on")} />
        <img src={look} alt="" draggable={false} className="minimi-fr minimi-look" />
      </button>
      {faces.node}
    </div>
  );
}
