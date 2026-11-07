// Notes (beta): a tree of pages on the left, the open page on the right. Every change saves on its own
// (a short pause after you stop typing, and when you leave the page). On a phone the tree is the list
// screen and a page opens on its own.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ArrowUpRight, Check, ChevronRight, Download, FileCode2, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, ImagePlus, MoreHorizontal, PenTool, Plus, Smile, X } from "lucide-react";
import type { NoteLinkOptions, PageRef } from "@/editor/note-link";
import { etudeFetch } from "@/lib/transport";
import { api, type CanvasScene, type Note, type NoteDoc, type NoteLook, type NoteSummary } from "@/lib/api";
import { BANNER_PRESETS } from "@/lib/banner";
import { EMOJI_SUGGESTIONS } from "@/lib/deck-icons";
import { useEtudeSrc } from "@/lib/local-url";
import { PatternSvg } from "@/components/profile-header";
import { navigate } from "@/lib/router";
import { usePhone } from "@/lib/phone";
import { NoteEditor, type NoteEditorHandle } from "@/editor/note-editor";
import { NoteIcon, NoteIconPicker } from "@/editor/note-icon";
import { CanvasBoard, exportBoard } from "@/editor/canvas-board";
import { PdfDocument, uploadPdf } from "@/editor/note-embed";
import { createFileEditor, fileLanguage, wrapsByDefault, type FileEditorHandle } from "@/editor/file-editor";
import { setVimMode, useVimMode } from "@/lib/vim";
import { isTextFile } from "../../../src/core/text-files.ts";
import { useScheme } from "@/lib/theme";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { registerNotesActions, setNotesPagesOpen, useNotesSlot } from "@/lib/sidebar-slot";
import { useNoteTreeDrag } from "@/components/note-tree-drag";

const OPEN_KEY = "etude.notes.open";
const TABS_KEY = "etude.notes.tabs";
/** The open-page tabs, when two or more are open. They sit in the page's top bar, where the path would be. */
const NoteTabsCtx = createContext<React.ReactNode>(null);
/** The + that shows when you hover the top bar: a new page in a new tab. */
const NotePlusCtx = createContext<React.ReactNode>(null);
const SAVE_MS = 600;

type Tree = Map<string | null, NoteSummary[]>;
function treeOf(list: NoteSummary[]): Tree {
  const t: Tree = new Map();
  const ids = new Set(list.map((n) => n.id));
  for (const n of list) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    if (!t.has(p)) t.set(p, []);
    t.get(p)!.push(n);
  }
  return t;
}
const display = (n: { title: string; kind?: string }) => n.title.trim() || (n.kind === "folder" ? "New folder" : n.kind === "canvas" ? "Untitled canvas" : n.kind === "pdf" ? "Untitled PDF" : n.kind === "file" ? "untitled.txt" : "Untitled");
/** A note's glyph when it has no icon of its own. */
const fallbackIcon = (n: { kind?: string }) => (n.kind === "canvas" ? "🎨" : n.kind === "pdf" ? "📕" : "📄");
const isFolder = (n: { kind?: string } | null | undefined) => n?.kind === "folder";
const isFile = (n: { kind?: string } | null | undefined) => n?.kind === "file";

// ---------------------------------------------------------------- saving

type SaveState = "saved" | "saving" | "error";

/** Keeps a page's edits and writes them a moment after the last one, or at once on flush. */
function useSaver(id: string | null, onSaved: (n: Note) => void) {
  const pending = useRef<{ title?: string; doc?: NoteDoc; scene?: CanvasScene; content?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const idRef = useRef(id);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    const target = idRef.current;
    if (!p || !target) return;
    pending.current = null;
    setState("saving");
    try {
      const n = await api.updateNote(target, p);
      setState(pending.current ? "saving" : "saved");
      saved.current(n);
    } catch (e) {
      pending.current = { ...p, ...(pending.current ?? {}) };
      setState("error");
      toast.error(`Couldn't save the page: ${(e as Error).message}`);
    }
  }, []);
  // Switching pages: write what's left of the old one first.
  useEffect(() => {
    if (idRef.current !== id) void flush();
    idRef.current = id;
  }, [id, flush]);
  useEffect(() => {
    const h = () => void flush();
    window.addEventListener("pagehide", h);
    document.addEventListener("visibilitychange", h);
    return () => {
      window.removeEventListener("pagehide", h);
      document.removeEventListener("visibilitychange", h);
      void flush();
    };
  }, [flush]);
  const queue = useCallback(
    (patch: { title?: string; doc?: NoteDoc; scene?: CanvasScene; content?: string }) => {
      pending.current = { ...pending.current, ...patch };
      setState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_MS);
    },
    [flush],
  );
  return { queue, flush, state };
}

// ---------------------------------------------------------------- the tree

type MenuEntry = { label: string; onSelect(): void; disabled?: boolean; danger?: boolean } | "sep";
/** "new": open it in a new tab and go there; "background": add the tab and stay where you are. */
type TabMode = "new" | "background";
type DragProps = { start(n: NoteSummary, e: React.PointerEvent<HTMLElement>): void; draggingId: string | null; targetId: string | null };
/** The row whose name is being typed in place (a new folder, or Rename). */
type RenameProps = { id: string | null; done(id: string, title: string | null): void };

function TreeRow({ n, depth, tree, open, setOpen, current, onPick, onAdd, onMenu, menuItems, inSidebar, dnd, rename }: {
  dnd: DragProps;
  rename: RenameProps;
  menuItems(n: NoteSummary): MenuEntry[];
  inSidebar?: boolean;
  n: NoteSummary;
  depth: number;
  tree: Tree;
  open: Set<string>;
  setOpen(id: string, on: boolean): void;
  current: string | null;
  onPick(id: string, tab?: TabMode): void;
  onAdd(parent: string): void;
  onMenu(n: NoteSummary): React.ReactNode;
}) {
  const kids = tree.get(n.id) ?? [];
  const expanded = open.has(n.id);
  const on = current === n.id;
  const folder = isFolder(n);
  const editing = rename.id === n.id;
  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        role="treeitem"
        aria-selected={on}
        aria-expanded={kids.length ? expanded : undefined}
        data-note-row={n.id}
        className={cn("note-row group", on && "is-on", dnd.draggingId === n.id && "is-dragged", dnd.targetId === n.id && "is-drop-into")}
        data-kind={folder ? "folder" : "page"}
        onPointerDown={(e) => !editing && dnd.start(n, e)}
        // In the sidebar the pages start under the word Notes and nest by indent only.
        style={{ paddingLeft: (inSidebar ? 28 : 6) + depth * 16 }}
        // A folder has no page of its own: clicking it opens or closes it.
        // Ctrl/⌘+click or a middle click opens the page in a new tab.
        onClick={(e) => (editing ? undefined : folder ? setOpen(n.id, !expanded) : onPick(n.id, e.ctrlKey || e.metaKey ? "background" : undefined))}
        onMouseDown={(e) => e.button === 1 && !folder && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && !folder && !editing && onPick(n.id, "background")}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? "Fold" : "Unfold"}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(n.id, !expanded);
          }}
          className={cn("note-row-chev", !kids.length && "invisible")}
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
        </button>
        <span className="note-row-icon" aria-hidden>
          {folder && !n.icon ? (expanded && kids.length ? <FolderOpen className="size-4" /> : <Folder className="size-4" />) : isFile(n) && !n.icon ? <FileCode2 className="size-4" /> : <NoteIcon icon={n.icon} size={18} fallback={fallbackIcon(n)} />}
        </span>
        {editing ? (
          <RenameInput initial={n.title || (folder ? "New folder" : "")} onDone={(t) => rename.done(n.id, t)} />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", !n.title.trim() && "text-muted-foreground")}>{display(n)}</span>
        )}
        <span className="note-row-acts" onClick={(e) => e.stopPropagation()}>
          {onMenu(n)}
          {!inSidebar && (
            <button type="button" aria-label="Add a page inside" title="Add a page inside" onClick={() => onAdd(n.id)} className="note-row-act">
              <Plus className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        {menuItems(n).map((m, i) =>
          m === "sep" ? <ContextMenuSeparator key={i} /> : (
            <ContextMenuItem key={i} disabled={m.disabled} variant={m.danger ? "destructive" : "default"} onSelect={m.onSelect}>{m.label}</ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
      </ContextMenu>
      {expanded && kids.map((k) => <TreeRow key={k.id} n={k} depth={depth + 1} tree={tree} open={open} setOpen={setOpen} current={current} onPick={onPick} onAdd={onAdd} onMenu={onMenu} menuItems={menuItems} inSidebar={inSidebar} dnd={dnd} rename={rename} />)}
    </>
  );
}

/** Typing a name in place: Enter or clicking away keeps it, Esc leaves it as it was. */
function RenameInput({ initial, onDone }: { initial: string; onDone(title: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const born = useRef(performance.now());
  useEffect(() => {
    // A closing menu hands focus back to whatever opened it, so take it back once that has happened.
    const grab = () => {
      const el = ref.current;
      if (!el || done.current) return;
      el.focus();
      el.select();
    };
    grab();
    const t1 = setTimeout(grab, 0);
    const t2 = setTimeout(grab, 120);
    return () => (clearTimeout(t1), clearTimeout(t2));
  }, []);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t);
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Name"
      maxLength={200}
      className="note-row-rename"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => {
        // Focus stolen right after it appeared (a menu closing): take it back instead of finishing.
        if (performance.now() - born.current < 400) {
          const el = e.currentTarget;
          setTimeout(() => !done.current && (el.focus(), el.select()), 0);
          return;
        }
        finish(e.currentTarget.value);
      }}
    />
  );
}

/** A folder opened by link or on a phone: what's inside it, since it has no page of its own. */
function FolderView({ folder, kids, onPick, onAdd, onAddFolder, onMakePage, onOpenFolder, onBack }: {
  folder: Note;
  kids: NoteSummary[];
  onPick(id: string): void;
  onAdd(): void;
  onAddFolder(): void;
  onMakePage(): void;
  onOpenFolder(id: string): void;
  onBack?: () => void;
}) {
  return (
    <article className="note-page">
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notes">
            <ChevronRight className="size-4 rotate-180" /> Notes
          </button>
        )}
        {useContext(NoteTabsCtx)}
        {useContext(NotePlusCtx)}
      </div>
      <div className="note-sheet note-folder">
        <div className="note-folder-head">
          <span className="note-folder-icon" aria-hidden>{folder.icon ? <NoteIcon icon={folder.icon} size={40} /> : <FolderOpen className="size-9" />}</span>
          <h1 className="note-folder-title">{display(folder)}</h1>
          <p className="text-[13.5px] text-muted-foreground">{kids.length ? `${kids.length} ${kids.length === 1 ? "thing" : "things"} inside` : "Nothing inside yet"}. A folder holds pages and has no page of its own.</p>
        </div>
        <div className="note-folder-list">
          {kids.map((k) => (
            <button key={k.id} type="button" className="note-folder-item" onClick={() => (isFolder(k) ? (onOpenFolder(k.id), onPick(k.id)) : onPick(k.id))}>
              <span className="note-row-icon" aria-hidden>{isFolder(k) && !k.icon ? <Folder className="size-4" /> : isFile(k) && !k.icon ? <FileCode2 className="size-4" /> : <NoteIcon icon={k.icon} size={18} />}</span>
              <span className="min-w-0 flex-1 truncate">{display(k)}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onAdd} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]"><FilePlus2 className="size-4" /> New page</button>
          <button type="button" onClick={onAddFolder} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]"><FolderPlus className="size-4" /> New folder</button>
          <button type="button" onClick={onMakePage} className="inline-flex h-10 items-center gap-2 rounded-[10px] px-3 text-[13.5px] text-muted-foreground hover:bg-accent hover:text-foreground">Turn into a page</button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- the page

// ---------------------------------------------------------------- the page's look

const WIDTHS: [NonNullable<NoteLook["width"]>, string][] = [["normal", "Normal"], ["wide", "Wide"], ["full", "Full width"]];
const PAGE_FONTS: [NonNullable<NoteLook["font"]>, string][] = [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]];
const PAGE_SIZES: [NonNullable<NoteLook["size"]>, string][] = [["small", "Small"], ["normal", "Normal"], ["large", "Large"]];

function CoverArt({ cover }: { cover: NonNullable<NoteLook["cover"]> }) {
  const src = useEtudeSrc(cover.kind === "image" ? `/media/${cover.media}` : null);
  if (cover.kind === "image")
    return <div className="absolute inset-0 bg-muted">{src && <img src={src} alt="" draggable={false} className="size-full object-cover select-none" style={{ objectPosition: `50% ${cover.y}%` }} />}</div>;
  const p = BANNER_PRESETS.find((x) => x.id === cover.id) ?? BANNER_PRESETS[0];
  return (
    <div className="absolute inset-0" style={{ background: p.bg }}>
      <PatternSvg pattern={p.pattern} ink={p.ink} />
    </div>
  );
}

function CoverPicker({ onPick, onUpload, onRemove, hasCover }: { onPick(id: string): void; onUpload(f: File): void; onRemove?(): void; hasCover: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="flex w-[19rem] flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        {BANNER_PRESETS.map((p) => (
          <button key={p.id} type="button" aria-label={`${p.id} cover`} title={p.id} onClick={() => onPick(p.id)} className="relative h-12 overflow-hidden rounded-[8px] ring-1 ring-border transition-transform hover:scale-[1.04]">
            <CoverArt cover={{ kind: "preset", id: p.id }} />
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => file.current?.click()} className="lib-raised inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-[9px] text-[13px] font-[600]">
          <ImagePlus className="size-4" /> Upload a picture
        </button>
        {hasCover && onRemove && (
          <button type="button" onClick={onRemove} className="h-9 rounded-[9px] px-3 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">Remove</button>
        )}
      </div>
      <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => (e.target.files?.[0] && onUpload(e.target.files[0]), (e.target.value = ""))} />
    </div>
  );
}

/** Drag the cover picture up or down to frame it; it saves when you let go. */
function useCoverDrag(cover: NoteLook["cover"], onY: (y: number, done: boolean) => void) {
  return (e: React.PointerEvent<HTMLDivElement>) => {
    if (cover?.kind !== "image" || e.button !== 0) return;
    const el = e.currentTarget;
    const h = el.getBoundingClientRect().height;
    const y0 = e.clientY;
    const start = cover.y;
    el.setPointerCapture(e.pointerId);
    let y = start;
    const move = (ev: PointerEvent) => {
      y = Math.max(0, Math.min(100, start - ((ev.clientY - y0) / h) * 100));
      onY(y, false);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onY(y, true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
}

function PageView({ note, tree, all, onTitle, onDoc, saveState, onPick, links, onIcon, onLook, onBack }: {
  note: Note;
  /** Phones: back to the page list. It sits in the top bar, so a cover can start at the very top. */
  onBack?: () => void;
  onIcon(icon: string | null): void;
  onLook(look: NoteLook): void;
  links: NoteLinkOptions;
  tree: Tree;
  all: NoteSummary[];
  onTitle(t: string): void;
  onDoc(d: NoteDoc): void;
  saveState: SaveState;
  onPick(id: string): void;
}) {
  const title = useRef<HTMLTextAreaElement>(null);
  const ed = useRef<NoteEditorHandle | null>(null);
  const [t, setT] = useState(note.title);
  // A new, empty page starts in its title.
  useEffect(() => {
    if (!note.title && !note.text) title.current?.focus();
  }, [note.id]);
  useEffect(() => {
    const el = title.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [t]);
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  const kids = tree.get(note.id) ?? [];
  const [icon, setIcon] = useState(note.icon);
  const [look, setLook] = useState<NoteLook>(note.look ?? {});
  const [iconOpen, setIconOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const setL = (patch: Partial<NoteLook>, save = true) => {
    const next = { ...look, ...patch };
    for (const k of Object.keys(next) as (keyof NoteLook)[]) if (next[k] === undefined) delete next[k];
    setLook(next);
    if (save) onLook(next);
  };
  const pickIcon = (e: string | null) => {
    setIcon(e);
    onIcon(e);
    setIconOpen(false);
  };
  const upload = async (f: File) => {
    try {
      const m = await api.uploadMedia(f);
      if (m.kind !== "image") throw new Error("That file isn't a picture.");
      setL({ cover: { kind: "image", media: m.file, y: 50 } });
      setCoverOpen(false);
    } catch (e) {
      toast.error(`Couldn't use that picture: ${(e as Error).message}`);
    }
  };
  const dragCover = useCoverDrag(look.cover, (y, done) => look.cover?.kind === "image" && setL({ cover: { ...look.cover, y: Math.round(y * 10) / 10 } }, done));
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  const lookClass = cn("note-sheet", look.width && look.width !== "normal" && `is-${look.width}`, look.font && `font-${look.font}`, look.size && `size-${look.size}`, look.cover && "has-cover", icon && "has-icon");
  return (
    <article className={cn("note-page", strip && "has-tabs")}>
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notes">
            <ChevronRight className="size-4 rotate-180" /> Notes
          </button>
        )}
        {strip ?? (
        <nav aria-label="Path" className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
          {crumbs.map((c) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
              <ChevronRight className="size-3 shrink-0 opacity-60" />
            </span>
          ))}
          {crumbs.length > 0 && <span className="truncate px-1 text-foreground/80">{display({ title: t })}</span>}
        </nav>
        )}
        {plus}
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Page options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="note-menu-label">Font</DropdownMenuLabel>
              <div className="note-menu-fonts">
                {PAGE_FONTS.map(([id, label]) => (
                  <button key={id} type="button" aria-pressed={(look.font ?? "sans") === id} onClick={() => setL({ font: id === "sans" ? undefined : id })} className={cn("note-menu-font", `font-${id}`, (look.font ?? "sans") === id && "is-on")}>
                    <span className="text-[19px] leading-none">Ag</span>
                    <span className="text-[11.5px] text-muted-foreground">{label}</span>
                  </button>
                ))}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="note-menu-label">Width</DropdownMenuLabel>
              {WIDTHS.map(([id, label]) => (
                <DropdownMenuItem key={id} onSelect={(e) => (e.preventDefault(), setL({ width: id === "normal" ? undefined : id }))}>
                  <Check className={cn("size-4", (look.width ?? "normal") !== id && "opacity-0")} /> {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="note-menu-label">Text size</DropdownMenuLabel>
              {PAGE_SIZES.map(([id, label]) => (
                <DropdownMenuItem key={id} onSelect={(e) => (e.preventDefault(), setL({ size: id === "normal" ? undefined : id }))}>
                  <Check className={cn("size-4", (look.size ?? "normal") !== id && "opacity-0")} /> {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportNote(note, "md")}><Download className="size-4" /> Export as Markdown</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportNote(note, "html")}><Download className="size-4" /> Export as HTML</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {look.cover && (
        <div className={cn("note-cover group/cover", look.cover.kind === "image" && "is-image")} onPointerDown={dragCover}>
          <CoverArt cover={look.cover} />
          <div className="note-cover-acts">
            <Popover open={coverOpen} onOpenChange={setCoverOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="note-cover-btn" onPointerDown={(e) => e.stopPropagation()}>Change cover</button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-3">
                <CoverPicker hasCover onPick={(id) => (setL({ cover: { kind: "preset", id } }), setCoverOpen(false))} onUpload={(f) => void upload(f)} onRemove={() => (setL({ cover: undefined }), setCoverOpen(false))} />
              </PopoverContent>
            </Popover>
            {look.cover.kind === "image" && <span className="note-cover-hint">Drag to move</span>}
          </div>
        </div>
      )}
      <div
        className={lookClass}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          ed.current?.focusEnd();
        }}
      >
        {icon && (
          <Popover open={iconOpen} onOpenChange={setIconOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="note-page-icon" aria-label="Change icon"><NoteIcon icon={icon} size={72} /></button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
              <NoteIconPicker icon={icon} onPick={pickIcon} onRemove={() => pickIcon(null)} />
            </PopoverContent>
          </Popover>
        )}
        <div className="note-addons">
          {!icon && (
            <Popover open={iconOpen} onOpenChange={setIconOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="note-addon"><Smile className="size-4" /> Add icon</button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-2">
                <NoteIconPicker icon={null} onPick={pickIcon} onRemove={() => pickIcon(null)} />
              </PopoverContent>
            </Popover>
          )}
          {!look.cover && (
            <Popover open={coverOpen} onOpenChange={setCoverOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="note-addon"><ImagePlus className="size-4" /> Add cover</button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <CoverPicker hasCover={false} onPick={(id) => (setL({ cover: { kind: "preset", id } }), setCoverOpen(false))} onUpload={(f) => void upload(f)} />
              </PopoverContent>
            </Popover>
          )}
        </div>
        {strip && crumbs.length > 0 && (
          <nav aria-label="Path" className="note-crumbs-above">
            {crumbs.map((c, i) => (
              <span key={c.id} className="flex min-w-0 items-center gap-1">
                {i > 0 && <ChevronRight className="size-3 shrink-0 opacity-60" />}
                <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
              </span>
            ))}
          </nav>
        )}
        <textarea
          ref={title}
          rows={1}
          value={t}
          placeholder="Untitled"
          aria-label="Title"
          className="note-title"
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, "");
            setT(v);
            onTitle(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === e.currentTarget.value.length)) {
              e.preventDefault();
              ed.current?.focusStart();
            }
          }}
        />
        <NoteEditor key={note.id} doc={note.doc} onChange={onDoc} editorRef={ed} onEscapeUp={() => title.current?.focus()} links={links} page={{ id: note.id, title: t }} />
        <Backlinks id={note.id} title={t} onPick={onPick} />
        {kids.length > 0 && (
          <div className="note-subpages">
            <div className="note-subpages-head">{kids.length === 1 ? "1 page inside" : `${kids.length} pages inside`}</div>
            {kids.map((k) => (
              <button key={k.id} onClick={() => onPick(k.id)} className="note-subpage">
                <NoteIcon icon={k.icon} size={18} fallback={fallbackIcon(k)} />
                <span className="truncate">{display(k)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}


async function exportNote(note: Note, format: "md" | "html") {
  try {
    const res = await etudeFetch(api.noteExportUrl(note.id, format));
    if (!res.ok) throw new Error(res.statusText);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    const base = (note.title.trim() || (isFile(note) ? "untitled.txt" : "Untitled")).replace(/[\\/:*?"<>|]+/g, " ").trim();
    a.download = isFile(note) ? base : `${base}.${note.kind === "canvas" ? "excalidraw" : note.kind === "pdf" ? "pdf" : format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    toast.error(`Couldn't export: ${(e as Error).message}`);
  }
}

/** The pages that link here, under the page. */
function mark(text: string, word: string) {
  const at = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + word.length)}</mark>{text.slice(at + word.length)}</>;
}

function Backlinks({ id, title, onPick }: { id: string; title: string; onPick(id: string): void }) {
  const [rows, setRows] = useState<(NoteSummary & { snippet: string })[]>([]);
  useEffect(() => {
    let live = true;
    api.noteBacklinks(id).then((r) => live && setRows(r)).catch(() => {});
    return () => void (live = false);
  }, [id]);
  if (!rows.length) return null;
  return (
    <div className="note-backlinks">
      <div className="note-backlinks-head">{rows.length === 1 ? "1 page links here" : `${rows.length} pages link here`}</div>
      {rows.map((r) => (
        <button key={r.id} onClick={() => onPick(r.id)} className="note-backlink">
          <span className="flex items-center gap-2 text-[14px] font-[550]"><NoteIcon icon={r.icon} size={18} fallback={fallbackIcon(r)} />{display(r)}<ArrowUpRight className="size-3.5 text-muted-foreground" /></span>
          {r.snippet && <span className="note-backlink-snip block truncate text-[13px] text-muted-foreground">{mark(r.snippet, title)}</span>}
        </button>
      ))}
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/** Reads a picked folder (or files) and imports its markdown, uploading its images first. */
async function importPicked(files: FileList, parentId: string | null) {
  const list = [...files].filter((f) => !(f.webkitRelativePath || f.name).split("/").some((p) => p.startsWith(".")));
  const md = list.filter((f) => /\.(md|markdown)$/i.test(f.name) || isTextFile(f.name));
  const pdfFiles = list.filter((f) => /\.pdf$/i.test(f.name));
  if (!md.length && !pdfFiles.length) throw new Error("no markdown, code files or PDFs in what you picked");
  const media: Record<string, string> = {};
  for (const f of list.filter((f) => IMAGE.test(f.name))) {
    const m = await api.uploadMedia(f);
    const rel = (f.webkitRelativePath || f.name).split("/").slice(1).join("/");
    if (rel) media[rel] = m.url;
    media[f.name] ??= m.url;
  }
  const pdfs: { path: string; file: string }[] = [];
  for (const f of pdfFiles) {
    const m = await api.uploadMedia(f);
    if (m.kind === "document") pdfs.push({ path: f.webkitRelativePath || f.name, file: m.url });
  }
  const texts = await Promise.all(md.map(async (f) => ({ path: f.webkitRelativePath || f.name, text: await f.text() })));
  return api.importNotes(texts, media, parentId, pdfs);
}

// ---------------------------------------------------------------- a canvas

/** A canvas note: its title in the top bar and the board filling the rest of the screen. */
function CanvasView({ note, all, onScene, saveState, onPick }: {
  note: Note;
  all: NoteSummary[];
  onTitle(t: string): void;
  onScene(s: CanvasScene): void;
  saveState: SaveState;
  onPick(id: string): void;
}) {
  const t = note.title;
  const xapi = useRef<any>(null);
  const dark = useScheme() === "dark";
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  return (
    <article className="note-page note-canvas-page">
      <div className="note-topbar">
        {strip ?? (
        <nav aria-label="Path" className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
          {crumbs.map((c) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
              <ChevronRight className="size-3 shrink-0 opacity-60" />
            </span>
          ))}
          {crumbs.length > 0 && <span className="truncate px-1 text-foreground/80">{display({ title: t })}</span>}
        </nav>
        )}
        {plus}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Canvas options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => xapi.current && void exportBoard(xapi.current, "png", t, dark)}><Download className="size-4" /> Export as PNG</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => xapi.current && void exportBoard(xapi.current, "svg", t, dark)}><Download className="size-4" /> Export as SVG</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportNote(note, "md")}><Download className="size-4" /> Export as .excalidraw</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <CanvasBoard key={note.id} scene={note.scene!} onChange={onScene} name={t} onApi={(a) => (xapi.current = a)} className="note-canvas-full" />
    </article>
  );
}

// ---------------------------------------------------------------- a PDF

/** A PDF note: its title in the top bar and the document filling the rest, like opening the file itself. */
function PdfNoteView({ note, all, onPick }: { note: Note; all: NoteSummary[]; onPick(id: string): void }) {
  const url = useEtudeSrc(note.file ? `/media/${note.file}` : null);
  const [ctl, setCtl] = useState<HTMLSpanElement | null>(null);
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  return (
    <article className="note-page note-canvas-page note-pdf-note">
      <div className="note-topbar">
        {strip}
        {!strip && (
          <nav aria-label="Path" className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
            {crumbs.map((c) => (
              <span key={c.id} className="flex min-w-0 items-center gap-1">
                <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
                <ChevronRight className="size-3 shrink-0 opacity-60" />
              </span>
            ))}
            <span className="truncate px-1 text-foreground/80">{display(note)}</span>
          </nav>
        )}
        {plus}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1">
          <span ref={setCtl} className="flex items-center" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="PDF options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => void exportNote(note, "md")}><Download className="size-4" /> Download the PDF</DropdownMenuItem>
              {url && <DropdownMenuItem onSelect={() => window.open(url, "_blank", "noopener")}><ArrowUpRight className="size-4" /> Open in the browser's viewer</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {note.file ? <PdfDocument url={url ?? null} name={display(note)} className="note-canvas-full" controls={ctl} /> : <div className="px-6 py-5 text-[14px] text-[var(--danger)]">This PDF's file is missing.</div>}
    </article>
  );
}

// ---------------------------------------------------------------- a file

const WRAP_KEY = "etude.notes.wrap";
/** Per-file wrap choice; files without one wrap when they read like prose (.tex, .txt). */
function wrapOf(id: string, name: string): boolean {
  try {
    const v = (JSON.parse(localStorage.getItem(WRAP_KEY) ?? "{}") as Record<string, boolean>)[id];
    if (typeof v === "boolean") return v;
  } catch {}
  // Phones wrap everything by default: sideways scrolling on a narrow screen loses the line.
  return wrapsByDefault(name) || matchMedia("(max-width: 767px)").matches;
}
function saveWrap(id: string, on: boolean) {
  try {
    const m = JSON.parse(localStorage.getItem(WRAP_KEY) ?? "{}") as Record<string, boolean>;
    m[id] = on;
    localStorage.setItem(WRAP_KEY, JSON.stringify(m));
  } catch {}
}

/** A code or text file (main.py, report.tex): its name in the top bar and a plain editor filling the rest. */
function FileView({ note, all, onTitle, onContent, saveState, onPick, onSave, onBack }: {
  note: Note;
  all: NoteSummary[];
  onTitle(t: string): void;
  onContent(c: string): void;
  saveState: SaveState;
  onPick(id: string): void;
  onSave(): void;
  onBack?: () => void;
}) {
  const [t, setT] = useState(note.title);
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<FileEditorHandle | null>(null);
  const vim = useVimMode();
  const [wrap, setWrap] = useState(() => wrapOf(note.id, note.title));
  const [pos, setPos] = useState({ line: 1, col: 1, sel: 0 });
  const [mode, setMode] = useState<string | null>(null);
  const cb = useRef({ onContent, onSave });
  cb.current = { onContent, onSave };
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  useEffect(() => {
    if (!host.current) return;
    const h = createFileEditor(host.current, {
      value: note.content ?? "",
      name: note.title,
      vim,
      wrap,
      onChange: (v) => cb.current.onContent(v),
      onSave: () => cb.current.onSave(),
      onVimMode: setMode,
    });
    ed.current = h;
    const where = () => {
      const st = h.view.state;
      const r = st.selection.main;
      const line = st.doc.lineAt(r.head);
      setPos({ line: line.number, col: r.head - line.from + 1, sel: Math.abs(r.to - r.from) });
    };
    const obs = h.view.dom.addEventListener.bind(h.view.dom);
    obs("keyup", where);
    obs("mouseup", where);
    // A new, empty file starts with the cursor in it; one with something in it waits for a click.
    if (!note.content) setTimeout(() => h.focus(), 0);
    return () => {
      h.destroy();
      ed.current = null;
    };
    // The editor lives as long as this file is open; name, Vim and wrap change it in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);
  useEffect(() => void ed.current?.setVim(vim), [vim]);
  useEffect(() => ed.current?.setWrap(wrap), [wrap]);
  // .m highlights with Octave's grammar, which is MATLAB's; call it what you'd call it.
  const language = /\.m$/i.test(t) ? "MATLAB" : fileLanguage(t)?.name ?? "Plain text";
  const lines = ed.current?.view.state.doc.lines;
  return (
    <article className="note-page note-canvas-page note-file-page">
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notes">
            <ChevronRight className="size-4 rotate-180" /> Notes
          </button>
        )}
        {strip}
        <nav aria-label="Path" className={cn("flex min-w-0 flex-1 items-center gap-1 text-[13px] text-muted-foreground", strip && "note-canvas-name")}>
          {!strip && crumbs.map((c) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
              <ChevronRight className="size-3 shrink-0 opacity-60" />
            </span>
          ))}
          <input
            value={t}
            placeholder="untitled.txt"
            aria-label="File name"
            spellCheck={false}
            className="note-canvas-title note-file-name"
            onChange={(e) => {
              const v = e.target.value.replace(/[\n/]/g, "");
              setT(v);
              onTitle(v);
              ed.current?.setName(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                ed.current?.focus();
              }
            }}
          />
        </nav>
        {plus}
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="File options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => (e.preventDefault(), ed.current?.focus())}>
              <DropdownMenuItem onSelect={() => setWrap((w) => (saveWrap(note.id, !w), !w))}>
                <Check className={cn("size-4", !wrap && "opacity-0")} /> Wrap long lines
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void setVimMode(!vim)?.catch((e: Error) => toast.error(`Couldn't save: ${e.message}`))}>
                <Check className={cn("size-4", !vim && "opacity-0")} /> Vim keys
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportNote({ ...note, title: t }, "md")}><Download className="size-4" /> Download {t.trim() || "untitled.txt"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div ref={host} className={cn("note-file-editor", vim && "is-vim")} />
      <div className="note-file-status" aria-label="File status">
        {vim && mode && <span className={cn("note-vim-mode", `is-${mode.split(" ")[0]}`)} aria-live="polite">{mode.toUpperCase()}</span>}
        <span>{language}</span>
        <span className="tabular-nums">Ln {pos.line}, Col {pos.col}{pos.sel ? ` · ${pos.sel} selected` : ""}</span>
        {lines !== undefined && <span className="tabular-nums max-sm:hidden">{lines} line{lines === 1 ? "" : "s"}</span>}
        <span className="max-sm:hidden">{wrap ? "Wrap" : "No wrap"}</span>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- tabs

/** The open pages as tabs over the page, once there's more than one. Middle click or × closes one. */
function NoteTabs({ tabs, all, current, onPick, onClose }: { tabs: string[]; all: NoteSummary[]; current: string | null; onPick(id: string): void; onClose(id: string): void }) {
  const by = useMemo(() => new Map(all.map((n) => [n.id, n])), [all]);
  const strip = useRef<HTMLDivElement>(null);
  // A fade on the edge where more tabs are hidden.
  const [over, setOver] = useState<{ l: boolean; r: boolean }>({ l: false, r: false });
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const f = () => setOver({ l: el.scrollLeft > 2, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    f();
    el.addEventListener("scroll", f, { passive: true });
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => (el.removeEventListener("scroll", f), ro.disconnect());
  });
  // The current tab stays in view when the strip scrolls.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(".note-tab.is-on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current, tabs.length]);
  const shown = tabs.filter((t) => by.has(t));
  if (shown.length < 2) return null;
  return (
    <div ref={strip} role="tablist" aria-label="Open pages" className={cn("note-tabs", over.l && "fade-l", over.r && "fade-r")}>
      {shown.map((tid) => {
        const n = by.get(tid)!;
        const on = tid === current;
        return (
          <div
            key={tid}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={display(n)}
            className={cn("note-tab group", on && "is-on")}
            onClick={() => !on && onPick(tid)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && onClose(tid)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(tid))}
          >
            <span className="note-tab-icon" aria-hidden>{isFile(n) && !n.icon ? <FileCode2 className="size-3.5" /> : <NoteIcon icon={n.icon} size={15} />}</span>
            <span className={cn("min-w-0 flex-1 truncate", !n.title.trim() && "text-muted-foreground")}>{display(n)}</span>
            <button
              type="button"
              aria-label={`Close ${display(n)}`}
              className="note-tab-x"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tid);
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the screen

export function NotesPage({ id }: { id: string | null }) {
  const phone = usePhone();
  const [list, setList] = useState<NoteSummary[] | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [open, setOpenSet] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]")));
  const tree = useMemo(() => treeOf(list ?? []), [list]);
  const current = id ?? (phone ? null : (list?.find((n) => !isFolder(n))?.id ?? null));
  const [renaming, setRenaming] = useState<string | null>(null);

  const reload = useCallback(async () => setList(await api.notes()), []);
  useEffect(() => void reload().catch((e) => toast.error((e as Error).message)), [reload]);
  // A canvas made from a page's /canvas block shows up in the tree.
  useEffect(() => {
    const h = () => void reload().catch(() => {});
    window.addEventListener("etude:notes-changed", h);
    return () => window.removeEventListener("etude:notes-changed", h);
  }, [reload]);

  // The title in the tree follows what's typed, before it's saved.
  const patchRow = useCallback((rid: string, p: Partial<NoteSummary>) => setList((l) => l?.map((n) => (n.id === rid ? { ...n, ...p } : n)) ?? l), []);
  const saver = useSaver(current, (n) => patchRow(n.id, { title: n.title, updated: n.updated }));

  useEffect(() => {
    if (!current) return setNote(null);
    if (note?.id === current) return;
    let live = true;
    api.note(current).then((n) => live && setNote(n)).catch(() => live && navigate("/notes", { replace: true }));
    return () => void (live = false);
  }, [current]);

  const setOpen = useCallback((oid: string, on: boolean) => {
    setOpenSet((s) => {
      const next = new Set(s);
      if (on) next.add(oid);
      else next.delete(oid);
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  // The open page is always visible in the tree: its parents unfold.
  useEffect(() => {
    if (!current || !list) return;
    const by = new Map(list.map((n) => [n.id, n]));
    const up: string[] = [];
    for (let p = by.get(current)?.parentId; p; p = by.get(p)?.parentId ?? null) up.push(p);
    if (up.some((u) => !open.has(u))) for (const u of up) setOpen(u, true);
  }, [current, list]);

  // Tabs, like a browser's: opening a page normally replaces the page in the current tab; "Open in new tab"
  // (or Ctrl/⌘+click, middle click) adds one next to it. The strip shows once there are two.
  const [tabs, setTabsState] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const setTabs = useCallback((f: (t: string[]) => string[]) => {
    setTabsState((t) => {
      const next = f(t);
      localStorage.setItem(TABS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const shownRef = useRef<string | null>(null);
  useEffect(() => {
    if (!current) return;
    const was = shownRef.current;
    shownRef.current = current;
    setTabs((t) => {
      if (t.includes(current)) return t;
      const at = was ? t.indexOf(was) : -1;
      if (at < 0) return t.length ? [...t, current] : [current];
      const next = [...t];
      next[at] = current;
      return next;
    });
  }, [current, setTabs]);
  // Pages that were archived or deleted leave their tabs.
  useEffect(() => {
    if (!list) return;
    const ids = new Set(list.map((n) => n.id));
    setTabs((t) => (t.every((x) => ids.has(x)) ? t : t.filter((x) => ids.has(x))));
  }, [list, setTabs]);

  const pick = useCallback(
    (pid: string, tab?: TabMode) => {
      if (tab) {
        setTabs((t) => {
          if (t.includes(pid)) return t;
          const at = current ? t.indexOf(current) : -1;
          const next = [...t];
          if (at < 0 && current) next.push(current);
          next.splice(at < 0 ? next.length : at + 1, 0, pid);
          return next;
        });
        if (tab === "background") return;
      }
      void saver.flush();
      navigate(`/notes?id=${encodeURIComponent(pid)}`);
    },
    [saver, current, setTabs],
  );
  const closeTab = useCallback(
    (tid: string) => {
      const at = tabs.indexOf(tid);
      if (at < 0) return;
      const next = tabs.filter((x) => x !== tid);
      setTabs(() => next);
      if (tid === current && next.length) {
        void saver.flush();
        navigate(`/notes?id=${encodeURIComponent(next[Math.min(at, next.length - 1)])}`, { replace: true });
      }
    },
    [tabs, current, saver, setTabs],
  );

  const add = useCallback(
    async (parentId: string | null, kind: "page" | "canvas" | "file" = "page") => {
      try {
        await saver.flush();
        // A file gets a name ready to edit, so it highlights as soon as you change the extension.
        const n = await api.createNote({ title: kind === "file" ? "untitled.py" : "", parentId, kind });
        if (parentId) setOpen(parentId, true);
        await reload();
        setNote(n);
        navigate(`/notes?id=${encodeURIComponent(n.id)}`);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [reload, saver, setOpen],
  );

  // A folder holds pages and has no page of its own. It appears in the tree with its name ready to type.
  const addFolder = useCallback(
    async (parentId: string | null) => {
      try {
        if (!phone) setNotesPagesOpen(true);
        const n = await api.createNote({ title: "New folder", parentId, kind: "folder" });
        if (parentId) setOpen(parentId, true);
        await reload();
        setRenaming(n.id);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [reload, setOpen, phone],
  );
  const rename = useMemo<RenameProps>(
    () => ({
      id: renaming,
      done: (rid, t) => {
        setRenaming(null);
        if (t === null) return;
        const title = t.trim();
        const old = listRef.current?.find((x) => x.id === rid);
        if (!old || title === old.title) return;
        patchRow(rid, { title });
        if (note?.id === rid) setNote({ ...note, title });
        void api.updateNote(rid, { title }).catch((e) => toast.error((e as Error).message));
      },
    }),
    [renaming, patchRow, note],
  );
  const setKind = async (n: NoteSummary, kind: "page" | "folder") => {
    try {
      await saver.flush();
      await api.updateNote(n.id, { kind });
      await reload();
      if (kind === "page") navigate(`/notes?id=${encodeURIComponent(n.id)}`);
      else if (current === n.id) setNote(await api.note(n.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Ctrl/⌘+Alt+N: a new page next to nothing (top level).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void add(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [add]);

  const archive = async (n: NoteSummary) => {
    await saver.flush();
    const r = await api.setNoteArchived(n.id, true);
    await reload();
    if (current && r.ids.includes(current)) navigate("/notes", { replace: true });
    toast(`Archived “${display(n)}”${r.ids.length > 1 ? ` and ${r.ids.length - 1} page${r.ids.length > 2 ? "s" : ""} inside` : ""}`, {
      action: { label: "Undo", onClick: async () => void (await api.setNoteArchived(n.id, false), await reload()) },
    });
  };

  const move = async (n: NoteSummary, parentId: string | null) => {
    try {
      await api.moveNote(n.id, parentId);
      if (parentId) setOpen(parentId, true);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const reorder = async (n: NoteSummary, delta: number) => {
    const sibs = tree.get(n.parentId) ?? [];
    const at = sibs.findIndex((s) => s.id === n.id);
    const to = at + delta;
    if (to < 0 || to >= sibs.length) return;
    await api.moveNote(n.id, n.parentId, to);
    await reload();
  };

  // The same menu on ⋯ and on right-click.
  const menuItems = (n: NoteSummary): MenuEntry[] => {
    const parent = n.parentId ? list?.find((x) => x.id === n.parentId) : undefined;
    const sibs = tree.get(n.parentId) ?? [];
    const at = sibs.findIndex((s) => s.id === n.id);
    const prev = at > 0 ? sibs[at - 1] : undefined;
    return [
      ...(isFolder(n) ? [] : [{ label: "Open", onSelect: () => pick(n.id) }, { label: "Open in new tab", onSelect: () => pick(n.id, "new") }]),
      { label: "New page inside", onSelect: () => void add(n.id) },
      { label: "New canvas inside", onSelect: () => void add(n.id, "canvas") },
      { label: "New code file inside", onSelect: () => void add(n.id, "file") },
      { label: "New folder inside", onSelect: () => void addFolder(n.id) },
      { label: "Add a PDF inside…", onSelect: () => pickPdf(n.id) },
      { label: "Rename", onSelect: () => setRenaming(n.id) },
      n.kind === "canvas" || n.kind === "pdf" || isFile(n)
        ? "sep"
        : isFolder(n)
        ? { label: "Turn into a page", onSelect: () => void setKind(n, "page") }
        : { label: n.empty === false ? "Turn into a folder (only when it's empty)" : "Turn into a folder", disabled: n.empty === false, onSelect: () => void setKind(n, "folder") },
      "sep",
      { label: "Move up", disabled: at <= 0, onSelect: () => void reorder(n, -1) },
      { label: "Move down", disabled: at < 0 || at >= sibs.length - 1, onSelect: () => void reorder(n, 1) },
      { label: `Put inside “${prev ? display(prev) : "the page above"}”`, disabled: !prev, onSelect: () => prev && void move(n, prev.id) },
      { label: "Move out a level", disabled: !n.parentId, onSelect: () => void move(n, parent?.parentId ?? null) },
      "sep",
      { label: "Archive", danger: true, onSelect: () => void archive(n) },
    ];
  };
  const rowMenu = (n: NoteSummary) => {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`More for ${display(n)}`} className="note-row-act">
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
          {menuItems(n).map((m, i) =>
            m === "sep" ? <DropdownMenuSeparator key={i} /> : (
              <DropdownMenuItem key={i} disabled={m.disabled} variant={m.danger ? "destructive" : "default"} onSelect={m.onSelect}>{m.label}</DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // What [[links]] in the editor see: the pages as they are now.
  const listRef = useRef(list);
  listRef.current = list;
  const links: NoteLinkOptions = useMemo(
    () => ({
      pages: (q: string): PageRef[] => {
        const all = listRef.current ?? [];
        const by = new Map(all.map((n) => [n.id, n]));
        const path = (n: NoteSummary) => {
          const out: string[] = [];
          for (let p = n.parentId ? by.get(n.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(display(p));
          return out.join(" › ");
        };
        const ql = q.toLowerCase();
        const hits = ql
          ? all.filter((n) => n.title.toLowerCase().includes(ql)).sort((a, b) => Number(!a.title.toLowerCase().startsWith(ql)) - Number(!b.title.toLowerCase().startsWith(ql)) || a.title.length - b.title.length)
          : [...all].sort((a, b) => b.updated.localeCompare(a.updated));
        return hits.filter((n) => n.id !== current && !isFolder(n)).map((n) => ({ id: n.id, title: n.title, icon: n.icon, path: path(n) }));
      },
      create: async (title: string) => {
        const n = await api.createNote({ title });
        await reload();
        return { id: n.id, title: n.title, icon: n.icon, path: "" };
      },
      open: (oid: string) => pick(oid),
      titleOf: (oid: string) => {
        const n = (listRef.current ?? []).find((x) => x.id === oid);
        return n ? display(n) : null;
      },
    }),
    [current, pick, reload],
  );

  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const pdfParent = useRef<string | null>(null);
  // Each PDF becomes a note of its own that opens as the document; the last one opens.
  const addPdfs = async (files: FileList | File[] | null, parentId: string | null) => {
    const pdfs = [...(files ?? [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return;
    try {
      await saver.flush();
      let last: Note | null = null;
      for (const f of pdfs) {
        const m = await uploadPdf(f);
        if (!m) continue;
        last = await api.createNote({ title: f.name.replace(/\.pdf$/i, ""), parentId, kind: "pdf", file: m.url });
      }
      if (!last) return;
      if (parentId) setOpen(parentId, true);
      if (!phone) setNotesPagesOpen(true);
      await reload();
      setNote(last);
      navigate(`/notes?id=${encodeURIComponent(last.id)}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const pickPdf = (parentId: string | null) => {
    pdfParent.current = parentId;
    pdfInput.current?.click();
  };
  const runImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const t = toast.loading("Importing…");
    try {
      await saver.flush();
      const drawings = [...files].filter((f) => /\.excalidraw(\.json)?$/i.test(f.name));
      let lastCanvas: string | null = null;
      for (const f of drawings) lastCanvas = (await api.importExcalidraw(await f.text(), f.name, null)).id;
      if (drawings.length === files.length) {
        await reload();
        toast.success(drawings.length === 1 ? "Imported the canvas" : `Imported ${drawings.length} canvases`, { id: t });
        if (lastCanvas) navigate(`/notes?id=${encodeURIComponent(lastCanvas)}`);
        return;
      }
      const r = await importPicked(files, null);
      await reload();
      toast.success(`Imported ${r.pages} page${r.pages === 1 ? "" : "s"}${r.pdfs ? `, ${r.pdfs} PDF${r.pdfs === 1 ? "" : "s"}` : ""}${r.files ? `, ${r.files} file${r.files === 1 ? "" : "s"}` : ""}${r.links ? `, ${r.links} link${r.links === 1 ? "" : "s"}` : ""}${r.unresolved ? ` (${r.unresolved} to pages that don't exist yet)` : ""}`, { id: t });
      const first = r.root ?? r.ids[0];
      if (first) navigate(`/notes?id=${encodeURIComponent(first)}`);
    } catch (e) {
      toast.error(`Couldn't import: ${(e as Error).message}`, { id: t });
    }
  };

  // What Notes' right-click menu in the sidebar does.
  useEffect(() => {
    registerNotesActions((a) => {
      if (a === "new") void add(null);
      else if (a === "new-canvas") void add(null, "canvas");
      else if (a === "new-file") void add(null, "file");
      else if (a === "new-folder") void addFolder(null);
      else if (a === "add-pdf") pickPdf(null);
      else if (a === "import-md") fileInput.current?.click();
      else if (a === "import-vault") folderInput.current?.click();
      else if (a === "fold-all") {
        localStorage.setItem(OPEN_KEY, "[]");
        setOpenSet(new Set());
      }
    });
    return () => registerNotesActions(null);
  }, [add, addFolder]);

  const dnd = useNoteTreeDrag({
    list,
    tree,
    open,
    setOpen,
    move: async (mid, parentId, index) => {
      await api.moveNote(mid, parentId, index);
      await reload();
    },
  });

  const top = tree.get(null) ?? [];
  const slot = useNotesSlot();
  // Desktop: the pages live only in the app sidebar, under the Notes row. Folded sidebar or pages hidden (click
  // Notes) means no tree anywhere. Phones have no sidebar, so there the tree is the list screen.
  const inSidebar = !phone && !!slot;
  const showTree = phone && !current;
  const showPage = !phone || !!current;
  const pickers = (
    <>
      <input ref={folderInput} type="file" className="hidden" {...({ webkitdirectory: "", directory: "" } as any)} multiple onChange={(e) => void runImport(e.target.files).finally(() => (e.target.value = ""))} />
      <input ref={fileInput} type="file" className="hidden" accept=".md,.markdown,text/markdown,.excalidraw,.json,.pdf,application/pdf,.py,.tex,.bib,.sty,.cls,.js,.ts,.tsx,.jsx,.c,.h,.cpp,.hpp,.java,.go,.rs,.m,.r,.jl,.sh,.sql,.yaml,.yml,.toml,.txt,.csv,.html,.css" multiple onChange={(e) => void runImport(e.target.files).finally(() => (e.target.value = ""))} />
      <input ref={pdfInput} type="file" className="hidden" accept=".pdf,application/pdf" multiple onChange={(e) => void addPdfs(e.target.files, pdfParent.current).finally(() => (e.target.value = ""))} />
    </>
  );
  const sidebarTree =
    inSidebar &&
    createPortal(
      <div role="tree" aria-label="Pages">
        {list === null ? null : top.length === 0 ? (
          <p className="sb-pages-empty">No pages yet. Right-click Notes to make one.</p>
        ) : (
          top.map((n) => <TreeRow key={n.id} n={n} depth={0} tree={tree} open={open} setOpen={setOpen} current={current} onPick={pick} onAdd={(p) => void add(p)} onMenu={rowMenu} menuItems={menuItems} inSidebar dnd={dnd} rename={rename} />)
        )}
      </div>,
      slot!,
    );

  // + in the top bar: a new top-level page, opened in a new tab next to this one.
  const newTab = async () => {
    try {
      await saver.flush();
      const n = await api.createNote({ title: "", parentId: null });
      await reload();
      setNote(n);
      pick(n.id, "new");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const tabPlus = phone ? null : (
    <button type="button" className="note-tab-plus" onClick={() => void newTab()} aria-label="New page in a new tab" title="New page in a new tab">
      <Plus className="size-4" />
    </button>
  );
  const tabStrip = phone ? null : <NoteTabs tabs={tabs} all={list ?? []} current={current} onPick={pick} onClose={closeTab} />;
  // NoteTabs renders nothing below two tabs; then the top bar shows the path as before.
  const shownTabs = tabs.filter((x) => list?.some((n) => n.id === x)).length;
  return (
    <div className="notes-shell">
      {pickers}
      {sidebarTree}
      {dnd.overlay}
      {showTree && (
        <aside className="notes-tree" aria-label="Pages">
          <div className="notes-tree-head">
            <span className="flex items-center gap-2 font-[650]">
              Notes <span className="sb-beta">beta</span>
            </span>
            <span className="flex items-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Import" title="Import Markdown or an Obsidian vault" className="note-row-act is-visible"><FolderInput className="size-4" /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem onSelect={() => folderInput.current?.click()}>Import a folder (Obsidian vault)…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => fileInput.current?.click()}>Import Markdown, code or .excalidraw files…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => pickPdf(null)}>Add a PDF…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" onClick={() => void add(null, "canvas")} aria-label="New canvas" title="New canvas" className="note-row-act is-visible">
                <PenTool className="size-4" />
              </button>
              <button type="button" onClick={() => void addFolder(null)} aria-label="New folder" title="New folder" className="note-row-act is-visible">
                <FolderPlus className="size-4" />
              </button>
              <button type="button" onClick={() => void add(null)} aria-label="New page" title="New page (Ctrl+Alt+N)" className="note-row-act is-visible">
                <FilePlus2 className="size-4" />
              </button>
            </span>
          </div>
          <div role="tree" className="notes-tree-list">
            {list === null ? null : top.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">No pages yet.</p>
            ) : (
              top.map((n) => <TreeRow key={n.id} n={n} depth={0} tree={tree} open={open} setOpen={setOpen} current={current} onPick={pick} onAdd={(p) => void add(p)} onMenu={rowMenu} menuItems={menuItems} dnd={dnd} rename={rename} />)
            )}
            <button type="button" onClick={() => void add(null)} className="note-row note-new">
              <Plus className="size-3.5" /> New page
            </button>
            <button type="button" onClick={() => void add(null, "canvas")} className="note-row note-new">
              <PenTool className="size-3.5" /> New canvas
            </button>
            <button type="button" onClick={() => void add(null, "file")} className="note-row note-new">
              <FileCode2 className="size-3.5" /> New code file
            </button>
          </div>
        </aside>
      )}
      {showPage && (
        <NoteTabsCtx.Provider value={shownTabs > 1 ? tabStrip : null}>
        <NotePlusCtx.Provider value={tabPlus}>
        <section className="notes-main">
          {note && note.id === current && isFile(note) ? (
            <FileView
              key={note.id}
              note={note}
              all={list ?? []}
              saveState={saver.state}
              onPick={pick}
              onTitle={(title) => {
                patchRow(note.id, { title });
                saver.queue({ title });
              }}
              onContent={(content) => saver.queue({ content })}
              onSave={() => void saver.flush()}
              onBack={phone ? () => navigate("/notes") : undefined}
            />
          ) : note && note.id === current && note.kind === "pdf" ? (
            <PdfNoteView
              key={note.id}
              note={note}
              all={list ?? []}
              onPick={pick}
            />
          ) : note && note.id === current && note.kind === "canvas" ? (
            <CanvasView
              key={note.id}
              note={note}
              all={list ?? []}
              saveState={saver.state}
              onPick={pick}
              onTitle={(title) => {
                patchRow(note.id, { title });
                saver.queue({ title });
              }}
              onScene={(scene) => saver.queue({ scene })}
            />
          ) : note && note.id === current && isFolder(note) ? (
            <FolderView
              folder={note}
              kids={tree.get(note.id) ?? []}
              onPick={pick}
              onAdd={() => void add(note.id)}
              onAddFolder={() => void addFolder(note.id)}
              onMakePage={() => void setKind(note, "page")}
              onOpenFolder={(fid) => setOpen(fid, true)}
              onBack={phone ? () => navigate("/notes") : undefined}
            />
          ) : note && note.id === current ? (
            <PageView
              key={note.id}
              note={note}
              tree={tree}
              all={list ?? []}
              saveState={saver.state}
              onPick={pick}
              onTitle={(title) => {
                patchRow(note.id, { title });
                saver.queue({ title });
              }}
              onDoc={(doc) => saver.queue({ doc })}
              onIcon={(icon) => {
                patchRow(note.id, { icon });
                void api.updateNote(note.id, { icon }).catch((e) => toast.error((e as Error).message));
              }}
              onLook={(look) => void api.updateNote(note.id, { look }).catch((e) => toast.error((e as Error).message))}
              links={links}
              onBack={phone ? () => navigate("/notes") : undefined}
            />
          ) : list && list.length === 0 ? (
            <div className="notes-empty">
              <div className="text-[2.4rem]" aria-hidden>📝</div>
              <h1 className="note-empty-title">Your first page</h1>
              <p className="max-w-sm text-[14px] text-muted-foreground">Notes live next to your decks. Type <kbd>/</kbd> for blocks, <kbd>[[</kbd> to link a page, <kbd>#</kbd> for a heading. Everything saves on its own.</p>
              <p className="max-w-sm text-[13px] text-muted-foreground/80">Notes is in beta: expect rough edges, and it doesn't sync to your other devices yet.</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => void add(null)} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <FilePlus2 className="size-4" /> New page
                </button>
                <button type="button" onClick={() => folderInput.current?.click()} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <FolderInput className="size-4" /> Import a vault
                </button>
              </div>
            </div>
          ) : null}
        </section>
        </NotePlusCtx.Provider>
        </NoteTabsCtx.Provider>
      )}
    </div>
  );
}
