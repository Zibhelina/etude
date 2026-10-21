import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Parse "YYYY-MM-DD" as a local calendar date. */
export const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fmtDay = (s: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) => parseDay(s).toLocaleDateString(undefined, opts);
export const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? "<1 min" : "0 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

type Tip = { x: number; y: number; lines: string[] } | null;

/** Width of an element in CSS pixels, so charts draw text at its real size instead of scaling a viewBox. */
function useWidth<T extends HTMLElement>() {
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

/** A tooltip positioned inside a relative container, clamped to stay on screen. */
function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.max(4, Math.min(width - 184, tip.x - 90));
  return (
    <div className="pointer-events-none absolute z-10 w-[180px] rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style={{ left, top: Math.max(0, tip.y - 8), transform: "translateY(-100%)" }}>
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? "font-medium" : "text-muted-foreground"}>{l}</div>
      ))}
    </div>
  );
}

/**
 * Review heatmap: one column per week (Monday first), one row per weekday, newest week on the right.
 * Cell color scales with reviews; the again rate shows in the tooltip.
 */
export function Heatmap({ days, weeks: maxWeeks, today }: { days: { day: string; reviews: number; again: number; ms: number }[]; weeks: number; today: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const L = 30, T = 20, G = 3;
  // As many weeks as fit at a readable cell size (up to maxWeeks), then cells grow to fill the width.
  const weeks = width ? Math.max(8, Math.min(maxWeeks, Math.floor((width - L) / (11 + G)))) : maxWeeks;
  const C = width ? Math.max(9, Math.min(28, Math.floor((width - L) / weeks) - G)) : 12;
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const end = parseDay(today);
  // Start on the Monday `weeks - 1` weeks before this week's Monday.
  const start = new Date(end);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (weeks - 1) * 7);
  const cells: { key: string; col: number; row: number; future: boolean }[] = [];
  const months: { col: number; label: string }[] = [];
  for (let i = 0, d = new Date(start); i < weeks * 7; i++, d.setDate(d.getDate() + 1)) {
    const col = Math.floor(i / 7), row = i % 7;
    cells.push({ key: dayKey(d), col, row, future: d > end });
    if (d.getDate() <= 7 && row === 0) months.push({ col, label: d.toLocaleDateString(undefined, { month: "short" }) });
  }
  const shown = new Set(cells.map((c) => c.key));
  const visible = days.filter((d) => shown.has(d.day));
  const max = Math.max(1, ...visible.map((d) => d.reviews));
  const W = L + weeks * (C + G), H = T + 7 * (C + G);
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)));
  const total = visible.reduce((a, d) => a + d.reviews, 0);
  const active = visible.filter((d) => d.reviews > 0).length;

  return (
    <div ref={ref} className="relative">
      <div className="overflow-hidden">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full" role="img" aria-label={`Reviews per day over the last ${weeks} weeks: ${total} reviews on ${active} days`} onMouseLeave={() => setTip(null)}>
          <title>{`Reviews per day, last ${weeks} weeks`}</title>
          {months.map((m, i) => (
            <text key={i} x={L + m.col * (C + G)} y={11} className="fill-muted-foreground" fontSize={11}>{m.label}</text>
          ))}
          {["Mon", "", "Wed", "", "Fri", "", ""].map((l, r) => l && (
            <text key={r} x={0} y={T + r * (C + G) + C / 2 + 4} className="fill-muted-foreground" fontSize={11}>{l}</text>
          ))}
          {cells.map((c) => {
            if (c.future) return null;
            const d = byDay.get(c.key);
            const n = d?.reviews ?? 0;
            const lv = level(n);
            const isToday = c.key === today;
            return (
              <rect
                key={c.key}
                x={L + c.col * (C + G) + (isToday ? 0.75 : 0)}
                y={T + c.row * (C + G) + (isToday ? 0.75 : 0)}
                width={isToday ? C - 1.5 : C}
                height={isToday ? C - 1.5 : C}
                rx={2.5}
                fill={lv === 0 ? "var(--muted)" : "var(--highlight)"}
                fillOpacity={lv === 0 ? 0.55 : [0, 0.28, 0.5, 0.75, 1][lv]}
                stroke={isToday ? "var(--foreground)" : "none"}
                strokeWidth={isToday ? 1.5 : 0}
                onMouseEnter={(e) => {
                  const box = ref.current!.getBoundingClientRect();
                  const r = (e.target as SVGRectElement).getBoundingClientRect();
                  setTip({
                    x: r.left - box.left + r.width / 2,
                    y: r.top - box.top,
                    lines: [
                      fmtDay(c.key),
                      n ? `${n} review${n === 1 ? "" : "s"} · ${Math.round(((d!.again) / n) * 100)}% again` : "No reviews",
                      ...(d?.ms ? [fmtDuration(d.ms)] : []),
                    ],
                  });
                }}
              >
                <title>{`${fmtDay(c.key)}: ${n} review${n === 1 ? "" : "s"}${n ? `, ${Math.round((d!.again / n) * 100)}% again` : ""}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <Tooltip tip={tip} width={width || 300} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" style={{ width: W, maxWidth: "100%" }}>
        <span className="tabular mr-auto basis-full pb-1 sm:basis-auto sm:pb-0">Last {weeks} weeks · {total} review{total === 1 ? "" : "s"} on {active} day{active === 1 ? "" : "s"}</span>
        Less
        {[0, 1, 2, 3, 4].map((lv) => (
          <span key={lv} className="size-3 rounded-[2px]" style={{ background: lv ? "var(--highlight)" : "var(--muted)", opacity: lv ? [0, 0.28, 0.5, 0.75, 1][lv] : 0.55 }} />
        ))}
        More
      </div>
    </div>
  );
}

/** Vertical bars with a few y gridlines; `mark` draws a labeled vertical line at a fractional bar index. */
export function BarChart({
  data,
  height = 160,
  color = "var(--review)",
  highlight,
  mark,
  label,
  valueLabel,
  ticks: tickAt,
  format = (v: number) => String(v),
}: {
  data: { key: string; value: number; label: string }[];
  height?: number;
  color?: string;
  highlight?: number;
  mark?: { at: number; label: string } | null;
  label: string;
  valueLabel(v: number, i: number): string[];
  /** Bar indexes to label on the x axis; by default as many as fit. */
  ticks?: number[];
  format?(v: number): string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(240, width || 600), L = 34, R = 8, B = 24;
  const T = mark ? 26 : 12;
  const H = height;
  const n = data.length;
  const max = Math.max(...data.map((d) => d.value), 0);
  const nice = (() => {
    if (max <= 4) return Math.max(1, Math.ceil(max));
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
    return 10 * p;
  })();
  const ticks = nice <= 4 ? Array.from({ length: nice + 1 }, (_, i) => i) : [0, nice / 2, nice];
  const bw = (W - L - R) / n;
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  // Label only as many bars as fit, always keeping the first one and never colliding with it.
  const every = Math.max(1, Math.ceil(52 / bw));
  const labelled = (i: number) => (tickAt ? tickAt.includes(i) && (bw >= 9 || i === 0 || i === n - 1 || i % 14 === 0) : i === 0 || (i % every === 0 && i >= every));
  return (
    <div ref={ref} className="relative w-full">
      <svg width={W} height={H} className="block max-w-full" role="img" aria-label={label} onMouseLeave={() => { setTip(null); setHover(null); }}>
        <title>{label}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={L - 7} y={y(t) + 4} textAnchor="end" fontSize={11} className="fill-muted-foreground tabular">{format(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 2 : 0, (H - T - B) * (d.value / nice));
          const x = L + i * bw;
          const active = hover === i;
          return (
            <g key={d.key}>
              <rect
                x={x}
                y={T}
                width={bw}
                height={H - T - B}
                fill={active ? "var(--accent)" : "transparent"}
                opacity={0.6}
                onMouseEnter={() => {
                  setHover(i);
                  setTip({ x: x + bw / 2, y: y(d.value), lines: valueLabel(d.value, i) });
                }}
              />
              <rect x={x + bw * 0.15} y={H - B - h} width={bw * 0.7} height={h} rx={Math.min(2.5, bw * 0.15)} fill={i === highlight ? "var(--highlight)" : color} opacity={hover === null || active ? 1 : 0.7} pointerEvents="none" />
              {labelled(i) && d.label && (
                <text x={i === 0 ? x + bw * 0.15 : i === n - 1 ? x + bw * 0.85 : x + bw / 2} y={H - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={11} className={i === highlight ? "fill-highlight" : "fill-muted-foreground"}>{d.label}</text>
              )}
            </g>
          );
        })}
        {mark && mark.at >= 0 && mark.at <= n && (
          <g pointerEvents="none">
            <line x1={L + mark.at * bw} x2={L + mark.at * bw} y1={T - 16} y2={H - B} stroke="var(--highlight)" strokeDasharray="3 3" />
            <text x={L + mark.at * bw + (mark.at > n * 0.75 ? -5 : 5)} y={T - 8} fontSize={11} textAnchor={mark.at > n * 0.75 ? "end" : "start"} className="fill-highlight">{mark.label}</text>
          </g>
        )}
      </svg>
      <Tooltip tip={tip} width={W} />
    </div>
  );
}

/** One horizontal stacked bar with a legend; each segment's share is in its label. */
export function ShareBar({ parts, label }: { parts: { key: string; label: string; value: number; color: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const pct = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value} (${pct(p.value)}%)`).join(", ")}`}>
        {parts.map((p) => p.value > 0 && <div key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} className="h-full first:rounded-l-full last:rounded-r-full" title={`${p.label}: ${p.value} (${pct(p.value)}%)`} />)}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-10 gap-y-2 min-[480px]:grid-cols-2">
        {parts.map((p) => (
          <div key={p.key} className={cn("flex min-w-0 items-center gap-2 text-sm", !p.value && "opacity-50")}>
            <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.label}</span>
            <span className="tabular ml-auto shrink-0 font-medium">{p.value}</span>
            <span className="tabular w-12 shrink-0 text-right text-xs text-muted-foreground">{total ? `${pct(p.value)}%` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Small horizontal meter for a 0..1 value, colored by how risky the value is. */
export function RecallMeter({ value }: { value: number | null }) {
  if (value == null) return <div className="h-1.5 w-full rounded-full bg-muted" />;
  const color = value < 0.7 ? "var(--again)" : value < 0.85 ? "var(--hard)" : "var(--good)";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full" style={{ width: `${Math.max(2, value * 100)}%`, background: color }} />
    </div>
  );
}
