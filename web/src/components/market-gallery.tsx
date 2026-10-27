import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import { api, type MarketEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import "./market-gallery.css";

const isVideo = (p: string) => /\.(mp4|webm)$/.test(p);

/**
 * App Store-style screenshot strip: every preview keeps its own shape at one shared height,
 * so landscape and portrait shots sit side by side. Clips play muted while they're on screen.
 */
export function MarketGallery({ entry, fallback }: { entry: MarketEntry; fallback: React.ReactNode }) {
  const media = (entry as MarketEntry & { media?: string[] }).media ?? [];
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const [zoom, setZoom] = useState<number | null>(null);
  const shots = media.map((p, i) => (isVideo(p) ? -1 : i)).filter((i) => i >= 0);

  const url = (i: number) => {
    const u = new URL(api.marketCoverUrl(entry.kind, entry.id), location.origin);
    u.pathname = u.pathname.replace("/cover/", "/media/") + `/${i}`;
    return u.pathname + u.search;
  };

  const measure = () => {
    const el = rail.current;
    if (el) setEdges({ start: el.scrollLeft < 4, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    const el = rail.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [media.length]);

  const page = (dir: 1 | -1) => {
    const el = rail.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };

  if (!media.length) return <section className="market-gallery market-gallery-single">{fallback}</section>;

  return (
    <section className={cn("market-gallery", !edges.start && "fade-start", !edges.end && "fade-end")} aria-label={`${entry.name} previews`}>
      <div
        ref={rail}
        className="market-gallery-rail"
        tabIndex={0}
        onScroll={measure}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          e.preventDefault();
          page(e.key === "ArrowRight" ? 1 : -1);
        }}
      >
        {media.map((path, i) =>
          isVideo(path) ? (
            <Clip key={path} src={url(i)} label={`${entry.name}, preview video`} onReady={measure} />
          ) : (
            <button type="button" className="market-shot" key={path} onClick={() => setZoom(i)} aria-label={`Open screenshot ${i + 1}`}>
              <img src={url(i)} alt={`${entry.name}, screenshot ${i + 1}`} loading={i < 3 ? "eager" : "lazy"} onLoad={measure} />
            </button>
          ),
        )}
      </div>
      {zoom !== null && <Lightbox srcs={shots.map((s) => url(s))} start={shots.indexOf(zoom)} name={entry.name} onClose={() => setZoom(null)} />}
      <button className={cn("market-gallery-arrow left", edges.start && "gone")} aria-label="Previous previews" tabIndex={-1} onClick={() => page(-1)}>
        <ChevronLeft className="size-5" />
      </button>
      <button className={cn("market-gallery-arrow right", edges.end && "gone")} aria-label="Next previews" tabIndex={-1} onClick={() => page(1)}>
        <ChevronRight className="size-5" />
      </button>
    </section>
  );
}

/** Full-size screenshot viewer: ← → to move, Esc or a click outside to close. */
function Lightbox({ srcs, start, name, onClose }: { srcs: string[]; start: number; name: string; onClose(): void }) {
  const [i, setI] = useState(Math.max(0, start));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight") setI((x) => Math.min(srcs.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [srcs.length, onClose]);
  // Portaled to <body>: the dialog's transform would otherwise trap position:fixed inside it.
  return createPortal(
    <div className="market-lightbox" role="dialog" aria-modal="true" aria-label={`${name}, screenshot ${i + 1} of ${srcs.length}`} onClick={onClose}>
      <img src={srcs[i]} alt={`${name}, screenshot ${i + 1}`} onClick={(e) => e.stopPropagation()} />
      <button className="market-lightbox-close" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><X className="size-5" /></button>
      {srcs.length > 1 && (
        <>
          <button className="market-lightbox-arrow left" disabled={i === 0} aria-label="Previous screenshot" onClick={(e) => { e.stopPropagation(); setI(i - 1); }}><ChevronLeft className="size-6" /></button>
          <button className="market-lightbox-arrow right" disabled={i === srcs.length - 1} aria-label="Next screenshot" onClick={(e) => { e.stopPropagation(); setI(i + 1); }}><ChevronRight className="size-6" /></button>
          <div className="market-lightbox-count">{i + 1} / {srcs.length}</div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** A muted looping clip that plays only while it's mostly on screen, with one small play/pause button. */
function Clip({ src, label, onReady }: { src: string; label: string; onReady(): void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  const userPaused = useRef(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(([e]) => {
      if (e.intersectionRatio > 0.6 && !userPaused.current && !reduce) v.play().catch(() => {});
      else v.pause();
    }, { threshold: [0, 0.6, 1] });
    io.observe(v);
    return () => { io.disconnect(); v.pause(); };
  }, []);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    userPaused.current = !v.paused;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  return (
    <figure className="market-shot market-clip">
      <video ref={ref} src={src} muted loop playsInline preload="auto" aria-label={label} onLoadedMetadata={onReady} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onClick={toggle} />
      <button className="market-clip-toggle" aria-label={paused ? "Play preview" : "Pause preview"} onClick={toggle}>
        {paused ? <Play className="size-3.5 fill-current" /> : <Pause className="size-3.5 fill-current" />}
      </button>
    </figure>
  );
}
