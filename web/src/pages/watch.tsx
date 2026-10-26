// Watch mode: a tour through a deck, one card at a time. Each card can show an example answer,
// graded the way a real one would be, so a newcomer sees how it works without answering anything.
// Nothing here is scheduled or stored. Trying a card yourself works too; AI-graded types then
// show their reference instead of calling a model.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { Markdown } from "@/components/markdown";
import { api, type Grade, type Scope, type StudyCard, type WatchEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/router";

type Phase = "loading" | "answer" | "grading" | "result" | "done" | "empty";

const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: "Correct", cls: "text-good" },
  partial: { label: "Partly right", cls: "text-hard" },
  incorrect: { label: "Not quite", cls: "text-again" },
};

interface Shown {
  card: StudyCard;
  demo: { answer: unknown; grade: Grade | null };
  /** Bumped to remount the frame (a fresh variant, or the example answer filled in). */
  n: number;
}

export function WatchPage({ scope, title }: { scope: Scope; title: string }) {
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
      if (!e.ctrlKey && !e.metaKey && !e.altKey) onKey(e.key);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey, next, prev]);

  const card = shown?.card;
  const total = list?.length ?? 0;
  const entry = list?.[index];
  const verdict = card?.showVerdict !== false && result?.grade.verdict ? VERDICT[result.grade.verdict] : undefined;
  const ai = card && (card.grader === "ai" || result?.grade.grader.kind === "ai");
  const last = index + 1 >= total;
  const filled = phase === "result" && by === "example";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-44 sm:px-8">
      <header className="sticky top-0 z-10 -mx-4 bg-background/90 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-2 py-3 sm:gap-3 sm:py-4">
          <Button variant="ghost" size="icon" className="-ml-2" onClick={() => navigate("/")} aria-label="Back to decks">
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title}</div>
            {entry && <div className="truncate text-xs text-muted-foreground">{entry.deck.split("::").slice(1).join(" › ") || entry.deck}</div>}
          </div>
          {total > 0 && phase !== "done" && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={prev} disabled={index === 0} aria-label="Previous card"><ChevronLeft /></Button>
              <span className="tabular min-w-12 text-center text-sm text-muted-foreground">{index + 1} / {total}</span>
            </div>
          )}
        </div>
        {total > 0 && (
          <div className="-mx-4 h-0.5 bg-border/60 sm:-mx-8" aria-hidden>
            <div className="h-full bg-highlight transition-[width] duration-500" style={{ width: `${((phase === "done" ? total : index + (phase === "result" ? 1 : 0.5)) / total) * 100}%` }} />
          </div>
        )}
      </header>

      {phase === "empty" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <div className="text-2xl font-semibold tracking-tight">Nothing to watch</div>
          <p className="max-w-sm text-muted-foreground">This deck has no cards yet.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/")}>Back to decks</Button>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <div className="text-2xl font-semibold tracking-tight">That's the tour</div>
          <p className="max-w-sm text-muted-foreground">{total} cards, one of each kind. Watching doesn't schedule anything; make a deck of your own, or import one, to study for real.</p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={() => load(0)}><RotateCcw className="size-4" />Watch again</Button>
            <Button onClick={() => navigate("/")}>Back to decks</Button>
          </div>
        </div>
      )}

      {card && shown && phase !== "done" && phase !== "empty" && (
        <main className="flex flex-1 flex-col gap-6 pt-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">{card.type}</Badge>
            {ai && <Badge variant="outline" className="gap-1 font-normal">AI-graded</Badge>}
            {card.generated && <Badge variant="outline" className="font-normal">new variant every time</Badge>}
            {phase === "result" && verdict ? (
              <span className={cn("ml-auto text-sm font-medium", verdict.cls)}>{by === "example" ? "Example: " : ""}{verdict.label}</span>
            ) : (
              <span className="ml-auto hidden sm:inline">Try it, or let it show you.</span>
            )}
          </div>

          <div className={cn("transition-opacity duration-300", phase === "loading" && "opacity-40")}>
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
          </div>

          {phase === "result" && result && (
            <section ref={resultRef} className="flex scroll-mb-36 flex-col gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {by === "example" && <span className="text-muted-foreground">Example answer:</span>}
                {verdict ? (
                  <span className={cn("font-medium", verdict.cls)}>{verdict.label}</span>
                ) : ai ? (
                  <span className="text-muted-foreground">In a study session, AI grades this answer against the reference.</span>
                ) : card.grader === "self" ? (
                  <span className="text-muted-foreground">You'd rate yourself here: Again, Hard, Good or Easy.</span>
                ) : null}
                {result.grade.score != null && result.grade.verdict === "partial" && <span className="tabular text-muted-foreground">{Math.round(result.grade.score * 100)}%</span>}
                {result.grade.grader.example && result.grade.grader.model && (
                  <span className="truncate text-xs text-muted-foreground">· a real grade by {result.grade.grader.model.split(" + ").map((m) => m.split("/").pop()).join(" + ")}</span>
                )}
              </div>
              {result.grade.feedback && card?.showVerdict !== false && (
                <div className="rounded-lg border bg-card/60 px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">Feedback</div>
                  <Markdown className="text-[0.95rem]">{result.grade.feedback}</Markdown>
                </div>
              )}
            </section>
          )}
        </main>
      )}

      {card && (phase === "answer" || phase === "grading" || phase === "result") && (
        <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-3 py-3 sm:px-8 sm:py-4">
            {phase === "result" ? (
              <>
                <Button variant="outline" size="lg" className="h-12 gap-2 sm:h-10" onClick={again} aria-label="Show this card again">
                  <RotateCcw className="size-4" /><span className="hidden sm:inline">{card.generated ? "Another variant" : "Again"}</span>
                </Button>
                <Button size="lg" className="h-12 flex-1 gap-2 sm:h-10 sm:min-w-48 sm:flex-none" onClick={next}>
                  {last ? "Finish" : "Next card"} <ArrowRight className="size-4" />
                  <kbd className="hidden text-xs opacity-60 sm:inline">Space</kbd>
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="lg" className="h-12 gap-2 sm:h-10" onClick={next} disabled={phase === "grading"}>
                  {last ? "Finish" : "Skip"}
                </Button>
                <Button size="lg" className="h-12 flex-1 gap-2 sm:h-10 sm:min-w-48 sm:flex-none" onClick={showExample} disabled={phase === "grading"}>
                  {phase === "grading" ? <><Loader2 className="size-4 animate-spin" />Answering…</> : <>Show an answer</>}
                </Button>
              </>
            )}
          </div>
          <div className="hidden pb-3 text-center text-xs text-muted-foreground sm:block">
            <kbd>←</kbd> <kbd>→</kbd> to move between cards · nothing here is scheduled
          </div>
        </footer>
      )}
      {phase === "loading" && !card && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      )}
    </div>
  );
}
