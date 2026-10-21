import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CornerDownLeft, Dices, Loader2, MessageSquareText, Pencil, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { Markdown } from "@/components/markdown";
import { api, humanInterval, relative, RATING_LABEL, type Counts, type Rating, type Scope, type StudyCard } from "@/lib/api";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/router";

type Phase = "loading" | "answer" | "grading" | "result" | "done";

const RATING_STYLE: Record<Rating, string> = {
  1: "text-again border-again/30 hover:bg-again/10",
  2: "text-hard border-hard/30 hover:bg-hard/10",
  3: "text-good border-good/30 hover:bg-good/10",
  4: "text-easy border-easy/30 hover:bg-easy/10",
};

const VERDICT_TEXT: Record<string, { label: string; cls: string }> = {
  correct: { label: "Correct", cls: "text-good" },
  partial: { label: "Partly right", cls: "text-hard" },
  incorrect: { label: "Not quite", cls: "text-again" },
};

export function StudyPage({ scope, title, startCard }: { scope: Scope; title: string; startCard?: number }) {
  const [card, setCard] = useState<StudyCard | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<CardResult | null>(null);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text?: string; loading?: boolean; error?: string } | null>(null);
  const [ready, setReady] = useState(true);
  const [practice, setPractice] = useState(false);
  const frame = useRef<CardFrameHandle>(null);
  const shownAt = useRef(Date.now());
  const lastCard = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (phase === "result") setTimeout(() => resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
  }, [phase, feedback?.text]);

  const load = useCallback(async (exclude?: number) => {
    setPhase("loading");
    setResult(null);
    setAttemptId(null);
    setFeedback(null);
    setReady(true);
    try {
      const r = await api.next(scope, exclude);
      setCounts(r.counts);
      setCard(r.card);
      setPractice(false);
      setPhase(r.card ? "answer" : "done");
      shownAt.current = Date.now();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [scope.deck, scope.q]);

  useEffect(() => {
    if (!startCard) {
      load();
      return;
    }
    // Opened on a specific card (from Browse, or a link): show it first, then continue with the scope.
    Promise.all([api.card(startCard), api.counts(scope)])
      .then(([c, cnt]) => {
        setCard(c);
        setCounts(cnt);
        setPhase("answer");
        shownAt.current = Date.now();
      })
      .catch((e) => toast.error((e as Error).message));
  }, [load, startCard]);

  const askFeedback = useCallback(async (id: number) => {
    setFeedback({ loading: true });
    try {
      const f = await api.feedback(id);
      setFeedback({ text: f.feedback });
    } catch (e) {
      setFeedback({ error: (e as Error).message });
    }
  }, []);

  const onSubmit = useCallback(async (answer: unknown) => {
    if (!card || busy.current) return;
    busy.current = true;
    setPhase("grading");
    try {
      const r = await api.submit(card.cardId, card.seed, answer, practice);
      const res: CardResult = { grade: r.grade, key: r.key, answer };
      setResult(res);
      setAttemptId(r.attemptId);
      frame.current?.showResult(res);
      setPhase("result");
      if (r.grade.feedback) setFeedback({ text: r.grade.feedback });
      else if (r.wantsFeedback) askFeedback(r.attemptId);
      if (r.grade.grader.error) toast.warning("Couldn't grade automatically", { description: r.grade.grader.error.slice(0, 200) });
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("answer");
    } finally {
      busy.current = false;
    }
  }, [card, practice, askFeedback]);

  const reveal = useCallback(() => {
    if (!card || phase !== "answer") return;
    // Cards say when an answer is complete enough to submit (e.g. not an empty box).
    if (!ready && card.grader !== "self") return;
    frame.current?.collect();
  }, [card, phase, ready]);

  const rate = useCallback(async (rating: Rating) => {
    if (!card || phase !== "result" || busy.current) return;
    busy.current = true;
    try {
      await api.rate(card.cardId, rating, { attemptId: attemptId ?? undefined, durationMs: Date.now() - shownAt.current, practice });
      lastCard.current = card.cardId;
      await load(card.cardId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [card, phase, attemptId, practice, load]);

  const undo = useCallback(async () => {
    try {
      const r = await api.undo();
      if (!r) return toast("Nothing to undo");
      const c = await api.card(r.cardId);
      const cnt = await api.counts(scope);
      setCounts(cnt);
      setCard(c);
      setResult(null);
      setAttemptId(null);
      setFeedback(null);
      setPhase("answer");
      shownAt.current = Date.now();
      toast("Undid the last rating");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [scope.deck, scope.q]);

  /** Same card, a new random variant, as practice: logged but doesn't move the schedule. */
  const anotherVariant = useCallback(async () => {
    if (!card) return;
    const c = await api.card(card.cardId);
    setCard(c);
    setResult(null);
    setAttemptId(null);
    setFeedback(null);
    setPractice(true);
    setPhase("answer");
  }, [card]);

  const onKey = useCallback((key: string) => {
    if (phase === "answer") {
      if (key === "Mod+Enter" || ((key === " " || key === "Enter") && card?.grader === "self")) reveal();
      return;
    }
    if (phase === "result") {
      if (key === "1" || key === "2" || key === "3" || key === "4") rate(Number(key) as Rating);
      else if (key === " " || key === "Enter" || key === "Mod+Enter") {
        const s = result?.grade.suggested ?? 3;
        rate(s);
      } else if (key === "Undo" || key === "u") undo();
    }
  }, [phase, card, reveal, rate, result, undo]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") return navigate("/");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") return onKey("Mod+Enter");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") return onKey("Undo");
      if (!e.ctrlKey && !e.metaKey && !e.altKey) onKey(e.key);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey]);

  const suggested = result?.grade.suggested ?? null;
  const verdict = result?.grade.verdict && VERDICT_TEXT[result.grade.verdict];
  const total = counts ? counts.new + counts.learning + counts.review : 0;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-5 pb-40 sm:px-8">
      <header className="sticky top-0 z-10 -mx-5 flex items-center gap-3 bg-background/85 px-5 py-4 backdrop-blur sm:-mx-8 sm:px-8">
        <Button variant="ghost" size="icon" className="-ml-2" onClick={() => navigate("/")} aria-label="Back to decks">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {card && <div className="truncate text-xs text-muted-foreground">{card.deck.split("::").slice(1).join(" › ") || card.deck}</div>}
        </div>
        {counts && (
          <div className="flex items-center gap-3 text-sm tabular">
            <Tooltip><TooltipTrigger asChild><span className="text-new">{counts.new}</span></TooltipTrigger><TooltipContent>New</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><span className="text-learn">{counts.learning}</span></TooltipTrigger><TooltipContent>Learning</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><span className="text-review">{counts.review}</span></TooltipTrigger><TooltipContent>Review</TooltipContent></Tooltip>
          </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo"><Undo2 /></Button>
          </TooltipTrigger>
          <TooltipContent>Undo last rating <kbd className="ml-1 opacity-70">Ctrl Z</kbd></TooltipContent>
        </Tooltip>
      </header>

      {phase === "done" && <Done counts={counts} />}

      {card && phase !== "done" && (
        <main className="flex flex-1 flex-col gap-6 pt-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">{card.type}</Badge>
            {card.state === 0 && <Badge variant="outline" className="border-new/30 font-normal text-new">new</Badge>}
            {card.generated && (
              <Tooltip>
                <TooltipTrigger asChild><Badge variant="outline" className="gap-1 font-normal"><Dices className="size-3" />variant</Badge></TooltipTrigger>
                <TooltipContent>Generated: the numbers change every review</TooltipContent>
              </Tooltip>
            )}
            {practice && <Badge variant="outline" className="border-highlight/40 font-normal text-highlight">practice, not scheduled</Badge>}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => navigate(`/browse?item=${encodeURIComponent(card.itemId)}`)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          </div>

          <CardFrame
            ref={frame}
            src={`/frame/${encodeURIComponent(card.type)}?v=${encodeURIComponent(card.typeVersion)}`}
            frameKey={`${card.cardId}:${card.seed}:${card.typeVersion}`}
            view={card.view}
            onSubmit={onSubmit}
            onReady={setReady}
            onKey={onKey}
            onError={(m) => toast.error("Card error", { description: m })}
          />

          {phase === "result" && result && (
            <section ref={resultRef} className="flex scroll-mb-36 flex-col gap-3 pt-1">
              {verdict && (
                <div className="flex items-center gap-2 text-sm">
                  <span className={cn("font-medium", verdict.cls)}>{verdict.label}</span>
                  {result.grade.score != null && result.grade.verdict === "partial" && <span className="tabular text-muted-foreground">{Math.round(result.grade.score * 100)}%</span>}
                  {result.grade.grader.kind === "ai" && result.grade.grader.model && (
                    <span className="truncate text-xs text-muted-foreground">· graded by {result.grade.grader.model.split("/").pop()}</span>
                  )}
                </div>
              )}
              {feedback?.loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Writing feedback…</div>
              )}
              {feedback?.text && (
                <div className="rounded-lg border bg-card/60 px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Sparkles className="size-3.5 text-highlight" />Feedback</div>
                  <Markdown className="text-[0.95rem]">{feedback.text}</Markdown>
                </div>
              )}
              {feedback?.error && <div className="text-sm text-destructive">Feedback failed: {feedback.error}</div>}
              <div className="flex flex-wrap items-center gap-2">
                {!feedback && attemptId && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => askFeedback(attemptId)}>
                    <MessageSquareText className="size-4" /> Explain my answer
                  </Button>
                )}
                {card.generated && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={anotherVariant}>
                    <RotateCcw className="size-4" /> Try another variant
                  </Button>
                )}
                {card.source && <span className="ml-auto text-xs text-muted-foreground">Source: {card.source}</span>}
              </div>
            </section>
          )}
        </main>
      )}

      {card && (phase === "answer" || phase === "grading" || phase === "result") && (
        <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background">
          <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-5 py-4 sm:px-8">
            {phase !== "result" ? (
              <Button size="lg" className="min-w-48 gap-2" disabled={phase === "grading" || (!ready && card.grader !== "self")} onClick={reveal}>
                {phase === "grading" ? <><Loader2 className="size-4 animate-spin" /> Grading…</> : card.grader === "self" ? <>Show answer <kbd className="text-xs opacity-60">Space</kbd></> : <>Check <span className="flex items-center gap-0.5 text-xs opacity-60"><kbd>Ctrl</kbd><CornerDownLeft className="size-3" /></span></>}
              </Button>
            ) : (
              ([1, 2, 3, 4] as Rating[]).map((r) => (
                <button
                  key={r}
                  onClick={() => rate(r)}
                  className={cn(
                    "flex min-w-20 flex-1 flex-col items-center gap-0.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors sm:max-w-36",
                    RATING_STYLE[r],
                    suggested === r && "ring-2 ring-current/60",
                  )}
                >
                  <span>{RATING_LABEL[r]}</span>
                  <span className="tabular text-xs font-normal opacity-70">{practice ? "practice" : humanInterval(card.intervals[r])}</span>
                </button>
              ))
            )}
          </div>
          {phase === "result" && (
            <div className="pb-3 text-center text-xs text-muted-foreground">
              <kbd>1</kbd>–<kbd>4</kbd> to rate{suggested ? <>, <kbd>Space</kbd> for {RATING_LABEL[suggested]}</> : null}
            </div>
          )}
        </footer>
      )}
      {phase === "loading" && !card && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      )}
      {total === 0 && phase === "loading" && null}
    </div>
  );
}

function Done({ counts }: { counts: Counts | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="text-2xl font-semibold tracking-tight">All done for now</div>
      <p className="max-w-sm text-muted-foreground">
        {counts?.doneToday ? `${counts.doneToday} reviews today. ` : ""}
        {counts?.nextDue ? `The next card comes back ${relative(counts.nextDue)}.` : "Nothing else is scheduled."}
      </p>
      <Button variant="outline" className="mt-4" onClick={() => navigate("/")}>Back to decks</Button>
    </div>
  );
}
