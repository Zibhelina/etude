// Minimi's mini chat (Fun mode, desktop and iPad): no panel, just speech balloons floating beside him wherever he
// sits. His replies sit on the left, yours on the right, no tails (compact style). It is
// Ask Etude, the same conversation as the side panel; ⤢ moves it there.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, SquarePen, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RichContext } from "@/components/agent-rich";
import { Composer, LiveView, MessageView, YouContext, askName, openAiSettings, useAgentChat } from "@/components/agent-panel";
import { useFunMode } from "@/lib/fun";
import { MINIMI_PROFILE_ID } from "@/lib/agent-profiles";
import { cn } from "@/lib/utils";

const GAP = 18;
const EDGE = 8;
/** Room above the balloons for the round buttons. */
const CTRL = 40;

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
        <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-ring hover:bg-accent hover:text-foreground focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[15px]">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function MinimiChat({ onClose, onExpand, onChanged, onProfile }: { onClose(): void; onExpand(): void; onChanged(final: boolean): void; onProfile?(id: string | null): void }) {
  const chat = useAgentChat({ onClose, onChanged, takeAsk: false });
  // The corner shows whoever this chat is with, while it's open (App.tsx).
  useEffect(() => onProfile?.(chat.profile.id), [chat.profile.id]);
  const { conv, models, profile, live, busy, scroller, fileInput, stick, openConv, addFiles, answer, undo, removeConv, notConfigured, messages, empty, suggest } = chat;
  const fun = useFunMode();
  const minimi = profile.id === MINIMI_PROFILE_ID;
  const card = useRef<HTMLDivElement>(null);
  const place = usePlaceBesideMinimi(card);
  const [scrolled, setScrolled] = useState(false);

  return (
    <div
      ref={card}
      role="dialog"
      aria-label={`Ask ${askName(profile, fun)}`}
      data-minimi-chat
      className={cn("mchat fixed z-40 flex w-[360px] max-w-[calc(100vw-16px)] flex-col text-foreground", place ? "visible" : "invisible", place && (place.flip ? "is-flip" : "is-right"))}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: `min(520px, calc(100dvh - ${CTRL + EDGE}px))` }}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {chat.consentDialog}
      {/* backdrop-filter set inline: the CSS minifier keeps only the -webkit- copy, which Chrome ignores. */}
      <div className="mchat-veil" aria-hidden style={{ backdropFilter: "blur(16px) saturate(0.8)" }} />
      <div className="mchat-ctl absolute -top-9 right-0 flex gap-0.5">
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

      <YouContext.Provider value>
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
              <div className="text-[14.5px] leading-[1.42]">
                Hm. I need a brain first. Connect a model in Settings → AI and I'm all yours.
              </div>
              <button type="button" onClick={openAiSettings} className="mchat-chip self-end">
                Settings → AI
              </button>
            </div>
          ) : empty ? (
            // Only Minimi greets and offers suggestions; another agent's mini chat starts as just the box.
            !profile.available ? (
              <div className="self-start text-[14.5px] leading-[1.42]">{`${profile.note}. Pick someone else above, or open Etude on that computer.`}</div>
            ) : minimi ? (
              <div className="self-start text-[14.5px] leading-[1.42]">Hm? What do you want: a card explained, new cards made, or a quick quiz on what's due?</div>
            ) : null
          ) : (
            <RichContext.Provider value={{ conv: conv?.id ?? "", send: suggest }}>
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
            </RichContext.Provider>
          )}
        </div>
      </YouContext.Provider>

      {empty && !notConfigured && minimi && (
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5 pt-2.5">
          {CHIPS.map((c) => (
            <button key={c.label} type="button" className="mchat-chip" onClick={() => (c.file ? fileInput.current?.click() : suggest(c.label))}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="shrink-0 pt-4">
        <Composer chat={chat} phone={false} below onDelete={conv ? () => (removeConv(conv.id), openConv(null)) : undefined} />
      </div>
    </div>
  );
}
