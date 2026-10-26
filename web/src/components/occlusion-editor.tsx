// The image occlusion editor: pick an image, draw boxes over the parts to hide, label them.
// Each box (or group of boxes) becomes its own card. Coordinates are stored as fractions of the image.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy, Group, Hand, ImageUp, Loader2, Maximize, Redo2, SquareDashed, Trash2, Undo2, Ungroup, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface OcclusionBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  group?: string;
}
type Snap = { image: string; boxes: OcclusionBox[] };
type Patch = Partial<{ image: string; boxes: OcclusionBox[]; mode: string }>;
type Rect = { x: number; y: number; w: number; h: number };

const MIN = 0.004;
const MAX_Z = 10;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const faceOf = (b: OcclusionBox) => String(b.group || b.id).replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable);

/** The cards an item will have: one per box, or per group. Same rule as the type's facesWhen. */
export function occlusionFaces(boxes: OcclusionBox[]) {
  const out: { face: string; boxes: OcclusionBox[] }[] = [];
  for (const b of boxes) {
    const f = faceOf(b);
    const e = out.find((o) => o.face === f);
    if (e) e.boxes.push(b);
    else out.push({ face: f, boxes: [b] });
  }
  return out;
}

const clean = (boxes: OcclusionBox[]) =>
  boxes.map((b) => {
    const o: OcclusionBox = { id: b.id, x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h), label: b.label ?? "" };
    if (b.group) o.group = b.group;
    return o;
  });

function nextId(boxes: OcclusionBox[], prefix = "b") {
  let n = 1;
  const ids = new Set(boxes.map((b) => b.id));
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
function nextGroup(boxes: OcclusionBox[]) {
  let n = 1;
  const used = new Set(boxes.flatMap((b) => [b.group, b.id]));
  while (used.has(`g${n}`)) n++;
  return `g${n}`;
}

function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function OcclusionEditor({ image, boxes: propBoxes, mode, onChange, onPendingChange }: { image: string; boxes: OcclusionBox[]; mode: string; onChange(p: Patch): void; onPendingChange?(pending: boolean): void }) {
  const boxes = useMemo(() => (Array.isArray(propBoxes) ? propBoxes.filter((b) => b && typeof b === "object") : []), [propBoxes]);
  const [live, setLive] = useState<OcclusionBox[] | null>(null);
  const shown = live ?? boxes;
  const [sel, setSel] = useState<string[]>([]);
  const [past, setPast] = useState<Snap[]>([]);
  const [future, setFuture] = useState<Snap[]>([]);
  const [tool, setTool] = useState<"draw" | "pan">("draw");
  const [space, setSpace] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 });
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const labelRefs = useRef(new Map<string, HTMLInputElement>());
  const latest = useRef({ image, boxes });
  latest.current = { image, boxes };

  // ------------------------------------------------------------ history
  const commit = useCallback((next: Partial<Snap>, extra: Patch = {}) => {
    const cur = latest.current;
    setPast((p) => [...p.slice(-99), { image: cur.image, boxes: cur.boxes }]);
    setFuture([]);
    onChange({ ...(next.boxes ? { boxes: clean(next.boxes) } : {}), ...(next.image !== undefined ? { image: next.image } : {}), ...extra });
  }, [onChange]);
  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [{ image: latest.current.image, boxes: latest.current.boxes }, ...f]);
      onChange({ image: prev.image, boxes: prev.boxes });
      return p.slice(0, -1);
    });
  }, [onChange]);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setPast((p) => [...p, { image: latest.current.image, boxes: latest.current.boxes }]);
      onChange({ image: next.image, boxes: next.boxes });
      return f.slice(1);
    });
  }, [onChange]);

  // ------------------------------------------------------------ image
  const upload = useCallback(async (file: File) => {
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(file.name)) {
      toast.error("That isn't an image", { description: file.name });
      return;
    }
    const named = file.name && file.name !== "image.png" ? file : new File([file], `occlusion-${Date.now().toString(36)}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg")}`, { type: file.type });
    setUploading(true);
    onPendingChange?.(true);
    try {
      const m = await api.uploadMedia(named);
      setBroken(false);
      setNatural(null);
      setView({ z: 1, tx: 0, ty: 0 });
      commit({ image: m.url });
    } catch (e) {
      toast.error("Couldn't add the image", { description: (e as Error).message });
    } finally {
      setUploading(false);
      onPendingChange?.(false);
    }
  }, [commit, onPendingChange]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => /^image\//.test(f.type));
      if (!file) return;
      // Pasting into another field (a markdown header, say) belongs to that field.
      const t = e.target as HTMLElement | null;
      if (isTyping(t) && !root.current?.contains(t)) return;
      if (t?.closest?.(".cm-editor") && !root.current?.contains(t)) return;
      e.preventDefault();
      upload(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [upload]);

  // ------------------------------------------------------------ layout
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      const ratio = natural ? natural.h / natural.w : 0.62;
      const maxH = Math.max(240, Math.min(window.innerHeight * 0.6, 820));
      let W = avail, H = avail * ratio;
      if (H > maxH) { H = maxH; W = H / ratio; }
      setSize((s) => {
        if (s.W && W !== s.W) setView((v) => ({ ...v, tx: v.tx * (W / s.W), ty: v.ty * (W / s.W) }));
        return { W, H };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural, image]);

  const fit = (v: { z: number; tx: number; ty: number }) => {
    const z = Math.min(MAX_Z, Math.max(1, v.z));
    return { z, tx: Math.min(0, Math.max(size.W - size.W * z, v.tx)), ty: Math.min(0, Math.max(size.H - size.H * z, v.ty)) };
  };
  const zoomAt = (nz: number, px: number, py: number) =>
    setView((v) => {
      const z = Math.min(MAX_Z, Math.max(1, nz));
      return fit({ z, tx: px - (px - v.tx) * (z / v.z), ty: py - (py - v.ty) * (z / v.z) });
    });

  // ------------------------------------------------------------ pointer
  type Drag =
    | { kind: "draw"; x0: number; y0: number; id: number }
    | { kind: "move"; x0: number; y0: number; start: OcclusionBox[]; ids: string[]; moved: boolean; id: number }
    | { kind: "resize"; dir: string; x0: number; y0: number; start: OcclusionBox; id: number }
    | { kind: "pan"; cx: number; cy: number; tx: number; ty: number; id: number }
    | { kind: "pinch"; d: number; mx: number; my: number; z: number; tx: number; ty: number };
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const norm = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const wrapPt = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    setLive(null);
    setDraft(null);
    drag.current = { kind: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ...view };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!image || broken) return;
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    root.current?.focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, wrapPt(e));
    if (pointers.current.size >= 2) return startPinch();
    const p = norm(e);
    const t = e.target as HTMLElement;
    const handle = t.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    const boxId = t.closest<HTMLElement>("[data-box]")?.dataset.box;
    if (e.button === 1 || space || tool === "pan") {
      drag.current = { kind: "pan", cx: e.clientX, cy: e.clientY, tx: view.tx, ty: view.ty, id: e.pointerId };
      return;
    }
    if (handle && sel.length === 1) {
      const start = boxes.find((b) => b.id === sel[0]);
      if (start) drag.current = { kind: "resize", dir: handle, x0: p.x, y0: p.y, start, id: e.pointerId };
      return;
    }
    if (boxId) {
      let ids = sel;
      if (e.shiftKey || e.metaKey || e.ctrlKey) ids = sel.includes(boxId) ? sel.filter((s) => s !== boxId) : [...sel, boxId];
      else if (!sel.includes(boxId)) ids = [boxId];
      // Clicking a grouped box picks up its whole group, so it moves as one.
      const b = boxes.find((x) => x.id === boxId);
      if (b?.group && !(e.shiftKey || e.metaKey || e.ctrlKey)) ids = [...new Set([...ids, ...boxes.filter((x) => x.group === b.group).map((x) => x.id)])];
      setSel(ids);
      if (ids.includes(boxId)) drag.current = { kind: "move", x0: p.x, y0: p.y, start: boxes, ids, moved: false, id: e.pointerId };
      return;
    }
    if (!(e.shiftKey || e.metaKey || e.ctrlKey)) setSel([]);
    drag.current = { kind: "draw", x0: p.x, y0: p.y, id: e.pointerId };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, wrapPt(e));
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const z = Math.min(MAX_Z, Math.max(1, d.z * (dist / d.d)));
      setView(fit({ z, tx: mx - (d.mx - d.tx) * (z / d.z), ty: my - (d.my - d.ty) * (z / d.z) }));
      return;
    }
    if (d.id !== e.pointerId) return;
    if (d.kind === "pan") {
      setView(fit({ z: view.z, tx: d.tx + (e.clientX - d.cx), ty: d.ty + (e.clientY - d.cy) }));
      return;
    }
    const p = norm(e);
    if (d.kind === "draw") {
      setDraft({ x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) });
    } else if (d.kind === "move") {
      const moving = d.start.filter((b) => d.ids.includes(b.id));
      let dx = p.x - d.x0, dy = p.y - d.y0;
      for (const b of moving) {
        dx = Math.min(1 - b.x - b.w, Math.max(-b.x, dx));
        dy = Math.min(1 - b.y - b.h, Math.max(-b.y, dy));
      }
      if (Math.abs(dx) + Math.abs(dy) > 0.0005) d.moved = true;
      setLive(d.start.map((b) => (d.ids.includes(b.id) ? { ...b, x: b.x + dx, y: b.y + dy } : b)));
    } else if (d.kind === "resize") {
      const s = d.start;
      let x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
      if (d.dir.includes("w")) x1 = p.x;
      if (d.dir.includes("e")) x2 = p.x;
      if (d.dir.includes("n")) y1 = p.y;
      if (d.dir.includes("s")) y2 = p.y;
      const r: Rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(MIN, Math.abs(x2 - x1)), h: Math.max(MIN, Math.abs(y2 - y1)) };
      setLive(boxes.map((b) => (b.id === s.id ? { ...b, ...r } : b)));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const d = drag.current;
    if (d?.kind === "pinch") {
      // Lifting one finger of a pinch leaves the other one panning, not drawing.
      const rest = [...pointers.current.entries()][0];
      drag.current = rest ? { kind: "pan", cx: e.clientX, cy: e.clientY, tx: view.tx, ty: view.ty, id: rest[0] } : null;
      if (rest) {
        const r = wrap.current!.getBoundingClientRect();
        drag.current = { kind: "pan", cx: rest[1].x + r.left, cy: rest[1].y + r.top, tx: view.tx, ty: view.ty, id: rest[0] };
      }
      return;
    }
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.kind === "draw") {
      const r = draft;
      setDraft(null);
      // Too small to be meant (a click on the image): just clears the selection.
      if (!r || r.w * size.W * view.z < 6 || r.h * size.H * view.z < 6) return;
      const id = nextId(boxes);
      commit({ boxes: [...boxes, { id, ...r, label: "" }] });
      setSel([id]);
      if (!matchMedia("(pointer: coarse)").matches) requestAnimationFrame(() => labelRefs.current.get(id)?.focus({ preventScroll: true }));
    } else if (d.kind === "move" || d.kind === "resize") {
      const next = live;
      setLive(null);
      if (next && (d.kind === "resize" || d.moved)) commit({ boxes: next });
    }
  };

  const onWheel = useCallback((e: WheelEvent) => {
    if (!image) return;
    const r = wrap.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setView((v) => {
        const z = Math.min(MAX_Z, Math.max(1, v.z * Math.exp(-e.deltaY * 0.0025)));
        const px = e.clientX - r.left, py = e.clientY - r.top;
        return fitWith({ z, tx: px - (px - v.tx) * (z / v.z), ty: py - (py - v.ty) * (z / v.z) });
      });
    } else if (view.z > 1.001) {
      e.preventDefault();
      setView((v) => fitWith({ z: v.z, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
    }
  }, [image, view.z, size.W, size.H]);
  const fitWith = (v: { z: number; tx: number; ty: number }) => fit(v);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // ------------------------------------------------------------ actions
  const remove = useCallback(() => {
    if (!sel.length) return;
    commit({ boxes: boxes.filter((b) => !sel.includes(b.id)) });
    setSel([]);
  }, [sel, boxes, commit]);
  const duplicate = useCallback(() => {
    if (!sel.length) return;
    const add: OcclusionBox[] = [];
    let all = boxes;
    const groupMap = new Map<string, string>();
    for (const b of boxes.filter((x) => sel.includes(x.id))) {
      const id = nextId(all);
      let group: string | undefined;
      if (b.group) {
        if (!groupMap.has(b.group)) groupMap.set(b.group, nextGroup([...all, ...add]));
        group = groupMap.get(b.group);
      }
      const nb = { ...b, id, x: Math.min(1 - b.w, b.x + 0.02), y: Math.min(1 - b.h, b.y + 0.02), label: "", group };
      if (!group) delete nb.group;
      add.push(nb);
      all = [...all, nb];
    }
    commit({ boxes: [...boxes, ...add] });
    setSel(add.map((b) => b.id));
  }, [sel, boxes, commit]);
  const group = useCallback(() => {
    if (sel.length < 2) return;
    const existing = boxes.find((b) => sel.includes(b.id) && b.group)?.group;
    const g = existing ?? nextGroup(boxes);
    commit({ boxes: boxes.map((b) => (sel.includes(b.id) ? { ...b, group: g } : b)) });
  }, [sel, boxes, commit]);
  const ungroup = useCallback(() => {
    commit({ boxes: boxes.map((b) => (sel.includes(b.id) ? (({ group: _, ...rest }) => rest)(b) : b)) });
  }, [sel, boxes, commit]);
  const nudge = useCallback((dx: number, dy: number) => {
    if (!sel.length) return;
    commit({ boxes: boxes.map((b) => (sel.includes(b.id) ? { ...b, x: clamp01(Math.min(1 - b.w, b.x + dx)), y: clamp01(Math.min(1 - b.h, b.y + dy)) } : b)) });
  }, [sel, boxes, commit]);
  const setLabel = (id: string, label: string) => {
    // Typing a label is one undo step per field focus, not per keystroke.
    onChange({ boxes: clean(boxes.map((b) => (b.id === id ? { ...b, label } : b))) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !isTyping(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && k === "y" && !isTyping(e.target)) {
      e.preventDefault();
      redo();
      return;
    }
    if (isTyping(e.target)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (mod && k === "d") {
      e.preventDefault();
      duplicate();
    } else if (mod && k === "g") {
      e.preventDefault();
      if (e.shiftKey) ungroup();
      else group();
    } else if (mod && k === "a") {
      e.preventDefault();
      setSel(boxes.map((b) => b.id));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (!sel.length) return;
      e.preventDefault();
      remove();
    } else if (e.key.startsWith("Arrow") && sel.length) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / Math.max(1, size.W * view.z);
      const stepY = (e.shiftKey ? 10 : 1) / Math.max(1, size.H * view.z);
      nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -stepY : e.key === "ArrowDown" ? stepY : 0);
    } else if (e.key === "Escape") {
      if (sel.length) {
        e.stopPropagation();
        setSel([]);
      }
    } else if (e.key === " " && !space) {
      e.preventDefault();
      setSpace(true);
    } else if (k === "+" || k === "=") zoomAt(view.z * 1.4, size.W / 2, size.H / 2);
    else if (k === "-") zoomAt(view.z / 1.4, size.W / 2, size.H / 2);
    else if (k === "0") setView({ z: 1, tx: 0, ty: 0 });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === " ") setSpace(false);
  };

  // ------------------------------------------------------------ derived
  const faces = occlusionFaces(shown);
  const number = new Map<string, number>();
  faces.forEach((f, i) => f.boxes.forEach((b) => number.set(b.id, i + 1)));
  const unlabeled = faces.filter((f) => !f.boxes.some((b) => (b.label ?? "").trim())).length;
  const selGrouped = boxes.some((b) => sel.includes(b.id) && b.group);
  const panning = tool === "pan" || space;
  const z = view.z;
  const one = sel.length === 1 ? shown.find((b) => b.id === sel[0]) : undefined;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  // ------------------------------------------------------------ render
  if (!image) {
    return (
      <div ref={root} tabIndex={-1} className="outline-none" data-occlusion-editor>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = Array.from(e.dataTransfer.files)[0];
            if (f) upload(f);
          }}
          className={cn("flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors", dragOver ? "border-highlight text-foreground" : "border-input text-muted-foreground")}
        >
          {uploading ? <Loader2 className="size-6 animate-spin" /> : <ImageUp className="size-7" />}
          <div className="text-sm">
            <span className="font-medium text-foreground">Drop an image here</span>, paste a screenshot <kbd className="rounded border px-1 font-mono text-[11px]">Ctrl V</kbd>, or
          </div>
          <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>Choose an image</Button>
          <p className="max-w-sm text-xs">A diagram, a slide, an atlas page. Then drag boxes over the parts to hide.</p>
        </div>
        <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
      </div>
    );
  }

  return (
    <div ref={root} tabIndex={-1} className="flex flex-col gap-3 outline-none" onKeyDown={onKeyDown} onKeyUp={onKeyUp} data-occlusion-editor>
      <div className="flex flex-wrap items-center gap-1">
        <div className="flex rounded-md border p-0.5">
          <Tip label="Draw boxes"><Button type="button" size="icon-sm" variant="ghost" aria-pressed={!panning} className={cn("size-7", !panning && "bg-accent text-foreground")} onClick={() => setTool("draw")} aria-label="Draw boxes"><SquareDashed /></Button></Tip>
          <Tip label="Move the image (or hold Space)"><Button type="button" size="icon-sm" variant="ghost" aria-pressed={panning} className={cn("size-7", panning && "bg-accent text-foreground")} onClick={() => setTool("pan")} aria-label="Move the image"><Hand /></Button></Tip>
        </div>
        <Tip label="Undo (Ctrl Z)"><Button type="button" size="icon-sm" variant="ghost" disabled={!past.length} onClick={undo} aria-label="Undo"><Undo2 /></Button></Tip>
        <Tip label="Redo (Ctrl Shift Z)"><Button type="button" size="icon-sm" variant="ghost" disabled={!future.length} onClick={redo} aria-label="Redo"><Redo2 /></Button></Tip>
        <span className="mx-1 h-5 w-px bg-border" />
        <Tip label="Group: asked together as one card (Ctrl G)"><Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2" disabled={sel.length < 2} onClick={group}><Group /><span className="hidden sm:inline">Group</span></Button></Tip>
        <Tip label="Ungroup (Ctrl Shift G)"><Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2" disabled={!selGrouped} onClick={ungroup}><Ungroup /><span className="hidden sm:inline">Ungroup</span></Button></Tip>
        <Tip label="Duplicate (Ctrl D)"><Button type="button" size="icon-sm" variant="ghost" disabled={!sel.length} onClick={duplicate} aria-label="Duplicate"><Copy /></Button></Tip>
        <Tip label="Delete (Del)"><Button type="button" size="icon-sm" variant="ghost" disabled={!sel.length} onClick={remove} aria-label="Delete box"><Trash2 /></Button></Tip>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <Tip label="Zoom out (−)"><Button type="button" size="icon-sm" variant="ghost" disabled={z <= 1} onClick={() => zoomAt(z / 1.4, size.W / 2, size.H / 2)} aria-label="Zoom out"><ZoomOut /></Button></Tip>
        <button type="button" className="h-8 min-w-12 rounded-md px-1 text-xs tabular text-muted-foreground hover:text-foreground" onClick={() => setView({ z: 1, tx: 0, ty: 0 })} title="Fit (0)">{Math.round(z * 100)}%</button>
        <Tip label="Zoom in (+, Ctrl + scroll, pinch)"><Button type="button" size="icon-sm" variant="ghost" disabled={z >= MAX_Z} onClick={() => zoomAt(z * 1.4, size.W / 2, size.H / 2)} aria-label="Zoom in"><ZoomIn /></Button></Tip>
        <Tip label="Fit the image"><Button type="button" size="icon-sm" variant="ghost" className="hidden sm:inline-flex" disabled={z <= 1} onClick={() => setView({ z: 1, tx: 0, ty: 0 })} aria-label="Fit"><Maximize /></Button></Tip>
        <div className="flex-1" />
        <span className="text-sm tabular" data-occlusion-count>{faces.length} card{faces.length === 1 ? "" : "s"}</span>
      </div>

      <div className="grid gap-3 @container lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-2">
          <div ref={wrap} className="w-full">
            <div
              className={cn("relative mx-auto touch-none select-none overflow-hidden rounded-md border bg-muted/40", panning ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair", dragOver && "border-highlight")}
              style={{ width: size.W || "100%", height: size.H || 240 }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = Array.from(e.dataTransfer.files)[0]; if (f) upload(f); }}
              data-occlusion-stage
            >
              <div
                ref={canvas}
                className="absolute left-0 top-0 origin-top-left"
                style={{ width: size.W, height: size.H, transform: `translate(${view.tx}px, ${view.ty}px) scale(${z})` }}
              >
                <img
                  src={image}
                  alt=""
                  draggable={false}
                  className="pointer-events-none block size-full"
                  onLoad={(e) => { setBroken(false); setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 }); }}
                  onError={() => setBroken(true)}
                />
                {shown.map((b) => {
                  const on = sel.includes(b.id);
                  return (
                    <div
                      key={b.id}
                      data-box={b.id}
                      className={cn("absolute rounded-[2px]", on ? "bg-highlight/45" : "bg-[rgb(71_85_105/0.62)] hover:bg-[rgb(71_85_105/0.75)]", panning ? "" : "cursor-move")}
                      style={{
                        // Fixed, theme-independent fills: the image underneath is the same in every theme.
                        left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`,
                        outline: `${(on ? 2 : 1) / z}px solid ${on ? "var(--highlight)" : "rgb(15 23 42 / 0.85)"}`,
                        outlineOffset: 0,
                      }}
                    >
                      <span
                        className={cn("pointer-events-none absolute left-0 flex h-5 min-w-5 items-center justify-center rounded-[4px] px-1 text-[11px] font-semibold tabular", on ? "bg-highlight text-background" : "bg-foreground text-background")}
                        // Just above the box, so it never covers what the box covers; below it at the image's top edge.
                        style={b.y * size.H * z + view.ty >= 22
                          ? { top: 0, transform: `translateY(calc(-100% - 2px)) scale(${1 / z})`, transformOrigin: "0 100%" }
                          : { top: "calc(100% + 2px)", transform: `scale(${1 / z})`, transformOrigin: "0 0" }}
                      >
                        {number.get(b.id)}
                      </span>
                    </div>
                  );
                })}
                {one && !panning && ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => {
                  const x = h.includes("w") ? one.x : h.includes("e") ? one.x + one.w : one.x + one.w / 2;
                  const y = h.includes("n") ? one.y : h.includes("s") ? one.y + one.h : one.y + one.h / 2;
                  return (
                    <div
                      key={h}
                      data-handle={h}
                      className="absolute flex size-6 items-center justify-center pointer-coarse:size-9"
                      style={{ left: `${x * 100}%`, top: `${y * 100}%`, transform: `translate(-50%, -50%) scale(${1 / z})`, cursor: `${h}-resize` }}
                    >
                      <span className="size-2 rounded-[2px] border border-highlight bg-white pointer-coarse:size-3" />
                    </div>
                  );
                })}
                {draft && <div className="pointer-events-none absolute bg-highlight/20" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`, outline: `${1.5 / z}px dashed var(--highlight)` }} />}
              </div>
              {broken && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">The image couldn't be loaded.</div>}
              {uploading && <div className="absolute inset-0 flex items-center justify-center bg-background/60"><Loader2 className="size-6 animate-spin" /></div>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {!shown.length ? "Drag on the image to cover a part." : coarse ? "Drag to add a box. Tap the numbers in the list to select several." : "Drag to add a box. Shift-click, or click the numbers in the list, to select several."}
            </span>
            <div className="flex-1" />
            <button type="button" className="hover:text-foreground" onClick={() => fileInput.current?.click()}>Replace image</button>
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">On each card</span>
            <div className="flex-1" />
            <div className="flex rounded-md border p-0.5 text-xs" role="radiogroup" aria-label="What a card covers">
              {[["hide-all", "Hide all"], ["hide-one", "Hide one"]].map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={(mode || "hide-all") === v} title={v === "hide-all" ? "Every box is covered and one is asked" : "Only the asked box is covered; the others stay visible"} onClick={() => onChange({ mode: v })} className={cn("h-6 rounded px-2 pointer-coarse:h-8", (mode || "hide-all") === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{l}</button>
              ))}
            </div>
          </div>
          {faces.length === 0 && <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No boxes yet.</p>}
          <div className="flex flex-col gap-1.5 lg:max-h-[min(70vh,900px)] lg:overflow-y-auto lg:pr-0.5" data-occlusion-list>
            {faces.map((f, i) => {
              const on = f.boxes.some((b) => sel.includes(b.id));
              return (
                <div
                  key={f.face}
                  className={cn("flex items-start gap-2 rounded-md border p-1.5 transition-colors", on ? "border-highlight/70" : "border-border")}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest("button")) return;
                    setSel(f.boxes.map((b) => b.id));
                  }}
                  data-occlusion-row={f.face}
                >
                  <button
                    type="button"
                    title="Add to the selection or take it out (to group boxes)"
                    aria-pressed={on}
                    aria-label={`Select box ${i + 1} along with others`}
                    onClick={() => {
                      const ids = f.boxes.map((b) => b.id);
                      setSel((cur) => (ids.every((id) => cur.includes(id)) ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])]));
                    }}
                    className={cn("relative mt-1.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[11px] font-semibold tabular after:absolute after:-inset-2 after:content-['']", on ? "bg-highlight text-background" : "bg-foreground text-background hover:bg-foreground/80")}
                  >
                    {i + 1}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {f.boxes.map((b, j) => (
                      <Input
                        key={b.id}
                        ref={(el) => { if (el) labelRefs.current.set(b.id, el); else labelRefs.current.delete(b.id); }}
                        className="h-8 text-sm pointer-coarse:h-10"
                        value={b.label ?? ""}
                        placeholder={j === 0 ? "Name, e.g. Aorta | aortic arch" : "Name of this box (any one is accepted)"}
                        onFocus={() => {
                          setSel(f.boxes.map((x) => x.id));
                          setPast((p) => [...p.slice(-99), { image, boxes }]);
                          setFuture([]);
                        }}
                        onChange={(e) => setLabel(b.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const ids = faces.flatMap((x) => x.boxes.map((y) => y.id));
                            const nx = ids[ids.indexOf(b.id) + 1];
                            if (nx) labelRefs.current.get(nx)?.focus();
                            else (e.target as HTMLInputElement).blur();
                          }
                        }}
                        aria-label={`Label for box ${i + 1}`}
                      />
                    ))}
                    {f.boxes.length > 1 && <span className="px-0.5 text-xs text-muted-foreground">{f.boxes.length} boxes, asked together as one card</span>}
                  </div>
                  <Button type="button" size="icon-sm" variant="ghost" className="size-8 shrink-0 text-muted-foreground" aria-label={`Delete box ${i + 1}`} onClick={() => { commit({ boxes: boxes.filter((b) => !f.boxes.some((x) => x.id === b.id)) }); setSel([]); }}><Trash2 className="size-3.5" /></Button>
                </div>
              );
            })}
          </div>
          {unlabeled > 0 && (
            <p className="text-xs text-muted-foreground" data-occlusion-hint>
              {unlabeled === 1 ? "One card has" : `${unlabeled} cards have`} no label. {unlabeled === 1 ? "It's" : "They're"} shown with the answer hidden and you rate yourself, like a basic card. Add a label to type the answer instead.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
