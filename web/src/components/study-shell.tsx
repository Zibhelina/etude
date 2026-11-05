// The study screen's fixed shell (Etude 3), shared by Study and Watch: the header, the card on its stage,
// the result layer (verdict, Minimi's feedback, the follow-up chat) and the bottom strip whose one main
// button changes its verb. Styles are the `st-*` block in index.css.
import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Plus, SendHorizontal } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { humanInterval, RATING_LABEL, type Rating, type StudyCard } from "@/lib/api";
import { cn } from "@/lib/utils";
import face from "@/assets/minimi/face.webp";
import sitHead from "@/assets/minimi/sit-head.webp";
import sitLegL from "@/assets/minimi/sit-legL.webp";
import sitLegR from "@/assets/minimi/sit-legR.webp";
import sitTorso from "@/assets/minimi/sit-torso.webp";

export const minimiFace = face;
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const modKey = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl");

/** "Etude Showcase / Recall": the deck as the back button, the subdeck path beside it. */
export function StudyTop({ title, crumb, onBack, children }: { title: string; crumb?: string; onBack(): void; children?: ReactNode }) {
  return (
    <header className="st-top">
      <button className="st-back" onClick={onBack} title="Back to the library" aria-label={`Back: ${title}`}>
        <ChevronLeft className="size-5" strokeWidth={1.8} />
        <span>{title}</span>
      </button>
      {crumb && <span className="st-crumb max-md:hidden">/ {crumb}</span>}
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

/** The card's place on the stage. Self-graded cards sit on paper with the deck behind them. */
export const CardStage = forwardRef<HTMLDivElement, { paper: boolean; eyebrow?: ReactNode; aside?: ReactNode; enter?: boolean; style?: React.CSSProperties; className?: string; children: ReactNode }>(function CardStage(
  { paper, eyebrow, aside, enter = true, style, className, children },
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
      <div className="st-paper" data-paper>
        {head}
        <div className="st-frame">{children}</div>
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

export function Verdict({ verdict, score, prefix }: { verdict?: string | null; score?: number | null; prefix?: string }) {
  const v = verdict ? VERDICT[verdict] : null;
  if (!v) return null;
  return (
    <span className={cn("st-verdict", v.cls)} role="status">
      <span aria-hidden>{v.mark}</span>
      {prefix}
      {v.label}
      {score != null && verdict === "partial" && <span className="tabular font-medium opacity-80">{Math.round(score * 100)}%</span>}
    </span>
  );
}

/** Minimi sitting on the feedback bubble: two poses at 1 fps (head tilts, that side's leg comes forward). */
function SittingMinimi() {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const t = window.setInterval(() => setF((x) => x ^ 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className={cn("st-sit", f ? "p1" : "p0")} aria-hidden>
      <img className="lL" src={sitLegL} alt="" />
      <img className="lR" src={sitLegR} alt="" />
      <img className="hd" src={sitHead} alt="" />
      <img src={sitTorso} alt="" />
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
            {fun && <img src={face} alt="" />}
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
      {fun ? <><img src={face} alt="" />Ask Minimi</> : <span className="pl-2">Ask about it</span>}
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

/** The bottom strip: same background as the page, no divider; a short fade above it. */
export const Slot = forwardRef<HTMLDivElement, { className?: string; children: ReactNode }>(function Slot({ className, children }, ref) {
  return (
    <footer ref={ref} className={cn("st-slot", className)}>
      {children}
    </footer>
  );
});

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
