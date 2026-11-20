// /kanban: a board inside a page. The board is a note of its own (kind "kanban", in the folder you pick when you
// make it), and the page holds a portal that shows it live: add cards, drag them, open them, right there. ↗ opens
// the board on its own. Edits save to the board, so they show wherever it is.
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, Folder, KanbanSquare } from "lucide-react";
import { api, type KanbanBoard, type Note, type NoteSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { KANBAN_CHANGED, KanbanView, kanbanChanged } from "./kanban-board";
import type { NoteLinkOptions } from "./note-link";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kanbanEmbed: { insertKanban: (attrs?: { id?: string | null; title?: string }) => ReturnType };
  }
}

export interface KanbanEmbedOptions {
  /** The page the block is in (its folder is where a new board goes by default). */
  page(): { id: string; title: string } | null;
  /** Where [[links]] on a card's page find and open pages. */
  links(): NoteLinkOptions | null;
}

const SAVE_MS = 500;
const noLinks: NoteLinkOptions = { pages: () => [], create: async (title) => ({ id: "", title, icon: null, path: "" }), open: () => {}, titleOf: () => null };
const display = (n: { title: string }) => n.title.trim() || "Untitled";

type Template = "basic" | "week" | "empty";
const TEMPLATES: { id: Template; name: string; hint: string; cols: number[] }[] = [
  { id: "basic", name: "To do · Doing · Done", hint: "The usual three", cols: [2, 1, 3] },
  { id: "week", name: "A week", hint: "Mon to Weekend", cols: [1, 0, 1, 0, 1] },
  { id: "empty", name: "Empty", hint: "Make your own columns", cols: [] },
];

/** The prompt a new /kanban block shows: a new board (its name, the folder it lives in, how it starts) or one you have. */
function Setup({ pageId, onMade, onPick, onCancel }: { pageId: string | null; onMade(n: Note): void; onPick(n: NoteSummary): void; onCancel(): void }) {
  const [list, setList] = useState<NoteSummary[] | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [tpl, setTpl] = useState<Template>("basic");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => void api.notes().then(setList).catch(() => setList([])), []);
  useEffect(() => void (mode === "new" && nameRef.current?.focus()), [mode]);
  const by = useMemo(() => new Map((list ?? []).map((n) => [n.id, n])), [list]);
  const folders = useMemo(() => (list ?? []).filter((n) => n.kind === "folder" && !n.archived), [list]);
  const depth = (n: NoteSummary) => {
    let d = 0;
    for (let p = n.parentId ? by.get(n.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) d++;
    return d;
  };
  const pathOf = (id: string | null) => {
    const out: string[] = [];
    for (let p = id ? by.get(id) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(display(p));
    return out.length ? out.join(" / ") : "Notebook";
  };
  // The page's own folder by default.
  const pageFolder = useMemo(() => {
    const page = pageId ? by.get(pageId) : undefined;
    for (let p = page?.parentId ? by.get(page.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) if (p.kind === "folder") return p.id;
    return null;
  }, [by, pageId]);
  const where = folder === undefined ? pageFolder : folder;
  const boards = (list ?? []).filter((n) => n.kind === "kanban" && !n.archived);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const n = await api.createNote({ kind: "kanban", title: name.trim() || "Untitled board", parentId: where, template: tpl });
      window.dispatchEvent(new Event("etude:notes-changed"));
      toast.success(`Saved in ${pathOf(where)}`);
      onMade(n);
    } catch (e) {
      setBusy(false);
      toast.error(`Couldn't make the board: ${(e as Error).message}`);
    }
  };
  return (
    <div className="kb-setup" contentEditable={false} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())}>
      <div className="kb-setup-head">
        <b>{mode === "new" ? "New kanban" : "Add a board"}</b>
        <div className="kb-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "new"} className={cn(mode === "new" && "is-on")} onClick={() => setMode("new")}>New board</button>
          <button type="button" role="tab" aria-selected={mode === "existing"} className={cn(mode === "existing" && "is-on")} onClick={() => setMode("existing")}>Existing board</button>
        </div>
      </div>
      {mode === "new" ? (
        <div className="kb-setup-body">
          <label className="kb-field">Name</label>
          <input ref={nameRef} className="kb-input" value={name} placeholder="Untitled board" spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), void create())} />
          <label className="kb-field">Save in</label>
          <div className="kb-folders" role="listbox" aria-label="Folder">
            <button type="button" role="option" aria-selected={where === null} className={cn("kb-folder", where === null && "is-on")} onClick={() => setFolder(null)}>
              <Folder className="size-4" /> Notebook <span className="kb-folder-tag">{where === null ? "✓" : "top level"}</span>
            </button>
            {folders.map((f) => (
              <button key={f.id} type="button" role="option" aria-selected={where === f.id} className={cn("kb-folder", where === f.id && "is-on")} style={{ paddingLeft: 10 + (depth(f) + 1) * 16 }} onClick={() => setFolder(f.id)}>
                <Folder className="size-4" /> <span className="truncate">{display(f)}</span>
                <span className="kb-folder-tag">{where === f.id ? "✓" : f.id === pageFolder ? "this page's folder" : ""}</span>
              </button>
            ))}
          </div>
          <label className="kb-field">Start with</label>
          <div className="kb-tpls">
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" className={cn("kb-tpl", tpl === t.id && "is-on")} onClick={() => setTpl(t.id)}>
                <span className={cn("kb-tpl-mini", !t.cols.length && "is-empty")}>
                  {t.cols.map((n, i) => (
                    <i key={i}>{Array.from({ length: n }, (_, j) => <b key={j} />)}</i>
                  ))}
                </span>
                <span className="kb-tpl-name">{t.name}</span>
                <span className="kb-tpl-hint">{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="kb-setup-foot">
            <span className="kb-path">{pathOf(where)} / <b>{name.trim() || "Untitled board"}</b></span>
            <button type="button" className="kb-btn is-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="kb-btn" disabled={busy} onClick={() => void create()}>Create and add here</button>
          </div>
        </div>
      ) : (
        <div className="kb-setup-body">
          {list === null ? (
            <div className="kb-muted">Loading…</div>
          ) : boards.length ? (
            <div className="kb-existing">
              {boards.map((b) => (
                <button key={b.id} type="button" className="kb-exrow" onClick={() => onPick(b)}>
                  <KanbanSquare className="size-4" />
                  <span className="min-w-0 flex-1 text-left">
                    <b className="block truncate">{display(b)}</b>
                    <span className="kb-muted block truncate">{pathOf(b.parentId)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="kb-muted">No boards yet. Make one in New board.</div>
          )}
          <div className="kb-setup-foot">
            <span className="kb-path">Pick a board to show it in this page</span>
            <button type="button" className="kb-btn is-ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A board, kept current and saved: used by the portal (the full view keeps its own through the page's saver). */
export function useBoardNote(id: string | null) {
  const [note, setNote] = useState<Note | null | "missing">(null);
  const me = useRef(Math.random().toString(36).slice(2));
  const pending = useRef<KanbanBoard | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEdit = useRef(0);
  const load = useCallback(() => {
    if (!id) return setNote(null);
    api.note(id).then((n) => setNote(n.kind === "kanban" && !n.archived ? (pending.current ? { ...n, board: pending.current } : n) : "missing")).catch(() => setNote("missing"));
  }, [id]);
  useEffect(load, [load]);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const b = pending.current;
    if (!b || !id) return;
    pending.current = null;
    try {
      await api.updateNote(id, { board: b });
    } catch (e) {
      toast.error(`Couldn't save the board: ${(e as Error).message}`);
    }
  }, [id]);
  useEffect(() => () => void flush(), [flush]);
  const change = useCallback(
    (b: KanbanBoard) => {
      setNote((cur) => (cur && cur !== "missing" ? { ...cur, board: b } : cur));
      pending.current = b;
      lastEdit.current = Date.now();
      if (id) kanbanChanged(id, b, me.current);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_MS);
    },
    [flush, id],
  );
  // Another place in this window changed it: follow. Coming back to the window: read it again (the CLI, an agent).
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: string; board: KanbanBoard; from: string };
      if (d.id === id && d.from !== me.current) setNote((cur) => (cur && cur !== "missing" ? { ...cur, board: d.board } : cur));
    };
    const back = () => document.visibilityState === "visible" && !pending.current && Date.now() - lastEdit.current > 1500 && load();
    window.addEventListener(KANBAN_CHANGED, h);
    window.addEventListener("focus", back);
    return () => {
      window.removeEventListener(KANBAN_CHANGED, h);
      window.removeEventListener("focus", back);
    };
  }, [id, load]);
  return { note, change, flush, me: me.current };
}

function KanbanBlock({ node, updateAttributes, deleteNode, selected, extension }: NodeViewProps) {
  const id = (node.attrs.id as string | null) || null;
  const opts = extension.options as KanbanEmbedOptions;
  const { note, change, flush } = useBoardNote(id);
  const [fresh, setFresh] = useState(false);
  const [path, setPath] = useState("");
  useEffect(() => {
    if (!note || note === "missing") return;
    api.notes().then((l) => {
      const by = new Map(l.map((n) => [n.id, n]));
      const out: string[] = [];
      for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(display(p));
      setPath(out.join(" / ") || "Notebook");
    }).catch(() => {});
  }, [note && note !== "missing" ? note.parentId : null]);
  // The board's name follows a rename, in the block too (exports and links use it).
  useEffect(() => {
    if (note && note !== "missing" && note.title !== node.attrs.title) updateAttributes({ title: note.title });
  }, [note && note !== "missing" ? note.title : null]);
  const title = note && note !== "missing" ? note.title.trim() || "Untitled board" : (node.attrs.title as string) || "Board";
  const links = opts.links() ?? noLinks;
  return (
    <NodeViewWrapper className={cn("kb-embed", selected && "is-on")}>
      {!id ? (
        <Setup
          pageId={opts.page()?.id ?? null}
          onMade={(n) => (setFresh(true), updateAttributes({ id: n.id, title: n.title }))}
          onPick={(n) => updateAttributes({ id: n.id, title: n.title })}
          onCancel={() => deleteNode()}
        />
      ) : note === "missing" ? (
        <div className="kb-embed-empty" contentEditable={false}>This board was archived or deleted.</div>
      ) : note === null ? (
        <div className="kb-embed-empty" contentEditable={false}>Loading…</div>
      ) : (
        <div className="kb-embed-inner" contentEditable={false}>
          <div className="kb-embed-head">
            <KanbanSquare className="size-4 kb-embed-icon" />
            <b className="truncate">{title}</b>
            <span className="kb-muted truncate">{path}</span>
            <span className="flex-1" />
            <button type="button" className="kb-btn is-ghost" title={`Open ${title}`} onClick={() => void flush().then(() => navigate(`/notes?id=${encodeURIComponent(note.id)}`))}>
              <ArrowUpRight className="size-4" /> Open
            </button>
          </div>
          <KanbanView boardId={note.id} boardTitle={title} board={note.board!} onChange={change} links={links} compact startAdding={fresh} />
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const KanbanEmbed = Node.create<KanbanEmbedOptions>({
  name: "kanbanEmbed",
  group: "block",
  atom: true,
  // Moved with the ⋮⋮ grip only: dragging a card must never drag the block.
  draggable: false,
  selectable: true,
  addOptions() {
    return { page: () => null, links: () => null };
  },
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el: HTMLElement) => el.dataset.kanban || null },
      title: { default: "", parseHTML: (el: HTMLElement) => el.dataset.title || "" },
    };
  },
  parseHTML: () => [{ tag: "div[data-etude-kanban]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-kanban": "", "data-kanban": node.attrs.id ?? "", "data-title": node.attrs.title ?? "" })],
  addNodeView() {
    // The board and the prompt are their own: ProseMirror leaves their events (keys, pointer, typing) and DOM alone.
    return ReactNodeViewRenderer(KanbanBlock, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.(".kb-embed-inner, .kb-setup"),
      ignoreMutation: () => true,
    });
  },
  addCommands() {
    return { insertKanban: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});
