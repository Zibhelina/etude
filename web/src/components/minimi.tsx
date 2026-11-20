// Minimi, Etude's mascot, in the corner (Fun mode, desktop and iPad). He sits reading; on hover he looks up
// with "Ask me"; a click opens Ask Etude. He can be dragged anywhere in the window: he lifts and tilts while
// carried, squashes a little when dropped, and stays where he was put (per device size). Dropping him near
// his corner sends him home. While his mini chat is open he looks up at you. Right-click → Hide puts him away
// on this device; right-clicking an empty spot of the page brings him back there (App.tsx, lib/minimi-hidden).
// Right-click → Resize shows a frame with a handle on his top-left corner: drag it (or scroll) and his feet and
// right side stay put; Enter, Esc or a click elsewhere keeps the size. Saved per device size, like his spot.
// Another agent profile with a body of its own (a transparent picture, optionally animated by clips like his Christmas ones) sits here the same way, at his size.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import read from "@/assets/minimi/read.webp";
import down from "@/assets/minimi/down.webp";
import look from "@/assets/minimi/look.webp";
import { cn } from "@/lib/utils";

import { useMinimiFaces } from "@/components/minimi-faces";
import { PointMenu } from "@/components/point-menu";
import { setMinimiHidden } from "@/lib/minimi-hidden";
import { toast } from "sonner";
import { useHoliday, useHolidayArt } from "@/lib/holiday";
import { MinimiClips, ProfileClips, clipsOk } from "@/components/minimi-clips";
import { EtudeImg } from "@/lib/local-url";
import { mediaUrl, type ProfileView } from "@/lib/agent-profiles";

const W = 84;
const H = 124;
const MARGIN = 12;
// The page's own box, without a classic scrollbar, so he never hides under one.
const view = () => [document.documentElement.clientWidth, document.documentElement.clientHeight] as const;
const deviceKey = () => `etude.minimi.pos.${view()[0] >= 1024 ? "desktop" : "tablet"}`;

// His size, a multiple of W×H. The art is 360×533, so 2.5× still stays sharp on a 2× screen.
const MIN_S = 0.6, MAX_S = 2.5;
const sizeKey = () => `etude.minimi.size.${view()[0] >= 1024 ? "desktop" : "tablet"}`;
const clampS = (v: number) => Math.min(MAX_S, Math.max(MIN_S, v));
const loadSize = () => {
  try {
    const v = Number(localStorage.getItem(sizeKey()));
    return v > 0 ? clampS(v) : 1;
  } catch {
    return 1;
  }
};
const saveSize = (v: number) => {
  try {
    Math.abs(v - 1) < 0.005 ? localStorage.removeItem(sizeKey()) : localStorage.setItem(sizeKey(), v.toFixed(3));
  } catch {}
};

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

/** Saves his spot so the pointer sits on his middle, inside the window. The next mount reads it. */
export function placeMinimiAt(px: number, py: number) {
  const [vw, vh] = view();
  const s = vw >= 1024 ? 1 : 0.78; // iPad draws him smaller, from his bottom-right corner
  const z = loadSize(), bw = W * z, bh = H * z;
  const w = Math.max(1, vw - bw), h = Math.max(1, vh - bh);
  // On iPad he's scaled around his bottom-right corner, so his drawn middle sits right of and below the box's.
  const cx = bw - (bw * s) / 2, cy = bh - (bh * s) / 2;
  const x = Math.min(w, Math.max(0, px - cx)), y = Math.min(h, Math.max(0, py - cy));
  savePos({ fx: x / w, fy: y / h });
  appear = true;
}
// Set when he's just been called back, so he pops in instead of simply being there.
let appear = false;

export function MinimiCorner({ onOpen, shortcut, rightOffset = "0px", talking = false, profile }: { onOpen(): void; shortcut: string; rightOffset?: string; talking?: boolean; profile?: ProfileView }) {
  // Minimi's own body (faces, holiday clips), or another profile's picture.
  const body = profile?.body && profile.body !== "minimi" ? profile.body : null;
  const name = body ? profile!.name : "Minimi";
  const ref = useRef<HTMLDivElement>(null);
  const art = useHolidayArt(); // his Christmas outfit while the holidays are on
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [page, setPage] = useState(false);
  const [drag, setDrag] = useState<null | { near: boolean }>(null);
  const [land, setLand] = useState(false);
  const [pop, setPop] = useState(() => appear);
  const [leaving, setLeaving] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [size, setSizeState] = useState(loadSize);
  const sizeRef = useRef(size);
  const setSize = (v: number) => {
    sizeRef.current = v;
    setSizeState(v);
  };
  const [resizing, setResizing] = useState(false);
  const [grip, setGrip] = useState(false);
  const faces = useMinimiFaces();
  useEffect(() => {
    appear = false;
    if (!pop) return;
    const t = setTimeout(() => setPop(false), 420);
    return () => clearTimeout(t);
  }, []);
  const lastPointer = useRef("mouse");
  const hide = () => {
    setLeaving(true);
    setTimeout(() => {
      setMinimiHidden(true);
      toast(body ? `${name} stepped away` : "Minimi went to take a nap", {
        description: "Right-click an empty spot to call him back.",
        action: { label: "Undo", onClick: () => setMinimiHidden(false) },
      });
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);
  };
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // A long press on a touch screen opens his faces, not this menu.
    const type = (e.nativeEvent as PointerEvent).pointerType || lastPointer.current;
    if (type === "touch" || type === "pen") return;
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // Free space for his top-left corner, inside the window.
  const room = (z = sizeRef.current) => [Math.max(1, view()[0] - W * z), Math.max(1, view()[1] - H * z)] as const;
  const place = useCallback(() => {
    // Crossing the desktop/iPad line reads that device's own size.
    const z = loadSize();
    if (z !== sizeRef.current) setSize(z);
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

  // Idle: he turns a page every few seconds. In his holiday outfit the two frames are his eyes on the left
  // and the right page, so he reads instead: a glance back to the start of a line (~1.3 s), a longer run across
  // it (~2.8 s), and a longer pause every few lines. He only looks up at you on hover, drag or chat.
  const holiday = useHoliday().active;
  // In the outfit he's drawn by short clips (components/minimi-clips) where the browser can play them.
  const [clips] = useState(clipsOk);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!holiday) {
      const t = setInterval(() => setPage((p) => !p), 2600);
      return () => clearInterval(t);
    }
    let line = 0, t = 0;
    const step = (right: boolean) => {
      setPage(right);
      if (right) line++;
      const ms = right ? (line % 4 === 0 ? 4500 : 2400 + Math.random() * 800) : 1200 + Math.random() * 400;
      t = window.setTimeout(() => step(!right), ms);
    };
    step(false);
    return () => window.clearTimeout(t);
  }, [holiday]);

  // Resize mode: his bottom-right corner (feet, right side) stays put while the top-left handle moves.
  const stopResize = useCallback(() => {
    setResizing(false);
    setGrip(false);
    saveSize(sizeRef.current);
    // After the last size has been drawn, so his spot is read from where he actually is.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || !loadPos()) return;
      const [w, h] = room();
      savePos({ fx: Math.min(1, Math.max(0, el.offsetLeft / w)), fy: Math.min(1, Math.max(0, el.offsetTop / h)) });
    });
  }, []);
  /** Sets his size keeping his bottom-right corner where it is, never bigger than the room up and left of it. */
  const resizeTo = (want: number) => {
    const el = ref.current!;
    const right = el.offsetLeft + el.offsetWidth, bottom = el.offsetTop + el.offsetHeight;
    const z = clampS(Math.min(want, right / W, bottom / H));
    if (pos) setPos({ x: right - W * z, y: bottom - H * z });
    setSize(z);
  };
  useEffect(() => {
    if (!resizing) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        stopResize();
      } else if (e.key === "+" || e.key === "=" || e.key === "ArrowUp") {
        e.preventDefault();
        resizeTo(sizeRef.current + 0.1);
      } else if (e.key === "-" || e.key === "ArrowDown") {
        e.preventDefault();
        resizeTo(sizeRef.current - 0.1);
      }
    };
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && stopResize();
    // Scrolling over him resizes him; not passive, so the page behind doesn't scroll too.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      resizeTo(sizeRef.current * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    };
    const el = ref.current;
    addEventListener("keydown", key, true);
    addEventListener("pointerdown", away, true);
    el?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      removeEventListener("keydown", key, true);
      removeEventListener("pointerdown", away, true);
      el?.removeEventListener("wheel", wheel);
    };
  });
  const onGripDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button > 0) return;
    const el = ref.current!;
    const right = el.offsetLeft + el.offsetWidth, bottom = el.offsetTop + el.offsetHeight;
    const z0 = sizeRef.current, sx = e.clientX, sy = e.clientY;
    setGrip(true);
    document.body.classList.add("minimi-resizing");
    const move = (ev: PointerEvent) => {
      // Up-left grows him, down-right shrinks him; the diagonal decides, weighted by his shape.
      const grow = (-(ev.clientX - sx) / W - (ev.clientY - sy) / H) / 2;
      const z = clampS(Math.min(z0 + grow, right / W, bottom / H));
      if (pos) setPos({ x: right - W * z, y: bottom - H * z });
      setSize(z);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      document.body.classList.remove("minimi-resizing");
      setGrip(false);
      saveSize(sizeRef.current);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    lastPointer.current = e.pointerType;
    if (e.button > 0 || resizing) return;
    // Hold-for-faces is a touch gesture (phone, iPad); with a mouse a press is a click or a drag.
    if (e.pointerType !== "mouse" && !body) faces.onPointerDown(e);
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const home = { x: view()[0] - W * sizeRef.current - MARGIN, y: view()[1] - H * sizeRef.current - MARGIN };
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

  const bw = W * size, bh = H * size;
  const tipBelow = pos ? pos.y < 70 : false;
  return (
    <div
      ref={ref}
      data-minimi
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={cn("minimi group fixed z-30 touch-none select-none", resizing ? "is-resize" : drag ? "cursor-grabbing" : "cursor-grab", drag && "is-drag", drag?.near && "is-near", land && "is-land", talking && "is-talk", pop && "is-pop", leaving && "is-leave", menu && "is-menu", grip && "is-grip")}
      style={{ ...(pos ? { left: pos.x, top: pos.y } : { right: `calc(${MARGIN}px + ${rightOffset})`, bottom: MARGIN }), width: bw, height: bh, ["--minimi-s" as string]: size }}
    >
      <div role="tooltip" style={tipBelow ? undefined : { bottom: bh + 4 }} className={cn("minimi-tip pointer-events-none absolute right-0 rounded-xl bg-card px-3 py-2 text-[13.5px] leading-snug whitespace-nowrap text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_22px_rgb(0_0_0/0.10)] ring-1 ring-border", tipBelow ? "top-[calc(100%+6px)]" : "rounded-br-sm")}>
        Hm?
        <br />
        <b className="font-semibold">Ask me</b> <kbd className="ml-1 rounded-[5px] bg-muted px-1.5 py-px text-muted-foreground">{shortcut}</kbd>
        <span className="mt-0.5 block text-[11.5px] text-muted-foreground/70">or drag me</span>
      </div>
      <button type="button" onClick={() => !resizing && onOpen()} aria-label={`Ask ${name} · ${shortcut}`} aria-expanded={talking} data-agent-launcher data-agent-body={body ? profile!.id : "minimi"} className="minimi-btn relative block size-full rounded-2xl outline-ring focus-visible:outline-2">
        {body && profile?.clips && clips ? (
          <ProfileClips clips={profile.clips} poster={body} attention={hover || !!drag || talking || !!menu || resizing} />
        ) : body ? (
          <EtudeImg src={mediaUrl(body)} alt="" draggable={false} className="minimi-fr minimi-body" />
        ) : holiday && clips ? (
          <MinimiClips attention={hover || !!drag || talking || !!menu || resizing} />
        ) : (
          <>
            <img src={art(read)} alt="" draggable={false} className={cn("minimi-fr", !page && "on")} />
            <img src={art(down)} alt="" draggable={false} className={cn("minimi-fr", page && "on")} />
            <img src={art(look)} alt="" draggable={false} className="minimi-fr minimi-look" />
          </>
        )}
      </button>
      {resizing && (
        <>
          <span aria-hidden className="minimi-frame pointer-events-none absolute inset-0 rounded-xl" />
          <span role="slider" aria-label={`${name}'s size`} aria-valuemin={MIN_S * 100} aria-valuemax={MAX_S * 100} aria-valuenow={Math.round(size * 100)} tabIndex={-1} onPointerDown={onGripDown} className="minimi-grip absolute" />
          <span className="minimi-size pointer-events-none absolute left-1/2 rounded-full bg-popover px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap text-popover-foreground tabular-nums shadow-sm ring-1 ring-border">{Math.round(size * 100)}%</span>
        </>
      )}
      {!body && faces.node}
      {menu && (
        <PointMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Resize", onSelect: () => setResizing(true) },
            ...(Math.abs(size - 1) > 0.005 ? [{ label: "Original size", onSelect: () => (resizeTo(1), saveSize(1), stopResize()) }] : []),
            "sep" as const,
            { label: `Hide ${name}`, onSelect: hide },
          ]}
        />
      )}
    </div>
  );
}
