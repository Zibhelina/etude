import { autoSync } from "@/lib/sync";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeftToLine, EyeOff, FastForward, Loader2, Maximize2, MessageSquareText, Minimize2, MoreHorizontal, Pause, Pencil, Plus, RotateCcw, Undo2, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CardFrame, type CardFrameHandle, type CardResult } from "@/components/card-frame";
import { AnswerRetry } from "@/components/answer-retry";
import { api, relative, type Counts, type LearnerSummary, type Rating, type Scope, type StudyCard } from "@/lib/api";
import { agentApi } from "@/lib/agent";
import { cn } from "@/lib/utils";
import { appPath, navigate } from "@/lib/router";
import { usePhone } from "@/lib/phone";
import { useFunMode } from "@/lib/fun";
import { ActionSheet, Tally } from "@/components/phone-shell";
import { SketchBar, SketchLayer, sketchTransform, useSketch } from "@/components/sketch-pad";
import { track } from "@/lib/telemetry";
import {
  AskTab, CardStage, cardEyebrow, flyOff, turnOver, useGlide, Composer, crumbPath, shownVerdict, Eyebrow, Feedback, IconButton, modKey, Ratings, reducedMotion, Slot, StudyTop, Suggestion, Thread, Track, useSwapIn, Verdict,
  type ChatMsg, type FlipSide,
} from "@/components/study-shell";

type Phase = "loading" | "answer" | "grading" | "result" | "done";

const FOCUS_KEY = "etude.study.focus";

// On a phone, focus mode runs the card edge to edge; this strip under it holds the leave-focus button,
// so the button never covers the card.
const PHONE_FOCUS_STRIP = 56;

// Once per session the page dips toward the follow-up chat, to show there's more below the feedback.
let nudged = false;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// After a rating: a beat for the ring on the chosen key, then the next card rises 230 ms into the fly-off.
const RATE_BEAT_MS = 50;
const NEXT_AFTER_MS = 230;

const frameKeyOf = (c: StudyCard, retries: number) => `${c.cardId}:${c.seed}:${c.typeVersion}:${retries}`;
const clip = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

interface Leaving {
  key: string;
  card: StudyCard;
  rect: { left: number; top: number; width: number };
  paper: boolean;
  done: boolean;
}

export function StudyPage({ scope, title, startCard }: { scope: Scope; title: string; startCard?: number }) {
  // Usage count (only when the person turned usage stats on).
  useEffect(() => track("study.session"), []);
  const [card, setCard] = useState<StudyCard | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<CardResult | null>(null);
  const [retry, setRetry] = useState<{ hint: string; count: number } | null>(null);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text?: string; loading?: boolean; error?: string } | null>(null);
  const [ready, setReady] = useState(true);
  const [practice, setPractice] = useState(false);
  const phone = usePhone();
  const fun = useFunMode();
  const [tools, setTools] = useState(false);
  const [plus, setPlus] = useState(false);
  // Focus mode: only the card, for cards that fill the screen (games). Remembered per browser.
  const [focus, setFocus] = useState(() => { try { return localStorage.getItem(FOCUS_KEY) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(FOCUS_KEY, focus ? "1" : "0"); } catch { /* storage blocked */ } }, [focus]);
  const mainRef = useRef<HTMLElement>(null);
  const frame = useRef<CardFrameHandle>(null);
  const shownAt = useRef(Date.now());
  const lastCard = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const sk = useSketch(card ? `${card.cardId}:${card.seed}` : null);
  const currentKeyRef = useRef<string | null>(null);

  // Motion: the card on the stage, the one flying off after a rating, and a basic card's flip.
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [exiting, setExiting] = useState(false);
  // A self-graded card turns over to a second copy of itself showing the answer (its back face).
  const backFrame = useRef<CardFrameHandle>(null);
  const backSized = useRef<((h: number) => void) | null>(null);
  const flipPending = useRef(false);
  const [flip, setFlip] = useState<{ key: string; side: FlipSide } | null>(null);
  const [flipping, setFlipping] = useState(false);
  const [lateVerdict, setLateVerdict] = useState(false);

  // The follow-up chat under AI feedback.
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatting, setChatting] = useState(false);
  const [sawChat, setSawChat] = useState(false);
  const [asking, setAsking] = useState(false);
  const [attached, setAttached] = useState<{ id: string; name: string } | null>(null);
  const conv = useRef<{ id: string; model: string | null; primed: boolean } | null>(null);
  const fbRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const askInput = useRef<HTMLInputElement>(null);
  const quiet = useRef(0);

  const resetCard = () => {
    setResult(null);
    setRetry(null);
    setAttemptId(null);
    setFeedback(null);
    setChat([]);
    setChatting(false);
    setSawChat(false);
    setAttached(null);
    setExiting(false);
    setFlip(null);
    setFlipping(false);
    setLateVerdict(false);
    flipPending.current = false;
    conv.current = null;
  };

  const load = useCallback(async (exclude?: number) => {
    setPhase("loading");
    resetCard();
    setReady(true);
    try {
      const r = await api.next(scope, exclude);
      setCounts(r.counts);
      setCard(r.card);
      setPractice(false);
      setPhase(r.card ? "answer" : "done");
      shownAt.current = Date.now();
      window.scrollTo({ top: 0 });
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

  const holdCard = useGlide(() => (currentKeyRef.current ? cardEls.current.get(currentKeyRef.current) : null));
  const askFeedback = useCallback(async (id: number) => {
    holdCard();
    setFeedback({ loading: true });
    try {
      const f = await api.feedback(id);
      holdCard();
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
      const r = await api.submit(card, answer, practice);
      if (r.retry) {
        flipPending.current = false;
        setFlipping(false);
        setRetry((previous) => ({ hint: r.retry!.hint, count: (previous?.count ?? 0) + 1 }));
        setReady(true);
        setPhase("answer");
        return;
      }
      const res: CardResult = { grade: r.grade, key: r.key, answer };
      setResult(res);
      setAttemptId(r.attemptId);
      if (flipPending.current) {
        flipPending.current = false;
        await flipOverRef.current(res);
      } else {
        frame.current?.showResult(res, { morph: card.showVerdict !== false });
      }
      holdCard();
      setPhase("result");
      if (r.grade.feedback && card.showVerdict !== false) setFeedback({ text: r.grade.feedback });
      else if (r.wantsFeedback && r.attemptId !== null) askFeedback(r.attemptId);
      if (r.grade.grader.error) toast.warning("Couldn't grade automatically", { description: r.grade.grader.error.slice(0, 200) });
    } catch (e) {
      toast.error((e as Error).message);
      flipPending.current = false;
      setFlipping(false);
      setFlip(null);
      setPhase("answer");
    } finally {
      busy.current = false;
    }
  }, [card, practice, askFeedback]);

  const bare = focus && !!card && phase !== "done" && phase !== "loading";
  const paper = !!card && card.grader === "self" && !bare;
  const currentKey = card ? frameKeyOf(card, retry?.count ?? 0) : null;
  currentKeyRef.current = currentKey;
  // Self-graded cards get a back face to turn over to; with reduced motion the answer just goes on.
  const twoFaced = paper && !reducedMotion();

  /** Puts the result on the back face and turns the card over to it. */
  const flipOver = async (res: CardResult) => {
    const key = currentKey;
    const sized = () => new Promise<void>((ok) => {
      backSized.current = () => ok();
      setTimeout(ok, 160);
    });
    const turned = await turnOver(key ? cardEls.current.get(key) : null, backFrame.current, res, sized, (side) => flushSync(() => setFlip(key ? { key, side } : null)));
    backSized.current = null;
    if (!turned) frame.current?.showResult(res);
    setFlipping(false);
  };

  const flipOverRef = useRef(flipOver);
  flipOverRef.current = flipOver;

  const reveal = useCallback(() => {
    if (!card || phase !== "answer" || flipping || busy.current) return;
    // Cards say when an answer is complete enough to submit (e.g. not an empty box).
    if (!ready && card.grader !== "self") return;
    if (twoFaced && currentKey && cardEls.current.get(currentKey)?.querySelector(".st-backface")) {
      flipPending.current = true;
      setFlipping(true);
      // A card still loading doesn't answer collect(); don't stay stuck waiting to turn it over.
      window.setTimeout(() => {
        if (flipPending.current && !busy.current) {
          flipPending.current = false;
          setFlipping(false);
        }
      }, 1200);
    }
    frame.current?.collect();
  }, [card, phase, ready, twoFaced, currentKey, flipping]);

  const rate = useCallback(async (rating: Rating | 0) => {
    if (!card || phase !== "result" || busy.current) return;
    busy.current = true;
    // The card flies off to the left while the next one is fetched; the next rises off the deck.
    const el = currentKey ? cardEls.current.get(currentKey) : null;
    const motion = !!el && !!currentKey && !reducedMotion() && !bare;
    const rated = api.rate(card.cardId, rating, { attemptId: attemptId ?? undefined, durationMs: Date.now() - shownAt.current, practice });
    rated.catch(() => {}); // handled below; this keeps a fast failure from being reported as unhandled during the beat
    if (motion) await sleep(RATE_BEAT_MS);
    if (motion && el && currentKey) {
      const r = el.getBoundingClientRect();
      setLeaving({ key: currentKey, card, rect: { left: r.left, top: r.top, width: r.width }, paper, done: false });
    }
    setExiting(true);
    try {
      await Promise.all([rated, motion ? sleep(NEXT_AFTER_MS) : null]);
      lastCard.current = card.cardId;
      await load(card.cardId);
    } catch (e) {
      toast.error((e as Error).message);
      setLeaving(null);
      setExiting(false);
    } finally {
      busy.current = false;
    }
  }, [card, phase, attemptId, practice, load, currentKey, paper, bare]);

  // Start the fly-off once the leaving card is pinned where it was.
  useLayoutEffect(() => {
    if (!leaving || leaving.done) return;
    const el = cardEls.current.get(leaving.key);
    if (!el) return setLeaving(null);
    const anim = flyOff(el, leaving.paper);
    const k = leaving.key;
    anim.finished.then(() => setLeaving((l) => (l && l.key === k ? { ...l, done: true } : l)), () => {});
  }, [leaving?.key, leaving?.done]);
  useEffect(() => {
    if (leaving?.done && leaving.key !== currentKey) setLeaving(null);
  }, [leaving?.done, leaving?.key, currentKey]);

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
      resetCard();
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
      resetCard();
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
    resetCard();
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
              resetCard();
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

  // ---------------------------------------------------------------- the follow-up chat
  const hasAsk = phase === "result" && !!feedback?.text && !bare && !exiting;
  const headerH = () => document.querySelector<HTMLElement>(".st-top")?.offsetHeight ?? 64;
  const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
  const chatPos = () => {
    const el = fbRef.current;
    return el ? Math.max(0, el.getBoundingClientRect().top + window.scrollY - headerH() - 14) : 0;
  };
  const chatTop = () => Math.min(chatPos(), maxScroll());
  // The page ends where the chat starts: scrolled to the bottom, the feedback sits under the header.
  const sizePad = useCallback(() => {
    const pad = padRef.current;
    if (!pad) return;
    let h = 0;
    // Resizing the pad can clamp the scroll position; that isn't the reader scrolling back up.
    quiet.current = Math.max(quiet.current, Date.now() + 250);
    pad.style.height = "0px";
    for (let i = 0; i < 8; i++) {
      const need = chatPos() - maxScroll();
      if (Math.abs(need) < 1) break;
      h = Math.max(0, h + need);
      pad.style.height = `${h}px`;
    }
  }, []);
  const glide = (top: number) => {
    quiet.current = Date.now() + 700;
    window.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  const openChat = useCallback(() => {
    setChatting(true);
    setSawChat(true);
    requestAnimationFrame(() => {
      sizePad();
      glide(chatTop());
      if (!phone) askInput.current?.focus({ preventScroll: true });
    });
  }, [phone, sizePad]);
  const backToRating = useCallback(() => {
    setChatting(false);
    askInput.current?.blur();
    glide(0);
  }, []);

  useLayoutEffect(() => {
    if (hasAsk) sizePad();
  }, [hasAsk, chat.length, feedback?.text, sizePad]);
  useEffect(() => {
    if (!hasAsk) return;
    const onScroll = () => {
      if (Date.now() < quiet.current) return;
      const fb = fbRef.current;
      if (!fb) return;
      const slotH = slotRef.current?.offsetHeight ?? 96;
      const bottom = fb.getBoundingClientRect().bottom + window.scrollY;
      const T = Math.min(chatTop(), Math.max(30, bottom - (window.innerHeight - slotH) + 30));
      const y = window.scrollY;
      setChatting((on) => {
        if (!on && y >= T) {
          setSawChat(true);
          return true;
        }
        if (on && y < Math.max(8, T - 80)) return false;
        return on;
      });
    };
    const onResize = () => sizePad();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    if (!nudged && !reducedMotion()) {
      nudged = true;
      const t1 = window.setTimeout(() => {
        quiet.current = Date.now() + 1600;
        window.scrollTo({ top: Math.min(120, chatTop()), behavior: "smooth" });
        window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 650);
      }, 700);
      return () => {
        window.clearTimeout(t1);
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
      };
    }
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [hasAsk, sizePad]);

  const ensureConv = async () => {
    if (conv.current) return conv.current;
    const m = await agentApi.models();
    if (!m.configured || !m.default) throw new Error("AI isn't set up yet. Pick a model in Settings → AI.");
    const c = await agentApi.create(m.default);
    conv.current = { id: c.id, model: m.default, primed: false };
    return conv.current;
  };

  const askSend = useCallback(async (q: string) => {
    if (!card || asking) return;
    setAsking(true);
    quiet.current = Date.now() + 900;
    setChat((m) => [...m, { me: true, text: q }, { text: "", typing: true }]);
    requestAnimationFrame(() => { sizePad(); glide(maxScroll()); });
    const setLast = (f: (m: ChatMsg) => ChatMsg) => setChat((all) => [...all.slice(0, -1), f(all[all.length - 1])]);
    try {
      const c = await ensureConv();
      let text = q;
      if (!c.primed) {
        // The first question carries the card, so the assistant knows what's being asked about.
        text = [
          "I'm in a study session and just answered this card. Answer my question about it briefly and plainly.",
          `Deck: ${card.deck}. Card type: ${card.type}.`,
          `Card: ${clip(card.view, 1500)}`,
          result ? `Answer key: ${clip(result.key, 1500)}` : "",
          result ? `My answer: ${clip(result.answer, 800)}` : "",
          result?.grade.verdict ? `Verdict: ${result.grade.verdict}.` : "",
          feedback?.text ? `Feedback I got: ${feedback.text}` : "",
          "",
          `My question: ${q}`,
        ].filter(Boolean).join("\n");
      }
      let acc = "";
      let failed = "";
      await agentApi.send(c.id, { text, attachments: attached ? [attached.id] : [], model: c.model, page: appPath() + location.search }, (e) => {
        if (e.type === "text") {
          acc += e.delta;
          setLast((m) => ({ ...m, text: acc }));
        } else if (e.type === "error") failed = e.error;
        else if (e.type === "done") {
          const content = e.message.content as { text?: string; error?: string };
          if (content.text) acc = content.text;
          if (content.error && !acc) failed = content.error;
        }
      });
      c.primed = true;
      setAttached(null);
      setLast(() => (failed && !acc ? { text: `Couldn't answer: ${failed}`, error: true } : { text: acc || "…" }));
    } catch (e) {
      setLast(() => ({ text: (e as Error).message, error: true }));
    } finally {
      setAsking(false);
      requestAnimationFrame(() => { sizePad(); glide(maxScroll()); });
    }
  }, [card, asking, attached, result, feedback?.text, sizePad]);

  const askAttach = useCallback(async (f: File) => {
    try {
      const c = await ensureConv();
      const meta = await agentApi.upload(c.id, f);
      setAttached({ id: meta.id, name: meta.name });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  const usedChips = new Set(chat.filter((m) => m.me).map((m) => m.text));
  const chips = (result?.grade.verdict === "correct" ? ["Explain it more simply", "Give me another example"] : ["What did I miss?", "Explain it more simply", "Give me another example"]).filter((c) => !usedChips.has(c));

  // ---------------------------------------------------------------- keys
  const onKey = useCallback((key: string) => {
    if (chatting) {
      if (key === "Escape") backToRating();
      return;
    }
    if (key === "Escape") return void setFocus(false);
    if (flipping) return;
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
  }, [phase, card, reveal, rate, result, undo, setAside, again, chatting, backToRating, flipping]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.repeat && (["u", "U", "=", "-", "@", "!"].includes(e.key) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"))) return;
      const t = e.target as HTMLElement;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === " " && t?.closest("button")) e.preventDefault();
      if (e.key === "Escape") return chatting ? backToRating() : focus ? setFocus(false) : navigate("/");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") return onKey("Mod+Enter");
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return onKey("Undo");
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === " ") e.preventDefault();
        onKey(e.key);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onKey, focus, chatting, backToRating]);

  const suggested = result?.grade.suggested ?? null;
  const total = counts ? counts.new + counts.learning + counts.review : 0;
  const done = counts?.doneToday ?? 0;
  // In focus mode the header and the card's badges go, and the bottom bar only shows when it has
  // something to press: not while grading, nor while a card that submits by itself keeps Check disabled.
  const idleBar = phase === "grading" || (phase === "answer" && !ready && card?.grader !== "self");
  const showBar = !bare || !idleBar;
  const verdictShown = card?.showVerdict !== false ? shownVerdict(result?.grade.verdict) : null;
  const slotSwap = useSwapIn(`${currentKey}:${phase === "result" ? "r" : "a"}`);
  const deckPath = crumbPath(card?.deck, scope.deck);
  const canAct = !!card && (phase === "answer" || phase === "result");

  const src = (c: StudyCard) => `/frame/${encodeURIComponent(c.type)}?v=${encodeURIComponent(c.typeVersion)}`;
  const renderCard = (c: StudyCard, key: string, live: boolean, isPaper: boolean, style?: React.CSSProperties) => (
    <CardStage
      key={key}
      ref={(el) => { if (el) cardEls.current.set(key, el); else cardEls.current.delete(key); }}
      paper={isPaper}
      style={style}
      className={cn(!live && "st-leaving")}
      eyebrow={!bare && <Eyebrow items={cardEyebrow(c, { ahead: scope.ahead, practice })} />}
      aside={live && !isPaper && phase === "result" && verdictShown ? <Verdict verdict={verdictShown} score={result?.grade.score} late={lateVerdict} /> : undefined}
      flip={flip?.key === key ? flip.side : "front"}
      back={isPaper && (twoFaced || flip?.key === key) ? (
        <CardFrame
          ref={live ? backFrame : undefined}
          src={src(c)}
          frameKey={`${key}:back`}
          view={c.view}
          autoFocus={false}
          onKey={live ? onKey : undefined}
          onSize={live ? (h) => backSized.current?.(h) : undefined}
          onError={live ? (m) => toast.error("Card error", { description: m }) : undefined}
        />
      ) : undefined}
    >
      <CardFrame
        ref={live ? frame : undefined}
        src={src(c)}
        frameKey={key}
        view={c.view}
        onSubmit={live ? onSubmit : undefined}
        onMorph={live ? setLateVerdict : undefined}
        onReady={live ? setReady : undefined}
        onKey={live ? onKey : undefined}
        onError={live ? (m) => toast.error("Card error", { description: m }) : undefined}
        fitScreen={live && bare}
        fitMargin={live && bare && phone && !showBar ? PHONE_FOCUS_STRIP : undefined}
      />
    </CardStage>
  );

  const stageCards: React.ReactNode[] = [];
  if (leaving) stageCards.push(renderCard(leaving.card, leaving.key, false, leaving.paper, { left: leaving.rect.left, top: leaving.rect.top, width: leaving.rect.width }));
  if (card && currentKey && currentKey !== leaving?.key && phase !== "done") stageCards.push(renderCard(card, currentKey, true, paper));

  const tallyTip = counts && (
    <span className="flex items-center gap-2.5 tabular">
      <Tooltip><TooltipTrigger asChild><span className="text-new">{counts.new}</span></TooltipTrigger><TooltipContent>New</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><span className="text-learn">{counts.learning}</span></TooltipTrigger><TooltipContent>Learning</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><span className="text-review">{counts.review}</span></TooltipTrigger><TooltipContent>Review</TooltipContent></Tooltip>
    </span>
  );

  return (
    <div
      className={cn("flex min-h-dvh w-full flex-col", showBar ? "pb-[calc(9.5rem+env(safe-area-inset-bottom))]" : "pb-6", bare && "pt-[env(safe-area-inset-top)]", bare && phone && !showBar && "pb-0", sk.on && "overflow-x-clip")}
    >
      {!bare && (
        <StudyTop title={title} crumb={deckPath} onBack={() => navigate("/")}>
          {card && phase !== "done" && <span className="st-tag max-md:hidden">{card.type}</span>}
          {counts && (
            <div className="st-prog">
              {total > 0 && (phone ? <Tally n={counts.new} l={counts.learning} r={counts.review} className="text-[12px]" /> : tallyTip)}
              <Track value={done + total ? done / (done + total) : 0} />
            </div>
          )}
          <div className="flex items-center gap-0.5">
            <IconButton label="Undo last rating" title={`Undo last rating (${modKey()} Z)`} disabled={phase === "loading" || phase === "grading"} onClick={undo}>
              <Undo2 className="size-5" strokeWidth={1.8} />
            </IconButton>
            {card && !phone && (
              <IconButton label="Edit card" className="phone:hidden" disabled={!canAct} onClick={() => navigate(`/browse?item=${encodeURIComponent(card.itemId)}`)}>
                <Pencil className="size-5" strokeWidth={1.8} />
              </IconButton>
            )}
            {phone ? (
              <IconButton label="Card actions" disabled={!canAct} onClick={() => setTools(true)}>
                <MoreHorizontal className="size-5" strokeWidth={1.8} />
              </IconButton>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="st-ib" aria-label="More" title="More" disabled={!canAct}>
                    <MoreHorizontal className="size-5" strokeWidth={1.8} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem onClick={() => setAside("bury", false)}><EyeOff />Bury this card<kbd className="ml-auto pl-4 text-xs opacity-60">-</kbd></DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAside("bury", true)}><EyeOff />Bury the whole note<kbd className="ml-auto pl-4 text-xs opacity-60">=</kbd></DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAside("suspend", false)}><Pause />Suspend this card<kbd className="ml-auto pl-4 text-xs opacity-60">@</kbd></DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAside("suspend", true)}><Pause />Suspend the whole note<kbd className="ml-auto pl-4 text-xs opacity-60">!</kbd></DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setFocus(true)}><Maximize2 />Focus on the card<kbd className="ml-auto pl-4 text-xs opacity-60">Esc leaves</kbd></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </StudyTop>
      )}

      {phase === "done" && (scope.placement ? <PlacementDone deck={scope.deck ?? ""} /> : <Done counts={counts} scope={scope} />)}

      {(stageCards.length > 0 || (card && phase !== "done")) && (
        <main ref={mainRef} style={phone ? sketchTransform(sk.view, mainRef.current) : undefined} className={cn("st-stage", bare && "p-0 sm:px-8", bare && !phone && "pt-4")}>
          <div className={cn("st-col", bare && "w-full max-w-3xl")}>
            {retry && phase === "answer" && <AnswerRetry hint={retry.hint} />}
            {stageCards}

            {card && phase === "result" && result && currentKey !== leaving?.key && (
              <section className={cn("flex flex-col gap-4", exiting && "st-fade-out")}>
                {paper && verdictShown && <div><Verdict verdict={verdictShown} score={result.grade.score} /></div>}
                {(result.grade.adaptive?.reason || (verdictShown && result.grade.grader.kind === "ai" && result.grade.grader.model)) && (
                  <div className="st-rise flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {result.grade.adaptive?.reason && <span>Picked for you: {result.grade.adaptive.reason}.</span>}
                    {verdictShown && result.grade.grader.kind === "ai" && result.grade.grader.model && <span className="truncate">Graded by {result.grade.grader.model.split("/").pop()}</span>}
                  </div>
                )}
                {feedback?.loading && (
                  <div className="st-rise flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {fun ? "Minimi is writing…" : "Writing feedback…"}</div>
                )}
                {feedback?.text && <Feedback ref={fbRef} text={feedback.text} fun={fun} />}
                {feedback?.error && <div className="text-sm text-danger">Feedback failed: {feedback.error}</div>}
                {hasAsk && <Thread msgs={chat} fun={fun} />}
                {(!feedback && attemptId && card.showVerdict !== false) || card.generated || card.source ? (
                  <div className="st-rise flex flex-wrap items-center gap-2">
                    {!feedback && attemptId && card.showVerdict !== false && (
                      <button className="st-chip inline-flex items-center gap-1.5" onClick={() => askFeedback(attemptId)}>
                        <MessageSquareText className="size-4" /> {card.grader === "self" ? "Explain this card" : "Explain my answer"}
                      </button>
                    )}
                    {card.generated && (
                      <button className="st-chip inline-flex items-center gap-1.5" onClick={anotherVariant}>
                        <RotateCcw className="size-4" /> Try another variant
                      </button>
                    )}
                    {card.source && <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">Source: {card.source}</span>}
                  </div>
                ) : null}
                {hasAsk && <div ref={padRef} aria-hidden />}
              </section>
            )}
          </div>
        </main>
      )}

      {bare && (
        <button
          onClick={() => setFocus(false)}
          aria-label="Leave focus mode"
          title="Leave focus mode (Esc)"
          className={cn(
            "fixed right-[max(1rem,env(safe-area-inset-right))] z-30 flex size-10 items-center justify-center rounded-full border bg-background/80 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground",
            showBar ? "bottom-[calc(6.5rem+env(safe-area-inset-bottom))] sm:bottom-[calc(7.5rem+env(safe-area-inset-bottom))]" : phone ? "bottom-[max(0.5rem,env(safe-area-inset-bottom))]" : "bottom-[max(1rem,env(safe-area-inset-bottom))]",
          )}
        >
          <Minimize2 className="size-4" />
        </button>
      )}
      {card && showBar && (phase === "answer" || phase === "grading" || phase === "result" || (phase === "loading" && exiting)) && (
        <Slot ref={(el) => { slotRef.current = el; (slotSwap as React.MutableRefObject<HTMLDivElement | null>).current = el; }} className={cn(exiting && "leaving")}>
          {hasAsk && !sawChat && !chatting && <AskTab fun={fun} onClick={openChat} />}
          {phone && sk.on ? (
            <div className="st-row"><SketchBar sk={sk} /></div>
          ) : hasAsk && chatting ? (
            <Composer fun={fun} chips={chips} busy={asking} onSend={askSend} onAttach={askAttach} attached={attached?.name} onBack={backToRating} inputRef={askInput} />
          ) : phase !== "result" ? (
            <div className="st-row">
              {phone && (
                <div className="relative shrink-0">
                  {plus && (
                    <div className="absolute bottom-[calc(100%+0.6rem)] left-0 z-20 w-60 rounded-[1.6rem] border bg-card p-1.5 shadow-2xl">
                      {[
                        { label: "Scratchpad", icon: Pencil, hl: true, onClick: () => { setPlus(false); sk.setOn(true); } },
                        { label: "Previous card", icon: ArrowLeftToLine, onClick: () => { setPlus(false); undo(); } },
                        { label: "Suspend", icon: Pause, onClick: () => { setPlus(false); setAside("suspend", false); } },
                        { label: "More actions", icon: MoreHorizontal, onClick: () => { setPlus(false); setTools(true); } },
                      ].map((a) => (
                        <button key={a.label} onClick={a.onClick} className={cn("flex h-[2.9rem] w-full items-center gap-3 rounded-full px-4 text-[15px] active:bg-accent", a.hl ? "bg-highlight/10 text-highlight" : "text-foreground/85")}>
                          <a.icon className="size-5" />{a.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <button onClick={() => setPlus((v) => !v)} disabled={phase === "grading"} aria-label={plus ? "Close" : "More"} aria-expanded={plus} className="st-round disabled:opacity-40">
                    {plus ? <XIcon className="size-5" /> : <Plus className="size-5" />}
                  </button>
                </div>
              )}
              <button className="st-pri" id="study-main" disabled={(phase === "grading" && !flipping) || phase === "loading" || (!ready && card.grader !== "self")} onClick={reveal}>
                {phase === "grading" && !flipping ? <><Loader2 className="size-4 animate-spin" /> Checking…</> : card.grader === "self" ? <>Show answer <kbd>Space</kbd></> : <>Check <kbd>{modKey()} ↵</kbd></>}
              </button>
            </div>
          ) : !card.scheduler.ratings ? (
            <div className="st-row">
              <button className="st-sec" onClick={again}>
                <RotateCcw className="size-4" /> Go again <kbd>R</kbd>
              </button>
              <button className="st-pri" onClick={() => rate(0)}>
                Next
                <span className="text-sm font-normal opacity-80">{practice ? "practice" : card.scheduler.next ? (new Date(card.scheduler.next).getTime() <= Date.now() + 60_000 ? "again today" : `back ${relative(card.scheduler.next)}`) : ""}</span>
                <kbd>Space</kbd>
              </button>
            </div>
          ) : (
            <>
              <Suggestion suggested={suggested} />
              <Ratings card={card} selected={(suggested ?? 3) as Rating} practice={practice} onRate={rate} />
            </>
          )}
          {phase === "result" && !card.scheduler.ratings && !chatting && <div className="st-sugg st-kbd">Your result is saved either way.</div>}
        </Slot>
      )}
      {phone && card && <SketchLayer sk={sk} />}
      {phone && plus && <div className="fixed inset-0 z-[9] bg-background/60" onClick={() => setPlus(false)} />}
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
            [
              { label: "Focus on the card", icon: Maximize2, hint: "hide everything else", onClick: () => setFocus(true) },
              { label: "Edit card", icon: Pencil, onClick: () => navigate(`/browse?item=${encodeURIComponent(card.itemId)}`) },
            ],
          ]}
        />
      )}
      {phase === "loading" && !card && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
      )}
    </div>
  );
}

function PlacementDone({ deck }: { deck: string }) {
  const [summary, setSummary] = useState<LearnerSummary | null>(null);
  useEffect(() => {
    api.skills(deck).then(setSummary, () => setSummary(null));
  }, [deck]);
  const skills = summary?.adaptive ? summary.skills.filter((s) => s.placement) : [];
  return (
    <div className="st-rise flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <h2 className="st-serif text-4xl font-semibold tracking-tight sm:text-[2.6rem]">Placement done</h2>
      {skills.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground">
          {skills.map((s) => (
            <li key={s.skill}>
              <span className="font-medium text-foreground">{s.skill}</span>: you start at {s.placement!.frontier}
            </li>
          ))}
        </ul>
      ) : (
        <p className="max-w-sm text-muted-foreground">There was nothing to place: the deck has no new cards for it.</p>
      )}
      <p className="max-w-sm text-sm text-muted-foreground">Earlier cards come up as quick checks. Right on first sight sends them weeks away.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <button className="st-sec" onClick={() => navigate(`/deck?${new URLSearchParams({ name: deck })}`)}>Back to the deck</button>
        <button className="st-pri" onClick={() => navigate(`/study?${new URLSearchParams({ deck })}`)}>Start studying</button>
      </div>
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
    <div className="st-rise flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <h2 className="st-serif text-4xl font-semibold tracking-tight sm:text-[2.9rem]">{scope.ahead ? "Nothing left to study" : "All done for now"}</h2>
      <p className="max-w-sm text-muted-foreground">
        {counts?.doneToday ? `${counts.doneToday} reviews today. ` : ""}
        {scope.ahead ? "There are no cards in this deck." : counts?.nextDue ? `The next card comes back ${relative(counts.nextDue)}.` : "Nothing else is scheduled."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <button className="st-sec" onClick={() => navigate("/")}>Back to the library</button>
        {!scope.ahead && counts?.nextDue && (
          <button className="st-pri" onClick={() => navigate(aheadUrl())} title="Review cards before they're due. FSRS counts an early review for less.">
            <FastForward className="size-4" />Practice ahead
          </button>
        )}
      </div>
    </div>
  );
}
