// Image occlusion helpers shared by the engine, the CLI and the Anki importer: box parsing,
// pixel-to-fraction conversion and the shape checks the editor and `occlusion add` rely on.
import { imageSize } from "./image-size.ts";

export interface OcclusionBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  group?: string;
}

export class OcclusionError extends Error {}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * `"x,y,w,h=Label"`, `"x,y,w,h@group=Label"` or `"x,y,w,h"` (no label: self-graded).
 * Numbers are fractions of the image unless `px` gives its size in pixels.
 */
export function parseBoxSpec(spec: string): Omit<OcclusionBox, "id"> & { id?: string } {
  const m = /^\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*(?:@\s*([\w-]+)\s*)?(?:=(.*))?$/s.exec(spec);
  if (!m) throw new OcclusionError(`box "${spec}" should look like x,y,w,h=Label (or x,y,w,h@group=Label)`);
  const [x, y, w, h] = m.slice(1, 5).map(Number);
  if (![x, y, w, h].every(Number.isFinite)) throw new OcclusionError(`box "${spec}" has a coordinate that isn't a number`);
  return { x, y, w, h, label: (m[6] ?? "").trim(), ...(m[5] ? { group: m[5] } : {}) };
}

/** Checks and normalises a box list: ids filled in and unique, coordinates in 0..1 (or converted from pixels). */
export function normalizeBoxes(raw: unknown[], opts: { px?: { width: number; height: number } } = {}): OcclusionBox[] {
  const out: OcclusionBox[] = [];
  const used = new Set<string>();
  raw.forEach((b: any, i) => {
    if (!b || typeof b !== "object") throw new OcclusionError(`box ${i + 1} must be an object`);
    let { x, y, w, h } = b;
    if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) throw new OcclusionError(`box ${i + 1} needs numbers x, y, w and h`);
    if (opts.px) {
      x /= opts.px.width;
      w /= opts.px.width;
      y /= opts.px.height;
      h /= opts.px.height;
    }
    if (w <= 0 || h <= 0) throw new OcclusionError(`box ${i + 1} has no area`);
    if (x < -0.001 || y < -0.001 || x + w > 1.001 || y + h > 1.001)
      throw new OcclusionError(`box ${i + 1} (${[x, y, w, h].map((v) => r4(v)).join(", ")}) is outside the image; coordinates are fractions from 0 to 1${opts.px ? "" : " (use --px for pixels)"}`);
    let id = typeof b.id === "string" && /^[\w-]+$/.test(b.id) ? b.id : "";
    if (!id || used.has(id)) {
      let n = i + 1;
      while (used.has(`b${n}`) || raw.some((o: any) => o?.id === `b${n}` && o !== b)) n++;
      id = `b${n}`;
    }
    used.add(id);
    const box: OcclusionBox = { id, x: r4(Math.max(0, x)), y: r4(Math.max(0, y)), w: r4(Math.min(w, 1 - Math.max(0, x))), h: r4(Math.min(h, 1 - Math.max(0, y))), label: String(b.label ?? "").trim() };
    if (b.group) box.group = String(b.group);
    out.push(box);
  });
  return out;
}

export function imagePixels(bytes: Buffer, name: string) {
  const size = imageSize(bytes);
  if (!size || !size.width || !size.height) throw new OcclusionError(`couldn't read the pixel size of ${name}; give coordinates as fractions instead of --px`);
  return size;
}
