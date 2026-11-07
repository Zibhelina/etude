// /create-card: write a card right in the page. The block starts as a small form (type, fields, deck); Save makes
// a real item and the block becomes that card, answerable in place (graded and scheduled like Study). Edit
// brings the form back with the card's fields; the item lives in its deck, so it's also in Browse and Study.
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { RESIZE_ATTRS, useResizable } from "./note-resize";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type DeckNode } from "@/lib/api";
import { navigate, withBase } from "@/lib/router";
import { LiveMarkdown } from "@/components/live-editor";
import { cn } from "@/lib/utils";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteCard: { insertCard: () => ReturnType };
  }
}

type Kind = "basic" | "cloze" | "typed" | "free";
const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: "basic", label: "Front and back", hint: "Recall, then rate yourself" },
  { id: "cloze", label: "Cloze", hint: "Write {{the blank}} in braces" },
  { id: "typed", label: "Type the answer", hint: "Checked against your answers" },
  { id: "free", label: "Explain", hint: "Graded by AI against a reference" },
];

type Fields = Record<string, unknown>;
const empty = (k: Kind): Fields => (k === "basic" ? { front: "", back: "" } : k === "cloze" ? { text: "" } : k === "typed" ? { prompt: "", answers: [] } : { prompt: "", reference: "" });

function ready(k: Kind, f: Fields) {
  const s = (x: unknown) => String(x ?? "").trim();
  if (k === "basic") return !!s(f.front) && !!s(f.back);
  if (k === "cloze") return /\{\{[^}]+\}\}/.test(s(f.text));
  if (k === "typed") return !!s(f.prompt) && Array.isArray(f.answers) && f.answers.some((a) => s(a));
  return !!s(f.prompt) && !!s(f.reference);
}

export interface NoteCardOptions {
  /** The page the card is written in: its default deck is Notes::<title>. */
  page(): { id: string; title: string } | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="note-card-field">
      <span className="note-card-label">{label}</span>
      {children}
    </label>
  );
}

function Form({ initial, onSave, onCancel, defaultDeck }: {
  initial: { type: Kind; fields: Fields; deck: string } | null;
  defaultDeck: string;
  onSave(v: { type: Kind; fields: Fields; deck: string }): Promise<void>;
  onCancel(): void;
}) {
  const [kind, setKind] = useState<Kind>(initial?.type ?? "basic");
  const [fields, setFields] = useState<Fields>(initial?.fields ?? empty("basic"));
  const [deck, setDeck] = useState(initial?.deck ?? defaultDeck);
  const [decks, setDecks] = useState<DeckNode[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.decks().then((d) => setDecks(d.filter((x) => !x.archived && x.mode !== "watch"))).catch(() => {}), []);
  const set = (k: string) => (v: unknown) => setFields((f) => ({ ...f, [k]: v }));
  const md = (k: string, placeholder: string, minLines = 2) => <LiveMarkdown value={String(fields[k] ?? "")} onChange={set(k)} placeholder={placeholder} minLines={minLines} className="note-card-input" />;
  const ok = ready(kind, fields);
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await onSave({ type: kind, fields, deck: deck.trim() || defaultDeck });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="note-card-form"
      contentEditable={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void save();
        }
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="note-card-kinds" role="radiogroup" aria-label="Kind of card">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="radio"
            aria-checked={kind === k.id}
            title={k.hint}
            disabled={!!initial}
            onClick={() => {
              setKind(k.id);
              setFields(empty(k.id));
            }}
            className={cn("note-card-kind", kind === k.id && "is-on")}
          >
            {k.label}
          </button>
        ))}
      </div>
      {kind === "basic" && (
        <>
          <Field label="Front">{md("front", "What's asked")}</Field>
          <Field label="Back">{md("back", "The answer")}</Field>
        </>
      )}
      {kind === "cloze" && <Field label="Text">{md("text", "Dijkstra needs {{nonnegative}} edge weights.", 3)}</Field>}
      {kind === "typed" && (
        <>
          <Field label="Question">{md("prompt", "What's asked")}</Field>
          <Field label="Accepted answers">
            <input
              className="note-card-input note-card-plain"
              value={(fields.answers as string[]).join(", ")}
              onChange={(e) => set("answers")(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
              placeholder="O(n log n), n log n"
            />
          </Field>
        </>
      )}
      {kind === "free" && (
        <>
          <Field label="Question">{md("prompt", "Explain why…")}</Field>
          <Field label="Reference answer">{md("reference", "What a full answer covers", 3)}</Field>
        </>
      )}
      <div className="note-card-foot">
        <label className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
          Deck
          <input list="note-card-decks" value={deck} onChange={(e) => setDeck(e.target.value)} className="note-card-input note-card-plain h-8 min-w-0 flex-1 py-0 text-[13px]" />
          <datalist id="note-card-decks">
            {decks.map((d) => <option key={d.id} value={d.name} />)}
          </datalist>
        </label>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="note-cards-btn">Cancel</button>
        <button type="button" disabled={!ok || busy} onClick={() => void save()} className="lib-raised h-8 rounded-[8px] px-3 text-[13px] font-[600] disabled:opacity-50" title="Ctrl+Enter">
          {busy ? "Saving…" : initial ? "Save" : "Make card"}
        </button>
      </div>
    </div>
  );
}

function CardView({ node, updateAttributes, deleteNode, extension, selected }: NodeViewProps) {
  const opts = extension.options as NoteCardOptions;
  const item = node.attrs.item as string | null;
  const [card, setCard] = useState<{ cardId: number; type: Kind; fields: Fields; deck: string } | null>(null);
  const [editing, setEditing] = useState(!item);
  const [missing, setMissing] = useState(false);
  const [h, setH] = useState(200);
  const rs = useResizable(node.attrs, (a) => updateAttributes(a));
  const [key, setKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const page = opts.page();
  const defaultDeck = `Notes::${(page?.title.trim() || "Untitled").replace(/::/g, " ")}`;
  useEffect(() => {
    if (!item) return;
    let live = true;
    api
      .item(item)
      .then((it) => live && setCard({ cardId: it.cards[0]?.id, type: it.type as Kind, fields: it.fields, deck: it.deck }))
      .catch(() => live && setMissing(true));
    return () => void (live = false);
  }, [item, key]);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.lotus !== 1) return;
      if (e.data.type === "resize" && typeof e.data.height === "number") setH(Math.max(100, Math.min(1400, e.data.height)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const save = async (v: { type: Kind; fields: Fields; deck: string }) => {
    const id = item ?? `note-${(page?.id ?? "x").slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await api.saveItem(id, { type: v.type, deck: v.deck, fields: v.fields, tags: ["notes"], source: page ? `note:${page.id}` : "" });
      if (!item) updateAttributes({ item: id });
      setEditing(false);
      setKey((k) => k + 1);
    } catch (e) {
      toast.error(`Couldn't save the card: ${(e as Error).message}`);
    }
  };
  const kindLabel = KINDS.find((k) => k.id === card?.type)?.label ?? "Card";
  return (
    <NodeViewWrapper ref={rs.box} className={cn(cn("note-cards note-card", selected && "is-on"), rs.resizing && "is-resizing")} style={{ width: rs.width ?? undefined }}>
      <div className="note-cards-head" contentEditable={false}>
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden>🃏</span>
          <span className="truncate">{editing ? (item ? "Edit card" : "New card") : `${kindLabel} · ${(card?.deck ?? "").split("::").join(" › ")}`}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {!editing && card && <button type="button" onClick={() => setKey((k) => k + 1)} className="note-cards-btn" title="Answer again">↻</button>}
          {!editing && card && <button type="button" onClick={() => setEditing(true)} className="note-cards-btn">Edit</button>}
          {!editing && item && <button type="button" onClick={() => navigate(`/browse?item=${encodeURIComponent(item)}`)} className="note-cards-btn">In Browse</button>}
          <button type="button" onClick={() => deleteNode()} className="note-cards-btn" title="Remove from the page (the card stays in its deck)">✕</button>
        </span>
      </div>
      {editing ? (
        <Form initial={card} defaultDeck={defaultDeck} onSave={save} onCancel={() => (item ? setEditing(false) : deleteNode())} />
      ) : missing ? (
        <div className="px-4 py-3 text-[13px] text-muted-foreground">This card was deleted.</div>
      ) : card?.cardId ? (
        <iframe key={key} ref={frame} src={withBase(`/embed?card=${card.cardId}&host=note&title=Card`)} title="Card" className="note-cards-frame" style={{ height: rs.height ?? h }} />
      ) : (
        <div className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</div>
      )}
      {rs.handles}
    </NodeViewWrapper>
  );
}

export const NoteCard = Node.create<NoteCardOptions>({
  name: "noteCard",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { page: () => null };
  },
  addAttributes() {
    return { item: { default: null, parseHTML: (el: HTMLElement) => el.dataset.item || null }, ...RESIZE_ATTRS };
  },
  parseHTML: () => [{ tag: "div[data-etude-card]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-card": "", "data-item": node.attrs.item ?? "" })],
  addNodeView() {
    return ReactNodeViewRenderer(CardView);
  },
  addCommands() {
    return { insertCard: () => ({ commands }) => commands.insertContent({ type: this.name }) };
  },
});
