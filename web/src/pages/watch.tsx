// Watch mode: a tour through a deck, one card at a time. Each card can show an example answer,
// graded the way a real one would be, so a newcomer sees how it works without answering anything.
// Nothing here is scheduled or stored. Trying a card yourself works too; AI-graded types then
// show their reference instead of calling a model.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { api, type Grade, type Scope, type StudyCard, type WatchEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/router";
import { useFunMode } from "@/lib/fun";
import { track } from "@/lib/telemetry";
import { CardStage, cardEyebrow, Eyebrow, Feedback, IconButton, shownVerdict, Slot, StudyTop, Track, useSwapIn, Verdict } from "@/components/study-shell";

type Phase = "loading" | "answer" | "grading" | "result" | "done" | "empty";

interface Shown {
  card: StudyCard;
  demo: { answer: unknown; grade: Grade | null };
  /** Bumped to remount the frame (a fresh variant, or the example answer filled in). */
  n: number;
}

export function WatchPage({ scope, title }: { scope: Scope; title: string }) {
  // Usage count (only when the person turned usage stats on).
  useEffect(() => track("watch.open"), []);
  const [list, setList] = useState<WatchEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<CardResult | null>(null);
  /** Whose answer the result is: the example's or the reader's own. */
  const [by, setBy] = useState<"example" | "you" | null>(null);
  const frame = useRef<CardFrameHandle>(null);
  const resultRef = useRef<HTMLElement>(null);
  const busy = useRef(false);
  const fun = useFunMode();

  useEffect(() => {
    api.watchList(scope).then((r) => {
      setList(r.cards);
      if (!r.cards.length) setPhase("empty");
    }).catch((e) => toast.error((e as Error).message));
  }, [scope.deck, scope.q]);

  const load = useCallback(async (i: number) => {
    if (!list) return;
    if (i >= list.length) return setPhase("done");
    setPhase("loading");
    setResult(null);
    setBy(null);
    try {
      const r = await api.watchCard(list[i].cardId);
      setShown((s) => ({ ...r, n: (s?.n ?? 0) + 1 }));
      setIndex(i);
      setPhase("answer");
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [list]);

  useEffect(() => { if (list?.length) load(0); }, [list]);

  // The reader's own answer: bring the verdict into view. The example's: stay on the card, since
  // the filled-in answer is the point, and the verdict also shows above the card.
  useEffect(() => {
    if (phase !== "result") return;
    if (by === "example") window.scrollTo({ top: 0, behavior: "smooth" });
    else setTimeout(() => resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
  }, [phase, by]);

  /** Fills the card with the example answer and grades it like a real one. */
  const showExample = useCallback(async () => {
    if (!shown || busy.current || phase !== "answer") return;
    busy.current = true;
    setPhase("grading");
    try {
      const { card, demo } = shown;
      let grade = demo.grade, key: Record<string, unknown> = {};
      const g = await api.watchGrade(card.cardId, card.seed, demo.answer);
      key = g.key;
      if (!grade) grade = g.grade;
      setResult({ grade, key, answer: demo.answer });
      setBy("example");
      // Remount in result mode with the answer filled in, as the card would look once answered.
      setShown((s) => s && { ...s, n: s.n + 1 });
      setPhase("result");
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("answer");
    } finally {
      busy.current = false;
    }
  }, [shown, phase]);

  /** The reader answered it themselves. */
  const onSubmit = useCallback(async (answer: unknown) => {
    if (!shown || busy.current) return;
    busy.current = true;
    setPhase("grading");
    try {
      const g = await api.watchGrade(shown.card.cardId, shown.card.seed, answer);
      const res: CardResult = { grade: g.grade, key: g.key, answer };
      setResult(res);
      setBy("you");
      frame.current?.showResult(res);
      setPhase("result");
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("answer");
    } finally {
      busy.current = false;
    }
  }, [shown]);

  const next = useCallback(() => { if (list && phase !== "loading" && phase !== "grading") load(index + 1); }, [list, index, phase, load]);
  const prev = useCallback(() => { if (index > 0 && phase !== "loading" && phase !== "grading") load(index - 1); }, [index, phase, load]);
  const again = useCallback(() => load(index), [index, load]);

  const onKey = useCallback((key: string) => {
    if (key === "ArrowRight") return next();
    if (key === "ArrowLeft") return prev();
    if (phase === "result" && (key === " " || key === "Enter" || key === "Mod+Enter")) next();
    else if (phase === "answer" && key === "Mod+Enter") frame.current?.collect();
  }, [phase, next, prev]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const field = t?.closest("input, textarea, [contenteditable]") as HTMLInputElement | null;
      const arrow = e.key === "ArrowRight" || e.key === "ArrowLeft";
      if (field && !(arrow && !(field.isContentEditable ? field.textContent : field.value))) return;
      if (e.key === "Escape") return navigate("/");
      if (e.key === "ArrowRight") return next();
      if (e.key === "ArrowLeft") return prev();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") return onKey("Mod+Enter");
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === " ") e.preventDefault();
        onKey(e.key);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey, next, prev]);

  const card = shown?.card;
  const total = list?.length ?? 0;
  const entry = list?.[index];
  const verdict = card?.showVerdict !== false ? shownVerdict(result?.grade.verdict) : null;
  const ai = card && (card.grader === "ai" || result?.grade.grader.kind === "ai");
  const last = index + 1 >= total;
  const filled = phase === "result" && by === "example";
  const paper = !!card && card.grader === "self";
  const slotRef = useSwapIn(`${shown?.n}:${phase === "result" ? "r" : "a"}`);
  const eyebrow = card ? cardEyebrow(card).filter((it) => it.text !== "Variant") : [];
  if (ai) eyebrow.push({ text: "AI-graded" });
  if (card?.generated) eyebrow.push({ text: "New variant every time" });

  return (
    <div className="flex min-h-dvh w-full flex-col pb-[calc(9.5rem+env(safe-area-inset-bottom))]">
      <StudyTop title={title} crumb={entry ? entry.deck.split("::").slice(1).join(" › ") || undefined : undefined} onBack={() => navigate("/")}>
        {card && phase !== "done" && phase !== "empty" && <span className="st-tag max-md:hidden">{card.type}</span>}
        {total > 0 && phase !== "done" && (
          <div className="st-prog">
            <span>{index + 1} / {total}</span>
            <Track value={(index + (phase === "result" ? 1 : 0.5)) / total} />
          </div>
        )}
        {total > 0 && phase !== "done" && (
          <div className="flex items-center gap-0.5">
            <IconButton label="Previous card" title="Previous card (←)" onClick={prev} disabled={index === 0}><ChevronLeft className="size-5" strokeWidth={1.8} /></IconButton>
            <IconButton label="Next card" title="Next card (→)" onClick={next} disabled={phase === "loading" || phase === "grading"}><ChevronRight className="size-5" strokeWidth={1.8} /></IconButton>
          </div>
        )}
      </StudyTop>

      {phase === "empty" && (
        <div className="st-rise flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
          <h2 className="st-serif text-4xl font-semibold tracking-tight">Nothing to watch</h2>
          <p className="max-w-sm text-muted-foreground">This deck has no cards yet.</p>
          <button className="st-sec mt-4" onClick={() => navigate("/")}>Back to the library</button>
        </div>
      )}

      {phase === "done" && (
        <div className="st-rise flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
          <h2 className="st-serif text-4xl font-semibold tracking-tight sm:text-[2.9rem]">That's the tour</h2>
          <p className="max-w-sm text-muted-foreground">{total} cards, one of each kind. Watching doesn't schedule anything; make a deck of your own, or import one, to study for real.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <button className="st-sec" onClick={() => load(0)}><RotateCcw className="size-4" />Watch again</button>
            <button className="st-pri" onClick={() => navigate("/")}>Back to the library</button>
          </div>
        </div>
      )}

      {card && shown && phase !== "done" && phase !== "empty" && (
        <main className="st-stage">
          <div className="st-col">
            <CardStage
              key={`${card.cardId}:${card.seed}`}
              paper={paper}
              eyebrow={<Eyebrow items={eyebrow} />}
              aside={!paper && phase === "result" && verdict ? <Verdict verdict={verdict} score={result?.grade.score} prefix={by === "example" ? "Example: " : undefined} /> : !paper && phase === "answer" ? <span className="hidden text-xs text-muted-foreground sm:inline">Try it, or let it show you.</span> : undefined}
              className={cn(phase === "loading" && "opacity-40 transition-opacity")}
            >
              <CardFrame
                ref={frame}
                src={`/frame/${encodeURIComponent(card.type)}?v=${encodeURIComponent(card.typeVersion)}`}
                frameKey={`${card.cardId}:${card.seed}:${shown.n}`}
                view={card.view}
                mode={filled ? "result" : "answer"}
                answer={filled ? result?.answer : undefined}
                result={filled ? result : null}
                autoFocus={false}
                onSubmit={onSubmit}
                onKey={onKey}
                onError={(m) => toast.error("Card error", { description: m })}
              />
            </CardStage>

            {phase === "result" && result && (
              <section ref={resultRef} className="flex scroll-mb-40 flex-col gap-4">
                <div className="st-rise flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                  {paper && verdict && <Verdict verdict={verdict} score={result.grade.score} prefix={by === "example" ? "Example: " : undefined} />}
                  {!verdict && (ai ? (
                    <span className="text-muted-foreground">In a study session, AI grades this answer against the reference.</span>
                  ) : card.grader === "self" ? (
                    <span className="text-muted-foreground">You'd rate yourself here: Again, Hard, Good or Easy.</span>
                  ) : null)}
                  {result.grade.grader.example && result.grade.grader.model && (
                    <span className="truncate text-xs text-muted-foreground">A real grade by {result.grade.grader.model.split(" + ").map((m) => m.split("/").pop()).join(" + ")}</span>
                  )}
                </div>
                {result.grade.feedback && card.showVerdict !== false && <Feedback text={result.grade.feedback} fun={fun} />}
              </section>
            )}
          </div>
        </main>
      )}

      {card && (phase === "answer" || phase === "grading" || phase === "result") && (
        <Slot ref={slotRef}>
          <div className="st-row">
            {phase === "result" ? (
              <>
                <button className="st-sec" onClick={again} aria-label="Show this card again">
                  <RotateCcw className="size-4" />{card.generated ? "Another variant" : "Again"}
                </button>
                <button className="st-pri" onClick={next}>
                  {last ? "Finish" : "Next card"} <ArrowRight className="size-4" /><kbd>Space</kbd>
                </button>
              </>
            ) : (
              <>
                <button className="st-sec" onClick={next} disabled={phase === "grading"}>{last ? "Finish" : "Skip"}</button>
                <button className="st-pri" onClick={showExample} disabled={phase === "grading"}>
                  {phase === "grading" ? <><Loader2 className="size-4 animate-spin" />Answering…</> : <>Show an answer</>}
                </button>
              </>
            )}
          </div>
          <div className="st-sugg st-kbd"><span><kbd>←</kbd> <kbd>→</kbd> to move between cards · nothing here is scheduled</span></div>
        </Slot>
      )}
      {phase === "loading" && !card && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      )}
    </div>
  );
}
