// Notes as a graph, like Obsidian's: every page is a point, every [[link]] a line. Opens over the app from the
// Notes right-click menu (or the "etude:note-graph" event). Points settle with a small force simulation; drag a
// point to pull it, drag the background to pan, scroll to zoom, hover to light up a page's neighbours, click to open it.
// The gear opens settings (arrows, colours by folder or #tag, names, forces); ▶ replays the graph growing page by
// page in the order you made them.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Search, Settings2, X } from "lucide-react";
import { api, type NoteGraph } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

export const NOTE_GRAPH_EVENT = "etude:note-graph";
export const openNoteGraph = () => window.dispatchEvent(new Event(NOTE_GRAPH_EVENT));

type GNode = NoteGraph["nodes"][number];
interface P {
  id: string;
  kind: GNode["kind"];
  title: string;
  links: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
  /** Its place in the order pages were made (a ghost arrives with the first page that links to it). */
  order: number;
  group: string | null;
  /** 0 → 1 as it pops in during the timelapse. */
  born: number;
}
interface L {
  a: P;
  b: P;
  kind: "link" | "parent";
}

type ColorBy = "none" | "folder" | "tag";
type Labels = "auto" | "always" | "never";
interface GraphSettings {
  arrows: boolean;
  tree: boolean;
  ghosts: boolean;
  colorBy: ColorBy;
  labels: Labels;
  /** Multipliers around 1. */
  size: number;
  repel: number;
  length: number;
  /** Colours you picked for a group, by its name. */
  colors: Record<string, string>;
}
const DEFAULTS: GraphSettings = { arrows: false, tree: false, ghosts: true, colorBy: "none", labels: "auto", size: 1, repel: 1, length: 1, colors: {} };
const SETTINGS_KEY = "etude.notes.graph";
const loadSettings = (): GraphSettings => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
};

/** Group colours, picked to stay apart on light and dark backgrounds. */
const PALETTE = ["#e5484d", "#f76b15", "#e2b203", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8d6e63", "#5b8def"];

/** Which group a page belongs to: its top folder (the page or folder at the top of its tree) or its first #tag. */
function groupsOf(nodes: GNode[], by: ColorBy): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (by === "none") return out;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasKids = new Set(nodes.map((n) => n.parentId).filter(Boolean) as string[]);
  for (const n of nodes) {
    if (n.kind === "ghost") {
      out.set(n.id, null);
      continue;
    }
    if (by === "tag") {
      out.set(n.id, n.tags[0] ? `#${n.tags[0]}` : null);
      continue;
    }
    let top = n;
    for (let i = 0; top.parentId && i < 64; i++) top = byId.get(top.parentId) ?? top;
    // A lone page at the top with nothing under it isn't in any folder.
    out.set(n.id, top === n && !hasKids.has(n.id) && n.kind !== "folder" ? null : top.title || "Untitled");
  }
  return out;
}

export function NoteGraphHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(NOTE_GRAPH_EVENT, on);
    return () => window.removeEventListener(NOTE_GRAPH_EVENT, on);
  }, []);
  return open ? createPortal(<NoteGraphView onClose={() => setOpen(false)} />, document.body) : null;
}

function NoteGraphView({ onClose }: { onClose(): void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<NoteGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [st, setSt] = useState<GraphSettings>(loadSettings);
  const [panel, setPanel] = useState(false);
  const [q, setQ] = useState("");
  const [closing, setClosing] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const m = matchMedia("(max-width: 639px)");
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  // Timelapse: how many pages (in the order they were made) are on screen; null = all of them.
  const [shown, setShown] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const current = new URLSearchParams(location.search).get("id");
  const set = (patch: Partial<GraphSettings>) => setSt((s) => ({ ...s, ...patch }));
  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(st)), [st]);

  // The order pages arrived in, and the date of each step for the timelapse label.
  const timeline = useMemo(() => {
    if (!data) return { order: new Map<string, number>(), dates: [] as string[] };
    const pages = data.nodes.filter((n) => n.kind !== "ghost").sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
    const order = new Map(pages.map((p, i) => [p.id, i]));
    for (const l of data.links) if (l.to.startsWith("ghost:")) order.set(l.to, Math.min(order.get(l.to) ?? Infinity, order.get(l.from) ?? 0));
    return { order, dates: pages.map((p) => p.created ?? "") };
  }, [data]);
  const total = timeline.dates.length;

  const groups = useMemo(() => (data ? groupsOf(data.nodes, st.colorBy) : new Map<string, string | null>()), [data, st.colorBy]);
  const legend = useMemo(() => {
    const count = new Map<string, number>();
    for (const g of groups.values()) if (g) count.set(g, (count.get(g) ?? 0) + 1);
    const names = [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || a.localeCompare(b));
    return names.map((name, i) => ({ name, n: count.get(name)!, color: st.colors[name] ?? PALETTE[i % PALETTE.length] }));
  }, [groups, st.colors]);

  // What the draw loop reads without re-running the effect.
  const live = useRef({ q: "", st, shown, groups, legend, sheet: false });
  // On a phone the settings sheet covers the bottom; the graph fits into what's left above it.
  live.current = { q: q.trim().toLowerCase(), st, shown, groups, legend, sheet: panel && narrow };
  const kick = useRef<() => void>(() => {});

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 140);
  };

  useEffect(() => {
    api.noteGraph().then(setData, (e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (live.current.q) setQ("");
      else close();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The timelapse clock: a page every ~0.35 s (faster for big collections), the whole thing in at most ~20 s.
  useEffect(() => {
    if (!playing || !total) return;
    const step = Math.max(60, Math.min(350, 20000 / total));
    const t = setInterval(() => {
      setShown((s) => {
        const next = (s ?? 0) + 1;
        if (next >= total) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, step);
    return () => clearInterval(t);
  }, [playing, total]);
  const play = () => {
    if (playing) return setPlaying(false);
    if (shown === null || shown >= total) setShown(0);
    setPlaying(true);
  };

  // Changing a force, a filter or the timelapse step wakes the simulation up.
  useEffect(() => kick.current(), [st.repel, st.length, st.tree, st.ghosts, shown]);

  useEffect(() => {
    const cv = canvas.current;
    const box = wrap.current;
    if (!data || !cv || !box) return;
    const ctx = cv.getContext("2d")!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- the model
    const n = data.nodes.length;
    const spread = 40 * Math.sqrt(n + 1);
    const pts = new Map<string, P>();
    data.nodes.forEach((d, i) => {
      // A sunflower spiral to start from, so the first frames already look like a cloud.
      const a = i * 2.39996;
      const rad = spread * Math.sqrt((i + 0.5) / Math.max(1, n));
      pts.set(d.id, { id: d.id, kind: d.kind, title: d.title || "Untitled", links: d.links, r: 4 + Math.min(10, Math.sqrt(d.links) * 2.2), x: Math.cos(a) * rad, y: Math.sin(a) * rad, vx: 0, vy: 0, fixed: false, order: timeline.order.get(d.id) ?? 0, group: null, born: 1 });
    });
    const all = [...pts.values()];
    const lines: L[] = data.links.flatMap((l) => {
      const a = pts.get(l.from), b = pts.get(l.to);
      return a && b ? [{ a, b, kind: l.kind }] : [];
    });
    const nbrs = new Map<string, Set<string>>();
    const linked = new Map<string, P[]>();
    for (const l of lines) {
      if (l.kind === "link") {
        (nbrs.get(l.a.id) ?? nbrs.set(l.a.id, new Set()).get(l.a.id)!).add(l.b.id);
        (nbrs.get(l.b.id) ?? nbrs.set(l.b.id, new Set()).get(l.b.id)!).add(l.a.id);
      }
      (linked.get(l.a.id) ?? linked.set(l.a.id, []).get(l.a.id)!).push(l.b);
      (linked.get(l.b.id) ?? linked.set(l.b.id, []).get(l.b.id)!).push(l.a);
    }
    const arrived = new Set<string>();
    const inTime = (p: P) => live.current.shown === null || p.order < live.current.shown;
    const visible = (p: P) => (live.current.st.ghosts || p.kind !== "ghost") && inTime(p);
    const active = (l: L) => (l.kind === "parent" ? live.current.st.tree : true) && visible(l.a) && visible(l.b);

    // ---- the camera
    let W = 0, H = 0, dpr = 1;
    const cam = { x: 0, y: 0, k: 1 };
    const fit = () => {
      const r = box.getBoundingClientRect();
      W = r.width;
      H = r.height;
      dpr = Math.min(2, devicePixelRatio || 1);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
    };
    fit();
    cam.k = Math.max(0.35, Math.min(1.6, Math.min(W, H) / (spread * 2.6 + 80)));
    const ro = new ResizeObserver(() => fit());
    ro.observe(box);
    const toWorld = (sx: number, sy: number) => ({ x: (sx - W / 2) / cam.k + cam.x, y: (sy - H / 2) / cam.k + cam.y });

    // ---- the physics: links pull, every point pushes the others away, a soft pull keeps the cloud centred.
    let alpha = 1;
    let touched = false; // once you pan or zoom, the camera stops following the cloud
    kick.current = () => {
      alpha = Math.max(alpha, 0.5);
    };
    const autoFit = (ease: number) => {
      const vis = all.filter(visible);
      if (!vis.length || !W) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of vis) {
        x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r);
        y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r + 18);
      }
      const hidden = live.current.sheet ? Math.min(H * 0.62, 480) : 0;
      const k = Math.max(0.2, Math.min(2.2, Math.min((W - 120) / Math.max(1, x1 - x0), (H - hidden - 100) / Math.max(1, y1 - y0))));
      cam.k += (k - cam.k) * ease;
      cam.x += ((x0 + x1) / 2 - cam.x) * ease;
      cam.y += ((y0 + y1) / 2 + hidden / 2 / cam.k - cam.y) * ease;
    };
    const tick = () => {
      const { repel, length } = live.current.st;
      const vis = all.filter(visible);
      // A page that just arrived in the timelapse starts beside one it links to, so it grows out of the graph.
      for (const p of vis) {
        if (arrived.has(p.id)) continue;
        arrived.add(p.id);
        if (live.current.shown === null) continue;
        const near = (linked.get(p.id) ?? []).find((o) => o !== p && arrived.has(o.id) && visible(o));
        const a = Math.random() * Math.PI * 2;
        p.x = (near ? near.x : cam.x) + Math.cos(a) * 30;
        p.y = (near ? near.y : cam.y) + Math.sin(a) * 30;
        p.vx = p.vy = 0;
        p.born = 0;
      }
      for (const p of all) if (!visible(p)) arrived.delete(p.id);
      for (let i = 0; i < vis.length; i++) {
        const a = vis[i];
        for (let j = i + 1; j < vis.length; j++) {
          const b = vis[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.25;
          }
          if (d2 > 250000) continue;
          const f = (2600 * repel * alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }
      for (const l of lines) {
        if (!active(l)) continue;
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = (l.kind === "parent" ? 70 : 110) * length;
        const k = (l.kind === "parent" ? 0.03 : 0.05) * alpha;
        const f = (d - rest) * k;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        l.a.vx += fx; l.a.vy += fy;
        l.b.vx -= fx; l.b.vy -= fy;
      }
      for (const p of vis) {
        p.vx -= p.x * 0.008 * alpha;
        p.vy -= p.y * 0.008 * alpha;
        if (p.fixed) {
          p.vx = p.vy = 0;
          continue;
        }
        p.vx *= 0.82;
        p.vy *= 0.82;
        p.x += Math.max(-30, Math.min(30, p.vx));
        p.y += Math.max(-30, Math.min(30, p.vy));
      }
      alpha = Math.max(0.02, alpha * 0.985);
    };
    if (reduce) {
      for (let i = 0; i < 300; i++) tick();
      autoFit(1);
    }

    // ---- colours from the theme, resolved to plain rgb (canvas can't read var() or every colour syntax)
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const el = document.createElement("span");
    el.style.display = "none";
    document.body.appendChild(el);
    const rgb = (expr: string, fb: string) => {
      el.style.color = fb;
      el.style.color = expr;
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = fb;
      probe.fillStyle = getComputedStyle(el).color;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      return `rgb(${r} ${g} ${b})`;
    };
    const C = {
      fg: rgb("var(--foreground)", "#222"),
      muted: rgb("var(--muted-foreground)", "#888"),
      accent: rgb("var(--primary)", "#2f9a41"),
      bg: rgb("var(--background)", "#fff"),
      edge: rgb("color-mix(in oklab, var(--muted-foreground) 78%, var(--background))", "#bbb"),
      page: rgb("color-mix(in oklab, var(--foreground) 62%, var(--background))", "#777"),
      folder: rgb("color-mix(in oklab, var(--muted-foreground) 70%, var(--background))", "#999"),
    };
    el.remove();

    // ---- interaction
    let hover: P | null = null;
    let drag: { p: P | null; sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
    const pick = (sx: number, sy: number) => {
      const w = toWorld(sx, sy);
      let best: P | null = null, bd = Infinity;
      for (const p of all) {
        if (!visible(p)) continue;
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        const reach = p.r * live.current.st.size + 6 / cam.k;
        if (d < reach && d < bd) {
          best = p;
          bd = d;
        }
      }
      return best;
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { sx, sy } = local(e);
      const p = pick(sx, sy);
      if (!p) touched = true;
      cv.setPointerCapture(e.pointerId);
      drag = { p, sx, sy, cx: cam.x, cy: cam.y, moved: false };
      if (p) {
        p.fixed = true;
        alpha = Math.max(alpha, 0.3);
      }
    };
    const move = (e: PointerEvent) => {
      const { sx, sy } = local(e);
      if (!drag) {
        const p = pick(sx, sy);
        if (p !== hover) {
          hover = p;
          cv.style.cursor = p ? (p.kind === "ghost" ? "default" : "pointer") : "grab";
        }
        return;
      }
      if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
      if (drag.p) {
        const w = toWorld(sx, sy);
        drag.p.x = w.x;
        drag.p.y = w.y;
        alpha = Math.max(alpha, 0.3);
      } else {
        cam.x = drag.cx - (sx - drag.sx) / cam.k;
        cam.y = drag.cy - (sy - drag.sy) / cam.k;
        cv.style.cursor = "grabbing";
      }
    };
    const up = () => {
      if (!drag) return;
      const { p, moved } = drag;
      drag = null;
      cv.style.cursor = hover ? "pointer" : "grab";
      if (p) {
        p.fixed = false;
        if (!moved && p.kind !== "ghost") {
          navigate(`/notes?id=${encodeURIComponent(p.id)}`);
          close();
        }
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      touched = true;
      const { sx, sy } = local(e);
      const before = toWorld(sx, sy);
      cam.k = Math.max(0.15, Math.min(4, cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      const after = toWorld(sx, sy);
      cam.x += before.x - after.x;
      cam.y += before.y - after.y;
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", () => {
      if (!drag) hover = null;
    });
    cv.addEventListener("wheel", wheel, { passive: false });
    cv.style.cursor = "grab";

    // ---- drawing
    let glow = 0; // eases the hover highlight in and out
    let focus: P | null = null;
    let raf = 0;
    const arrow = (l: L, rb: number) => {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const d = Math.hypot(dx, dy);
      if (d < rb + 6) return;
      const ux = dx / d, uy = dy / d;
      const tipX = l.b.x - ux * (rb + 1.5), tipY = l.b.y - uy * (rb + 1.5);
      const s = 8.5 / Math.sqrt(cam.k);
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * s - uy * s * 0.55, tipY - uy * s + ux * s * 0.55);
      ctx.lineTo(tipX - ux * s + uy * s * 0.55, tipY - uy * s - ux * s * 0.55);
      ctx.closePath();
      ctx.fill();
    };
    const frame = () => {
      const { st, q, groups: grp, legend: leg } = live.current;
      const colorOf = new Map(leg.map((g) => [g.name, g.color]));
      if (!reduce || alpha > 0.03) tick();
      if (!touched && !drag) autoFit(0.08);
      for (const p of all) {
        p.group = grp.get(p.id) ?? null;
        if (p.born < 1) p.born = reduce ? 1 : Math.min(1, p.born + 0.07);
      }
      const target = hover ?? (drag?.p ?? null);
      if (target) focus = target;
      glow += ((target ? 1 : 0) - glow) * 0.2;
      if (glow < 0.01) focus = null;
      const hit = (p: P) => !q || p.title.toLowerCase().includes(q);
      const near = focus ? nbrs.get(focus.id) ?? new Set<string>() : null;
      const lit = (p: P) => !focus || p === focus || near!.has(p.id);
      const radius = (p: P) => {
        // A little overshoot as it arrives, then it settles.
        const b = p.born;
        const pop = b < 1 ? Math.sin(b * Math.PI * 0.5) * (1 + 0.35 * Math.sin(b * Math.PI)) : 1;
        return p.r * st.size * pop * (p === focus ? 1 + 0.15 * glow : 1);
      };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.k, cam.k);
      ctx.translate(-cam.x, -cam.y);

      ctx.lineCap = "round";
      for (const l of lines) {
        if (!active(l)) continue;
        const on = focus && (l.a === focus || l.b === focus) && l.kind === "link";
        const born = Math.min(l.a.born, l.b.born);
        ctx.globalAlpha = born * (on ? 0.35 + 0.65 * glow : (focus ? 1 - 0.75 * glow : 1) * (q && !(hit(l.a) && hit(l.b)) ? 0.25 : 1) * (l.kind === "parent" ? 0.5 : 0.9));
        ctx.strokeStyle = on ? C.accent : C.edge;
        ctx.fillStyle = on ? C.accent : C.edge;
        ctx.lineWidth = (on ? 1.8 : 1.2) / Math.sqrt(cam.k);
        if (l.kind === "parent") ctx.setLineDash([3 / cam.k, 4 / cam.k]);
        ctx.beginPath();
        ctx.moveTo(l.a.x, l.a.y);
        ctx.lineTo(l.b.x, l.b.y);
        ctx.stroke();
        if (l.kind === "parent") ctx.setLineDash([]);
        else if (st.arrows) arrow(l, radius(l.b));
      }

      for (const p of all) {
        if (!visible(p)) continue;
        const dim = (focus && !lit(p) ? 1 - 0.8 * glow : 1) * (q && !hit(p) ? 0.2 : 1);
        ctx.globalAlpha = dim;
        const isCur = p.id === current;
        const isFocus = p === focus;
        const rr = radius(p);
        if (rr <= 0.1) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        const gc = p.group ? colorOf.get(p.group) : undefined;
        if (p.kind === "ghost") {
          ctx.fillStyle = C.bg;
          ctx.fill();
          ctx.setLineDash([2, 2]);
          ctx.strokeStyle = C.muted;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = gc ?? (isFocus || (q && hit(p)) || isCur ? C.accent : p.kind === "folder" ? C.folder : C.page);
          ctx.fill();
          if (gc && (isFocus || (q && hit(p)))) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = C.fg;
            ctx.stroke();
          }
        }
        if (isCur) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr + 4, 0, Math.PI * 2);
          ctx.strokeStyle = C.accent;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Names: for the hovered page and its neighbours, and for everything once you've zoomed in (or always / never).
      if (st.labels !== "never") {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const fs = 12 / cam.k;
        ctx.font = `500 ${fs}px Inter, ui-sans-serif, system-ui, sans-serif`;
        for (const p of all) {
          if (!visible(p)) continue;
          const named = (focus && lit(p)) || (q && hit(p)) || p.id === current;
          const base = st.labels === "always" ? 1 : Math.max(0, Math.min(1, (cam.k - 0.7) / 0.5));
          let a = named ? Math.max(base, glow, q || p.id === current ? 1 : 0) : base * (focus ? 1 - 0.85 * glow : 1);
          if (q && !hit(p)) a *= 0.25;
          a *= p.born;
          if (a < 0.03) continue;
          ctx.globalAlpha = a;
          const t = p.title.length > 34 ? p.title.slice(0, 33) + "…" : p.title;
          const ty = p.y + radius(p) + 4 / cam.k;
          ctx.lineJoin = "round";
          ctx.lineWidth = 4 / cam.k;
          ctx.strokeStyle = C.bg;
          ctx.strokeText(t, p.x, ty);
          ctx.fillStyle = p === focus ? C.fg : C.muted;
          ctx.fillText(t, p.x, ty);
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const pages = data?.nodes.filter((d) => d.kind !== "ghost").length ?? 0;
  const linkCount = data?.links.filter((l) => l.kind === "link").length ?? 0;
  const hasGhosts = !!data?.nodes.some((d) => d.kind === "ghost");
  const lapse = shown !== null;
  const lapseDate = lapse && shown! > 0 ? new Date(timeline.dates[shown! - 1]).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;

  return (
    <div className="note-graph fixed inset-0 z-[80] flex items-stretch justify-center" data-closing={closing || undefined} role="dialog" aria-modal aria-label="Graph of your notes">
      <div className="note-graph-veil" onClick={close} />
      <div className="note-graph-box relative m-3 flex min-h-0 w-full max-w-[1400px] flex-col overflow-hidden rounded-[18px] bg-background sm:m-8">
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
          <div className="shrink-0">
            <div className="text-[15px] font-[650]">Graph</div>
            <div className="text-[12px] text-muted-foreground">{data ? `${pages} page${pages === 1 ? "" : "s"} · ${linkCount} link${linkCount === 1 ? "" : "s"}` : err ? "Couldn't load" : "Loading…"}</div>
          </div>
          <label className="ml-auto flex h-9 min-w-0 flex-1 items-center sm:max-w-[260px] gap-2 rounded-full bg-muted/60 px-3 text-[13px] focus-within:ring-2 focus-within:ring-ring">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={narrow ? "Find" : "Find a page"} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
          </label>
          <button type="button" onClick={() => setPanel(!panel)} aria-label="Graph settings" aria-pressed={panel} className={cn("ng-gear grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", panel && "bg-muted text-foreground")}>
            <Settings2 className="size-4" />
          </button>
          <button type="button" onClick={close} aria-label="Close graph" className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div ref={wrap} className="relative min-h-0 flex-1">
          <canvas ref={canvas} className="absolute inset-0 touch-none" />
          {data && pages === 0 && <div className="absolute inset-0 grid place-items-center text-[14px] text-muted-foreground">No pages yet. Make one and link it with [[ to see it here.</div>}
          {err && <div className="absolute inset-0 grid place-items-center text-[14px] text-muted-foreground">{err}</div>}

          {/* Timelapse: ▶ grows the graph page by page in the order you made them; the slider scrubs. */}
          {total > 1 && !(panel && narrow) && (
            <div className="ng-lapse absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] items-center gap-2 rounded-full border border-border bg-background/80 py-1 pr-3 pl-1 backdrop-blur">
              <button type="button" onClick={play} aria-label={playing ? "Pause" : "Play how your notes grew"} className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-foreground transition-colors hover:bg-foreground/[0.12]">
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
              </button>
              <input
                type="range"
                min={0}
                max={total}
                value={shown ?? total}
                aria-label="Pages shown"
                onChange={(e) => {
                  setPlaying(false);
                  const v = Number(e.target.value);
                  setShown(v >= total ? null : v);
                }}
                className="ng-range w-[min(220px,30vw)]"
                style={{ "--ng-fill": `${((shown ?? total) / total) * 100}%` } as React.CSSProperties}
              />
              <span className="min-w-[7.5rem] text-[12px] whitespace-nowrap text-muted-foreground tabular-nums">{lapse ? `${shown} of ${total}${lapseDate ? ` · ${lapseDate}` : ""}` : "How it grew"}</span>
            </div>
          )}

          {st.colorBy !== "none" && legend.length > 0 && !panel && (
            <div className="pointer-events-none absolute top-2 left-4 flex max-w-[60%] flex-wrap gap-x-3 gap-y-1">
              {legend.slice(0, 12).map((g) => (
                <span key={g.name} className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span className="size-2.5 rounded-full" style={{ background: g.color }} />
                  {g.name}
                </span>
              ))}
              {legend.length > 12 && <span className="text-[12px] text-muted-foreground">+{legend.length - 12} more</span>}
              {[...groups.values()].some((g) => g === null) && (
                <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span className="size-2.5 rounded-full bg-muted-foreground/50" />
                  {st.colorBy === "tag" ? "No #tag" : "Not in a folder"}
                </span>
              )}
            </div>
          )}

          {!panel && <div className="pointer-events-none absolute right-4 bottom-4 hidden text-[11.5px] text-muted-foreground lg:block">Scroll to zoom · drag to move · click a page to open it</div>}

          {panel && (
            <aside className="ng-panel absolute inset-x-2 bottom-2 flex max-h-[62%] flex-col overflow-y-auto rounded-[16px] border border-border bg-background/95 p-4 backdrop-blur sm:inset-x-auto sm:top-2 sm:right-3 sm:bottom-auto sm:max-h-[calc(100%-20px)] sm:w-[300px]" aria-label="Graph settings">
              <Section title="Show">
                <Row label="Arrows" hint="Which way each link points">
                  <Switch on={st.arrows} onChange={(v) => set({ arrows: v })} label="Arrows" />
                </Row>
                <Row label="Page tree" hint="Dashed lines from a page to the pages inside it">
                  <Switch on={st.tree} onChange={(v) => set({ tree: v })} label="Page tree" />
                </Row>
                {hasGhosts && (
                  <Row label="Pages that don't exist yet" hint="Links to a page nobody made">
                    <Switch on={st.ghosts} onChange={(v) => set({ ghosts: v })} label="Pages that don't exist yet" />
                  </Row>
                )}
                <Row label="Names">
                  <Seg value={st.labels} onChange={(v) => set({ labels: v })} options={[["auto", "Zoom in"], ["always", "Always"], ["never", "Never"]]} />
                </Row>
              </Section>

              <Section title="Colours">
                <Seg value={st.colorBy} onChange={(v) => set({ colorBy: v })} options={[["none", "None"], ["folder", "By folder"], ["tag", "By #tag"]]} full />
                {st.colorBy !== "none" && (
                  <div className="mt-2 flex flex-col gap-0.5">
                    {legend.length === 0 && <p className="text-[12.5px] text-muted-foreground">{st.colorBy === "tag" ? "No #tags yet. Write #something in a page and it shows up here." : "Nothing is inside a folder yet."}</p>}
                    {legend.map((g) => (
                      <label key={g.name} className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-1 text-[13px] hover:bg-muted/60">
                        <span className="relative size-5 shrink-0 overflow-hidden rounded-full ring-1 ring-border" style={{ background: g.color }}>
                          <input type="color" value={g.color} onChange={(e) => set({ colors: { ...st.colors, [g.name]: e.target.value } })} aria-label={`Colour for ${g.name}`} className="absolute inset-0 cursor-pointer opacity-0" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{g.name}</span>
                        <span className="text-[12px] text-muted-foreground tabular-nums">{g.n}</span>
                      </label>
                    ))}
                    {legend.some((g) => st.colors[g.name]) && (
                      <button type="button" onClick={() => set({ colors: {} })} className="mt-1 self-start text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                        Reset colours
                      </button>
                    )}
                  </div>
                )}
              </Section>

              <Section title="Forces">
                <Slide label="Dot size" value={st.size} min={0.5} max={2.5} onChange={(v) => set({ size: v })} />
                <Slide label="Push apart" value={st.repel} min={0.2} max={3} onChange={(v) => set({ repel: v })} />
                <Slide label="Link length" value={st.length} min={0.4} max={2.5} onChange={(v) => set({ length: v })} />
              </Section>

              <button type="button" onClick={() => setSt({ ...DEFAULTS })} className="self-start rounded-md py-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                Back to defaults
              </button>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 border-b border-border pb-4 last-of-type:mb-2 last-of-type:border-0 last-of-type:pb-0">
      <h3 className="mb-2.5 text-[11.5px] font-[650] tracking-[0.06em] text-muted-foreground uppercase">{title}</h3>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{label}</div>
        {hint && <div className="text-[11.5px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={cn("relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-foreground/15")}>
      <span className={cn("absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow-sm transition-transform duration-200", on && "translate-x-4")} />
    </button>
  );
}

function Seg<T extends string>({ value, onChange, options, full }: { value: T; onChange(v: T): void; options: [T, string][]; full?: boolean }) {
  return (
    <div className={cn("flex rounded-full bg-foreground/[0.06] p-0.5", full && "w-full")}>
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={cn("h-8 flex-1 rounded-full px-2.5 text-[12.5px] whitespace-nowrap transition-colors", value === v ? "bg-background font-[600] text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Slide({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(v: number): void }) {
  return (
    <label className="flex items-center gap-3 text-[13.5px]" title="Double-click to reset">
      <span className="w-24 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={0.05} value={value} style={{ "--ng-fill": `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(1)} className="ng-range min-w-0 flex-1" />
    </label>
  );
}
