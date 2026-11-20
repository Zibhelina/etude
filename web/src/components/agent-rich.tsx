// What a reply in Ask shows besides text. The agent writes plain text; marks in it become widgets, charts,
// flashcards, note blocks, stickers and media (pictures, a voice player, video, PDFs). The server's side of
// this, and the words the agent is told, are in src/core/agent-show.ts.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Loader2, PanelRight, Pause, Play, X } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { HtmlFrame, PdfDocument } from "@/editor/note-embed";
import { NoteEditor } from "@/editor/note-editor";
import { apiToken } from "@/lib/transport";
import { EtudeImg, useEtudeSrc } from "@/lib/local-url";
import { navigate, withBase } from "@/lib/router";
import type { NoteDoc } from "@/lib/api";
import { chartSpec, isLocalPath, PALETTE, richSegments, type Seg } from "@/lib/agent-rich";

export { richSegments };
import { cn } from "@/lib/utils";

/** Where the reply is: its chat (for files it names) and how a widget talks back. */
export interface RichHost {
  conv: string;
  /** The saved reply, so a file it showed comes from the copy kept with it. */
  message?: number;
  /** A widget or a finished card session sends this as the user's next message. */
  send?(text: string): void;
}

export const RichContext = createContext<RichHost>({ conv: "" });

// ------------------------------------------------------------------ files

/** The address a reply's file loads from. */
export function shownUrl(host: RichHost, src: string): string {
  if (!isLocalPath(src)) return src;
  const token = apiToken();
  return `/api/agent/conversations/${host.conv}/shown?path=${encodeURIComponent(src)}${host.message ? `&m=${host.message}` : ""}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
}

type MediaKind = "image" | "audio" | "video" | "pdf" | "html" | "file";
const KINDS: [MediaKind, RegExp][] = [
  ["image", /\.(png|jpe?g|webp|gif|avif|svg)$/i],
  ["audio", /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i],
  ["video", /\.(mp4|webm|mov)$/i],
  ["pdf", /\.pdf$/i],
  ["html", /\.html?$/i],
];

function mediaKind(src: string): MediaKind {
  const path = src.split(/[?#]/)[0];
  for (const [k, re] of KINDS) if (re.test(path)) return k;
  // A web picture often has no extension in its address.
  return /^(https?:|data:image\/)/.test(src) ? "image" : "file";
}

const fileName = (src: string) => decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() || src);

/** Markdown inside a reply: pictures written as local paths load through the chat. */
function localImages(text: string, host: RichHost): string {
  return text.replace(/(!\[[^\]]*\]\()<?([^)\s>]+)>?/g, (all, open: string, src: string) => (isLocalPath(src) ? `${open}${shownUrl(host, src)}` : all));
}

// ------------------------------------------------------------------ the pieces

export function Zoom({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  // On the page itself: the chat panel slides with a transform, which would pin a fixed layer inside it.
  return createPortal(
    <div role="dialog" data-state="open" aria-label={alt || "Picture"} className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-6" onClick={(e) => (e.stopPropagation(), onClose())}>
      <EtudeImg src={src} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" />
      <button type="button" aria-label="Close" className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20">
        <X className="size-4" />
      </button>
    </div>,
    document.body,
  );
}

function Picture({ src, alt, sticker = false }: { src: string; alt: string; sticker?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return <Missing name={alt || fileName(src)} />;
  if (sticker) return <EtudeImg src={src} alt={alt} draggable={false} onError={() => setGone(true)} className="achat-sticker" />;
  return (
    <>
      <button type="button" className="achat-picture" onClick={() => setZoom(true)} aria-label={alt ? `Open ${alt}` : "Open picture"}>
        <EtudeImg src={src} alt={alt} onError={() => setGone(true)} />
      </button>
      {zoom && <Zoom src={src} alt={alt} onClose={() => setZoom(false)} />}
    </>
  );
}

function Missing({ name }: { name: string }) {
  return (
    <div className="achat-file text-muted-foreground">
      <FileText className="size-4 shrink-0" />
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-xs">isn't there anymore</span>
    </div>
  );
}

const clock = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
const SPEEDS = [1, 1.5, 2];

/** The same bars every time for one file, so a voice note keeps its shape. */
function bars(seed: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) + i;
    const r = ((h >>> 0) % 1000) / 1000;
    // Louder in the middle of phrases, like speech.
    out.push(0.25 + 0.75 * r * (0.55 + 0.45 * Math.sin((i / n) * Math.PI * 5 + (seed.length % 7))) ** 2 + 0.05);
  }
  return out.map((v) => Math.max(0.16, Math.min(1, v)));
}

export function VoicePlayer({ src, name }: { src: string; name: string }) {
  const url = useEtudeSrc(src);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [len, setLen] = useState(NaN);
  const [speed, setSpeed] = useState(1);
  const [gone, setGone] = useState(false);
  const shape = useMemo(() => bars(src, 44), [src]);
  if (gone) return <Missing name={name} />;
  const frac = len > 0 ? Math.min(1, at / len) : 0;
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a || !(len > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * len;
    setAt(a.currentTime);
  };
  return (
    <div className="achat-voice" data-agent-voice>
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration)}
        onDurationChange={(e) => setLen(e.currentTarget.duration)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setAt(0))}
        onError={() => setGone(true)}
      />
      <button type="button" aria-label={playing ? "Pause" : "Play"} className="achat-voice-play" onClick={() => (playing ? audio.current?.pause() : void audio.current?.play().catch(() => {}))}>
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
      </button>
      <div className="achat-voice-wave" role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(len) || 0} aria-valuenow={Math.round(at)} tabIndex={0} onPointerDown={seek} onPointerMove={(e) => e.buttons === 1 && seek(e)} onKeyDown={(e) => {
        const a = audio.current;
        if (!a) return;
        if (e.key === "ArrowRight") a.currentTime = Math.min(len || 0, a.currentTime + 5);
        if (e.key === "ArrowLeft") a.currentTime = Math.max(0, a.currentTime - 5);
      }}>
        {shape.map((v, i) => (
          <i key={i} style={{ height: `${Math.round(v * 100)}%` }} className={(i + 0.5) / shape.length <= frac ? "is-on" : undefined} />
        ))}
      </div>
      <span className="achat-voice-time">{clock(playing || at > 0 ? at : len)}</span>
      <button
        type="button"
        className="achat-voice-speed"
        aria-label="Speed"
        onClick={() => {
          const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
          setSpeed(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
      >
        {speed}×
      </button>
    </div>
  );
}

function Video({ src }: { src: string }) {
  const url = useEtudeSrc(src);
  return <video src={url} controls playsInline preload="metadata" className="achat-video" />;
}

function Pdf({ src, name }: { src: string; name: string }) {
  return (
    <div className="achat-card achat-pdf">
      <div className="achat-card-head">
        <FileText className="size-3.5" />
        <span className="truncate">{name}</span>
      </div>
      <PdfDocument url={src} name={name} className="h-[420px]" />
    </div>
  );
}

function FileLink({ src, name }: { src: string; name: string }) {
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="achat-file">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </a>
  );
}

// The frame a widget runs in speaks to the chat through etude.send (and hermes.send, so a widget written for
// Lotus works as it is).
// A widget starts out looking like the app: its buttons, fields and headings need no CSS of their own.
const LOOK = `<style>body{padding:10px 12px}button,input,select,textarea{font:inherit;color:inherit}button{padding:7px 14px;border-radius:12px;border:1px solid var(--border);border-bottom-width:3px;background:var(--card);font-weight:550;cursor:pointer;transition:transform .08s,border-bottom-width .08s}button:active{transform:translateY(2px);border-bottom-width:1px;margin-bottom:2px}button.primary{background:var(--primary);border-color:color-mix(in oklab,var(--primary) 72%,#000);color:var(--primary-foreground)}button:disabled{opacity:.5;cursor:default}input,select,textarea{padding:7px 10px;border-radius:10px;border:1px solid var(--border);background:transparent}input[type=range],input[type=checkbox],input[type=radio]{padding:0;accent-color:var(--primary)}h1,h2,h3{margin:.2em 0 .4em;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:650;letter-spacing:-.01em}h1{font-size:1.35em}h2{font-size:1.15em}h3{font-size:1em}a{color:var(--primary)}</style>`;
const BRIDGE = LOOK + `<script>(()=>{const send=t=>{if(navigator.userActivation&&!navigator.userActivation.hasBeenActive)return;parent.postMessage({etudeEmbed:1,send:String(t)},"*")};window.etude=Object.assign(window.etude||{},{send});window.hermes=Object.assign(window.hermes||{},{send});addEventListener("click",e=>{const el=e.target&&e.target.closest&&e.target.closest("[data-etude-send],[data-hermes-send]");if(el)send(el.getAttribute("data-etude-send")||el.getAttribute("data-hermes-send"))})})()</script>`;

function useSend() {
  const host = useContext(RichContext);
  return (t: unknown) => {
    const text = String(t ?? "").trim();
    if (text) host.send?.(text.slice(0, 8000));
  };
}

/** Without a card (`bare`): no box, no padding of its own, the chat's background showing through. */
const BARE = `<style>body{padding:0}</style>`;

function HtmlWidget({ html, height, bare = false }: { html: string; height?: number; bare?: boolean }) {
  const send = useSend();
  return (
    <div className={bare ? "achat-bare" : "achat-card"} data-agent-widget>
      <HtmlFrame html={html} height={height ?? null} title="Widget" head={bare ? BRIDGE + BARE : BRIDGE} onMessage={(d) => "send" in d && send(d.send)} />
    </div>
  );
}

function FileWidget({ src, height, bare = false }: { src: string; height?: number; bare?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let on = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => on && setHtml(t))
      .catch(() => on && setErr(true));
    return () => {
      on = false;
    };
  }, [src]);
  if (err) return <Missing name={fileName(src)} />;
  if (html == null) return <Pending what="widget" />;
  return <HtmlWidget html={html} height={height} bare={bare} />;
}

/** A page from somewhere else (or Etude's own /embed). It can size itself and send a summary the way Lotus widgets do. */
function UrlWidget({ url, height, bare = false }: { url: string; height?: number; bare?: boolean }) {
  const send = useSend();
  const frame = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(height ?? 360);
  const own = url.startsWith("/");
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data;
      if (d?.lotus === 1 && d.type === "resize" && typeof d.height === "number") setH(Math.max(80, Math.min(1400, d.height)));
      else if (d?.lotus === 1 && d.type === "submit" && typeof d.text === "string") send(d.text);
      else if (d?.etudeEmbed === 1 && typeof d.height === "number") setH(Math.max(80, Math.min(1400, d.height)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Only Etude's own /embed route runs as the app (normalized via URL to stop /embed/../settings traversal).
  // External URLs must be http(s) and must never share the app's origin when allow-same-origin is granted.
  let safeUrl: string | null = null;
  let sameOriginEmbed = false;
  try {
    const parsed = new URL(url, location.origin);
    if (own) {
      if (parsed.origin === location.origin && (parsed.pathname === "/embed" || parsed.pathname.startsWith("/embed/"))) {
        safeUrl = withBase(parsed.pathname + parsed.search + parsed.hash);
        sameOriginEmbed = true;
      }
    } else if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin !== location.origin) {
      safeUrl = parsed.href;
    }
  } catch {
    return null;
  }
  if (!safeUrl) return null;
  return (
    <div className={bare ? "achat-bare" : "achat-card"} data-agent-widget>
      <iframe ref={frame} src={safeUrl} title="Widget" className="block w-full border-0" style={{ height: h }} {...(sameOriginEmbed ? {} : { sandbox: "allow-scripts allow-same-origin allow-forms allow-popups", referrerPolicy: "no-referrer" as const })} />
    </div>
  );
}

/** A widget sits on the chat with no card unless asked for one (`"frame": "card"`, or ```widget card).
 *  A page from another site keeps its card: it brings its own background. */
function Widget({ body, bare = true }: { body: string; bare?: boolean }) {
  const host = useContext(RichContext);
  const t = body.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as { url?: string; file?: string; html?: string; height?: number; frame?: string; seamless?: boolean };
      const height = typeof j.height === "number" && j.height > 0 ? j.height : undefined;
      const asked = j.frame === "card" || j.seamless === false ? false : j.frame === "none" || j.seamless === true ? true : null;
      const b = asked ?? (typeof j.url === "string" && !j.file && !j.html ? false : bare);
      if (typeof j.html === "string") return <HtmlWidget html={j.html} height={height} bare={b} />;
      if (typeof j.file === "string" && isLocalPath(j.file)) return <FileWidget src={shownUrl(host, j.file)} height={height} bare={b} />;
      if (typeof j.url === "string") return <UrlWidget url={j.url} height={height} bare={b} />;
    } catch {}
  }
  return <HtmlWidget html={body} bare={bare} />;
}

function Cards({ attrs }: { attrs: Record<string, string> }) {
  const p = new URLSearchParams();
  if (attrs.id) p.set("card", attrs.id);
  else if (attrs.q) p.set("q", attrs.q);
  else p.set("deck", attrs.deck);
  if (!attrs.id) p.set("n", String(Math.max(1, Math.min(50, Number(attrs.n) || 5))));
  p.set("title", attrs.title || (attrs.deck ? attrs.deck.split("::").pop()! : attrs.q || "Card"));
  p.set("host", "note");
  return <UrlWidget url={`/embed?${p}`} height={220} />;
}

const NO_LINKS = { pages: () => [], create: () => Promise.reject(new Error("read only")), open: (id: string) => navigate(`/notes?id=${encodeURIComponent(id)}`), titleOf: () => null };

/** Note blocks, shown the way a page shows them, read only. */
function NoteBlocks({ body }: { body: string }) {
  const doc = useMemo<NoteDoc | null>(() => {
    try {
      const j = JSON.parse(body);
      const content = Array.isArray(j) ? j : j?.type === "doc" ? j.content : j?.type ? [j] : null;
      return Array.isArray(content) && content.length ? { type: "doc", content } : null;
    } catch {
      return null;
    }
  }, [body]);
  if (!doc) return <Markdown className="agent-prose">{body}</Markdown>;
  return (
    <div className="achat-note note-sheet" data-agent-note>
      <NoteEditor doc={doc} editable={false} links={NO_LINKS} onChange={() => {}} />
    </div>
  );
}

function Pending({ what }: { what: string }) {
  return (
    // No card: most of what it turns into sits on the chat itself.
    <div className="flex h-10 items-center gap-2 text-[13px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {what === "chart" ? "Drawing a chart…" : what === "note" ? "Laying it out…" : what === "file" ? "Getting it…" : "Building a widget…"}
    </div>
  );
}

function Media({ src, alt }: { src: string; alt: string }) {
  const host = useContext(RichContext);
  const url = shownUrl(host, src);
  const name = alt || fileName(src);
  switch (mediaKind(src)) {
    case "image":
      return <Picture src={url} alt={alt} />;
    case "audio":
      return <VoicePlayer src={url} name={name} />;
    case "video":
      return <Video src={url} />;
    case "pdf":
      return <Pdf src={url} name={name} />;
    case "html":
      return isLocalPath(src) ? <FileWidget src={url} /> : <UrlWidget url={src} />;
    default:
      return isLocalPath(src) ? <Missing name={name} /> : <FileLink src={url} name={name} />;
  }
}

// ------------------------------------------------------------------ charts

/** Round steps for an axis from lo to hi. */
function ticks(lo: number, hi: number, want = 4): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(a < 10 ? 2 : 1));
};

function Chart({ body }: { body: string }) {
  const spec = useMemo(() => chartSpec(body), [body]);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.floor(el.clientWidth)));
    ro.observe(el);
    setW(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  if (!spec) return <Markdown className="agent-prose">{"```json\n" + body + "\n```"}</Markdown>;
  const { type, x, series, unit } = spec;
  const round = type === "pie" || type === "donut";
  const names = type === "scatter" ? spec.points!.map((p) => p.name) : round ? x : series.map((s) => s.name);
  const legend = round || names.filter(Boolean).length > 1;
  // "%" and "°" sit against the number; a word ("cards") takes a space.
  const word = /^\p{L}{2}/u.test(unit);
  const fmt = (v: number) => `${short(v)}${word ? " " : ""}${unit}`;
  // On the axis a word would repeat on every line; it stays in the readout.
  const tick = (v: number) => (word ? short(v) : fmt(v));
  let plot: React.ReactNode = null;
  let readout: React.ReactNode = null;
  if (w > 0 && round) {
    const data = series[0].data.map((v) => (v > 0 ? v : 0));
    const total = data.reduce((a, b) => a + b, 0) || 1;
    const R = Math.min(96, Math.max(60, w * 0.26));
    const r = type === "donut" ? R * 0.58 : 0;
    let a0 = -Math.PI / 2;
    const arcs = data.map((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number, rad: number) => `${(R + rad * Math.cos(a)).toFixed(2)} ${(R + rad * Math.sin(a)).toFixed(2)}`;
      const full = v / total > 0.9999;
      const d = full
        ? `M ${R} 0 A ${R} ${R} 0 1 1 ${R - 0.01} 0 Z${r ? ` M ${R} ${R - r} A ${r} ${r} 0 1 0 ${R + 0.01} ${R - r} Z` : ""}`
        : r
          ? `M ${p(a0, R)} A ${R} ${R} 0 ${big} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${big} 0 ${p(a0, r)} Z`
          : `M ${R} ${R} L ${p(a0, R)} A ${R} ${R} 0 ${big} 1 ${p(a1, R)} Z`;
      a0 = a1;
      return <path key={i} d={d} fillRule="evenodd" fill={PALETTE[i % PALETTE.length]} opacity={hover == null || hover === i ? 1 : 0.35} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />;
    });
    plot = (
      <svg width={R * 2} height={R * 2} className="shrink-0" role="img" aria-label={spec.title ?? "Chart"}>
        {arcs}
        {type === "donut" && (
          <text x={R} y={R} textAnchor="middle" dominantBaseline="central" className="achat-chart-big">
            {hover != null ? `${Math.round((data[hover] / total) * 100)}%` : fmt(total)}
          </text>
        )}
      </svg>
    );
  } else if (w > 0) {
    const H = Math.round(Math.min(260, Math.max(170, w * 0.52)));
    const scatter = type === "scatter";
    const pts = spec.points ?? [];
    const n = x.length;
    const stacked = spec.stacked && (type === "bar" || type === "area");
    const all = scatter ? pts.flatMap((p) => p.data.map((d) => d[1])) : stacked ? x.map((_, i) => series.reduce((a, s) => a + (Number.isNaN(s.data[i] ?? NaN) ? 0 : Math.max(0, s.data[i])), 0)) : series.flatMap((s) => s.data.filter((v) => !Number.isNaN(v)));
    const lo0 = Math.min(...all);
    const hi0 = Math.max(...all);
    const yt = ticks(type === "bar" || type === "area" || lo0 >= 0 ? Math.min(0, lo0) : lo0, hi0);
    const lo = yt[0];
    const hi = yt[yt.length - 1];
    const left = 8 + Math.max(...yt.map((t) => tick(t).length)) * 6.4;
    const top = 8;
    const bottom = 22;
    const right = 10;
    const pw = Math.max(40, w - left - right);
    const ph = H - top - bottom;
    const Y = (v: number) => top + ph - ((v - lo) / (hi - lo)) * ph;
    const xs = scatter ? pts.flatMap((p) => p.data.map((d) => d[0])) : [];
    const xt = scatter ? ticks(Math.min(...xs), Math.max(...xs), Math.max(2, Math.floor(pw / 70))) : [];
    const band = pw / Math.max(1, n);
    const X = scatter ? (v: number) => left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * pw : type === "bar" ? (i: number) => left + band * (i + 0.5) : (i: number) => left + (n > 1 ? (pw * i) / (n - 1) : pw / 2);
    const every = Math.max(1, Math.ceil((Math.max(...x.map((l) => l.length), 1) * 6.2 + 10) / (type === "bar" ? band : pw / Math.max(1, n - 1))));
    const marks: React.ReactNode[] = [];
    if (scatter) {
      pts.forEach((p, si) => p.data.forEach((d, i) => marks.push(<circle key={`${si}-${i}`} cx={X(d[0])} cy={Y(d[1])} r={3.2} fill={PALETTE[si % PALETTE.length]} opacity={0.85}><title>{`${p.name ? `${p.name}: ` : ""}${short(d[0])}, ${fmt(d[1])}`}</title></circle>)));
    } else if (type === "bar") {
      const k = stacked ? 1 : series.length;
      const bw = Math.min(46, (band * 0.72) / k);
      x.forEach((_, i) => {
        let base = 0;
        series.forEach((s, si) => {
          const v = s.data[i];
          if (v === undefined || Number.isNaN(v)) return;
          const y0 = stacked ? Y(base) : Y(Math.max(lo, Math.min(0, hi)));
          const y1 = stacked ? Y(base + Math.max(0, v)) : Y(v);
          if (stacked) base += Math.max(0, v);
          const cx = X(i) + (stacked ? 0 : (si - (k - 1) / 2) * bw);
          marks.push(<rect key={`${si}-${i}`} x={cx - bw / 2 + 0.5} y={Math.min(y0, y1)} width={Math.max(1, bw - 1)} height={Math.max(1, Math.abs(y1 - y0))} rx={Math.min(4, bw / 3)} fill={PALETTE[si % PALETTE.length]} opacity={hover == null || hover === i ? 1 : 0.45} />);
        });
      });
    } else {
      const base = x.map(() => 0);
      series.forEach((s, si) => {
        const color = PALETTE[si % PALETTE.length];
        const run: [number, number, number][] = [];
        s.data.forEach((v, i) => {
          if (Number.isNaN(v)) return;
          const b = stacked ? base[i] : 0;
          run.push([X(i), Y(b + v), Y(stacked ? b : Math.max(lo, 0))]);
          if (stacked) base[i] += v;
        });
        if (!run.length) return;
        const line = run.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
        if (type === "area") marks.push(<path key={`a${si}`} d={`${line} ${[...run].reverse().map((p) => `L${p[0].toFixed(1)} ${p[2].toFixed(1)}`).join(" ")} Z`} fill={color} opacity={stacked ? 0.55 : 0.16} />);
        marks.push(<path key={`l${si}`} d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
        if (run.length <= 40 || hover != null) run.forEach((p, i) => (run.length <= 40 || i === hover) && marks.push(<circle key={`p${si}-${i}`} cx={p[0]} cy={p[1]} r={hover === i ? 4 : 2.6} fill={color} />));
      });
    }
    const pick = (e: React.PointerEvent<SVGSVGElement>) => {
      if (scatter || !n) return;
      const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
      const i = type === "bar" ? Math.floor((px - left) / band) : Math.round(((px - left) / pw) * (n - 1));
      setHover(i >= 0 && i < n ? i : null);
    };
    plot = (
      <svg width={w} height={H} role="img" aria-label={spec.title ?? "Chart"} onPointerMove={pick} onPointerLeave={() => setHover(null)} className="block touch-pan-y">
        {yt.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + pw} y1={Y(t)} y2={Y(t)} className={t === 0 ? "achat-chart-zero" : "achat-chart-grid"} />
            <text x={left - 6} y={Y(t)} textAnchor="end" dominantBaseline="central" className="achat-chart-tick">{tick(t)}</text>
          </g>
        ))}
        {scatter
          ? xt.map((t) => <text key={t} x={X(t)} y={H - 6} textAnchor="middle" className="achat-chart-tick">{short(t)}</text>)
          : x.map((l, i) => (i % every === 0 ? <text key={i} x={(X as (i: number) => number)(i)} y={H - 6} textAnchor={type !== "bar" && i === 0 && n > 1 ? "start" : type !== "bar" && i === n - 1 && n > 1 ? "end" : "middle"} className={cn("achat-chart-tick", hover === i && "is-on")}>{l}</text> : null))}
        {hover != null && type !== "bar" && !scatter && <line x1={(X as (i: number) => number)(hover)} x2={(X as (i: number) => number)(hover)} y1={top} y2={top + ph} className="achat-chart-zero" />}
        {marks}
      </svg>
    );
    if (hover != null && !scatter) readout = <>{x[hover]}: {series.map((s, si) => (s.data[hover] === undefined || Number.isNaN(s.data[hover]) ? null : <span key={si} style={{ color: series.length > 1 ? PALETTE[si % PALETTE.length] : undefined }}>{series.length > 1 && s.name ? `${s.name} ` : ""}{fmt(s.data[hover])}{" "}</span>))}</>;
  }
  const total = round ? series[0].data.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1 : 1;
  return (
    <div className={cn("achat-chart", spec.frame === "card" ? "achat-card" : "is-bare")} data-agent-chart>
      {(spec.title || readout) && (
        <div className="achat-chart-head">
          {spec.title && <span className="achat-chart-title">{spec.title}</span>}
          <span className="achat-chart-read">{readout}</span>
        </div>
      )}
      <div ref={box} className={cn("min-w-0", round && "flex flex-wrap items-center gap-x-5 gap-y-3")}>
        {plot}
        {legend && (
          <ul className={cn("achat-chart-legend", round && "is-list")}>
            {names.map((name, i) => (
              <li key={i} onPointerEnter={() => round && setHover(i)} onPointerLeave={() => round && setHover(null)}>
                <i style={{ background: PALETTE[i % PALETTE.length] }} />
                <span className="truncate">{name || `Series ${i + 1}`}</span>
                {round && <b>{Math.round((Math.max(0, series[0].data[i] ?? 0) / total) * 100)}%</b>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the reply

/** One thing a reply shows that isn't text. */
export function RichBlock({ seg }: { seg: Exclude<Seg, { kind: "md" }> }) {
  const host = useContext(RichContext);
  switch (seg.kind) {
    case "widget":
      return <Widget body={seg.body} bare={seg.bare ?? true} />;
    case "chart":
      return <Chart body={seg.body} />;
    case "note":
      return <NoteBlocks body={seg.body} />;
    case "media":
      return <Media key={seg.src} src={seg.src} alt={seg.alt} />;
    case "sticker":
      return <Picture src={shownUrl(host, seg.src)} alt="" sticker />;
    case "cards":
      return <Cards attrs={seg.attrs} />;
    case "pending":
      return <Pending what={seg.what} />;
    case "open":
      return <OpenNote seg={seg} />;
    case "row":
      return <Row seg={seg} />;
    case "aside":
      return <Aside seg={seg} />;
  }
}

export const OPEN_NOTE_EVENT = "etude:open-note";
export type OpenNoteDetail = { note: string; side: "left" | "right" | "top" | "bottom"; conv: string; handled?: boolean };
const OPENED_KEY = "etude.agent.opened";

/** A note the reply opens beside the chat (`::open{note side}`): it opens once, when the reply first shows,
 *  and the row under it opens it again. Off the Notebook, the note opens on its own. */
function OpenNote({ seg }: { seg: Extract<Seg, { kind: "open" }> }) {
  const host = useContext(RichContext);
  const open = useCallback(() => {
    const detail: OpenNoteDetail = { note: seg.note, side: seg.side, conv: host.conv };
    window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, { detail }));
    if (!detail.handled) navigate(`/notes?id=${encodeURIComponent(seg.note)}`);
  }, [seg.note, seg.side, host.conv]);
  useEffect(() => {
    const key = `${host.conv}|${seg.note}|${seg.side}`;
    let done: string[] = [];
    try {
      done = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "[]");
    } catch {}
    if (done.includes(key)) return;
    localStorage.setItem(OPENED_KEY, JSON.stringify([...done, key].slice(-200)));
    open();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const where = seg.side === "left" ? "on the left" : seg.side === "top" ? "above" : seg.side === "bottom" ? "below" : "on the right";
  return (
    <button type="button" onClick={open} data-agent-open={seg.note} className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground outline-ring hover:text-foreground focus-visible:outline-2">
      <PanelRight className="size-3.5" />
      Opened {where} · open again
    </button>
  );
}

/** The things of a reply, in order: text runs as prose, the rest as their own blocks. */
function Segs({ segs }: { segs: Seg[] }) {
  return <>{segs.map((s, k) => (s.kind === "md" ? <RichMarkdown key={k} className="agent-prose" text={s.text} /> : <div key={k} className="achat-rich" data-agent-rich={s.kind}><RichBlock seg={s} /></div>))}</>;
}

/** A floated box (`:::aside … :::`) with the rest of the reply wrapping around it, like an encyclopedia's infobox. */
function Aside({ seg }: { seg: Extract<Seg, { kind: "aside" }> }) {
  return (
    <div className="achat-wrap">
      <div className="achat-flow">
        <aside className={cn("achat-aside", seg.side === "left" && "achat-aside-left")} style={{ width: seg.width }}>
          <Segs segs={seg.aside} />
        </aside>
        <Segs segs={seg.body} />
      </div>
    </div>
  );
}

/** Columns side by side (`:::row … :::col … :::`); they stack when the chat is too narrow for them. */
function Row({ seg }: { seg: Extract<Seg, { kind: "row" }> }) {
  return (
    <div className="achat-row-wrap">
      <div className="achat-row" data-cols={seg.cols.length} style={{ gridTemplateColumns: seg.widths.map((w) => `minmax(0, ${w}fr)`).join(" ") }}>
        {seg.cols.map((col, c) => (
          <div key={c} className="achat-col">
            <Segs segs={col} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A run of the reply's Markdown. */
export function RichMarkdown({ text, className }: { text: string; className?: string }) {
  const host = useContext(RichContext);
  return <Markdown className={className} decorate={markCitations}>{localImages(text, host)}</Markdown>;
}

/** A link whose text is just a number, [1](url "title"), is a citation: a small numbered chip. */
function markCitations(el: HTMLElement) {
  for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!/^\d{1,3}$/.test(a.textContent?.trim() ?? "") || !/^https?:/i.test(a.getAttribute("href") ?? "")) continue;
    a.classList.add("achat-cite");
    if (!a.title) a.title = hostOf(a.href);
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export type Citation = { n: number; url: string; title: string; host: string };

const CITE = /\[(\d{1,3})\]\((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)/g;

/** The numbered citations a reply's text makes, once each, in number order. */
export function citations(texts: string[]): Citation[] {
  const seen = new Map<number, Citation>();
  for (const t of texts)
    for (const m of t.replace(/```[\s\S]*?```/g, "").matchAll(CITE)) {
      const n = Number(m[1]);
      const prev = seen.get(n);
      if (!prev || (!prev.title && m[3])) seen.set(n, { n, url: m[2], title: m[3]?.trim() || "", host: hostOf(m[2]) });
    }
  return [...seen.values()].sort((a, b) => a.n - b.n);
}

/** The Sources list under a reply that cited pages. */
export function SourceList({ items }: { items: Citation[] }) {
  if (!items.length) return null;
  return (
    <div className="achat-sources" data-agent-sources>
      <div className="achat-sources-h">Sources</div>
      <ol>
        {items.map((c) => (
          <li key={c.n}>
            <a href={c.url} target="_blank" rel="noopener noreferrer" title={c.url}>
              <span className="achat-sources-n">{c.n}</span>
              <span className="achat-sources-t">{c.title || c.host}</span>
              {c.title && <span className="achat-sources-d">{c.host}</span>}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
