import { autoSync } from "@/lib/sync";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, FastForward, CornerDownLeft, Dices, EyeOff, Loader2, MessageSquareText, MoreHorizontal, Pause, Pencil, RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { Markdown } from "@/components/markdown";
import { api, humanInterval, relative, RATING_LABEL, type Counts, type Rating, type Scope, type StudyCard } from "@/lib/api";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/router";
import { usePhone } from "@/lib/phone";
import { ActionSheet, Tally } from "@/components/phone-shell";

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
  const phone = usePhone();
  const [tools, setTools] = useState(false);
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
  }, [scope.deck, scope.q, scope.ahead]);

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
      if (r.grade.feedback && card.showVerdict !== false) setFeedback({ text: r.grade.feedback });
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

  const rate = useCallback(async (rating: Rating | 0) => {
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
    if (busy.current) return;
    busy.current = true;
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
      setReady(true);
      setPractice(false);
      setPhase("answer");
      shownAt.current = Date.now();
      toast("Undid the last rating");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [scope.deck, scope.q, scope.ahead]);

  /** A drill: record this result, then go straight into another run of the same card. */
  const again = useCallback(async () => {
    if (!card || phase !== "result" || busy.current) return;
    busy.current = true;
    try {
      await api.rate(card.cardId, 0, { attemptId: attemptId ?? undefined, durationMs: Date.now() - shownAt.current, practice });
      const [c, cnt] = await Promise.all([api.card(card.cardId), api.counts(scope)]);
      setCounts(cnt);
      setCard(c);
      setResult(null);
      setAttemptId(null);
      setFeedback(null);
      setReady(false);
      setPractice(false);
      setPhase("answer");
      shownAt.current = Date.now();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [card, phase, attemptId, practice, scope.deck, scope.q, scope.ahead]);

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

  /** Bury or suspend the card or its whole note, then move on without rating. Undo restores only what this changed. */
  const setAside = useCallback(async (how: "bury" | "suspend", note: boolean) => {
    if (!card || busy.current || (phase !== "answer" && phase !== "result")) return;
    busy.current = true;
    const shown = card.cardId;
    try {
      const r = how === "bury" ? await api.buryCards([shown], note) : await api.suspendCards([shown], note);
      await load();
      const what = note ? "this note" : "this card";
      toast(how === "bury" ? `Buried ${what} until tomorrow` : `Suspended ${what}`, {
        action: r.cardIds.length ? {
          label: "Undo",
          onClick: async () => {
            if (busy.current) return;
            busy.current = true;
            try {
              await api.bulkCards(how === "bury" ? "unbury" : "unsuspend", r.cardIds);
              const [c, cnt] = await Promise.all([api.card(shown), api.counts(scope)]);
              setCard(c);
              setCounts(cnt);
              setResult(null);
              setAttemptId(null);
              setFeedback(null);
              setReady(true);
              setPractice(false);
              setPhase("answer");
              shownAt.current = Date.now();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              busy.current = false;
            }
          },
        } : undefined,
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [card, phase, load, scope.deck, scope.q, scope.ahead]);

  const onKey = useCallback((key: string) => {
    if (phase === "answer" || phase === "result") {
      // As in Anki: - and = bury the card or the note, @ and ! suspend them.
      if (key === "-" || key === "=") return void setAside("bury", key === "=");
      if (key === "@" || key === "!") return void setAside("suspend", key === "!");
    }
    if ((key === "Undo" || key.toLowerCase() === "u") && (phase === "answer" || phase === "result" || phase === "done")) return void undo();
    if (phase === "answer") {
      if (key === "Mod+Enter" || ((key === " " || key === "Enter") && card?.grader === "self")) reveal();
      return;
    }
    if (phase === "result") {
      if (card && !card.scheduler.ratings) {
        if (key === " " || key === "Enter" || key === "Mod+Enter") rate(0);
        else if (key.toLowerCase() === "r") again();
        return;
      }
      if (key === "1" || key === "2" || key === "3" || key === "4") rate(Number(key) as Rating);
      else if (key === " " || key === "Enter" || key === "Mod+Enter") {
        const s = result?.grade.suggested ?? 3;
        rate(s);
      }
    }
  }, [phase, card, reveal, rate, result, undo, setAside, again]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.repeat && (["u", "U", "=", "-", "@", "!"].includes(e.key) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"))) return;
      const t = e.target as HTMLElement;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") return navigate("/");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") return onKey("Mod+Enter");
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return onKey("Undo");
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) onKey(e.key);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey]);

  const suggested = result?.grade.suggested ?? null;
  const verdict = card?.showVerdict !== false && result?.grade.verdict && VERDICT_TEXT[result.grade.verdict];
  const total = counts ? counts.new + counts.learning + counts.review : 0;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pb-44 sm:px-8">
      {phone ? (
        <header className="sticky top-0 z-10 -mx-4 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end bg-background/92 px-1 pt-[env(safe-area-inset-top)] backdrop-blur">
          <div className="flex h-14 w-full items-center gap-1">
            <button onClick={() => navigate("/")} className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent" aria-label="Back to decks"><ChevronLeft className="size-6" /></button>
            <div className="min-w-0 flex-1">
              <div className="score-serif truncate text-[1.15rem] leading-tight">{title}</div>
              {counts && <Tally n={counts.new} l={counts.learning} r={counts.review} className="mt-0.5 text-[12px]" />}
            </div>
            {card && (phase === "answer" || phase === "result") && (
              <button onClick={() => setTools(true)} className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent" aria-label="Card actions"><MoreHorizontal className="size-5" /></button>
            )}
          </div>
        </header>
      ) : (
      <header className="sticky top-0 z-10 -mx-4 flex items-center gap-2 bg-background/90 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur sm:-mx-8 sm:gap-3 sm:px-8 sm:py-4">
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
        {card && (phase === "answer" || phase === "result") && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setAside("bury", true)} aria-label="Bury note until tomorrow" aria-keyshortcuts="="><EyeOff /></Button>
            </TooltipTrigger>
            <TooltipContent>Bury until tomorrow: <kbd className="opacity-70">=</kbd> the note, <kbd className="opacity-70">-</kbd> just this card</TooltipContent>
          </Tooltip>
        )}
        {card && (phase === "answer" || phase === "result") && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Suspend"><Pause /></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Suspend: <kbd className="opacity-70">@</kbd> just this card, <kbd className="opacity-70">!</kbd> the note</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setAside("suspend", false)}>Suspend this card<kbd className="ml-auto pl-4 text-xs opacity-60">@</kbd></DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAside("suspend", true)}>Suspend the whole note<kbd className="ml-auto pl-4 text-xs opacity-60">!</kbd></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" disabled={phase === "loading" || phase === "grading"} onClick={undo} aria-label="Undo"><Undo2 /></Button>
          </TooltipTrigger>
          <TooltipContent>Undo last rating <kbd className="ml-1 opacity-70">Ctrl Z</kbd></TooltipContent>
        </Tooltip>
      </header>
      )}

      {phase === "done" && <Done counts={counts} scope={scope} />}

      {card && phase !== "done" && (
        <main className="flex flex-1 flex-col gap-5 pt-3 sm:gap-6 sm:pt-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">{card.type}</Badge>
            {card.scheduler.id !== "fsrs" && <Badge variant="outline" className="font-normal">{card.scheduler.name.toLowerCase()}</Badge>}
            {card.state === 0 && <Badge variant="outline" className="border-new/30 font-normal text-new">new</Badge>}
            {card.generated && (
              <Tooltip>
                <TooltipTrigger asChild><Badge variant="outline" className="gap-1 font-normal"><Dices className="size-3" />variant</Badge></TooltipTrigger>
                <TooltipContent>Generated: the numbers change every review</TooltipContent>
              </Tooltip>
            )}
            {scope.ahead && <Badge variant="outline" className="gap-1 font-normal"><FastForward className="size-3" />practicing ahead</Badge>}
            {practice && <Badge variant="outline" className="border-highlight/40 font-normal text-highlight">practice, not scheduled</Badge>}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground max-md:hidden" onClick={() => navigate(`/browse?item=${encodeURIComponent(card.itemId)}`)}>
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
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">Feedback</div>
                  <Markdown className="text-[0.95rem]">{feedback.text}</Markdown>
                </div>
              )}
              {feedback?.error && <div className="text-sm text-destructive">Feedback failed: {feedback.error}</div>}
              <div className="flex flex-wrap items-center gap-2">
                {!feedback && attemptId && card.showVerdict !== false && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => askFeedback(attemptId)}>
                    <MessageSquareText className="size-4" /> Explain my answer
                  </Button>
                )}
                {card.generated && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={anotherVariant}>
                    <RotateCcw className="size-4" /> Try another variant
                  </Button>
                )}
                {card.source && <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">Source: {card.source}</span>}
              </div>
            </section>
          )}
        </main>
      )}

      {card && (phase === "answer" || phase === "grading" || phase === "result") && (
        <footer className="fixed inset-x-0 bottom-0 z-10 border-t bg-background pb-[env(safe-area-inset-bottom)] max-md:border-t-0 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-3 py-3 max-md:px-4 sm:px-8 sm:py-4">
            {phone && phase !== "result" && (
              <button onClick={undo} disabled={phase === "grading"} aria-label="Undo last rating" className="flex size-[3.25rem] shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground active:bg-accent disabled:opacity-40"><Undo2 className="size-5" /></button>
            )}
            {phase !== "result" ? (
              <Button size="lg" className="h-[3.25rem] flex-1 gap-2 rounded-full text-[16px] pointer-coarse:h-[3.25rem] sm:h-10 sm:w-auto sm:min-w-48 sm:flex-none sm:rounded-md sm:text-sm" disabled={phase === "grading" || (!ready && card.grader !== "self")} onClick={reveal}>
                {phase === "grading" ? <><Loader2 className="size-4 animate-spin" /> Grading…</> : card.grader === "self" ? <>Show answer <kbd className="hidden text-xs opacity-60 sm:inline">Space</kbd></> : <>Check <span className="hidden items-center gap-0.5 text-xs opacity-60 sm:flex"><kbd>Ctrl</kbd><CornerDownLeft className="size-3" /></span></>}
              </Button>
            ) : !card.scheduler.ratings ? (
              <>
                <Button variant="outline" size="lg" className="h-[3.25rem] flex-1 gap-2 rounded-full pointer-coarse:h-[3.25rem] sm:h-10 sm:max-w-44 sm:flex-none sm:rounded-md" onClick={again}>
                  <RotateCcw className="size-4" /> Go again <kbd className="hidden text-xs opacity-60 sm:inline">R</kbd>
                </Button>
                <Button size="lg" className="h-[3.25rem] flex-1 gap-2 rounded-full pointer-coarse:h-[3.25rem] sm:h-10 sm:max-w-56 sm:flex-none sm:rounded-md" onClick={() => rate(0)}>
                  Next
                  <span className="text-xs font-normal opacity-70">{practice ? "practice" : card.scheduler.next ? (new Date(card.scheduler.next).getTime() <= Date.now() + 60_000 ? "again today" : `back ${relative(card.scheduler.next)}`) : ""}</span>
                </Button>
              </>
            ) : (
              ([1, 2, 3, 4] as Rating[]).map((r) => (
                <button
                  key={r}
                  onClick={() => rate(r)}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-2xl border px-1 py-3 text-[15px] font-medium transition-[colors,transform] active:scale-95 sm:max-w-36 sm:rounded-lg sm:px-3 sm:py-2 sm:text-sm",
                    RATING_STYLE[r],
                    suggested === r && "ring-2 ring-current/60 max-sm:bg-current/10 max-md:ring-inset",
                  )}
                >
                  <span>{RATING_LABEL[r]}</span>
                  <span className="tabular text-xs font-normal opacity-70">{practice ? "practice" : humanInterval(card.intervals[r])}</span>
                </button>
              ))
            )}
          </div>
          {phase === "result" && (
            <div className="hidden pb-3 text-center text-xs text-muted-foreground sm:block">
              {card.scheduler.ratings ? (
                <><kbd>1</kbd>–<kbd>4</kbd> to rate{suggested ? <>, <kbd>Space</kbd> for {RATING_LABEL[suggested]}</> : null}</>
              ) : (
                <>Your result is saved either way. <kbd>Space</kbd> for next, <kbd>R</kbd> to go again</>
              )}
            </div>
          )}
        </footer>
      )}
      {phone && card && (
        <ActionSheet
          open={tools}
          onClose={() => setTools(false)}
          title={card.deck.split("::").pop()}
          description={`${card.type}${card.generated ? " · a new variant each time" : ""}`}
          groups={[
            [{ label: "Undo last rating", icon: Undo2, onClick: undo }],
            [
              { label: "Bury this card", icon: EyeOff, hint: "until tomorrow", onClick: () => setAside("bury", false) },
              { label: "Bury the whole note", icon: EyeOff, onClick: () => setAside("bury", true) },
              { label: "Suspend this card", icon: Pause, onClick: () => setAside("suspend", false) },
              { label: "Suspend the whole note", icon: Pause, onClick: () => setAside("suspend", true) },
            ],
            [{ label: "Edit card", icon: Pencil, onClick: () => navigate(`/browse?item=${encodeURIComponent(card.itemId)}`) }],
          ]}
        />
      )}
      {phase === "loading" && !card && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      )}
      {total === 0 && phase === "loading" && null}
    </div>
  );
}

function Done({ counts, scope }: { counts: Counts | null; scope: Scope }) {
  useEffect(() => { void autoSync(); }, []);
  const aheadUrl = () => {
    const p = new URLSearchParams();
    if (scope.deck) p.set("deck", scope.deck);
    if (scope.q) p.set("q", scope.q);
    p.set("ahead", "1");
    return `/study?${p}`;
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="text-2xl font-semibold tracking-tight">{scope.ahead ? "Nothing left to study" : "All done for now"}</div>
      <p className="max-w-sm text-muted-foreground">
        {counts?.doneToday ? `${counts.doneToday} reviews today. ` : ""}
        {scope.ahead ? "There are no cards in this deck." : counts?.nextDue ? `The next card comes back ${relative(counts.nextDue)}.` : "Nothing else is scheduled."}
      </p>
      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={() => navigate("/")}>Back to decks</Button>
        {!scope.ahead && counts?.nextDue && (
          <Button className="gap-1.5" onClick={() => navigate(aheadUrl())} title="Review cards before they're due. FSRS counts an early review for less.">
            <FastForward className="size-4" />Practice ahead
          </Button>
        )}
      </div>
    </div>
  );
}
