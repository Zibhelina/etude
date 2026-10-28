// Phone scratchpad: ink drawn over the card, with pinch zoom. Strokes live in "unzoomed viewport" coordinates,
// so the same ink follows the card when it is zoomed and stays put after the zoom resets.
import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Pencil, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Pt = { x: number; y: number };
type Stroke = { pts: Pt[]; w: number };
export type View = { s: number; x: number; y: number };
const ID: View = { s: 1, x: 0, y: 0 };
const INK = "#ff9dc6";

export function useSketch(resetKey: unknown) {
  const [on, setOn] = useState(false);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [past, setPast] = useState<Stroke[][]>([]);
  const [view, setView] = useState<View>(ID);
  useEffect(() => { setStrokes([]); setPast([]); setView(ID); setOn(false); }, [resetKey]);
  const commit = useCallback((next: Stroke[]) => { setPast((p) => [...p.slice(-50), strokes]); setStrokes(next); }, [strokes]);
  const undo = useCallback(() => setPast((p) => { if (!p.length) return p; setStrokes(p[p.length - 1]); return p.slice(0, -1); }), []);
  const exit = useCallback(() => { setOn(false); setView(ID); }, []);
  return { on, setOn, tool, setTool, strokes, setStrokes, commit, undo, canUndo: past.length > 0, view, setView, exit };
}
export type Sketch = ReturnType<typeof useSketch>;

/** Transform for the content under the ink (origin = viewport top-left). */
export function sketchTransform(view: View, el: HTMLElement | null): React.CSSProperties {
  if (view.s === 1 && !view.x && !view.y) return {};
  // Untransformed position (getBoundingClientRect would include the zoom we're about to apply).
  const left = (el?.offsetLeft ?? 0) - window.scrollX, top = (el?.offsetTop ?? 0) - window.scrollY;
  // translate(x,y) scale(s) about the viewport origin, expressed for an element that starts at left/top.
  return { transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: `${-left}px ${-top}px` };
}

export function SketchLayer({ sk }: { sk: Sketch }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const live = useRef<Stroke | null>(null);
  const ptrs = useRef(new Map<number, Pt>());
  const pinch = useRef<{ d: number; c: Pt; v: View } | null>(null);
  const [badge, setBadge] = useState(false);
  const badgeT = useRef<number>(0);

  const draw = useCallback(() => {
    const c = cv.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
    const { s, x, y } = sk.view;
    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
    g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = INK;
    for (const st of live.current ? [...sk.strokes, live.current] : sk.strokes) {
      g.lineWidth = st.w; g.beginPath();
      st.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      if (st.pts.length === 1) g.lineTo(st.pts[0].x + 0.01, st.pts[0].y);
      g.stroke();
    }
  }, [sk.strokes, sk.view]);
  useEffect(() => { draw(); }, [draw]);
  useEffect(() => { const r = () => draw(); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, [draw]);
  // No page scroll while drawing; the card would slide under the ink.
  useEffect(() => {
    if (!sk.on) return;
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [sk.on]);

  const toContent = (p: Pt): Pt => ({ x: (p.x - sk.view.x) / sk.view.s, y: (p.y - sk.view.y) / sk.view.s });
  const eraseAt = (p: Pt) => {
    const r = 14 / sk.view.s;
    const keep = sk.strokes.filter((st) => !st.pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r));
    if (keep.length !== sk.strokes.length) sk.commit(keep);
  };
  const showBadge = () => { setBadge(true); clearTimeout(badgeT.current); badgeT.current = window.setTimeout(() => setBadge(false), 1000); };

  const down = (e: React.PointerEvent) => {
    e.preventDefault(); (e.target as Element).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      live.current = null; draw(); // a second finger turns the stroke into a pinch
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v: sk.view };
      return;
    }
    if (ptrs.current.size > 2) return;
    const p = toContent({ x: e.clientX, y: e.clientY });
    if (sk.tool === "eraser") eraseAt(p);
    else { live.current = { pts: [p], w: 3 / Math.max(1, sk.view.s * 0.8) }; draw(); }
  };
  const move = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const p0 = pinch.current, s = Math.min(4, Math.max(1, p0.v.s * (d / p0.d)));
      // keep the content point under the starting centre under the current centre
      const cx = (p0.c.x - p0.v.x) / p0.v.s, cy = (p0.c.y - p0.v.y) / p0.v.s;
      let x = c.x - cx * s, y = c.y - cy * s;
      const W = window.innerWidth, H = window.innerHeight;
      x = Math.min(0, Math.max(W - W * s, x)); y = Math.min(0, Math.max(H - H * s, y));
      sk.setView(s === 1 ? ID : { s, x, y }); showBadge();
      return;
    }
    const p = toContent({ x: e.clientX, y: e.clientY });
    if (sk.tool === "eraser") return eraseAt(p);
    if (live.current) {
      const last = live.current.pts[live.current.pts.length - 1];
      if (Math.hypot(last.x - p.x, last.y - p.y) > 0.6 / sk.view.s) { live.current.pts.push(p); draw(); }
    }
  };
  const up = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
    if (ptrs.current.size === 0 && live.current) { const st = live.current; live.current = null; sk.commit([...sk.strokes, st]); }
  };

  return (
    <>
      <canvas
        ref={cv}
        aria-hidden={!sk.on}
        className={cn("fixed inset-0 z-[15] h-dvh w-screen", sk.on ? "touch-none" : "pointer-events-none")}
        style={{ width: "100vw", height: "100dvh" }}
        onPointerDown={sk.on ? down : undefined}
        onPointerMove={sk.on ? move : undefined}
        onPointerUp={sk.on ? up : undefined}
        onPointerCancel={sk.on ? up : undefined}
      />
      {sk.on && (
        <div className={cn("pointer-events-none fixed right-5 z-[16] rounded-full border border-highlight bg-card/90 px-3 py-1 text-xs font-semibold text-highlight transition-opacity duration-300", badge && sk.view.s > 1 ? "opacity-100" : "opacity-0")} style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}>
          {sk.view.s.toFixed(1)}×
        </div>
      )}
    </>
  );
}

/** Footer while sketching: × on the left, the tools pill where Check was. */
export function SketchBar({ sk }: { sk: Sketch }) {
  const tb = (active: boolean) => cn("flex h-[2.6rem] items-center justify-center gap-2 rounded-full text-[14px] font-semibold transition-all", active ? "bg-highlight px-4 text-black" : "min-w-[2.6rem] flex-1 text-muted-foreground active:bg-accent");
  return (
    <>
      <button onClick={sk.exit} aria-label="Sair do rascunho" className="flex size-[3.25rem] shrink-0 items-center justify-center rounded-full border bg-card text-foreground active:bg-accent"><X className="size-5" /></button>
      <div className="flex h-[3.25rem] flex-1 items-center justify-between rounded-full border bg-card px-1">
        <button className={tb(sk.tool === "pen")} onClick={() => sk.setTool("pen")} aria-label="Caneta"><Pencil className="size-5" />{sk.tool === "pen" && "Caneta"}</button>
        <button className={tb(sk.tool === "eraser")} onClick={() => sk.setTool("eraser")} aria-label="Borracha"><Eraser className="size-5" />{sk.tool === "eraser" && "Borracha"}</button>
        <button className={tb(false)} onClick={sk.undo} disabled={!sk.canUndo} aria-label="Desfazer traço"><Undo2 className={cn("size-5", !sk.canUndo && "opacity-40")} /></button>
      </div>
    </>
  );
}
