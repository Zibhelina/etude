// The reading side of what a reply in Ask can show (web/src/components/agent-rich.tsx draws it): the reply's
// text split into Markdown and the things between it, and a chart's JSON in its one form. No React here, so
// the tests read it as it is.

export type Seg =
  | { kind: "md"; text: string }
  | { kind: "widget"; body: string; bare?: boolean }
  | { kind: "chart"; body: string }
  | { kind: "note"; body: string }
  | { kind: "media"; src: string; alt: string }
  | { kind: "sticker"; src: string }
  | { kind: "cards"; attrs: Record<string, string> }
  | { kind: "pending"; what: string }
  | { kind: "open"; note: string; side: "left" | "right" | "top" | "bottom" }
  | { kind: "row"; cols: Seg[][]; widths: number[] }
  | { kind: "aside"; aside: Seg[]; body: Seg[]; side: "left" | "right"; width: string };

/** `:::row` opens columns side by side, `:::col` starts the next one, a bare `:::` closes the row. */
const ROW_OPEN = /^[ \t]*:::row(?:\{([^\n]*)\})?[ \t]*$/;
const ROW_COL = /^[ \t]*:::col[ \t]*$/;
const ROW_CLOSE = /^[ \t]*:::[ \t]*$/;
/** `:::aside` … `:::` floats a box (an infobox, a picture, a widget) and the text after it wraps around,
 *  until a `:::clear` line or the end of the reply. */
const ASIDE_OPEN = /^[ \t]*:::aside(?:\{([^\n]*)\})?[ \t]*$/;
const ASIDE_CLEAR = /^[ \t]*:::clear[ \t]*$/;

/** Lines from `from` up to the first one `stop` accepts outside a code fence and outside any nested
 *  :::row/:::aside (fences are taken whole and nested blocks up to their own `:::`, so neither can end this
 *  block). Returns where it stopped: lines.length if nothing did. */
function collect(lines: string[], from: number, stop: (l: string) => boolean, take: (l: string) => void): number {
  let fence: string | null = null;
  let depth = 0;
  let j = from;
  for (; j < lines.length; j++) {
    const l = lines[j];
    const ff = FENCE.exec(l);
    if (fence) {
      if (l.trimEnd() === fence || (l.startsWith(fence) && /^[`~]+\s*$/.test(l))) fence = null;
    } else if (ff) fence = ff[1];
    else if (ROW_OPEN.test(l) || ASIDE_OPEN.test(l)) depth++;
    else if (depth > 0 && ROW_CLOSE.test(l)) depth--;
    else if (depth === 0 && stop(l)) break;
    take(l);
  }
  return j;
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*$/;
const RICH_FENCE = new Set(["widget", "chart", "note"]);
const DIRECTIVE = /^[ \t]*::([a-z]+)\{([^\n]*)\}[ \t]*$/;
const MEDIA_LINE = /^[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$/;
const IMAGE_LINE = /^[ \t]*!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)[ \t]*$/;

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** A reply's text as runs of Markdown and the things to show between them. `live`: it's still being written. */
export function richSegments(text: string, live = false): Seg[] {
  const out: Seg[] = [];
  let md: string[] = [];
  const flush = () => {
    if (md.join("\n").trim()) out.push({ kind: "md", text: md.join("\n") });
    md = [];
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const row = ROW_OPEN.exec(line);
    if (row) {
      // Columns: each one is a reply of its own; one still being written shows as it grows.
      const cols: string[][] = [[]];
      let marker = false;
      const j = collect(lines, i + 1, (l) => {
        if (ROW_CLOSE.test(l)) return true;
        if (ROW_COL.test(l)) (cols.push([]), (marker = true));
        return false;
      }, (l) => {
        if (marker) marker = false;
        else cols[cols.length - 1].push(l);
      });
      const segs = cols.map((c) => richSegments(c.join("\n"), live && j >= lines.length)).filter((s) => s.length);
      const want = (attrsOf(row[1] ?? "").widths ?? "").split(/[\s,:]+/).map(Number).filter((n) => n > 0);
      if (segs.length) {
        flush();
        out.push({ kind: "row", cols: segs, widths: segs.map((_, k) => want[k] ?? 1) });
      }
      i = j;
      continue;
    }
    const aside = ASIDE_OPEN.exec(line);
    if (aside) {
      const box: string[] = [];
      const j = collect(lines, i + 1, (l) => ROW_CLOSE.test(l), (l) => box.push(l));
      const body: string[] = [];
      const k = j >= lines.length ? j : collect(lines, j + 1, (l) => ASIDE_CLEAR.test(l), (l) => body.push(l));
      const a = attrsOf(aside[1] ?? "");
      const width = /^\d{1,3}(?:\.\d+)?(?:%|px|em)$/.test(a.width ?? "") ? a.width : "40%";
      const boxSegs = richSegments(box.join("\n"), live && j >= lines.length);
      if (boxSegs.length) {
        flush();
        out.push({ kind: "aside", aside: boxSegs, body: richSegments(body.join("\n"), live && k >= lines.length), side: a.side === "left" ? "left" : "right", width });
      }
      i = k;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      const rich = RICH_FENCE.has(f[2]);
      let end = i + 1;
      while (end < lines.length && !(lines[end].trimEnd() === f[1] || (lines[end].startsWith(f[1]) && /^[`~]+\s*$/.test(lines[end])))) end++;
      const closed = end < lines.length;
      if (!rich) {
        // Any other code block stays Markdown, marks inside it included.
        md.push(...lines.slice(i, end + 1));
      } else {
        flush();
        const body = lines.slice(i + 1, end).join("\n");
        if (!closed && live) out.push({ kind: "pending", what: f[2] });
        // A widget sits on the chat itself; ```widget card (or frame=card) puts it in a card.
        else if (f[2] === "widget") out.push({ kind: "widget", body, bare: !/\b(?:card|frame=card)\b/.test(line) });
        else out.push({ kind: f[2] as "widget" | "chart" | "note", body });
      }
      i = end;
      continue;
    }
    // The last line of a reply still being written may be half a path: wait for the rest.
    if (live && i === lines.length - 1 && (/^[ \t]*(MEDIA:|::[a-z]+\{)/.test(line) || /^[ \t]*!\[[^\]]*\]\(/.test(line))) {
      flush();
      out.push({ kind: "pending", what: "file" });
      continue;
    }
    const d = DIRECTIVE.exec(line);
    if (d) {
      const a = attrsOf(d[2]);
      const src = a.file ?? a.src ?? a.url ?? "";
      let seg: Seg | null = null;
      if (d[1] === "sticker" && src) seg = { kind: "sticker", src };
      // ::open{note="id" side="right"}: the note opens in a pane beside the chat.
      else if (d[1] === "open" && a.note) seg = { kind: "open", note: a.note, side: (["left", "right", "top", "bottom"] as const).find((x) => x === (a.side === "below" ? "bottom" : a.side === "above" ? "top" : a.side)) ?? "right" };
      else if ((d[1] === "card" && a.id) || (d[1] === "cards" && (a.deck || a.q))) seg = { kind: "cards", attrs: a };
      else if (d[1] === "preview" && src) seg = { kind: "widget", body: JSON.stringify({ file: src, height: a.height ? Number(a.height) : undefined }) };
      else if (d[1] === "widget" && src) seg = { kind: "widget", body: JSON.stringify(a.url ? { url: a.url, height: a.height ? Number(a.height) : undefined } : { file: src }) };
      else if (["image", "audio", "voice", "video", "pdf", "file", "media"].includes(d[1]) && src) seg = { kind: "media", src, alt: a.alt ?? a.title ?? "" };
      if (seg) {
        flush();
        out.push(seg);
        continue;
      }
    }
    const m = MEDIA_LINE.exec(line);
    if (m) {
      flush();
      out.push({ kind: "media", src: m[1].replace(/^<|>$/g, ""), alt: "" });
      continue;
    }
    const img = IMAGE_LINE.exec(line);
    if (img) {
      flush();
      out.push({ kind: "media", src: img[2], alt: img[1] });
      continue;
    }
    md.push(line);
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ files

const OWN = /^\/(api|media|type-assets|embed|runtime)\//;

/** Written as a file on the agent's computer ("~/a.png", "file:///a.png", "/tmp/a.png"), not a web or app address. */
export function isLocalPath(src: string): boolean {
  return src.startsWith("~/") || src.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(src) || (src.startsWith("/") && !src.startsWith("//") && !OWN.test(src));
}

// ------------------------------------------------------------------ charts

type Series = { name: string; data: number[] };
export interface ChartSpec {
  type: "line" | "bar" | "area" | "pie" | "donut" | "scatter";
  title?: string;
  /** "card" puts it in a card; by default it sits on the chat. */
  frame?: "card" | "none";
  x: string[];
  series: Series[];
  points?: { name: string; data: [number, number][] }[];
  unit: string;
  stacked: boolean;
}

export const PALETTE = ["var(--highlight)", "var(--nc-blue)", "var(--nc-orange)", "var(--nc-purple)", "var(--nc-green)", "var(--nc-pink)", "var(--nc-yellow)", "var(--nc-red)", "var(--nc-brown)", "var(--nc-gray)"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : NaN);

/** The forms a chart can be written in, as one. Null when there's nothing to draw. */
export function chartSpec(body: string): ChartSpec | null {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const type = ["line", "bar", "area", "pie", "donut", "scatter"].includes(j.type) ? j.type : "bar";
  let x: string[] = (j.x ?? j.labels ?? j.categories ?? []).map(String);
  let series: Series[] = [];
  const points: ChartSpec["points"] = [];
  const raw = Array.isArray(j.series) ? j.series : j.data !== undefined ? [{ name: j.name ?? "", data: j.data }] : j.y !== undefined ? [{ name: j.name ?? "", data: j.y }] : j.values !== undefined ? [{ name: j.name ?? "", data: j.values }] : [];
  for (const s of raw) {
    const name = String(s?.name ?? "");
    let d = s?.data ?? s?.values ?? s;
    if (d && !Array.isArray(d) && typeof d === "object") {
      // {"A": 1, "B": 2}
      if (!x.length) x = Object.keys(d);
      d = Object.values(d);
    }
    if (!Array.isArray(d)) continue;
    if (d.length && d.every((p: unknown) => Array.isArray(p) && p.length >= 2)) {
      if (type === "scatter") points.push({ name, data: d.map((p: unknown[]) => [num(p[0]), num(p[1])] as [number, number]).filter((p: number[]) => !Number.isNaN(p[0]) && !Number.isNaN(p[1])) });
      else {
        if (!x.length) x = d.map((p: unknown[]) => String(p[0]));
        series.push({ name, data: d.map((p: unknown[]) => num(p[1])) });
      }
    } else if (d.length && d.every((p: unknown) => p && typeof p === "object" && !Array.isArray(p))) {
      // [{label, value}] or [{x, y}]
      if (type === "scatter") points.push({ name, data: d.map((p: any) => [num(p.x), num(p.y)] as [number, number]).filter((p: number[]) => !Number.isNaN(p[0]) && !Number.isNaN(p[1])) });
      else {
        if (!x.length) x = d.map((p: any) => String(p.label ?? p.name ?? p.x ?? ""));
        series.push({ name, data: d.map((p: any) => num(p.value ?? p.y)) });
      }
    } else series.push({ name, data: d.map(num) });
  }
  series = series.filter((s) => s.data.some((v) => !Number.isNaN(v)));
  if (type === "scatter" ? !points.some((p) => p.data.length) : !series.length) return null;
  const n = Math.max(0, ...series.map((s) => s.data.length));
  if (x.length < n) x = [...x, ...Array.from({ length: n - x.length }, (_, i) => String(x.length + i + 1))];
  const frame = j.frame === "card" || j.frame === "none" ? j.frame : undefined;
  return { frame, type, title: typeof j.title === "string" ? j.title : undefined, x, series, points, unit: typeof j.unit === "string" ? j.unit : "", stacked: !!j.stacked };
}
