// Notes (beta): a tree of pages on the left, the open page on the right. Every change saves on its own
// (a short pause after you stop typing, and when you leave the page). On a phone the tree is the list
// screen and a page opens on its own.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ArrowUpRight, Check, ChevronRight, Download, FileCode2, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, GraduationCap, ImagePlus, MoreHorizontal, PenTool, Plus, Smile, X } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { registerNotesActions, setNotesPagesOpen, useNotesSlot } from "@/lib/sidebar-slot";
import { NoteStart, StartTabIcon, isStartTab, newStartTab, startShortcut } from "@/components/note-start";
import { useNoteTreeDrag, type Placement } from "@/components/note-tree-drag";
import { activate, canSplitTo, dropPage, closeTab as closeLayoutTab, count, findPane, focus as focusLayout, focusedPane, MAX_PANES, moveTab, normalizeLayout, openIn, openSplit, panes, prune, rects, setRatio, single, type Layout, type PaneNode, type Rect, type Side, type TabDrop } from "@/lib/note-layout";

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
/** The small grey tag after a name that isn't a plain page, as Obsidian marks PDF and CANVAS. A file's name already ends in its extension. */
const kindTag = (n: { kind?: string }): string | null => (n.kind === "pdf" ? "PDF" : n.kind === "canvas" ? "CANVAS" : null);

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
type DragProps = { start(n: NoteSummary, e: React.PointerEvent<HTMLElement>): void; draggingId: string | null; draggingMany: boolean; targetId: string | null };
/** The row whose name is being typed in place (a new folder, or Rename). */
type RenameProps = { id: string | null; done(id: string, title: string | null): void };
/** Several pages picked at once with Shift+click, to move, archive or open together. */
type SelectProps = { ids: Set<string>; shift(id: string): void; clear(): void };

function TreeRow({ n, depth, tree, open, setOpen, current, onPick, onAdd, onMenu, menuItems, inSidebar, dnd, rename, sel }: {
  sel: SelectProps;
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
  const picked = sel.ids.has(n.id);
  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        role="treeitem"
        aria-selected={on}
        aria-expanded={kids.length ? expanded : undefined}
        data-note-row={n.id}
        className={cn("note-row group", on && "is-on", picked && "is-sel", (dnd.draggingId === n.id || (dnd.draggingMany && picked)) && "is-dragged", dnd.targetId === n.id && "is-drop-into")}
        data-kind={folder ? "folder" : "page"}
        onPointerDown={(e) => !editing && dnd.start(n, e)}
        // In the sidebar the pages start under the word Notes and nest by indent only.
        style={{ paddingLeft: (inSidebar ? 28 : 6) + depth * 16 }}
        // A folder has no page of its own: clicking it opens or closes it.
        // Ctrl/⌘+click or a middle click opens the page in a new tab.
        // Shift+click picks a run of pages, from the last one picked (or the open page) to this one.
        onClick={(e) => {
          if (editing) return;
          if (e.shiftKey) return void (e.preventDefault(), sel.shift(n.id));
          if (sel.ids.size) sel.clear();
          if (folder) setOpen(n.id, !expanded);
          else onPick(n.id, e.ctrlKey || e.metaKey ? "background" : undefined);
        }}
        onContextMenu={() => !picked && sel.ids.size && sel.clear()}
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
        {/* Like Obsidian, the list shows names only; a page's icon shows here when you ask for it (right-click → Show icon). */}
        {n.look?.showIcon && (
          <span className="note-row-icon" aria-hidden>
            {folder && !n.icon ? (expanded && kids.length ? <FolderOpen className="size-4" /> : <Folder className="size-4" />) : isFile(n) && !n.icon ? <FileCode2 className="size-4" /> : <NoteIcon icon={n.icon} size={18} fallback={fallbackIcon(n)} />}
          </span>
        )}
        {editing ? (
          <RenameInput initial={n.title || (folder ? "New folder" : "")} onDone={(t) => rename.done(n.id, t)} />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", !n.title.trim() && "text-muted-foreground")}>{display(n)}</span>
        )}
        {!editing && kindTag(n) && <span className="note-row-tag">{kindTag(n)}</span>}
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
      {expanded && kids.map((k) => <TreeRow key={k.id} n={k} depth={depth + 1} tree={tree} open={open} setOpen={setOpen} current={current} onPick={onPick} onAdd={onAdd} onMenu={onMenu} menuItems={menuItems} inSidebar={inSidebar} dnd={dnd} rename={rename} sel={sel} />)}
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
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
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
function FileView({ note, all, onContent, saveState, onPick, onSave, onBack }: {
  note: Note;
  all: NoteSummary[];
  onTitle(t: string): void;
  onContent(c: string): void;
  saveState: SaveState;
  onPick(id: string): void;
  onSave(): void;
  onBack?: () => void;
}) {
  // The name lives in the tab and the sidebar; Rename there changes it, and the highlighting follows.
  const t = note.title;
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
  useEffect(() => ed.current?.setName(t), [t]);
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
        {!strip && (
          <nav aria-label="Path" className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
            {crumbs.map((c) => (
              <span key={c.id} className="flex min-w-0 items-center gap-1">
                <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
                <ChevronRight className="size-3 shrink-0 opacity-60" />
              </span>
            ))}
            <span className="note-file-name truncate px-1 text-foreground/80">{t || "untitled.txt"}</span>
          </nav>
        )}
        {plus}
        <span className="flex-1" />
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

/** New file: asks for the name with its extension first, since the extension is what decides the language. */
function NewFileDialog({ open, onClose, onCreate }: { open: boolean; onClose(): void; onCreate(name: string): void }) {
  const [name, setName] = useState("");
  useEffect(() => void (open && setName("")), [open]);
  const clean = name.trim();
  const bad = /[\\/:*?"<>|]/.test(clean);
  const lang = clean ? (/\.m$/i.test(clean) ? "MATLAB" : fileLanguage(clean)?.name ?? null) : null;
  const ok = !!clean && !bad;
  const submit = () => ok && onCreate(clean);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="note-newfile sm:max-w-[26rem]" onOpenAutoFocus={(e) => (e.preventDefault(), (e.currentTarget as HTMLElement).querySelector("input")?.focus())}>
        <DialogTitle className="text-[17px]">New file</DialogTitle>
        <DialogDescription className="text-[13px]">Type the name with its extension, like main.py or report.tex. The extension picks the language.</DialogDescription>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="main.py"
            aria-label="File name"
            spellCheck={false}
            autoComplete="off"
            maxLength={200}
            className="note-newfile-input"
          />
          <div className={cn("flex min-h-[18px] items-center gap-1.5 text-[12.5px]", bad ? "text-[var(--danger)]" : "text-muted-foreground")} aria-live="polite">
            {bad ? (
              "A name can't have / \\ : * ? \" < > |"
            ) : clean ? (
              <>
                <FileCode2 className="size-3.5" /> {lang ?? "Plain text"}
              </>
            ) : null}
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="lib-raised inline-flex h-9 items-center rounded-[10px] px-4 text-[14px] font-[600]">Cancel</button>
            <button type="submit" disabled={!ok} className="lib-primary inline-flex h-9 items-center rounded-[10px] px-4 text-[14px] font-[600] disabled:opacity-50">Create</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- tabs

/** One pane's open pages as tabs in its top bar. Drag a tab to reorder it, to another pane, or to a pane's
 *  edge to split. Middle click or × closes one; right-click has Split right / Split down. */
function NoteTabs({ pane, tabs, all, current, onPick, onClose, onDrag, menu, dragging }: {
  pane: string;
  tabs: string[];
  all: NoteSummary[];
  current: string | null;
  onPick(id: string): void;
  onClose(id: string): void;
  onDrag(id: string, e: React.PointerEvent<HTMLElement>): void;
  menu(id: string): MenuEntry[];
  dragging: string | null;
}) {
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
  const shown = tabs.filter((t) => by.has(t) || isStartTab(t));
  return (
    <div ref={strip} role="tablist" aria-label="Open pages" data-tabs-of={pane} className={cn("note-tabs", over.l && "fade-l", over.r && "fade-r")}>
      {shown.map((tid) => {
        // A New tab (the start page) isn't a note: it's called New tab and has an empty-page icon.
        const n = by.get(tid) ?? { id: tid, title: "New tab", kind: "page" as const, icon: null };
        const start = isStartTab(tid);
        const on = tid === current;
        return (
          <ContextMenu key={tid}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                title={display(n)}
                data-tab={tid}
                className={cn("note-tab group", on && "is-on", dragging === tid && "is-dragging")}
                onPointerDown={(e) => onDrag(tid, e)}
                onClick={() => onPick(tid)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => e.button === 1 && onClose(tid)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(tid))}
              >
                <span className="note-tab-icon" aria-hidden>{start ? <StartTabIcon /> : isFile(n) && !n.icon ? <FileCode2 className="size-3.5" /> : <NoteIcon icon={n.icon} size={15} />}</span>
                <span className={cn("min-w-0 flex-1 truncate", !n.title.trim() && "text-muted-foreground")}>{display(n)}</span>
                <button
                  type="button"
                  aria-label={`Close ${display(n)}`}
                  className="note-tab-x"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tid);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
              {menu(tid).map((m, i) =>
                m === "sep" ? <ContextMenuSeparator key={i} /> : (
                  <ContextMenuItem key={i} disabled={m.disabled} variant={m.danger ? "destructive" : "default"} onSelect={m.onSelect}>{m.label}</ContextMenuItem>
                ),
              )}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- a pane

/** What every pane needs from the screen. */
type PaneCtx = {
  phone: boolean;
  list: NoteSummary[] | null;
  tree: Tree;
  listRef: React.MutableRefObject<NoteSummary[] | null>;
  primed: Map<string, Note>;
  bumps: Record<string, number>;
  flushers: Set<() => Promise<void>>;
  patchRow(id: string, p: Partial<NoteSummary>): void;
  pick(pane: string, id: string, mode?: "replace" | "new" | "background"): void;
  focus(pane: string): void;
  missing(pane: string, id: string): void;
  add(parentId: string | null, kind?: "page" | "canvas" | "file", title?: string): Promise<void>;
  addFolder(parentId: string | null): Promise<void>;
  setKind(n: NoteSummary, kind: "page" | "folder"): Promise<void>;
  setOpen(id: string, on: boolean): void;
  reload(): Promise<void>;
  importVault(): void;
  addTutorial(): void;
  importMd(): void;
  pickPdf(parentId: string | null): void;
  newFile(): void;
  setPinned(ids: string[], on: boolean): Promise<void>;
  createFromStart(pane: string, title: string, newTab: boolean): Promise<void>;
};

/** One open page and its own top bar, editor and saving. With one pane it scrolls with the window, as before. */
function NotePane({ pane, noteId, ctx, focused, strip, plus }: {
  pane: string;
  noteId: string | null;
  ctx: PaneCtx;
  focused: boolean;
  strip: React.ReactNode;
  plus: React.ReactNode;
}) {
  const { list, tree, phone } = ctx;
  const [note, setNote] = useState<Note | null>(null);
  const bump = noteId ? (ctx.bumps[noteId] ?? 0) : 0;
  const seen = useRef<{ id: string | null; bump: number }>({ id: null, bump: 0 });
  useEffect(() => {
    if (!noteId || isStartTab(noteId)) return setNote(null);
    const p = ctx.primed.get(noteId);
    if (p) {
      ctx.primed.delete(noteId);
      seen.current = { id: noteId, bump };
      return setNote(p);
    }
    if (seen.current.id === noteId && seen.current.bump === bump && note?.id === noteId) return;
    seen.current = { id: noteId, bump };
    let live = true;
    api.note(noteId).then((n) => live && setNote(n)).catch(() => live && ctx.missing(pane, noteId));
    return () => void (live = false);
  }, [noteId, bump]);

  const saver = useSaver(noteId, (n) => ctx.patchRow(n.id, { title: n.title, updated: n.updated }));
  useEffect(() => {
    ctx.flushers.add(saver.flush);
    return () => void ctx.flushers.delete(saver.flush);
  }, [saver.flush]);

  const onPick = useCallback((oid: string) => ctx.pick(pane, oid), [ctx.pick, pane]);
  // What [[links]] in the editor see: the pages as they are now. A link opens in this pane.
  const links: NoteLinkOptions = useMemo(
    () => ({
      pages: (q: string): PageRef[] => {
        const all = ctx.listRef.current ?? [];
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
        return hits.filter((n) => n.id !== noteId && !isFolder(n)).map((n) => ({ id: n.id, title: n.title, icon: n.icon, path: path(n) }));
      },
      create: async (title: string) => {
        const n = await api.createNote({ title });
        await ctx.reload();
        return { id: n.id, title: n.title, icon: n.icon, path: "" };
      },
      open: (oid: string) => ctx.pick(pane, oid),
      titleOf: (oid: string) => {
        const n = (ctx.listRef.current ?? []).find((x) => x.id === oid);
        return n ? display(n) : null;
      },
    }),
    [noteId, pane, ctx.pick, ctx.reload],
  );

  // A rename in the sidebar shows here too (canvases and files show the name from the note).
  const row = noteId ? list?.find((n) => n.id === noteId) : undefined;
  const shown = note && note.id === noteId ? (row && row.title !== note.title ? { ...note, title: row.title } : note) : null;
  const back = phone ? () => navigate("/notes") : undefined;
  return (
    <NoteTabsCtx.Provider value={strip}>
      <NotePlusCtx.Provider value={plus}>
        <section
          data-pane={pane}
          className={cn("notes-main note-pane", focused && "is-focus")}
          onPointerDownCapture={() => ctx.focus(pane)}
          onFocusCapture={() => ctx.focus(pane)}
        >
          {isStartTab(noteId) ? (
            list && (
              <NoteStart
                key={noteId}
                list={list}
                phone={phone}
                bar={
                  <div className="note-topbar">
                    {strip ?? <span className="ns-tabname"><StartTabIcon /> New tab</span>}
                    {plus}
                    <span />
                  </div>
                }
                onOpen={(oid, tab) => ctx.pick(pane, oid, tab ?? "replace")}
                onCreate={(title, nt) => void ctx.createFromStart(pane, title, nt)}
                onPin={(n, on) => void ctx.setPinned([n.id], on)}
                actions={{
                  page: () => void ctx.add(null),
                  canvas: () => void ctx.add(null, "canvas"),
                  file: ctx.newFile,
                  folder: () => void ctx.addFolder(null),
                  pdf: () => ctx.pickPdf(null),
                  importMd: ctx.importMd,
                  importVault: ctx.importVault,
                }}
              />
            )
          ) : shown && isFile(shown) ? (
            <FileView
              key={shown.id}
              note={shown}
              all={list ?? []}
              saveState={saver.state}
              onPick={onPick}
              onTitle={(title) => {
                ctx.patchRow(shown.id, { title });
                saver.queue({ title });
              }}
              onContent={(content) => saver.queue({ content })}
              onSave={() => void saver.flush()}
              onBack={back}
            />
          ) : shown && shown.kind === "pdf" ? (
            <PdfNoteView key={shown.id} note={shown} all={list ?? []} onPick={onPick} />
          ) : shown && shown.kind === "canvas" ? (
            <CanvasView
              key={shown.id}
              note={shown}
              all={list ?? []}
              saveState={saver.state}
              onPick={onPick}
              onTitle={(title) => {
                ctx.patchRow(shown.id, { title });
                saver.queue({ title });
              }}
              onScene={(scene) => saver.queue({ scene })}
            />
          ) : shown && isFolder(shown) ? (
            <FolderView
              folder={shown}
              kids={tree.get(shown.id) ?? []}
              onPick={onPick}
              onAdd={() => void ctx.add(shown.id)}
              onAddFolder={() => void ctx.addFolder(shown.id)}
              onMakePage={() => void ctx.setKind(shown, "page")}
              onOpenFolder={(fid) => ctx.setOpen(fid, true)}
              onBack={back}
            />
          ) : shown ? (
            <PageView
              key={shown.id}
              note={shown}
              tree={tree}
              all={list ?? []}
              saveState={saver.state}
              onPick={onPick}
              onTitle={(title) => {
                ctx.patchRow(shown.id, { title });
                saver.queue({ title });
              }}
              onDoc={(doc) => saver.queue({ doc })}
              onIcon={(icon) => {
                ctx.patchRow(shown.id, { icon });
                void api.updateNote(shown.id, { icon }).catch((e) => toast.error((e as Error).message));
              }}
              onLook={(look) => {
                // The page keeps its own copy of the look; the list icon may have changed in the sidebar since, so that part comes from the row.
                const row = ctx.listRef.current?.find((x) => x.id === shown.id);
                const next: NoteLook = { ...look };
                if (row?.look?.showIcon) next.showIcon = true;
                else delete next.showIcon;
                ctx.patchRow(shown.id, { look: next });
                void api.updateNote(shown.id, { look: next }).catch((e) => toast.error((e as Error).message));
              }}
              links={links}
              onBack={back}
            />
          ) : list && list.length === 0 ? (
            <div className="notes-empty">
              <div className="text-[2.4rem]" aria-hidden>📝</div>
              <h1 className="note-empty-title">Your first page</h1>
              <p className="max-w-sm text-[14px] text-muted-foreground">Notes live next to your decks. Type <kbd>/</kbd> for blocks, <kbd>[[</kbd> to link a page, <kbd>#</kbd> for a heading. Everything saves on its own.</p>
              <p className="max-w-sm text-[13px] text-muted-foreground/80">Notes is in beta: expect rough edges, and it doesn't sync to your other devices yet.</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => void ctx.add(null)} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <FilePlus2 className="size-4" /> New page
                </button>
                <button type="button" onClick={ctx.importVault} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <FolderInput className="size-4" /> Import a vault
                </button>
                <button type="button" onClick={ctx.addTutorial} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <GraduationCap className="size-4" /> Notes tutorial
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </NotePlusCtx.Provider>
    </NoteTabsCtx.Provider>
  );
}

// ---------------------------------------------------------------- dragging tabs

type TabDragView = { pane: string; note: string; label: string; x: number; y: number; drop: TabDrop | null; zone: Rect | null; line: Rect | null };

/** The part of a pane you can see, in viewport pixels: its own box when split (it scrolls inside), the window otherwise. */
function visibleRect(el: Element): Rect {
  const r = (el.closest(".is-multi .note-pane-box") ?? el).getBoundingClientRect();
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  return { x: r.left, y: top, w: r.width, h: Math.max(0, bottom - top) };
}

/** Where a tab dragged from `from` would land under the pointer, and what to draw for it. */
function hitTabDrop(l: Layout, from: string | null, note: string, x: number, y: number): Pick<TabDragView, "drop" | "zone" | "line"> {
  const none = { drop: null, zone: null, line: null };
  const el = document.elementFromPoint(x, y);
  const paneEl = el?.closest<HTMLElement>("[data-pane]");
  const pid = paneEl?.dataset.pane;
  if (!paneEl || !pid || !findPane(l.root, pid)) return none;
  // Over a pane's top bar: among its tabs, before the one whose middle is right of the pointer.
  const bar = el!.closest(".note-topbar");
  if (bar && paneEl.contains(bar)) {
    const tabs = [...paneEl.querySelectorAll<HTMLElement>(".note-tab[data-tab]")].filter((t) => t.dataset.tab !== note);
    const next = tabs.find((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2 > x;
    });
    const br = bar.getBoundingClientRect();
    const ref = next ?? tabs[tabs.length - 1];
    const lx = ref ? (next ? ref.getBoundingClientRect().left - 2 : ref.getBoundingClientRect().right + 1) : br.left + 16;
    return { drop: { pane: pid, before: next?.dataset.tab ?? null }, zone: null, line: { x: lx, y: br.top + 8, w: 2, h: br.height - 16 } };
  }
  // Over the page: near an edge splits that side; the middle of another pane joins its tabs.
  const R = visibleRect(paneEl);
  if (R.w < 40 || R.h < 40) return none;
  const fx = (x - R.x) / R.w;
  const fy = (y - R.y) / R.h;
  const edges: [Side, number][] = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
  const [side, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  const inset = (z: Rect): Rect => ({ x: z.x + 6, y: z.y + 6, w: z.w - 12, h: z.h - 12 });
  // A page from the sidebar that's already open somewhere drags like that tab.
  const owner = from ?? panes(l.root).find((p) => p.tabs.includes(note))?.id ?? null;
  const splittable = owner ? canSplitTo(l, owner, note, pid) : count(l.root) < MAX_PANES;
  if (d < 0.32 && splittable) {
    const zone = side === "left" ? { ...R, w: R.w / 2 } : side === "right" ? { ...R, x: R.x + R.w / 2, w: R.w / 2 } : side === "top" ? { ...R, h: R.h / 2 } : { ...R, y: R.y + R.h / 2, h: R.h / 2 };
    return { drop: { pane: pid, side }, zone: inset(zone), line: null };
  }
  if (pid !== owner) return { drop: { pane: pid, before: null }, zone: inset(R), line: null };
  return none;
}

// ---------------------------------------------------------------- the screen

const LAYOUT_KEY = "etude.notes.layout";
function loadLayout(): Layout {
  try {
    const v = normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
    if (v) return v;
  } catch {}
  // Before split view the tabs were one list.
  try {
    const old = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]");
    if (Array.isArray(old)) return single(old.filter((x) => typeof x === "string"));
  } catch {}
  return single([]);
}

export function NotesPage({ id }: { id: string | null }) {
  const phone = usePhone();
  const [list, setList] = useState<NoteSummary[] | null>(null);
  const [open, setOpenSet] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]")));
  const tree = useMemo(() => treeOf(list ?? []), [list]);
  const [renaming, setRenaming] = useState<string | null>(null);
  // New file asks for its name first: undefined = closed, otherwise the parent it goes in.
  const [newFileIn, setNewFileIn] = useState<string | null | undefined>(undefined);
  // A note just made, handed to the pane that opens it so it shows without a reload.
  const primed = useRef(new Map<string, Note>()).current;
  // Bumping a note's number makes the pane showing it read it again (it turned into a folder or a page).
  const [bumps, setBumps] = useState<Record<string, number>>({});
  const bumpNote = (nid: string) => setBumps((b) => ({ ...b, [nid]: (b[nid] ?? 0) + 1 }));
  // Each pane's saver; flushed before tabs move between panes, so the new pane reads what was typed.
  const flushers = useRef(new Set<() => Promise<void>>()).current;
  const flushAll = useCallback(() => Promise.all([...flushers].map((f) => f())).then(() => {}), [flushers]);

  const reload = useCallback(async () => setList(await api.notes()), []);
  // The first time Notes opens on a collection it gets the tutorial (once: archived or deleted, it stays gone).
  const seeded = useRef<{ root: string; start: string | null } | null>(null);
  useEffect(() => {
    void api
      .notesTutorial(true)
      .then((r) => void (r.added && r.root && (seeded.current = { root: r.root, start: r.start })), () => {})
      .then(reload)
      .catch((e) => toast.error((e as Error).message));
  }, [reload]);
  // A canvas made from a page's /canvas block shows up in the tree.
  useEffect(() => {
    const h = () => void reload().catch(() => {});
    window.addEventListener("etude:notes-changed", h);
    return () => window.removeEventListener("etude:notes-changed", h);
  }, [reload]);

  // The title in the tree follows what's typed, before it's saved.
  const patchRow = useCallback((rid: string, p: Partial<NoteSummary>) => setList((l) => l?.map((n) => (n.id === rid ? { ...n, ...p } : n)) ?? l), []);
  const listRef = useRef(list);
  listRef.current = list;

  // ---- panes and their tabs. Desktop only: a phone shows one page at a time, from the address.
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)), [layout]);
  const multi = !phone && count(layout.root) > 1;
  const current = phone ? id : (focusedPane(layout)?.active ?? null);

  // The address opens a page in the focused pane (a plain click in the sidebar, a link, Ctrl+K), or goes to the
  // pane where it's already open. With nothing open, the first page opens.
  const lastId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (phone || !list) return;
    if (lastId.current === id) return;
    lastId.current = id;
    // No page in the address (Notes clicked in the sidebar, the last tab closed): a New tab, the one already open, else a new one.
    const l = layoutRef.current;
    const target = id ?? panes(l.root).flatMap((p) => p.tabs).find(isStartTab) ?? newStartTab();
    setLayout((l) => {
      const owner = panes(l.root).find((p) => p.tabs.includes(target));
      return owner ? activate(l, owner.id, target) : openIn(l, l.focus, target, id ? "replace" : "new");
    });
  }, [id, list, phone]);
  // Just added: its folder unfolds and Start here opens, unless the address asked for another page.
  useEffect(() => {
    const s = seeded.current;
    if (!s || !list) return;
    seeded.current = null;
    setOpen(s.root, true);
    if (!id && s.start) navigate(`/notes?id=${encodeURIComponent(s.start)}`, { replace: true });
  }, [list]);
  // …and the address follows the focused pane's page, so a reload comes back to it.
  const lastActive = useRef(current);
  useEffect(() => {
    if (phone || lastActive.current === current) return;
    lastActive.current = current;
    lastId.current = current;
    if (current !== id) navigate(current ? `/notes?id=${encodeURIComponent(current)}` : "/notes", { replace: true });
  }, [current, phone]);
  // Opening a note tells the server, for the start page's Jump back in (folders don't count, the server knows).
  useEffect(() => {
    if (!current || isStartTab(current)) return;
    let live = true;
    api.noteOpened(current).then((n) => live && patchRow(n.id, { opened: n.opened }), () => {});
    return () => void (live = false);
  }, [current]);
  // Pages that were archived or deleted leave their tabs.
  useEffect(() => {
    if (!list) return;
    const ids = new Set(list.map((n) => n.id));
    setLayout((l) => prune(l, (x) => ids.has(x) || isStartTab(x)));
  }, [list]);

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

  /** Opening a page in a pane: a plain click replaces the pane's current tab, like a browser; "new" opens a tab
   *  next to it, "background" adds it without going there. A page already open in another pane goes there. */
  const pickIn = useCallback(
    (pane: string, pid: string, mode: "replace" | "new" | "background" = "replace") => {
      if (phone) return navigate(`/notes?id=${encodeURIComponent(pid)}`);
      setLayout((l) => {
        const owner = panes(l.root).find((p) => p.tabs.includes(pid));
        if (owner) return mode === "background" ? l : activate(l, owner.id, pid);
        const next = openIn(l, pane, pid, mode);
        return mode === "background" ? next : focusLayout(next, pane);
      });
    },
    [phone],
  );
  const pick = useCallback((pid: string, tab?: TabMode) => pickIn(layoutRef.current.focus, pid, tab ?? "replace"), [pickIn]);
  const focusPane = useCallback((pane: string) => setLayout((l) => focusLayout(l, pane)), []);
  const closeTabIn = useCallback((pane: string, tid: string) => {
    setLayout((l) => {
      const p = findPane(l.root, pane);
      if (!p) return l;
      // Closing the last tab leaves a New tab, like a browser.
      if (count(l.root) === 1 && p.tabs.length <= 1) return isStartTab(tid) ? l : openIn(l, pane, newStartTab(), "replace");
      return closeLayoutTab(l, pane, tid);
    });
  }, []);

  /** A page in a new pane beside one (the focused pane unless said), moving it there if it's open elsewhere. */
  const sideLayout = (pid: string, side: Side, beside?: string): Layout | null => {
    const l = layoutRef.current;
    const target = beside ?? l.focus;
    const owner = panes(l.root).find((p) => p.tabs.includes(pid));
    return owner ? moveTab(l, owner.id, pid, { pane: target, side }) : openSplit(l, target, pid, side);
  };
  const openSide = async (pid: string, side: Side, beside?: string) => {
    if (!sideLayout(pid, side, beside)) {
      toast(count(layoutRef.current.root) >= MAX_PANES ? "Up to four pages side by side" : "It's already open there on its own");
      return;
    }
    await flushAll();
    const next = sideLayout(pid, side, beside);
    if (next) setLayout(() => next);
  };

  // Dragging a tab: to reorder it, to another pane's tabs or middle, or to a pane's edge to split it.
  const [tabDrag, setTabDrag] = useState<TabDragView | null>(null);
  const dragEnded = useRef(0);
  const startTabDrag = (pane: string, note: string, e: React.PointerEvent<HTMLElement>) => {
    if (phone || e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const n = listRef.current?.find((x) => x.id === note);
    const label = n ? display(n) : "Page";
    let on = false;
    let hit: Pick<TabDragView, "drop" | "zone" | "line"> = { drop: null, zone: null, line: null };
    const move = (ev: PointerEvent) => {
      if (!on) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        on = true;
        document.body.classList.add("note-tab-dragging");
      }
      hit = hitTabDrop(layoutRef.current, pane, note, ev.clientX, ev.clientY);
      setTabDrag({ pane, note, label, x: ev.clientX, y: ev.clientY, ...hit });
    };
    const end = (apply: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("note-tab-dragging");
      setTabDrag(null);
      if (!on) return;
      dragEnded.current = performance.now();
      const drop = hit.drop;
      if (apply && drop)
        void flushAll().then(() => {
          setLayout((l) => moveTab(l, pane, note, drop) ?? l);
        });
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  // Dragging the line between two panes resizes them; double-click puts it back in the middle.
  const area = useRef<HTMLDivElement>(null);
  const startResize = (bar: { path: string; dir: "row" | "col"; x: number; y: number; w: number; h: number }, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !area.current) return;
    e.preventDefault();
    const C = area.current.getBoundingClientRect();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.dataset.on = "";
    document.body.classList.add("note-split-resizing", bar.dir === "row" ? "is-row" : "is-col");
    const size = bar.dir === "row" ? bar.w * C.width : bar.h * C.height;
    const min = Math.min(0.45, 220 / Math.max(size, 1));
    const move = (ev: PointerEvent) => {
      const f = bar.dir === "row" ? ((ev.clientX - C.left) / C.width - bar.x) / bar.w : ((ev.clientY - C.top) / C.height - bar.y) / bar.h;
      const r = Math.max(min, Math.min(1 - min, f));
      setLayout((l) => ({ ...l, root: setRatio(l.root, bar.path, r) }));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      delete el.dataset.on;
      document.body.classList.remove("note-split-resizing", "is-row", "is-col");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // A fresh copy of the tutorial, on demand (right-click Notes, or the empty Notes page).
  const addTutorial = useCallback(async () => {
    const t = toast.loading("Adding the Notes tutorial…");
    try {
      const r = await api.notesTutorial(false);
      if (!phone) setNotesPagesOpen(true);
      await reload();
      if (r.root) setOpen(r.root, true);
      if (r.start) navigate(`/notes?id=${encodeURIComponent(r.start)}`);
      toast.success("Added the Notes tutorial", { id: t, description: "The Notes showcase folder, with its cards in Notes::Notes showcase." });
    } catch (e) {
      toast.error(`Couldn't add the tutorial: ${(e as Error).message}`, { id: t });
    }
  }, [reload, setOpen, phone]);
  const add = useCallback(
    async (parentId: string | null, kind: "page" | "canvas" | "file" = "page", title = "") => {
      try {
        const n = await api.createNote({ title, parentId, kind });
        if (parentId) setOpen(parentId, true);
        await reload();
        primed.set(n.id, n);
        navigate(`/notes?id=${encodeURIComponent(n.id)}`);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [reload, setOpen, primed],
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
        void api.updateNote(rid, { title }).catch((e) => toast.error((e as Error).message));
      },
    }),
    [renaming, patchRow],
  );
  const setKind = useCallback(
    async (n: NoteSummary, kind: "page" | "folder") => {
      try {
        await flushAll();
        await api.updateNote(n.id, { kind });
        await reload();
        bumpNote(n.id);
        if (kind === "page") navigate(`/notes?id=${encodeURIComponent(n.id)}`);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [flushAll, reload],
  );

  // Ctrl/⌘+Alt+N / C / F: a new page, canvas or file at the top level (never AltGr, which types characters).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const k = startShortcut(e);
      if (!k || e.defaultPrevented) return;
      e.preventDefault();
      if (k === "file") setNewFileIn(null);
      else void add(null, k);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [add]);

  const archive = async (n: NoteSummary) => {
    await flushAll();
    const r = await api.setNoteArchived(n.id, true);
    await reload();
    if (phone && id && r.ids.includes(id)) navigate("/notes", { replace: true });
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

  // ---- several pages at once (Shift+click)
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const sel = useMemo<SelectProps>(
    () => ({
      ids: picked,
      clear: () => {
        anchor.current = null;
        setPicked(new Set());
      },
      shift: (id) => {
        // The pages in the order they show in the tree right now.
        const rows = [...document.querySelectorAll<HTMLElement>("[role=tree] [data-note-row]")].map((r) => r.dataset.noteRow!);
        const from = anchor.current && rows.includes(anchor.current) ? anchor.current : current && rows.includes(current) ? current : id;
        anchor.current = from;
        const a = rows.indexOf(from), b = rows.indexOf(id);
        setPicked(new Set(a < 0 || b < 0 ? [id] : rows.slice(Math.min(a, b), Math.max(a, b) + 1)));
      },
    }),
    [picked, current],
  );
  // Esc lets go of them; so does the list changing under them.
  useEffect(() => {
    if (!picked.size) return;
    // An open menu takes its own Esc; only a second Esc lets go of the pages.
    const h = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=menu]") && sel.clear();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [picked, sel]);
  useEffect(() => {
    if (!list || !picked.size) return;
    const ids = new Set(list.map((n) => n.id));
    if ([...picked].some((x) => !ids.has(x))) setPicked(new Set([...picked].filter((x) => ids.has(x))));
  }, [list]);
  /** The picked pages without the ones inside another picked page (those go along with their parent), in tree order. */
  const outermost = useCallback((): string[] => {
    const by = new Map((listRef.current ?? []).map((n) => [n.id, n]));
    const inPicked = (id: string) => {
      for (let p = by.get(id)?.parentId ?? null; p; p = by.get(p)?.parentId ?? null) if (picked.has(p)) return true;
      return false;
    };
    return (listRef.current ?? []).filter((n) => picked.has(n.id) && !inPicked(n.id)).map((n) => n.id);
  }, [picked]);
  const pickedRef = useRef(outermost);
  pickedRef.current = outermost;

  /** Puts several pages in place, one after another. They first go to the end of the top level so the order
   * they land in can't be shuffled by each other, then each goes to its spot (lowest place first). */
  const place = useCallback(
    async (items: Placement[]) => {
      if (items.length === 1) return void (await api.moveNote(items[0].id, items[0].parentId, items[0].index), await reload());
      try {
        for (const it of items) await api.moveNote(it.id, null);
        const order = [...items].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
        for (const it of order) await api.moveNote(it.id, it.parentId, it.index);
      } finally {
        await reload();
      }
    },
    [reload],
  );
  const archiveMany = async (ids: string[]) => {
    await flushAll();
    const gone = new Set<string>();
    try {
      for (const id of ids) (await api.setNoteArchived(id, true)).ids.forEach((x) => gone.add(x));
    } catch (e) {
      toast.error((e as Error).message);
    }
    sel.clear();
    await reload();
    if (phone && id && gone.has(id)) navigate("/notes", { replace: true });
    toast(`Archived ${ids.length} ${ids.length === 1 ? "page" : "pages"}${gone.size > ids.length ? ` and ${gone.size - ids.length} inside` : ""}`, {
      action: { label: "Undo", onClick: async () => void (await Promise.all(ids.map((id) => api.setNoteArchived(id, false))), await reload()) },
    });
  };
  const toTopMany = async (ids: string[]) => {
    const by = new Map((list ?? []).map((n) => [n.id, n]));
    const before: Placement[] = ids.map((id) => {
      const p = by.get(id)?.parentId ?? null;
      return { id, parentId: p, index: (tree.get(p) ?? []).findIndex((s) => s.id === id) };
    });
    try {
      await place(ids.map((id) => ({ id, parentId: null })));
      toast(`Moved ${ids.length} pages to the top level`, { action: { label: "Undo", onClick: () => void place(before) } });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const iconMany = async (ids: string[], show: boolean) => {
    for (const id of ids) {
      const n = list?.find((x) => x.id === id);
      if (n) await setListIcon(n, show);
    }
  };
  const bulkItems = (): MenuEntry[] => {
    const ids = outermost();
    const all = [...picked];
    const pages = (list ?? []).filter((n) => picked.has(n.id) && !isFolder(n));
    const anyShown = (list ?? []).some((n) => picked.has(n.id) && n.look?.showIcon);
    return [
      { label: `Open ${pages.length} in tabs`, disabled: !pages.length, onSelect: () => (pages.forEach((p, i) => pick(p.id, i === 0 ? "new" : "background")), sel.clear()) },
      anyShown ? { label: "Hide icons", onSelect: () => void iconMany(all, false) } : { label: "Show icons", onSelect: () => void iconMany(all, true) },
      all.every((x) => list?.find((n) => n.id === x)?.pinned)
        ? { label: `Unpin ${all.length}`, onSelect: () => void setPinned(all, false).then(sel.clear) }
        : { label: `Pin ${all.length} to the start page`, onSelect: () => void setPinned(all.filter((x) => !list?.find((n) => n.id === x)?.pinned), true).then(sel.clear) },
      "sep",
      { label: "Move to the top level", disabled: ids.every((id) => !list?.find((x) => x.id === id)?.parentId), onSelect: () => void toTopMany(ids).then(sel.clear) },
      "sep",
      { label: `Archive ${ids.length} ${ids.length === 1 ? "page" : "pages"}`, danger: true, onSelect: () => void archiveMany(ids) },
    ];
  };

  // Whether a page's icon shows in the list (off unless asked for). It lives in the page's look.
  const setListIcon = async (n: NoteSummary, show: boolean) => {
    const look: NoteLook = { ...(n.look ?? {}) };
    if (show) look.showIcon = true;
    else delete look.showIcon;
    patchRow(n.id, { look });
    try {
      await api.updateNote(n.id, { look });
    } catch (e) {
      patchRow(n.id, { look: n.look });
      toast.error((e as Error).message);
    }
  };

  // Pinned pages show at the top of the start page (a New tab).
  const setPinned = async (ids: string[], on: boolean) => {
    const stamp = new Date().toISOString();
    for (const pid of ids) patchRow(pid, { pinned: on ? (listRef.current?.find((x) => x.id === pid)?.pinned ?? stamp) : null });
    try {
      for (const pid of ids) {
        const r = await api.pinNote(pid, on);
        patchRow(r.id, { pinned: r.pinned });
      }
    } catch (e) {
      toast.error((e as Error).message);
      await reload();
    }
  };

  // The same menu on ⋯ and on right-click.
  const menuItems = (n: NoteSummary): MenuEntry[] => {
    if (picked.size > 1 && picked.has(n.id)) return bulkItems();
    const parent = n.parentId ? list?.find((x) => x.id === n.parentId) : undefined;
    const sibs = tree.get(n.parentId) ?? [];
    const at = sibs.findIndex((s) => s.id === n.id);
    const prev = at > 0 ? sibs[at - 1] : undefined;
    const split: MenuEntry[] = phone
      ? []
      : [
          { label: "Open to the right", disabled: !sideLayout(n.id, "right"), onSelect: () => void openSide(n.id, "right") },
          { label: "Open below", disabled: !sideLayout(n.id, "bottom"), onSelect: () => void openSide(n.id, "bottom") },
        ];
    return [
      ...(isFolder(n) ? [] : [{ label: "Open", onSelect: () => pick(n.id) }, { label: "Open in new tab", onSelect: () => pick(n.id, "new") }, ...split]),
      { label: "New page inside", onSelect: () => void add(n.id) },
      { label: "New canvas inside", onSelect: () => void add(n.id, "canvas") },
      { label: "New file inside", onSelect: () => setNewFileIn(n.id) },
      { label: "New folder inside", onSelect: () => void addFolder(n.id) },
      { label: "Add a PDF inside…", onSelect: () => pickPdf(n.id) },
      { label: "Rename", onSelect: () => setRenaming(n.id) },
      n.look?.showIcon ? { label: "Hide icon", onSelect: () => void setListIcon(n, false) } : { label: "Show icon", onSelect: () => void setListIcon(n, true) },
      n.pinned ? { label: "Unpin", onSelect: () => void setPinned([n.id], false) } : { label: "Pin to the start page", onSelect: () => void setPinned([n.id], true) },
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
  // A tab's right-click menu.
  const tabMenu = (pane: string, tid: string): MenuEntry[] => {
    const p = findPane(layout.root, pane);
    const others = (p?.tabs.length ?? 0) > 1;
    return [
      { label: "Split right", disabled: !sideLayout(tid, "right", pane), onSelect: () => void openSide(tid, "right", pane) },
      { label: "Split down", disabled: !sideLayout(tid, "bottom", pane), onSelect: () => void openSide(tid, "bottom", pane) },
      "sep",
      { label: "Close", disabled: !multi && !others, onSelect: () => closeTabIn(pane, tid) },
      {
        label: "Close other tabs",
        disabled: !others,
        onSelect: () => setLayout((l) => (findPane(l.root, pane)?.tabs ?? []).filter((t) => t !== tid).reduce((acc, t) => closeLayoutTab(acc, pane, t), activate(l, pane, tid))),
      },
    ];
  };

  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const pdfParent = useRef<string | null>(null);
  // Each PDF becomes a note of its own that opens as the document; the last one opens.
  const addPdfs = async (files: FileList | File[] | null, parentId: string | null) => {
    const pdfs = [...(files ?? [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return;
    try {
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
      primed.set(last.id, last);
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
      await flushAll();
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
      else if (a === "new-file") setNewFileIn(null);
      else if (a === "new-folder") void addFolder(null);
      else if (a === "add-pdf") pickPdf(null);
      else if (a === "import-md") fileInput.current?.click();
      else if (a === "import-vault") folderInput.current?.click();
      else if (a === "tutorial") void addTutorial();
      else if (a === "fold-all") {
        localStorage.setItem(OPEN_KEY, "[]");
        setOpenSet(new Set());
      }
    });
    return () => registerNotesActions(null);
  }, [add, addFolder, addTutorial]);

  // A page dragged out of the sidebar onto the pages opens there: in a pane's tabs, its middle, or at an edge as a new pane.
  const outside = phone
    ? undefined
    : {
        hit: (nid: string, x: number, y: number) => {
          const h = hitTabDrop(layoutRef.current, null, nid, x, y);
          return h.drop ? h : null;
        },
        drop: (nid: string, d: TabDrop) =>
          void flushAll().then(() => setLayout((l) => dropPage(l, nid, d) ?? l)),
      };
  const dnd = useNoteTreeDrag({ list, tree, open, setOpen, place, selected: () => pickedRef.current(), outside });

  const top = tree.get(null) ?? [];
  const slot = useNotesSlot();
  // Desktop: the pages live only in the app sidebar, under the Notes row. Folded sidebar or pages hidden (click
  // Notes) means no tree anywhere. Phones have no sidebar, so there the tree is the list screen.
  const inSidebar = !phone && !!slot;
  const showTree = phone && !id;
  const showPage = !phone || !!id;
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
          top.map((n) => <TreeRow key={n.id} n={n} depth={0} tree={tree} open={open} setOpen={setOpen} current={current} onPick={pick} onAdd={(p) => void add(p)} onMenu={rowMenu} menuItems={menuItems} inSidebar dnd={dnd} rename={rename} sel={sel} />)
        )}
      </div>,
      slot!,
    );

  // + in a pane's top bar: a New tab (the start page) next to that pane's page.
  const newTab = (pane: string) => pickIn(pane, newStartTab(), "new");
  // A page made from the start page opens in its tab; Ctrl/⌘ makes a new tab.
  const createFromStart = async (pane: string, title: string, nt: boolean) => {
    try {
      const n = await api.createNote({ title, parentId: null });
      await reload();
      primed.set(n.id, n);
      pickIn(pane, n.id, nt ? "new" : "replace");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const ctx: PaneCtx = {
    phone,
    list,
    tree,
    listRef,
    primed,
    bumps,
    flushers,
    patchRow,
    pick: pickIn,
    focus: focusPane,
    missing: (pane, nid) => (phone ? navigate("/notes", { replace: true }) : setLayout((l) => (count(l.root) === 1 && (findPane(l.root, pane)?.tabs.length ?? 0) <= 1 ? { ...l, root: { ...(l.root as PaneNode), tabs: [], active: null } } : closeLayoutTab(l, pane, nid)))),
    add,
    addFolder,
    setKind,
    setOpen,
    reload,
    importVault: () => folderInput.current?.click(),
    addTutorial: () => void addTutorial(),
    importMd: () => fileInput.current?.click(),
    pickPdf,
    newFile: () => setNewFileIn(null),
    setPinned,
    createFromStart,
  };

  const shownPanes = phone ? [{ k: "pane" as const, id: "phone", tabs: id ? [id] : [], active: id }] : panes(layout.root);
  const geo = multi ? rects(layout.root) : null;
  const existing = (t: string) => isStartTab(t) || !!list?.some((n) => n.id === t);
  return (
    <div className="notes-shell">
      {pickers}
      <NewFileDialog
        open={newFileIn !== undefined}
        onClose={() => setNewFileIn(undefined)}
        onCreate={(name) => {
          const parent = newFileIn ?? null;
          setNewFileIn(undefined);
          void add(parent, "file", name);
        }}
      />
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
                  <DropdownMenuItem onSelect={() => void addTutorial()}>Notes tutorial</DropdownMenuItem>
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
              top.map((n) => <TreeRow key={n.id} n={n} depth={0} tree={tree} open={open} setOpen={setOpen} current={current} onPick={pick} onAdd={(p) => void add(p)} onMenu={rowMenu} menuItems={menuItems} dnd={dnd} rename={rename} sel={sel} />)
            )}
            <button type="button" onClick={() => void add(null)} className="note-row note-new">
              <Plus className="size-3.5" /> New page
            </button>
            <button type="button" onClick={() => void add(null, "canvas")} className="note-row note-new">
              <PenTool className="size-3.5" /> New canvas
            </button>
            <button type="button" onClick={() => setNewFileIn(null)} className="note-row note-new">
              <FileCode2 className="size-3.5" /> New file
            </button>
          </div>
        </aside>
      )}
      {showPage && (
        <div ref={area} className={cn("notes-split", multi && "is-multi")} data-panes={shownPanes.length}>
          {shownPanes.map((p) => {
            const g = geo?.panes.find((r) => r.id === p.id);
            const tabsShown = p.tabs.filter(existing).length;
            // One pane shows its tabs once there are two; with several panes each shows its tabs, so they can move.
            const strip = phone || (!multi && tabsShown < 2) ? null : (
              <NoteTabs
                pane={p.id}
                tabs={p.tabs}
                all={list ?? []}
                current={p.active}
                onPick={(t) => performance.now() - dragEnded.current > 250 && pickIn(p.id, t)}
                onClose={(t) => closeTabIn(p.id, t)}
                onDrag={(t, e) => startTabDrag(p.id, t, e)}
                menu={(t) => tabMenu(p.id, t)}
                dragging={tabDrag?.pane === p.id ? tabDrag.note : null}
              />
            );
            const plus = phone ? null : (
              <button type="button" className="note-tab-plus" onClick={() => newTab(p.id)} aria-label="New tab" title="New tab">
                <Plus className="size-4" />
              </button>
            );
            return (
              <div
                key={p.id}
                className={cn("note-pane-box", g && g.x > 0.001 && "has-left", g && g.y > 0.001 && "has-top")}
                style={g ? { left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.w * 100}%`, height: `${g.h * 100}%` } : undefined}
              >
                <NotePane pane={p.id} noteId={p.active} ctx={ctx} focused={multi && layout.focus === p.id} strip={strip} plus={plus} />
              </div>
            );
          })}
          {geo?.bars.map((b) => (
            <div
              key={b.path}
              role="separator"
              aria-orientation={b.dir === "row" ? "vertical" : "horizontal"}
              aria-label="Resize panes"
              className={cn("note-split-bar", b.dir === "row" ? "is-row" : "is-col")}
              style={
                b.dir === "row"
                  ? { left: `${(b.x + b.w * b.r) * 100}%`, top: `${b.y * 100}%`, height: `${b.h * 100}%` }
                  : { top: `${(b.y + b.h * b.r) * 100}%`, left: `${b.x * 100}%`, width: `${b.w * 100}%` }
              }
              onPointerDown={(e) => startResize(b, e)}
              onDoubleClick={() => setLayout((l) => ({ ...l, root: setRatio(l.root, b.path, 0.5) }))}
            />
          ))}
        </div>
      )}
      {tabDrag &&
        createPortal(
          <>
            {tabDrag.zone && <div className="note-drop-zone" style={{ left: tabDrag.zone.x, top: tabDrag.zone.y, width: tabDrag.zone.w, height: tabDrag.zone.h }} />}
            {tabDrag.line && <div className="note-drop-tabline" style={{ left: tabDrag.line.x, top: tabDrag.line.y, height: tabDrag.line.h }} />}
            <div className="note-tab-ghost" style={{ transform: `translate(${Math.min(tabDrag.x + 14, window.innerWidth - 214)}px, ${Math.min(tabDrag.y + 12, window.innerHeight - 40)}px)` }}>{tabDrag.label}</div>
          </>,
          document.body,
        )}
    </div>
  );
}
