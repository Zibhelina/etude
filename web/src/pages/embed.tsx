// A compact study session for embedding in other apps (chat clients, notes, dashboards).
// No app chrome, transparent background, sizes itself to its content, and speaks the
// widget protocol of hosts like Lotus: resize, theme and an optional summary sent back to the chat.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquareText, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { AnswerRetry } from "@/components/answer-retry";
import { Markdown } from "@/components/markdown";
import { api, humanInterval, RATING_LABEL, type Counts, type Rating, type Scope, type StudyCard } from "@/lib/api";
import { cn } from "@/lib/utils";

type Phase = "loading" | "answer" | "grading" | "result" | "done";
interface Done {
  itemId: string;
  title: string;
  rating: Rating | 0;
  verdict?: string;
}

const RATING_STYLE: Record<Rating, string> = {
  1: "text-again border-again/30 hover:bg-again/10",
  2: "text-hard border-hard/30 hover:bg-hard/10",
  3: "text-good border-good/30 hover:bg-good/10",
  4: "text-easy border-easy/30 hover:bg-easy/10",
};
const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: "Correct", cls: "text-good" },
  partial: { label: "Partly right", cls: "text-hard" },
  incorrect: { label: "Not quite", cls: "text-again" },
};

const host = window.parent !== window ? window.parent : null;
const toHost = (msg: Record<string, unknown>) => host?.postMessage({ lotus: 1, ...msg }, "*");

/** Maps a host's palette onto Etude's tokens so the widget matches the app around it. */
function applyHostTheme(theme: any) {
  // A frame whose color-scheme differs from its host's gets an opaque canvas, so follow the host.
  if (theme?.mode === "light" || theme?.mode === "dark") document.documentElement.style.colorScheme = theme.mode;
  const c = theme?.colors;
  if (!c) return;
  const root = document.documentElement.style;
  const set = (k: string, v: unknown) => typeof v === "string" && v && root.setProperty(k, v);
  set("--foreground", c.text);
  set("--card-foreground", c.text);
  set("--muted-foreground", c.textMuted);
  set("--border", c.border);
  set("--card", c.surface);
  set("--popover", c.surfaceRaised);
  if (theme.typography?.fontSans) root.setProperty("--font-sans", theme.typography.fontSans);
}

function useHostBridge() {
  useEffect(() => {
    document.documentElement.classList.add("embed");
    const report = () => toHost({ type: "resize", height: Math.ceil(document.body.getBoundingClientRect().height) });
    const ro = new ResizeObserver(report);
    ro.observe(document.body);
    const mo = new MutationObserver(report);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    const onMsg = (e: MessageEvent) => {
      if (e.source !== host || e.data?.lotus !== 1) return;
      if (e.data.type === "resize-request") report();
      if (e.data.type === "theme") applyHostTheme(e.data.theme);
    };
    window.addEventListener("message", onMsg);
    toHost({ type: "theme-request" });
    report();
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("message", onMsg);
    };
  }, []);
}

export function EmbedStudy({ scope, limit, cardId, title }: { scope: Scope; limit: number; cardId?: number; title: string }) {
  useHostBridge();
  const [card, setCard] = useState<StudyCard | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<CardResult | null>(null);
  const [retry, setRetry] = useState<{ hint: string; count: number } | null>(null);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text?: string; loading?: boolean; error?: string } | null>(null);
  const [ready, setReady] = useState(true);
  const [done, setDone] = useState<Done[]>([]);
  const [sent, setSent] = useState(false);
  const [round, setRound] = useState(0);
  const frame = useRef<CardFrameHandle>(null);
  const shownAt = useRef(Date.now());
  const busy = useRef(false);
  const titleRef = useRef("");
  /** Cards finished before the current round ("N more" starts a new round). */
  const doneBefore = useRef(0);

  const reset = () => {
    setResult(null);
    setRetry(null);
    setAttemptId(null);
    setFeedback(null);
    setReady(true);
  };

  const load = useCallback(async (exclude?: number, count = 0) => {
    setPhase("loading");
    reset();
    if (count >= limit) {
      setCounts(await api.counts(scope));
      setPhase("done");
      return;
    }
    const r = await api.next(scope, exclude);
    setCounts(r.counts);
    setCard(r.card);
    setPhase(r.card ? "answer" : "done");
    shownAt.current = Date.now();
  }, [scope.deck, scope.q, limit]);

  useEffect(() => {
    if (cardId) {
      Promise.all([api.card(cardId), api.counts(scope)]).then(([c, cnt]) => {
        setCard(c);
        setCounts(cnt);
        setPhase("answer");
      });
    } else load();
  }, [round]);

  useEffect(() => {
    if (card) {
      const t = card.title || card.itemId;
      titleRef.current = t.length > 90 ? t.slice(0, 88) + "…" : t;
    }
  }, [card?.itemId]);

  const askFeedback = useCallback(async (id: number) => {
    setFeedback({ loading: true });
    try {
      setFeedback({ text: (await api.feedback(id)).feedback });
    } catch (e) {
      setFeedback({ error: (e as Error).message });
    }
  }, []);

  const onSubmit = useCallback(async (answer: unknown) => {
    if (!card || busy.current) return;
    busy.current = true;
    setPhase("grading");
    try {
      const r = await api.submit(card, answer);
      if (r.retry) {
        setRetry((previous) => ({ hint: r.retry!.hint, count: (previous?.count ?? 0) + 1 }));
        setReady(true);
        setPhase("answer");
        return;
      }
      const res: CardResult = { grade: r.grade, key: r.key, answer };
      setResult(res);
      setAttemptId(r.attemptId);
      frame.current?.showResult(res);
      setPhase("result");
      if (r.grade.feedback && card.showVerdict !== false) setFeedback({ text: r.grade.feedback });
      else if (r.wantsFeedback && r.attemptId !== null) askFeedback(r.attemptId);
    } catch {
      setPhase("answer");
    } finally {
      busy.current = false;
    }
  }, [card, askFeedback]);

  const check = useCallback(() => {
    if (!card || phase !== "answer") return;
    if (!ready && card.grader !== "self") return;
    frame.current?.collect();
  }, [card, phase, ready]);

  const rate = useCallback(async (rating: Rating | 0) => {
    if (!card || phase !== "result" || busy.current) return;
    busy.current = true;
    try {
      await api.rate(card.cardId, rating, { attemptId: attemptId ?? undefined, durationMs: Date.now() - shownAt.current });
      const next = [...done, { itemId: card.itemId, title: titleRef.current || card.itemId, rating, verdict: result?.grade.verdict }];
      setDone(next);
      if (cardId) {
        setPhase("done");
        setCounts(await api.counts(scope));
      } else await load(card.cardId, next.length - doneBefore.current);
    } finally {
      busy.current = false;
    }
  }, [card, phase, attemptId, done, result, load, cardId]);

  const onKey = useCallback((key: string) => {
    if (phase === "answer" && (key === "Mod+Enter" || ((key === " " || key === "Enter") && card?.grader === "self"))) check();
    else if (phase === "result") {
      if (card && !card.scheduler.ratings) {
        if (key === " " || key === "Enter" || key === "Mod+Enter") rate(0);
      } else if (["1", "2", "3", "4"].includes(key)) rate(Number(key) as Rating);
      else if (key === " " || key === "Enter" || key === "Mod+Enter") rate(result?.grade.suggested ?? 3);
    }
  }, [phase, card, check, rate, result]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onKey("Mod+Enter");
      else if (!e.ctrlKey && !e.metaKey && !e.altKey) onKey(e.key);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey]);

  const sendSummary = () => {
    const n = done.length;
    const tally = ([1, 2, 3, 4] as Rating[]).map((r) => [RATING_LABEL[r], done.filter((d) => d.rating === r).length] as const).filter(([, c]) => c);
    const missed = done.filter((d) => d.rating === 1 || d.verdict === "incorrect" || d.verdict === "partial");
    const lines = [
      `[Etude] Finished ${n} card${n === 1 ? "" : "s"} in ${title}: ${tally.map(([l, c]) => `${c} ${l.toLowerCase()}`).join(", ")}.`,
      ...(missed.length ? [`Struggled with: ${missed.map((d) => `${d.title.trim()} (${d.itemId})`).join("; ")}.`] : []),
      counts ? `Still due here: ${counts.new} new, ${counts.learning} learning, ${counts.review} review.` : "",
    ].filter(Boolean);
    toHost({ type: "submit", text: lines.join("\n") });
    setSent(true);
  };

  const suggested = result?.grade.suggested ?? null;
  const verdict = card?.showVerdict !== false && result?.grade.verdict && VERDICT[result.grade.verdict];
  const progress = cardId ? null : `${Math.min(done.length - doneBefore.current + (phase === "done" ? 0 : 1), limit)} / ${limit}`;

  return (
    <div className="flex flex-col gap-4 p-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span>
        {progress && phase !== "done" && <span className="tabular">· {progress}</span>}
        <div className="flex-1" />
        {counts && (
          <span className="flex gap-2 tabular">
            <span className="text-new">{counts.new}</span>
            <span className="text-learn">{counts.learning}</span>
            <span className="text-review">{counts.review}</span>
          </span>
        )}
      </div>

      {phase === "loading" && !card && <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>}

      {phase === "done" ? (
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <div className="font-medium">{done.length ? `Done: ${done.length} card${done.length === 1 ? "" : "s"}` : "Nothing due right now"}</div>
          {done.length > 0 && (
            <div className="flex flex-wrap gap-3 text-sm">
              {([1, 2, 3, 4] as Rating[]).map((r) => {
                const c = done.filter((d) => d.rating === r).length;
                return c ? <span key={r} className={cn("tabular", RATING_STYLE[r].split(" ")[0])}>{c} {RATING_LABEL[r].toLowerCase()}</span> : null;
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {done.length > 0 && host && (
              <Button size="sm" variant="outline" className="gap-1.5" disabled={sent} onClick={sendSummary}>
                <Send className="size-4" /> {sent ? "Sent" : "Send results to chat"}
              </Button>
            )}
            {!cardId && counts && counts.new + counts.learning + counts.review > 0 && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { doneBefore.current = done.length; setSent(false); setRound((r) => r + 1); }}>
                <RotateCcw className="size-4" /> {limit} more
              </Button>
            )}
          </div>
        </div>
      ) : card ? (
        <>
          {retry && phase === "answer" && <AnswerRetry hint={retry.hint} />}
          <CardFrame
            ref={frame}
            src={`/frame/${encodeURIComponent(card.type)}?v=${encodeURIComponent(card.typeVersion)}`}
            frameKey={`${card.cardId}:${card.seed}:${card.typeVersion}:${retry?.count ?? 0}`}
            view={card.view}
            autoFocus={done.length > 0}
            onSubmit={onSubmit}
            onReady={setReady}
            onKey={onKey}
          />
          {phase === "result" && result && (
            <div className="flex flex-col gap-2.5">
              {verdict && (
                <div className="flex items-center gap-2 text-sm">
                  <span className={cn("font-medium", verdict.cls)}>{verdict.label}</span>
                  {result.grade.verdict === "partial" && result.grade.score != null && <span className="tabular text-muted-foreground">{Math.round(result.grade.score * 100)}%</span>}
                </div>
              )}
              {result.grade.adaptive?.reason && <div className="text-xs text-muted-foreground">Picked for you: {result.grade.adaptive.reason}.</div>}
              {feedback?.loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Writing feedback…</div>}
              {feedback?.text && (
                <div className="rounded-lg border px-3.5 py-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">Feedback</div>
                  <Markdown className="text-[0.93rem]">{feedback.text}</Markdown>
                </div>
              )}
              {!feedback && attemptId && card.showVerdict !== false && (
                <Button variant="ghost" size="sm" className="self-start gap-1.5 text-muted-foreground" onClick={() => askFeedback(attemptId)}>
                  <MessageSquareText className="size-4" /> Explain my answer
                </Button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {phase !== "result" ? (
              <Button className="h-10 w-full sm:w-auto sm:min-w-40" disabled={phase === "grading" || (!ready && card.grader !== "self")} onClick={check}>
                {phase === "grading" ? <><Loader2 className="size-4 animate-spin" /> Grading…</> : card.grader === "self" ? "Show answer" : "Check"}
              </Button>
            ) : !card.scheduler.ratings ? (
              <Button className="h-10 w-full sm:w-auto sm:min-w-40" onClick={() => rate(0)}>Next</Button>
            ) : (
              ([1, 2, 3, 4] as Rating[]).map((r) => (
                <button
                  key={r}
                  onClick={() => rate(r)}
                  className={cn("flex min-w-0 flex-1 flex-col items-center rounded-lg border px-2 py-1.5 text-sm font-medium sm:max-w-32", RATING_STYLE[r], suggested === r && "ring-2 ring-current/60")}
                >
                  <span>{RATING_LABEL[r]}</span>
                  <span className="tabular text-xs font-normal opacity-70">{humanInterval(card.intervals[r])}</span>
                </button>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
