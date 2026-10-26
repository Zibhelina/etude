// Image occlusion notes from Anki become Etude `occlusion` items.
//
// - Anki's built-in Image Occlusion (23.10+) is a cloze notetype whose Occlusion field holds
//   `{{c1::image-occlusion:rect:left=.2:top=.3:width=.1:height=.05:oi=1}}`. Shapes with the same
//   cloze number are one card; ellipses and polygons become their bounding box; text is skipped.
// - The Image Occlusion Enhanced add-on stores one note per shape and an SVG mask
//   (`Original Mask`) whose top layer lists the shapes in order; `ID (hidden)` says which one a note asks.
// Neither stores what a box is called, so imported boxes have no label and are self-graded.
import type { AnkiNote, AnkiNotetype } from "./collection.ts";

export interface IoBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  group?: string;
}

export interface IoItem {
  /** Notes this item came from, and the face each of their cards becomes (by card ord). */
  notes: { note: AnkiNote; faceOf(ord: number): string | null }[];
  id: string;
  fields: { image: string; boxes: IoBox[]; mode?: string; header?: string; extra?: string };
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function fieldIndex(nt: AnkiNotetype, names: string[], fallback: number): number {
  const i = nt.fields.findIndex((f) => names.some((n) => f.name.trim().toLowerCase() === n));
  return i >= 0 ? nt.fields[i].ord : fallback;
}
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
const srcOf = (html: string) => /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null;
const joinHtml = (parts: [string, string][]) =>
  parts
    .filter(([, v]) => plain(v))
    .map(([label, v]) => (label ? `<p><strong>${label}</strong></p>\n${v}` : v))
    .join("\n\n");

function box(id: string, x: number, y: number, w: number, h: number, group?: string): IoBox | null {
  const x0 = clamp01(x), y0 = clamp01(y), x1 = clamp01(x + w), y1 = clamp01(y + h);
  if (!(x1 - x0 > 0.0005 && y1 - y0 > 0.0005)) return null;
  const b: IoBox = { id, x: r4(x0), y: r4(y0), w: r4(x1 - x0), h: r4(y1 - y0), label: "" };
  if (group) b.group = group;
  return b;
}

// ------------------------------------------------------------------ Anki's built-in IO

export const isAnkiIoNotetype = (nt: AnkiNotetype, notes: AnkiNote[]) =>
  nt.cloze && notes.some((n) => n.fields.some((f) => /\{\{c\d+::image-occlusion:/.test(f)));

/** Reads `key=value` pairs separated by `:`, where `\:` and `\\` are escapes. */
function props(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = "", parts: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === "\\" && i + 1 < spec.length) cur += spec[++i];
    else if (c === ":") {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return out;
}

export function ankiIoShapes(occlusions: string): { ord: number; shape: string; box: Omit<IoBox, "id" | "label" | "group"> | null; oi: boolean }[] {
  const out: { ord: number; shape: string; box: Omit<IoBox, "id" | "label" | "group"> | null; oi: boolean }[] = [];
  const re = /\{\{c(\d+)::image-occlusion:(\w+)((?:\\.|[^}\\])*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(occlusions))) {
    const ord = Number(m[1]);
    const shape = m[2];
    const p = props(m[3].replace(/^:/, ""));
    const n = (k: string) => Number(p[k]);
    let b: { x: number; y: number; w: number; h: number } | null = null;
    if (shape === "rect") b = { x: n("left"), y: n("top"), w: n("width"), h: n("height") };
    else if (shape === "ellipse") b = { x: n("left"), y: n("top"), w: 2 * n("rx"), h: 2 * n("ry") };
    else if (shape === "polygon" && p.points) {
      const pts = p.points.trim().split(/\s+/).map((xy) => xy.split(",").map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite));
      if (pts.length >= 2) {
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
    }
    // Text shapes are labels drawn on the image, not something to ask.
    if (shape === "text") continue;
    out.push({ ord, shape, box: b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : null, oi: p.oi === "1" });
  }
  return out;
}

export function convertAnkiIo(nt: AnkiNotetype, note: AnkiNote, rewrite: (html: string) => string): IoItem | null {
  const at = (i: number) => note.fields[i] ?? "";
  const occl = at(fieldIndex(nt, ["occlusion", "occlusions"], 0));
  const image = srcOf(rewrite(at(fieldIndex(nt, ["image"], 1))));
  if (!image) return null;
  const shapes = ankiIoShapes(occl);
  const boxes: IoBox[] = [];
  const count = new Map<number, number>();
  for (const s of shapes) {
    if (!s.box) continue;
    const k = (count.get(s.ord) ?? 0) + 1;
    count.set(s.ord, k);
    const b = box(`c${s.ord}${k > 1 ? `-${k}` : ""}`, s.box.x, s.box.y, s.box.w, s.box.h, `c${s.ord}`);
    if (b) boxes.push(b);
  }
  if (!boxes.length) return null;
  // A box alone in its cloze doesn't need a group: its id is already the face.
  for (const b of boxes) if (boxes.filter((o) => o.group === b.group).length === 1) {
    b.id = b.group!;
    delete b.group;
  }
  // oi=1 ("hide all, guess one") is per shape in Anki; an Etude item has one mode, so the majority wins.
  const oi = shapes.filter((s) => s.box && s.oi).length;
  const mode = oi * 2 >= shapes.filter((s) => s.box).length ? undefined : "hide-one";
  const header = rewrite(at(fieldIndex(nt, ["header"], 2)));
  const extra = joinHtml([["", rewrite(at(fieldIndex(nt, ["back extra"], 3)))], ["Comments", rewrite(nt.fields.length > 4 ? at(fieldIndex(nt, ["comments"], 4)) : "")]]);
  return {
    id: "",
    notes: [{ note, faceOf: (ord) => (count.has(ord + 1) ? `c${ord + 1}` : null) }],
    fields: { image, boxes, ...(mode ? { mode } : {}), ...(plain(header) ? { header } : {}), ...(extra ? { extra } : {}) },
  };
}

// ------------------------------------------------------------------ Image Occlusion Enhanced

export const isIoeNotetype = (nt: AnkiNotetype) => {
  const names = nt.fields.map((f) => f.name.trim().toLowerCase());
  return names.includes("original mask") && names.includes("image") && (names.includes("question mask") || /image occlusion/i.test(nt.name));
};

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
const num = (tag: string, name: string) => {
  const v = attr(tag, name);
  return v == null ? NaN : parseFloat(v);
};

/** Splits an element's direct children (ignoring text and comments). */
function children(xml: string): { name: string; open: string; inner: string }[] {
  const out: { name: string; open: string; inner: string }[] = [];
  const re = /<(\/?)([\w:-]+)([^>]*?)(\/?)>/g;
  let depth = 0;
  let start: { name: string; open: string; from: number } | null = null;
  let m: RegExpExecArray | null;
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  while ((m = re.exec(clean))) {
    const [all, close, name, , self] = m;
    if (close) {
      depth--;
      if (depth === 0 && start) {
        out.push({ name: start.name, open: start.open, inner: clean.slice(start.from, m.index) });
        start = null;
      }
    } else if (self) {
      if (depth === 0) out.push({ name, open: all, inner: "" });
    } else {
      if (depth === 0) start = { name, open: all, from: m.index + all.length };
      depth++;
    }
  }
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };
function shapeRect(el: { name: string; open: string }): Rect | null {
  const t = el.open;
  const n = el.name.toLowerCase();
  if (n === "rect") return { x: num(t, "x") || 0, y: num(t, "y") || 0, w: num(t, "width"), h: num(t, "height") };
  if (n === "ellipse" || n === "circle") {
    const rx = n === "circle" ? num(t, "r") : num(t, "rx"), ry = n === "circle" ? num(t, "r") : num(t, "ry");
    return { x: num(t, "cx") - rx, y: num(t, "cy") - ry, w: 2 * rx, h: 2 * ry };
  }
  if (n === "polygon" || n === "polyline") {
    const v = (attr(t, "points") ?? "").trim().split(/[\s,]+/).map(Number);
    const xs = v.filter((_, i) => i % 2 === 0), ys = v.filter((_, i) => i % 2 === 1);
    if (xs.length < 2 || ![...xs, ...ys].every(Number.isFinite)) return null;
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return null;
}

/** The shapes of an IOE mask, numbered the way the add-on numbers its notes (1-based, in layer order). */
export function ioeMaskShapes(svg: string): { width: number; height: number; shapes: { nr: number; rects: Rect[] }[] } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  let width = num(root, "width"), height = num(root, "height");
  if (!(width > 0 && height > 0)) {
    const vb = (attr(root, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4) [width, height] = [vb[2], vb[3]];
  }
  if (!(width > 0 && height > 0)) return null;
  const body = svg.slice(svg.indexOf(root) + root.length, svg.toLowerCase().lastIndexOf("</svg>"));
  const layers = children(body).filter((c) => c.name.toLowerCase() === "g");
  const masks = layers[layers.length - 1];
  if (!masks) return null;
  const shapes: { nr: number; rects: Rect[] }[] = [];
  let nr = 0;
  for (const el of children(masks.inner)) {
    if (el.name.toLowerCase() === "title") continue;
    nr++;
    const parts = el.name.toLowerCase() === "g" ? children(el.inner) : [el];
    const rects = parts.map(shapeRect).filter((r): r is Rect => !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
    shapes.push({ nr, rects });
  }
  return { width, height, shapes };
}

/** Image Occlusion Enhanced notes, grouped by the mask they share: one Etude item per image. */
export function convertIoe(nt: AnkiNotetype, notes: AnkiNote[], rewrite: (html: string) => string, media: Map<string, () => Buffer>): { items: IoItem[]; failed: AnkiNote[] } {
  const at = (n: AnkiNote, names: string[], fb: number) => n.fields[fieldIndex(nt, names, fb)] ?? "";
  const idx = { id: ["id (hidden)", "id"], header: ["header"], image: ["image"], footer: ["footer"], remarks: ["remarks"], sources: ["sources"], extra1: ["extra 1"], extra2: ["extra 2"], omask: ["original mask"] };
  const failed: AnkiNote[] = [];
  const byMask = new Map<string, { notes: { note: AnkiNote; nr: number }[]; uniq: string; tp: string; first: AnkiNote; svg: NonNullable<ReturnType<typeof ioeMaskShapes>> }>();
  for (const note of notes) {
    const maskName = srcOf(at(note, idx.omask, 10));
    const id = plain(at(note, idx.id, 0));
    const m = /^(.+)-(\w{2})-(\d+)$/.exec(id);
    const load = maskName ? media.get(maskName) : undefined;
    let svg: ReturnType<typeof ioeMaskShapes> = null;
    try {
      svg = load ? ioeMaskShapes(load().toString("utf8")) : null;
    } catch {
      svg = null;
    }
    if (!m || !svg || !srcOf(rewrite(at(note, idx.image, 2)))) {
      failed.push(note);
      continue;
    }
    const nr = Number(m[3]);
    if (!svg.shapes.some((s) => s.nr === nr && s.rects.length)) {
      failed.push(note);
      continue;
    }
    const key = `${m[1]}\u0000${maskName}`;
    const g = byMask.get(key) ?? { notes: [], uniq: m[1], tp: m[2], first: note, svg };
    g.notes.push({ note, nr });
    byMask.set(key, g);
  }
  const items: IoItem[] = [];
  for (const g of byMask.values()) {
    const boxes: IoBox[] = [];
    for (const s of g.svg.shapes) {
      const many = s.rects.length > 1;
      s.rects.forEach((r, k) => {
        const b = box(many ? `n${s.nr}-${k + 1}` : `n${s.nr}`, r.x / g.svg.width, r.y / g.svg.height, r.w / g.svg.width, r.h / g.svg.height, many ? `n${s.nr}` : undefined);
        if (b) boxes.push(b);
      });
    }
    const n = g.first;
    const header = rewrite(at(n, idx.header, 1));
    const extra = joinHtml([
      ["", rewrite(at(n, idx.footer, 4))],
      ["Remarks", rewrite(at(n, idx.remarks, 5))],
      ["Sources", rewrite(at(n, idx.sources, 6))],
      ["Extra 1", rewrite(at(n, idx.extra1, 7))],
      ["Extra 2", rewrite(at(n, idx.extra2, 8))],
    ]);
    items.push({
      id: `ioe-${g.uniq}`,
      // `oa` is "one/all: hide one, guess one"; `ao` (the default) hides all.
      fields: { image: srcOf(rewrite(at(n, idx.image, 2)))!, boxes, ...(g.tp === "oa" ? { mode: "hide-one" } : {}), ...(plain(header) ? { header } : {}), ...(extra ? { extra } : {}) },
      notes: g.notes.map(({ note, nr }) => ({ note, faceOf: () => `n${nr}` })),
    });
  }
  return { items, failed };
}
