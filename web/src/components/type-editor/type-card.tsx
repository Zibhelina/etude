// A type's live card, small: the Types gallery tiles and the New type picks show a real card of the
// type (one of your items, or its field defaults when nothing uses it yet), rendered by its own frame.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CardFrame } from "@/components/card-frame";
import { api, type TypeSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fieldDefaults } from "./starter";

export interface Sample {
  src: string;
  view: Record<string, unknown>;
  key: Record<string, unknown>;
  seed: number;
  face: string;
  /** Set when the card is one of the user's items. */
  item?: { id: string; deck: string; cardId: number };
}

export const frameSrc = (t: Pick<TypeSummary, "id" | "updated">) => `/frame/${encodeURIComponent(t.id)}?v=${encodeURIComponent(t.updated ?? "")}`;

async function fetchSample(t: TypeSummary, face?: string): Promise<Sample> {
  const src = frameSrc(t);
  if (t.items > 0) {
    const r = await api.search(face ? `type:${t.id} face:${face}` : `type:${t.id}`, { limit: 1 });
    const row = r.rows[0];
    if (row) {
      const p = await api.previewItem(row.itemId, 1, row.face);
      return { src, view: p.view, key: p.key, seed: p.seed, face: row.face, item: { id: row.itemId, deck: row.deck, cardId: row.cardId } };
    }
  }
  const def = await api.type(t.id);
  const p = await api.previewType(def, fieldDefaults(def), { seed: 1, face });
  if (!p.view) throw new Error(p.errors.join("\n") || "no preview");
  return { src, view: p.view, key: p.key ?? {}, seed: p.seed ?? 1, face: face ?? def.faces?.[0] ?? "main" };
}

// One sample per type version and face, shared by the gallery and the detail page; at most a few load at once.
const cache = new Map<string, Promise<Sample>>();
const waiting: (() => void)[] = [];
let running = 0;
const LIMIT = 4;
function queued<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      job().then(resolve, reject).finally(() => {
        running--;
        waiting.shift()?.();
      });
    };
    running < LIMIT ? go() : waiting.push(go);
  });
}
export function loadSample(t: TypeSummary, face?: string): Promise<Sample> {
  const k = `${t.id}@${t.updated}:${face ?? ""}`;
  if (!cache.has(k)) {
    const p = queued(() => fetchSample(t, face));
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return cache.get(k)!;
}

/** Width the card is laid out at before it's scaled down to the tile. */
const BASE = 540;

/** A real card of the type, scaled to fit, loaded when it scrolls into view. Not interactive. */
export function TypeThumb({ t, className, base = BASE }: { t: TypeSummary; className?: string; base?: number }) {
  const well = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);
  const [failed, setFailed] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0, card: 0 });

  useEffect(() => {
    const el = well.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let live = true;
    loadSample(t).then((s) => live && setSample(s), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [near, t.id, t.updated]);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setBox({ w: well.current?.clientWidth ?? 0, h: well.current?.clientHeight ?? 0, card: inner.current?.offsetHeight ?? 0 }));
    if (well.current) ro.observe(well.current);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, [!!sample]);

  const s = box.w ? box.w / base : 0;
  const tall = box.card * s > box.h;
  const top = tall ? 0 : Math.max(0, (box.h - box.card * s) / 2);
  return (
    <div ref={well} className={cn("types-well relative overflow-hidden", tall && "types-well-fade", className)} aria-hidden>
      {sample && (
        <div ref={inner} inert className="pointer-events-none absolute left-0 origin-top-left px-7 py-6" style={{ width: base, top, transform: `scale(${s})`, visibility: s ? "visible" : "hidden" }}>
          <CardFrame frameKey={`${t.id}:${t.updated}`} src={sample.src} view={sample.view} mode="preview" autoFocus={false} minHeight={60} />
        </div>
      )}
      {!sample && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-muted-foreground/70">
          {failed ? t.name : <span className="h-2 w-24 animate-pulse rounded-full bg-muted-foreground/10" />}
        </div>
      )}
    </div>
  );
}
