// Stats (Etude 3, "Answers"): every section asks a plain question, answers it in one sentence, and puts
// the chart under it. Memory and today first, then habits, the forecast, the forgetting curve and weak spots;
// quieter sections after. Each scheduler gets its own page: FSRS has a memory model, a rated script
// (Leitner) has due dates and ratings but no recall, a drill is measured by its runs.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Flame, Library, Play, Store } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bars, Gauge, Heatmap, Keys, StackBar, TargetBar, dayKey, fmtDay, fmtDuration, hourName, parseDay, type Part } from "@/components/stats-charts";
import { ForgettingCurve, Histogram, ProgressChart, crossing, spanWord } from "@/components/stats-viz";
import { api, type DeckNode, type LearnerSummary, type PracticeCard, type StatsScheduler, type Stats, type StatsDeck } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useFunMode } from "@/lib/fun";
import { useNarrow } from "@/lib/device";
import { track } from "@/lib/telemetry";
import { useMinimiFace } from "@/lib/minimi-face";

/** The engine window: ratings, verdicts and the heatmap cover this many weeks. */
const WEEKS = 26;
const pct = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const num = (n: number) => Math.round(n).toLocaleString("en-US");
const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
/** Deck names often start with an ordering number ("3 Find it on the table"); the page shows the words. */
const shortName = (deck: string) => deck.split("::").pop()!.replace(/^\d+\s+/, "") || deck.split("::").pop()!;
const studyUrl = (deck?: string, extra = "") => (deck ? `/study?deck=${encodeURIComponent(deck)}${extra}` : `/study${extra ? `?${extra.slice(1)}` : ""}`);

export function StatsPage({ deck }: { deck?: string }) {
  // Usage count (only when the person turned usage stats on).
  useEffect(() => track("stats.open"), []);
  const [stats, setStats] = useState<Stats | null>(null);
  const [decks, setDecks] = useState<DeckNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.decks().then(setDecks).catch(() => {});
  }, []);
  useEffect(() => {
    setStats(null);
    api
      .stats({ deck }, WEEKS * 7)
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((e) => {
        setError((e as Error).message);
        toast.error((e as Error).message);
      });
  }, [deck]);

  const empty = stats ? stats.schedulers.reduce((a, x) => a + x.cards, 0) === 0 : false;
  return (
    <div className="@container mx-auto w-full max-w-5xl px-8 pt-[30px] max-md:px-3 phone:pt-[calc(1rem+env(safe-area-inset-top))] max-lg:px-8 max-md:pb-4">
      <Header deck={deck} decks={decks} hideScope={empty && !deck} />
      {error && !stats && <div className="stats-card px-6 py-12 text-center text-muted-foreground">{error}</div>}
      {!stats && !error && <Loading />}
      {stats && <Body stats={stats} deck={deck} />}
    </div>
  );
}

function Header({ deck, decks, hideScope }: { deck?: string; decks: DeckNode[]; hideScope: boolean }) {
  const scope = (v: string) => navigate(v === "__all" ? "/stats" : `/stats?deck=${encodeURIComponent(v)}`, { replace: true });
  const live = decks.filter((d) => !d.archived);
  return (
    <header className="mb-[26px] flex flex-wrap items-end gap-3.5 max-md:mb-[18px] max-md:px-1.5">
      <div>
        <div className="text-xs font-bold tracking-[.13em] text-muted-foreground uppercase">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</div>
        <h1 className="stats-serif mt-1.5 text-[32px] leading-[1.1] font-semibold tracking-[-.01em]">Stats</h1>
      </div>
      <div className="flex-1" />
      {!hideScope && (
        <Select value={deck ?? "__all"} onValueChange={scope}>
          <SelectTrigger aria-label="Scope" className="h-auto max-w-[280px] gap-2.5 rounded-[11px] border-0 bg-card py-2 pr-3 pl-2.5 text-sm font-semibold shadow-[inset_0_0_0_1px_var(--border)] max-md:w-full max-md:max-w-none max-md:py-[11px] [&>svg:last-child]:hidden">
            <Library className="size-[18px] shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left"><SelectValue /></span>
            <ChevronDown className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={2.2} />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-96" align="end">
            <SelectItem value="__all">All decks</SelectItem>
            {live.length > 0 && <SelectSeparator />}
            {live.map((d) => (
              <SelectItem key={d.id} value={d.name}>
                <span style={{ paddingLeft: d.depth * 14 }}>{d.name.split("::").pop()}</span>
              </SelectItem>
            ))}
            {deck && !live.some((d) => d.name === deck) && <SelectItem value={deck}>{deck}</SelectItem>}
          </SelectContent>
        </Select>
      )}
    </header>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-[22px] max-md:gap-3" aria-busy>
      <div className="h-64 animate-pulse rounded-2xl bg-[var(--stats-track)]" />
      <div className="h-72 animate-pulse rounded-2xl bg-[var(--stats-track)]" />
      <div className="h-56 animate-pulse rounded-2xl bg-[var(--stats-track)]" />
    </div>
  );
}

// ------------------------------------------------------------------ layout pieces

function Section({ q, a, aside, children, className, label }: { q: ReactNode; a?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? (typeof q === "string" ? q : undefined)} className={cn("stats-card @container min-w-0 px-[26px] py-6 max-md:rounded-[18px] max-md:px-4 max-md:pt-[18px] max-md:pb-4", className)}>
      <Q aside={aside}>{q}</Q>
      {a && <A>{a}</A>}
      {children}
    </section>
  );
}

function Q({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-2.5 text-xs font-bold tracking-[.13em] text-muted-foreground uppercase max-md:text-[11px]", aside && "min-h-7")}>
      <h2>{children}</h2>
      <span className="flex-1" />
      {aside && <div className="tracking-normal normal-case">{aside}</div>}
    </div>
  );
}

function A({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("stats-serif stats-a mt-2.5 mb-[18px] max-w-[760px] text-[23px] leading-[1.3] font-medium tracking-[-.005em] text-pretty max-md:mt-1.5 max-md:mb-3 max-md:text-[19px]", className)}>{children}</p>;
}

function Foot({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("stats-foot mt-3 text-[13px] leading-[1.45] text-pretty text-muted-foreground max-md:leading-normal", className)}>{children}</p>;
}

function Row2({ children }: { children: ReactNode }) {
  return <div className="grid gap-[22px] max-md:gap-3 @min-[860px]:grid-cols-2">{children}</div>;
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[22px] max-md:gap-3">{children}</div>;
}

/** A two- or three-option switch in a section's corner. */
function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange(v: T): void; label: string }) {
  return (
    <span className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[9px] bg-[var(--stats-track)] p-[3px]" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={cn("rounded-[7px] px-2.5 py-[5px] text-[12.5px] font-semibold text-muted-foreground transition-colors", value === v ? "bg-card text-foreground shadow-sm" : "hover:text-foreground")}>
          {l}
        </button>
      ))}
    </span>
  );
}

function Kv({ items, className }: { items: { value: ReactNode; label: string; tone?: string }[]; className?: string }) {
  return (
    <div className={cn("grid grid-cols-3 gap-3 max-md:gap-2", className)}>
      {items.map((it) => (
        <div key={it.label} className="flex min-w-0 flex-col gap-0.5">
          <b className={cn("stats-serif tabular text-[30px] leading-none font-semibold tracking-[-.02em] max-md:text-[26px]", it.tone)}>{it.value}</b>
          <span className="truncate text-[12.5px] font-medium text-muted-foreground">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Minimi says the one useful thing in Fun mode; with Fun off it's a plain line, or nothing. */
function MinimiLine({ text, plain }: { text: ReactNode; plain?: ReactNode }) {
  const fun = useFunMode();
  const minimiFace = useMinimiFace();
  if (!fun) return plain ? <Foot className="mb-1.5">{plain}</Foot> : null;
  return (
    <div className="mt-3.5 mb-1.5 flex items-start gap-3">
      <img src={minimiFace} alt="Minimi" className="size-11 shrink-0 rounded-full bg-[var(--stats-track)] object-cover max-md:size-9" />
      <p className="relative mt-1 max-w-[560px] rounded-[4px_14px_14px_14px] bg-[var(--stats-bubble)] px-3.5 py-2.5 text-[14.5px] leading-[1.42] text-pretty max-md:px-3 max-md:py-[9px] max-md:text-[13.5px] [&_b]:font-semibold">
        <span aria-hidden className="absolute top-3 -left-1.5 size-3 rotate-45 rounded-[2px] bg-[var(--stats-bubble)]" />
        <span className="relative">{text}</span>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ derived numbers

interface DeckRoll {
  deck: string;
  cards: number;
  new: number;
  learning: number;
  young: number;
  mature: number;
  seen: number;
  recall: number | null;
  due: number;
  scripted: number;
}

/** Add each deck's own rows up into the deck itself plus everything under it. */
function rollUp(rows: StatsDeck[], name: string): DeckRoll {
  const out: DeckRoll = { deck: name, cards: 0, new: 0, learning: 0, young: 0, mature: 0, seen: 0, recall: null, due: 0, scripted: 0 };
  let rs = 0;
  for (const r of rows) {
    if (r.deck !== name && !r.deck.startsWith(name + "::")) continue;
    out.cards += r.cards;
    out.new += r.new;
    out.learning += r.learning;
    out.young += r.review - r.mature;
    out.mature += r.mature;
    out.seen += r.seen;
    out.due += r.due;
    out.scripted += r.scripted;
    if (r.recall != null) rs += r.recall * r.seen;
  }
  out.recall = out.seen ? rs / out.seen : null;
  return out;
}

function derive(s: Stats) {
  const act = (d: { reviews: number; runs?: number }) => d.reviews + (d.runs ?? 0);
  const totalReviews = s.days.reduce((a, d) => a + d.reviews, 0);
  const totalAnswers = s.days.reduce((a, d) => a + act(d), 0);
  const totalMs = s.days.reduce((a, d) => a + d.ms, 0);
  const activeDays = s.days.filter((d) => act(d) > 0).length;
  const target = s.desiredRetention ?? 0.9;
  // Seconds per answer: today's pace once there are enough answers today, else the window's, else a guess.
  const perAnswer = s.today.reviews >= 10 && s.today.ms ? s.today.ms / s.today.reviews : totalAnswers >= 20 && totalMs ? totalMs / totalAnswers : 10_000;
  const minutes = (n: number) => Math.max(1, Math.round((n * perAnswer) / 60000));
  const byDay = new Map(s.days.map((d) => [d.day, d]));
  const end = parseDay(s.today.day);
  const back = (n: number) => {
    const d = new Date(end);
    d.setDate(d.getDate() - n);
    return dayKey(d);
  };
  const weekMs = Array.from({ length: 7 }, (_, i) => byDay.get(back(i))?.ms ?? 0).reduce((a, b) => a + b, 0);
  const hours = s.hours;
  const hourTotal = hours.reduce((a, h) => a + h.reviews, 0);
  const LATE = [21, 22, 23, 0, 1];
  const lateShare = hourTotal ? LATE.reduce((a, h) => a + hours[h].reviews, 0) / hourTotal : 0;
  const busiest = hours.reduce((a, b) => (b.reviews > a.reviews ? b : a), hours[0]);
  const totalRated = hours.reduce((a, h) => a + h.rated, 0);
  const eligible = totalRated >= 40 ? hours.filter((h) => h.rated >= Math.max(10, totalRated * 0.05)) : [];
  const sharpest = eligible.length ? eligible.reduce((a, b) => (b.passed / b.rated > a.passed / a.rated ? b : a)) : null;
  const rows = s.decks ?? [];
  return { act, totalReviews, totalAnswers, totalMs, activeDays, target, minutes, byDay, back, weekMs, hourTotal, lateShare, LATE, busiest, sharpest, rows };
}
type D = ReturnType<typeof derive>;

// ------------------------------------------------------------------ the page

function Body({ stats: s, deck }: { stats: Stats; deck?: string }) {
  const d = useMemo(() => derive(s), [s]);
  const allCards = s.schedulers.reduce((a, x) => a + x.cards, 0);
  const kind = s.scheduler ? (s.schedulers.find((x) => x.id === s.scheduler)?.kind ?? (s.scheduler === "fsrs" ? "fsrs" : null)) : null;

  if (allCards === 0) return <EmptyState />;
  if (kind === "rated") return <RatedBody stats={s} d={d} deck={deck!} summary={s.schedulers[0]} />;
  if (s.scheduler && s.scheduler !== "fsrs") return <DrillBody stats={s} d={d} deck={deck!} />;
  return <FsrsBody stats={s} d={d} deck={deck} />;
}

function EmptyState() {
  return (
    <section className="stats-card grid items-center gap-[30px] px-8 py-[34px] max-md:px-5 max-md:py-6 @min-[860px]:grid-cols-[1fr_280px]">
      <div>
        <div className="text-xs font-bold tracking-[.13em] text-muted-foreground uppercase">Stats</div>
        <h2 className="stats-serif mt-2 mb-2.5 text-[30px] leading-[1.15] font-semibold">Nothing to measure yet.</h2>
        <p className="mb-[18px] max-w-[520px] text-[15px] leading-normal text-muted-foreground">Study a few days and this page starts answering three things: how much you'd remember right now, what's coming, and where you're weak.</p>
        <ul className="mb-[22px] flex flex-col gap-[9px] text-[14.5px]">
          {[
            [Library, "Add a deck from the Market or import from Anki"],
            [Play, "Study a little every day"],
            [Flame, "Come back after a week"],
          ].map(([Icon, t], i) => {
            const I = Icon as typeof Library;
            return (
              <li key={i} className="flex items-center gap-2.5">
                <i className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-[var(--stats-track)] text-muted-foreground"><I className="size-4" /></i>
                {t as string}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2.5">
          <Button className="h-11 gap-2 px-5 text-[15px]" onClick={() => navigate("/market")}><Store className="size-[18px]" />Browse the Market</Button>
          <Button variant="outline" className="h-11 px-5 text-[15px]" onClick={() => navigate("/")}>Go to decks</Button>
        </div>
      </div>
      <div aria-hidden className="opacity-50 grayscale max-md:hidden">
        <div className="stats-card p-4">
          <div className="mt-1.5 mb-3.5 h-2 w-[70%] rounded-full bg-muted-foreground/40" />
          <div className="flex h-[60px] items-end gap-[5px]">
            {[20, 34, 28, 50, 38, 60, 44].map((v, i) => <span key={i} className="flex-1 rounded bg-muted-foreground/30" style={{ height: v }} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function FsrsBody({ stats: s, d, deck }: { stats: Stats; d: D; deck?: string }) {
  const phone = useNarrow();
  const others = s.schedulers.filter((x) => x.kind !== "fsrs");
  const studied = s.cards.total - s.cards.new;
  const early = studied > 0 && d.activeDays < 4;
  const weak = weakDecks(s, d, deck);

  if (studied === 0 && s.cards.total > 0) {
    return (
      <Stack>
        <Section q="Nothing studied yet" a={<><b>{num(s.cards.total)}</b> new cards in {deck ? shortName(deck) : "your decks"}. Stats show up after your first reviews.</>}>
          <Button className="h-12 gap-2.5 px-6 text-base" onClick={() => navigate(studyUrl(deck))}><Play className="size-[15px] fill-current" />Learn the first {Math.min(10, s.cards.new)}</Button>
        </Section>
        {others.length > 0 && <Schedulers list={s.schedulers} />}
        {s.practice.slice(0, 4).map((p) => <PracticePanel key={p.cardId} card={p} />)}
      </Stack>
    );
  }

  const target = d.target;
  const recall = s.recall ?? 0;
  const under = Math.round((target - recall) * 100);
  const first = weak[0];
  const tr = s.trueRetention;
  return (
    <Stack>
      {/* Memory and today */}
      <section aria-label="How's your memory?" className="stats-card @container grid items-stretch gap-x-11 gap-y-6 px-[26px] py-6 max-md:!bg-transparent max-md:gap-3 max-md:p-0 max-md:!shadow-none @min-[860px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0 max-md:stats-card max-md:rounded-[18px] max-md:px-4 max-md:pt-[18px] max-md:pb-4">
          <Q aside={early ? <span className="text-xs font-semibold">early estimate</span> : undefined}>How's your memory?</Q>
          <A className="mb-1.5">
            You'd remember {early ? "about " : ""}<b>{early ? `${Math.round(recall * 20) * 5}%` : pct(recall)}</b> of your cards right now.{" "}
            {recall >= target - 0.005 ? `That's above your ${Math.round(target * 100)}% target.` : <>Your target is {Math.round(target * 100)}%, so you're <span className="text-[var(--learn)]">{plural(Math.max(1, under), "point")} under</span>.</>}
          </A>
          <Gauge value={recall} target={target} />
          <Foot>
            {early
              ? <>Based on {plural(studied, "card")} over {plural(d.activeDays, "day")}. It settles after about a week.</>
              : tr.reviewed
                ? <>That's Etude's prediction from your answers. In real reviews you got <b>{pct(tr.rate)}</b> right over the last 30 days ({num(tr.passed)} of {num(tr.reviewed)}).</>
                : <>That's Etude's prediction from your answers. Real review results show up here after a few reviews.</>}
          </Foot>
          {!early && first && (
            <MinimiLine
              text={<>Hm. <b>{shortName(first.deck)}</b> is the one dragging you down. {first.due ? <>{d.minutes(first.due) === 1 ? "One minute" : `${d.minutes(first.due)} minutes`} on its {plural(first.due, "due card")} fixes most of it.</> : "Do a few more of those."}</>}
              plain={<>Weakest right now: {shortName(first.deck)}, {pct(first.recall)}.</>}
            />
          )}
        </div>
        <TodayPanel stats={s} d={d} deck={deck} />
      </section>

      {deck && <Skills deck={deck} />}

      {/* Streak and heatmap */}
      <Section q="How are you studying?" a={habitSentence(s, d)}>
        <div className="mb-[22px] flex flex-wrap items-center gap-x-[26px] gap-y-3 max-md:mb-4 max-md:gap-x-4">
          <div className="flex items-center gap-2">
            <Flame className="size-10 fill-[var(--stats-streak)] text-[var(--stats-streak)] max-md:size-9" strokeWidth={1.5} />
            <b className="tabular text-[40px] leading-none font-extrabold tracking-[-.03em] text-[var(--stats-streak)] max-md:text-[34px]">{s.streak}</b>
            <span className="flex flex-col text-[12.5px] leading-tight font-semibold text-muted-foreground">
              <i className="text-sm font-bold text-[var(--stats-streak-ink)] not-italic">day streak</i>best {s.bestStreak}
            </span>
          </div>
          <WeekRow stats={s} d={d} />
        </div>
        {d.totalAnswers ? <Heatmap days={s.days} weeks={WEEKS} today={s.today.day} phone={phone} /> : <Empty>No reviews in the last {WEEKS} weeks. Each study day fills a square here.</Empty>}
      </Section>

      <ForecastSection stats={s} d={d} deck={deck} />

      {s.curve.length > 0 &&
        (early ? (
          <Section q="If you stopped today">
            <div className="relative mt-3">
              <div style={{ height: 150 }} />
              <div className="absolute inset-0 grid place-items-center rounded-[10px] bg-card/55 p-2.5 text-center text-[13.5px] font-medium text-muted-foreground">The forgetting curve needs about a week of reviews. It shows up around {fmtDay(d.back(-(7 - d.activeDays)))}.</div>
            </div>
          </Section>
        ) : (
          <Section q="If you stopped today" a={stopSentence(s, target)}>
            <ForgettingCurve curve={s.curve} target={target} height={210} />
          </Section>
        ))}

      <WeakSection stats={s} d={d} deck={deck} weak={weak} early={early} />

      {s.practice.length > 0 && s.practice.slice(0, 4).map((p) => <PracticePanel key={p.cardId} card={p} />)}

      {d.totalAnswers > 0 && (
        <Row2>
          <HoursSection stats={s} d={d} />
          <Section q="How much time?" a={d.totalMs - d.weekMs < 60000 ? <><b>{fmtDuration(d.weekMs)}</b> so far, all of it this week.</> : <><b>{fmtDuration(d.weekMs)}</b> this week, {fmtDuration(d.totalMs)} in the last {WEEKS} weeks.</>}>
            <DayBars stats={s} d={d} />
            <Foot>Minutes per day, last 30 days.</Foot>
          </Section>
        </Row2>
      )}

      <Row2>
        <LibrarySection stats={s} deck={deck} others={others} />
        <AnswersSection stats={s} d={d} />
      </Row2>

      {studied > 0 && <StrengthSection stats={s} deck={deck} />}

      {!deck && <DecksSection stats={s} d={d} />}
      {others.length > 0 && <Schedulers list={s.schedulers} />}
    </Stack>
  );
}

// ------------------------------------------------------------------ today

function TodayPanel({ stats: s, d, deck }: { stats: Stats; d: D; deck?: string }) {
  const due = s.forecast[0]?.due ?? 0;
  const done = s.today.reviews;
  const tot = done + due;
  const share = tot ? Math.round((100 * done) / tot) : 100;
  const drills = s.schedulers.filter((x) => x.kind === "drill").reduce((a, x) => a + x.due, 0);
  const left = d.minutes(due);
  const tomorrow = s.forecast[1]?.due ?? 0;
  const canLearn = s.cards.new > 0;
  return (
    <div aria-label="Today" className="flex min-w-0 flex-col justify-between gap-5 rounded-[14px] bg-[var(--stats-inset)] px-5 py-[18px] max-md:stats-card max-md:gap-4 max-md:rounded-[18px] max-md:!bg-card max-md:px-4 max-md:pt-[18px] max-md:pb-4 @min-[560px]:@max-[859px]:flex-row @min-[560px]:@max-[859px]:items-center @min-[560px]:@max-[859px]:gap-8">
      <div className="flex min-w-0 flex-col gap-3 @min-[560px]:@max-[859px]:flex-[1.25]">
        <Q>Today</Q>
        <Kv
          items={[
            { value: num(due), label: "due now" },
            { value: num(done), label: "done today" },
            { value: <>{Math.round(s.today.ms / 60000)}<small className="ml-0.5 font-sans text-sm font-medium text-muted-foreground">min</small></>, label: "studied" },
          ]}
        />
        <div className="mt-1 h-2 overflow-hidden rounded bg-[var(--stats-track)]" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100} aria-label={`${done} of ${tot} done today`}>
          <i className="stats-grow-x block h-full rounded-l bg-highlight" style={{ width: `${share}%` }} />
        </div>
        <p className="text-[13px] leading-[1.45] text-pretty text-muted-foreground">
          {s.overdue > 0 && <span className="text-[var(--again)]">{plural(s.overdue, "card")} overdue. </span>}
          {due ? <>{share >= 40 && share <= 60 ? "Halfway there. " : ""}{left === 1 ? "About a minute" : left < 60 ? `About ${left} minutes` : `About ${fmtDuration(left * 60000)}`} left at today's pace.</> : done ? "All done for today." : "Nothing waiting."}
          {drills > 0 && <> {plural(drills, "drill")} ready too.</>}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-3 @min-[560px]:@max-[859px]:flex-1">
        <Button className="h-12 w-full gap-2.5 text-base font-semibold" disabled={!due && !canLearn} onClick={() => navigate(studyUrl(deck))}>
          <Play className="size-[15px] fill-current" />
          {due ? `Review ${num(due)}` : canLearn ? "Learn new cards" : "Nothing due"}
        </Button>
        <div className="flex items-baseline justify-center gap-2 text-[13px] text-muted-foreground">
          <span className="font-semibold text-foreground">Tomorrow</span>
          {tomorrow ? <><b className="tabular text-sm font-semibold text-foreground">{num(tomorrow)}</b><span>cards · about {fmtDuration(d.minutes(tomorrow) * 60000)}</span></> : <span>nothing due</span>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ habits

function habitSentence(s: Stats, d: D): ReactNode {
  const at = d.hourTotal ? <> You study most around <b>{hourName(d.busiest.hour)}</b>.</> : null;
  if (s.streak) return <><b>{plural(s.streak, "day")}</b> in a row.{at}</>;
  if (s.bestStreak) return <>No streak right now. Your best was <b>{plural(s.bestStreak, "day")}</b>.</>;
  return <>No streak yet. Study today to start one.</>;
}

/** This week, Monday first: a check for each study day, today ringed. */
function WeekRow({ stats: s, d }: { stats: Stats; d: D }) {
  const todayIdx = (parseDay(s.today.day).getDay() + 6) % 7;
  return (
    <div className="flex gap-2.5 max-md:gap-1.5" aria-label="This week">
      {["M", "T", "W", "T", "F", "S", "S"].map((l, i) => {
        const k = i <= todayIdx ? d.back(todayIdx - i) : null;
        const e = k ? d.byDay.get(k) : undefined;
        const on = !!e && d.act(e) > 0;
        const today = i === todayIdx;
        return (
          <div key={i} className="flex flex-col items-center gap-1.5" title={k ? fmtDay(k) : undefined}>
            <span
              className={cn("grid size-[34px] place-items-center rounded-full max-md:size-[30px]", on ? "stats-pop bg-[var(--stats-streak)] text-white" : "bg-[var(--stats-track)] shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--muted-foreground)_25%,transparent)]")}
              style={{ ...(on ? { animationDelay: `${i * 50}ms` } : {}), ...(today ? { boxShadow: "0 0 0 3px var(--card), 0 0 0 5px var(--stats-streak)" } : {}) }}
            >
              {on && <Check className="size-4" strokeWidth={3.2} />}
            </span>
            <small className={cn("text-xs font-bold", today ? "text-[var(--stats-streak-ink)]" : on ? "text-foreground" : "text-muted-foreground/60")}>{l}</small>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ forecast

function ForecastSection({ stats: s, deck }: { stats: Stats; d?: D; deck?: string }) {
  const phone = useNarrow();
  const [range, setRange] = useState<14 | 30>(14);
  const f = s.forecast;
  const n = range === 14 ? (phone ? 8 : 14) : 30;
  const shown = f.slice(0, n);
  const total = f.reduce((a, x) => a + x.due, 0);
  const rest = f.slice(2, 8).reduce((a, x) => a + x.due, 0);
  const week = f.slice(1, 8);
  const bi = week.reduce((m, x, i) => (x.due > week[m].due ? i : m), 0) + 1;
  // The exam deadline falls on a forecast day: the marker sits at the matching fraction of that day.
  let mark: { at: number; label: string } | null = null;
  let after = false;
  if (s.deadline) {
    const dl = new Date(s.deadline);
    for (let i = 0; i < shown.length; i++) {
      const start = parseDay(shown[i].day), next = new Date(start);
      next.setDate(next.getDate() + 1);
      if (dl < start) break;
      if (dl < next) {
        mark = { at: i + (dl.getTime() - start.getTime()) / (next.getTime() - start.getTime()), label: "Exam" };
        break;
      }
    }
    after = !mark && dl > parseDay(f[0].day);
  }
  const narrow = phone || n > 14;
  const labels = shown.map((x, i) => {
    const day = parseDay(x.day);
    if (i === 0) return "Today";
    if (n > 14) return i % 7 === 0 ? day.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    if (narrow) return i % 2 === 0 ? day.toLocaleDateString("en-US", { weekday: "narrow" }) : "";
    return i === 1 ? "Tmrw" : day.toLocaleDateString("en-US", { weekday: "short" });
  });
  const bd = parseDay(f[bi]?.day ?? f[0].day);
  return (
    <Section
      q="What's coming?"
      aside={<Seg<14 | 30> label="Forecast range" value={range} onChange={setRange} options={[[14, phone ? "Week" : "2 weeks"], [30, "30 days"]]} />}
      a={total ? <><b>{num(f[1]?.due ?? 0)}</b> tomorrow and <b>{num(rest)}</b> more in the six days after.{bi > 1 && f[bi].due > 0 ? ` ${bd.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, is the busy one.` : ""}</> : <>Nothing is scheduled in the next 30 days.</>}
    >
      {total > 0 ? (
        <Bars
          label={`Cards due per day for the next ${n} days`}
          values={shown.map((x) => x.due)}
          labels={labels}
          height={phone ? 170 : 150}
          capFirst
          mark={mark}
          startLabels={n > 14}
          hot={(i) => i === 0}
          strong={(i) => i < 2}
          showValues={(i) => n <= 14 && (!phone || i < 2 || shown.length <= 8)}
          tip={(i) => [i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDay(shown[i].day), `${plural(shown[i].due, "card")} due${i === 0 && s.overdue ? ` (${s.overdue} overdue)` : ""}`]}
        />
      ) : (
        <Empty>New cards enter the forecast once you study them.</Empty>
      )}
      {(s.overdue > 0 || s.deadline || !deck) && total > 0 && (
        <Foot>
          {s.overdue > 0 && <>Today includes {plural(s.overdue, "overdue card")}. </>}
          {s.deadline && (
            <>
              Exam {new Date(s.deadline).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {new Date(s.deadline) < new Date() ? " (passed)" : after ? " (after this window)" : ""}, last reviews at least {s.deadlineMargin} h before.{" "}
            </>
          )}
          {!deck && !s.deadline && "Pick a deck to see its exam deadline here."}
        </Foot>
      )}
    </Section>
  );
}

function stopSentence(s: Stats, target: number): ReactNode {
  const at30 = s.curve.find((p) => p.days === 30)?.recall ?? s.curve[s.curve.length - 1].recall;
  const cross = crossing(s.curve, target);
  if (cross === 0) return <>You're already under your target. With no reviews you'd be at <b>{pct(at30)}</b> in a month.</>;
  if (cross == null) return <>Even with no reviews for {spanWord(s.curve[s.curve.length - 1].days)}, you'd stay above {Math.round(target * 100)}%.</>;
  return <>Stop now and you'd drop under {Math.round(target * 100)}% in <b>{spanWord(cross)}</b>, and to <b>{pct(at30)}</b> in a month.</>;
}

// ------------------------------------------------------------------ weak spots

/** The decks with their own studied cards, weakest first: the subdecks of the scope, or every deck. */
function weakDecks(s: Stats, d: D, deck?: string) {
  const rows = d.rows.filter((r) => r.seen >= 3 && r.recall != null && r.deck !== deck);
  // A scope with no subdecks has only itself: weak spots go by tag then.
  return rows.map((r) => rollUp(d.rows, r.deck)).filter((r) => r.recall != null).sort((a, b) => a.recall! - b.recall! || b.seen - a.seen);
}

function WeakSection({ stats: s, d, deck, weak, early }: { stats: Stats; d: D; deck?: string; weak: DeckRoll[]; early: boolean }) {
  const tagsSeen = s.tagTree.some((t) => t.seen > 0);
  const [view, setView] = useState<"decks" | "tags">(weak.length >= 2 || !tagsSeen ? "decks" : "tags");
  const [all, setAll] = useState(false);
  const target = d.target;
  if (early)
    return (
      <Section q="Where are you weak?" a="Too early to say.">
        <Foot className="mt-0">Weak spots need a few days of answers per deck. Check back around <b>{fmtDay(d.back(-(5 - d.activeDays)))}</b>.</Foot>
      </Section>
    );
  if (!weak.length && !tagsSeen) return null;
  const v = weak.length ? view : "tags";
  const switcher = weak.length && tagsSeen ? <Seg<"decks" | "tags"> label="Weak spots by" value={view} onChange={setView} options={[["decks", "Decks"], ["tags", "Tags"]]} /> : undefined;
  if (v === "tags") return <WeakTags stats={s} target={target} deck={deck} aside={switcher} />;
  const shown = all ? weak : weak.slice(0, 5);
  const w = weak[0];
  return (
    <Section q="Where are you weak?" aside={switcher} a={<><b>{shortName(w.deck)}</b> is your weakest, at {pct(w.recall)}.</>}>
      <div className="flex flex-col">
        {shown.map((r) => {
          const parent = r.deck.includes("::") ? shortName(r.deck.slice(0, r.deck.lastIndexOf("::"))) : null;
          return (
            <WeakRow
              key={r.deck}
              name={shortName(r.deck)}
              sub={deck ? `${num(r.seen)} studied · ${num(r.due)} due` : `${parent ? `${parent} · ` : ""}${num(r.due)} due`}
              recall={r.recall!}
              target={target}
              action={r.due ? `Review ${num(r.due)}` : "Practice"}
              onAction={() => navigate(studyUrl(r.deck, r.due ? "" : "&ahead=1"))}
              onOpen={() => navigate(`/stats?deck=${encodeURIComponent(r.deck)}`)}
            />
          );
        })}
      </div>
      {weak.length > 5 && (
        <button type="button" className="mt-2 h-10 rounded-[9px] px-3 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${weak.length}`}
        </button>
      )}
      <Foot>Bars run from 50% to 100%, like the one at the top. The little arrow marks your {Math.round(target * 100)}% target. The button opens a session with only that deck's cards.</Foot>
    </Section>
  );
}

function WeakRow({ name, sub, recall, target, action, onAction, onOpen, mono }: { name: ReactNode; sub: ReactNode; recall: number; target: number; action: string; onAction(): void; onOpen?(): void; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_44px_92px] items-center gap-x-3.5 gap-y-1.5 border-t px-1 py-3 first:border-t-0 first:pt-1 max-md:grid-cols-[minmax(0,1fr)_auto_auto] max-md:gap-2.5 max-md:px-0 max-md:py-3.5">
      <button type="button" onClick={onOpen} disabled={!onOpen} className="min-w-0 text-left enabled:hover:opacity-80">
        <b className={cn("block truncate text-[14.5px] font-semibold", mono && "font-mono text-[13px]")}>{name}</b>
        <small className="block truncate text-[12.5px] text-muted-foreground">{sub}</small>
      </button>
      <div className="max-md:col-span-3 max-md:row-start-2 max-md:mt-3">
        <TargetBar value={recall} target={target} />
      </div>
      <span className="tabular text-right text-[15px] font-semibold max-md:text-base" style={recall < target - 0.1 ? { color: "var(--learn)" } : undefined}>{pct(recall)}</span>
      <button type="button" onClick={onAction} className="h-[34px] rounded-[9px] px-3 text-[13px] font-semibold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent max-md:h-8 max-md:px-2.5 max-md:text-xs">
        {action}
      </button>
    </div>
  );
}

/** Weak spots by tag, with the tag groups as chips: a row opens those cards in Browse. */
function WeakTags({ stats: s, target, deck, aside }: { stats: Stats; target: number; deck?: string; aside?: ReactNode }) {
  const tree = s.tagTree;
  const roots = useMemo(() => tree.filter((t) => t.depth === 0 && tree.some((x) => x.tag.startsWith(t.tag + "::"))).sort((a, b) => b.cards - a.cards), [tree]);
  const [group, setGroup] = useState("__leaf");
  const [all, setAll] = useState(false);
  const inGroup = group === "__leaf" ? tree.filter((t) => t.direct) : tree.filter((t) => t.tag.startsWith(group + "::"));
  const seen = inGroup.filter((t) => t.seen > 0).sort((a, b) => a.recall! - b.recall! || b.seen - a.seen);
  const unseen = inGroup.filter((t) => t.seen === 0).length;
  const shown = all ? seen : seen.slice(0, 5);
  const scope = deck ? `deck:"${deck}" ` : "";
  return (
    <Section q="Where are you weak?" aside={aside} a={seen[0] ? <><b className="font-mono text-[0.85em]">{seen[0].tag.split("::").pop()}</b> is your weakest tag, at {pct(seen[0].recall)}.</> : "No studied tags yet."}>
      {roots.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tag group">
          {[["__leaf", "Every tag"], ...roots.map((r) => [r.tag, r.tag])].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={group === k} onClick={() => setGroup(k)} className={cn("h-9 rounded-full px-3.5 text-[13px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground", group === k && "bg-accent text-foreground")}>
              {l}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col">
        {shown.map((t) => {
          const label = group === "__leaf" ? t.tag : t.tag.slice(group.length + 2);
          return (
            <WeakRow
              key={t.tag}
              mono
              name={label}
              sub={t.seen === t.cards ? plural(t.cards, "card") : `${num(t.seen)} of ${plural(t.cards, "card")} studied`}
              recall={t.recall!}
              target={target}
              action="Browse"
              onAction={() => navigate(`/browse?q=${encodeURIComponent(`${scope}tag:${t.tag}`)}`)}
              onOpen={() => navigate(`/browse?q=${encodeURIComponent(`${scope}tag:${t.tag}`)}`)}
            />
          );
        })}
      </div>
      {!seen.length && <Empty>None of these tags has a studied card yet. Recall per tag appears after your first reviews.</Empty>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {seen.length > 5 && (
          <button type="button" className="h-10 rounded-[9px] px-3 text-[13px] font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${seen.length}`}
          </button>
        )}
        {unseen > 0 && <span>{plural(unseen, "tag")} not studied yet</span>}
      </div>
      <Foot>Bars run from 50% to 100%. The little arrow marks your {Math.round(target * 100)}% target.</Foot>
    </Section>
  );
}

// ------------------------------------------------------------------ quieter sections

function HoursSection({ stats: s, d, q = "When do you study?" }: { stats: Stats; d: D; q?: string }) {
  const late = d.lateShare > 0.5;
  const hot = (h: number) => (late ? d.LATE.includes(h) : h === d.busiest.hour);
  return (
    <Section q={q} a={late ? <>Late. <b>{Math.round(d.lateShare * 100)}%</b> of your answers come between 9&nbsp;pm and 2&nbsp;am.</> : <>Mostly around <b>{hourName(d.busiest.hour)}</b>.</>}>
      <Bars
        label="Answers by hour of day"
        values={s.hours.map((h) => h.reviews)}
        labels={s.hours.map((h) => (h.hour % 6 === 0 ? hourName(h.hour) : ""))}
        startLabels
        height={120}
        hot={hot}
        tip={(i) => {
          const h = s.hours[i];
          return [hourName(h.hour), h.reviews ? `${Math.round((h.reviews / d.hourTotal) * 100)}% of your answers${h.rated ? ` · ${Math.round((h.passed / h.rated) * 100)}% not Again` : ""}` : "nothing"];
        }}
      />
      <Foot>
        Share of your answers by hour, last {WEEKS} weeks. Green is your usual window.
        {d.sharpest && <> You're sharpest around <b>{hourName(d.sharpest.hour)}</b> ({Math.round((d.sharpest.passed / d.sharpest.rated) * 100)}% not Again).</>}
      </Foot>
    </Section>
  );
}

function DayBars({ stats: s, d }: { stats: Stats; d: D }) {
  const days = Array.from({ length: 30 }, (_, i) => d.back(29 - i));
  const ms = days.map((k) => d.byDay.get(k)?.ms ?? 0);
  return (
    <Bars
      label="Minutes studied per day, last 30 days"
      values={ms.map((v) => Math.round(v / 6000) / 10)}
      labels={days.map((k, i) => (i === 29 ? "today" : (29 - i) % 7 === 0 && i > 2 ? fmtDay(k, { month: "short", day: "numeric" }) : ""))}
      height={110}
      hot={(i) => i === 29}
      strong={(i) => i === 29}
      tip={(i) => [i === 29 ? "Today" : fmtDay(days[i]), ms[i] ? fmtDuration(ms[i]) : "no study"]}
    />
  );
}

function statesParts(x: { new: number; learning: number; young: number; mature: number }, browse?: (q: string) => void): Part[] {
  return [
    { key: "new", label: "New", value: x.new, color: "var(--new)", hint: "never studied", onPick: browse && (() => browse("is:new")) },
    { key: "learning", label: "Learning", value: x.learning, color: "var(--learn)", hint: "still in the first steps", onPick: browse && (() => browse("is:learning")) },
    { key: "young", label: "Young", value: x.young, color: "color-mix(in oklab, var(--highlight) 55%, var(--card))", hint: "held under 3 weeks", onPick: browse && (() => browse("is:review prop:stability<21")) },
    { key: "mature", label: "Mature", value: x.mature, color: "var(--highlight)", hint: "held 3 weeks or more", onPick: browse && (() => browse("is:review prop:stability>=21")) },
  ];
}

function LibrarySection({ stats: s, deck, others }: { stats: Stats; deck?: string; others: StatsScheduler[] }) {
  const scope = deck ? `deck:"${deck}" ` : "";
  const parts = statesParts({ new: s.cards.new, learning: s.cards.learning, young: s.cards.review - s.cards.mature, mature: s.cards.mature }, (q) => navigate(`/browse?q=${encodeURIComponent(scope + q)}`));
  const scripted = others.reduce((a, x) => a + x.cards, 0);
  return (
    <Section q="What's in your library?" a={<><b>{num(s.cards.new)}</b> of {num(s.cards.total)} cards are still new.</>}>
      <StackBar big parts={parts} label="Cards by state" />
      <Keys parts={parts} />
      <Foot>Pick a colour to browse those cards.{scripted > 0 && <> {plural(scripted, "more card")} follow other schedulers.</>}</Foot>
    </Section>
  );
}

function AnswersSection({ stats: s }: { stats: Stats; d?: D }) {
  const r = s.ratings, t = r.again + r.hard + r.good + r.easy;
  const parts: Part[] = [
    { key: "again", label: "Again", value: r.again, color: "var(--again)" },
    { key: "hard", label: "Hard", value: r.hard, color: "var(--hard)" },
    { key: "good", label: "Good", value: r.good, color: "var(--good)" },
    { key: "easy", label: "Easy", value: r.easy, color: "var(--easy)" },
  ];
  const top = parts.reduce((a, b) => (b.value > a.value ? b : a));
  const v = s.verdicts, vt = v.correct + v.partial + v.incorrect + v.ungraded;
  const vparts: Part[] = [
    { key: "correct", label: "Correct", value: v.correct, color: "var(--good)" },
    { key: "partial", label: "Partial", value: v.partial, color: "var(--hard)" },
    { key: "incorrect", label: "Incorrect", value: v.incorrect, color: "var(--again)" },
    { key: "ungraded", label: "Ungraded", value: v.ungraded, color: "var(--muted-foreground)" },
  ];
  return (
    <Section q="How do you answer?" a={t ? <>You press <b>{top.label}</b> {Math.round((top.value / t) * 100)}% of the time.</> : "No ratings yet."}>
      {t > 0 ? (
        <>
          <StackBar big parts={parts} label="Ratings" />
          <Keys parts={parts} show="share" />
          <Foot>Your buttons after each answer, last {WEEKS} weeks. Hard counts as remembered.</Foot>
        </>
      ) : (
        <Empty>Ratings appear after your first reviews.</Empty>
      )}
      {vt > 0 && (
        <div className="mt-5">
          <div className="mb-2.5 text-[13px] font-semibold">Graded answers</div>
          <StackBar parts={vparts} label="Grading verdicts" />
          <Keys parts={vparts} show="share" />
        </div>
      )}
    </Section>
  );
}

function StrengthSection({ stats: s, deck }: { stats: Stats; deck?: string }) {
  const scope = deck ? `deck:"${deck}" ` : "";
  const names = ["<1 d", "1–3 d", "3–7 d", "1–3 wk", "3–8 wk", "2–6 mo", "6 mo+"];
  return (
    <Section q="How long will they last?" a={<><b>{num(s.cards.mature)}</b> {s.cards.mature === 1 ? "card stays" : "cards stay"} above {Math.round((s.desiredRetention ?? 0.9) * 100)}% for three weeks or more.</>}>
      <Histogram
        label="Studied cards by stability"
        height={110}
        bars={s.stability.map((b, i) => ({ key: names[i] ?? String(i), value: b.cards, label: names[i], color: "var(--highlight)", tip: `${plural(b.cards, "card")} · stays above target for ${names[i]}` }))}
        onPick={(i) => {
          const lo = i ? s.stability[i - 1].upTo! : 0, hi = s.stability[i].upTo;
          navigate(`/browse?q=${encodeURIComponent(`${scope}-is:new prop:stability>=${lo}${hi == null ? "" : ` prop:stability<${hi}`}`)}`);
        }}
      />
    </Section>
  );
}

function DecksSection({ stats: s, d }: { stats: Stats; d: D }) {
  const tops = [...new Set(d.rows.map((r) => r.deck.split("::")[0]))];
  if (tops.length < 2) return null;
  const rolls = tops.map((t) => rollUp(d.rows, t));
  const schedOf = (deck: string) => s.schedulers.find((x) => x.kind !== "fsrs" && x.decks.some((n) => n === deck || n.startsWith(deck + "::")));
  const ranked = rolls.filter((r) => r.recall != null && r.cards > 0).sort((a, b) => a.recall! - b.recall!);
  return (
    <Section q="How is each deck?" a={ranked[0] ? <><b>{shortName(ranked[0].deck)}</b> needs the most attention, at {pct(ranked[0].recall)}.</> : "None of your decks has studied cards yet."}>
      <div className="flex flex-col">
        {rolls.map((r) => {
          const script = r.cards === 0 && r.scripted > 0 ? schedOf(r.deck) : undefined;
          return (
            <button key={r.deck} type="button" onClick={() => navigate(`/stats?deck=${encodeURIComponent(r.deck)}`)} className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_54px] items-center gap-3 border-t py-[9px] text-left first:border-t-0 first:pt-0 hover:opacity-80 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-2.5 max-md:gap-y-2 max-md:py-3">
              <span className="truncate text-[13.5px] font-medium max-md:text-[14.5px]">{shortName(r.deck)}</span>
              <span className="min-w-0 max-md:col-span-2 max-md:row-start-2">
                {script ? <span className="text-[12.5px] text-muted-foreground">{script.kind === "drill" ? "always ready · no memory model" : `${script.name} · no recall model`}</span> : <StackBar parts={statesParts(r)} label={`${r.deck} by state`} />}
              </span>
              <span className={cn("tabular text-right text-sm font-semibold max-md:text-[15px]", r.recall != null && r.recall < 0.85 && "text-[var(--learn)]")}>{script ? (script.kind === "drill" ? "drill" : "rated") : r.recall == null ? "new" : pct(r.recall)}</span>
            </button>
          );
        })}
      </div>
      <Foot>Bars are cards by state, the number is memory now. Pick a deck to see its own stats.</Foot>
    </Section>
  );
}

/** Cards on schedulers other than FSRS, one row each: they have no memory model, so they're counted apart. */
function Schedulers({ list }: { list: StatsScheduler[] }) {
  const max = Math.max(1, ...list.map((x) => x.cards));
  const word = { fsrs: "Memory model", rated: "Rated, no recall model", drill: "Measured, always ready" } as const;
  return (
    <Section q="What schedules your cards?" a={<>{list.length === 1 ? "One scheduler" : `${list.length} schedulers`}. Recall, the curve and weak spots count FSRS cards only.</>}>
      <div className="flex flex-col">
        {list.map((x) => {
          const go = () => (x.decks.length === 1 ? navigate(`/stats?deck=${encodeURIComponent(x.decks[0])}`) : undefined);
          const status = x.kind === "drill" ? (x.due ? `${x.due} ready` : "none ready") : `${x.due} due`;
          const extra = x.kind === "drill" ? (x.answers ? plural(x.answers, "run") : "") : x.passRate != null ? `${pct(x.passRate)} pass` : "";
          return (
            <button key={x.id} type="button" onClick={go} disabled={x.decks.length !== 1} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t py-3 text-left first:border-t-0 first:pt-0 enabled:hover:opacity-80 @min-[560px]:grid-cols-[13rem_minmax(0,1fr)_auto]">
              <div className="col-span-2 min-w-0 @min-[560px]:col-span-1">
                <div className="truncate text-sm font-semibold">{x.name}</div>
                <div className="truncate text-[12px] text-muted-foreground" title={x.decks.join(", ")}>{word[x.kind]} · {x.decks.length === 1 ? shortName(x.decks[0]) : `${x.decks.length} decks`}</div>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--stats-track)]">
                <div className="h-full rounded-full" style={{ width: `${Math.max(2, (x.cards / max) * 100)}%`, background: x.kind === "fsrs" ? "var(--highlight)" : "var(--stats-ink-bar)" }} />
              </div>
              <div className="tabular grid grid-cols-[4.5rem_4rem_4.5rem] items-baseline text-right text-xs whitespace-nowrap text-muted-foreground">
                <span><span className="text-sm text-foreground">{num(x.cards)}</span> card{x.cards === 1 ? "" : "s"}</span>
                <span>{status}</span>
                <span>{extra}</span>
              </div>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

/** Adaptive decks: what the deck estimates about each skill. Computed from the graded history. */
function Skills({ deck }: { deck: string }) {
  const [summary, setSummary] = useState<LearnerSummary | null>(null);
  useEffect(() => {
    setSummary(null);
    api.skills(deck).then(setSummary, () => setSummary(null));
  }, [deck]);
  if (!summary?.adaptive) return null;
  const p = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  return (
    <Section q="What does the deck think you know?" a={summary.pace ? <><b>{summary.pace.value}</b> new cards today. {summary.pace.reason}</> : <>It aims for {p(summary.settings.targetSuccess)} right answers.</>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Skill</th>
              <th className="pb-2 font-medium">Answers</th>
              <th className="pb-2 font-medium" title="Share of the last 50 graded answers that were right">Recently right</th>
              <th className="pb-2 font-medium" title="Predicted chance of getting a card of middling difficulty right">Typical card</th>
              {summary.settings.levels.length > 0 && <th className="pb-2 font-medium">Level</th>}
              <th className="pb-2 font-medium">Placement</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {summary.skills.map((x) => (
              <tr key={x.skill} className="border-t">
                <td className="py-2 font-medium">{x.skill}</td>
                <td className="py-2">{x.answers}</td>
                <td className="py-2">{p(x.success)}</td>
                <td className="py-2">{p(x.typical)}</td>
                {summary.settings.levels.length > 0 && <td className="py-2">{x.level ? `${x.level.tag.split("::").pop()} · ${p(x.level.progress)} stable${x.level.nextOpen ? " · next level open" : ""}${x.level.done ? " · all done" : ""}` : "–"}</td>}
                <td className="py-2 text-muted-foreground" title={x.placement?.checks.done ? `${x.placement.checks.passed} of ${x.placement.checks.done} quick checks right` : undefined}>
                  {x.placement ? `${x.placement.frontier}${x.placement.revised ? " (lowered by quick checks)" : ""}${x.placement.done ? "" : " (in progress)"}` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ measured cards (drills)

/** One measured card: pick a metric, see every run, the average of the last five and the best. */
function PracticePanel({ card, q }: { card: PracticeCard; q?: string }) {
  const [key, setKey] = useState(card.metrics[0]?.key);
  const m = card.metrics.find((x) => x.key === key) ?? card.metrics[0];
  if (!m || !m.points.length) return null;
  const p = m.points.map((x) => x.value);
  const fmt = (v: number) => `${v.toFixed(m.digits)}${m.unit === "%" ? "%" : m.unit ? ` ${m.unit}` : ""}`;
  const av = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const k = Math.min(5, Math.max(1, Math.floor(p.length / 2)));
  const a0 = av(p.slice(0, k)), a1 = av(p.slice(-k));
  const diff = Number((a1 - a0).toFixed(m.digits));
  const up = m.better === "lower" ? diff < 0 : diff > 0;
  const best = m.better === "lower" ? Math.min(...p) : Math.max(...p);
  return (
    <Section
      q={q ?? shortName(card.deck)}
      label={q ?? `${shortName(card.deck)}: ${card.title}`}
      aside={<span className="text-xs text-muted-foreground">{plural(card.sessions, "run")}</span>}
      a={p.length > 1 ? <>{!q && <><b>{card.title.replace(/[.:]\s*$/, "")}.</b> </>}Your average went from <b>{fmt(a0)}</b> to <b>{fmt(a1)}</b> over {plural(p.length, "run")}.</> : <>One run so far: <b>{fmt(p[0])}</b>.</>}
    >
      {card.metrics.length > 1 && (
        <div className="mb-4">
          <Seg<string> label="Metric" value={m.key} onChange={setKey} options={card.metrics.map((x) => [x.key, x.label])} />
        </div>
      )}
      <div className="mb-[18px] grid grid-cols-3 gap-3">
        {[
          ["Last run", fmt(p[p.length - 1]), ""],
          ["Best", fmt(best), "text-good"],
          [`Last ${k} vs first ${k}`, p.length > 1 ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff).toFixed(m.digits)}` : "—", up ? "text-good" : ""],
        ].map(([l, v, c]) => (
          <div key={l} className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate text-[12.5px] font-medium text-muted-foreground">{l}</span>
            <b className={cn("stats-serif tabular text-[32px] leading-none font-semibold max-md:text-[26px]", c)}>{v}</b>
          </div>
        ))}
      </div>
      <ProgressChart points={m.points} better={m.better} unit={m.unit} digits={m.digits} height={220} />
      <Foot>Each dot is a run, the line is your average of the last five. {card.scheduler !== "fsrs" ? "A drill is always ready and doesn't predict memory, so there's no forgetting curve here." : ""}</Foot>
    </Section>
  );
}

function DrillBody({ stats: s, d, deck }: { stats: Stats; d: D; deck: string }) {
  const phone = useNarrow();
  const runs = s.days.reduce((a, x) => a + (x.runs ?? 0) + x.reviews, 0);
  const first = s.days.find((x) => d.act(x) > 0)?.day;
  return (
    <Stack>
      {s.practice.length ? (
        s.practice.map((p, i) => <PracticePanel key={p.cardId} card={p} q={s.practice.length === 1 && i === 0 ? "How are you doing?" : undefined} />)
      ) : (
        <Section q="How are you doing?" a="Every run you do here is measured.">
          <Button className="h-12 gap-2.5 px-6 text-base" onClick={() => navigate(studyUrl(deck))}><Play className="size-[15px] fill-current" />Practice once</Button>
        </Section>
      )}
      {runs > 0 && (
        <Row2>
          <HoursSection stats={s} d={d} q="When do you play?" />
          <Section q="How much?">
            <Kv
              className="mt-1.5 mb-2.5"
              items={[
                { value: num(runs), label: first ? `runs since ${fmtDay(first, { month: "short", day: "numeric" })}` : "runs" },
                { value: fmtDuration(d.totalMs / runs).replace(" min", "") + (d.totalMs / runs >= 60000 ? " min" : ""), label: "per run" },
                { value: fmtDuration(d.totalMs), label: "in total" },
              ]}
            />
            <Foot>Counted over the last {WEEKS} weeks.</Foot>
          </Section>
        </Row2>
      )}
      <Section q="Which days?" a={habitSentence(s, d)}>
        {d.totalAnswers ? <Heatmap days={s.days} weeks={WEEKS} today={s.today.day} phone={phone} /> : <Empty>Each practice day fills a square here.</Empty>}
      </Section>
    </Stack>
  );
}

// ------------------------------------------------------------------ rated script schedulers (Leitner)

function RatedBody({ stats: s, d, deck, summary }: { stats: Stats; d: D; deck: string; summary: StatsScheduler }) {
  const phone = useNarrow();
  const due = s.forecast[0]?.due ?? 0;
  const g = summary.groups;
  const groupTotal = g ? g.bins.reduce((a, b) => a + b.cards, 0) + g.other : 0;
  return (
    <Stack>
      <section aria-label="How's it going?" className="stats-card @container grid items-stretch gap-x-11 gap-y-6 px-[26px] py-6 max-md:px-4 @min-[860px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Q>How's it going?</Q>
          <A>{summary.rated ? <>You passed <b>{pct(summary.passRate)}</b> of your answers in the last {WEEKS} weeks.</> : "No answers yet."}</A>
          {summary.passRate != null && <Gauge value={summary.passRate} target={d.target} />}
          <Foot>Scheduled by {summary.name}. It decides when cards come back without predicting recall, so there's no forgetting curve here.</Foot>
        </div>
        <div className="flex min-w-0 flex-col justify-between gap-5 rounded-[14px] bg-[var(--stats-inset)] px-5 py-[18px]">
          <div className="flex flex-col gap-3">
            <Q>Today</Q>
            <Kv items={[{ value: num(due), label: "due now" }, { value: num(summary.cards), label: "cards" }, { value: num(summary.new), label: "not seen yet" }]} />
            {s.overdue > 0 && <p className="text-[13px] text-[var(--again)]">{plural(s.overdue, "card")} overdue.</p>}
          </div>
          <Button className="h-12 w-full gap-2.5 text-base font-semibold" disabled={!due && !summary.new} onClick={() => navigate(studyUrl(deck))}>
            <Play className="size-[15px] fill-current" />{due ? `Practice ${num(due)}` : "Practice"}
          </Button>
        </div>
      </section>

      <Section q="How are you studying?" a={habitSentence(s, d)}>
        {d.totalAnswers ? <Heatmap days={s.days} weeks={WEEKS} today={s.today.day} phone={phone} /> : <Empty>Each practice day fills a square here.</Empty>}
      </Section>

      {g && (
        <Section q={`Cards by ${g.label.toLowerCase()}`} a={groupTotal ? <><b>{num(groupTotal)}</b> cards seen so far.</> : undefined}>
          {groupTotal ? (
            <>
              <Histogram label={`Seen cards by ${g.label}`} height={120} bars={g.bins.map((b) => ({ key: b.key, value: b.cards, label: b.key, color: "var(--highlight)", tip: `${g.label} ${b.key}: ${plural(b.cards, "card")}` }))} />
              {g.other > 0 && <Foot>{plural(g.other, "card")} without a {g.label.toLowerCase()} yet.</Foot>}
            </>
          ) : (
            <Empty>Answer a few cards and they spread across the {g.label.toLowerCase()}es.</Empty>
          )}
        </Section>
      )}

      <ForecastSection stats={s} d={d} deck={deck} />

      {d.totalAnswers > 0 && (
        <Row2>
          <AnswersSection stats={s} d={d} />
          <HoursSection stats={s} d={d} q="When do you practice?" />
        </Row2>
      )}
    </Stack>
  );
}
