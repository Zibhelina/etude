// The richer Stats visuals: recall ring, sparklines, forgetting curve, memory ladder, study clock, donuts.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Computer Modern for the big numerals, matching the wordmark. */
export const SERIF = { fontFamily: "KaTeX_Main, 'Latin Modern Roman', 'CMU Serif', Georgia, serif" } as const;

/** Width of an element in CSS pixels. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** False on the first frame, then true: lets SVG shapes animate in from zero with CSS transitions. */
export function useShown(delay = 30) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return on;
}

/** Recall color: below target by a lot is again, a little is hard, at or above is good. */
export const recallColor = (v: number, target = 0.9) => (v < target - 0.15 ? "var(--again)" : v < target - 0.005 ? "var(--hard)" : "var(--good)");

// ------------------------------------------------------------------ ring

export function RecallRing({ value, target, size = 176, label, sub }: { value: number | null; target: number; size?: number; label: string; sub?: string }) {
  const shown = useShown();
  const id = useId();
  const stroke = 11;
  const r = size / 2 - stroke;
  const C = 2 * Math.PI * r;
  const v = value ?? 0;
  const color = value == null ? "var(--muted-foreground)" : recallColor(v, target);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={`${label}: ${value == null ? "no data" : `${(v * 100).toFixed(1)}%`}, target ${Math.round(target * 100)}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        {value != null && (
          <>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={shown ? C * (1 - v) : C}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="viz-anim"
              style={{ transition: "stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)" }}
            />
          </>
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="tabular text-[40px] leading-none tracking-tight" style={SERIF}>
          {value == null ? "—" : (v * 100).toFixed(1)}
          {value != null && <span className="ml-0.5 text-xl text-muted-foreground">%</span>}
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
        {sub && <div className="mt-0.5 text-[11px] text-muted-foreground/80">{sub}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- sparkline

export function Sparkline({ values, color = "var(--highlight)", height = 34, domain }: { values: (number | null)[]; color?: string; height?: number; domain?: [number, number] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const id = useId();
  const W = Math.max(60, width || 160);
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v != null);
  if (pts.length < 2) return <div ref={ref} style={{ height }} />;
  const lo = domain?.[0] ?? Math.min(...pts.map((p) => p.v));
  const hi = domain?.[1] ?? Math.max(...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 6);
  const y = (v: number) => 3 + (height - 6) * (1 - (v - lo) / span);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <div ref={ref} className="w-full">
      <svg width={W} height={height} className="block max-w-full overflow-visible" aria-hidden>
        <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.i)} cy={y(last.v)} r={3} fill={color} />
      </svg>
    </div>
  );
}

// -------------------------------------------------------- forgetting curve

const fmtSpan = (d: number) => (d === 0 ? "today" : d < 7 ? `${d} day${d === 1 ? "" : "s"}` : d < 30 ? `${Math.round(d / 7)} wk` : `${Math.round(d / 30)} mo`);

/**
 * Mean predicted recall of the studied cards if nothing were reviewed from now on.
 * The x axis is square-root scaled so the steep first days get room.
 */
export function ForgettingCurve({ curve, target }: { curve: { days: number; recall: number }[]; target: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const shown = useShown(60);
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(260, width || 600), H = 220, L = 38, R = 14, T = 16, B = 26;
  const maxD = curve[curve.length - 1]?.days ?? 90;
  const fx = (d: number) => L + (W - L - R) * Math.sqrt(d / maxD);
  const minR = Math.min(target, ...curve.map((p) => p.recall));
  const lo = Math.max(0, Math.floor((minR - 0.04) * 20) / 20);
  const fy = (v: number) => T + (H - T - B) * (1 - (v - lo) / (1 - lo));
  // A smooth path through the samples (Catmull-Rom → Bézier).
  const P = curve.map((p) => [fx(p.days), fy(p.recall)] as const);
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] ?? P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] ?? p2;
    d += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  const area = `${d}L${P[P.length - 1][0]},${H - B}L${P[0][0]},${H - B}Z`;
  // When the mean drops under the target, interpolated between samples.
  let cross: number | null = null;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (a.recall >= target && b.recall < target) {
      cross = a.days + ((a.recall - target) / (a.recall - b.recall)) * (b.days - a.days);
      break;
    }
  }
  if (cross == null && curve[0] && curve[0].recall < target) cross = 0;
  const yTicks = [lo, (lo + 1) / 2, 1].map((v) => Math.round(v * 100) / 100);
  // Keep ticks at least 30 px apart: on a phone the first days crowd together.
  const xTicks = [0, 1, 3, 7, 14, 30, 60, 90].filter((t) => t <= maxD).reduce<number[]>((acc, t) => (acc.length && fx(t) - fx(acc[acc.length - 1]) < 30 ? acc : [...acc, t]), []);
  const hp = hover != null ? curve[hover] : null;
  const clipW = shown ? W : L;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = 0;
    for (let i = 1; i < curve.length; i++) if (Math.abs(fx(curve[i].days) - px) < Math.abs(fx(curve[best].days) - px)) best = i;
    setHover(best);
  };

  return (
    <div ref={ref} className="relative w-full">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {cross == null ? (
          <p className="text-sm text-pretty">
            Even with <span className="text-foreground">no reviews for {fmtSpan(maxD)}</span>, your average recall stays above {Math.round(target * 100)}%.
          </p>
        ) : cross === 0 ? (
          <p className="text-sm text-pretty">Your average recall is already under your {Math.round(target * 100)}% target. Reviewing what's due brings it back.</p>
        ) : (
          <p className="text-sm text-pretty text-muted-foreground">
            Stop reviewing today and your average recall drops under <span className="text-foreground">{Math.round(target * 100)}%</span> in about{" "}
            <span className="tabular text-highlight">{cross < 1.5 ? "a day" : `${Math.round(cross)} days`}</span>, and to{" "}
            <span className="tabular text-foreground">{Math.round(curve[curve.length - 1].recall * 100)}%</span> in {fmtSpan(maxD)}.
          </p>
        )}
      </div>
      <svg width={W} height={H} className="block max-w-full touch-none" role="img" aria-label={`Forgetting curve: average recall falls from ${Math.round(curve[0].recall * 100)}% today to ${Math.round(curve[curve.length - 1].recall * 100)}% in ${maxD} days without reviews`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          <clipPath id={`${id}c`}>
            <rect x={0} y={0} width={clipW} height={H} className="viz-anim" style={{ transition: "width 1.3s cubic-bezier(.3,.7,.2,1)" }} />
          </clipPath>
        </defs>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={fy(v)} y2={fy(v)} stroke="var(--border)" />
            <text x={L - 7} y={fy(v) + 4} textAnchor="end" fontSize={11} className="tabular fill-muted-foreground">{Math.round(v * 100)}%</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}><line x1={fx(t)} x2={fx(t)} y1={H - B} y2={H - B + 4} stroke="var(--border)" /><text x={fx(t)} y={H - 7} textAnchor={t === 0 ? "start" : t === maxD ? "end" : "middle"} fontSize={11} className="fill-muted-foreground">{t === 0 ? "now" : t < 7 ? `${t}d` : t < 30 ? `${t / 7}w` : `${t / 30}mo`}</text></g>
        ))}
        {/* Target line. */}
        <line x1={L} x2={W - R} y1={fy(target)} y2={fy(target)} stroke="var(--foreground)" strokeOpacity={0.45} strokeDasharray="4 4" />
        <text x={W - R} y={fy(target) - 6} textAnchor="end" fontSize={11} className="fill-muted-foreground">target {Math.round(target * 100)}%</text>
        <g clipPath={`url(#${id}c)`}>
          <path d={area} fill="var(--highlight)" fillOpacity={0.1} />
          <path d={d} fill="none" stroke="var(--highlight)" strokeWidth={2.25} strokeLinecap="round" />
          {cross != null && cross > 0 && (
            <g>
              <line x1={fx(cross)} x2={fx(cross)} y1={fy(target)} y2={H - B} stroke="var(--highlight)" strokeOpacity={0.6} strokeDasharray="2 3" />
              <circle cx={fx(cross)} cy={fy(target)} r={4.5} fill="var(--background)" stroke="var(--highlight)" strokeWidth={2} />
              <text x={fx(cross) - 8} y={fy(target) + 17} textAnchor="end" fontSize={11} className="tabular fill-highlight">{Math.round(cross)} days</text>
            </g>
          )}
        </g>
        {hp && (
          <g pointerEvents="none">
            <line x1={fx(hp.days)} x2={fx(hp.days)} y1={T} y2={H - B} stroke="var(--foreground)" strokeOpacity={0.25} />
            <circle cx={fx(hp.days)} cy={fy(hp.recall)} r={4} fill="var(--highlight)" />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.max(4, Math.min(W - 150, fx(hp.days) - 70)), top: fy(hp.recall) + 30 }}
        >
          <div className="font-medium">{hp.days === 0 ? "Now" : `In ${hp.days} day${hp.days === 1 ? "" : "s"}`}</div>
          <div className="tabular text-muted-foreground">{(hp.recall * 100).toFixed(1)}% average recall</div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ histograms

/** Small vertical histogram; each bar has its own color, label under it and a hover readout. */
export function Histogram({
  bars,
  height = 96,
  label,
  onPick,
}: {
  bars: { key: string; value: number; color: string; label?: string; tip: string }[];
  height?: number;
  label: string;
  onPick?(i: number): void;
}) {
  const shown = useShown(80);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="w-full">
      <div className="flex items-end gap-[3px] pt-4" style={{ height: height + 16 }} role="img" aria-label={`${label}: ${bars.map((b) => `${b.tip}`).join(", ")}`} onMouseLeave={() => setHover(null)}>
        {bars.map((b, i) => (
          <button
            key={b.key}
            type="button"
            tabIndex={onPick ? 0 : -1}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => onPick?.(i)}
            className={cn("group relative flex h-full flex-1 items-end rounded-sm outline-none", onPick ? "cursor-pointer" : "cursor-default")}
            aria-label={b.tip}
          >
            {b.value > 0 && <span className="tabular absolute inset-x-0 text-center text-[10px] text-muted-foreground" style={{ bottom: `calc(${shown ? Math.max(4, (b.value / max) * 100) : 0}% + 2px)`, opacity: shown ? 1 : 0, transition: `bottom .8s cubic-bezier(.2,.8,.2,1) ${i * 35}ms, opacity .4s` }}>{b.value}</span>}
            <span
              className="viz-anim block w-full rounded-[3px]"
              style={{
                height: shown ? `${Math.max(b.value ? 4 : 1.5, (b.value / max) * 100)}%` : "0%",
                background: b.value ? b.color : "var(--muted)",
                opacity: hover == null || hover === i ? 1 : 0.55,
                transition: `height .8s cubic-bezier(.2,.8,.2,1) ${i * 35}ms, opacity .15s`,
              }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[3px] text-[10.5px] text-muted-foreground">
        {bars.map((b) => (
          <span key={b.key} className="flex-1 truncate text-center">{b.label ?? ""}</span>
        ))}
      </div>
      <div className="mt-1 h-4 text-xs text-muted-foreground">{hover != null ? bars[hover].tip : "\u00a0"}</div>
    </div>
  );
}

// ---------------------------------------------------------- study clock

/** A 24-hour clock: wedge length is how much you study at that hour, color is how well. */
export function StudyClock({ hours, target }: { hours: { hour: number; reviews: number; passed: number }[]; target: number }) {
  const shown = useShown(100);
  const [hover, setHover] = useState<number | null>(null);
  const S = 232, c = S / 2, r0 = 34, r1 = c - 28;
  const max = Math.max(1, ...hours.map((h) => h.reviews));
  const total = hours.reduce((a, h) => a + h.reviews, 0);
  // Best hour: highest pass rate among hours carrying at least 5% of reviews.
  // Only hours with enough answers to mean something; a 3-for-3 hour is luck, not sharpness.
  const eligible = total >= 40 ? hours.filter((h) => h.reviews >= Math.max(10, total * 0.05)) : [];
  const best = eligible.length ? eligible.reduce((a, b) => (b.passed / b.reviews > a.passed / a.reviews ? b : a)) : null;
  const busiest = hours.reduce((a, b) => (b.reviews > a.reviews ? b : a));
  const wedge = (h: number, len: number) => {
    const a0 = ((h / 24) * 2 - 0.5) * Math.PI + 0.025, a1 = (((h + 1) / 24) * 2 - 0.5) * Math.PI - 0.025;
    const r = r0 + (r1 - r0) * len;
    const p = (a: number, rr: number) => `${(c + Math.cos(a) * rr).toFixed(2)},${(c + Math.sin(a) * rr).toFixed(2)}`;
    return `M${p(a0, r0)}L${p(a0, r)}A${r},${r} 0 0 1 ${p(a1, r)}L${p(a1, r0)}A${r0},${r0} 0 0 0 ${p(a0, r0)}Z`;
  };
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const hv = hover != null ? hours[hover] : null;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="relative shrink-0" style={{ width: S, height: S }}>
        <svg width={S} height={S} role="img" aria-label={`Reviews by hour of day; busiest ${hh(busiest.hour)}`} onMouseLeave={() => setHover(null)}>
          {[0.33, 0.66, 1].map((k) => (
            <circle key={k} cx={c} cy={c} r={r0 + (r1 - r0) * k} fill="none" stroke="var(--border)" />
          ))}
          {[0, 6, 12, 18].map((h) => {
            const a = ((h / 24) * 2 - 0.5) * Math.PI;
            return (
              <text key={h} x={c + Math.cos(a) * (r1 + 17)} y={c + Math.sin(a) * (r1 + 17) + 4} textAnchor="middle" fontSize={11} className="tabular fill-muted-foreground">{h}h</text>
            );
          })}
          <g className="viz-anim" style={{ transform: `scale(${shown ? 1 : 0.15})`, transformOrigin: `${c}px ${c}px`, opacity: shown ? 1 : 0, transition: "transform 1s cubic-bezier(.2,.8,.2,1), opacity .5s" }}>
            {hours.map((h, i) => {
              const len = h.reviews ? Math.sqrt(h.reviews / max) : 0;
              const rate = h.reviews ? h.passed / h.reviews : 0;
              return (
                <g key={h.hour} onMouseEnter={() => setHover(i)}>
                  <path d={wedge(h.hour, 1)} fill="transparent" />
                  {h.reviews > 0 && (
                    <path
                      d={wedge(h.hour, Math.max(len, 0.06))}
                      fill={recallColor(rate, target)}
                      fillOpacity={hover == null || hover === i ? 0.9 : 0.4}
                      style={{ transition: "fill-opacity .15s" }}
                      pointerEvents="none"
                    />
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {hv ? (
            <>
              <div className="tabular text-lg leading-none" style={SERIF}>{hh(hv.hour)}</div>
              <div className="tabular mt-1 text-[11px] text-muted-foreground">{hv.reviews} · {hv.reviews ? Math.round((hv.passed / hv.reviews) * 100) : 0}%</div>
            </>
          ) : (
            <div className="text-[11px] text-muted-foreground">24 h</div>
          )}
        </div>
      </div>
      <dl className="grid w-full grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-1">
        <div>
          <dt className="text-xs text-muted-foreground">Busiest hour</dt>
          <dd className="tabular mt-0.5 text-lg" style={SERIF}>{hh(busiest.hour)}</dd>
          <dd className="tabular text-xs text-muted-foreground">{busiest.reviews} review{busiest.reviews === 1 ? "" : "s"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Sharpest hour</dt>
          <dd className="tabular mt-0.5 text-lg" style={SERIF}>{best ? hh(best.hour) : "—"}</dd>
          <dd className="tabular text-xs text-muted-foreground">{best ? `${Math.round((best.passed / best.reviews) * 100)}% not Again` : "Needs more reviews"}</dd>
        </div>
        <p className="col-span-2 text-xs text-pretty text-muted-foreground sm:col-span-1">Longer wedges, more reviews. Color is how often you didn't press Again at that hour.</p>
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ donut

export function Donut({ parts, center, sub, size = 132, onPick }: { parts: { key: string; label: string; value: number; color: string }[]; center: ReactNode; sub?: string; size?: number; onPick?(i: number): void }) {
  const shown = useShown(120);
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((a, p) => a + p.value, 0);
  const stroke = 16, r = size / 2 - stroke / 2 - 2, C = 2 * Math.PI * r;
  const gap = total && parts.filter((p) => p.value).length > 1 ? 2.5 : 0;
  let acc = 0;
  const pct = (v: number) => (total ? ((v / total) * 100).toFixed(1) : "0");
  return (
    <div className="flex flex-col items-center gap-5 min-[480px]:flex-row">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={parts.map((p) => `${p.label} ${p.value} (${pct(p.value)}%)`).join(", ")} onMouseLeave={() => setHover(null)}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
          {parts.map((p, i) => {
            if (!p.value) return null;
            const len = (p.value / total) * C;
            const start = acc;
            acc += len;
            return (
              <circle
                key={p.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={p.color}
                strokeWidth={hover === i ? stroke + 4 : stroke}
                strokeDasharray={`${shown ? Math.max(0.5, len - gap) : 0} ${C}`}
                strokeDashoffset={-start}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                opacity={hover == null || hover === i ? 1 : 0.45}
                onMouseEnter={() => setHover(i)}
                className="viz-anim"
                style={{ transition: `stroke-dasharray .9s cubic-bezier(.2,.8,.2,1) ${i * 90}ms, opacity .15s, stroke-width .15s` }}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {hover != null ? (
            <>
              <div className="tabular text-2xl leading-none" style={SERIF}>{pct(parts[hover].value)}%</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{parts[hover].label}</div>
            </>
          ) : (
            <>
              <div className="tabular text-2xl leading-none" style={SERIF}>{center}</div>
              {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
            </>
          )}
        </div>
      </div>
      <div className="grid w-full gap-y-1.5">
        {parts.map((p, i) => {
          const Row = onPick ? "button" : "div";
          return (
            <Row
              key={p.key}
              {...(onPick ? { type: "button" as const, onClick: () => onPick(i) } : {})}
              className={cn("flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors", hover === i && "bg-accent/50", !p.value && "opacity-45")}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="text-muted-foreground">{p.label}</span>
              <span className="tabular ml-auto shrink-0 font-medium">{p.value}</span>
              <span className="tabular w-12 shrink-0 text-right text-xs text-muted-foreground">{total ? `${pct(p.value)}%` : ""}</span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ practice progress

/**
 * One measured number over a card's sessions (WPM, accuracy...), oldest left. Sessions are evenly
 * spaced so a burst of runs on one day reads as clearly as one run a week; the best one is ringed.
 */
export function ProgressChart({ points, better, unit, digits, height = 168 }: { points: { at: string; value: number }[]; better: "higher" | "lower"; unit: string; digits: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(240, width || 480);
  const padL = 36, padR = 12, padT = 12, padB = 22;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const n = points.length;
  const x = (i: number) => padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (height - padT - padB) * (1 - (v - lo) / (hi - lo));
  const fmt = (v: number) => `${v.toFixed(digits)}${unit === "%" ? "%" : ""}`;
  const best = better === "lower" ? Math.min(...vals) : Math.max(...vals);
  const bestAt = vals.lastIndexOf(best);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const labels = n > 1 ? [0, n - 1] : [0];
  // Runs on the same day read better as session numbers than as one repeated date.
  const sameDay = n > 1 && day(points[0].at) === day(points[n - 1].at);
  const xLabel = (i: number) => (sameDay ? `#${i + 1}` : day(points[i].at));
  return (
    <div ref={ref} className="w-full">
      <svg width={W} height={height} className="block max-w-full" role="img" aria-label={`${n} sessions, best ${fmt(best)}`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={i === 1 ? "2 4" : undefined} />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" className="tabular fill-muted-foreground text-[10px]">{t.toFixed(digits && hi - lo < 10 ? 1 : 0)}</text>
          </g>
        ))}
        {n > 1 && <path d={line} fill="none" stroke="var(--highlight)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={n > 40 ? 1.8 : 3} fill={i === bestAt ? "var(--good)" : "var(--highlight)"}>
            <title>{`${day(p.at)} ${new Date(p.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ${fmt(p.value)}`}</title>
          </circle>
        ))}
        <circle cx={x(bestAt)} cy={y(best)} r={7} fill="none" stroke="var(--good)" strokeWidth={1.4} />
        {labels.map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={n === 1 ? "middle" : i === 0 ? "start" : "end"} className="fill-muted-foreground text-[10px]">{xLabel(i)}</text>
        ))}
      </svg>
    </div>
  );
}
