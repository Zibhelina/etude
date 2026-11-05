// The Stats line charts: the forgetting curve, a measured card's runs, and the small labelled histogram.
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChartTip, recallFill, useWidth } from "@/components/stats-charts";

const spanWord = (t: number) => (t < 1 ? "today" : t < 1.5 ? "tomorrow" : t < 14 ? `${Math.round(t)} days` : t < 60 ? `${Math.round(t / 7)} weeks` : `${Math.round(t / 30)} months`);

/** When the mean predicted recall falls under the target, interpolated between samples; 0 if it already is, null if never. */
export function crossing(curve: { days: number; recall: number }[], target: number) {
  if (!curve.length) return null;
  if (curve[0].recall < target) return 0;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (a.recall >= target && b.recall < target) return a.days + ((a.recall - target) / (a.recall - b.recall)) * (b.days - a.days);
  }
  return null;
}
export { spanWord };

/** Mean predicted recall of the studied cards if nothing were reviewed from now on, for the next two months. */
export function ForgettingCurve({ curve, target, height = 210, maxT = 60 }: { curve: { days: number; recall: number }[]; target: number; height?: number; maxT?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = w || 600, h = height, pl = 40, pr = 12, pt = 14, pb = 26;
  const pts = curve.filter((p) => p.days <= maxT);
  const mn = Math.max(0, Math.floor(Math.min(target, ...pts.map((p) => p.recall)) * 20 - 1) / 20);
  const X = (t: number) => pl + ((W - pl - pr) * t) / maxT;
  const Y = (r: number) => pt + (h - pt - pb) * (1 - (r - mn) / (1 - mn));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.days).toFixed(1)},${Y(p.recall).toFixed(1)}`).join("");
  const area = `${line}L${X(pts[pts.length - 1].days)},${Y(mn)}L${X(0)},${Y(mn)}Z`;
  const yt: number[] = [];
  for (let v = Math.ceil(mn * 10) / 10; v <= 1.001; v += 0.1) yt.push(Math.round(v * 10) / 10);
  const xt: [number, string][] = [];
  let lastX = -99;
  for (const t of [[0, "today"], [7, "1 week"], [14, "2 weeks"], [30, "1 month"], [60, "2 months"]] as [number, string][]) {
    if (t[0] > maxT) continue;
    if (X(t[0]) - lastX >= 70) {
      xt.push(t);
      lastX = X(t[0]);
    }
  }
  const cross = crossing(curve, target);
  const p30 = pts.find((p) => p.days === 30);
  const hp = hover != null ? pts[hover] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(X(pts[i].days) - px) < Math.abs(X(pts[best].days) - px)) best = i;
    setHover(best);
  };
  return (
    <div ref={ref} className="stats-chart relative w-full">
      {w > 0 ? (
        <svg width={W} height={h} className="block touch-pan-y overflow-visible" role="img" aria-label={`Forgetting curve: average recall falls from ${Math.round(curve[0].recall * 100)}% today to ${Math.round(pts[pts.length - 1].recall * 100)}% in ${maxT} days without reviews`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="stats-curve-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--foreground)" stopOpacity={0.1} />
              <stop offset="1" stopColor="var(--foreground)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {yt.map((v) => (
            <g key={v}>
              <line x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} stroke="var(--border)" />
              <text x={pl - 8} y={Y(v) + 4} textAnchor="end">{Math.round(v * 100)}%</text>
            </g>
          ))}
          <line x1={pl} x2={W - pr} y1={Y(target)} y2={Y(target)} stroke="var(--good)" strokeWidth={1.5} strokeDasharray="5 4" />
          <text x={W - pr} y={Y(target) - 6} textAnchor="end" className="lab" style={{ fill: "var(--good)" }}>target</text>
          <path d={area} fill="url(#stats-curve-fill)" />
          <path d={line} fill="none" stroke="var(--foreground)" strokeWidth={2.2} strokeLinejoin="round" />
          {xt.map(([t, l]) => (
            <text key={t} x={X(t)} y={h - 6} textAnchor={t === 0 ? "start" : t === maxT ? "end" : "middle"}>{l}</text>
          ))}
          {cross != null && cross > 0 && cross <= maxT && (
            <g>
              <line x1={X(cross)} x2={X(cross)} y1={Y(target)} y2={h - pb} stroke="var(--foreground)" strokeDasharray="3 3" opacity={0.5} />
              <circle cx={X(cross)} cy={Y(target)} r={5} fill="var(--card)" stroke="var(--foreground)" strokeWidth={2} />
              <text x={X(cross) + 8} y={Y(target) - 8} className="lab">{spanWord(cross)}</text>
            </g>
          )}
          {p30 && (
            <g>
              <circle cx={X(30)} cy={Y(p30.recall)} r={4} fill={recallFill(p30.recall, target)} />
              <text x={X(30) + 8} y={Y(p30.recall) - 9} className="lab">{Math.round(p30.recall * 100)}%</text>
            </g>
          )}
          {hp && (
            <g pointerEvents="none">
              <line x1={X(hp.days)} x2={X(hp.days)} y1={pt} y2={h - pb} stroke="var(--foreground)" strokeOpacity={0.2} />
              <circle cx={X(hp.days)} cy={Y(hp.recall)} r={4} fill="var(--foreground)" />
            </g>
          )}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      {hp && <ChartTip tip={{ x: X(hp.days), y: Y(hp.recall), lines: [hp.days === 0 ? "Now" : `In ${hp.days} day${hp.days === 1 ? "" : "s"}`, `${(hp.recall * 100).toFixed(1)}% average recall`] }} width={W} />}
    </div>
  );
}

/** Small vertical histogram: a number above each bar and a label under it. */
export function Histogram({ bars, height = 130, label, onPick }: { bars: { key: string; value: number; color: string; label?: string; tip: string }[]; height?: number; label: string; onPick?(i: number): void }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="w-full">
      <div className="flex items-end gap-2.5 pt-5" style={{ height: height + 20 }} role="img" aria-label={`${label}: ${bars.map((b) => b.tip).join(", ")}`} onMouseLeave={() => setHover(null)}>
        {bars.map((b, i) => (
          <button key={b.key} type="button" tabIndex={onPick ? 0 : -1} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => onPick?.(i)} className={cn("relative flex h-full flex-1 items-end rounded-md outline-none", onPick ? "cursor-pointer" : "cursor-default")} aria-label={b.tip}>
            {b.value > 0 && <span className="tabular absolute inset-x-0 text-center text-[11px] text-muted-foreground" style={{ bottom: `calc(${Math.max(3, (b.value / max) * 100)}% + 4px)` }}>{b.value}</span>}
            <span className="stats-grow block w-full rounded-[5px]" style={{ transformOrigin: "bottom", height: `${Math.max(b.value ? 3 : 1.5, (b.value / max) * 100)}%`, background: b.value ? b.color : "var(--stats-track)", opacity: hover == null || hover === i ? 1 : 0.55, animationDelay: `${i * 35}ms` }} />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2.5 text-[11px] text-muted-foreground">
        {bars.map((b) => (
          <span key={b.key} className="flex-1 truncate text-center">{b.label ?? ""}</span>
        ))}
      </div>
      <div className="mt-1 h-4 text-xs text-muted-foreground">{hover != null ? bars[hover].tip : "\u00a0"}</div>
    </div>
  );
}

/**
 * One measured number over a card's runs, oldest left: each run a faint dot, the line the average of the
 * last five, the best run green. Runs are evenly spaced, so a burst on one day reads like a run a week.
 */
export function ProgressChart({ points, better, unit, digits, height = 220 }: { points: { at: string; value: number }[]; better: "higher" | "lower"; unit: string; digits: number; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const W = w || 480, pl = 38, pr = 10, pt = 16, pb = 24;
  const p = points.map((x) => x.value), n = p.length;
  const mn = Math.min(...p), mx = Math.max(...p);
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((k) => (mx - mn) / k <= 4) ?? 1000;
  const t0 = Math.floor(mn / step) * step, t1 = Math.max(t0 + step, Math.ceil((mx + step * 0.3) / step) * step);
  const ticks: number[] = [];
  for (let v = t0; v <= t1 + 1e-9; v += step) ticks.push(v);
  const X = (i: number) => pl + (n === 1 ? (W - pl - pr) / 2 : ((W - pl - pr) * i) / (n - 1));
  const Y = (v: number) => pt + (height - pt - pb) * (1 - (v - t0) / (t1 - t0));
  const best = better === "lower" ? mn : mx, bi = p.lastIndexOf(best);
  const avg = p.map((_, i) => {
    const s = p.slice(Math.max(0, i - 4), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
  const fmt = (v: number) => `${v.toFixed(digits)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const tickDigits = step < 1 ? 1 : 0;
  return (
    <div ref={ref} className="stats-chart w-full">
      {w > 0 ? (
        <svg width={W} height={height} className="block overflow-visible" role="img" aria-label={`${n} runs, best ${fmt(best)}`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} stroke="var(--border)" />
              <text x={pl - 8} y={Y(v) + 4} textAnchor="end">{v.toFixed(tickDigits)}</text>
            </g>
          ))}
          {p.map((v, i) => (
            <circle key={i} cx={X(i)} cy={Y(v)} r={n > 80 ? 2.2 : 3.2} fill="var(--foreground)" opacity={0.28}>
              <title>{`Run ${i + 1} · ${day(points[i].at)} · ${fmt(v)}`}</title>
            </circle>
          ))}
          {n > 1 && <path d={avg.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("")} fill="none" stroke="var(--foreground)" strokeWidth={2.2} strokeLinejoin="round" />}
          <circle cx={X(bi)} cy={Y(best)} r={6} fill="var(--highlight)" />
          <text x={X(bi)} y={Y(best) - 10} textAnchor="middle" className="lab">best</text>
          <text x={pl} y={height - 5}>{n > 1 ? "first run" : day(points[0].at)}</text>
          {n > 1 && <text x={W - pr} y={height - 5} textAnchor="end">last run</text>}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}
