// Stats charts (Etude 3): plain bars, the recall gauge with its target notch, stacked share bars and the heatmap.
// Ink bars are the quiet ones; the bar that matters (today, your usual hours) is the highlight colour.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Parse "YYYY-MM-DD" as a local calendar date. */
export const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fmtDay = (s: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) => parseDay(s).toLocaleDateString("en-US", opts);
export const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? "<1 min" : "0 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
export const hourName = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

/** Width of an element in CSS pixels, so charts draw text at its real size instead of scaling a viewBox. */
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

type Tip = { x: number; y: number; lines: ReactNode[] } | null;

/** A dark pill above the pointer, kept inside the chart. */
export function ChartTip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const x = Math.max(70, Math.min(width - 70, tip.x));
  return (
    <div role="tooltip" className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-[9px] bg-foreground px-2.5 py-1.5 text-[12.5px] leading-snug whitespace-nowrap text-background shadow-lg" style={{ left: x, top: tip.y - 10 }}>
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? "font-semibold" : ""}>{l}</div>
      ))}
    </div>
  );
}

/** How a recall value reads against the target: green at or above, amber a little under, red well under. */
export const recallFill = (v: number, target: number) => (v >= target - 0.005 ? "var(--good)" : v >= target - 0.1 ? "var(--hard)" : "var(--learn)");

// ------------------------------------------------------------------ bars

export interface BarsProps {
  values: number[];
  /** Label under each bar ("" for none). */
  labels: string[];
  height: number;
  /** Bars drawn in the highlight colour; the rest are quiet ink. */
  hot?(i: number): boolean;
  /** Bold labels (today, tomorrow). */
  strong?(i: number): boolean;
  /** Numbers above the bars. */
  showValues?(i: number): boolean;
  tip(i: number): ReactNode[];
  /** Scale to the other bars so a big first one (today's pile) doesn't flatten them; it gets a cut mark. */
  capFirst?: boolean;
  /** A dashed marker at a fractional bar index (an exam). */
  mark?: { at: number; label: string } | null;
  label: string;
  /** Labels anchored to each bar's start instead of its middle (long axes). */
  startLabels?: boolean;
}

export function Bars({ values, labels, height, hot, strong, showValues, tip: tipOf, capFirst, mark, label, startLabels }: BarsProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const W = w || 600, n = values.length;
  const pb = 22, pt = mark ? 26 : 18, gap = n > 20 ? 3 : n > 12 ? 4 : 6;
  const bw = (W - gap * (n - 1)) / n;
  // Capping only makes sense when there's something after the first bar to keep readable.
  if (capFirst && !values.slice(1).some((v) => v > 0)) capFirst = false;
  const rest = Math.max(1, ...values.slice(capFirst ? 1 : 0));
  const mx = capFirst ? Math.max(rest * 1.15, Math.min(values[0], rest * 1.6)) : Math.max(1, ...values);
  const cut = capFirst && values[0] > mx;
  const avail = height - pb - pt;
  return (
    <div ref={ref} className="stats-chart relative w-full" onPointerLeave={() => setTip(null)}>
      {w > 0 && (
        <svg width={W} height={height} className="block overflow-visible" role="img" aria-label={label}>
          {values.map((v, i) => {
            const bh = v ? Math.max(4, (avail * Math.min(v, mx)) / mx) : 2;
            const x = i * (bw + gap), y = height - pb - bh;
            const isHot = hot?.(i) ?? false;
            const textX = startLabels ? x : x + bw / 2;
            return (
              <g key={i} onPointerEnter={() => setTip({ x: x + bw / 2, y, lines: tipOf(i) })}>
                <rect x={x - gap / 2} y={0} width={bw + gap} height={height} fill="transparent" />
                <rect className="stats-grow" style={{ transformOrigin: `0 ${height - pb}px`, animationDelay: `${i * 14}ms` }} x={x} y={y} width={bw} height={bh} rx={Math.min(4, bw / 3)} fill={!v ? "var(--stats-track)" : isHot ? "var(--highlight)" : "var(--stats-ink-bar)"} />
                {i === 0 && cut && <path d={`M${x - 1},${y + 16} l${bw + 2},-6 v6 l${-bw - 2},6z`} fill="var(--card)" />}
                {showValues?.(i) && v > 0 && <text x={x + bw / 2} y={y - 6} textAnchor="middle" className={strong?.(i) ? "lab" : ""}>{v}</text>}
                {labels[i] && <text x={textX} y={height - 5} textAnchor={startLabels ? "start" : "middle"} className={strong?.(i) ? "lab" : ""}>{labels[i]}</text>}
              </g>
            );
          })}
          {mark && mark.at >= 0 && mark.at <= n && (
            <g pointerEvents="none">
              <line x1={mark.at * (bw + gap) - gap / 2} x2={mark.at * (bw + gap) - gap / 2} y1={8} y2={height - pb} stroke="var(--foreground)" strokeOpacity={0.55} strokeDasharray="3 3" />
              <text x={mark.at * (bw + gap) + (mark.at > n * 0.75 ? -8 : 4)} y={14} textAnchor={mark.at > n * 0.75 ? "end" : "start"} className="lab">{mark.label}</text>
            </g>
          )}
        </svg>
      )}
      {!w && <div style={{ height }} />}
      <ChartTip tip={tip} width={W} />
    </div>
  );
}

// ------------------------------------------------------------------ gauge

/** Recall on a 50–100% track with tick labels and the target as a small notch above the bar. */
export function Gauge({ value, target }: { value: number; target: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const W = w || 400, h = 60, y = 30, lo = 0.5;
  const x = (v: number) => Math.round(10 + ((W - 20) * (Math.max(lo, Math.min(1, v)) - lo)) / (1 - lo));
  const T = x(target), R = Math.max(x(value), 24);
  return (
    <div ref={ref} className="stats-chart w-full">
      {w > 0 ? (
        <svg width={W} height={h} className="block overflow-visible" role="img" aria-label={`Recall now ${(value * 100).toFixed(0)}%, target ${Math.round(target * 100)}%`}>
          <rect x={10} y={y - 7} width={W - 20} height={14} rx={7} fill="var(--stats-track)" />
          <rect className="stats-grow-x" style={{ transformOrigin: `10px ${y}px` }} x={10} y={y - 7} width={R - 10} height={14} rx={7} fill={recallFill(value, target)} />
          <path d={`M${T - 6},${y - 16} L${T + 6},${y - 16} L${T},${y - 9} Z`} fill="var(--foreground)" />
          <text x={T} y={y - 20} textAnchor="middle" className="lab">target</text>
          {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => (
            <text key={v} x={v === 0.5 ? x(v) - 6 : v === 1 ? x(v) + 6 : x(v)} y={h - 2} textAnchor={v === 0.5 ? "start" : v === 1 ? "end" : "middle"} className={Math.abs(v - target) < 0.001 ? "lab" : ""}>
              {Math.round(v * 100)}%
            </text>
          ))}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
    </div>
  );
}

/** A recall bar for a list row: 50–100% like the gauge, target as a small grey notch above it. */
export function TargetBar({ value, target }: { value: number; target: number }) {
  const at = (v: number) => Math.max(0, Math.min(1, (v - 0.5) / 0.5)) * 100;
  return (
    <div className="relative h-2 rounded-full bg-[var(--stats-track)]" role="img" aria-label={`${Math.round(value * 100)}% remembered now, target ${Math.round(target * 100)}%`}>
      <i className="stats-grow-x absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(4, at(value))}%`, background: recallFill(value, target) }} />
      <b className="absolute -top-[9px] -ml-[5px] size-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-muted-foreground" style={{ left: `${at(target)}%` }} />
    </div>
  );
}

// ------------------------------------------------------------ stacked bar

export type Part = { key: string; label: string; value: number; color: string; hint?: string; onPick?(): void };

/** One bar split into parts with straight joins (rounded only at the ends). */
export function StackBar({ parts, big, label }: { parts: Part[]; big?: boolean; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const [tip, setTip] = useState<Tip>(null);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="relative" onPointerLeave={() => setTip(null)}>
      <div className={cn("flex overflow-hidden rounded-full bg-[var(--stats-track)]", big ? "h-[18px]" : "h-3")} role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
        {total > 0 &&
          parts.map((p) =>
            p.value ? (
              <i
                key={p.key}
                className={cn("block h-full", p.onPick && "cursor-pointer hover:brightness-110")}
                style={{ flex: p.value, background: p.color }}
                onClick={p.onPick}
                onPointerEnter={(e) => {
                  const box = ref.current!.getBoundingClientRect(), r = (e.target as HTMLElement).getBoundingClientRect();
                  setTip({ x: r.left - box.left + r.width / 2, y: 0, lines: [`${p.value.toLocaleString("en-US")} ${p.label.toLowerCase()}`, `${Math.round((p.value / total) * 100)}%`] });
                }}
              />
            ) : null,
          )}
      </div>
      <ChartTip tip={tip} width={ref.current?.clientWidth ?? 300} />
    </div>
  );
}

/** The legend under a StackBar. `show` picks what follows each label: the count or the share. */
export function Keys({ parts, show = "count" }: { parts: Part[]; show?: "count" | "share" }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="mt-3.5 grid grid-cols-2 gap-x-3.5 gap-y-2 text-[12.5px] text-muted-foreground @min-[420px]:grid-cols-[repeat(auto-fill,minmax(112px,1fr))] max-md:text-[13px]">
      {parts.map((p) => {
        const Tag = p.onPick ? "button" : "span";
        return (
          <Tag key={p.key} {...(p.onPick ? { type: "button" as const, onClick: p.onPick } : {})} title={p.hint} className={cn("inline-flex items-center gap-1.5 text-left", p.onPick && "hover:text-foreground", !p.value && "opacity-50")}>
            <i className="inline-block size-2.5 shrink-0 rounded-[3px] max-md:size-3" style={{ background: p.color }} />
            {p.label} <b className="tabular font-semibold text-foreground">{show === "share" ? `${Math.round((p.value / total) * 100)}%` : p.value.toLocaleString("en-US")}</b>
          </Tag>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- heatmap

const HEAT = ["var(--stats-track)", "color-mix(in oklab, var(--highlight) 30%, var(--card))", "color-mix(in oklab, var(--highlight) 55%, var(--card))", "color-mix(in oklab, var(--highlight) 80%, var(--card))", "var(--highlight)"];

/**
 * One column per week (Monday first), newest on the right, starting a little before the first study day.
 * Cells grow to fill the width; on a phone they stay big enough to tap.
 */
export function Heatmap({ days, weeks: maxWeeks, today, phone }: { days: { day: string; reviews: number; again: number; runs?: number; ms: number }[]; weeks: number; today: string; phone?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const W = w || 600, L = 26, T = 16, G = 3;
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const act = (d?: { reviews: number; runs?: number }) => (d ? d.reviews + (d.runs ?? 0) : 0);
  const end = parseDay(today);
  const first = days.find((d) => act(d) > 0)?.day;
  const activeWeeks = first ? Math.ceil((end.getTime() - parseDay(first).getTime()) / (7 * 86400_000)) + 2 : 12;
  const fit = Math.floor((W - L + G) / ((phone ? 14 : 9) + G));
  const want = Math.floor((W - L + G) / ((phone ? 16 : 17) + G));
  const cols = Math.max(4, Math.min(maxWeeks, fit, Math.max(Math.max(12, activeWeeks), want)));
  const C = Math.max(9, Math.floor((W - L + G) / cols - G));
  const start = new Date(end);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (cols - 1) * 7);
  const max = Math.max(1, ...days.map((d) => act(d)));
  const level = (v: number) => (!v ? 0 : v < max * 0.25 ? 1 : v < max * 0.5 ? 2 : v < max * 0.75 ? 3 : 4);
  const cells: ReactNode[] = [];
  const months: ReactNode[] = [];
  let lastM = -1, lastC = -9;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < 7; r++) {
      const d = new Date(start);
      d.setDate(d.getDate() + c * 7 + r);
      if (d > end) continue;
      const k = dayKey(d), e = byDay.get(k), v = act(e), x = L + c * (C + G), y = T + r * (C + G);
      if (r === 0 && d.getMonth() !== lastM) {
        lastM = d.getMonth();
        if (c < cols - 1 && c - lastC >= 3) {
          months.push(<text key={`m${c}`} x={x} y={10}>{d.toLocaleDateString("en-US", { month: "short" })}</text>);
          lastC = c;
        }
      }
      const parts = [];
      if (e?.reviews) parts.push(`${e.reviews} answer${e.reviews === 1 ? "" : "s"}`);
      if (e?.runs) parts.push(`${e.runs} run${e.runs === 1 ? "" : "s"}`);
      const lines = [fmtDay(k), v ? `${parts.join(" · ")}${e!.ms ? ` · ${fmtDuration(e!.ms)}` : ""}` : "no study"];
      cells.push(
        <rect key={k} x={x} y={y} width={C} height={C} rx={C / 4} fill={HEAT[level(v)]} stroke={k === today ? "var(--foreground)" : undefined} strokeWidth={k === today ? 1.6 : 0} onPointerEnter={() => setTip({ x: x + C / 2, y, lines })}>
          <title>{lines.join(": ")}</title>
        </rect>,
      );
    }
  const total = days.reduce((a, d) => a + act(d), 0);
  const active = days.filter((d) => act(d) > 0).length;
  return (
    <div ref={ref} className="stats-chart relative" onPointerLeave={() => setTip(null)}>
      {w > 0 ? (
        <svg width={W} height={T + 7 * (C + G)} className="block overflow-visible" role="img" aria-label={`Answers per day, last ${cols} weeks: ${total} on ${active} days`}>
          {months}
          {["M", "W", "F"].map((l, k) => (
            <text key={l} x={0} y={T + (1 + 2 * k) * (C + G) + C - 2}>{l}</text>
          ))}
          {cells}
        </svg>
      ) : (
        <div style={{ height: 160 }} />
      )}
      <ChartTip tip={tip} width={W} />
      <div className="mt-2 flex items-center justify-end gap-1 text-[11.5px] text-muted-foreground max-md:text-[12.5px]">
        less
        {HEAT.map((c, i) => (
          <i key={i} className="inline-block size-[11px] rounded-[3px] max-md:size-[13px]" style={{ background: c }} />
        ))}
        more
      </div>
    </div>
  );
}
