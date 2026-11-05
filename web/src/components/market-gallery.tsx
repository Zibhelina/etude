import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import { api, type MarketEntry } from "@/lib/api";
import { EtudeImg, useEtudeSrc } from "@/lib/local-url";
import { cn } from "@/lib/utils";
import "./market-gallery.css";

const isVideo = (p: string) => /\.(mp4|webm)$/.test(p);

type Slide = { kind: "cover" } | { kind: "image"; src: string } | { kind: "video"; src: string };

/**
 * The detail page's gallery: one large view with the cover first, then the entry's screenshots and clips,
 * and a row of thumbnails to pick from. Screenshots open full size; clips play muted while on screen.
 */
export function MarketGallery({ entry, cover }: { entry: MarketEntry; cover: React.ReactNode }) {
  const media = (entry as MarketEntry & { media?: string[] }).media ?? [];
  const url = (i: number) => {
    const u = new URL(api.marketCoverUrl(entry.kind, entry.id), location.origin);
    u.pathname = u.pathname.replace("/cover/", "/media/") + `/${i}`;
    return u.pathname + u.search;
  };
  const slides: Slide[] = [{ kind: "cover" }, ...media.map((p, i): Slide => (isVideo(p) ? { kind: "video", src: url(i) } : { kind: "image", src: url(i) }))];
  return <Gallery name={entry.name} slides={slides} cover={cover} thumb={entry.kind === "theme" ? cover : entry.cover ? <EtudeImg src={api.marketCoverUrl(entry.kind, entry.id)} alt="" /> : cover} />;
}

/** The same gallery for anything with just a cover (paid decks). */
export function CoverGallery({ cover }: { cover: React.ReactNode }) {
  return <Gallery name="" slides={[{ kind: "cover" }]} cover={cover} thumb={cover} />;
}

/**
 * App Store style: every preview side by side in one row that scrolls sideways (swipe, trackpad, the arrows, or
 * ← → with the row focused), snapping to each card. One preview fills the row; two or more show the next one peeking.
 */
function Gallery({ name, slides, cover }: { name: string; slides: Slide[]; cover: React.ReactNode; thumb?: React.ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [edge, setEdge] = useState<{ start: boolean; end: boolean }>({ start: true, end: slides.length < 2 });
  const shots = slides.map((s, j) => (s.kind === "image" ? j : -1)).filter((j) => j >= 0);
  const measure = () => {
    const r = row.current;
    if (r) setEdge({ start: r.scrollLeft < 4, end: r.scrollLeft + r.clientWidth >= r.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    const r = row.current;
    if (!r) return;
    const ro = new ResizeObserver(measure);
    ro.observe(r);
    return () => ro.disconnect();
  }, [slides.length]);
  const page = (d: 1 | -1) => {
    const r = row.current;
    const card = r?.firstElementChild as HTMLElement | null;
    if (!r || !card) return;
    const gap = parseFloat(getComputedStyle(r).columnGap) || 0;
    r.scrollBy({ left: d * (card.offsetWidth + gap), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  return (
    <section className={cn("mk-gal", slides.length === 1 && "single")} aria-label={name ? `${name} previews` : "Previews"}>
      <div
        className="mk-gal-row"
        ref={row}
        tabIndex={slides.length > 1 ? 0 : -1}
        onScroll={measure}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          e.preventDefault();
          page(e.key === "ArrowRight" ? 1 : -1);
        }}
        data-gallery-row
      >
        {slides.map((s, j) => (
          <div key={j} className="mk-gal-card" data-slide={s.kind}>
            {s.kind === "cover" ? (
              <div className="mk-gal-cover">{cover}</div>
            ) : s.kind === "video" ? (
              <Clip src={s.src} label={`${name}, preview video`} />
            ) : (
              <button type="button" className="mk-gal-shot" onClick={() => setZoom(j)} aria-label="Open screenshot full size">
                <EtudeImg src={s.src} alt={`${name}, screenshot ${j}`} loading={j > 2 ? "lazy" : undefined} />
              </button>
            )}
          </div>
        ))}
      </div>
      {slides.length > 1 && (
        <>
          <button type="button" className={cn("mk-gal-arrow left", edge.start && "gone")} aria-label="Previous preview" tabIndex={-1} onClick={() => page(-1)}><ChevronLeft className="size-5" /></button>
          <button type="button" className={cn("mk-gal-arrow right", edge.end && "gone")} aria-label="Next preview" tabIndex={-1} onClick={() => page(1)}><ChevronRight className="size-5" /></button>
        </>
      )}
      {zoom !== null && <Lightbox srcs={shots.map((j) => (slides[j] as { src: string }).src)} start={shots.indexOf(zoom)} name={name} onClose={() => setZoom(null)} onMove={() => {}} />}
    </section>
  );
}

/** Full-size screenshot viewer: ← → to move, Esc or a click outside to close. */
function Lightbox({ srcs, start, name, onClose, onMove }: { srcs: string[]; start: number; name: string; onClose(): void; onMove(i: number): void }) {
  const [i, setI] = useState(Math.max(0, start));
  useEffect(() => onMove(i), [i]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight") setI((x) => Math.min(srcs.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [srcs.length, onClose]);
  return createPortal(
    <div className="market-lightbox" role="dialog" aria-modal="true" aria-label={`${name}, screenshot ${i + 1} of ${srcs.length}`} onClick={onClose}>
      <EtudeImg src={srcs[i]} alt={`${name}, screenshot ${i + 1}`} onClick={(e) => e.stopPropagation()} />
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
function Clip({ src, label }: { src: string; label: string }) {
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
    <figure className="mk-gal-clip">
      <video ref={ref} src={useEtudeSrc(src)} muted loop playsInline preload="auto" aria-label={label} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onClick={toggle} />
      <button className="market-clip-toggle" aria-label={paused ? "Play preview" : "Pause preview"} onClick={toggle}>
        {paused ? <Play className="size-3.5 fill-current" /> : <Pause className="size-3.5 fill-current" />}
      </button>
    </figure>
  );
}
