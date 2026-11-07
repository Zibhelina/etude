// Embeds in a page: an HTML block (your own HTML, CSS and JavaScript: a widget, a diagram, a mini game), a
// video (a file in the collection, or YouTube/Vimeo) and a PDF (rendered here, page by page, with selectable
// text). The HTML runs in a sandboxed frame with an opaque origin: it can't read the app, its data or its API.
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ChevronRight, Code2, Download, FileText, Film, Menu, Minus, Plus, RotateCw } from "lucide-react";
import { api } from "@/lib/api";
import { isLocal } from "@/lib/transport";
import { useEtudeSrc } from "@/lib/local-url";
import { pageScheme, THEME_EVENT, useScheme } from "@/lib/theme";
import { AnyCodeEditor } from "@/components/live-editor";
import { RESIZE_ATTRS, useResizable } from "./note-resize";
import { cn } from "@/lib/utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteEmbeds: {
      insertHtmlBlock: () => ReturnType;
      insertVideo: (attrs?: { src?: string | null }) => ReturnType;
      insertPdf: (attrs?: { src?: string | null; name?: string | null }) => ReturnType;
    };
  }
}

// ------------------------------------------------------------------ HTML / mini game

const STARTER = `<div class="box">
  <p>Clicks: <b id="n">0</b></p>
  <button id="b">Click me</button>
</div>

<style>
  .box { padding: 18px; text-align: center; font-family: var(--font-sans); }
  button { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--foreground); cursor: pointer; }
</style>

<script>
  let clicks = 0;
  document.getElementById("b").onclick = () => {
    document.getElementById("n").textContent = ++clicks;
  };
</script>
`;

const THEME_VARS = ["--background", "--foreground", "--card", "--card-foreground", "--muted", "--muted-foreground", "--border", "--primary", "--primary-foreground", "--accent", "--success", "--danger", "--highlight", "--radius", "--font-sans", "--font-mono"];

function themeCss(): string {
  const cs = getComputedStyle(document.documentElement);
  const vars = THEME_VARS.map((v) => [v, cs.getPropertyValue(v).trim()]).filter(([, x]) => x);
  const hl = cs.getPropertyValue("--card-highlight").trim();
  if (hl) vars.push(["--highlight", hl]);
  return `:root{color-scheme:${pageScheme()};${vars.map(([k, x]) => `${k}:${x}`).join(";")}}html,body{margin:0;background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:15px;line-height:1.5}`;
}

/** The document an HTML block runs as: the app's colours and fonts as CSS variables, and a little script that
 * tells the page how tall it is. Its policy lets it load from the web (a library from a CDN, a picture) but not
 * from the app. */
function htmlDoc(src: string): string {
  const origin = location.origin;
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:",
    "style-src 'unsafe-inline' https:",
    `img-src data: blob: https: ${origin}`,
    `media-src data: blob: https: ${origin}`,
    "font-src data: https:",
    "connect-src https:",
    "worker-src blob:",
  ].join("; ");
  const size = `<script>(()=>{const s=()=>parent.postMessage({etudeEmbed:1,height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*");new ResizeObserver(s).observe(document.documentElement);addEventListener("load",s);s()})()</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="${origin}/"><style>${themeCss()}</style>${size}</head><body>${src}</body></html>`;
}

function useFrameDoc(html: string, scheme: string) {
  const [url, setUrl] = useState<{ src?: string; srcDoc?: string } | null>(null);
  useEffect(() => {
    const doc = htmlDoc(html);
    // Without a server the app page has no script policy, so the frame can be written in place. With one, a
    // srcdoc frame would inherit the app's policy and its scripts wouldn't run: the server serves it instead.
    if (isLocal()) return void setUrl({ srcDoc: doc });
    let live = true;
    const t = setTimeout(() => void api.frameDoc(doc).then((j) => live && setUrl({ src: j.url })).catch(() => live && setUrl(null)), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [html, scheme]);
  return url;
}

function HtmlView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const saved = String(node.attrs.html ?? "");
  const [editing, setEditing] = useState(!saved.trim());
  const [draft, setDraft] = useState(saved || STARTER);
  const [shown, setShown] = useState(saved || STARTER);
  const [run, setRun] = useState(0);
  const [h, setH] = useState(160);
  const scheme = useScheme();
  const rs = useResizable(node.attrs, (a) => updateAttributes(a));
  const frame = useRef<HTMLIFrameElement>(null);
  // While editing, the preview follows the code after a short pause; the page keeps it once you stop typing.
  useEffect(() => {
    if (draft === shown) return;
    const t = setTimeout(() => {
      setShown(draft);
      updateAttributes({ html: draft });
    }, 450);
    return () => clearTimeout(t);
  }, [draft, shown, updateAttributes]);
  useEffect(() => {
    if (saved && saved !== shown && !editing) (setShown(saved), setDraft(saved));
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = useFrameDoc(shown, scheme + run);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.etudeEmbed !== 1) return;
      if (typeof e.data.height === "number") setH(Math.max(40, Math.min(2400, e.data.height)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  return (
    <NodeViewWrapper ref={rs.box} className={cn("note-embed note-html", selected && "is-on", rs.resizing && "is-resizing")} style={{ width: rs.width ?? undefined }} data-drag-handle="">
      <div className="note-embed-head" contentEditable={false}>
        <span className="flex min-w-0 items-center gap-2">
          <Code2 className="size-3.5" />
          <span className="truncate">HTML</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => setRun((r) => r + 1)} className="note-cards-btn" title="Run it again from the start">
            <RotateCw className="size-3.5" />
          </button>
          <button type="button" onClick={() => setEditing((x) => !x)} className="note-cards-btn">{editing ? "Done" : "Edit"}</button>
          <button type="button" onClick={() => deleteNode()} className="note-cards-btn" title="Remove">✕</button>
        </span>
      </div>
      {editing && (
        <div className="note-embed-code" contentEditable={false} onKeyDown={(e) => e.stopPropagation()} onPaste={(e) => e.stopPropagation()}>
          <AnyCodeEditor value={draft} onChange={setDraft} language="html" minLines={8} className="px-1 py-1" />
        </div>
      )}
      {doc ? (
        <iframe key={`${doc.src ?? ""}${run}`} ref={frame} sandbox="allow-scripts allow-pointer-lock" src={doc.src} srcDoc={doc.srcDoc} title="HTML block" className="note-embed-frame note-cards-frame" style={{ height: rs.height ?? h, colorScheme: scheme }} />
      ) : (
        <div className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</div>
      )}
      {rs.handles}
    </NodeViewWrapper>
  );
}

// ------------------------------------------------------------------ video

/** A YouTube or Vimeo address as the player to embed, or null. */
export function videoPlayer(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") id = u.searchParams.get("v") ?? (/^\/(embed|shorts|live)\/([\w-]+)/.exec(u.pathname)?.[2] ?? null);
  if (id && /^[\w-]{6,20}$/.test(id)) {
    const t = Number.parseInt(u.searchParams.get("t") ?? u.searchParams.get("start") ?? "", 10);
    return `https://www.youtube-nocookie.com/embed/${id}${t > 0 ? `?start=${t}` : ""}`;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const v = /(\d{6,12})/.exec(u.pathname)?.[1];
    if (v) return `https://player.vimeo.com/video/${v}`;
  }
  return null;
}

function Pick({ accept, kind, onFile, onUrl, hint }: { accept: string; kind: "video" | "document"; onFile(f: File): void; onUrl?(u: string): boolean; hint: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [url, setUrl] = useState("");
  return (
    <div className="note-embed-empty" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={cn("note-embed-drop", over && "is-over")}
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), e.stopPropagation(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
      >
        {kind === "video" ? <Film className="size-5" /> : <FileText className="size-5" />}
        <span>{hint}</span>
      </button>
      <input ref={input} type="file" accept={accept} className="hidden" onChange={(e) => (e.target.files?.[0] && onFile(e.target.files[0]), (e.target.value = ""))} />
      {onUrl && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!onUrl(url)) toast.error("That isn't a YouTube or Vimeo link.");
          }}
        >
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="or paste a YouTube or Vimeo link" aria-label="Video link" className="note-cards-input" />
          <button type="submit" disabled={!url.trim()} className="lib-raised h-9 shrink-0 rounded-[8px] px-3 text-[13px] font-[600] disabled:opacity-50">Embed</button>
        </form>
      )}
    </div>
  );
}

async function upload(f: File, want: "video" | "document"): Promise<{ url: string; name: string } | null> {
  const t = toast.loading(`Adding ${f.name}…`);
  try {
    const m = await api.uploadMedia(f);
    if (m.kind !== want) throw new Error(want === "video" ? "That file isn't a video." : "That file isn't a PDF.");
    toast.dismiss(t);
    return { url: m.url, name: f.name };
  } catch (e) {
    toast.error(`Couldn't add ${f.name}: ${(e as Error).message}`, { id: t });
    return null;
  }
}

function VideoView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const src = (node.attrs.src as string | null) ?? null;
  const player = src ? videoPlayer(src) : null;
  const file = src && !player && /^\/media\/files\//.test(src) ? src : null;
  const local = useEtudeSrc(file);
  // Only the width: a video keeps its own shape.
  const rs = useResizable(node.attrs, (a) => a.width !== undefined && updateAttributes({ width: a.width }));
  return (
    <NodeViewWrapper ref={rs.box} className={cn("note-embed note-video-box", selected && "is-on", rs.resizing && "is-resizing")} style={{ width: rs.width ?? undefined }} data-drag-handle="">
      {!src ? (
        <>
          <div className="note-embed-head" contentEditable={false}>
            <span className="flex items-center gap-2"><Film className="size-3.5" /> Video</span>
            <button type="button" onClick={() => deleteNode()} className="note-cards-btn" title="Remove">✕</button>
          </div>
          <Pick
            accept="video/*"
            kind="video"
            hint="Drop a video file, or click to pick one"
            onFile={async (f) => {
              const m = await upload(f, "video");
              if (m) updateAttributes({ src: m.url });
            }}
            onUrl={(u) => {
              if (!videoPlayer(u)) return false;
              updateAttributes({ src: u.trim() });
              return true;
            }}
          />
        </>
      ) : player ? (
        <div className="note-yt" contentEditable={false}>
          <iframe src={player} title="Video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      ) : (
        <video src={local} controls preload="metadata" className="note-video" contentEditable={false} />
      )}
      {src && rs.handles}
    </NodeViewWrapper>
  );
}

// ------------------------------------------------------------------ PDF

type Pdfjs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<Pdfjs> | null = null;
function loadPdfjs(): Promise<Pdfjs> {
  return (pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([p, w]) => {
    p.GlobalWorkerOptions.workerSrc = w.default;
    return p;
  }));
}

function PdfPage({ doc, n, scale, pdfjs, ratio }: { doc: any; n: number; scale: number; pdfjs: Pdfjs; ratio: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen || !box.current) return;
    let live = true;
    let task: any = null;
    let text: any = null;
    void (async () => {
      const page = await doc.getPage(n);
      if (!live) return;
      const vp = page.getViewport({ scale });
      setSize({ w: vp.width, h: vp.height });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (!live || !box.current) return;
      const layer = document.createElement("div");
      layer.className = "textLayer";
      layer.style.setProperty("--total-scale-factor", String(scale));
      box.current.replaceChildren(canvas, layer);
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: vp });
      await text.render().catch(() => {});
    })();
    return () => {
      live = false;
      task?.cancel?.();
      text?.cancel?.();
    };
  }, [seen, doc, n, scale, pdfjs]);
  const w = size?.w ?? Math.round(scale * 612);
  const h = size?.h ?? Math.round(w * ratio);
  return <div ref={box} className="note-pdf-page" style={{ width: w, height: h }} data-page={n} />;
}

function PdfView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const src = (node.attrs.src as string | null) ?? null;
  const name = String(node.attrs.name ?? "Document.pdf");
  const url = useEtudeSrc(src);
  const rs = useResizable(node.attrs, (a) => updateAttributes(a));
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<{ doc: any; pdfjs: Pdfjs; base: number; ratio: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(680);
  const [at, setAt] = useState(1);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let doc: any = null;
    setErr(null);
    void loadPdfjs()
      .then(async (pdfjs) => {
        const origin = location.origin;
        doc = await pdfjs.getDocument({ url, isEvalSupported: false, standardFontDataUrl: `${origin}/runtime/pdfjs/standard_fonts/`, cMapUrl: `${origin}/runtime/pdfjs/cmaps/`, cMapPacked: true, wasmUrl: `${origin}/runtime/pdfjs/wasm/` } as any).promise;
        const p1 = await doc.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        if (live) setPdf({ doc, pdfjs, base: vp.width, ratio: vp.height / vp.width });
      })
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => {
      live = false;
      void doc?.destroy?.();
    };
  }, [url]);
  const scale = pdf ? Math.max(0.3, ((width - 24) / pdf.base) * zoom) : 1;
  const pages = pdf ? Array.from({ length: pdf.doc.numPages }, (_, i) => i + 1) : [];
  return (
    <NodeViewWrapper ref={rs.box} className={cn("note-embed note-pdf-box", selected && "is-on", rs.resizing && "is-resizing")} style={{ width: rs.width ?? undefined }} data-drag-handle="">
      <div className="note-embed-head" contentEditable={false}>
        <span className="flex min-w-0 items-center gap-2">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{src ? name : "PDF"}</span>
          {pdf && <span className="shrink-0 font-normal tabular-nums">{at} / {pdf.doc.numPages}</span>}
        </span>
        <span className="note-pdf-bar shrink-0">
          {pdf && (
            <>
              <button type="button" className="note-cards-btn" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} title="Zoom out"><Minus className="size-3.5" /></button>
              <button type="button" className="note-cards-btn tabular-nums" onClick={() => setZoom(1)} title="Fit the width">{Math.round(zoom * 100)}%</button>
              <button type="button" className="note-cards-btn" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} title="Zoom in"><Plus className="size-3.5" /></button>
              {url && <a href={url} download={name} className="note-cards-btn flex items-center" title="Download"><Download className="size-3.5" /></a>}
            </>
          )}
          <button type="button" onClick={() => deleteNode()} className="note-cards-btn" title="Remove">✕</button>
        </span>
      </div>
      {!src ? (
        <Pick
          accept="application/pdf,.pdf"
          kind="document"
          hint="Drop a PDF, or click to pick one"
          onFile={async (f) => {
            const m = await upload(f, "document");
            if (m) updateAttributes({ src: m.url, name: m.name });
          }}
        />
      ) : err ? (
        <div className="px-4 py-3 text-[13px] text-[var(--danger)]">Couldn't open this PDF: {err}</div>
      ) : (
        <div
          ref={scroller}
          className="note-pdf"
          contentEditable={false}
          style={{ height: rs.height ?? (pdf ? Math.min(Math.round(scale * pdf.base * pdf.ratio) + 26, Math.round(window.innerHeight * 0.8)) : 240) }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const kids = el.querySelectorAll<HTMLElement>("[data-page]");
            const mid = el.scrollTop + el.clientHeight / 3;
            for (const k of kids) if (k.offsetTop + k.offsetHeight > mid) return setAt(Number(k.dataset.page));
          }}
        >
          {pdf ? pages.map((n) => <PdfPage key={`${n}-${scale.toFixed(3)}`} doc={pdf.doc} n={n} scale={scale} pdfjs={pdf.pdfjs} ratio={pdf.ratio} />) : <div className="px-4 py-3 text-[13px] text-muted-foreground">Opening…</div>}
        </div>
      )}
      {src && rs.handles}
    </NodeViewWrapper>
  );
}

/** A PDF's table of contents (its bookmarks), each entry with the page it opens. */
type Section = { title: string; page: number | null; items: Section[] };
async function outlineOf(doc: any): Promise<Section[]> {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw?.length) return [];
  const walk = (items: any[]): Promise<Section[]> =>
    Promise.all(
      items.map(async (it) => {
        let page: number | null = null;
        try {
          let dest = it.dest;
          if (typeof dest === "string") dest = await doc.getDestination(dest);
          if (Array.isArray(dest)) page = typeof dest[0] === "number" ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
        } catch {}
        return { title: String(it.title ?? "").trim() || "Untitled", page, items: await walk(it.items ?? []) };
      }),
    );
  return walk(raw);
}
const flat = (xs: Section[], depth = 0, out: (Section & { depth: number })[] = []) => {
  for (const x of xs) out.push({ ...x, depth }), flat(x.items, depth + 1, out);
  return out;
};

/** A page as a small picture in the side panel, drawn once it scrolls into view. */
function PdfThumb({ doc, n, base, ratio, on, onPick }: { doc: any; n: number; base: number; ratio: number; on: boolean; onPick(n: number): void }) {
  const box = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  const W = 132;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    let task: any = null;
    void (async () => {
      const page = await doc.getPage(n);
      if (!live) return;
      const vp = page.getViewport({ scale: W / base });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      task = page.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (live) box.current?.querySelector(".note-pdf-thumb-img")?.replaceChildren(c);
    })();
    return () => {
      live = false;
      task?.cancel?.();
    };
  }, [seen, doc, n, base]);
  return (
    <button ref={box} type="button" className={cn("note-pdf-thumb", on && "is-on")} onClick={() => onPick(n)} aria-label={`Page ${n}`} aria-current={on ? "page" : undefined} data-thumb={n}>
      <span className="note-pdf-thumb-img" style={{ width: W, height: Math.round(W * ratio) }} />
      <span className="note-pdf-thumb-n tabular-nums">{n}</span>
    </button>
  );
}

const PANEL_KEY = "etude.notes.pdfPanel";

/**
 * A whole PDF as a note of its own: the pages fill the screen, scrolled like a reader. The page count and zoom
 * go into `controls` (the note's top bar) with ☰, which opens a panel on the left: the PDF's chapters and
 * sections when it has them, or its pages as pictures. Ctrl/⌘ + and − zoom, Ctrl/⌘ 0 fits the width.
 */
export function PdfDocument({ url, name, className, controls }: { url: string | null; name: string; className?: string; controls?: HTMLElement | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<{ doc: any; pdfjs: Pdfjs; base: number; ratio: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(900);
  const [at, setAt] = useState(1);
  const [toc, setToc] = useState<Section[]>([]);
  const [panel, setPanel] = useState(() => localStorage.getItem(PANEL_KEY) === "1");
  const [view, setView] = useState<"toc" | "pages">("toc");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const side = useRef<HTMLDivElement>(null);
  useEffect(() => localStorage.setItem(PANEL_KEY, panel ? "1" : "0"), [panel]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let doc: any = null;
    setErr(null);
    setPdf(null);
    setToc([]);
    void loadPdfjs()
      .then(async (pdfjs) => {
        const origin = location.origin;
        doc = await pdfjs.getDocument({ url, isEvalSupported: false, standardFontDataUrl: `${origin}/runtime/pdfjs/standard_fonts/`, cMapUrl: `${origin}/runtime/pdfjs/cmaps/`, cMapPacked: true, wasmUrl: `${origin}/runtime/pdfjs/wasm/` } as any).promise;
        const p1 = await doc.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        if (!live) return;
        setPdf({ doc, pdfjs, base: vp.width, ratio: vp.height / vp.width });
        const t = await outlineOf(doc);
        if (live) (setToc(t), setView(t.length ? "toc" : "pages"));
      })
      .catch((e) => live && setErr(String(e?.message ?? e)));
    return () => {
      live = false;
      void doc?.destroy?.();
    };
  }, [url]);
  const zoomBy = (d: number) => setZoom((z) => Math.min(3, Math.max(0.5, +(z + d).toFixed(2))));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") zoomBy(0.25);
      else if (e.key === "-") zoomBy(-0.25);
      else if (e.key === "0") setZoom(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const goTo = (n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    if (window.innerWidth < 768) setPanel(false);
  };
  // The page you're on stays in view in the panel.
  useEffect(() => {
    if (!panel || view !== "pages") return;
    side.current?.querySelector<HTMLElement>(`[data-thumb="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at, panel, view]);
  const fit = pdf ? Math.min(width - 48, 920) / pdf.base : 1;
  const scale = pdf ? Math.max(0.3, fit * zoom) : 1;
  const pages = pdf ? Array.from({ length: pdf.doc.numPages }, (_, i) => i + 1) : [];
  const rows = flat(toc);
  // The section you're reading: the last one that starts at or before this page.
  let here = -1;
  rows.forEach((r, i) => r.page != null && r.page <= at && (here = i));
  const hidden = (i: number) => {
    // A row is hidden when one of its parents is folded.
    for (let k = i - 1, d = rows[i].depth; k >= 0 && d > 0; k--) if (rows[k].depth < d) {
      if (shut.has(String(k))) return true;
      d = rows[k].depth;
    }
    return false;
  };
  const bar = pdf && (
    <span className="note-pdf-ctl">
      <button type="button" className={cn("note-cards-btn", panel && "is-on")} onClick={() => setPanel((x) => !x)} title={toc.length ? "Contents and pages" : "Pages"} aria-label="Contents and pages" aria-pressed={panel}><Menu className="size-4" /></button>
      <span className="note-pdf-ctl-n tabular-nums">{at} / {pdf.doc.numPages}</span>
      <span className="note-pdf-pill-sep" />
      <button type="button" className="note-cards-btn" onClick={() => zoomBy(-0.25)} title="Zoom out (Ctrl −)" aria-label="Zoom out"><Minus className="size-3.5" /></button>
      <button type="button" className="note-cards-btn min-w-[3.2rem] tabular-nums" onClick={() => setZoom(1)} title="Fit the width (Ctrl 0)">{Math.round(zoom * 100)}%</button>
      <button type="button" className="note-cards-btn" onClick={() => zoomBy(0.25)} title="Zoom in (Ctrl +)" aria-label="Zoom in"><Plus className="size-3.5" /></button>
    </span>
  );
  return (
    <div
      className={cn("note-pdf-doc", panel && pdf && "has-panel", className)}
      onClick={(e) => {
        // On a phone the panel floats over the pages: a tap on the dimmed pages closes it.
        if (panel && window.innerWidth < 768 && e.target === e.currentTarget) setPanel(false);
      }}
    >
      {pdf && (
        <aside ref={side} className="note-pdf-side" aria-label="Contents" aria-hidden={!panel} inert={!panel ? true : undefined}>
          {toc.length > 0 && (
            <div className="note-pdf-side-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={view === "toc"} className={cn(view === "toc" && "is-on")} onClick={() => setView("toc")}>Contents</button>
              <button type="button" role="tab" aria-selected={view === "pages"} className={cn(view === "pages" && "is-on")} onClick={() => setView("pages")}>Pages</button>
            </div>
          )}
          {view === "toc" && toc.length ? (
            <div className="note-pdf-toc" role="tree">
              {rows.map((r, i) =>
                hidden(i) ? null : (
                  <div key={i} className={cn("note-pdf-toc-row", i === here && "is-on")} style={{ paddingLeft: 6 + r.depth * 14 }} role="treeitem" aria-current={i === here ? "location" : undefined}>
                    {r.items.length ? (
                      <button type="button" className="note-pdf-toc-fold" aria-label={shut.has(String(i)) ? "Unfold" : "Fold"} onClick={() => setShut((s) => { const x = new Set(s); x.has(String(i)) ? x.delete(String(i)) : x.add(String(i)); return x; })}>
                        <ChevronRight className={cn("size-3 transition-transform", !shut.has(String(i)) && "rotate-90")} />
                      </button>
                    ) : <span className="note-pdf-toc-fold" />}
                    <button type="button" className="note-pdf-toc-t" disabled={r.page == null} onClick={() => r.page != null && goTo(r.page)} title={r.title}>
                      <span className="truncate">{r.title}</span>
                      {r.page != null && <span className="note-pdf-toc-p tabular-nums">{r.page}</span>}
                    </button>
                  </div>
                ),
              )}
            </div>
          ) : (
            <div className="note-pdf-thumbs">
              {pages.map((n) => <PdfThumb key={n} doc={pdf.doc} n={n} base={pdf.base} ratio={pdf.ratio} on={n === at} onPick={goTo} />)}
            </div>
          )}
        </aside>
      )}
      <div
        ref={scroller}
        className="note-pdf note-pdf-full"
        tabIndex={0}
        aria-label={name}
        onScroll={(e) => {
          const el = e.currentTarget;
          const kids = el.querySelectorAll<HTMLElement>("[data-page]");
          const mid = el.scrollTop + el.clientHeight / 3;
          for (const k of kids) if (k.offsetTop + k.offsetHeight > mid) return setAt(Number(k.dataset.page));
        }}
      >
        {err ? (
          <div className="px-6 py-5 text-[14px] text-[var(--danger)]">Couldn't open this PDF: {err}</div>
        ) : pdf ? (
          pages.map((n) => <PdfPage key={`${n}-${scale.toFixed(3)}`} doc={pdf.doc} n={n} scale={scale} pdfjs={pdf.pdfjs} ratio={pdf.ratio} />)
        ) : (
          <div className="px-6 py-5 text-[14px] text-muted-foreground">Opening…</div>
        )}
      </div>
      {bar && (controls ? createPortal(bar, controls) : <div className="note-pdf-pill">{bar}</div>)}
    </div>
  );
}

/** Puts a PDF in the media for a PDF note; null when it isn't one or the upload fails (a toast says why). */
export async function uploadPdf(f: File) {
  return upload(f, "document");
}

// ------------------------------------------------------------------ nodes

const atom = { group: "block", atom: true, draggable: true, selectable: true } as const;

export const HtmlBlock = Node.create({
  name: "htmlEmbed",
  ...atom,
  addAttributes() {
    return { html: { default: "", parseHTML: (el: HTMLElement) => el.dataset.html ?? "" }, ...RESIZE_ATTRS };
  },
  parseHTML: () => [{ tag: "div[data-etude-html]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-html": "", "data-html": node.attrs.html ?? "" })],
  addNodeView() {
    return ReactNodeViewRenderer(HtmlView);
  },
  addCommands() {
    return { insertHtmlBlock: () => ({ commands }) => commands.insertContent({ type: this.name }) };
  },
});

export const VideoBlock = Node.create({
  name: "noteVideo",
  ...atom,
  addAttributes() {
    return { src: { default: null, parseHTML: (el: HTMLElement) => el.dataset.src || null }, width: RESIZE_ATTRS.width };
  },
  parseHTML: () => [{ tag: "div[data-etude-video]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-video": "", "data-src": node.attrs.src ?? "" })],
  addNodeView() {
    return ReactNodeViewRenderer(VideoView);
  },
  addCommands() {
    return { insertVideo: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});

export const PdfBlock = Node.create({
  name: "notePdf",
  ...atom,
  addAttributes() {
    return { src: { default: null, parseHTML: (el: HTMLElement) => el.dataset.src || null }, name: { default: null, parseHTML: (el: HTMLElement) => el.dataset.name || null }, ...RESIZE_ATTRS };
  },
  parseHTML: () => [{ tag: "div[data-etude-pdf]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-pdf": "", "data-src": node.attrs.src ?? "", "data-name": node.attrs.name ?? "" })],
  addNodeView() {
    return ReactNodeViewRenderer(PdfView);
  },
  addCommands() {
    return { insertPdf: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});

export const NoteEmbeds = [HtmlBlock, VideoBlock, PdfBlock];
