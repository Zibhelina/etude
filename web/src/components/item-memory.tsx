// The Memory and History tabs of the item inspector: the real FSRS forgetting curve for each card, and the
// item's reviews and graded attempts as one timeline.
import { useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { RATING_LABEL, type ItemDetail } from "@/lib/api";
import { EtudeImg } from "@/lib/local-url";
import { useNarrow } from "@/lib/device";
import { cn } from "@/lib/utils";

type Card = ItemDetail["cards"][number];
const DAY = 86_400_000;

/** FSRS-6: R(t) = (1 + F·t/S)^(-d), with F chosen so R(S) = 90% for any decay d. */
const recallAt = (t: number, S: number, d: number) => Math.pow(1 + (Math.pow(0.9, -1 / d) - 1) * t / S, -d);
const DEFAULT_DECAY = 0.1542;

/** The deck's decay isn't sent with the item, but today's recall pins it down: solve R(elapsed) = R now. */
function decayOf(S: number, elapsed: number, R: number | null): number {
  if (R == null || !(S > 0) || elapsed < 0.05 || Math.abs(elapsed - S) / S < 0.02 || R <= 0 || R >= 1) return DEFAULT_DECAY;
  let lo = 0.05, hi = 1.5;
  const f = (d: number) => recallAt(elapsed, S, d) - R;
  if (f(lo) * f(hi) > 0) return DEFAULT_DECAY;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** "3 days", "1.5 mo": a number of days in words. */
export function daysWords(d: number): string {
  if (d < 1) {
    const h = Math.round(d * 24);
    return h <= 1 ? "1 hour" : `${h} hours`;
  }
  const n = Math.round(d);
  if (n === 1) return "1 day";
  if (n < 45) return `${n} days`;
  if (n < 365) return `${(n / 30).toFixed(n < 300 ? 1 : 0).replace(".0", "")} mo`;
  return `${(n / 365).toFixed(1).replace(".0", "")} yr`;
}
/** Time between now (or `from`) and a date, in words: "10 min", "3 hours", "4 days". */
export function untilWords(iso: string, from = Date.now()): string {
  const ms = Math.max(0, new Date(iso).getTime() - from);
  const m = Math.round(ms / 60000);
  if (m < 60) return m <= 1 ? "1 min" : `${m} min`;
  return daysWords(ms / DAY);
}
const agoWords = (d: number) => (d < 1 ? "today" : d < 2 ? "yesterday" : `${daysWords(d)} ago`);
const pct = (r: number) => `${Math.round(r * 100)}%`;

function Big({ value, label, tone, small }: { value: React.ReactNode; label: React.ReactNode; tone?: string; small?: boolean }) {
  return (
    <div className="min-w-0">
      <b className={cn("browse-serif block leading-none tabular tracking-[-0.02em]", small ? "text-[30px] max-md:text-[26px]" : "text-[48px] max-md:text-[42px]", tone)}>{value}</b>
      <span className="mt-1.5 block text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

function Curve({ S, d, elapsed, interval, R, late, compact }: { S: number; d: number; elapsed: number; interval: number; R: number; late: boolean; compact?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth - 28));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const X = Math.max(interval * 1.6, elapsed * 1.25, 8);
  // Drawn at the size it shows, so labels stay 11px whatever the pane's width.
  const W = Math.max(240, (box || (compact ? 382 : 652)) - 52), H = compact ? 150 : 170;
  const rEnd = recallAt(X, S, d);
  const y0 = Math.max(0.5, Math.min(0.8, Math.floor(Math.min(rEnd, R) * 20) / 20 - 0.05));
  const px = (t: number) => (t / X) * W;
  const py = (r: number) => H - ((r - y0) / (1 - y0)) * H;
  let past = "", future = "";
  for (let i = 0; i <= 80; i++) {
    const t = (X * i) / 80;
    const pt = `${px(t).toFixed(1)} ${py(recallAt(t, S, d)).toFixed(1)}`;
    if (t <= elapsed) past += (past ? "L" : "M") + pt;
    else {
      if (!future) future = `M${px(elapsed).toFixed(1)} ${py(R).toFixed(1)}`;
      future += "L" + pt;
    }
  }
  const grid = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1].filter((r) => r >= y0 - 0.001 && (y0 >= 0.7 || Math.round(r * 100) % 10 === 0));
  const rDue = recallAt(interval, S, d);
  const nowColor = late ? "var(--learn)" : "var(--foreground)";
  const labelGap = Math.abs(px(interval) - px(elapsed)) < 44;
  return (
    <svg ref={ref} viewBox={`-38 -16 ${W + 52} ${H + 40}`} className="block w-full overflow-visible text-[11px] font-semibold" role="img" aria-label={`Recall now ${pct(R)}; due at about ${pct(rDue)}`}>
      {grid.map((r) => (
        <g key={r}>
          <line x1="0" x2={W} y1={py(r)} y2={py(r)} stroke="var(--border)" />
          <text x="-8" y={py(r) + 4} textAnchor="end" fill="var(--muted-foreground)">{Math.round(r * 100)}%</text>
        </g>
      ))}
      <line x1="0" x2={W} y1={py(rDue)} y2={py(rDue)} stroke="var(--ring)" strokeDasharray="4 5" strokeWidth="1.3" />
      <path d={past} fill="none" stroke="var(--primary)" strokeWidth="2.6" strokeLinecap="round" />
      <path d={future} fill="none" stroke="var(--primary)" strokeWidth="2.2" strokeDasharray="2 6" strokeLinecap="round" opacity=".8" />
      <line x1={px(interval)} x2={px(interval)} y1={py(rDue)} y2={H} stroke="var(--ring)" strokeWidth="1.3" />
      <circle cx={px(interval)} cy={py(rDue)} r="4.5" fill="var(--background)" stroke="var(--primary)" strokeWidth="2" />
      {!labelGap && <text x={px(interval)} y={H + 18} textAnchor="middle" fill="var(--muted-foreground)">due</text>}
      <line x1={px(elapsed)} x2={px(elapsed)} y1={py(R)} y2={H} stroke={nowColor} strokeWidth="1.6" />
      <circle cx={px(elapsed)} cy={py(R)} r="6" fill={nowColor} />
      <text x={px(elapsed)} y={py(R) - 12} textAnchor="middle" fill={nowColor} fontWeight="700">{pct(R)}</text>
      <text x={px(elapsed)} y={H + 18} textAnchor="middle" fill="var(--foreground)">{labelGap ? (late ? "due · today" : "today · due") : "today"}</text>
      <text x="0" y={H + 18} textAnchor="start" fill="var(--muted-foreground)">last review</text>
    </svg>
  );
}

export function MemoryPanel({ item, onPractice, onForget, onSuspend }: { item: ItemDetail; onPractice(): void; onForget(): void; onSuspend(): void }) {
  const [face, setFace] = useState(0);
  const compact = useNarrow();
  const c: Card | undefined = item.cards[Math.min(face, item.cards.length - 1)];
  const allSuspended = item.cards.every((x) => x.suspended);
  if (!c) return null;
  const faces = item.cards.length > 1 && (
    <div className="mb-5 flex flex-wrap gap-1.5">
      {item.cards.map((x, i) => (
        <button key={x.id} onClick={() => setFace(i)} className={cn("h-8 rounded-full px-3 text-[13px] font-semibold shadow-[inset_0_0_0_1.5px_var(--border)]", i === face ? "bg-foreground text-background shadow-none" : "text-muted-foreground hover:text-foreground")}>{x.face}</button>
      ))}
    </div>
  );
  const actions = (
    <div className="mt-5 flex flex-wrap gap-2">
      {!allSuspended && <Button variant="outline" className="gap-1.5" onClick={onPractice}><Play className="size-3.5 fill-current" />Practice now</Button>}
      {c.state !== 0 && <Button variant="outline" className="gap-1.5" onClick={onForget}><RotateCcw className="size-4" />Start over</Button>}
      <Button variant="outline" className="gap-1.5" onClick={onSuspend}><Pause className="size-4" />{allSuspended ? "Unsuspend" : "Suspend"}</Button>
    </div>
  );

  if (c.state === 0)
    return (
      <div className="pb-6">
        {faces}
        <Big value="New" label="not studied yet" />
        <p className="browse-exp">It joins a session when its deck has room for new cards. After the first review, Etude starts tracking how well you remember it.</p>
        {actions}
      </div>
    );

  const now = Date.now();
  const S = Number(c.stability) || 0;
  const last = c.last_review ? new Date(c.last_review).getTime() : null;
  const due = new Date(c.due).getTime();
  const learning = c.state === 1 || c.state === 3;
  const R = c.retrievability;

  if (learning || last == null || R == null || !(S > 0)) {
    const soon = due - now;
    return (
      <div className="pb-6">
        {faces}
        <div className="grid grid-cols-2 gap-6">
          <Big value={learning ? "Learning" : R != null ? pct(R) : "Review"} label={soon <= 0 ? "due now" : `comes back in ${untilWords(c.due)}`} />
          <Big small value={c.lapses} label="times missed" tone={c.lapses >= 2 ? "text-learn" : undefined} />
        </div>
        <p className="browse-exp">{learning ? "You're still getting this one in. Etude shows it again in short steps until it sticks, then it moves to days." : "This card's deck uses its own scheduler, so there's no forgetting curve to draw."}</p>
        <Facts c={c} />
        {actions}
      </div>
    );
  }

  const elapsed = Math.max(0, (now - last) / DAY);
  const interval = Math.max(0.01, (due - last) / DAY);
  const left = (due - now) / DAY;
  const d = decayOf(S, elapsed, R);
  const rDue = recallAt(interval, S, d);
  const lateDays = Math.floor(-left);
  const late = lateDays >= 1;
  const when = late ? `${daysWords(lateDays)} late` : left <= 0 ? "Due today" : `In ${daysWords(left)}`;
  const exp = late
    ? <>You last saw this <b>{agoWords(elapsed)}</b>. Etude planned to show it after {daysWords(interval)}, when recall drops to about {pct(rDue)}. It's late, so recall is now nearer <b>{pct(R)}</b>. It's at the front of your next session.</>
    : left <= 0
      ? <>You last saw this <b>{agoWords(elapsed)}</b>. Recall is at about <b>{pct(R)}</b>, the point where Etude brings it back, so it's in today's session.</>
      : <>You last saw this <b>{agoWords(elapsed)}</b>. Recall is around <b>{pct(R)}</b> and drops to about {pct(rDue)} in {daysWords(left)}, which is when it comes back. A good review then pushes the next gap out further.</>;
  return (
    <div className="pb-6">
      {faces}
      <div className="grid grid-cols-2 gap-6">
        <Big value={pct(R)} label="chance you'd recall it now" />
        <Big small value={when} label={allSuspended ? "suspended, won't come up" : `every ${daysWords(interval)} right now`} tone={late ? "text-learn" : undefined} />
      </div>
      <div className="browse-paper mt-6 mb-2 px-3.5 pt-3.5 pb-2 max-md:px-1.5 max-md:pt-2.5 max-md:pb-1">
        <Curve S={S} d={d} elapsed={elapsed} interval={interval} R={R} late={late} compact={compact} />
      </div>
      <p className="browse-exp">{exp}</p>
      <Facts c={c} S={S} />
      {actions}
    </div>
  );
}

function Facts({ c, S }: { c: Card; S?: number }) {
  const facts: [React.ReactNode, string, string?][] = [];
  if (S) facts.push([daysWords(S), "Memory strength · time until recall falls to 90%"]);
  if (c.state !== 0) facts.push([<>{Number(c.difficulty).toFixed(1)}<small className="ml-1 font-sans text-[13px] font-semibold text-muted-foreground">/ 10</small></>, "Difficulty · how hard it is for you"]);
  facts.push([c.reps, "Reviews"]);
  facts.push([c.lapses, "Times missed", c.lapses >= 2 ? "text-learn" : undefined]);
  return (
    <div className="mt-6 grid grid-cols-4 gap-[18px] max-lg:grid-cols-2">
      {facts.map(([v, l, tone], i) => (
        <div key={i} className="min-w-0">
          <b className={cn("browse-serif block text-[22px] leading-none tabular", tone)}>{v}</b>
          <span className="mt-1.5 block text-[12.5px] leading-snug text-muted-foreground">{l}</span>
        </div>
      ))}
    </div>
  );
}

const RATING_COLOR = ["", "var(--again)", "var(--hard)", "var(--good)", "var(--easy)"];
const VERDICT_COLOR: Record<string, string> = { correct: "var(--good)", partial: "var(--hard)", incorrect: "var(--again)", ungraded: "var(--ring)" };

export function HistoryPanel({ item }: { item: ItemDetail }) {
  const now = Date.now();
  const multi = item.cards.length > 1;
  const faceOf = new Map(item.cards.map((c) => [c.id, c.face]));
  const events = [
    ...item.reviews.map((r) => ({ kind: "review" as const, ts: r.ts, r })),
    ...item.attempts.map((a) => ({ kind: "attempt" as const, ts: a.ts, a })),
  ].sort((x, y) => y.ts.localeCompare(x.ts));
  const ago = (ts: string) => agoWords((now - new Date(ts).getTime()) / DAY);
  const at = (ts: string) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex flex-col pb-6">
      {events.map((e, i) =>
        e.kind === "review" ? (
          <div key={i} className="browse-hr" title={at(e.ts)}>
            <span className="dt" style={{ background: RATING_COLOR[e.r.rating] }} />
            <span className="when">{ago(e.ts)}</span>
            <span className="min-w-0 truncate font-semibold" style={{ color: RATING_COLOR[e.r.rating] }}>
              {RATING_LABEL[e.r.rating as 1]}
              {multi && <span className="ml-2 font-normal text-muted-foreground">{faceOf.get(e.r.card_id)}</span>}
            </span>
            <span className="nx">{e.r.practice ? "practice" : `next in ${untilWords(e.r.due_after, new Date(e.ts).getTime())}`}{e.r.duration_ms != null && <span className="ml-2 max-md:hidden">· {Math.round(e.r.duration_ms / 1000)}s</span>}</span>
          </div>
        ) : (
          <div key={i} className="browse-hr items-start" title={at(e.ts)}>
            <span className="dt mt-[15px]" style={{ background: VERDICT_COLOR[e.a.grade.verdict] }} />
            <span className="when pt-3">{ago(e.ts)}</span>
            <div className="col-span-2 min-w-0 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                <span className="font-semibold capitalize" style={{ color: VERDICT_COLOR[e.a.grade.verdict] }}>
                  {e.a.grade.verdict}{e.a.grade.score != null && e.a.grade.verdict === "partial" ? ` ${Math.round(e.a.grade.score * 100)}%` : ""}
                </span>
                <span className="text-muted-foreground">answer{e.a.practice ? " · practice" : ""}{e.a.grade.grader.model ? ` · ${e.a.grade.grader.model}` : ""}</span>
              </div>
              <div className="mt-1.5"><AnswerView answer={e.a.answer} /></div>
              {e.a.grade.feedback && <Markdown className="mt-2 text-[0.9rem] text-muted-foreground">{e.a.grade.feedback}</Markdown>}
            </div>
          </div>
        ),
      )}
      <div className="browse-hr">
        <span className="dt" style={{ background: "var(--ring)" }} />
        <span className="when">{ago(item.created)}</span>
        <span className="min-w-0 truncate text-muted-foreground">Added{item.source ? ` from ${item.source}` : ""}</span>
        <span className="nx" />
      </div>
      {!events.length && <p className="browse-exp">Not studied yet.</p>}
    </div>
  );
}

function AnswerView({ answer }: { answer: unknown }) {
  if (answer && typeof answer === "object" && typeof (answer as { image?: unknown }).image === "string") {
    const img = (answer as { image: string }).image;
    return <EtudeImg src={img.startsWith("media:") ? `/media/${img.slice(6)}` : img} alt="drawing" className="max-h-64 rounded-lg border bg-white" />;
  }
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  return <pre className="whitespace-pre-wrap break-words font-mono text-[13px]">{text || <span className="text-muted-foreground">(empty)</span>}</pre>;
}
