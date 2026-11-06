// Minimi's mini chat (Fun mode, desktop and iPad): no panel, just speech balloons floating beside him wherever he
// sits. His replies sit on the left, yours on the right, no tails (João's pick). It is
// Ask Etude, the same conversation as the side panel; ⤢ moves it there.
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Maximize2, Plus, Square, SquarePen, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttachmentChip, BubbleContext, LiveView, MessageView, openAiSettings, useAgentChat } from "@/components/agent-panel";
import { isNativeApp } from "@/lib/platform";
import { cn } from "@/lib/utils";

const NATIVE_ATTACH = isNativeApp() ? "image/*,application/pdf,text/*,.md,.csv,.json,.apkg" : undefined;
const GAP = 18;
const EDGE = 8;
/** Room above the balloons for the round buttons. */
const CTRL = 54;

const CHIPS: { label: string; file?: boolean }[] = [
  { label: "What should I review today?" },
  { label: "Make a deck from a file", file: true },
  { label: "Explain my hardest card" },
];

/** Puts the card beside Minimi (on whichever side has room) and keeps it there while he moves or it grows. */
function usePlaceBesideMinimi(card: React.RefObject<HTMLDivElement | null>) {
  const [place, setPlace] = useState<{ left: number; top: number; flip: boolean } | null>(null);
  useLayoutEffect(() => {
    const run = () => {
      const c = card.current;
      const m = document.querySelector<HTMLElement>("[data-minimi]");
      if (!c) return;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const cw = c.offsetWidth;
      const ch = c.offsetHeight;
      if (!m) return setPlace({ left: vw - cw - 24, top: vh - ch - 24, flip: true });
      const r = m.getBoundingClientRect();
      const flip = r.left + r.width / 2 > vw / 2;
      const left = Math.max(EDGE, Math.min(vw - cw - EDGE, flip ? r.left - cw - GAP : r.right + GAP));
      const top = Math.max(CTRL, Math.min(vh - ch - EDGE, r.bottom - ch - 6));
      setPlace((p) => (p && p.left === left && p.top === top && p.flip === flip ? p : { left, top, flip }));
    };
    run();
    const ro = new ResizeObserver(run);
    if (card.current) ro.observe(card.current);
    ro.observe(document.documentElement);
    const m = document.querySelector("[data-minimi]");
    const mo = new MutationObserver(run);
    if (m) mo.observe(m, { attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", run);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", run);
    };
  }, [card]);
  return place;
}

function IconButton({ label, tip, onClick, disabled, children }: { label: string; tip?: React.ReactNode; onClick(): void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="mchat-round flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-ring hover:text-foreground focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[18px]">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function MinimiChat({ onClose, onExpand, onChanged }: { onClose(): void; onExpand(): void; onChanged(final: boolean): void }) {
  const chat = useAgentChat({ onClose, onChanged, takeAsk: false });
  const { conv, models, text, setText, atts, setAtts, live, busy, scroller, input, fileInput, stick, openConv, addFiles, send, stop, answer, undo, notConfigured, messages, empty, canSend, suggest } = chat;
  const card = useRef<HTMLDivElement>(null);
  const place = usePlaceBesideMinimi(card);
  const [scrolled, setScrolled] = useState(false);

  return (
    <div
      ref={card}
      role="dialog"
      aria-label="Ask Minimi"
      data-minimi-chat
      className={cn("mchat fixed z-40 flex w-[320px] max-w-[calc(100vw-16px)] flex-col text-foreground", place ? "visible" : "invisible", place && (place.flip ? "is-flip" : "is-right"))}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: `min(520px, calc(100dvh - ${CTRL + EDGE}px))` }}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {/* backdrop-filter set inline: the CSS minifier keeps only the -webkit- copy, which Chrome ignores. */}
      <div className="mchat-veil" aria-hidden style={{ backdropFilter: "blur(14px) saturate(0.8)" }} />
      <div className="mchat-ctl absolute -top-[52px] right-0 flex gap-2">
        {!empty && (
          <IconButton label="New chat" disabled={busy || !conv} onClick={() => openConv(null)}>
            <SquarePen />
          </IconButton>
        )}
        <IconButton label="Open in the side panel" onClick={onExpand}>
          <Maximize2 />
        </IconButton>
        <IconButton label="Close" tip={<>Close <span className="opacity-60">Esc</span></>} onClick={onClose}>
          <X />
        </IconButton>
      </div>

      <BubbleContext.Provider value>
        <div
          ref={scroller}
          className={cn("mchat-log flex min-h-0 flex-1 flex-col overflow-y-auto", scrolled && "is-scrolled")}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setScrolled(el.scrollTop > 2);
          }}
        >
          {notConfigured ? (
            <div className="flex flex-col items-start gap-2.5">
              <div data-mbub className="mchat-b max-w-[88%] px-[14px] py-2.5 text-[14.5px] leading-[1.42]">
                Hm. I need a brain first. Connect a model in Settings → AI and I'm all yours.
              </div>
              <button type="button" onClick={openAiSettings} className="mchat-chip self-end">
                Settings → AI
              </button>
            </div>
          ) : empty ? (
            <div data-mbub className="mchat-b max-w-[88%] self-start px-[14px] py-2.5 text-[14.5px] leading-[1.42]">
              Hm? What do you want: a card explained, new cards made, or a quick quiz on what's due?
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {messages.map((m, i) => (
                <MessageView key={m.id} m={m} conv={conv!.id} last={i === messages.length - 1 && !live} groups={models?.groups} onUndo={() => undo(m)} />
              ))}
              {live && (
                <>
                  {live.user && <MessageView m={live.user} conv={conv?.id ?? ""} />}
                  <LiveView live={live} onAnswer={answer} />
                </>
              )}
            </div>
          )}
        </div>
      </BubbleContext.Provider>

      {empty && !notConfigured && (
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5 pt-2.5">
          {CHIPS.map((c) => (
            <button key={c.label} type="button" className="mchat-chip" onClick={() => (c.file ? fileInput.current?.click() : suggest(c.label))}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="shrink-0 pt-4">
        {atts.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 pb-2">
            {atts.map((a) => (
              <AttachmentChip key={"key" in a ? a.key : a.id} a={a} conv={conv?.id} onRemove={"id" in a ? () => setAtts((x) => x.filter((y) => !("id" in y) || y.id !== a.id)) : undefined} />
            ))}
          </div>
        )}
        <div className="mchat-pill flex items-end gap-1 rounded-[22px] p-1" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
          <input ref={fileInput} type="file" multiple hidden accept={NATIVE_ATTACH} onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
          <button type="button" aria-label="Attach files" title="Attach images, PDFs, text or .apkg" disabled={!!notConfigured} onClick={() => fileInput.current?.click()} className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-ring hover:bg-accent hover:text-foreground focus-visible:outline-2 disabled:opacity-40">
            <Plus className="size-[18px]" strokeWidth={2.2} />
          </button>
          <textarea
            ref={input}
            value={text}
            rows={1}
            disabled={!!notConfigured}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            placeholder="Ask Minimi"
            aria-label="Message"
            className="block max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-[20px] text-foreground outline-none placeholder:text-muted-foreground/70 [field-sizing:content]"
          />
          {busy ? (
            <button type="button" aria-label="Stop" onClick={stop} className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background outline-ring hover:opacity-85 focus-visible:outline-2">
              <Square className="size-2.5 fill-current" />
            </button>
          ) : (
            <button type="button" aria-label="Send" disabled={!canSend} onClick={send} className={cn("grid size-8 shrink-0 place-items-center rounded-full transition-all outline-ring focus-visible:outline-2", canSend ? "bg-primary text-primary-foreground" : "pointer-events-none scale-75 opacity-0")}>
              <ArrowUp className="size-[18px]" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
