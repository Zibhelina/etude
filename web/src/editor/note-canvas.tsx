// /canvas: a canvas inside a page. The canvas is a note of its own (in the tree, under the page), and the page
// holds a block that shows it. At rest the block is a picture of the drawing, so the page scrolls normally; click
// it and it becomes the live board right there. Click outside (or Esc) and it's a picture again. Edits save to
// the canvas, so they show wherever the canvas is.
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, Maximize2, Minimize2 } from "lucide-react";
import { api, type CanvasScene, type Note, type NoteSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { useScheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { CanvasBoard, loadExcalidraw, sceneForBoard } from "./canvas-board";
import { RESIZE_ATTRS, useResizable } from "./note-resize";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    canvasEmbed: { insertCanvasEmbed: (attrs?: { id?: string | null; title?: string }) => ReturnType };
  }
}

export interface CanvasEmbedOptions {
  /** The page the block is in: a new canvas goes inside it. */
  page(): { id: string; title: string } | null;
}

const SAVE_MS = 600;
const DEFAULT_H = 460;

/** The drawing as an SVG picture, in the page's scheme (also the start page's canvas cards). */
export function Preview({ scene, dark }: { scene: CanvasScene; dark: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(!scene.elements.length);
  useEffect(() => {
    let live = true;
    setEmpty(!scene.elements.length);
    if (!scene.elements.length) return;
    (async () => {
      const [m, data] = await Promise.all([loadExcalidraw(), sceneForBoard(scene)]);
      const svg = await m.exportToSvg({
        elements: data.elements as any,
        appState: { ...data.appState, exportBackground: false, exportWithDarkMode: dark } as any,
        files: data.files as any,
        exportPadding: 20,
        // The page already has Excalidraw's fonts; inlining them needs eval, which the app's CSP refuses.
        skipInliningFonts: true,
      } as any);
      if (!live || !box.current) return;
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      box.current.replaceChildren(svg);
    })().catch(() => {});
    return () => void (live = false);
  }, [scene, dark]);
  return empty ? <div className="note-canvas-empty">Empty canvas · click to draw</div> : <div ref={box} className="note-canvas-svg" aria-hidden />;
}

function Picker({ onPick, onNew, onCancel }: { onPick(n: NoteSummary): void; onNew(): void; onCancel(): void }) {
  const [list, setList] = useState<NoteSummary[] | null>(null);
  useEffect(() => void api.notes().then((l) => setList(l.filter((n) => n.kind === "canvas"))).catch(() => setList([])), []);
  return (
    <div className="note-cards-setup" contentEditable={false}>
      <div className="text-[13px] text-muted-foreground">Which canvas goes here?</div>
      <div className="note-canvas-pick">
        <button type="button" onClick={onNew} className="note-canvas-pick-row is-new">＋ A new canvas</button>
        {list?.map((n) => (
          <button key={n.id} type="button" onClick={() => onPick(n)} className="note-canvas-pick-row">
            🎨 <span className="truncate">{n.title.trim() || "Untitled canvas"}</span>
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="note-cards-btn">Cancel</button>
      </div>
    </div>
  );
}

function CanvasView({ node, updateAttributes, deleteNode, selected, extension }: NodeViewProps) {
  const { id } = node.attrs as { id: string | null };
  const dark = useScheme() === "dark";
  const [note, setNote] = useState<Note | null | "missing">(null);
  const [editing, setEditing] = useState(false);
  // Full screen over the page, for real drawing; Esc or the button brings it back.
  const [full, setFull] = useState(false);
  const rs = useResizable(node.attrs, (a) => updateAttributes(a));
  const wrap = useRef<HTMLDivElement>(null);
  const pending = useRef<CanvasScene | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return setNote(null);
    let live = true;
    api.note(id).then((n) => live && setNote(n.kind === "canvas" && !n.archived ? n : "missing")).catch(() => live && setNote("missing"));
    return () => void (live = false);
  }, [id]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const s = pending.current;
    if (!s || !id) return;
    pending.current = null;
    try {
      const n = await api.updateNote(id, { scene: s });
      setNote((cur) => (cur && cur !== "missing" ? { ...cur, scene: n.scene, title: n.title } : cur));
    } catch (e) {
      toast.error(`Couldn't save the canvas: ${(e as Error).message}`);
    }
  }, [id]);
  useEffect(() => () => void flush(), [flush]);

  const queue = useCallback(
    (s: CanvasScene) => {
      pending.current = s;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_MS);
    },
    [flush],
  );

  // Opening the board moves the focus into it, so keys (space, tool letters) are the board's and never type into the page.
  useEffect(() => {
    if (!editing) return;
    let tries = 0;
    const t = setInterval(() => {
      const el = wrap.current?.querySelector<HTMLElement>(".excalidraw");
      if (el || ++tries > 40) clearInterval(t);
      if (el) {
        (document.activeElement as HTMLElement | null)?.blur?.();
        el.focus({ preventScroll: true });
      }
    }, 50);
    return () => clearInterval(t);
  }, [editing, full]);

  // Out of the board: a click anywhere else, or Esc when nothing in the board is using it.
  useEffect(() => {
    if (!editing) return;
    const done = () => {
      setEditing(false);
      void flush().then(() => {
        if (id) api.note(id).then((n) => setNote(n)).catch(() => {});
      });
    };
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (full || wrap.current?.contains(t) || t.closest?.(".excalidraw-modal-container, .excalidraw .popover, [data-radix-popper-content-wrapper]")) return;
      done();
    };
    const key = (e: KeyboardEvent) => {
      // Space is Excalidraw's hand (hold and drag to pan); the page must not scroll with it.
      if (e.key === " " && wrap.current?.contains(document.activeElement) && !(document.activeElement as HTMLElement | null)?.matches?.("textarea, input")) e.preventDefault();
      if (e.key !== "Escape" || !wrap.current?.contains(document.activeElement)) return;
      // Only while typing a label does Esc stay with Excalidraw (those containers are always in its DOM).
      if (full && !document.querySelector("textarea.excalidraw-wysiwyg")) return void setFull(false);
      // Excalidraw uses Esc to drop a selection or leave text first; a second Esc with nothing going on leaves.
      if (document.querySelector("textarea.excalidraw-wysiwyg")) return;
      setTimeout(done, 0);
    };
    document.addEventListener("pointerdown", down, true);
    // Capture: Excalidraw stops Esc from bubbling.
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [editing, flush, id, full]);

  const makeNew = async () => {
    const page = (extension.options as CanvasEmbedOptions).page();
    try {
      const n = await api.createNote({ kind: "canvas", title: page?.title ? `${page.title} · canvas` : "Canvas", parentId: page?.id ?? null });
      window.dispatchEvent(new Event("etude:notes-changed"));
      updateAttributes({ id: n.id, title: n.title });
      setNote(n);
      setEditing(true);
    } catch (e) {
      toast.error(`Couldn't make the canvas: ${(e as Error).message}`);
    }
  };

  const height = rs.height ?? DEFAULT_H;
  const title = note && note !== "missing" ? note.title.trim() || "Untitled canvas" : "Canvas";
  return (
    <NodeViewWrapper ref={(el: HTMLDivElement | null) => ((rs.box as any).current = el, (wrap.current = el))} className={cn("note-cards note-canvas", selected && "is-on", editing && "is-editing", full && "is-full", rs.resizing && "is-resizing")} style={{ width: rs.width ?? undefined }} onDragStart={(e: React.DragEvent) => editing && e.preventDefault()}>
      {note && note !== "missing" && (
        <div className="note-canvas-acts" contentEditable={false}>
          <button type="button" onClick={() => (setEditing(true), setFull((f) => !f))} className="note-canvas-act" title={full ? "Back into the page (Esc)" : "Draw full screen"} aria-label={full ? "Back into the page" : "Full screen"}>
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          {!full && (
            <button type="button" onClick={() => void flush().then(() => navigate(`/notes?id=${encodeURIComponent(note.id)}`))} className="note-canvas-act" title={`Open ${title}`} aria-label={`Open ${title}`}>
              <ArrowUpRight className="size-4" />
            </button>
          )}
        </div>
      )}
      {!id ? (
        <Picker onNew={() => void makeNew()} onPick={(n) => updateAttributes({ id: n.id, title: n.title })} onCancel={() => deleteNode()} />
      ) : note === "missing" ? (
        <div className="note-canvas-empty" contentEditable={false}>This canvas was archived or deleted.</div>
      ) : note === null ? (
        <div className="note-canvas-empty" contentEditable={false} style={{ height }}>Loading…</div>
      ) : editing ? (
        <div className="note-cards-frame" contentEditable={false} style={full ? undefined : { height }}>
          <CanvasBoard scene={note.scene!} onChange={queue} name={title} embedded />
        </div>
      ) : (
        <button type="button" className="note-cards-frame note-canvas-rest" contentEditable={false} style={{ height }} onClick={() => setEditing(true)} aria-label={`Draw on ${title}`}>
          <Preview scene={note.scene!} dark={dark} />
        </button>
      )}
      {rs.handles}
    </NodeViewWrapper>
  );
}

export const CanvasEmbed = Node.create<CanvasEmbedOptions>({
  name: "canvasEmbed",
  group: "block",
  atom: true,
  // Moved with the ⋮⋮ grip only: a draggable block turned every stroke on the board into a drag of the block.
  draggable: false,
  selectable: true,
  addOptions() {
    return { page: () => null };
  },
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el: HTMLElement) => el.dataset.canvas || null },
      title: { default: "", parseHTML: (el: HTMLElement) => el.dataset.title || "" },
      ...RESIZE_ATTRS,
    };
  },
  parseHTML: () => [{ tag: "div[data-etude-canvas]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-etude-canvas": "", "data-canvas": node.attrs.id ?? "", "data-title": node.attrs.title ?? "" })],
  addNodeView() {
    // Everything inside the board is Excalidraw's: ProseMirror leaves its events and DOM changes alone.
    return ReactNodeViewRenderer(CanvasView, {
      // Keys too while you draw: the focus is in the board, and a key reaching the page would replace the block.
      stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.(".note-canvas-board, .note-cards-setup") || (event.type.startsWith("key") && !!document.activeElement?.closest?.(".note-canvas-board")),
      ignoreMutation: () => true,
    });
  },
  addCommands() {
    return { insertCanvasEmbed: (attrs = {}) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
});
