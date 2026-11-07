// Cards inside notes. A "cards" block runs a real study session in the page (the /embed route: answers are
// graded and scheduled exactly like in Study) for a deck or a search. And a selection can become a cloze card:
// the words you picked are the blank, the item lands in "Notes::<page>", and the words keep a mark so you see
// they're a card.
import { Mark, Node, mergeAttributes, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { RESIZE_ATTRS, useResizable } from "./note-resize";
import { useEffect, useRef, useState } from "react";
import { api, type DeckNode } from "@/lib/api";
import { navigate, withBase } from "@/lib/router";
import { cn } from "@/lib/utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteCards: { insertCards: (attrs?: { deck?: string | null; q?: string | null; n?: number }) => ReturnType };
    cardMark: { setCardMark: (item: string) => ReturnType };
  }
}

function embedUrl(a: { deck?: string | null; q?: string | null; n?: number; title?: string }) {
  const p = new URLSearchParams();
  if (a.q) p.set("q", a.q);
  else if (a.deck) p.set("deck", a.deck);
  p.set("n", String(a.n ?? 5));
  p.set("title", a.title || (a.deck ? a.deck.split("::").pop()! : a.q ? a.q : "Cards"));
  p.set("host", "note");
  return withBase(`/embed?${p}`);
}

function Setup({ deck, q, n, onDone, onCancel }: { deck: string | null; q: string | null; n: number; onDone(a: { deck: string | null; q: string | null; n: number }): void; onCancel(): void }) {
  const [decks, setDecks] = useState<DeckNode[]>([]);
  const [mode, setMode] = useState<"deck" | "q">(q ? "q" : "deck");
  const [d, setD] = useState(deck ?? "");
  const [query, setQuery] = useState(q ?? "");
  const [count, setCount] = useState(n);
  useEffect(() => void api.decks().then((x) => setDecks(x.filter((y) => !y.archived && y.mode !== "watch"))).catch(() => {}), []);
  const ok = mode === "deck" ? !!d : !!query.trim();
  return (
    <div className="note-cards-setup" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1 text-[13px]">
        {(["deck", "q"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={cn("rounded-[7px] px-2.5 py-1 text-muted-foreground", mode === m && "bg-accent text-foreground font-[600]")}>
            {m === "deck" ? "From a deck" : "From a search"}
          </button>
        ))}
      </div>
      {mode === "deck" ? (
        <select value={d} onChange={(e) => setD(e.target.value)} aria-label="Deck" className="note-cards-input">
          <option value="">Pick a deck…</option>
          {decks.map((x) => (
            <option key={x.id} value={x.name}>{"\u00a0\u00a0".repeat(x.depth)}{x.name.split("::").pop()} {x.new + x.learning + x.review ? `· ${x.new + x.learning + x.review} today` : ""}</option>
          ))}
        </select>
      ) : (
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='tag:greedy  or  deck:"CMPT 307" is:due' aria-label="Search" className="note-cards-input font-mono text-[13px]" autoFocus />
      )}
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <label className="flex items-center gap-2">
          Cards per session
          <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 5)))} className="note-cards-input w-16 py-1" />
        </label>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="rounded-[8px] px-3 py-1.5 hover:bg-accent">Cancel</button>
        <button type="button" disabled={!ok} onClick={() => onDone({ deck: mode === "deck" ? d : null, q: mode === "q" ? query.trim() : null, n: count })} className="lib-raised rounded-[8px] px-3 py-1.5 font-[600] text-foreground disabled:opacity-50">
          Done
        </button>
      </div>
    </div>
  );
}

function CardsView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const { deck, q, n } = node.attrs as { deck: string | null; q: string | null; n: number };
  const [setup, setSetup] = useState(!deck && !q);
  const [h, setH] = useState(220);
  const rs = useResizable(node.attrs, (a) => updateAttributes(a));
  const frame = useRef<HTMLIFrameElement>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.lotus !== 1) return;
      if (e.data.type === "resize" && typeof e.data.height === "number") setH(Math.max(120, Math.min(1400, e.data.height)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const label = q ? `Search: ${q}` : deck ? deck.split("::").join(" › ") : "Cards";
  return (
    <NodeViewWrapper ref={rs.box} className={cn(cn("note-cards", selected && "is-on"), rs.resizing && "is-resizing")} style={{ width: rs.width ?? undefined }} data-drag-handle="">
      <div className="note-cards-head" contentEditable={false}>
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden>🃏</span>
          <span className="truncate">{label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {!setup && <button type="button" onClick={() => setKey((k) => k + 1)} className="note-cards-btn" title="Start again">↻</button>}
          {!setup && <button type="button" onClick={() => setSetup(true)} className="note-cards-btn">Change</button>}
          {!setup && deck && <button type="button" onClick={() => navigate(`/deck?name=${encodeURIComponent(deck)}`)} className="note-cards-btn">Open deck</button>}
          <button type="button" onClick={() => deleteNode()} className="note-cards-btn" title="Remove from the page (the cards stay)">✕</button>
        </span>
      </div>
      {setup ? (
        <Setup
          deck={deck}
          q={q}
          n={n}
          onCancel={() => (deck || q ? setSetup(false) : deleteNode())}
          onDone={(a) => {
            updateAttributes(a);
            setSetup(false);
            setKey((k) => k + 1);
          }}
        />
      ) : (
        <iframe key={key} ref={frame} src={embedUrl({ deck, q, n })} title={label} className="note-cards-frame" style={{ height: rs.height ?? h }} />
      )}
      {rs.handles}
    </NodeViewWrapper>
  );
}

export const NoteCards = Node.create({
  name: "noteCards",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      deck: { default: null, parseHTML: (el: HTMLElement) => el.dataset.deck || null },
      q: { default: null, parseHTML: (el: HTMLElement) => el.dataset.q || null },
      n: { default: 5, parseHTML: (el: HTMLElement) => Number(el.dataset.n) || 5 },
      ...RESIZE_ATTRS,
    };
  },
  parseHTML: () => [{ tag: "div[data-etude-cards]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-cards": "", "data-deck": node.attrs.deck ?? "", "data-q": node.attrs.q ?? "", "data-n": String(node.attrs.n) })],
  addNodeView() {
    return ReactNodeViewRenderer(CardsView);
  },
  addCommands() {
    return { insertCards: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});

/** Words in the page that are a card's blank. */
export const CardMark = Mark.create({
  name: "cardMark",
  inclusive: false,
  addAttributes() {
    return { item: { default: null } };
  },
  parseHTML: () => [{ tag: "span[data-card]", getAttrs: (el) => ({ item: (el as HTMLElement).dataset.card }) }],
  renderHTML: ({ HTMLAttributes, mark }) => ["span", mergeAttributes(HTMLAttributes, { "data-card": mark.attrs.item, class: "note-cardmark", title: "This is a card's blank" }), 0],
  addCommands() {
    return { setCardMark: (item) => ({ commands }) => commands.setMark(this.name, { item }) };
  },
});
