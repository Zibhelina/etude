// The study screen's fixed shell (Etude 3), shared by Study and Watch: the header, the card on its stage,
// the result layer (verdict, Minimi's feedback, the follow-up chat) and the bottom strip whose one main
// button changes its verb. Styles are the `st-*` block in index.css.
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, SendHorizontal } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { humanInterval, RATING_LABEL, type Rating, type StudyCard } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CardFrameHandle, CardResult } from "@/components/card-frame";
import { faceSrc, minimiFaceId, useMinimiFace } from "@/lib/minimi-face";
import sitBlink from "@/assets/minimi/sit-up-blink.webp";
import sitLeft from "@/assets/minimi/sit-up-L.webp";
import sitLegL from "@/assets/minimi/sit-legL.webp";
import sitLegR from "@/assets/minimi/sit-legR.webp";
import sitNeutral from "@/assets/minimi/sit-up-n.webp";
import sitRight from "@/assets/minimi/sit-up-R.webp";

/** The face Minimi wears right now (a snapshot; components that need live updates use useMinimiFace). */
export const minimiFace = () => faceSrc(minimiFaceId());
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const modKey = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl");

/** Where the card sits below what you're studying: the card's deck with the studied deck's path removed.
 *  Studying "University::CMPT 371", a card in "University::CMPT 371::Week 1::01 Delay" gives ["Week 1", "01 Delay"];
 *  studying everything (or a search) gives the whole path. */
export function crumbPath(cardDeck: string | undefined, scopeDeck?: string): string[] {
  if (!cardDeck) return [];
  const parts = cardDeck.split("::");
  if (!scopeDeck) return parts;
  const base = scopeDeck.split("::");
  const inside = base.every((b, i) => parts[i] === b);
  return inside ? parts.slice(base.length) : parts;
}

/** "Etude Showcase › Week 1 › Recall": the studied deck as the back button, the card's subdeck path beside it. */
export function StudyTop({ title, crumb, onBack, children }: { title: string; crumb?: string[]; onBack(): void; children?: ReactNode }) {
  return (
    <header className="st-top">
      <button className="st-back" onClick={onBack} title="Back to the library" aria-label={`Back: ${title}`}>
        <ChevronLeft className="size-5" strokeWidth={1.8} />
        <span>{title}</span>
      </button>
      {!!crumb?.length && (
        <span className="st-crumb max-md:hidden" title={crumb.join(" › ")}>
          {crumb.length > 1 && (
            <span className="st-crumb-seg st-crumb-more" aria-hidden>
              <ChevronRight className="st-crumb-sep" strokeWidth={1.8} />
              <span className="st-crumb-txt">…</span>
            </span>
          )}
          {crumb.map((c, i) => (
            <span key={i} className={cn("st-crumb-seg", i === crumb.length - 1 && "st-crumb-last")}>
              <ChevronRight className="st-crumb-sep" strokeWidth={1.8} aria-hidden />
              <span className="st-crumb-txt">{c}</span>
            </span>
          ))}
        </span>
      )}
      <div className="flex-1" />
      {children}
    </header>
  );
}

export function Track({ value }: { value: number }) {
  return (
    <span className="st-track max-md:hidden" aria-hidden>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}

export function IconButton({ label, onClick, disabled, children, className, ...rest }: { label: string; onClick?(): void; disabled?: boolean; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={cn("st-ib", className)} onClick={onClick} disabled={disabled} aria-label={label} title={rest.title ?? label}>
      {children}
    </button>
  );
}

/** Which side of a self-graded card faces you: the question, turning over, or the answer (settled). */
export type FlipSide = "front" | "turning" | "back";

/** The card's place on the stage. Self-graded cards sit on paper with the deck behind them; with a `back`
 *  they're two-faced, and `flip` turns them over to it. */
export const CardStage = forwardRef<HTMLDivElement, { paper: boolean; eyebrow?: ReactNode; aside?: ReactNode; enter?: boolean; style?: React.CSSProperties; className?: string; children: ReactNode; back?: ReactNode; flip?: FlipSide }>(function CardStage(
  { paper, eyebrow, aside, enter = true, style, className, children, back, flip = "front" },
  ref,
) {
  const head = (eyebrow || aside) && (
    <div className="flex items-center justify-between gap-3">
      <div className="st-eyebrow">{eyebrow}</div>
      {aside}
    </div>
  );
  if (!paper) {
    return (
      <div ref={ref} style={style} className={cn("st-bare-card flex flex-col gap-4", enter && "st-in", className)}>
        {head}
        <div className="st-frame">{children}</div>
      </div>
    );
  }
  return (
    <div ref={ref} style={style} className={cn("st-stack", enter && "st-in", className)}>
      <div className="st-sheet s1" />
      <div className="st-sheet s2" />
      <div className={cn("st-flip", flip !== "front" && "flipped", flip === "back" && "settled")} data-paper>
        <div className="st-paper st-face" inert={flip === "back" || undefined}>
          {head && <div className="st-head">{head}</div>}
          <div className="st-frame">{children}</div>
        </div>
        {back && (
          <div className="st-paper st-face st-backface" inert={flip !== "back" || undefined} aria-hidden={flip !== "back" || undefined}>
            {head && <div className="st-head">{head}</div>}
            <div className="st-frame">{back}</div>
          </div>
        )}
      </div>
    </div>
  );
});

/** "NEW · BASIC · VARIANT": a dot-separated eyebrow; the first item is ink, the rest muted. */
export function Eyebrow({ items }: { items: { text: string; strong?: boolean; hl?: boolean; title?: string }[] }) {
  return (
    <>
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-2" title={it.title}>
          {i > 0 && <span aria-hidden>·</span>}
          {it.strong ? <b>{it.text}</b> : <span className={it.hl ? "hl" : undefined}>{it.text}</span>}
        </span>
      ))}
    </>
  );
}

export function cardEyebrow(card: StudyCard, extra: { ahead?: boolean; practice?: boolean } = {}) {
  const items: { text: string; strong?: boolean; hl?: boolean; title?: string }[] = [];
  if (card.state === 0) items.push({ text: "New", strong: true });
  items.push({ text: card.type });
  if (card.scheduler.id !== "fsrs") items.push({ text: card.scheduler.name });
  if (card.generated) items.push({ text: "Variant", title: "Generated: the numbers change every review" });
  if (extra.ahead) items.push({ text: "Practicing ahead" });
  if (card.placement) items.push({ text: "Finding your level", hl: true });
  if (card.quickCheck) items.push({ text: "Quick check", title: "Your placement suggests you know this. Right on first sight sends it weeks away." });
  if (extra.practice) items.push({ text: "Practice, not scheduled", hl: true });
  return items;
}

const VERDICT: Record<string, { label: string; cls: string; mark: string }> = {
  correct: { label: "Correct", cls: "ok", mark: "✓" },
  partial: { label: "Partly right", cls: "mid", mark: "~" },
  incorrect: { label: "Not quite", cls: "no", mark: "×" },
};

/** The grade's verdict when it's one the shell shows (correct, partial, incorrect), else null. */
export const shownVerdict = (v: string | null | undefined) => (v && VERDICT[v] ? v : null);

/** `late`: the card's own pieces are still clearing (the morph reported some leaving), so it pops a beat later. */
export function Verdict({ verdict, score, prefix, late }: { verdict?: string | null; score?: number | null; prefix?: string; late?: boolean }) {
  const v = verdict ? VERDICT[verdict] : null;
  if (!v) return null;
  return (
    <span className={cn("st-verdict", v.cls, late && "late")} role="status">
      <span aria-hidden>{v.mark}</span>
      {prefix}
      {v.label}
      {score != null && verdict === "partial" && <span className="tabular font-medium opacity-80">{Math.round(score * 100)}%</span>}
    </span>
  );
}

/** Minimi sitting on the feedback bubble: four drawn upper-body frames (neutral, blink, looking left,
 *  looking right) swap instantly on a 4.8 s loop while his hind legs swing; CSS only (`st-sit`). */
function SittingMinimi() {
  return (
    <div className="st-sit" aria-hidden>
      <div className="up">
        <img className="fn" src={sitNeutral} alt="" />
        <img className="fk" src={sitBlink} alt="" />
        <img className="fL" src={sitLeft} alt="" />
        <img className="fR" src={sitRight} alt="" />
      </div>
      <img className="lL" src={sitLegL} alt="" />
      <img className="lR" src={sitLegR} alt="" />
    </div>
  );
}

/** The grader's feedback: from Minimi's mouth in Fun mode, a plain labelled message otherwise. */
export const Feedback = forwardRef<HTMLDivElement, { text: string; fun: boolean; label?: string }>(function Feedback({ text, fun, label }, ref) {
  return (
    <div ref={ref} className={cn("st-fb st-rise", fun && "sit")}>
      {fun && <SittingMinimi />}
      <div className="st-msg">
        <div className={cn("st-who", fun && "st-mini")}>{fun ? "Minimi" : (label ?? "Feedback")}</div>
        <Markdown className="prose-etude">{text}</Markdown>
      </div>
    </div>
  );
});

export interface ChatMsg {
  me?: boolean;
  text: string;
  typing?: boolean;
  error?: boolean;
}

export function Thread({ msgs, fun }: { msgs: ChatMsg[]; fun: boolean }) {
  if (!msgs.length) return null;
  return (
    <div className="st-thread">
      {msgs.map((m, i) =>
        m.me ? (
          <div key={i} className="st-me st-rise">{m.text}</div>
        ) : (
          <div key={i} className={cn("st-rise", fun ? "st-npc" : "")}>
            {fun && <img src={faceSrc(minimiFaceId())} alt="" />}
            {fun && <div className="st-who st-mini m-0">Minimi</div>}
            <div className={cn("st-msg", m.error && "text-danger")}>
              {m.typing && !m.text ? <span className="st-dots" aria-label="Writing"><i /><i /><i /></span> : <Markdown className="prose-etude">{m.text}</Markdown>}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/** The pill reply field: attach on the left, the send circle turns green once there's text. */
export function Composer({ fun, chips, busy, onSend, onAttach, attached, onBack, inputRef }: {
  fun: boolean;
  chips: string[];
  busy?: boolean;
  onSend(text: string): void;
  onAttach?(file: File): void;
  attached?: string | null;
  onBack(): void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState("");
  const send = (t: string) => {
    const v = t.trim();
    if (!v || busy) return;
    onSend(v);
    setText("");
  };
  return (
    <div className="st-composer">
      {chips.length > 0 && (
        <div className="st-chips">
          {chips.map((c) => (
            <button key={c} className="st-chip" onClick={() => send(c)} disabled={busy}>{c}</button>
          ))}
        </div>
      )}
      <form className="st-pill" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        {onAttach && (
          <label className="attach" title={attached ? `Attached: ${attached}` : "Attach a photo or file"}>
            <Plus className={cn("size-5", attached && "text-primary")} strokeWidth={2} />
            <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(f); e.target.value = ""; }} />
          </label>
        )}
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onBack(); } }}
          placeholder={fun ? "Ask Minimi about your answer…" : "Ask about your answer…"}
          aria-label="Ask about your answer"
          autoComplete="off"
        />
        <button type="submit" className={cn("send", text.trim() && "go")} title="Send" aria-label="Send" disabled={busy}>
          <SendHorizontal className="size-4" strokeWidth={2} />
        </button>
      </form>
      <button className="st-backrate" onClick={onBack}>Back to rating</button>
    </div>
  );
}

export function AskTab({ fun, onClick }: { fun: boolean; onClick(): void }) {
  return (
    <button className="st-docktab" onClick={onClick}>
      {fun ? <><img src={faceSrc(minimiFaceId())} alt="" />Ask Minimi</> : <span className="pl-2">Ask about it</span>}
      <ChevronDown className="size-4" strokeWidth={2.2} />
    </button>
  );
}

/** Rating style A: outlined keys with the real interval, a ring in the colour of the highlighted one. */
export function Ratings({ card, selected, practice, onRate }: { card: StudyCard; selected: Rating; practice?: boolean; onRate(r: Rating): void }) {
  return (
    <div className="st-rt" role="group" aria-label="Rate this card">
      {([1, 2, 3, 4] as Rating[]).map((r) => (
        <button key={r} className={cn("st-rb", `r${r}`, selected === r && "sel")} onClick={() => onRate(r)} aria-keyshortcuts={String(r)}>
          <span className="nm">{RATING_LABEL[r]}</span>
          <small>{practice ? "practice" : humanInterval(card.intervals[r])}</small>
          <kbd>{r}</kbd>
        </button>
      ))}
    </div>
  );
}

export function Suggestion({ suggested, extra }: { suggested: Rating | null; extra?: ReactNode }) {
  return (
    <div className="st-sugg">
      <span>
        {suggested ? <>Etude suggests <b>{RATING_LABEL[suggested]}</b></> : "How did it go?"}
        <span className="st-kbd">&nbsp;· Space picks the highlighted one</span>
        {extra}
      </span>
    </div>
  );
}

/** Turns a two-faced card (CardStage with a `back`) over to its back: the result goes on the back face first,
 *  then one continuous turn with the height easing to the back's. `sized` resolves once the back reported its
 *  new height; `setSide` must render synchronously (flushSync). Resolves false if there was nothing to turn. */
export async function turnOver(stage: HTMLElement | null | undefined, back: CardFrameHandle | null, res: CardResult, sized: () => Promise<void>, setSide: (side: FlipSide) => void, focus = true): Promise<boolean> {
  const el = stage?.querySelector<HTMLElement>(".st-flip");
  const fr = el?.firstElementChild as HTMLElement | null | undefined;
  const bk = el?.querySelector<HTMLElement>(".st-backface");
  if (!el || !fr || !bk || !back) return false;
  const ready = sized();
  back.showResult(res, { morph: false });
  await ready;
  await new Promise((ok) => requestAnimationFrame(ok));
  // The card may still be settling in from the deck; the turn starts from where it is.
  el.getAnimations().forEach((a) => a.cancel());
  el.style.height = `${fr.offsetHeight}px`;
  void el.offsetWidth;
  setSide("turning");
  el.style.height = `${Math.max(bk.offsetHeight, fr.offsetHeight * 0.6)}px`;
  await new Promise((ok) => setTimeout(ok, FLIP_MS));
  setSide("back");
  el.style.height = "";
  if (focus) back.focus();
  return true;
}
export const FLIP_MS = 720;

/** Sends a card off the stage after it's done: paper is tossed to the left with a turn, a bare card slides
 *  away; both fade quickly (as in design round 06). `dir` -1 sends it to the right (going back in Watch). */
export function flyOff(el: HTMLElement, paper: boolean, dir: 1 | -1 = 1): Animation {
  const target = paper ? el.querySelector<HTMLElement>("[data-paper]") ?? el : el;
  const to = paper ? `translate(${-118 * dir}%,-18px) rotate(${-8 * dir}deg)` : `translateX(${-40 * dir}%)`;
  const move = target.animate([{ transform: "none" }, { transform: to }], { duration: 480, easing: "cubic-bezier(.45,0,.7,1)", fill: "forwards" });
  target.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: 60, easing: "ease-in", fill: "forwards" });
  el.querySelectorAll<HTMLElement>(".st-sheet").forEach((s) => s.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }));
  return move;
}

/** The bottom strip: same background as the page, no divider; a short fade above it. */
export const Slot = forwardRef<HTMLDivElement, { className?: string; children: ReactNode }>(function Slot({ className, children }, ref) {
  return (
    <footer ref={ref} className={cn("st-slot", className)}>
      {children}
    </footer>
  );
});

/** Keeps the card from jumping when the column around it changes (the result appearing under it re-centres
 *  the column): call the returned `mark()` right before such a state change, and after that render the card
 *  glides from where it was. */
export function useGlide(getEl: () => HTMLElement | null | undefined) {
  const from = useRef<{ el: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const f = from.current;
    if (!f) return;
    from.current = null;
    if (!f.el.isConnected || reducedMotion()) return;
    const dy = f.top - (f.el.getBoundingClientRect().top + window.scrollY);
    if (Math.abs(dy) > 1) f.el.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], { duration: 460, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
  return () => {
    const el = getEl();
    if (el && !from.current) from.current = { el, top: el.getBoundingClientRect().top + window.scrollY };
  };
}

/** Replays the strip's entrance whenever `k` changes (a new step: answer → result → next card). */
export function useSwapIn(k: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current) { first.current = false; return; }
    el.classList.remove("swapin");
    void el.offsetWidth;
    el.classList.add("swapin");
  }, [k]);
  return ref;
}
