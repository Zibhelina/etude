// Watch mode: a tour through a deck, one card at a time. Each card can show an example answer,
// graded the way a real one would be, so a newcomer sees how it works without answering anything.
// Nothing here is scheduled or stored. Trying a card yourself works too; AI-graded types then
// show their reference instead of calling a model.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { api, type Grade, type Scope, type StudyCard, type WatchEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { navigate } from "@/lib/router";
import { useFunMode } from "@/lib/fun";
import { track } from "@/lib/telemetry";
import { CardStage, cardEyebrow, crumbPath, Eyebrow, Feedback, flyOff, IconButton, reducedMotion, shownVerdict, Slot, StudyTop, Track, turnOver, useGlide, useSwapIn, Verdict, type FlipSide } from "@/components/study-shell";

type Phase = "loading" | "answer" | "grading" | "result" | "done" | "empty";

interface Shown {
  card: StudyCard;
  demo: { answer: unknown; grade: Grade | null };
  /** Bumped to remount the frame (a fresh variant, or the example answer filled in). */
  n: number;
}

/** The answer-mode frame staying on top while its answered copy loads underneath, so the card can morph across. */
interface Handoff {
  key: string;
  leaves: unknown[] | null;
  height: number;
}

/** The card on its way off the stage, pinned where it was. */
interface Leaving {
  stageKey: string;
  shown: Shown;
  result: CardResult | null;
  by: "example" | "you" | null;
  flip: FlipSide;
  rect: { left: number; top: number; width: number };
  dir: 1 | -1;
  done: boolean;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// The next card rises 230 ms into the fly-off, as in Study.
const NEXT_AFTER_MS = 230;
const stageKeyOf = (s: Shown) => `${s.card.cardId}:${s.card.seed}`;
const frameKeyOf = (s: Shown) => `${s.card.cardId}:${s.card.seed}:${s.n}`;

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
  // Motion: a self-graded card turns over to its back face; an answered example morphs across frames;
  // the card flies off when you move on.
  const stageEl = useRef<HTMLDivElement>(null);
  const backFrame = useRef<CardFrameHandle>(null);
  const backSized = useRef<(() => void) | null>(null);
  const [flip, setFlip] = useState<FlipSide>("front");
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const leavingEl = useRef<HTMLDivElement>(null);
  const [lateVerdict, setLateVerdict] = useState(false);
  const holdCard = useGlide(() => stageEl.current);
  const live = useRef({ shown, result, by, flip, phase });
  live.current = { shown, result, by, flip, phase };

  useEffect(() => {
    api.watchList(scope).then((r) => {
      setList(r.cards);
      if (!r.cards.length) setPhase("empty");
    }).catch((e) => toast.error((e as Error).message));
  }, [scope.deck, scope.q]);

  const load = useCallback(async (i: number, dir: 1 | -1 = 1) => {
    if (!list) return;
    // The card on screen flies off (left going forward, right going back) while the next one comes.
    const cur = live.current;
    const el = stageEl.current;
    const fly = !!cur.shown && !!el && !reducedMotion() && cur.phase !== "done" && cur.phase !== "empty";
    if (fly && cur.shown && el) {
      const r = el.getBoundingClientRect();
      setLeaving({ stageKey: stageKeyOf(cur.shown), shown: cur.shown, result: cur.result, by: cur.by, flip: cur.flip, rect: { left: r.left, top: r.top, width: r.width }, dir, done: false });
    }
    if (i >= list.length) {
      if (fly) await sleep(NEXT_AFTER_MS);
      return setPhase("done");
    }
    setPhase("loading");
    setResult(null);
    setBy(null);
    setFlip("front");
    setHandoff(null);
    setLateVerdict(false);
    try {
      const [r] = await Promise.all([api.watchCard(list[i].cardId), fly ? sleep(NEXT_AFTER_MS) : null]);
      setShown((s) => ({ ...r, n: (s?.n ?? 0) + 1 }));
      setIndex(i);
      setPhase("answer");
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast.error((e as Error).message);
      setLeaving(null);
    }
  }, [list]);

  // Start the fly-off once the leaving card is pinned where it was.
  useLayoutEffect(() => {
    if (!leaving || leaving.done) return;
    const el = leavingEl.current;
    if (!el) return setLeaving(null);
    const k = leaving.stageKey;
    flyOff(el, leaving.shown.card.grader === "self", leaving.dir).finished.then(() => setLeaving((l) => (l && l.stageKey === k ? { ...l, done: true } : l)), () => {});
  }, [leaving?.stageKey, leaving?.done]);
  useEffect(() => {
    if (leaving?.done) setLeaving(null);
  }, [leaving?.done]);

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
      const motion = !reducedMotion();
      // Where the card's pieces are now, so its answered copy can grow out of them.
      const [g, leaves] = await Promise.all([api.watchGrade(card.cardId, card.seed, demo.answer), motion && card.showVerdict !== false ? frame.current?.snapshot() ?? null : null]);
      key = g.key;
      if (!grade) grade = g.grade;
      const res: CardResult = { grade, key, answer: demo.answer };
      setResult(res);
      setBy("example");
      const paper = card.grader === "self";
      if (paper && motion) {
        // Self-graded: turn the card over to the answer on its back.
        const sized = () => new Promise<void>((ok) => {
          backSized.current = ok;
          setTimeout(ok, 160);
        });
        const turned = await turnOver(stageEl.current, backFrame.current, res, sized, (side) => flushSync(() => setFlip(side)), false);
        backSized.current = null;
        if (!turned) setShown((s) => s && { ...s, n: s.n + 1 });
      } else {
        // Remount in result mode with the answer filled in, as the card would look once answered; the
        // answer-mode frame stays on top until the new one is up, and the new one morphs out of it.
        const h = stageEl.current?.querySelector<HTMLIFrameElement>(".st-frame iframe")?.offsetHeight ?? 0;
        if (motion && h) setHandoff({ key: frameKeyOf(shown), leaves: leaves ?? null, height: h });
        setShown((s) => s && { ...s, n: s.n + 1 });
      }
      holdCard();
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
      frame.current?.showResult(res, { morph: shown.card.showVerdict !== false });
      holdCard();
      setPhase("result");
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("answer");
    } finally {
      busy.current = false;
    }
  }, [shown]);

  const moving = phase === "loading" || phase === "grading" || (flip === "turning");
  const next = useCallback(() => { if (list && !moving) load(index + 1); }, [list, index, moving, load]);
  const prev = useCallback(() => { if (index > 0 && !moving) load(index - 1, -1); }, [index, moving, load]);
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
  const paper = !!card && card.grader === "self";
  const twoFaced = !reducedMotion();
  const slotRef = useSwapIn(`${shown?.n}:${phase === "result" ? "r" : "a"}`);
  const eyebrowOf = (c: StudyCard, r: CardResult | null) => {
    const items = cardEyebrow(c).filter((it) => it.text !== "Variant");
    if (c.grader === "ai" || r?.grade.grader.kind === "ai") items.push({ text: "AI-graded" });
    if (c.generated) items.push({ text: "New variant every time" });
    return items;
  };
  const src = (c: StudyCard) => `/frame/${encodeURIComponent(c.type)}?v=${encodeURIComponent(c.typeVersion)}`;

  /** The card on its stage; the same tree for the live card and for one flying off, so its frames aren't reloaded. */
  const renderStage = (s: Shown, o: { live: boolean; result: CardResult | null; by: "example" | "you" | null; flip: FlipSide; phase: Phase; leaving?: Leaving }) => {
    const c = s.card;
    const isPaper = c.grader === "self";
    const v = c.showVerdict !== false ? shownVerdict(o.result?.grade.verdict) : null;
    // The example answer is in the frame itself (a remount in result mode), unless it went on the back face.
    const filled = (o.phase === "result" || !!o.leaving) && o.by === "example" && o.flip === "front";
    const fk = frameKeyOf(s);
    const ho = o.live ? handoff : null;
    const frames = [];
    if (ho && ho.key !== fk) {
      frames.push(
        <div key={ho.key} className="st-handoff" aria-hidden>
          <CardFrame frameKey={ho.key} src={src(c)} view={c.view} mode="answer" autoFocus={false} initialHeight={ho.height} />
        </div>,
      );
    }
    frames.push(
      <div key={fk} className={ho && ho.key !== fk ? "st-handoff-under" : undefined}>
        <CardFrame
          ref={o.live ? frame : undefined}
          src={src(c)}
          frameKey={fk}
          view={c.view}
          mode={filled ? "result" : "answer"}
          answer={filled ? o.result?.answer : undefined}
          result={filled ? o.result : null}
          autoFocus={false}
          initialHeight={ho && ho.key !== fk ? ho.height : undefined}
          morphFrom={ho && ho.key !== fk ? ho.leaves : undefined}
          onMounted={o.live && ho && ho.key !== fk ? () => setHandoff(null) : undefined}
          onMorph={o.live ? setLateVerdict : undefined}
          onSubmit={o.live ? onSubmit : undefined}
          onKey={o.live ? onKey : undefined}
          onError={o.live ? (m) => toast.error("Card error", { description: m }) : undefined}
        />
      </div>,
    );
    return (
      <CardStage
        key={stageKeyOf(s)}
        ref={o.live ? stageEl : leavingEl}
        paper={isPaper}
        eyebrow={<Eyebrow items={eyebrowOf(c, o.result)} />}
        aside={!isPaper && o.phase === "result" && v ? <Verdict verdict={v} score={o.result?.grade.score} prefix={o.by === "example" ? "Example: " : undefined} late={o.live && lateVerdict} /> : !isPaper && o.phase === "answer" ? <span className="hidden text-xs text-muted-foreground sm:inline">Try it, or let it show you.</span> : undefined}
        className={cn(o.leaving && "st-leaving")}
        style={o.leaving ? { left: o.leaving.rect.left, top: o.leaving.rect.top, width: o.leaving.rect.width } : undefined}
        flip={o.flip}
        back={isPaper && (twoFaced || o.flip !== "front") ? (
          <CardFrame
            ref={o.live ? backFrame : undefined}
            src={src(c)}
            frameKey={`${fk}:back`}
            view={c.view}
            autoFocus={false}
            onKey={o.live ? onKey : undefined}
            onSize={o.live ? () => backSized.current?.() : undefined}
          />
        ) : undefined}
      >
        {frames}
      </CardStage>
    );
  };

  return (
    <div className="flex min-h-dvh w-full flex-col pb-[calc(9.5rem+env(safe-area-inset-bottom))]">
      <StudyTop title={title} crumb={crumbPath(entry?.deck, scope.deck)} onBack={() => navigate("/")}>
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

      {((card && shown && phase !== "done" && phase !== "empty") || leaving) && (
        <main className="st-stage">
          <div className="st-col">
            {leaving && renderStage(leaving.shown, { live: false, result: leaving.result, by: leaving.by, flip: leaving.flip, phase: "result", leaving })}
            {card && shown && phase !== "done" && phase !== "empty" && stageKeyOf(shown) !== leaving?.stageKey && renderStage(shown, { live: true, result, by, flip, phase })}

            {card && phase === "result" && result && (
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

      {card && (phase === "answer" || phase === "grading" || phase === "result" || (phase === "loading" && leaving)) && (
        <Slot ref={slotRef} className={cn(phase === "loading" && "leaving")}>
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
                <button className="st-sec" onClick={next} disabled={phase === "grading" && !(paper && twoFaced)}>{last ? "Finish" : "Skip"}</button>
                <button className="st-pri" onClick={showExample} disabled={phase === "grading" && !(paper && twoFaced)}>
                  {phase === "grading" && !(paper && twoFaced) ? <><Loader2 className="size-4 animate-spin" />Answering…</> : <>Show an answer</>}
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
