// Changing a canvas (an Excalidraw scene) one element at a time, for scripts and agents: list what's on it, add
// shapes, text, arrows between shapes, lines and pictures, change or move them, and remove them. Elements come out
// complete (seed, version, index…), the way Excalidraw itself saves them, so the canvas opens as if drawn by hand.
import { randomBytes } from "node:crypto";
import { keyBetween, validKey } from "./fractional-index.ts";
import { EtudeError } from "./engine.ts";
import type { CanvasScene } from "./notes.ts";

type El = Record<string, any>;

export const SHAPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "image", "frame"] as const;
export type Shape = (typeof SHAPES)[number];

/** Excalidraw's own palette names, so `--color red` works like the toolbar does. */
const COLORS: Record<string, string> = {
  black: "#1e1e1e", gray: "#868e96", grey: "#868e96", red: "#e03131", pink: "#c2255c", grape: "#9c36b5", violet: "#6741d9", purple: "#6741d9", indigo: "#3b5bdb",
  blue: "#1971c2", cyan: "#0c8599", teal: "#099268", green: "#2f9e44", lime: "#66a80f", yellow: "#f08c00", orange: "#e8590c", white: "#ffffff", transparent: "transparent",
};
const FILLS: Record<string, string> = {
  red: "#ffc9c9", pink: "#fcc2d7", grape: "#eebefa", violet: "#d0bfff", purple: "#d0bfff", indigo: "#bac8ff", blue: "#a5d8ff", cyan: "#99e9f2", teal: "#96f2d7",
  green: "#b2f2bb", lime: "#d8f5a2", yellow: "#ffec99", orange: "#ffd8a8", gray: "#e9ecef", grey: "#e9ecef", white: "#ffffff", black: "#1e1e1e", transparent: "transparent",
};
/** Excalidraw 0.18's font ids. */
const FONTS: Record<string, number> = { hand: 5, excalifont: 5, virgil: 1, normal: 6, sans: 6, nunito: 6, helvetica: 2, code: 8, mono: 8, cascadia: 3, lilita: 7 };

const color = (v: unknown, fill = false) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if ((fill ? FILLS : COLORS)[s]) return (fill ? FILLS : COLORS)[s];
  if (/^#[0-9a-f]{3,8}$/i.test(s) || s === "transparent") return s;
  throw new EtudeError(`"${v}" isn't a colour: use #rrggbb or one of ${Object.keys(COLORS).join(", ")}`);
};

const nid = () => randomBytes(15).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 20);
const seed = () => 1 + (randomBytes(4).readUInt32BE(0) % (2 ** 31 - 2));

export interface ElementSpec {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** A text element's words, or the label inside a shape or on an arrow. */
  text?: string;
  color?: string;
  background?: string;
  fill?: "solid" | "hachure" | "cross-hatch" | "zigzag";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  /** 0 architect (clean), 1 artist (default), 2 cartoonist. */
  roughness?: number;
  opacity?: number;
  fontSize?: number;
  font?: string;
  align?: "left" | "center" | "right";
  /** Arrows and lines: from one element to another (ids), or through points relative to x,y. */
  from?: string;
  to?: string;
  points?: [number, number][];
  /** Arrows: the head at the end, "none" for none. */
  head?: string;
  /** Pictures: the media file (as stored), its type and size in pixels. */
  image?: { media: string; mimeType: string; width?: number; height?: number };
  link?: string;
  rounded?: boolean;
  /** Put it inside this frame. */
  frame?: string;
}

const live = (s: CanvasScene) => s.elements.filter((e) => !e.isDeleted) as El[];
const byId = (s: CanvasScene, id: string): El => {
  const all = live(s);
  const pre = id.length >= 4 ? all.filter((e) => String(e.id).startsWith(id)) : [];
  const hit = all.find((e) => e.id === id) ?? (pre.length === 1 ? pre[0] : undefined);
  if (!hit) throw new EtudeError(`no element "${id}" on the canvas (note canvas lists them)`, 404);
  return hit;
};

function measure(text: string, fontSize: number) {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((l) => [...l].length));
  return { width: Math.ceil(longest * fontSize * 0.58), height: Math.ceil(lines.length * fontSize * 1.25) };
}

function nextIndex(s: CanvasScene): string {
  const last = (live(s).map((e) => e.index).filter(validKey) as string[]).sort().at(-1) ?? null;
  return keyBetween(last, null);
}

function base(s: CanvasScene, type: string, spec: ElementSpec): El {
  return {
    id: nid(),
    type,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    width: spec.width ?? 0,
    height: spec.height ?? 0,
    angle: 0,
    strokeColor: color(spec.color) ?? "#1e1e1e",
    backgroundColor: color(spec.background, true) ?? "transparent",
    fillStyle: spec.fill ?? "solid",
    strokeWidth: spec.strokeWidth ?? 2,
    strokeStyle: spec.strokeStyle ?? "solid",
    roughness: spec.roughness ?? 1,
    opacity: spec.opacity ?? 100,
    groupIds: [],
    frameId: spec.frame ? byId(s, spec.frame).id : null,
    index: nextIndex(s),
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: spec.link ?? null,
    locked: false,
  };
}

function textEl(s: CanvasScene, spec: ElementSpec, container?: El): El {
  const fontSize = spec.fontSize ?? 20;
  const text = String(spec.text ?? "");
  const m = measure(text, fontSize);
  const t = base(s, "text", { ...spec, background: "transparent", width: m.width, height: m.height });
  Object.assign(t, {
    text,
    originalText: text,
    fontSize,
    fontFamily: spec.font ? (FONTS[spec.font.toLowerCase()] ?? Number(spec.font)) || 5 : 5,
    textAlign: spec.align ?? (container ? "center" : "left"),
    verticalAlign: container ? "middle" : "top",
    containerId: container?.id ?? null,
    autoResize: true,
    lineHeight: 1.25,
  });
  if (container) placeLabel(t, container);
  return t;
}

/** Centres a bound label on its shape, or on an arrow's middle. */
function placeLabel(t: El, c: El) {
  const m = measure(String(t.text), t.fontSize);
  if (c.type === "arrow" || c.type === "line") {
    const p = c.points as [number, number][];
    const a = p[0], b = p[p.length - 1];
    const mx = c.x + (a[0] + b[0]) / 2, my = c.y + (a[1] + b[1]) / 2;
    Object.assign(t, { width: m.width, height: m.height, x: mx - m.width / 2, y: my - m.height / 2 });
    return;
  }
  const w = Math.min(m.width, Math.max(20, c.width - 10));
  Object.assign(t, { width: w, height: m.height, x: c.x + (c.width - w) / 2, y: c.y + (c.height - m.height) / 2 });
}

/** Where a line from the shape's centre toward (tx, ty) leaves the shape, `gap` further out. */
function edgePoint(e: El, tx: number, ty: number, gap = 8): [number, number] {
  const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const a = Math.max(1, e.width / 2), b = Math.max(1, e.height / 2);
  const t = e.type === "ellipse" ? 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2) : e.type === "diamond" ? 1 / (Math.abs(dx) / a + Math.abs(dy) / b) : Math.min(a / Math.abs(dx || 1e-9), b / Math.abs(dy || 1e-9));
  const len = Math.hypot(dx, dy);
  return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap];
}

const centre = (e: El): [number, number] => [e.x + e.width / 2, e.y + e.height / 2];

function bind(e: El, id: string, type: "arrow" | "text") {
  e.boundElements = [...(e.boundElements ?? []).filter((b: any) => b.id !== id), { type, id }];
  touch(e);
}
const touch = (e: El) => {
  e.version = (e.version ?? 1) + 1;
  e.versionNonce = seed();
  e.updated = Date.now();
};

/** Points an arrow or line runs through, from one element to another, along its points, or across its box. */
function route(s: CanvasScene, el: El, spec: ElementSpec) {
  if (spec.from || spec.to) {
    const A = spec.from ? byId(s, spec.from) : null, B = spec.to ? byId(s, spec.to) : null;
    const target = (E: El | null, fallback: [number, number]) => (E ? centre(E) : fallback);
    const start = A ? edgePoint(A, ...target(B, [spec.x ?? 0, spec.y ?? 0])) : [spec.x ?? 0, spec.y ?? 0];
    const end = B ? edgePoint(B, ...target(A, start as [number, number])) : [start[0] + (spec.width ?? 200), start[1] + (spec.height ?? 0)];
    el.x = start[0];
    el.y = start[1];
    el.points = [[0, 0], [end[0] - start[0], end[1] - start[1]]];
    el.startBinding = A ? { elementId: A.id, focus: 0, gap: 8 } : null;
    el.endBinding = B ? { elementId: B.id, focus: 0, gap: 8 } : null;
    if (A) bind(A, el.id, "arrow");
    if (B) bind(B, el.id, "arrow");
  } else if (spec.points?.length) {
    if (spec.points.length < 2 || spec.points.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) throw new EtudeError("points is a list of [x, y] pairs, two or more");
    el.points = spec.points.map(([x, y]) => [x, y]);
  } else if (!el.points) el.points = [[0, 0], [spec.width ?? 200, spec.height ?? 0]];
  const xs = el.points.map((p: number[]) => p[0]), ys = el.points.map((p: number[]) => p[1]);
  el.width = Math.max(...xs) - Math.min(...xs);
  el.height = Math.max(...ys) - Math.min(...ys);
}

/** Adds an element (and its label, if it has words). Returns the scene and the new element's id. */
export function addElement(scene: CanvasScene, type: string, spec: ElementSpec): { scene: CanvasScene; id: string; label?: string } {
  if (!SHAPES.includes(type as Shape)) throw new EtudeError(`"${type}" isn't something a canvas draws: ${SHAPES.join(", ")}`);
  const s: CanvasScene = structuredClone(scene);
  if (type === "text") {
    if (!spec.text) throw new EtudeError("a text element needs --text");
    const t = textEl(s, spec);
    s.elements.push(t);
    return { scene: s, id: t.id };
  }
  const el = base(s, type, { width: 200, height: type === "frame" ? 200 : 100, ...spec, ...(type === "image" || type === "frame" ? { background: "transparent" } : {}) });
  if (type === "rectangle" || type === "diamond") el.roundness = spec.rounded === false ? null : { type: 3 };
  if (type === "frame") Object.assign(el, { name: spec.text ?? null, strokeColor: "#bbb", roughness: 0, fillStyle: "solid" });
  if (type === "arrow" || type === "line") {
    Object.assign(el, { roundness: { type: 2 }, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: type === "arrow" ? (spec.head === "none" ? null : spec.head ?? "arrow") : null, elbowed: false });
    if (type === "line") el.polygon = false;
    route(s, el, spec);
  }
  if (type === "image") {
    if (!spec.image) throw new EtudeError("a picture needs --file");
    const fileId = nid() + nid();
    s.files[fileId] = { mimeType: spec.image.mimeType, media: spec.image.media, created: Date.now() };
    const w = spec.width ?? Math.min(spec.image.width ?? 400, 600);
    const h = spec.height ?? (spec.image.width && spec.image.height ? Math.round((w * spec.image.height) / spec.image.width) : 300);
    Object.assign(el, { fileId, status: "saved", scale: [1, 1], crop: null, width: w, height: h, strokeColor: "transparent" });
  }
  s.elements.push(el);
  let label: string | undefined;
  if (spec.text && type !== "image" && type !== "frame") {
    const t = textEl(s, { text: spec.text, fontSize: spec.fontSize, font: spec.font, color: spec.color, align: spec.align }, el);
    s.elements.push(t);
    bind(el, t.id, "text");
    el.version = 1;
    label = t.id;
  }
  return { scene: s, id: el.id, label };
}

export interface ElementPatch extends Omit<ElementSpec, "image" | "points"> {
  points?: [number, number][];
  /** Move it by this much. */
  dx?: number;
  dy?: number;
  /** In front of everything, or behind it. */
  order?: "front" | "back";
}

/** Changes an element: its words, colours, place, size, ends (arrows), or its place in front or behind. */
export function editElement(scene: CanvasScene, id: string, patch: ElementPatch): { scene: CanvasScene; id: string } {
  const s: CanvasScene = structuredClone(scene);
  let el = byId(s, id);
  // The label of a shape is edited through the shape, and the other way round.
  const label = () => live(s).find((e) => e.type === "text" && e.containerId === el.id);
  if (el.type === "text" && el.containerId && (patch.x !== undefined || patch.y !== undefined || patch.dx !== undefined || patch.dy !== undefined || patch.width !== undefined || patch.height !== undefined)) el = byId(s, el.containerId);
  const moveBy = (dx: number, dy: number) => {
    el.x += dx;
    el.y += dy;
    const t = label();
    if (t) (t.x += dx), (t.y += dy), touch(t);
    if (el.type === "frame") for (const c of live(s).filter((e) => e.frameId === el.id)) (c.x += dx), (c.y += dy), touch(c);
  };
  if (patch.x !== undefined || patch.y !== undefined) moveBy((patch.x ?? el.x) - el.x, (patch.y ?? el.y) - el.y);
  if (patch.dx || patch.dy) moveBy(patch.dx ?? 0, patch.dy ?? 0);
  if (patch.width !== undefined) el.width = patch.width;
  if (patch.height !== undefined) el.height = patch.height;
  if (patch.color !== undefined) el.strokeColor = color(patch.color);
  if (patch.background !== undefined) el.backgroundColor = color(patch.background, true);
  for (const k of ["fill", "strokeWidth", "strokeStyle", "roughness", "opacity", "link"] as const) if (patch[k] !== undefined) el[k === "fill" ? "fillStyle" : k] = patch[k];
  if (patch.rounded !== undefined && (el.type === "rectangle" || el.type === "diamond")) el.roundness = patch.rounded ? { type: 3 } : null;
  if (patch.frame !== undefined) el.frameId = patch.frame ? byId(s, patch.frame).id : null;
  if ((el.type === "arrow" || el.type === "line") && (patch.from !== undefined || patch.to !== undefined || patch.points)) {
    // Unbind the old ends before routing to the new ones.
    for (const end of [el.startBinding, el.endBinding]) {
      const other = end && live(s).find((e) => e.id === end.elementId);
      if (other) (other.boundElements = (other.boundElements ?? []).filter((b: any) => b.id !== el.id)), touch(other);
    }
    route(s, el, { from: patch.from ?? el.startBinding?.elementId, to: patch.to ?? el.endBinding?.elementId, points: patch.points, x: el.x, y: el.y });
  }
  if (patch.head !== undefined && el.type === "arrow") el.endArrowhead = patch.head === "none" ? null : patch.head;
  if (patch.text !== undefined) {
    if (el.type === "text") {
      el.text = el.originalText = patch.text;
      const m = measure(patch.text, el.fontSize);
      if (!el.containerId) (el.width = m.width), (el.height = m.height);
      else placeLabel(el, byId(s, el.containerId));
    } else if (el.type === "frame") el.name = patch.text;
    else {
      const t = label();
      if (t) (t.text = t.originalText = patch.text), placeLabel(t, el), touch(t);
      else if (patch.text) {
        const nt = textEl(s, { text: patch.text, color: el.strokeColor }, el);
        s.elements.push(nt);
        bind(el, nt.id, "text");
      }
    }
  }
  if (el.type === "text" && (patch.fontSize !== undefined || patch.font !== undefined || patch.align !== undefined)) {
    if (patch.fontSize !== undefined) el.fontSize = patch.fontSize;
    if (patch.font !== undefined) el.fontFamily = (FONTS[patch.font.toLowerCase()] ?? Number(patch.font)) || el.fontFamily;
    if (patch.align !== undefined) el.textAlign = patch.align;
    const m = measure(el.text, el.fontSize);
    if (!el.containerId) (el.width = m.width), (el.height = m.height);
  }
  if (patch.width !== undefined || patch.height !== undefined) {
    const t = label();
    if (t) placeLabel(t, el), touch(t);
  }
  // Arrows bound to it follow it.
  for (const b of el.boundElements ?? []) {
    const a = b.type === "arrow" && live(s).find((e) => e.id === b.id);
    if (!a) continue;
    route(s, a, { from: a.startBinding?.elementId, to: a.endBinding?.elementId });
    touch(a);
    const t = live(s).find((e) => e.type === "text" && e.containerId === a.id);
    if (t) placeLabel(t, a), touch(t);
  }
  if (patch.order) {
    const group = [el, ...live(s).filter((e) => e.containerId === el.id)];
    s.elements = s.elements.filter((e) => !group.includes(e as El));
    const idx = (live(s).map((e) => e.index).filter(validKey) as string[]).sort();
    let lo = patch.order === "front" ? idx.at(-1) ?? null : null;
    const hi = patch.order === "back" ? idx[0] ?? null : null;
    for (const g of group) lo = g.index = keyBetween(lo, hi);
    if (patch.order === "front") s.elements.push(...group);
    else s.elements.unshift(...group);
  }
  touch(el);
  return { scene: s, id: el.id };
}

/** Removes elements, with their labels, and lets go of arrows that pointed at them. */
export function deleteElements(scene: CanvasScene, ids: string[]): { scene: CanvasScene; removed: string[] } {
  const s: CanvasScene = structuredClone(scene);
  const gone = new Set(ids.map((id) => byId(s, id).id));
  for (const e of live(s)) if (e.containerId && gone.has(e.containerId)) gone.add(e.id);
  for (const e of live(s)) {
    if (gone.has(e.id)) continue;
    let changed = false;
    if (e.boundElements?.some((b: any) => gone.has(b.id))) (e.boundElements = e.boundElements.filter((b: any) => !gone.has(b.id))), (changed = true);
    for (const k of ["startBinding", "endBinding"]) if (e[k] && gone.has(e[k].elementId)) (e[k] = null), (changed = true);
    if (e.frameId && gone.has(e.frameId)) (e.frameId = null), (changed = true);
    if (changed) touch(e);
  }
  const fileIds = new Set(live(s).filter((e) => gone.has(e.id) && e.fileId).map((e) => e.fileId));
  s.elements = s.elements.filter((e) => !gone.has(e.id as string));
  for (const f of fileIds) if (!live(s).some((e) => e.fileId === f)) delete s.files[f];
  return { scene: s, removed: [...gone] };
}

/** What's on a canvas, back to front: each element's id, kind, box, words and ends. */
export function listElements(scene: CanvasScene) {
  const all = live(scene);
  const labelOf = (e: El) => all.find((t) => t.type === "text" && t.containerId === e.id)?.text ?? null;
  const r = (n: number) => Math.round(n);
  return all
    .filter((e) => !(e.type === "text" && e.containerId))
    .map((e) => ({
      id: e.id,
      type: e.type,
      x: r(e.x),
      y: r(e.y),
      width: r(e.width),
      height: r(e.height),
      ...(e.type === "text" ? { text: e.text } : labelOf(e) ? { text: labelOf(e) } : e.type === "frame" && e.name ? { text: e.name } : {}),
      ...(e.startBinding || e.endBinding ? { from: e.startBinding?.elementId ?? null, to: e.endBinding?.elementId ?? null } : {}),
      ...(e.strokeColor !== "#1e1e1e" && e.type !== "image" ? { color: e.strokeColor } : {}),
      ...(e.backgroundColor && e.backgroundColor !== "transparent" ? { background: e.backgroundColor } : {}),
      ...(e.frameId ? { frame: e.frameId } : {}),
      ...(e.link ? { link: e.link } : {}),
    }));
}

/** A picture's size in pixels, read from its first bytes (PNG, GIF, JPEG, WebP), or null. */
export function imageSize(d: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
