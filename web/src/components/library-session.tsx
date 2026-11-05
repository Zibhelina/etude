// The top of the Library: today's session (what's due and from where), the compact "done for today"
// panel once it's all done, and a full-screen celebration on every fifth day of a streak, shown once.
import { useEffect, useMemo, useState } from "react";
import { Check, FastForward, Play, Sprout } from "lucide-react";
import type { DeckNode, Stats } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useFunMode } from "@/lib/fun";
import { Mark } from "@/components/phone-shell";
import { DeckIcon } from "@/components/deck-icon";
import { leafOf } from "@/components/move-deck";
import cheer from "@/assets/library/minimi-cheer.webp";

const work = (d: DeckNode) => d.new + d.learning + d.review;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

/**
 * Seconds per card for the time estimate, from recent days of mostly rated answers (a drill's runs can
 * take minutes each and would swamp it); 12 s before there's enough history.
 */
function perCard(stats: Stats | null) {
  const d = (stats?.days ?? []).filter((x) => x.reviews > 0 && x.runs <= x.reviews * 0.1);
  const n = d.reduce((a, x) => a + x.reviews + x.runs, 0);
  const ms = d.reduce((a, x) => a + x.ms, 0);
  return n >= 15 && ms > 0 ? Math.min(45, Math.max(4, ms / n / 1000)) : 12;
}

function minutes(sec: number) {
  const m = Math.round(sec / 60);
  return m < 1 ? "under a minute" : m < 90 ? `about ${m} min` : `about ${Math.round(m / 6) / 10} h`;
}

/** The pill button with the pressed edge, used for the main actions here. */
export function PrimaryButton({ className, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...p} className={cn("lib-primary inline-flex h-12 items-center justify-center gap-2.5 rounded-xl px-6 text-[16px] font-semibold transition-[transform,box-shadow,filter] select-none disabled:opacity-50", className)}>
      {children}
    </button>
  );
}

/** The session card when something is due: the total, its kinds, Start, and the decks it comes from. */
export function SessionCard({ decks, stats, phone }: { decks: DeckNode[]; stats: Stats | null; phone?: boolean }) {
  const names = new Set(decks.map((d) => d.name));
  const top = decks.filter((d) => !names.has(d.name.split("::").slice(0, -1).join("::")));
  const study = top.filter((d) => d.mode !== "watch");
  const t = study.reduce((a, d) => ({ n: a.n + d.new, l: a.l + d.learning, r: a.r + d.review, done: a.done + d.doneToday }), { n: 0, l: 0, r: 0, done: 0 });
  const due = t.n + t.l + t.r;
  const from = study.filter((d) => work(d) > 0).sort((a, b) => work(b) - work(a));
  const shown = from.slice(0, phone ? 4 : 5);
  const rest = from.slice(shown.length);
  const max = Math.max(1, ...shown.map(work));
  const done = stats?.today.reviews ?? t.done;
  return (
    <section aria-label="Today's session" className={cn("lib-panel rounded-2xl p-6 sm:p-8", !phone && "@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] @3xl:gap-10")}>
      <div className="min-w-0">
        <div className="score-kicker font-semibold">Today’s session</div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="lib-title text-[3.4rem] leading-[0.9] font-semibold tabular sm:text-[3.6rem]">{due.toLocaleString()}</span>
          <span className="text-[16px] text-muted-foreground">card{due === 1 ? "" : "s"} · {minutes(due * perCard(stats))}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] font-semibold tabular">
          {t.n > 0 && <span className="inline-flex items-center gap-1.5 text-new"><Mark kind="new" />{t.n.toLocaleString()} new</span>}
          {t.l > 0 && <span className="inline-flex items-center gap-1.5 text-learn"><Mark kind="learn" />{t.l.toLocaleString()} learning</span>}
          {t.r > 0 && <span className="inline-flex items-center gap-1.5 text-review"><Mark kind="due" />{t.r.toLocaleString()} due</span>}
        </div>
        <PrimaryButton className={cn("mt-7", phone && "w-full")} onClick={() => navigate("/study")} aria-label="Start today's session">
          <Play className="size-4 fill-current" />Start
        </PrimaryButton>
        {done > 0 && <p className="mt-3 text-[13.5px] text-muted-foreground">{plural(done, "card")} done today</p>}
      </div>
      {shown.length > 0 && (
        <ul className={cn("min-w-0 self-center", phone ? "mt-6" : "mt-7 @3xl:mt-0")} aria-label="Where today's cards come from">
          {shown.map((d) => (
            <li key={d.id}>
              <button onClick={() => navigate(`/study?deck=${encodeURIComponent(d.name)}`)} className="group grid h-[2.15rem] w-full grid-cols-[auto_minmax(0,1fr)_4.5rem_2.25rem] items-center gap-3 rounded-lg text-left text-[15px] sm:grid-cols-[auto_minmax(0,1fr)_minmax(5rem,42%)_2.5rem] @3xl:grid-cols-[auto_minmax(0,1fr)_5rem_2.5rem]">
                <span className="flex w-6 justify-center">{d.icon ? <DeckIcon icon={d.icon} size={24} /> : <span className="size-1.5 rounded-full bg-muted-foreground/40" />}</span>
                <span className="truncate group-hover:underline">{leafOf(d.name)}</span>
                <Bar d={d} max={max} />
                <span className="text-right text-muted-foreground tabular">{work(d)}</span>
              </button>
            </li>
          ))}
          {rest.length > 0 && (
            <li className="grid h-[2.15rem] grid-cols-[auto_minmax(0,1fr)_4.5rem_2.25rem] items-center gap-3 text-[15px] text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)_minmax(5rem,42%)_2.5rem] @3xl:grid-cols-[auto_minmax(0,1fr)_5rem_2.5rem]">
              <span className="w-6" />
              <span className="truncate">and {plural(rest.length, "more deck")}</span>
              <span />
              <span className="text-right tabular">{rest.reduce((a, d) => a + work(d), 0)}</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** One deck's share of the session: new, learning and due as one bar with straight joins. */
function Bar({ d, max }: { d: DeckNode; max: number }) {
  const w = work(d);
  return (
    <span className="lib-track h-1.5 overflow-hidden rounded-full" aria-hidden>
      <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(6, (w / max) * 100)}%` }}>
        {d.new > 0 && <span className="h-full bg-new" style={{ flexGrow: d.new }} />}
        {d.learning > 0 && <span className="h-full bg-learn" style={{ flexGrow: d.learning }} />}
        {d.review > 0 && <span className="h-full bg-review" style={{ flexGrow: d.review }} />}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ done for today

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** This week, Monday first: which days had study, and which one is today. */
function week(stats: Stats | null) {
  const studied = new Set((stats?.days ?? []).filter((d) => d.reviews + d.runs > 0).map((d) => d.day));
  const today = stats?.today.day ? new Date(stats.today.day + "T12:00:00") : new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return WEEKDAYS.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const isToday = key === stats?.today.day;
    return { label, on: studied.has(key) || (isToday && !!stats && stats.today.reviews + stats.today.runs > 0), today: isToday, future: d > today };
  });
}

export function Flame({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="lib-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--lib-streak-hi)" />
          <stop offset="1" stopColor="var(--lib-streak)" />
        </linearGradient>
      </defs>
      <path fill="url(#lib-flame)" d="M12 21c4 0 6.5-2.6 6.5-6.2 0-4.3-3.7-6.6-4.6-10.3-2.6 1.6-3.6 4-3.4 6.1-1.3-.6-2-1.9-2.2-3.2C6.6 9 5.5 11.2 5.5 14.8 5.5 18.4 8 21 12 21z" />
    </svg>
  );
}

export function WeekDots({ stats, size = "sm" }: { stats: Stats | null; size?: "sm" | "lg" }) {
  return (
    <div className={cn("flex", size === "lg" ? "gap-2.5" : "gap-2")} aria-label="This week">
      {week(stats).map((d, i) => (
        <div key={i} className="flex flex-col items-center gap-1.5" aria-label={`${d.label}${d.on ? ", studied" : ""}${d.today ? ", today" : ""}`}>
          <span
            className={cn("lib-day grid place-items-center rounded-full", size === "lg" ? "size-10" : "size-[1.6rem]", d.on && "on", d.today && "today")}
            style={d.on ? { animationDelay: `${i * 50}ms` } : undefined}
          >
            {d.on && <Check className={size === "lg" ? "size-5" : "size-3.5"} strokeWidth={3.2} />}
          </span>
          <small className={cn("text-[10.5px] font-bold", d.today ? "text-[var(--lib-streak-ink)]" : d.on ? "text-muted-foreground" : "text-muted-foreground/50")}>{d.label}</small>
        </div>
      ))}
    </div>
  );
}

/** Nothing left today: the streak, what today took, and what's next. */
export function DonePanel({ decks, stats, phone }: { decks: DeckNode[]; stats: Stats | null; phone?: boolean }) {
  const today = stats?.today;
  const did = (today?.reviews ?? 0) + (today?.runs ?? 0);
  const rated = today ? today.reviews : 0;
  const pass = rated ? Math.round(((rated - (today?.again ?? 0)) / rated) * 100) : null;
  const unseen = decks.filter((d) => d.depth === 0 && d.mode !== "watch").reduce((a, d) => a + d.unseen, 0);
  const tomorrow = stats?.forecast[1]?.due ?? null;
  const streak = stats?.streak ?? 0;
  const facts = did ? [plural(did, "card"), today!.ms >= 60_000 ? `${Math.round(today!.ms / 60_000)} min` : null, pass != null ? `${pass}% remembered` : null].filter(Boolean).join(" · ") : "Nothing is due right now.";
  return (
    <section aria-label="Done for today" className="lib-panel rounded-2xl px-6 py-5 sm:px-7">
      <div className={cn("flex gap-x-6 gap-y-4", phone ? "flex-col" : "flex-wrap items-center")}>
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {streak > 0 && (
            <span className="flex items-center gap-1" aria-label={`${streak} day streak`}>
              <Flame size={26} />
              <b className="text-[1.9rem] leading-none font-extrabold tracking-tight text-[var(--lib-streak)] tabular">{streak}</b>
            </span>
          )}
          <div className="min-w-0">
            <div className="lib-title text-[1.4rem] leading-tight font-semibold">{did ? "Done for today." : "All caught up."}</div>
            <div className={cn("mt-0.5 text-muted-foreground", phone ? "text-[13.5px]" : "text-[14.5px]")}>{facts}</div>
          </div>
        </div>
        <WeekDots stats={stats} />
      </div>
      <div className="lib-rule my-4 h-px" />
      <div className={cn("flex gap-3", phone ? "flex-col" : "flex-wrap items-center")}>
        {unseen > 0 && (
          <PrimaryButton className={cn("h-11 px-5 text-[15px]", phone && "w-full")} onClick={() => navigate("/study?q=is%3Anew")}>
            <Sprout className="size-4" />Learn new cards
          </PrimaryButton>
        )}
        <button onClick={() => navigate("/study?ahead=1")} className={cn("lib-dotted inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold", phone && "w-full")}>
          <FastForward className="size-4" />Practice ahead
        </button>
        {tomorrow != null && <span className={cn("text-[14.5px] text-muted-foreground tabular", phone ? "text-[13.5px]" : "ml-auto")}><b className="font-semibold text-foreground">{tomorrow.toLocaleString()}</b> due tomorrow</span>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the celebration

const SEEN = "etude.streakCelebrated";
const line = (n: number) => (n === 5 ? "Five days in a row! Okay, I’m impressed." : n === 10 ? "Ten days. TEN. I’m telling everyone." : `${n} days in a row! Look at you.`);

/** True once per milestone: the streak is a multiple of 5, today counted, and it hasn't been shown. */
export function useMilestone(stats: Stats | null, allDone: boolean) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!stats || !allDone) return;
    const n = stats.streak;
    const did = stats.today.reviews + stats.today.runs > 0;
    const key = `${stats.today.day}:${n}`;
    if (n > 0 && n % 5 === 0 && did && localStorage.getItem(SEEN) !== key) setShow(true);
  }, [stats, allDone]);
  const close = () => {
    if (stats) localStorage.setItem(SEEN, `${stats.today.day}:${stats.streak}`);
    setShow(false);
  };
  return { show, close };
}

export function StreakCelebration({ stats, onClose }: { stats: Stats; onClose(): void }) {
  const fun = useFunMode();
  const n = stats.streak;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const confetti = useMemo(() => Array.from({ length: 26 }, (_, i) => ({ x: (i * 37) % 100, d: (i % 7) * 120, r: (i * 53) % 360, c: i % 5 })), []);
  return (
    <div role="dialog" aria-modal="true" aria-label={`${n} day streak`} className="lib-celebrate fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-background">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {confetti.map((p, i) => <b key={i} className="lib-confetti" style={{ left: `${p.x}%`, animationDelay: `${p.d}ms`, ["--r" as string]: `${p.r}deg`, background: `var(--lib-confetti-${p.c})` }} />)}
      </div>
      <div className="relative flex max-w-[28rem] flex-col items-center px-6 py-10 text-center">
        {fun ? (
          <>
            <div className="relative grid h-[12rem] w-[12rem] place-items-end sm:h-[13.5rem] sm:w-[13rem]">
              <span className="lib-burst" aria-hidden>{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 26}deg`, animationDelay: `${(i % 4) * 80}ms` }} />)}</span>
              <img src={cheer} alt="Minimi cheering" className="lib-cheer w-full" draggable={false} />
            </div>
            <p className="mt-6 text-[17px] font-semibold">{line(n)}</p>
          </>
        ) : (
          <Flame size={120} />
        )}
        <div className="mt-5 flex items-center gap-1">
          <Flame size={64} />
          <b className="lib-pop text-[4.4rem] leading-none font-extrabold tracking-[-0.04em] text-[var(--lib-streak)] tabular sm:text-[5.25rem]">{n}</b>
        </div>
        <div className="mb-5 text-[20px] font-bold text-[var(--lib-streak-ink)]">day streak</div>
        <WeekDots stats={stats} size="lg" />
        <p className="mt-6 mb-7 text-[15px] leading-relaxed text-balance text-muted-foreground">You studied {n} days in a row. Come back tomorrow to keep it going.</p>
        <PrimaryButton className="h-[3.25rem] w-full max-w-[21rem] text-[17px]" onClick={onClose}>Continue</PrimaryButton>
      </div>
    </div>
  );
}
