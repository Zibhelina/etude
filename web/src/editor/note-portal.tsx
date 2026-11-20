// A portal: a window in a page onto another note. This one opens onto a web file (a note of its own in the tree,
// its HTML its content) and runs it live and sandboxed. Edit it through the portal or open it full; the change shows
// through every portal to it. (A canvas's portal is in note-canvas.)
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, Code2, RotateCw, Square, SquareDashed } from "lucide-react";
import { api, type Note, type NoteSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { AnyCodeEditor } from "@/components/live-editor";
import { cn } from "@/lib/utils";
import { FullButton, WidgetFrame, useWidgetRoom } from "./note-embed";
import { RESIZE_ATTRS, useResizable } from "./note-resize";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    portal: { insertPortal: (attrs?: { id?: string | null; title?: string }) => ReturnType };
  }
}

export interface PortalOptions {
  /** The page the block is in: a new web file goes inside it. */
  page(): { id: string; title: string } | null;
}

/** Sent with a web file's id whenever it's saved, so every place showing it runs the new version. */
export const WEB_CHANGED = "etude:web-changed";
export const webChanged = (id: string) => window.dispatchEvent(new CustomEvent(WEB_CHANGED, { detail: id }));

const SAVE_MS = 500;

function Picker({ onPick, onNew, onCancel }: { onPick(n: NoteSummary): void; onNew(): void; onCancel(): void }) {
  const [list, setList] = useState<NoteSummary[] | null>(null);
  useEffect(() => void api.notes().then((l) => setList(l.filter((n) => n.kind === "web"))).catch(() => setList([])), []);
  return (
    <div className="note-cards-setup" contentEditable={false}>
      <div className="text-[13px] text-muted-foreground">Which web file does this portal open onto?</div>
      <div className="note-canvas-pick">
        <button type="button" onClick={onNew} className="note-canvas-pick-row is-new">＋ A new web file</button>
        {list?.map((n) => (
          <button key={n.id} type="button" onClick={() => onPick(n)} className="note-canvas-pick-row">
            <Code2 className="size-4 shrink-0" /> <span className="truncate">{n.title.trim() || "Untitled web file"}</span>
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="note-cards-btn">Cancel</button>
      </div>
    </div>
  );
}

/** A web file's HTML, kept current: it reloads when it's saved anywhere in this window, or the window comes back. */
export function useWebNote(id: string | null) {
  const [note, setNote] = useState<Note | null | "missing">(null);
  const load = useCallback(() => {
    if (!id) return setNote(null);
    api.note(id).then((n) => setNote(n.kind === "web" && !n.archived ? n : "missing")).catch(() => setNote("missing"));
  }, [id]);
  useEffect(() => {
    load();
    const changed = (e: Event) => (e as CustomEvent).detail === id && load();
    const back = () => document.visibilityState === "visible" && load();
    window.addEventListener(WEB_CHANGED, changed);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener(WEB_CHANGED, changed);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [id, load]);
  return [note, setNote] as const;
}

function PortalView({ node, updateAttributes, deleteNode, selected, extension }: NodeViewProps) {
  const { id, bare } = node.attrs as { id: string | null; bare: boolean };
  const [note, setNote] = useWebNote(id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const rs = useResizable(node.attrs, (a) => updateAttributes(a));
  const room = useWidgetRoom(rs.box, `${id}${run}`, editing);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const html = pending.current;
    if (html === null || !id) return;
    pending.current = null;
    try {
      const n = await api.updateNote(id, { content: html });
      setNote(n);
      webChanged(id);
    } catch (e) {
      toast.error(`Couldn't save the web file: ${(e as Error).message}`);
    }
  }, [id, setNote]);
  useEffect(() => () => void flush(), [flush]);

  const edit = (html: string) => {
    setDraft(html);
    pending.current = html;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_MS);
  };

  // Keep the block's title in step with the web file's, for search, export and the start page.
  useEffect(() => {
    if (note && note !== "missing" && note.title !== node.attrs.title) updateAttributes({ title: note.title });
  }, [note]); // eslint-disable-line react-hooks/exhaustive-deps

  const makeNew = async () => {
    const page = (extension.options as PortalOptions).page();
    try {
      const n = await api.createNote({ kind: "web", title: page?.title ? `${page.title} · web` : "Web file", parentId: page?.id ?? null });
      window.dispatchEvent(new Event("etude:notes-changed"));
      updateAttributes({ id: n.id, title: n.title });
      setNote(n);
      setDraft(n.content ?? "");
      setEditing(true);
    } catch (e) {
      toast.error(`Couldn't make the web file: ${(e as Error).message}`);
    }
  };

  const html = draft ?? (note && note !== "missing" ? note.content ?? "" : "");
  const title = note && note !== "missing" ? note.title.trim() || "Untitled web file" : "Web file";
  return (
    <NodeViewWrapper ref={rs.box} className={cn("note-embed note-html note-portal", bare && !editing && "is-bare", selected && "is-on", editing && "is-editing", rs.resizing && "is-resizing", room.overlay && "is-full")} style={{ width: rs.width ?? undefined, zoom: room.zoom }} data-drag-handle="">
      {!id ? (
        <Picker onNew={() => void makeNew()} onPick={(n) => updateAttributes({ id: n.id, title: n.title })} onCancel={() => deleteNode()} />
      ) : note === "missing" ? (
        <div className="note-canvas-empty" contentEditable={false}>This web file was archived or deleted.</div>
      ) : note === null ? (
        <div className="note-canvas-empty" contentEditable={false} style={{ height: rs.height ?? 160 }}>Loading…</div>
      ) : (
        <>
          <div className="note-embed-head" contentEditable={false}>
            <button type="button" className="flex min-w-0 items-center gap-2 hover:text-foreground" onClick={() => void flush().then(() => navigate(`/notes?id=${encodeURIComponent(note.id)}`))} title={`Open ${title}`}>
              <Code2 className="size-3.5 shrink-0" />
              <span className="truncate">{title}</span>
            </button>
            <span className="flex shrink-0 items-center gap-0.5">
              <button type="button" onClick={() => updateAttributes({ bare: !bare })} className="note-cards-btn" title={bare ? "Show it in a card" : "Blend it into the page (no card)"} aria-label={bare ? "Show card" : "Hide card"}>
                {bare ? <Square className="size-3.5" /> : <SquareDashed className="size-3.5" />}
              </button>
              <button type="button" onClick={() => setRun((r) => r + 1)} className="note-cards-btn" title="Run it again from the start" aria-label="Run again">
                <RotateCw className="size-3.5" />
              </button>
              <FullButton room={room} />
              <button type="button" onClick={() => (editing ? (void flush(), setEditing(false), setDraft(null)) : (setDraft(note.content ?? ""), setEditing(true)))} className="note-cards-btn">{editing ? "Done" : "Edit"}</button>
              <button type="button" onClick={() => void flush().then(() => navigate(`/notes?id=${encodeURIComponent(note.id)}`))} className="note-cards-btn" title={`Open ${title}`} aria-label={`Open ${title}`}>
                <ArrowUpRight className="size-3.5" />
              </button>
            </span>
          </div>
          {editing && (
            <div className="note-embed-code" contentEditable={false} onKeyDown={(e) => e.stopPropagation()} onPaste={(e) => e.stopPropagation()}>
              <AnyCodeEditor value={html} onChange={edit} language="html" minLines={8} className="px-1 py-1" />
            </div>
          )}
          <WidgetFrame room={room} html={html} run={run} height={rs.height} title={title} />
        </>
      )}
      {rs.handles}
    </NodeViewWrapper>
  );
}

export const Portal = Node.create<PortalOptions>({
  name: "portal",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { page: () => null };
  },
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el: HTMLElement) => el.dataset.note || null },
      title: { default: "", parseHTML: (el: HTMLElement) => el.dataset.title || "" },
      /** No card around it: the web file sits on the page like its own text; the toolbar shows on hover. */
      bare: { default: false, parseHTML: (el: HTMLElement) => el.dataset.bare === "true" },
      ...RESIZE_ATTRS,
    };
  },
  parseHTML: () => [{ tag: "div[data-etude-portal]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-portal": "", "data-note": node.attrs.id ?? "", "data-title": node.attrs.title ?? "", ...(node.attrs.bare ? { "data-bare": "true" } : {}) })],
  addNodeView() {
    return ReactNodeViewRenderer(PortalView, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.(".note-embed-code, .note-cards-setup"),
    });
  },
  addCommands() {
    return { insertPortal: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});
