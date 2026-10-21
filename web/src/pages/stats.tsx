import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Heatmap, RecallMeter, ShareBar, fmtDay, fmtDuration, parseDay } from "@/components/stats-charts";
import { api, type DeckNode, type Stats } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/** The engine window: ratings, verdicts and the heatmap cover this many weeks. */
const WEEKS = 26;
const pct = (v: number | null, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);

export function StatsPage({ deck }: { deck?: string }) {
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

  const scope = (v: string) => navigate(v === "__all" ? "/stats" : `/stats?deck=${encodeURIComponent(v)}`, { replace: true });

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-10">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">{deck ? deck.replace(/::/g, " › ") : "All decks"}</p>
        </div>
        <Select value={deck ?? "__all"} onValueChange={scope}>
          <SelectTrigger className="h-10 w-full sm:w-72" aria-label="Scope"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value="__all">All decks</SelectItem>
            {decks.length > 0 && <SelectSeparator />}
            {decks.map((d) => (
              <SelectItem key={d.id} value={d.name}>
                <span style={{ paddingLeft: d.depth * 12 }}>{d.name.split("::").pop()}</span>
              </SelectItem>
            ))}
            {deck && !decks.some((d) => d.name === deck) && <SelectItem value={deck}>{deck}</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      {error && !stats && <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">{error}</div>}
      {!stats && !error && <Loading />}
      {stats && <Body stats={stats} deck={deck} />}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/50" />)}</div>
      <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
      <div className="h-56 animate-pulse rounded-xl bg-muted/40" />
    </div>
  );
}

function Body({ stats, deck }: { stats: Stats; deck?: string }) {
  const s = stats;
  const totalReviews = s.days.reduce((a, d) => a + d.reviews, 0);
  const totalMs = s.days.reduce((a, d) => a + d.ms, 0);

  if (s.cards.total === 0)
    return (
      <div className="rounded-xl border border-dashed px-6 py-14 text-center">
        <p className="font-medium">No cards here yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Import a pack or add cards, then study for a few days. Retention, the forecast and your weakest tags show up here.</p>
        <Button variant="outline" className="mt-5 h-10" onClick={() => navigate("/")}>Go to decks</Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Headline numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Reviews today" value={String(s.today.reviews)} sub={s.today.reviews ? `${s.today.new} new · ${pct(s.today.again / s.today.reviews)} again${s.today.ms ? ` · ${fmtDuration(s.today.ms)}` : ""}` : s.streak ? `${s.streak}-day streak` : "None yet"} />
        <Tile
          label="True retention"
          value={pct(s.trueRetention.rate, 1)}
          sub={s.trueRetention.reviewed ? `${s.trueRetention.passed}/${s.trueRetention.reviewed} passed · 30 days` : "No review-card answers in 30 days"}
          tone={tone(s.trueRetention.rate)}
        />
        <Tile label="Recall now" value={pct(s.recall, 1)} tone={tone(s.recall)} sub={s.recall == null ? "No studied cards yet" : `Predicted, mean of ${s.cards.total - s.cards.new} studied card${s.cards.total - s.cards.new === 1 ? "" : "s"}`} />
        <Tile label="Streak" value={`${s.streak} day${s.streak === 1 ? "" : "s"}`} sub={totalReviews ? `${totalReviews} reviews in ${WEEKS} weeks` : "Study today to start one"} />
      </section>

      <Panel title="Cards" aside={<span className="tabular">{s.cards.total} total</span>}>
        <CardStates cards={s.cards} deck={deck} />
      </Panel>

      <Panel title="Review activity" aside={totalReviews ? "Reviews per day" : undefined}>
        {totalReviews ? (
          <Heatmap days={s.days} weeks={WEEKS} today={s.today.day} />
        ) : (
          <Empty>No reviews in the last {WEEKS} weeks. Each study day fills a square here.</Empty>
        )}
        {totalMs > 0 && <TimeSpent days={s.days} today={s.today.day} />}
      </Panel>

      <Panel title="Forecast" aside="Next 30 days">
        <Forecast stats={s} deck={deck} />
      </Panel>

      <Panel title="Weakest tags" aside="Predicted recall now · studied cards per tag">
        <WeakTags tree={s.tagTree} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Ratings" aside={`Last ${WEEKS} weeks`}>
          {totalReviews ? (
            <ShareBar
              label="Ratings"
              parts={[
                { key: "again", label: "Again", value: s.ratings.again, color: "var(--again)" },
                { key: "hard", label: "Hard", value: s.ratings.hard, color: "var(--hard)" },
                { key: "good", label: "Good", value: s.ratings.good, color: "var(--good)" },
                { key: "easy", label: "Easy", value: s.ratings.easy, color: "var(--easy)" },
              ]}
            />
          ) : (
            <Empty>Ratings appear after your first reviews.</Empty>
          )}
        </Panel>
        <Panel title="Graded answers" aside={`Last ${WEEKS} weeks`}>
          {s.verdicts.correct + s.verdicts.partial + s.verdicts.incorrect + s.verdicts.ungraded ? (
            <ShareBar
              label="Grading verdicts"
              parts={[
                { key: "correct", label: "Correct", value: s.verdicts.correct, color: "var(--good)" },
                { key: "partial", label: "Partial", value: s.verdicts.partial, color: "var(--hard)" },
                { key: "incorrect", label: "Incorrect", value: s.verdicts.incorrect, color: "var(--again)" },
                { key: "ungraded", label: "Ungraded", value: s.verdicts.ungraded, color: "var(--muted-foreground)" },
              ]}
            />
          ) : (
            <Empty>Verdicts from script and AI grading appear once you answer cards.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card/40 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 className="shrink-0 text-sm font-medium">{title}</h2>
        {aside && <div className="min-w-0 text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

const TONE = { good: "text-good", hard: "text-hard", again: "text-again" } as const;
const tone = (v: number | null): keyof typeof TONE | undefined => (v == null ? undefined : v >= 0.85 ? "good" : v >= 0.7 ? "hard" : "again");

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: keyof typeof TONE }) {
  return (
    <div className="rounded-xl border bg-card/40 px-4 py-3.5">
      <div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
      <div className={cn("tabular mt-1 text-2xl font-semibold tracking-tight", tone ? TONE[tone] : value === "—" && "text-muted-foreground/50")}>{value}</div>
      <div className="mt-0.5 text-xs leading-snug text-pretty text-muted-foreground">{sub}</div>
    </div>
  );
}

function CardStates({ cards, deck }: { cards: Stats["cards"]; deck?: string }) {
  const young = cards.review - cards.mature;
  const scope = deck ? `deck:"${deck}" ` : "";
  const parts = [
    { key: "new", label: "New", value: cards.new, color: "var(--new)", q: "is:new" },
    { key: "learning", label: "Learning", value: cards.learning, color: "var(--learn)", q: "is:learning" },
    { key: "young", label: "Young", value: young, color: "var(--chart-3)", q: "is:review prop:stability<21" },
    { key: "mature", label: "Mature", value: cards.mature, color: "var(--review)", q: "is:review prop:stability>=21" },
  ];
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {parts.map((p) => p.value > 0 && <div key={p.key} className="h-full" style={{ width: `${(p.value / cards.total) * 100}%`, background: p.color }} />)}
      </div>
      <div className="-mx-2 mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {parts.map((p) => (
          <button
            key={p.key}
            onClick={() => navigate(`/browse?q=${encodeURIComponent(scope + p.q)}`)}
            className="flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/50"
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="tabular font-medium">{p.value}</span>
            <span className="text-muted-foreground">{p.label}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Young review cards have a stability under 21 days; mature ones 21 days or more.</p>
    </div>
  );
}

function TimeSpent({ days, today }: { days: Stats["days"]; today: string }) {
  const series = useMemo(() => {
    const by = new Map(days.map((d) => [d.day, d]));
    const end = parseDay(today);
    const out: { key: string; value: number; label: string; reviews: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const e = by.get(k);
      out.push({ key: k, value: Math.round(((e?.ms ?? 0) / 60000) * 10) / 10, label: i === 0 ? "today" : fmtDay(k, { month: "short", day: "numeric" }), reviews: e?.reviews ?? 0 });
    }
    return out;
  }, [days, today]);
  const total = series.reduce((a, d) => a + d.value, 0);
  if (!total) return null;
  return (
    <div className="mt-6 border-t pt-5">
      <div className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Time studying</span>
        <span className="tabular">{fmtDuration(total * 60000)} in 30 days</span>
      </div>
      <BarChart
        data={series}
        height={120}
        color="var(--chart-2)"
        highlight={series.length - 1}
        ticks={[1, 8, 15, 22, 29]}
        format={(v) => `${v}m`}
        label={`Minutes studied per day, last 30 days: ${Math.round(total)} minutes total`}
        valueLabel={(v, i) => [fmtDay(series[i].key), `${fmtDuration(v * 60000)} · ${series[i].reviews} review${series[i].reviews === 1 ? "" : "s"}`]}
      />
    </div>
  );
}

function Forecast({ stats, deck }: { stats: Stats; deck?: string }) {
  const f = stats.forecast;
  const total = f.reduce((a, d) => a + d.due, 0);
  const data = f.map((d, i) => ({ key: d.day, value: d.due, label: i === 0 ? "today" : fmtDay(d.day, { month: "short", day: "numeric" }) }));
  // The deadline falls on a forecast day: place the marker at the matching fraction of that day.
  let mark: { at: number; label: string } | null = null;
  let after = false;
  if (stats.deadline) {
    const dl = new Date(stats.deadline);
    const first = parseDay(f[0].day);
    for (let i = 0; i < f.length; i++) {
      const start = parseDay(f[i].day);
      if (dl < start) break;
      const next = new Date(start);
      next.setDate(next.getDate() + 1);
      if (dl < next) {
        mark = { at: i + (dl.getTime() - start.getTime()) / (next.getTime() - start.getTime()), label: "Exam" };
        break;
      }
    }
    after = !mark && dl > first;
  }
  const busiest = f.reduce((m, d, i) => (d.due > f[m].due ? i : m), 0);
  // With an exam inside the window nothing is due after it, so the chart stops a few days past it.
  let last = -1;
  f.forEach((d, i) => d.due > 0 && (last = i));
  const span = mark ? Math.min(f.length, Math.max(10, Math.ceil(mark.at) + 4, last + 2)) : f.length;
  const shown = data.slice(0, span);
  const ticks = span <= 14 ? Array.from({ length: span }, (_, i) => i).filter((i) => i === 0 || i % 2 === 0) : [0, 7, 14, 21, 28];
  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-3 text-sm md:grid-cols-4">
        <Mini label="Due today" value={f[0].due} sub={stats.overdue ? `${stats.overdue} overdue` : undefined} />
        <Mini label="Next 7 days" value={f.slice(0, 7).reduce((a, d) => a + d.due, 0)} />
        <Mini label="Next 30 days" value={total} />
      </div>
      {total ? (
        <BarChart
          data={shown}
          height={170}
          color="var(--review)"
          highlight={0}
          ticks={ticks}
          mark={mark}
          label={`Cards due per day for the next 30 days: ${total} total, busiest ${fmtDay(f[busiest].day)} with ${f[busiest].due}${mark ? `; exam on ${fmtDay(f[Math.floor(mark.at)].day)}` : ""}`}
          valueLabel={(v, i) => [i === 0 ? `Today · ${fmtDay(f[i].day)}` : fmtDay(f[i].day), `${v} card${v === 1 ? "" : "s"} due${i === 0 && stats.overdue ? ` (${stats.overdue} overdue)` : ""}`]}
        />
      ) : (
        <Empty>Nothing is scheduled in the next 30 days. New cards enter the forecast once you study them.</Empty>
      )}
      {total > 0 && (stats.overdue > 0 || span < f.length) && (
        <p className="mt-3 text-xs text-muted-foreground">
          {stats.overdue > 0 && <><span className="mr-1.5 inline-block size-2 rounded-full bg-highlight" />Today includes {stats.overdue} overdue card{stats.overdue === 1 ? "" : "s"}. </>}
          {span < f.length && `Showing ${span} days; nothing else is due in the next 30.`}
        </p>
      )}
      {stats.deadline && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-balance text-muted-foreground">
          <CalendarClock className="mt-px size-3.5 shrink-0 text-highlight" />
          Exam {new Date(stats.deadline).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {new Date(stats.deadline) < new Date() ? " (passed)" : after ? " (after this window)" : ""} · last reviews at least {stats.deadlineMargin}h before
        </p>
      )}
      {!deck && <p className="mt-3 text-xs text-muted-foreground">Pick a deck to see its exam deadline on the forecast.</p>}
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div>
      <div className="tabular text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {sub && <div className="text-xs text-again">{sub}</div>}
    </div>
  );
}

function WeakTags({ tree }: { tree: Stats["tagTree"] }) {
  const roots = useMemo(() => tree.filter((t) => t.depth === 0).sort((a, b) => b.cards - a.cards), [tree]);
  const [group, setGroup] = useState<string>("__leaf");
  const [all, setAll] = useState(false);

  if (!tree.length) return <Empty>No tags in this scope. Tag items (for example exam::core) to see which topics are weakest.</Empty>;

  const inGroup = group === "__leaf" ? tree.filter((t) => t.direct) : tree.filter((t) => t.tag.startsWith(group + "::"));
  const seen = inGroup.filter((t) => t.seen > 0).sort((a, b) => a.recall! - b.recall! || b.seen - a.seen);
  const unseen = inGroup.filter((t) => t.seen === 0);
  const shown = all ? seen : seen.slice(0, 10);
  const head = group === "__leaf" ? null : tree.find((t) => t.tag === group);

  return (
    <div>
      <div className="-mx-1 mb-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tag group">
        <Chip active={group === "__leaf"} onClick={() => setGroup("__leaf")}>Every tag</Chip>
        {roots.filter((r) => tree.some((t) => t.tag.startsWith(r.tag + "::"))).map((r) => (
          <Chip key={r.tag} active={group === r.tag} onClick={() => setGroup(r.tag)}>{r.tag}</Chip>
        ))}
      </div>
      {head && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
          <span className="font-mono text-[13px]">{head.tag}</span>
          <span className="text-xs text-muted-foreground">all {head.cards} cards · {head.seen} studied</span>
          <span className="tabular ml-auto font-medium">{pct(head.recall)}</span>
        </div>
      )}
      {seen.length === 0 ? (
        <Empty>None of these tags has a studied card yet. Recall per tag appears after your first reviews.</Empty>
      ) : (
        <ul className="-mx-2">
          {shown.map((t) => {
            const label = group === "__leaf" ? t.tag : t.tag.slice(group.length + 2);
            const cut = label.lastIndexOf("::");
            return (
              <li key={t.tag}>
                <button
                  onClick={() => navigate(`/browse?q=${encodeURIComponent(`tag:${t.tag}`)}`)}
                  className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-2 text-left hover:bg-accent/40 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_3.5rem_1rem]"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 truncate font-mono text-[13px]">
                      {cut > 0 && <span className="text-muted-foreground">{label.slice(0, cut + 2)}</span>}
                      {label.slice(cut > 0 ? cut + 2 : 0)}
                    </span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">{t.seen === t.cards ? t.cards : `${t.seen}/${t.cards}`}</span>
                  </span>
                  <span className="tabular text-right text-sm font-medium sm:order-3">{pct(t.recall)}</span>
                  <span className="col-span-2 sm:order-2 sm:col-span-1"><RecallMeter value={t.recall} /></span>
                  <ChevronRight className="hidden size-4 text-muted-foreground sm:order-4 sm:block" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {seen.length > 10 && (
          <button className="h-10 rounded-md border px-3 text-foreground hover:bg-accent/50" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${seen.length}`}</button>
        )}
        {unseen.length > 0 && <span>{unseen.length} tag{unseen.length === 1 ? "" : "s"} not studied yet</span>}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn("h-10 rounded-full border px-4 text-[13px] text-muted-foreground transition-colors hover:text-foreground", active && "border-foreground/30 bg-accent text-foreground")}
    >
      {children}
    </button>
  );
}
