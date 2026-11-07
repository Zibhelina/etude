// Holding Minimi (the phone's Ask circle, the corner Minimi on desktop) fans his faces out around him, in
// three arcs pointing toward the middle of the screen. Keep the finger down and slide onto one, then let go to
// wear it; or let go first and tap a face. A quick tap still opens Ask. Settings → Appearance opens the same fan.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { FACE_NAMES, FACES, faceSrc, setMinimiFace, useMinimiFaceId, type FaceId } from "@/lib/minimi-face";
import { cn } from "@/lib/utils";

const HOLD_MS = 420;
const FACE = 44;
const RINGS: [number, number][] = [[100, 3], [160, 4], [220, 5]];
const SPAN = (65 * Math.PI) / 180;
const EDGE = 10;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Anchor = { x: number; y: number; r: number };
type State = null | { a: Anchor; phase: "press" | "open"; held: boolean };

/** Where each face sits: arcs around the anchor, opening toward the middle of the window, kept on screen. */
function layout(a: Anchor): [number, number][] {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const mid = Math.atan2(vh / 2 - a.y, vw / 2 - a.x);
  const at = (m: number) => {
    const out: [number, number][] = [];
    for (const [r, n] of RINGS)
      for (let j = 0; j < n; j++) {
        const t = m - SPAN / 2 + (SPAN * j) / (n - 1);
        out.push([a.x + Math.cos(t) * r, a.y + Math.sin(t) * r]);
      }
    return out;
  };
  const fits = (p: [number, number][]) => p.every(([x, y]) => x >= EDGE + FACE / 2 && x <= vw - EDGE - FACE / 2 && y >= EDGE + FACE / 2 && y <= vh - EDGE - FACE / 2);
  // Turn the fan away from an edge rather than squeezing faces against it (squeezed faces overlap).
  for (let d = 0; d <= 90; d += 3)
    for (const s of d ? [1, -1] : [1]) {
      const p = at(mid + (s * d * Math.PI) / 180);
      if (fits(p)) return p;
    }
  // Nowhere fits (a tiny window): keep them on screen.
  return at(mid).map(([x, y]) => [Math.min(vw - EDGE - FACE / 2, Math.max(EDGE + FACE / 2, x)), Math.min(vh - EDGE - FACE / 2, Math.max(EDGE + FACE / 2, y))]);
}

const anchorOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.min(r.width, r.height) / 2 };
};

/** The click that ends a hold isn't a tap on what was held. */
function swallowNextClick() {
  const kill = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  addEventListener("click", kill, { capture: true, once: true });
  setTimeout(() => removeEventListener("click", kill, { capture: true }), 80);
}

/**
 * Hold-to-pick for one element. Spread `onPointerDown` (and `onContextMenu`) on what you hold; render `node`.
 * `openAt(el)` opens the fan around an element without a hold (keyboard, Settings).
 */
export function useMinimiFaces() {
  const [st, setSt] = useState<State>(null);
  const [hot, setHot] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = useRef<State>(null);
  live.current = st;
  const pos = st?.phase === "open" ? layout(st.a) : [];
  const posRef = useRef(pos);
  posRef.current = pos;

  const close = () => {
    clearTimeout(timer.current);
    setSt(null);
    setHot(null);
  };
  const pick = (i: number) => {
    const id = FACES[i];
    close();
    setMinimiFace(id)?.catch((e: Error) => toast.error("Couldn't save his face", { description: e.message }));
  };
  const hit = (x: number, y: number) => {
    let best: number | null = null, bd = FACE * 0.8;
    posRef.current.forEach(([fx, fy], i) => {
      const d = Math.hypot(fx - x, fy - y);
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button > 0 || live.current) return;
    const a = anchorOf(e.currentTarget);
    const sx = e.clientX, sy = e.clientY;
    setSt({ a, phase: "press", held: true });
    timer.current = setTimeout(() => {
      navigator.vibrate?.(12);
      setSt({ a, phase: "open", held: true });
    }, HOLD_MS);
    const move = (ev: PointerEvent) => {
      const s = live.current;
      if (s?.phase === "press" && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
        // It's a drag (the corner Minimi moves), not a hold.
        cleanup();
        close();
      } else if (s?.phase === "open" && s.held) setHot(hit(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      cleanup();
      const s = live.current;
      if (!s) return;
      if (s.phase === "press") {
        clearTimeout(timer.current);
        setSt(null);
        return;
      }
      swallowNextClick();
      const i = hit(ev.clientX, ev.clientY);
      if (i !== null) pick(i);
      else setSt({ ...s, held: false });
    };
    const cleanup = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  useEffect(() => {
    if (st?.phase !== "open") return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [st?.phase]);

  const openAt = (el: Element) => setSt({ a: anchorOf(el), phase: "open", held: false });
  const node = st ? createPortal(<Fan st={st} pos={pos} hot={hot} onPick={pick} onClose={close} />, document.body) : null;
  return { onPointerDown, onContextMenu: (e: React.MouseEvent) => e.preventDefault(), openAt, node, open: st?.phase === "open" };
}

function Fan({ st, pos, hot, onPick, onClose }: { st: NonNullable<State>; pos: [number, number][]; hot: number | null; onPick(i: number): void; onClose(): void }) {
  const cur = useMinimiFaceId();
  const [out, setOut] = useState(false);
  const open = st.phase === "open";
  useLayoutEffect(() => {
    if (!open) return setOut(false);
    const f = requestAnimationFrame(() => setOut(true));
    return () => cancelAnimationFrame(f);
  }, [open]);
  const { a } = st;
  const still = reduced();
  return (
    <div data-minimi-faces className="minimi-faces">
      {/* backdrop-filter set inline: the CSS minifier keeps only the -webkit- copy, which Chrome ignores. */}
      {open && <div className={cn("mf-scrim", out && "on")} onClick={onClose} aria-hidden style={out ? { backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)" } : undefined} />}
      {/* The hold ring: only while pressing, gone once the fan is out (so no stray dot is left on him). */}
      {st.phase === "press" && !still && (
        <svg className="mf-hold" style={{ left: a.x - a.r - 5, top: a.y - a.r - 5, width: a.r * 2 + 10, height: a.r * 2 + 10 }} viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="47" pathLength={100} style={{ animationDuration: `${HOLD_MS}ms` }} />
        </svg>
      )}
      {open && (
        <>
          <img src={faceSrc(cur)} alt="" draggable={false} className="mf-me" style={{ left: a.x - a.r, top: a.y - a.r, width: a.r * 2, height: a.r * 2 }} />
          <div role="listbox" aria-label="Minimi's face" className="contents">
            {FACES.map((id: FaceId, i) => {
              const [x, y] = pos[i];
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={id === cur}
                  aria-label={FACE_NAMES[id]}
                  autoFocus={id === cur && !st.held}
                  onClick={() => onPick(i)}
                  className={cn("mf-face", id === cur && "is-on", hot === i && "is-hot")}
                  style={{
                    left: x - FACE / 2,
                    top: y - FACE / 2,
                    transform: out || still ? "none" : `translate(${a.x - x}px, ${a.y - y}px) scale(.3)`,
                    opacity: out || still ? 1 : 0,
                    transitionDelay: still ? "0ms" : `${i * 14}ms`,
                  }}
                >
                  <img src={faceSrc(id)} alt="" draggable={false} />
                </button>
              );
            })}
          </div>
          {hot !== null && (
            <div className="mf-cap" style={{ left: pos[hot][0], top: pos[hot][1] - FACE / 2 - 34 }}>{FACE_NAMES[FACES[hot]]}</div>
          )}
        </>
      )}
    </div>
  );
}
