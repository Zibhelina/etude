// Notes (beta): a tree of pages on the left, the open page on the right. Every change saves on its own
// (a short pause after you stop typing, and when you leave the page). On a phone the tree is the list
// screen and a page opens on its own.
import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Archive, ArrowUpRight, Check, Code2, SquareKanban, RotateCw, ChevronRight, Download, FileCode2, FilePlus2, Folder, FolderInput, FolderOpen, FolderPlus, GraduationCap, HardDrive, ImagePlus, Loader2, MoreHorizontal, PenTool, Plus, RefreshCw, Search, Smile, Users, X } from "lucide-react";
import katex from "katex";
import type { NoteLinkOptions, PageRef } from "@/editor/note-link";
import { etudeFetch, isLocal } from "@/lib/transport";
import { api, ApiError, isFsId, type FolderStamps, type ViewTarget, type ViewCommand, type CanvasScene, type KanbanBoard, type Note, type NoteDoc, type NoteLook, type NoteSummary } from "@/lib/api";
import { BANNER_PRESETS } from "@/lib/banner";
import { EMOJI_SUGGESTIONS } from "@/lib/deck-icons";
import { useEtudeSrc } from "@/lib/local-url";
import { PatternSvg } from "@/components/profile-header";
import { navigate } from "@/lib/router";
import { usePhone } from "@/lib/phone";
import { NoteEditor, type NoteEditorHandle } from "@/editor/note-editor";
import { merge3, mergeDocs } from "../../../src/core/doc-merge.ts";
import { NoteIcon, NoteIconPicker } from "@/editor/note-icon";
import { hexToHsv, hsvToHex, useDrag, type Hsv } from "@/components/accent-wheel";
import { accentText } from "../../../src/core/themes.ts";
import { CanvasBoard, exportBoard } from "@/editor/canvas-board";
import { holdReload } from "@/lib/live-reload";
import { ArchivedList, KANBAN_CHANGED, KanbanView, kanbanChanged, latestBoard, type KanbanFilter } from "@/editor/kanban-board";
import { HtmlFrame, PdfDocument, uploadPdf } from "@/editor/note-embed";
import { webChanged } from "@/editor/note-portal";
import { AnyCodeEditor } from "@/components/live-editor";
import { createFileEditor, fileLanguage, wrapsByDefault, type FileEditorHandle } from "@/editor/file-editor";
import { createMarkdownFileEditor } from "@/editor/markdown-file";
import { renderMarkdown } from "@/components/markdown";
import { copyPath, diskPath, FolderSyncDialog, fsAncestors, fsParent, LocalMediaView, LocalOtherView, OpenFolderDialog } from "@/components/local-files";
import { setVimMode, useVimMode } from "@/lib/vim";
import { isTextFile } from "../../../src/core/text-files.ts";
import { useScheme } from "@/lib/theme";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { EditedBy, PresenceDots, ShareBits, ShareCtx, ShareDialog, ShareInvites, useReadOnly, useShareStatus, WAITING_KEY, type ShareCtxValue } from "@/components/note-share";
import { openPresence, usePresencePoll } from "@/lib/presence";
import { shareApi } from "@/lib/share";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { registerNotesActions, setNotesPagesOpen, setNotesView, useNotesSlot, useNotesView } from "@/lib/sidebar-slot";
import { NoteStart, StartTabIcon, isStartTab, newStartTab, startShortcut } from "@/components/note-start";
import { reportView, setViewHandler } from "@/lib/view-remote";
import { OPEN_NOTE_EVENT, type OpenNoteDetail } from "@/components/agent-rich";
import { chatKey, chatTabId, dock, dockNode, dockState, isChatTab, registerNotebook, requestChat, takeWaiting, useDock, type ChatMeta, type DockedChat } from "@/lib/agent-dock";
import { NotesChats } from "@/components/chat-sidebar";
import { chatToPanel } from "@/components/agent-panel";
import { AgentAvatar } from "@/components/agent-avatar";
import { profileFrom, useAgentProfiles } from "@/lib/agent-profiles";
import { useNoteTreeDrag, type Placement } from "@/components/note-tree-drag";
import { useScreenLines } from "@/lib/screen";
import { inAskPanel, tabShortcut } from "@/lib/tab-keys";
import { WEB_HOME, WebLayer, WebPage, WebTabIcon, canWebTabs, focusAddress, isWebTab, linksInTabs, useWebSettings, useWebTabs, webBridge, webTabOfGuest, webTabs, webTitle } from "@/lib/web-tabs";
import { activate, canSplitTo, dropPage, closeTab as closeLayoutTab, count, editGroup, findPane, focus as focusLayout, focusedPane, GROUP_COLORS, groupOf, isGroupColor, groupTabs, groupTint, isPinned, MAX_PANES, moveGroup, moveTab, newGroupId, nextZoom, normalizeLayout, openIn, openSplit, panes, paneZoom, pinTab, prune, rects, renameTab, setPaneZoom, setRatio, setTabIcon, single, tabToEnd, ungroup, ungroupTab, type GroupColor, type Layout, type LayoutNode, type PaneNode, type Rect, type Side, type TabDrop, type TabGroup } from "@/lib/note-layout";
import { anchorAt, keepAnchor, ownZoom, PaneIdCtx, wheelFactor, zoomKey, type ZoomBy } from "@/lib/pane-zoom";
import { canOpenWindows, isExtraWindow, openNewWindow, windowStore } from "@/lib/window-store";

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
const display = (n: { title: string; kind?: string }) => n.title.trim() || (n.kind === "folder" ? "New folder" : n.kind === "canvas" ? "Untitled canvas" : n.kind === "pdf" ? "Untitled PDF" : n.kind === "file" ? "untitled.txt" : n.kind === "web" ? "Untitled web file" : n.kind === "kanban" ? "Untitled board" : "Untitled");
/** A note's glyph when it has no icon of its own. */
const fallbackIcon = (n: { kind?: string }) => (n.kind === "canvas" ? "🎨" : n.kind === "pdf" ? "📕" : n.kind === "web" ? "◈" : n.kind === "kanban" ? "▥" : "📄");
const isFolder = (n: { kind?: string } | null | undefined) => n?.kind === "folder";
const isFile = (n: { kind?: string } | null | undefined) => n?.kind === "file";
/** The small grey tag after a name that isn't a plain page, as Obsidian marks PDF and CANVAS. A file's name already ends in its extension. */
const kindTag = (n: { kind?: string }): string | null => (n.kind === "pdf" ? "PDF" : n.kind === "canvas" ? "CANVAS" : n.kind === "web" ? "WEB" : n.kind === "kanban" ? "KANBAN" : null);
const isWeb = (n: { kind?: string } | null | undefined) => n?.kind === "web";
const isKanban = (n: { kind?: string } | null | undefined) => n?.kind === "kanban";
/** A Markdown file (in the collection or on disk): it opens in the live editor, not the code one. */
const isMarkdownFile = (n: { title: string; local?: NoteSummary["local"] }) => /\.(md|markdown)$/i.test(n.local?.name ?? n.title);
/** Folders on this computer as the tree's rows: each open folder, then what's inside every folder that was listed. */
type Disk = { roots: NoteSummary[]; dirs: Record<string, NoteSummary[]> };
function diskRows(d: Disk): NoteSummary[] {
  const out: NoteSummary[] = [];
  const walk = (rows: NoteSummary[]) => {
    for (const r of rows) {
      out.push(r);
      const kids = d.dirs[r.id];
      if (kids) walk(kids);
    }
  };
  walk(d.roots);
  return out;
}
const stampsDiffer = (a: FolderStamps | null, b: FolderStamps) => !a || a.roots !== b.roots || (a.synced ?? "") !== (b.synced ?? "") || (a.order ?? "") !== (b.order ?? "") || Object.keys(b.dirs).some((k) => a.dirs[k] !== b.dirs[k]);

// ---------------------------------------------------------------- saving

type SaveState = "saved" | "saving" | "error";

type SavePatch = { title?: string; pageTitle?: string | null; doc?: NoteDoc; scene?: CanvasScene; content?: string; board?: KanbanBoard };
/** A page's body edits carry the `updated` they started from; when someone else saved in between, `conflict` merges and saves instead. */
type SaveHooks = {
  base?(): string | undefined;
  conflict?(target: string, p: SavePatch): Promise<Note | null>;
  /** The same for a file on this computer: the time on disk its text was read at, and what to do when the disk has moved on. */
  fileBase?(): string | undefined;
  fileConflict?(target: string, p: SavePatch): Promise<Note | null>;
};

/** Keeps a page's edits and writes them a moment after the last one, or at once on flush. */
function useSaver(id: string | null, onSaved: (n: Note, sent: SavePatch) => void, hooks?: React.MutableRefObject<SaveHooks>) {
  const pending = useRef<SavePatch | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
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
    inFlight.current = true;
    setState("saving");
    try {
      const base = p.doc !== undefined ? hooks?.current.base?.() : p.content !== undefined ? hooks?.current.fileBase?.() : undefined;
      let n: Note | null;
      try {
        n = await api.updateNote(target, base ? { ...p, base } : p);
      } catch (e) {
        const settle = p.doc !== undefined ? hooks?.current.conflict : p.content !== undefined ? hooks?.current.fileConflict : undefined;
        if (!(e instanceof ApiError && e.status === 409 && settle)) throw e;
        n = await settle(target, p);
      }
      inFlight.current = false;
      setState(pending.current ? "saving" : "saved");
      if (n) saved.current(n, p);
    } catch (e) {
      inFlight.current = false;
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
    (patch: SavePatch) => {
      pending.current = { ...pending.current, ...patch };
      setState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_MS);
    },
    [flush],
  );
  /** Edits typed and not yet written, or a write on its way. */
  const busy = useCallback(() => !!pending.current || !!timer.current || inFlight.current, []);
  // A new build of the app waits for this page's edits to be written before the window reloads.
  useEffect(() => holdReload(busy), [busy]);
  /** Swap what's waiting to be written (after a merge put a newer page in the editor). */
  const repending = useCallback((patch: SavePatch) => {
    if (pending.current) pending.current = { ...pending.current, ...patch };
  }, []);
  return { queue, flush, state, busy, repending };
}

// ---------------------------------------------------------------- the tree

type MenuEntry = { label: string; onSelect(): void; disabled?: boolean; danger?: boolean; /** A group's colour, shown as a dot before the label. */ dot?: GroupColor } | "sep";
/** "new": open it in a new tab and go there; "background": add the tab and stay where you are. */
type TabMode = "new" | "background";
type DragProps = { start(n: NoteSummary, e: React.PointerEvent<HTMLElement>): void; draggingId: string | null; draggingMany: boolean; targetId: string | null };
/** The row whose name is being typed in place (a new folder, or Rename). */
type RenameProps = { id: string | null; done(id: string, title: string | null): void };
/** Several pages picked at once with Shift+click, to move, archive or open together. */
type SelectProps = { ids: Set<string>; shift(id: string): void; clear(): void };

/** The people mark on a shared root, saying so when this device is still getting the folder's key. */
function SharedMark({ space }: { space: string }) {
  const waiting = useContext(ShareCtx)?.status?.spaces.some((s) => s.id === space && s.waitingKey);
  return <Users className={cn("note-row-shared", waiting && "is-waiting")} aria-label={waiting ? `Shared. ${WAITING_KEY}` : "Shared"}><title>{waiting ? WAITING_KEY : "Shared"}</title></Users>;
}

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
  const ro = !!n.share?.readonly;
  // A folder on disk is listed when it's unfolded: until then it has an arrow if it holds anything.
  const hasKids = kids.length > 0 || (n.local?.type === "dir" && n.children !== 0 && !n.local.root?.missing);
  return (
    <>
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        role="treeitem"
        aria-selected={on}
        aria-expanded={hasKids ? expanded : undefined}
        data-note-row={n.id}
        className={cn("note-row group", on && "is-on", picked && "is-sel", (dnd.draggingId === n.id || (dnd.draggingMany && picked)) && "is-dragged", dnd.targetId === n.id && "is-drop-into", n.local?.root?.missing && "is-missing")}
        data-kind={folder ? "folder" : "page"}
        title={n.local?.root ? (n.local.root.missing ? `${n.local.root.path} isn't on this computer right now` : n.local.root.path) : undefined}
        onPointerDown={(e) => !editing && !ro && !n.local?.root && dnd.start(n, e)}
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
          className={cn("note-row-chev", !hasKids && "invisible")}
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
        </button>
        {/* Like Obsidian, the list shows names only; a page's icon shows here when you ask for it (right-click → Show icon). */}
        {n.look?.showIcon && (
          <span className="note-row-icon" aria-hidden>
            {folder && !n.icon ? (expanded && kids.length ? <FolderOpen className="size-4" /> : <Folder className="size-4" />) : isFile(n) && !n.icon ? <FileCode2 className="size-4" /> : isWeb(n) && !n.icon ? <Code2 className="size-4" /> : <NoteIcon icon={n.icon} size={18} fallback={fallbackIcon(n)} />}
          </span>
        )}
        {editing ? (
          <RenameInput initial={n.title || (folder ? "New folder" : "")} onDone={(t) => rename.done(n.id, t)} />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", !n.title.trim() && "text-muted-foreground")}>{display(n)}</span>
        )}
        {!editing && n.share && <PresenceDots note={n.id} />}
        {!editing && n.share?.root && <SharedMark space={n.share.space} />}
        {!editing && n.local?.synced === "root" && <RefreshCw className="note-row-shared" data-synced aria-label="Synced to your other devices" />}
        {!editing && n.local?.root && <HardDrive className="note-row-shared" aria-label="A folder on this computer" />}
        {!editing && kindTag(n) && <span className="note-row-tag">{kindTag(n)}</span>}
        <span className="note-row-acts" onClick={(e) => e.stopPropagation()}>
          {onMenu(n)}
          {!inSidebar && !ro && (
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
function FolderView({ folder, kids, onPick, onAdd, onAddMarkdown, onAddFolder, onMakePage, onOpenFolder, onBack, path }: {
  folder: Note;
  kids: NoteSummary[];
  onPick(id: string): void;
  onAdd(): void;
  onAddFolder(): void;
  /** In a folder on this computer: a .md file beside the pages. */
  onAddMarkdown?: () => void;
  /** Not for a folder on this computer: that one is a folder on disk and stays one. */
  onMakePage?: () => void;
  /** Where a folder on this computer is on disk. */
  path?: string | null;
  onOpenFolder(id: string): void;
  onBack?: () => void;
}) {
  const ro = useReadOnly(folder);
  return (
    <article className="note-page">
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notebook">
            <ChevronRight className="size-4 rotate-180" /> Notebook
          </button>
        )}
        {useContext(NoteTabsCtx)}
        {useContext(NotePlusCtx)}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-2">
          <ShareBits note={folder} />
        </span>
      </div>
      <div className="note-sheet note-folder">
        <div className="note-folder-head">
          <span className="note-folder-icon" aria-hidden>{folder.icon ? <NoteIcon icon={folder.icon} size={40} /> : <FolderOpen className="size-9" />}</span>
          <h1 className="note-folder-title">{display(folder)}</h1>
          <p className="text-[13.5px] text-muted-foreground">{kids.length ? `${kids.length} ${kids.length === 1 ? "thing" : "things"} inside` : "Nothing inside yet"}. {folder.local ? "A folder on this computer: what you change here changes on disk." : "A folder holds pages and has no page of its own."}</p>
          {path && <button type="button" className="local-other-path" title="Copy the path" onClick={() => copyPath(path)}>{path}</button>}
        </div>
        <div className="note-folder-list">
          {kids.map((k) => (
            <button key={k.id} type="button" className="note-folder-item" onClick={() => (isFolder(k) ? (onOpenFolder(k.id), onPick(k.id)) : onPick(k.id))}>
              <span className="note-row-icon" aria-hidden>{isFolder(k) && !k.icon ? <Folder className="size-4" /> : isFile(k) && !k.icon ? <FileCode2 className="size-4" /> : isWeb(k) && !k.icon ? <Code2 className="size-4" /> : <NoteIcon icon={k.icon} size={18} />}</span>
              <span className="min-w-0 flex-1 truncate">{display(k)}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
        {!ro && <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onAdd} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]"><FilePlus2 className="size-4" /> New page</button>
          {onAddMarkdown && <button type="button" onClick={onAddMarkdown} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]"><FileCode2 className="size-4" /> New Markdown file</button>}
          <button type="button" onClick={onAddFolder} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]"><FolderPlus className="size-4" /> New folder</button>
          {onMakePage && <button type="button" onClick={onMakePage} className="inline-flex h-10 items-center gap-2 rounded-[10px] px-3 text-[13.5px] text-muted-foreground hover:bg-accent hover:text-foreground">Turn into a page</button>}
        </div>}
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

/**
 * A page or board kept as a file has a title of its own, apart from its name on disk. Until it has one, the name shows
 * faintly where the title goes, as a suggestion: Tab (or → at the end) takes it, and typing something else replaces it.
 * Returns the part of the name still to show after what's typed, or "" when the name isn't a way to finish it.
 */
export function titleHint(typed: string, name: string): string {
  if (!name) return "";
  if (!typed) return name;
  return typed.length < name.length && name.toLowerCase().startsWith(typed.toLowerCase()) ? name.slice(typed.length) : "";
}

const FIND_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? { find: "⌘F", replace: "⇧⌘H" } : { find: "Ctrl+F", replace: "Ctrl+H" };

function PageView({ note, tree, all, onTitle, onPageTitle, onDoc, saveState, onPick, links, onIcon, onLook, onBack, editorRef }: {
  note: Note;
  /** The pane's hold on the editor, to put in a page saved somewhere else. */
  editorRef?: React.MutableRefObject<NoteEditorHandle | null>;
  /** Phones: back to the page list. It sits in the top bar, so a cover can start at the very top. */
  onBack?: () => void;
  onIcon(icon: string | null): void;
  onLook(look: NoteLook): void;
  links: NoteLinkOptions;
  tree: Tree;
  all: NoteSummary[];
  onTitle(t: string): void;
  /** A page kept as a file: its own title, which leaves the file's name alone. */
  onPageTitle(t: string): void;
  onDoc(d: NoteDoc): void;
  saveState: SaveState;
  onPick(id: string): void;
}) {
  const title = useRef<HTMLTextAreaElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const ownEd = useRef<NoteEditorHandle | null>(null);
  const ed = editorRef ?? ownEd;
  const findDock = useRef<HTMLDivElement>(null);
  // Find picked in the page's menu opens once the menu has closed (it gives the focus back to its button first).
  const findNext = useRef(false);
  // A page kept as a file shows the title it was given, never its file's name; that name is only suggested.
  const onDisk = !!note.local;
  const [t, setT] = useState(onDisk ? (note.local?.pageTitle ?? "") : note.title);
  // Its title changed somewhere else (another device, an agent): follow it, unless it's being typed here.
  useEffect(() => {
    if (onDisk && document.activeElement !== title.current) setT(note.local?.pageTitle ?? "");
  }, [note.local?.pageTitle]);
  // A new, empty page starts in its title.
  useEffect(() => {
    if ((onDisk ? !t : !note.title) && !note.text && !note.share?.readonly) title.current?.focus();
  }, [note.id]);
  const ro = useReadOnly(note);
  const hint = onDisk && !ro ? titleHint(t, note.title) : "";
  useLayoutEffect(() => {
    const el = title.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.max(el.scrollHeight, hintRef.current?.offsetHeight ?? 0)}px`;
  }, [t, hint]);
  const takeHint = () => {
    setT(note.title);
    onPageTitle(note.title);
  };
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
  const shareNow = useContext(ShareCtx)?.shareOf(note.id) ?? note.share;
  const lookClass = cn("note-sheet", look.width && look.width !== "normal" && `is-${look.width}`, look.font && `font-${look.font}`, look.size && `size-${look.size}`, look.cover && "has-cover", icon && "has-icon");
  return (
    <article className={cn("note-page", strip && "has-tabs")}>
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notebook">
            <ChevronRight className="size-4 rotate-180" /> Notebook
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
          <EditedBy note={note} />
          {!ro && <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>}
          <ShareBits note={note} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Page options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => findNext.current && (e.preventDefault(), (findNext.current = false), ed.current?.find(ro ? "find" : "replace"))}>
              {!ro && <>
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
              </>}
              <DropdownMenuItem onSelect={() => void (findNext.current = true)}><Search className="size-4" /> {ro ? "Find in the page" : "Find and replace"}<DropdownMenuShortcut>{ro ? FIND_KEYS.find : FIND_KEYS.replace}</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportNote(note, "md")}><Download className="size-4" /> Export as Markdown</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportNote(note, "html")}><Download className="size-4" /> Export as HTML</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div ref={findDock} className="note-find-dock" />
      {/* With tabs in the top bar, the page's folder path sits in the page's top-left corner, under them. */}
      {strip && crumbs.length > 0 && (
        <nav aria-label="Path" className="note-crumbs-corner">
          {crumbs.map((c) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <button className="truncate rounded px-1 hover:text-foreground" onClick={() => onPick(c.id)}>{display(c)}</button>
              <ChevronRight className="size-3 shrink-0 opacity-60" />
            </span>
          ))}
          <span className="truncate px-1 text-foreground/80">{display({ title: t })}</span>
        </nav>
      )}
      {look.cover && (
        <div className={cn("note-cover group/cover", look.cover.kind === "image" && "is-image")} onPointerDown={ro ? undefined : dragCover}>
          <CoverArt cover={look.cover} />
          {!ro && <div className="note-cover-acts">
            <Popover open={coverOpen} onOpenChange={setCoverOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="note-cover-btn" onPointerDown={(e) => e.stopPropagation()}>Change cover</button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-3">
                <CoverPicker hasCover onPick={(id) => (setL({ cover: { kind: "preset", id } }), setCoverOpen(false))} onUpload={(f) => void upload(f)} onRemove={() => (setL({ cover: undefined }), setCoverOpen(false))} />
              </PopoverContent>
            </Popover>
            {look.cover.kind === "image" && <span className="note-cover-hint">Drag to move</span>}
          </div>}
        </div>
      )}
      <div
        className={lookClass}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget || ro) return;
          e.preventDefault();
          ed.current?.focusEnd();
        }}
      >
        {/* The page's head: icon, Add icon / Add cover and the title. The add buttons show while the pointer is here,
            on the cover or the top bar (near the top of the page), not anywhere on the page. */}
        <div className="note-head">
        {icon && ro && <span className="note-page-icon"><NoteIcon icon={icon} size={72} /></span>}
        {icon && !ro && (
          <Popover open={iconOpen} onOpenChange={setIconOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="note-page-icon" aria-label="Change icon"><NoteIcon icon={icon} size={72} /></button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
              <NoteIconPicker icon={icon} onPick={pickIcon} onRemove={() => pickIcon(null)} />
            </PopoverContent>
          </Popover>
        )}
        {!ro && <div className="note-addons">
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
        </div>}
        <div className="note-title-box">
        {hint && (
          <div ref={hintRef} className="note-title note-title-hint" aria-hidden="true">
            <span className="note-title-typed">{t}</span>
            {hint}
          </div>
        )}
        <textarea
          ref={title}
          readOnly={ro}
          rows={1}
          value={t}
          placeholder={onDisk ? undefined : "Untitled"}
          aria-label="Title"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="note-title"
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, "");
            setT(v);
            // A page kept as a file: the title is saved in the file, and its name on disk stays as it was.
            if (onDisk) onPageTitle(v);
            else onTitle(v);
          }}
          onBlur={() => {
            if (onDisk && t !== t.trim()) setT(t.trim());
          }}
          onKeyDown={(e) => {
            const end = e.currentTarget.selectionStart === e.currentTarget.value.length && e.currentTarget.selectionEnd === e.currentTarget.value.length;
            if (hint && ((e.key === "Tab" && !e.shiftKey) || (e.key === "ArrowRight" && end))) {
              e.preventDefault();
              takeHint();
              return;
            }
            if (e.key === "Enter" || (e.key === "ArrowDown" && end)) {
              e.preventDefault();
              ed.current?.focusStart();
            }
          }}
        />
        </div>
        </div>
        <NoteEditor key={note.id} doc={note.doc} onChange={onDoc} editorRef={ed} onEscapeUp={() => title.current?.focus()} links={links} page={{ id: note.id, title: t || note.title }} editable={!ro} shared={!!shareNow} findDock={findDock} />
        <Backlinks id={note.id} title={t || note.title} onPick={onPick} />
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
    a.download = note.local ? note.local.name : isFile(note) ? base : `${base.replace(/\.html?$/i, "")}.${note.kind === "canvas" ? "excalidraw" : note.kind === "pdf" ? "pdf" : note.kind === "web" ? "html" : note.kind === "kanban" ? "md" : format}`;
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
  const ro = useReadOnly(note);
  const canvasShared = !!(useContext(ShareCtx)?.shareOf(note.id) ?? note.share);
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
          <EditedBy note={note} />
          {!ro && <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>}
          <ShareBits note={note} />
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
      <CanvasBoard key={`${note.id}:${ro}`} scene={note.scene!} onChange={onScene} name={t} onApi={(a) => (xapi.current = a)} className="note-canvas-full" readOnly={ro} presenceNote={canvasShared ? note.id : undefined} />
    </article>
  );
}

// ---------------------------------------------------------------- a kanban board

/** A board open on its own: its name, a filter, and the columns filling the rest of the screen. */
function KanbanNoteView({ note, all, saveState, onPick, onTitle, onPageTitle, onBoard, links, onBack }: {
  note: Note;
  all: NoteSummary[];
  saveState: SaveState;
  onPick(id: string): void;
  onTitle(t: string): void;
  /** A board kept as a file: its own title, which leaves the file's name alone. */
  onPageTitle(t: string): void;
  onBoard(b: KanbanBoard): void;
  links: NoteLinkOptions;
  onBack?: () => void;
}) {
  const [board, setBoard] = useState<KanbanBoard>(() => latestBoard(note.id) ?? note.board!);
  // A board kept as a file shows the title it was given; its file's name is only suggested (see titleHint).
  const onDisk = !!note.local;
  const [t, setT] = useState(onDisk ? (note.local?.pageTitle ?? "") : note.title);
  const [filter, setFilter] = useState<KanbanFilter>({ q: "", labels: new Set(), due: false });
  const me = useRef(Math.random().toString(36).slice(2));
  const titleRef = useRef<HTMLInputElement>(null);
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  useEffect(() => {
    if (!onDisk) setT(note.title);
    else if (document.activeElement !== titleRef.current) setT(note.local?.pageTitle ?? "");
  }, [note.title, note.local?.pageTitle]);
  // A new board starts in its name.
  useEffect(() => {
    if (!note.title) titleRef.current?.focus();
  }, [note.id]);
  // The same board changed in a portal in this window: follow it.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: string; board: KanbanBoard; from: string };
      if (d.id === note.id && d.from !== me.current) setBoard(d.board);
    };
    window.addEventListener(KANBAN_CHANGED, h);
    return () => window.removeEventListener(KANBAN_CHANGED, h);
  }, [note.id]);
  const change = useCallback(
    (b: KanbanBoard) => {
      setBoard(b);
      kanbanChanged(note.id, b, me.current);
      onBoard(b);
    },
    [note.id, onBoard],
  );
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  const ro = useReadOnly(note);
  const used = board.labels.filter((l) => Object.values(board.cards).some((c) => c.labels.includes(l.id)));
  const toggleLabel = (id: string) =>
    setFilter((f) => {
      const labels = new Set(f.labels);
      labels.has(id) ? labels.delete(id) : labels.add(id);
      return { ...f, labels };
    });
  return (
    <article className="note-page note-canvas-page kb-page">
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notebook">
            <ChevronRight className="size-4 rotate-180" /> Notebook
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
            <span className="truncate px-1 text-foreground/80">{display({ title: t, kind: "kanban" })}</span>
          </nav>
        )}
        {plus}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1">
          <EditedBy note={note} />
          {!ro && <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>}
          <ShareBits note={note} />
          {!ro && <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="note-row-act is-visible" aria-label="Archived cards" title="Archived cards">
                <Archive className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="kb-pop w-72 p-1.5">
              <div className="kb-pop-label">Archived cards</div>
              <ArchivedList board={board} onChange={change} />
            </PopoverContent>
          </Popover>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Board options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => void exportNote(note, "md")}><Download className="size-4" /> Export as Markdown (Obsidian Kanban)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div className="kb-page-head">
        <span className="kb-page-title-box">
        {onDisk && !ro && titleHint(t, note.title) && (
          <span className="kb-page-title kb-page-title-hint" aria-hidden="true">
            <span className="note-title-typed">{t}</span>
            {titleHint(t, note.title)}
          </span>
        )}
        <input
          ref={titleRef}
          className="kb-page-title"
          readOnly={ro}
          value={t}
          placeholder={onDisk ? undefined : "Untitled board"}
          spellCheck={false}
          aria-label="Board name"
          onChange={(e) => {
            setT(e.target.value);
            // A board kept as a file: the title is saved in the file, and its name on disk stays as it was.
            if (onDisk) onPageTitle(e.target.value);
            else onTitle(e.target.value);
          }}
          onBlur={() => {
            if (onDisk && t !== t.trim()) setT(t.trim());
          }}
          onKeyDown={(e) => {
            const end = e.currentTarget.selectionStart === t.length && e.currentTarget.selectionEnd === t.length;
            if (onDisk && !ro && titleHint(t, note.title) && ((e.key === "Tab" && !e.shiftKey) || (e.key === "ArrowRight" && end))) {
              e.preventDefault();
              setT(note.title);
              onPageTitle(note.title);
              return;
            }
            if (e.key === "Enter") (e.preventDefault(), e.currentTarget.blur());
          }}
        />
        </span>
        <div className="kb-filter">
          <input value={filter.q} placeholder="Filter cards" spellCheck={false} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} onKeyDown={(e) => e.key === "Escape" && setFilter((f) => ({ ...f, q: "" }))} aria-label="Filter cards" />
          {used.map((l) => (
            <button key={l.id} type="button" className={cn("kb-chip", filter.labels.has(l.id) && "is-on")} style={{ ["--kc" as any]: `var(--kb-${l.color})` }} onClick={() => toggleLabel(l.id)}>{l.name}</button>
          ))}
          <button type="button" className={cn("kb-chip", filter.due && "is-on")} style={{ ["--kc" as any]: "var(--kb-red)" }} onClick={() => setFilter((f) => ({ ...f, due: !f.due }))}>Due soon</button>
        </div>
      </div>
      <KanbanView boardId={note.id} boardTitle={t} board={board} onChange={change} links={links} filter={filter} startAdding={!ro && !Object.keys(board.cards).length && !!note.title} readOnly={ro} />
    </article>
  );
}

// ---------------------------------------------------------------- a PDF

/** A PDF note: its title in the top bar and the document filling the rest, like opening the file itself. */
function PdfNoteView({ note, all, onPick }: { note: Note; all: NoteSummary[]; onPick(id: string): void }) {
  const url = useEtudeSrc(note.src ?? (note.file ? `/media/${note.file}` : null));
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
          <ShareBits note={note} />
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
      {note.file || note.src ? <PdfDocument url={url ?? null} name={display(note)} className="note-canvas-full" controls={ctl} /> : <div className="px-6 py-5 text-[14px] text-[var(--danger)]">This PDF's file is missing.</div>}
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

const SOURCE_KEY = "etude.notes.mdSource";
/** Markdown files shown as their raw text instead of the live preview (a choice per file). */
function sourceOf(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SOURCE_KEY) ?? "{}") as Record<string, boolean>)[id] === true;
  } catch {
    return false;
  }
}
function saveSource(id: string, on: boolean) {
  try {
    const m = JSON.parse(localStorage.getItem(SOURCE_KEY) ?? "{}") as Record<string, boolean>;
    if (on) m[id] = true;
    else delete m[id];
    localStorage.setItem(SOURCE_KEY, JSON.stringify(m));
  } catch {}
}

/** A link in a Markdown file that was clicked: a [[name]], or the address or path of a [text](link). */
type FileLink = { kind: "wiki" | "href"; target: string };

/**
 * A code or text file (main.py, report.tex): its name in the top bar and a plain editor filling the rest.
 * A Markdown file gets the live preview instead (its raw text is one menu item away).
 */
function FileView({ note, all, onTitle, onContent, saveState, onPick, onSave, onBack, onLink }: {
  note: Note;
  all: NoteSummary[];
  onTitle(t: string): void;
  onContent(c: string): void;
  saveState: SaveState;
  onPick(id: string): void;
  onSave(): void;
  onBack?: () => void;
  onLink?(link: FileLink, newTab: boolean): void;
}) {
  // The name lives in the tab and the sidebar; Rename there changes it, and the highlighting follows.
  // A file on disk shows its Markdown name without the extension there, so the real name comes from the disk.
  const t = note.local?.name ?? note.title;
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<FileEditorHandle | null>(null);
  const vim = useVimMode();
  const [wrap, setWrap] = useState(() => wrapOf(note.id, t));
  const [pos, setPos] = useState({ line: 1, col: 1, sel: 0 });
  const [mode, setMode] = useState<string | null>(null);
  const markdown = isMarkdownFile(note);
  const [source, setSource] = useState(() => sourceOf(note.id));
  const live = markdown && !source;
  // What's typed, so switching between the preview and the raw text carries it over.
  const text = useRef((note.content ?? "").replace(/\r\n/g, "\n"));
  // Set while text from somewhere else is put into the editor, so that isn't taken for typing and saved back.
  const quiet = useRef(false);
  const cb = useRef({ onTitle, onContent, onSave, onLink });
  cb.current = { onTitle, onContent, onSave, onLink };
  // A Markdown file's name is its title, shown above the text the way a page's is; typing a new one renames the file.
  const mdExt = /\.(md|markdown)$/i.exec(t)?.[0] ?? "";
  const titleRef = useRef("");
  titleRef.current = mdExt ? t.slice(0, -mdExt.length) : t;
  const extRef = useRef(mdExt);
  extRef.current = mdExt;
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  const ro = useReadOnly(note) || !!note.local?.locked;
  const path = diskPath(note, all);
  useEffect(() => {
    if (!host.current) return;
    const common = {
      readOnly: ro,
      value: text.current,
      vim,
      onChange: (v: string) => {
        text.current = v;
        if (!quiet.current) cb.current.onContent(v);
      },
      onSave: () => cb.current.onSave(),
      onVimMode: setMode,
    };
    const h = live
      ? createMarkdownFileEditor(host.current, {
          ...common,
          katex,
          renderTable: renderMarkdown,
          title: () => titleRef.current,
          onTitle: (name) => cb.current.onTitle(name + extRef.current),
          onLink: (l, nt) => cb.current.onLink?.(l, nt),
          // Pictures named in a file on disk load from its folder: beside the file, from the folder's top, or by name.
          imageUrl: note.local ? (target) => `/api/folders/raw?from=${encodeURIComponent(note.id)}&target=${encodeURIComponent(target)}` : undefined,
        })
      : createFileEditor(host.current, { ...common, name: t, wrap });
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
    if (!text.current && !ro) setTimeout(() => h.focus(), 0);
    return () => {
      h.destroy();
      ed.current = null;
    };
    // The editor lives as long as this file is open in this mode; name, Vim and wrap change it in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, ro, live]);
  useEffect(() => void ed.current?.setVim(vim), [vim]);
  useEffect(() => ed.current?.setWrap(wrap), [wrap]);
  useEffect(() => ed.current?.setName(t), [t]);
  // The file changed somewhere else (another program wrote it, an agent, another window): the open editor takes the
  // new text where it differs, so the cursor and the scroll stay where they are.
  useEffect(() => {
    const h = ed.current;
    const next = (note.content ?? "").replace(/\r\n/g, "\n");
    if (!h || next === text.current) return;
    const cur = h.view.state.doc.toString();
    let a = 0;
    while (a < cur.length && a < next.length && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
    let b = 0;
    while (b < cur.length - a && b < next.length - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
    quiet.current = true;
    try {
      h.view.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } });
    } finally {
      quiet.current = false;
    }
    text.current = next;
  }, [note.content]);
  // .m highlights with Octave's grammar, which is MATLAB's; call it what you'd call it.
  const language = markdown ? "Markdown" : /\.m$/i.test(t) ? "MATLAB" : fileLanguage(t)?.name ?? "Plain text";
  const lines = ed.current?.view.state.doc.lines;
  return (
    <article className={cn("note-page note-canvas-page note-file-page", live && "note-md-page")}>
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notebook">
            <ChevronRight className="size-4 rotate-180" /> Notebook
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
            <span className={cn("truncate px-1 text-foreground/80", !live && "note-file-name")}>{(live ? note.title : t) || "untitled.txt"}</span>
          </nav>
        )}
        {plus}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-2">
          <EditedBy note={note} />
          {!ro && <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>}
          {note.local?.locked && <span className="note-save">Read only</span>}
          <ShareBits note={note} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="File options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => (e.preventDefault(), ed.current?.focus())}>
              {markdown && (
                <DropdownMenuItem onSelect={() => setSource((v) => (saveSource(note.id, !v), !v))}>
                  <Check className={cn("size-4", !source && "opacity-0")} /> Source mode
                </DropdownMenuItem>
              )}
              {!live && (
                <DropdownMenuItem onSelect={() => setWrap((w) => (saveWrap(note.id, !w), !w))}>
                  <Check className={cn("size-4", !wrap && "opacity-0")} /> Wrap long lines
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void setVimMode(!vim)?.catch((e: Error) => toast.error(`Couldn't save: ${e.message}`))}>
                <Check className={cn("size-4", !vim && "opacity-0")} /> Vim keys
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {path && <DropdownMenuItem onSelect={() => copyPath(path)}><HardDrive className="size-4" /> Copy the path</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => void exportNote({ ...note, title: t }, "md")}><Download className="size-4" /> Download {t.trim() || "untitled.txt"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div ref={host} className={cn("note-file-editor", live && "note-md-editor", vim && "is-vim")} />
      <div className="note-file-status" aria-label="File status">
        {vim && mode && <span className={cn("note-vim-mode", `is-${mode.split(" ")[0]}`)} aria-live="polite">{mode.toUpperCase()}</span>}
        <span>{language}</span>
        <span className="tabular-nums">Ln {pos.line}, Col {pos.col}{pos.sel ? ` · ${pos.sel} selected` : ""}</span>
        {lines !== undefined && <span className="tabular-nums max-sm:hidden">{lines} line{lines === 1 ? "" : "s"}</span>}
        {!live && <span className="max-sm:hidden">{wrap ? "Wrap" : "No wrap"}</span>}
        {note.local?.broken && <span className="min-w-0 truncate text-[var(--danger)]" title={note.local.broken}>Not a page Etude can read: {note.local.broken}</span>}
        {path && <button type="button" className="min-w-0 truncate text-left hover:text-foreground max-sm:hidden" title="Copy the path" onClick={() => copyPath(path)}>{path}</button>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- a web file

/** A web file, open on its own: running big, and its HTML beside it (or under it) while you edit. */
function WebNoteView({ note, all, saveState, onPick, onContent, onBack }: {
  note: Note;
  all: NoteSummary[];
  saveState: SaveState;
  onPick(id: string): void;
  onContent(c: string): void;
  onBack?: () => void;
}) {
  const t = note.title;
  const [html, setHtml] = useState(note.content ?? "");
  const [shown, setShown] = useState(html);
  const [code, setCode] = useState(() => localStorage.getItem("etude.web.code") === "1");
  const [run, setRun] = useState(0);
  const crumbs = useMemo(() => {
    const by = new Map(all.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];
    for (let p = note.parentId ? by.get(note.parentId) : undefined; p; p = p.parentId ? by.get(p.parentId) : undefined) out.unshift(p);
    return out;
  }, [all, note.parentId]);
  const strip = useContext(NoteTabsCtx);
  const plus = useContext(NotePlusCtx);
  // It follows the code after a short pause, so it doesn't restart on every key.
  useEffect(() => {
    if (html === shown) return;
    const tm = setTimeout(() => setShown(html), 450);
    return () => clearTimeout(tm);
  }, [html, shown]);
  // Saved elsewhere (an embed, the CLI) while this is open and untouched: show that.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && note.content !== null && note.content !== html) (setHtml(note.content), setShown(note.content));
  }, [note.content]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (saveState === "saved" && touched.current) webChanged(note.id);
  }, [saveState, note.id]);
  const toggleCode = () => setCode((c) => (localStorage.setItem("etude.web.code", c ? "0" : "1"), !c));
  const ro = useReadOnly(note);
  return (
    <article className="note-page note-canvas-page note-web-page">
      <div className="note-topbar">
        {onBack && (
          <button type="button" className="note-back" onClick={onBack} aria-label="Back to Notebook">
            <ChevronRight className="size-4 rotate-180" /> Notebook
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
            <span className="truncate px-1 text-foreground/80">{display({ title: t, kind: "web" })}</span>
          </nav>
        )}
        {plus}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1">
          <EditedBy note={note} />
          {!ro && <span className={cn("note-save", saveState)} aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>}
          <ShareBits note={note} />
          <button type="button" onClick={() => setRun((r) => r + 1)} className="note-row-act is-visible" title="Run it again from the start" aria-label="Run again"><RotateCw className="size-4" /></button>
          {!ro && <button type="button" onClick={toggleCode} className={cn("note-row-act is-visible", code && "is-on")} title={code ? "Hide the code" : "Edit the code"} aria-label={code ? "Hide the code" : "Edit the code"} aria-pressed={code}><Code2 className="size-4" /></button>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Web file options" className="note-row-act is-visible"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => void exportNote({ ...note, title: t }, "md")}><Download className="size-4" /> Download as .html</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div className={cn("note-web-body", code && !ro && "has-code")}>
        <div className="note-web-stage">
          <HtmlFrame html={shown} run={run} title={display({ title: t, kind: "web" })} className="note-web-frame" minHeight={200} />
        </div>
        {code && !ro && (
          <div className="note-web-code">
            <AnyCodeEditor
              value={html}
              onChange={(v) => {
                touched.current = true;
                setHtml(v);
                onContent(v);
              }}
              language="html"
              minLines={20}
              className="px-1 py-1"
            />
          </div>
        )}
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

/** What a tab group's label does: rename, recolour, fold, dissolve, close. */
type GroupActions = {
  editing: string | null;
  setEditing(id: string | null): void;
  edit(id: string, patch: { name?: string; color?: GroupColor; collapsed?: boolean }): void;
  ungroup(id: string): void;
  close(id: string): void;
  /** The label was pressed: a drag from here moves the whole group. */
  drag(g: TabGroup, e: React.PointerEvent<HTMLElement>): void;
  /** False right after a drag, whose pointer-up isn't a click on the label. */
  clickable(): boolean;
  /** False for a moment after the card opens, so the closing of the menu that opened it doesn't shut it. */
  settled(): boolean;
  /** The group a dragged tab would join, and the group being dragged. */
  target: string | null;
  moving: string | null;
};
/** A pinned tab's own icon: the tab whose picker is open, and setting it (null: the page's own again). */
type IconActions = { editing: string | null; setEditing(tab: string | null): void; set(tab: string, icon: string | null): void; settled(): boolean };
const groupLabel = (g: TabGroup) => g.name.trim() || (g.color.startsWith("#") ? "Unnamed group" : `${g.color[0].toUpperCase()}${g.color.slice(1)} group`);
/** A group's colour for its label, its tabs' line and its swatch; a colour of your own also sets the label's text so it reads. */
const groupStyle = (c: GroupColor) => ({ "--tg": groupTint(c), ...(c.startsWith("#") ? { "--tgf": accentText(c) } : {}) }) as React.CSSProperties;

/** A group folding or unfolding: each tab takes FOLD_MS, one starting a step after the other; a big group's steps shrink so the whole stays short. */
const FOLD_MS = 240;
const foldStep = (n: number) => (n > 1 ? Math.min(55, 220 / (n - 1)) : 0);

const MIX_HUES = `conic-gradient(from 0deg, ${Array.from({ length: 25 }, (_, i) => `hsl(${i * 15} 100% 50%)`).join(", ")})`;
const MIX_SIZE = 148;

/** Any colour for a group, on a small wheel like the accent's: around it the hue, toward its middle the paler
 *  shades, a bar under it for brightness, and the hex to type or paste. */
function GroupColorMixer({ value, onChange }: { value: string; onChange(hex: string): void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const set = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    onChange(hex);
  };
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const wheel = useDrag((x, y, r) => {
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    // A colour picked on a wheel that was nearly black comes out bright enough to see.
    set({ h, s: Math.min(1, Math.hypot(dx, dy) / (r.width / 2)), v: hsv.v < 0.25 ? 0.85 : hsv.v });
  });
  const bar = useDrag((x, _y, r) => set({ ...hsv, v: clamp((x - r.left) / r.width) }));
  const rad = (hsv.h * Math.PI) / 180;
  const pin = { x: MIX_SIZE / 2 + Math.sin(rad) * hsv.s * (MIX_SIZE / 2), y: MIX_SIZE / 2 - Math.cos(rad) * hsv.s * (MIX_SIZE / 2) };
  const hex = hsvToHex(hsv);
  return (
    <div className="mt-3 flex flex-col items-center gap-2.5" data-group-mixer>
      <div {...wheel} role="slider" aria-label="Hue and strength" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} tabIndex={-1} className="note-mix-wheel" style={{ width: MIX_SIZE, height: MIX_SIZE }}>
        <span className="absolute inset-0 rounded-full" style={{ background: MIX_HUES }} />
        <span className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle closest-side, #fff, rgb(255 255 255 / 0.6) 35%, transparent)" }} />
        <span className="absolute inset-0 rounded-full bg-black" style={{ opacity: 1 - hsv.v }} />
        <span className="absolute inset-0 rounded-full ring-1 ring-black/10 ring-inset" />
        <span className="note-mix-pin" style={{ left: pin.x, top: pin.y, background: hex }} />
      </div>
      <div {...bar} role="slider" aria-label="Brightness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.v * 100)} tabIndex={-1} className="note-mix-bar" style={{ background: `linear-gradient(to right, #000, ${hsvToHex({ ...hsv, v: 1 })})` }}>
        <span className="note-mix-pin" style={{ left: `${hsv.v * 100}%`, top: "50%", background: hex }} />
      </div>
      <input
        value={text}
        spellCheck={false}
        maxLength={7}
        aria-label="Hex colour"
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          const typed = /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith("#") ? v : `#${v}`).toLowerCase() : null;
          if (typed) (setHsv(hexToHsv(typed)), onChange(typed));
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className="h-7 w-full rounded-[7px] border border-border bg-transparent px-2 text-center font-mono text-[12px] outline-none focus:border-foreground/40"
      />
    </div>
  );
}

/** A group's label in the strip, before its tabs: its name on its colour. A click folds or unfolds the group;
 *  a right-click (and making the group) opens its card: name, colour, Ungroup, Close group. */
function TabGroupChip({ g, act, shown }: { g: TabGroup; act: GroupActions; shown: number }) {
  const open = act.editing === g.id;
  const own = g.color.startsWith("#");
  const [mixing, setMixing] = useState(false);
  useEffect(() => {
    if (!open) setMixing(false);
  }, [open]);
  return (
    <Popover open={open} onOpenChange={(o) => (o || act.settled()) && act.setEditing(o ? g.id : null)}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-tab-group={g.id}
          aria-expanded={!g.collapsed}
          aria-label={`${groupLabel(g)}, ${g.tabs.length} ${g.tabs.length === 1 ? "tab" : "tabs"}${g.collapsed ? ", folded" : ""}`}
          title={`${groupLabel(g)} · click to ${g.collapsed ? "unfold" : "fold"}, drag to move, right-click to edit`}
          className={cn("note-tab-group", !g.name.trim() && "is-bare", g.collapsed && "is-folded", act.target === g.id && "is-target", act.moving === g.id && "is-dragging")}
          style={{ ...groupStyle(g.color), "--n": shown, "--tw": `${FOLD_MS + foldStep(g.tabs.length) * (g.tabs.length - 1)}ms` } as React.CSSProperties}
          onPointerDown={(e) => (e.stopPropagation(), act.drag(g, e))}
          onClick={() => act.clickable() && act.edit(g.id, { collapsed: !g.collapsed })}
          onContextMenu={(e) => {
            e.preventDefault();
            act.setEditing(g.id);
          }}
        >
          {g.name.trim() && <span className="truncate">{g.name.trim()}</span>}
          <span className="note-tab-group-n" aria-hidden={!g.collapsed}>{g.tabs.length}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={8} className="w-[232px] rounded-[14px] p-2.5" data-tab-group-card onEscapeKeyDown={() => act.setEditing(null)} onCloseAutoFocus={(e) => e.preventDefault()}>
        <input
          autoFocus
          value={g.name}
          maxLength={60}
          placeholder="Name this group"
          aria-label="Group name"
          onChange={(e) => act.edit(g.id, { name: e.target.value })}
          onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.preventDefault(), e.stopPropagation(), act.setEditing(null))}
          className="h-8 w-full rounded-[8px] border border-border bg-transparent px-2.5 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-foreground/40"
        />
        <div role="radiogroup" aria-label="Group colour" className="mt-2.5 flex items-center justify-between px-0.5">
          {GROUP_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={g.color === c} aria-label={c} title={c} data-color={c} onClick={() => (setMixing(false), act.edit(g.id, { color: c }))} className={cn("note-tab-swatch", g.color === c && "is-on")} style={groupStyle(c)} />
          ))}
          {/* Any other colour: the rainbow opens a small mixer. */}
          <button type="button" role="radio" aria-checked={own} aria-label="A colour of your own" title="A colour of your own" data-color="own" aria-expanded={mixing || own} onClick={() => setMixing(true)} className={cn("note-tab-swatch is-own", own && "is-on")} style={own ? groupStyle(g.color) : undefined} />
        </div>
        {(mixing || own) && <GroupColorMixer value={own ? g.color : "#5b93f0"} onChange={(hex) => act.edit(g.id, { color: hex as GroupColor })} />}
        <div className="mt-2 flex flex-col border-t border-border pt-1.5">
          <button type="button" className="achat-act" onClick={() => (act.setEditing(null), act.ungroup(g.id))}>Ungroup</button>
          <button type="button" className="achat-act" onClick={() => (act.setEditing(null), act.close(g.id))}>Close group</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One pane's open pages as tabs in its top bar. Drag a tab to reorder it, to another pane, or to a pane's
 *  edge to split. Middle click or × closes one; right-click has Pin, groups, Split right / Split down.
 *  Pinned tabs are small and first; a group's tabs follow its label and carry its colour. */
function NoteTabs({ pane, node, groupAct, iconAct, tabs, all, current, onPick, onClose, onDrag, menu, dragging }: {
  pane: string;
  node: PaneNode;
  groupAct: GroupActions;
  iconAct: IconActions;
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
    const f = () => {
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setOver((prev) => (prev.l === l && prev.r === r ? prev : { l, r }));
    };
    f();
    el.addEventListener("scroll", f, { passive: true });
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => (el.removeEventListener("scroll", f), ro.disconnect());
  }, [tabs.length]);
  // The current tab stays in view when the strip scrolls.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(".note-tab.is-on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current, tabs.length]);
  const docked = useDock();
  const profiles = useAgentProfiles();
  const webs = useWebTabs();
  const shown = tabs.filter((t) => by.has(t) || isStartTab(t) || isChatTab(t) || (isWebTab(t) && !!webs[t]));
  const labelled = new Set<string>();
  // Folding a group tucks its tabs into the label one by one, last first; unfolding deals them back out.
  // A folded group's tabs stay in the strip for the length of that, then go.
  const [motion, setMotion] = useState<Record<string, "in" | "out">>({});
  const was = useRef<Map<string, boolean> | null>(null);
  const timers = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const now = new Map((node.groups ?? []).map((g) => [g.id, !!g.collapsed]));
    const before = was.current;
    was.current = now;
    if (!before || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const g of node.groups ?? []) {
      const b = before.get(g.id);
      if (b === undefined || b === !!g.collapsed) continue;
      window.clearTimeout(timers.current.get(g.id));
      setMotion((m) => ({ ...m, [g.id]: g.collapsed ? "out" : "in" }));
      timers.current.set(g.id, window.setTimeout(() => setMotion(({ [g.id]: _, ...rest }) => rest), FOLD_MS + foldStep(g.tabs.length) * (g.tabs.length - 1) + 30));
    }
  }, [node.groups]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  return (
    <div ref={strip} role="tablist" aria-label="Open pages" data-tabs-of={pane} className={cn("note-tabs", over.l && "fade-l", over.r && "fade-r")}>
      {shown.flatMap((tid) => {
        const g = groupOf(node, tid);
        const move = g ? motion[g.id] : undefined;
        const chip = g && !labelled.has(g.id) ? <TabGroupChip key={`group:${g.id}`} g={g} act={groupAct} shown={shown.filter((t) => g.tabs.includes(t)).length} /> : null;
        if (g) labelled.add(g.id);
        // The label has its own place in the list, never inside a tab's element, so folding doesn't remake it.
        if (g?.collapsed && move !== "out") return [chip];
        const at = g ? g.tabs.indexOf(tid) : 0;
        const pinned = isPinned(node, tid);
        const own = pinned ? (node.icons?.[tid] ?? null) : null;
        // A New tab (the start page) isn't a note: it's called New tab and has an empty-page icon.
        // Nor is a chat: its tab has who it's with and the chat's name.
        const chat = isChatTab(tid) ? (docked.metas[chatKey(tid)] ?? { title: "", profile: "", busy: false }) : null;
        const web = isWebTab(tid) ? webs[tid] : undefined;
        const n = by.get(tid) ?? { id: tid, title: chat ? chat.title || "New chat" : web || isWebTab(tid) ? webTitle(web) : "New tab", kind: "page" as const, icon: null };
        const start = isStartTab(tid);
        const on = tid === current;
        return [
          chip,
          <ContextMenu key={tid}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                title={pinned ? `${display(n)} (pinned)` : display(n)}
                data-tab={tid}
                data-pinned={pinned || undefined}
                data-in-group={g?.id}
                data-folding={move === "out" || undefined}
                style={g ? { ...groupStyle(g.color), ...(move ? { "--td": `${foldStep(g.tabs.length) * (move === "out" ? g.tabs.length - 1 - at : at)}ms` } : {}) } : undefined}
                className={cn("note-tab group", on && "is-on", pinned && "is-pinned", g && "in-group", move === "out" && "is-folding", move === "in" && "is-unfolding", (dragging === tid || (g && groupAct.moving === g.id)) && "is-dragging")}
                onPointerDown={(e) => onDrag(tid, e)}
                onClick={() => onPick(tid)}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => e.button === 1 && onClose(tid)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(tid))}
              >
                {pinned && (
                  <Popover open={iconAct.editing === tid} onOpenChange={(o) => (o || iconAct.settled()) && iconAct.setEditing(o ? tid : null)}>
                    <PopoverAnchor asChild><span className="pointer-events-none absolute inset-0" aria-hidden /></PopoverAnchor>
                    <PopoverContent align="start" sideOffset={8} className="w-auto p-2" data-tab-icon-card onEscapeKeyDown={() => iconAct.setEditing(null)} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onCloseAutoFocus={(e) => e.preventDefault()}>
                      <NoteIconPicker icon={own} onPick={(i) => (iconAct.set(tid, i), iconAct.setEditing(null))} onRemove={() => (iconAct.set(tid, null), iconAct.setEditing(null))} />
                    </PopoverContent>
                  </Popover>
                )}
                <span className="note-tab-icon" aria-hidden>{chat?.busy ? <Loader2 className="size-3.5 animate-spin" /> : own ? <NoteIcon icon={own} size={18} /> : chat ? (chat.busy ? <Loader2 className="size-3.5 animate-spin" /> : <AgentAvatar profile={profileFrom(profiles, chat.profile || null)} size={16} />) : isWebTab(tid) ? <WebTabIcon meta={web} /> : start ? <StartTabIcon /> : isFile(n) && !n.icon ? <FileCode2 className="size-3.5" /> : isWeb(n) && !n.icon ? <Code2 className="size-3.5" /> : <NoteIcon icon={n.icon} size={15} />}</span>
                <span className={cn("note-tab-title min-w-0 flex-1 truncate", !n.title.trim() && "text-muted-foreground")}>{display(n)}</span>
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
            <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
              {menu(tid).map((m, i) =>
                m === "sep" ? <ContextMenuSeparator key={i} /> : (
                  <ContextMenuItem key={i} disabled={m.disabled} variant={m.danger ? "destructive" : "default"} onSelect={m.onSelect}>
                    {m.dot && <span className="note-tab-dot" style={{ background: groupTint(m.dot) }} aria-hidden />}
                    <span className="min-w-0 truncate">{m.label}</span>
                  </ContextMenuItem>
                ),
              )}
            </ContextMenuContent>
          </ContextMenu>,
        ];
      })}
    </div>
  );
}

// ---------------------------------------------------------------- a pane

/** What every pane needs from the screen. */
type PaneCtx = {
  phone: boolean;
  list: NoteSummary[] | null;
  /** `list`, and the pinned and lately opened files of folders the tree doesn't list: what the start page shows. */
  startList: NoteSummary[] | null;
  tree: Tree;
  listRef: React.MutableRefObject<NoteSummary[] | null>;
  primed: Map<string, Note>;
  bumps: Record<string, number>;
  flushers: Set<() => Promise<void>>;
  patchRow(id: string, p: Partial<NoteSummary>): void;
  /** A new name, as typing one in the sidebar gives: a file on this computer is renamed on disk and its tabs follow. */
  renameNote(id: string, title: string): void;
  pick(pane: string, id: string, mode?: "replace" | "new" | "background"): void;
  focus(pane: string): void;
  /** A pane's zoom: a step in (1), out (-1), or back to 100% (0). */
  zoom(pane: string, by: ZoomBy): void;
  missing(pane: string, id: string): void;
  add(parentId: string | null, kind?: "page" | "canvas" | "file" | "web" | "kanban", title?: string, unique?: boolean): Promise<void>;
  addFolder(parentId: string | null): Promise<void>;
  setKind(n: NoteSummary, kind: "page" | "folder"): Promise<void>;
  setOpen(id: string, on: boolean): void;
  reload(): Promise<void>;
  importVault(): void;
  /** Open a folder from this computer (not there in the web edition or on a phone). */
  openFolder?: () => void;
  addTutorial(): void;
  importMd(): void;
  pickPdf(parentId: string | null): void;
  newFile(): void;
  setPinned(ids: string[], on: boolean): Promise<void>;
  createFromStart(pane: string, title: string, newTab: boolean): Promise<void>;
};

/** One open page and its own top bar, editor and saving. With one pane it scrolls with the window, as before. */
function NotePane({ pane, noteId, ctx, focused, zoom, strip, plus }: {
  pane: string;
  noteId: string | null;
  ctx: PaneCtx;
  focused: boolean;
  zoom: number;
  strip: React.ReactNode;
  plus: React.ReactNode;
}) {
  const { list, tree, phone } = ctx;
  const [note, setNote] = useState<Note | null>(null);
  const bump = noteId ? (ctx.bumps[noteId] ?? 0) : 0;
  const seen = useRef<{ id: string | null; bump: number }>({ id: null, bump: 0 });
  useEffect(() => {
    if (!noteId || isStartTab(noteId) || isChatTab(noteId) || isWebTab(noteId)) return setNote(null);
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

  // The page as this pane last read or wrote it: its time and body, the base for merging a save made somewhere else.
  const base = useRef<{ id: string; updated: string; doc: NoteDoc } | null>(null);
  useEffect(() => {
    if (note && note.kind === "page") base.current = { id: note.id, updated: note.updated, doc: note.doc };
  }, [note]);
  // Boards, files, web files and canvases: when this pane last read or wrote one, and a count that opens the view
  // again on a version saved somewhere else.
  const stamp = useRef<{ id: string; updated: string } | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (note && note.kind !== "page") stamp.current = { id: note.id, updated: note.updated };
  }, [note]);
  // A file on this computer: its text as this pane last read or wrote it, the base for putting together what was
  // typed here and what another program wrote to the file meanwhile.
  const fileText = useRef<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (note?.local && typeof note.content === "string") fileText.current = { id: note.id, text: note.content.replace(/\r\n/g, "\n") };
  }, [note]);
  const edRef = useRef<NoteEditorHandle | null>(null);
  const hooks = useRef<SaveHooks>({});
  const saver = useSaver(
    noteId,
    (n, sent) => {
      if (base.current?.id === n.id) base.current = { id: n.id, updated: n.updated, doc: sent.doc ?? base.current.doc };
      if (stamp.current?.id === n.id) stamp.current = { id: n.id, updated: n.updated };
      if (fileText.current?.id === n.id && typeof n.content === "string") fileText.current = { id: n.id, text: n.content.replace(/\r\n/g, "\n") };
      ctx.patchRow(n.id, { title: n.title, updated: n.updated });
    },
    hooks,
  );
  /** Puts the newest saved page in the editor with this pane's unsaved edits merged in. Returns the body to write, or null when nothing of ours is left to save. */
  const takeTheirs = useCallback((latest: Note): NoteDoc | null => {
    const ed = edRef.current;
    const b = base.current;
    if (!ed || !b || b.id !== latest.id) return null;
    const theirs = ed.normalize(latest.doc);
    const mine = ed.json();
    const { doc, conflicts } = mergeDocs(ed.normalize(b.doc) as any, mine as any, theirs as any);
    const merged = doc as NoteDoc;
    if (JSON.stringify(merged) !== JSON.stringify(mine)) ed.replace(merged);
    base.current = { id: latest.id, updated: latest.updated, doc: theirs };
    if (conflicts) toast("This page changed somewhere else too. Both versions are kept where they differ.");
    return JSON.stringify(merged) === JSON.stringify(theirs) ? null : merged;
  }, []);
  hooks.current = {
    base: () => (base.current && base.current.id === noteId ? base.current.updated : undefined),
    conflict: async (target, p) => {
      for (let i = 0; i < 3; i++) {
        const latest = await api.note(target);
        const doc = takeTheirs(latest);
        if (!doc) return latest;
        saver.repending({ doc });
        try {
          return await api.updateNote(target, { ...p, doc, base: latest.updated });
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
        }
      }
      throw new Error("the page keeps changing somewhere else; try again in a moment");
    },
    fileBase: () => (isFsId(noteId) && stamp.current?.id === noteId ? stamp.current.updated : undefined),
    // Another program wrote the file while it was being edited here. What was typed and what was written are put
    // together line by line (where both changed the same lines, both stay), shown in the editor, and saved.
    fileConflict: async (target, p) => {
      const lf = (t: string) => t.replace(/\r\n/g, "\n");
      let mine = lf(p.content ?? "");
      for (let i = 0; i < 3; i++) {
        const latest = await api.note(target);
        const theirs = lf(latest.content ?? "");
        const from = fileText.current?.id === target ? fileText.current.text : theirs;
        const { result, conflicts } = merge3(from.split("\n"), mine.split("\n"), theirs.split("\n"));
        mine = result.join("\n");
        fileText.current = { id: target, text: theirs };
        stamp.current = { id: target, updated: latest.updated };
        // A later try writes the text put together, never the one from before.
        p.content = mine;
        saver.repending({ content: mine });
        setNote({ ...latest, content: mine });
        if (i === 0) toast(conflicts ? "This file changed on disk while you were typing. Both versions are kept where they differ." : "This file changed on disk while you were typing. The two sets of changes were put together.");
        if (mine === theirs) return latest;
        try {
          return await api.updateNote(target, { content: mine, base: latest.updated });
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
        }
      }
      throw new Error("the file keeps changing on disk; try again in a moment");
    },
  };
  // A page saved somewhere else (the CLI, an agent, another window) shows up here on its own, without reopening it.
  const isPage = !!note && note.id === noteId && note.kind === "page";
  useEffect(() => {
    if (!isPage || !noteId || isLocal()) return;
    let live = true;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== "visible" || saver.busy()) return;
      const b = base.current;
      if (!b || b.id !== noteId) return;
      checking = true;
      try {
        const { updated } = await api.noteStamp(noteId);
        if (!live || updated === b.updated || saver.busy()) return;
        const latest = await api.note(noteId);
        if (!live || saver.busy()) return;
        const doc = takeTheirs(latest);
        ctx.patchRow(latest.id, { title: latest.title, updated: latest.updated });
        if (doc) saver.queue({ doc });
      } catch {
        // Offline or the page went away: the next look or save says so.
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 2000);
    const now = () => void check();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [isPage, noteId, takeTheirs]);
  // A board, file, web file or canvas changed somewhere else (the CLI, an agent, another window) shows up here too.
  // A board takes the new version in place, like a change from one of its portals; the others open again on it.
  // Nothing is taken while this pane has a change of its own waiting to be written.
  const watchOther = !!note && note.id === noteId && (note.kind === "kanban" || note.kind === "file" || note.kind === "web" || note.kind === "canvas");
  useEffect(() => {
    if (!watchOther || !noteId || isLocal()) return;
    let live = true;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== "visible" || saver.busy()) return;
      const s = stamp.current;
      if (!s || s.id !== noteId) return;
      checking = true;
      try {
        const { updated } = await api.noteStamp(noteId);
        if (!live || updated === s.updated || saver.busy()) return;
        const latest = await api.note(noteId);
        if (!live || saver.busy() || latest.id !== noteId) return;
        stamp.current = { id: latest.id, updated: latest.updated };
        ctx.patchRow(latest.id, { title: latest.title, updated: latest.updated });
        if (latest.kind === "kanban" && latest.board) kanbanChanged(latest.id, latest.board, "outside");
        // A file's editor takes the new text where it differs, keeping the cursor; a web file or canvas opens again.
        else if (latest.kind !== "file" || latest.content === null) setRev((r) => r + 1);
        setNote(latest);
      } catch {
        // Offline or it went away: the next look says so.
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 2000);
    const now = () => void check();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [watchOther, noteId]);
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
        // Pages link to pages of the collection; files on this computer link among themselves, by name.
        return hits.filter((n) => n.id !== noteId && !isFolder(n) && !n.local).map((n) => ({ id: n.id, title: n.title, icon: n.icon, path: path(n) }));
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

  // A link clicked in a Markdown file: a web address opens as one; anything else is looked for in the file's folder
  // (beside it, from the folder's top, or by name anywhere, as Obsidian does).
  const followLink = useCallback(
    (link: FileLink, newTab: boolean) => {
      const target = link.target.trim();
      if (link.kind === "href" && /^(https?:|mailto:|tel:)/i.test(target)) return void window.open(target, "_blank", "noopener");
      if (!isFsId(noteId)) return void toast("Links between files work in a folder opened from this computer.");
      void api.resolveFolderLink(noteId, target).then(
        ({ id }) => {
          if (id === noteId) return;
          if (id) return ctx.pick(pane, id, newTab ? "new" : "replace");
          const dir = fsParent(noteId);
          const name = target.split("|")[0].split("#")[0].trim();
          toast(`Nothing called “${name}” in this folder`, link.kind === "wiki" && dir && name && !name.includes("/") ? { action: { label: "Create it", onClick: () => void ctx.add(dir, "file", /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`) } } : undefined);
        },
        (e) => toast.error((e as Error).message),
      );
    },
    [noteId, pane, ctx.pick, ctx.add],
  );

  // A rename in the sidebar shows here too (canvases and files show the name from the note).
  const row = noteId ? list?.find((n) => n.id === noteId) : undefined;
  const shown = note && note.id === noteId ? (row && row.title !== note.title ? { ...note, title: row.title } : note) : null;
  const back = phone ? () => navigate("/notes") : undefined;
  // The top bar of a file from disk that isn't text: its tabs (or its name), nothing to save.
  const localTop = (n: Note) => (
    <div className="note-topbar">
      {back && (
        <button type="button" className="note-back" onClick={back} aria-label="Back to Notebook">
          <ChevronRight className="size-4 rotate-180" /> Notebook
        </button>
      )}
      {strip ?? <span className="ns-tabname">{n.local?.name ?? display(n)}</span>}
      {plus}
      <span className="flex-1" />
    </div>
  );
  // Zoom: CSS zoom on what the pane shows (its top bar stays as it is); a web page and a canvas zoom themselves,
  // a PDF takes the keys and re-renders. The size shows for a moment when it changes, like a browser's.
  const selfZoom = isWebTab(noteId) || (!!shown && (shown.kind === "pdf" || shown.kind === "canvas"));
  const [pill, setPill] = useState(false);
  const firstZoom = useRef(true);
  useEffect(() => {
    if (firstZoom.current) return void (firstZoom.current = false);
    setPill(true);
    const t = setTimeout(() => setPill(false), 1200);
    return () => clearTimeout(t);
  }, [zoom]);
  return (
    <PaneIdCtx.Provider value={pane}>
    <NoteTabsCtx.Provider value={strip}>
      <NotePlusCtx.Provider value={plus}>
        <section
          data-pane={pane}
          data-pane-note={noteId ?? ""}
          data-pane-kind={shown?.kind ?? ""}
          data-zoom={zoom !== 1 && !selfZoom ? "" : undefined}
          style={zoom !== 1 && !selfZoom ? ({ "--pane-zoom": zoom } as React.CSSProperties) : undefined}
          className={cn("notes-main note-pane", focused && "is-focus")}
          onPointerDownCapture={() => ctx.focus(pane)}
          onFocusCapture={() => ctx.focus(pane)}
        >
          {pill && !(shown && shown.kind === "pdf") && !(shown && shown.kind === "canvas") && (
            <button key={zoom} type="button" className="pane-zoom-pill" onClick={() => ctx.zoom(pane, 0)} title="Back to 100% (Ctrl 0)">
              {Math.round(zoom * 100)}%
            </button>
          )}
          {isChatTab(noteId) ? (
            <ChatPage key={noteId} id={noteId} strip={strip} plus={plus} onFocus={() => ctx.focus(pane)} />
          ) : isWebTab(noteId) ? (
            <WebPage
              key={noteId}
              id={noteId}
              zoom={zoom}
              onFocus={() => ctx.focus(pane)}
              top={
                <div className="note-topbar">
                  {strip ?? <span className="ns-tabname">{webTitle(webTabs.get(noteId))}</span>}
                  {plus}
                  <span />
                </div>
              }
            />
          ) : isStartTab(noteId) ? (
            list && (
              <NoteStart
                key={noteId}
                list={ctx.startList ?? list}
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
                  openFolder: ctx.openFolder,
                  // A web page where the New tab was, like a browser's.
                  web: canWebTabs() ? () => ctx.pick(pane, webTabs.create(WEB_HOME), "replace") : undefined,
                }}
              />
            )
          ) : shown && shown.local && shown.kind === "file" && shown.content === null ? (
            shown.local.type === "image" || shown.local.type === "audio" || shown.local.type === "video" ? (
              <LocalMediaView key={shown.id} note={shown} top={localTop(shown)} />
            ) : (
              <LocalOtherView key={shown.id} note={shown} top={localTop(shown)} path={diskPath(shown, list ?? [])} />
            )
          ) : shown && isFile(shown) ? (
            <FileView
              key={`${shown.id}:${rev}`}
              note={shown}
              all={list ?? []}
              saveState={saver.state}
              onPick={onPick}
              onLink={followLink}
              onTitle={(title) => {
                // A file on this computer is renamed on disk, and its tab follows it to its new name.
                if (isFsId(shown.id)) return ctx.renameNote(shown.id, title);
                ctx.patchRow(shown.id, { title });
                saver.queue({ title });
              }}
              onContent={(content) => saver.queue({ content })}
              onSave={() => void saver.flush()}
              onBack={back}
            />
          ) : shown && isWeb(shown) ? (
            <WebNoteView key={`${shown.id}:${rev}`} note={shown} all={list ?? []} saveState={saver.state} onPick={onPick} onContent={(content) => saver.queue({ content })} onBack={back} />
          ) : shown && isKanban(shown) ? (
            <KanbanNoteView
              key={shown.id}
              note={shown}
              all={list ?? []}
              saveState={saver.state}
              onPick={onPick}
              links={links}
              onBack={back}
              onTitle={(title) => {
                if (isFsId(shown.id)) return ctx.renameNote(shown.id, title);
                ctx.patchRow(shown.id, { title });
                saver.queue({ title });
              }}
              onPageTitle={(pageTitle) => saver.queue({ pageTitle })}
              onBoard={(board) => saver.queue({ board })}
            />
          ) : shown && shown.kind === "pdf" ? (
            <PdfNoteView key={shown.id} note={shown} all={list ?? []} onPick={onPick} />
          ) : shown && shown.kind === "canvas" ? (
            <CanvasView
              key={`${shown.id}:${rev}`}
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
              onAddMarkdown={shown.local ? () => void ctx.add(shown.id, "file", "Untitled.md", true) : undefined}
              onAddFolder={() => void ctx.addFolder(shown.id)}
              onMakePage={shown.local ? undefined : () => void ctx.setKind(shown, "page")}
              path={diskPath(shown, list ?? [])}
              onOpenFolder={(fid) => ctx.setOpen(fid, true)}
              onBack={back}
            />
          ) : shown ? (
            <PageView
              key={shown.id}
              editorRef={edRef}
              note={shown}
              tree={tree}
              all={list ?? []}
              saveState={saver.state}
              onPick={onPick}
              onTitle={(title) => {
                if (isFsId(shown.id)) return ctx.renameNote(shown.id, title);
                ctx.patchRow(shown.id, { title });
                saver.queue({ title });
              }}
              onPageTitle={(pageTitle) => saver.queue({ pageTitle })}
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
              <p className="max-w-sm text-[14px] text-muted-foreground">Your notebook lives next to your decks. Type <kbd>/</kbd> for blocks, <kbd>[[</kbd> to link a page, <kbd>#</kbd> for a heading. Everything saves on its own.</p>
              <p className="max-w-sm text-[13px] text-muted-foreground/80">Notebook is in beta: expect rough edges, and it doesn't sync to your other devices yet.</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => void ctx.add(null)} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <FilePlus2 className="size-4" /> New page
                </button>
                <button type="button" onClick={ctx.importVault} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <FolderInput className="size-4" /> Import a vault
                </button>
                <button type="button" onClick={ctx.addTutorial} className="lib-raised inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]">
                  <GraduationCap className="size-4" /> Notebook tutorial
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </NotePlusCtx.Provider>
    </NoteTabsCtx.Provider>
    </PaneIdCtx.Provider>
  );
}

/** A chat open as a tab: the pane's top bar, and under it the chat's own box (it's drawn above the pages, so it
 *  keeps going when its tab moves to another pane). */
function ChatPage({ id, strip, plus, onFocus }: { id: string; strip: React.ReactNode; plus: React.ReactNode; onFocus(): void }) {
  const key = chatKey(id);
  const meta = useDock().metas[key];
  const profiles = useAgentProfiles();
  const host = useRef<HTMLDivElement>(null);
  const focusPane = useRef(onFocus);
  focusPane.current = onFocus;
  useLayoutEffect(() => {
    const el = host.current!;
    const node = dockNode(key);
    el.appendChild(node);
    dock.setShown(key, true);
    // A box that moved starts at its top: back to the newest message.
    const log = node.querySelector<HTMLElement>("[data-agent-scroll]");
    if (log) log.scrollTop = log.scrollHeight;
    // The chat isn't this pane's child for React, so the pane hears about clicks and focus from the box itself.
    const f = () => focusPane.current();
    el.addEventListener("pointerdown", f, true);
    el.addEventListener("focusin", f);
    return () => {
      el.removeEventListener("pointerdown", f, true);
      el.removeEventListener("focusin", f);
      dock.setShown(key, false);
      if (node.parentElement === el) node.remove();
    };
  }, [key]);
  const slot = useCallback((el: HTMLElement | null) => dock.setSlot(key, el), [key]);
  return (
    <div className="note-canvas-page note-chat-page">
      <div className="note-topbar">
        {strip ?? (
          <span className="ns-tabname">
            <AgentAvatar profile={profileFrom(profiles, meta?.profile || null)} size={16} /> {meta?.title || "New chat"}
          </span>
        )}
        {plus}
        <span ref={slot} className="note-chat-slot" />
      </div>
      <div ref={host} className="note-chat-host" />
    </div>
  );
}

// ---------------------------------------------------------------- dragging tabs

/** Where a dragged chat can also go: back to the side panel. */
type PanelDrop = "panel";
type TabDragView = { pane: string; note: string; label: string; x: number; y: number; drop: TabDrop | PanelDrop | null; zone: Rect | null; line: Rect | null; /** The colour of the group it would join. */ tint?: string; /** That group, to light its label. */ into?: string };
/** What's dragged when it's a whole group: its label stands for it. */
const GROUP_DRAG = "group:";

/** The part of a pane you can see, in viewport pixels: its own box when split (it scrolls inside), the window otherwise. */
function visibleRect(el: Element): Rect {
  const r = (el.closest(".is-multi .note-pane-box") ?? el).getBoundingClientRect();
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  return { x: r.left, y: top, w: r.width, h: Math.max(0, bottom - top) };
}

/** Where a tab dragged from `from` would land under the pointer, and what to draw for it. */
function hitTabDrop(l: Layout, from: string | null, note: string, x: number, y: number): Pick<TabDragView, "drop" | "zone" | "line" | "tint" | "into"> {
  const none = { drop: null, zone: null, line: null };
  const el = document.elementFromPoint(x, y);
  // A chat's tab over the side panel: it goes back there.
  const sidePanel = from && isChatTab(note) ? el?.closest<HTMLElement>("[data-agent-panel]") : null;
  if (sidePanel) {
    const r = sidePanel.getBoundingClientRect();
    return { drop: "panel", zone: { x: r.left + 6, y: r.top + 6, w: r.width - 12, h: r.height - 12 }, line: null };
  }
  const paneEl = el?.closest<HTMLElement>("[data-pane]");
  const pid = paneEl?.dataset.pane;
  if (!paneEl || !pid || !findPane(l.root, pid)) return none;
  // Over a pane's top bar: among its tabs, before the one whose middle is right of the pointer.
  const bar = el!.closest(".note-topbar");
  if (bar && paneEl.contains(bar)) {
    // A whole group being dragged: its own tabs don't count as places to land.
    const whole = note.startsWith(GROUP_DRAG) ? note.slice(GROUP_DRAG.length) : null;
    const tabs = [...paneEl.querySelectorAll<HTMLElement>(".note-tab[data-tab]")].filter((t) => t.dataset.tab !== note && !(whole && t.dataset.inGroup === whole));
    const groups = findPane(l.root, pid)?.groups ?? [];
    // What a tab can land in front of: the tabs in view, and the label of a folded group (standing for its
    // hidden tabs), in the order they sit.
    const spots = [...paneEl.querySelectorAll<HTMLElement>(".note-tab[data-tab], .note-tab-group.is-folded[data-tab-group]")]
      .map((el) => ({ el, tab: el.dataset.tab ?? groups.find((g) => g.id === el.dataset.tabGroup && g.id !== whole)?.tabs.find((t) => t !== note) }))
      .filter((sp): sp is { el: HTMLElement; tab: string } => !!sp.tab && sp.tab !== note && !(whole && sp.el.dataset.inGroup === whole));
    const nextSpot = spots.find((sp) => {
      const r = sp.el.getBoundingClientRect();
      return r.left + r.width / 2 > x;
    });
    const next = nextSpot ? { dataset: { tab: nextSpot.tab } } : undefined;
    const br = bar.getBoundingClientRect();
    const ref = nextSpot?.el ?? spots[spots.length - 1]?.el;
    const lx = ref ? (nextSpot ? ref.getBoundingClientRect().left - 2 : ref.getBoundingClientRect().right + 1) : br.left + 16;
    const line = { x: lx, y: br.top + 8, w: 2, h: br.height - 16 };
    if (whole) return { drop: { pane: pid, before: next?.dataset.tab ?? null }, zone: null, line };
    // On a group's label: it joins, after the group's last tab (the only way into a folded one).
    const chip = el!.closest<HTMLElement>("[data-tab-group]");
    const onChip = chip && paneEl.contains(chip) ? groups.find((g) => g.id === chip.dataset.tabGroup) : undefined;
    if (onChip) {
      const cr = chip!.getBoundingClientRect();
      const last = onChip.collapsed ? null : paneEl.querySelector<HTMLElement>(`.note-tab[data-tab="${CSS.escape(onChip.tabs.filter((t) => t !== note).at(-1) ?? "")}"]`);
      return { drop: { pane: pid, before: null, group: onChip.id }, zone: null, line: { ...line, x: (last?.getBoundingClientRect().right ?? cr.right) + 1 }, tint: groupTint(onChip.color), into: onChip.id };
    }
    // On a tab: it lands beside it, in that tab's group (or in none).
    const over = tabs.find((t) => {
      const r = t.getBoundingClientRect();
      return x >= r.left && x <= r.right;
    });
    // Beside a folded group's label (not on it): it lands next to the group, outside it.
    if (!over) return { drop: { pane: pid, before: next?.dataset.tab ?? null, ...(nextSpot && !nextSpot.el.dataset.tab ? { group: null } : {}) }, zone: null, line };
    const g = groups.find((x) => x.id === over.dataset.inGroup);
    return { drop: { pane: pid, before: next?.dataset.tab ?? null, group: g?.id ?? null }, zone: null, line, ...(g ? { tint: groupTint(g.color), into: g.id } : {}) };
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
/** The page whose place in the tree was last shown; kept outside the screen so coming back doesn't unfold it again. */
let revealedPage: string | null = null;
function loadLayout(): Layout {
  try {
    const v = normalizeLayout(JSON.parse(windowStore.get(LAYOUT_KEY) ?? "null"));
    if (v) return v;
  } catch {}
  // Before split view the tabs were one list.
  try {
    const old = isExtraWindow() ? [] : JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]");
    if (Array.isArray(old)) return single(old.filter((x) => typeof x === "string"));
  } catch {}
  return single([]);
}

export function NotesPage({ id, active = true }: { id: string | null; active?: boolean }) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const phone = usePhone();
  const [dbList, setList] = useState<NoteSummary[] | null>(null);
  // Folders on this computer, open in the Notebook: their own rows, and what's inside each folder that was listed.
  // They sit in the same list as the collection's notes, under the last of them.
  const [disk, setDisk] = useState<Disk>({ roots: [], dirs: {} });
  const diskRef = useRef(disk);
  diskRef.current = disk;
  const [diskOk, setDiskOk] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  // Starting or stopping Sync for a folder on this computer.
  const [syncAsk, setSyncAsk] = useState<{ kind: "on" | "off"; id: string; name: string } | null>(null);
  const list = useMemo(() => (dbList ? [...dbList, ...diskRows(disk)] : null), [dbList, disk]);
  const [open, setOpenSet] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]")));
  const openRef = useRef(open);
  openRef.current = open;
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

  // Files of folders on this computer that are pinned or were opened lately. The tree only knows the folders that
  // are unfolded, so the start page gets these from the server: a pinned file shows there whether or not its
  // folder is listed.
  const [marked, setMarked] = useState<NoteSummary[]>([]);
  const reloadMarked = useCallback(async () => {
    if (isLocal()) return;
    const [pinned, recent] = await Promise.all([api.pinnedNotes(), api.recentNotes(12)]);
    const seen = new Set<string>();
    setMarked([...pinned, ...recent].filter((n) => isFsId(n.id) && !seen.has(n.id) && !!seen.add(n.id)));
  }, []);
  // Which folders on disk the tree lists; worked out further down, from what's unfolded and what's open in tabs.
  const diskNeed = useRef<string[]>([]);
  const diskStamps = useRef<FolderStamps | null>(null);
  const heldSeen = useRef(new Set<string>());
  const reloadDisk = useCallback(async () => {
    // The web edition and the phone apps have no disk to open.
    if (isLocal()) return;
    const r = await api.folderEntries(diskNeed.current);
    diskStamps.current = r.stamps;
    setDiskOk(r.available);
    setDisk({ roots: r.roots, dirs: Object.fromEntries(Object.entries(r.dirs).filter((e): e is [string, NoteSummary[]] => !!e[1])) });
    void reloadMarked().catch(() => {});
  }, [reloadMarked]);
  const reload = useCallback(async () => {
    const [notes] = await Promise.all([api.notes(), reloadDisk().catch(() => {})]);
    setList(notes);
  }, [reloadDisk]);
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

  // Notes made, moved, renamed or deleted somewhere else (the CLI, an agent, another window) show up in the tree.
  useEffect(() => {
    if (isLocal()) return;
    let last: string | null = null;
    let live = true;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const { stamp } = await api.notesTreeStamp();
        if (!live) return;
        if (last !== null && stamp !== last) await reload();
        last = stamp;
        // Folders on this computer: a file added, removed or renamed in a listed folder, by any program, shows up too.
        const now = await api.folderStamps(Object.keys(diskRef.current.dirs));
        if (live && stampsDiffer(diskStamps.current, now)) await reloadDisk();
        // Removals Sync is holding back for a folder: said once, with the way to let them through.
        for (const h of now.held ?? [])
          toast(`Sync is holding back removals in “${h.name}”`, { id: `folder-held-${h.syncId}`, description: h.why, duration: Infinity, action: { label: "Go ahead", onClick: () => void api.folderSyncGo(h.syncId).catch((e) => toast.error((e as Error).message)) } });
        for (const id of heldSeen.current) if (!(now.held ?? []).some((h) => h.syncId === id)) toast.dismiss(`folder-held-${id}`);
        heldSeen.current = new Set((now.held ?? []).map((h) => h.syncId));
      } catch {
        // Offline: the next look says so.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 3000);
    const now = () => void check();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [reload]);

  // The title in the tree follows what's typed, before it's saved.
  const patchRow = useCallback((rid: string, p: Partial<NoteSummary>) => {
    if (!isFsId(rid)) return setList((l) => l?.map((n) => (n.id === rid ? { ...n, ...p } : n)) ?? l);
    const at = (rows: NoteSummary[]) => (rows.some((n) => n.id === rid) ? rows.map((n) => (n.id === rid ? { ...n, ...p } : n)) : rows);
    setDisk((d) => ({ roots: at(d.roots), dirs: Object.fromEntries(Object.entries(d.dirs).map(([k, v]) => [k, at(v)])) }));
    setMarked(at);
  }, []);
  // What the start page shows cards for: the tree's rows, and the pinned and lately opened files it doesn't list.
  const startList = useMemo(() => {
    if (!list) return null;
    const have = new Set(list.map((n) => n.id));
    const extra = marked.filter((n) => !have.has(n.id));
    return extra.length ? [...list, ...extra] : list;
  }, [list, marked]);
  const listRef = useRef(list);
  listRef.current = list;

  // Sharing: the local server syncs shared folders while Notes is open; the tree reads itself again when something came in.
  // Presence: the open note goes to the others (the page's editor adds the cursor), and who's here is read every second.
  const [together, setTogether] = useState(false);
  const share = useShareStatus(() => void reload().catch(() => {}), together);
  const [sharing, setSharing] = useState<string | null>(null);
  const shareBy = useMemo(() => new Map((list ?? []).map((n) => [n.id, n.share])), [list]);
  const shareChanged = useCallback(() => {
    void reload().catch(() => {});
    share.refresh();
  }, [reload, share.refresh]);

  // ---- panes and their tabs. Desktop only: a phone shows one page at a time, from the address.
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => windowStore.set(LAYOUT_KEY, JSON.stringify(layout)), [layout]);
  const multi = !phone && count(layout.root) > 1;
  const current = phone ? id : (focusedPane(layout)?.active ?? null);
  const openShared = !!current && !!shareBy.get(current);
  const people = usePresencePoll(current, openShared);
  useEffect(() => openPresence(openShared ? current : null), [current, openShared]);
  useEffect(() => setTogether(people.some((p) => p.here)), [people]);
  const shareCtx: ShareCtxValue = useMemo(
    () => ({ available: share.available, status: share.status, shareOf: (nid) => shareBy.get(nid), open: setSharing, people }),
    [shareBy, share.available, share.status, people],
  );

  // Ask Etude hears which pages are open: each pane's tabs, the one in front, and which pane has focus.
  const byId = useMemo(() => new Map((list ?? []).map((n) => [n.id, n])), [list]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  // The folders on disk whose contents the tree needs: the ones unfolded, and the ones above (or shown in) an open tab.
  const diskNeedNow = useMemo(() => {
    const need = new Set<string>();
    for (const o of open) if (isFsId(o)) need.add(o);
    for (const t of phone ? (id ? [id] : []) : panes(layout.root).flatMap((p) => p.tabs)) {
      if (!isFsId(t)) continue;
      for (const a of fsAncestors(t)) need.add(a);
      if (byId.get(t)?.kind === "folder") need.add(t);
    }
    return [...need].sort();
  }, [open, layout, byId, phone, id]);
  diskNeed.current = diskNeedNow;
  const diskNeedKey = diskNeedNow.join("\n");
  useEffect(() => {
    if (isLocal() || !dbList) return;
    const missing = diskNeedNow.filter((d) => !(d in diskRef.current.dirs));
    if (!missing.length) return;
    let live = true;
    api.folderEntries(missing).then(
      (r) => {
        if (!live) return;
        const got = Object.fromEntries(Object.entries(r.dirs).filter((e): e is [string, NoteSummary[]] => !!e[1]));
        diskStamps.current = { ...r.stamps, dirs: { ...(diskStamps.current?.dirs ?? {}), ...r.stamps.dirs } };
        setDiskOk(r.available);
        setDisk((d) => ({ roots: r.roots, dirs: { ...d.dirs, ...got } }));
        // A folder that isn't there any more folds itself away.
        for (const [k, v] of Object.entries(r.dirs)) if (!v && openRef.current.has(k)) setOpen(k, false);
      },
      () => {},
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diskNeedKey, !!dbList]);
  const shownPaneList = phone ? null : panes(layout.root);
  const noteName = (nid: string) => {
    const n = byId.get(nid);
    if (!n) return null;
    // A file on this computer says where it is, so an agent can read the same file.
    if (n.local) return `"${n.local.name}" (a ${n.kind === "folder" ? "folder" : "file"} on this computer at ${diskPath(n, list ?? []) ?? n.local.path}, id ${n.id})`;
    return `"${display(n)}" (${n.kind}, id ${n.id})`;
  };
  useScreenLines(
    "notes",
    !active || !list || !shownPaneList
      ? null
      : shownPaneList.map((p, i) => {
          const webName = (t: string) => `the web page "${webTitle(webTabs.get(t))}" (${webTabs.get(t)?.url || "blank"})`;
          const tabs = p.tabs.filter((t) => !isStartTab(t)).map((t) => (isWebTab(t) ? webName(t) : noteName(t))).filter(Boolean);
          const front = isChatTab(p.active) ? "an Ask chat" : isWebTab(p.active) ? webName(p.active) : p.active && !isStartTab(p.active) ? noteName(p.active) : p.active ? "a New tab (start page)" : "nothing";
          const which = shownPaneList.length > 1 ? `Notebook pane ${i + 1} of ${shownPaneList.length}${layout.focus === p.id ? " (focused)" : ""}` : "Notebook";
          return `${which}: showing ${front}${tabs.length > 1 ? `; tabs open: ${tabs.join(", ")}` : ""}`;
        }),
  );

  // The address opens a page in the focused pane (a plain click in the sidebar, a link, Ctrl+K), or goes to the
  // pane where it's already open. With nothing open, the first page opens.
  const lastId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (phone || !list) return;
    // The Notebook stays mounted behind the other screens: a load on Decks or Settings stays there.
    if (!active) return;
    if (lastId.current === id) return;
    lastId.current = id;
    const l = layoutRef.current;
    // No page in the address (the Notebook opened from another screen): the panes, tabs and front pages are as
    // they were left. The New tab is only for a Notebook with nothing open.
    if (!id && panes(l.root).some((p) => p.tabs.length > 0)) {
      const front = focusedPane(l)?.active ?? null;
      if (front) {
        lastId.current = front;
        navigate(`/notes?id=${encodeURIComponent(front)}`, { replace: true });
      }
      return;
    }
    // Nothing open: a New tab.
    const target = id ?? panes(l.root).flatMap((p) => p.tabs).find(isStartTab) ?? newStartTab();
    setLayout((l) => {
      const owner = panes(l.root).find((p) => p.tabs.includes(target));
      return owner ? activate(l, owner.id, target) : openIn(l, l.focus, target, id ? "replace" : "new");
    });
  }, [id, list, phone, active]);
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
    if (!current || isStartTab(current) || isChatTab(current) || isWebTab(current)) return;
    let live = true;
    api.noteOpened(current).then((n) => live && (patchRow(n.id, { opened: n.opened }), isFsId(n.id) && void reloadMarked().catch(() => {})), () => {});
    return () => void (live = false);
  }, [current]);
  // Pages that were archived or deleted leave their tabs.
  useEffect(() => {
    if (!list) return;
    const ids = new Set(list.map((n) => n.id));
    // A file on disk leaves its tab once its open folder was closed, or its own folder was listed without it. Until
    // a folder is listed, its files' tabs wait.
    const d = diskRef.current;
    const diskGone = (x: string) => {
      if (!diskStamps.current) return false;
      if (!d.roots.some((r) => r.id === x.split("/")[0])) return true;
      const parent = fsParent(x);
      return !!parent && !!d.dirs[parent];
    };
    setLayout((l) => prune(l, (x) => ids.has(x) || isStartTab(x) || (isChatTab(x) && dock.has(chatKey(x))) || (isWebTab(x) && webTabs.has(x)) || (isFsId(x) && !diskGone(x))));
  }, [list]);
  // Chats open here as tabs: one sent over from another screen opens now, and one whose tab closed leaves.
  useEffect(() => {
    if (phone) return;
    const coming = takeWaiting().map(chatTabId);
    if (coming.length) return setLayout((l) => coming.reduce((acc, t) => (panes(acc.root).some((p) => p.tabs.includes(t)) ? acc : openIn(acc, acc.focus, t, "new")), l));
    dock.keep(new Set(panes(layout.root).flatMap((p) => p.tabs).filter(isChatTab).map(chatKey)));
    // A web tab that closed forgets its page (in the desktop app; elsewhere they stay for when it's opened there).
    if (canWebTabs()) webTabs.keep(new Set(panes(layout.root).flatMap((p) => p.tabs).filter(isWebTab)));
  }, [layout, phone]);

  const setOpen = useCallback((oid: string, on: boolean) => {
    setOpenSet((s) => {
      const next = new Set(s);
      if (on) next.add(oid);
      else next.delete(oid);
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Going to a page shows it in the tree: its parents unfold, once. Folding one of them afterwards stays folded
  // while the page is edited (every edit reloads the list) and after a visit to another screen.
  useEffect(() => {
    if (!current || !list || revealedPage === current) return;
    const by = new Map(list.map((n) => [n.id, n]));
    if (!by.has(current)) return;
    revealedPage = current;
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

  /** Tabs showing something that's gone (a file moved to the trash, or anything in a folder that was) close. A pane left with none shows the start page. */
  const closeGone = useCallback((ids: string[]) => {
    const gone = (tid: string) => ids.some((id) => tid === id || tid.startsWith(`${id}/`));
    setLayout((l) => {
      let next = l;
      for (const p of panes(l.root))
        for (const tid of p.tabs) {
          if (!gone(tid)) continue;
          const cur = findPane(next.root, p.id);
          if (!cur?.tabs.includes(tid)) continue;
          next = count(next.root) === 1 && cur.tabs.length <= 1 ? openIn(next, p.id, newStartTab(), "replace") : closeLayoutTab(next, p.id, tid);
        }
      return next;
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

  // A reply that opens a note beside its chat (::open{note side}): in a pane next to that chat's, or next to the
  // focused pane when the chat is in the side panel.
  const openSideRef = useRef(openSide);
  openSideRef.current = openSide;
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<OpenNoteDetail>).detail;
      if (!d?.note) return;
      d.handled = true;
      const chat = dockState().chats.find((c) => c.conv && c.conv === d.conv);
      const beside = chat ? panes(layoutRef.current.root).find((p) => p.tabs.includes(chatTabId(chat.key)))?.id : undefined;
      void reload()
        .catch(() => {})
        .then(() => openSideRef.current(d.note, d.side, beside));
    };
    window.addEventListener(OPEN_NOTE_EVENT, h);
    return () => window.removeEventListener(OPEN_NOTE_EVENT, h);
  }, [reload]);

  // Web links (desktop app): a link clicked in Etude opens as a web tab beside where it was clicked: in the pane next
  // to it, or in a new one on its right when it's alone; from the side panel, in the focused pane. A page's own
  // new-window links open as a tab next to it. The same address already open just comes to the front.
  const openWebRef = useRef<(url: string, from: string | null, opts?: { after?: string; background?: boolean }) => void>(() => {});
  openWebRef.current = (url, from, opts) => {
    const l = layoutRef.current;
    const ps = panes(l.root);
    const there = webTabs.find(url, ps.flatMap((p) => p.tabs));
    // Off the Notebook (a chat in the side panel on another screen), the Notebook comes up showing it.
    const show = (tab: string) => !active && navigate(`/notes?id=${encodeURIComponent(tab)}`);
    if (there) {
      const owner = ps.find((p) => p.tabs.includes(there))!;
      setLayout((x) => focusLayout(activate(x, owner.id, there), owner.id));
      return show(there);
    }
    const id = webTabs.create(url);
    const src = from && findPane(l.root, from) ? from : null;
    const boxes = rects(l.root).panes;
    const me = boxes.find((r) => r.id === src);
    const others = boxes.filter((r) => r.id !== src);
    if (!src || opts?.after) pickIn(src ?? l.focus, id, opts?.background ? "background" : "new");
    else if (others.length && me) {
      // The pane on its right, else the nearest one.
      const d = (r: Rect) => Math.hypot(r.x + r.w / 2 - (me.x + me.w / 2), r.y + r.h / 2 - (me.y + me.h / 2)) - (r.x >= me.x + me.w - 0.01 ? 10 : 0);
      pickIn(others.reduce((a, b) => (d(b) < d(a) ? b : a)).id, id, "new");
    } else if (openSplit(l, src, id, "right")) void flushAll().then(() => setLayout((x) => openSplit(x, src, id, "right") ?? openIn(x, src, id, "new")));
    else pickIn(src, id, "new");
    if (!opts?.background) show(id);
  };
  const webSettings = useWebSettings();
  useEffect(() => {
    const bridge = webBridge();
    if (!bridge || phone) return;
    const on = linksInTabs();
    void bridge.takeLinks(on);
    // Where the last press was: the pane (or the side panel) a link clicked there came from.
    let from: { pane: string | null; panel: boolean; at: number } = { pane: null, panel: false, at: 0 };
    const press = (e: Event) => {
      const t = e.target as Element | null;
      from = { pane: t?.closest?.<HTMLElement>("[data-pane]")?.dataset.pane ?? null, panel: !!t?.closest?.("[data-agent-panel]"), at: Date.now() };
    };
    // Off the Notebook, only a chat's link brings it up (a card's link while studying goes to the browser).
    const here = (panel: boolean) => activeRef.current || panel;
    // A plain click on a web link in Etude (a chat's citation, a link in a page). Shift opens it in the browser.
    const click = (e: MouseEvent) => {
      if (!on || e.defaultPrevented || e.button !== 0 || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[href]");
      if (!a || a.hasAttribute("download") || a.closest("[contenteditable=true]")) return;
      const href = a.href;
      if (!/^https?:\/\//i.test(href) || new URL(href).origin === location.origin) return;
      e.preventDefault();
      if (e.shiftKey || !here(!!a.closest("[data-agent-panel]"))) return void bridge.outside(href);
      openWebRef.current(href, a.closest<HTMLElement>("[data-pane]")?.dataset.pane ?? null);
    };
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("click", click);
    const offOpen = bridge.onOpen(({ url, guest, background }) => {
      if (guest != null) {
        const tab = webTabOfGuest(guest);
        const pane = tab ? panes(layoutRef.current.root).find((p) => p.tabs.includes(tab))?.id ?? null : null;
        return openWebRef.current(url, pane, { after: tab, background });
      }
      const recent = Date.now() - from.at < 4000;
      if (!here(recent && from.panel)) return void bridge.outside(url);
      openWebRef.current(url, recent ? from.pane : null);
    });
    // App shortcuts pressed in a page: Ctrl+L is its address bar; the rest go to the app as if pressed here.
    const offKey = bridge.onKey((k) => {
      const tab = webTabOfGuest(k.guest);
      if (tab && k.key.toLowerCase() === "l" && (k.ctrl || k.meta) && !k.alt) return focusAddress(tab);
      const el = (tab && document.querySelector(`webview[data-web-tab="${CSS.escape(tab)}"]`)) || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k.key, code: k.code, ctrlKey: k.ctrl, metaKey: k.meta, altKey: k.alt, shiftKey: k.shift, bubbles: true, cancelable: true }));
    });
    return () => {
      void bridge.takeLinks(false);
      document.removeEventListener("pointerdown", press, true);
      window.removeEventListener("click", click);
      offOpen();
      offKey();
    };
  }, [phone, webSettings]);

  // `etude view` (the CLI, an agent over MCP): what the Notebook shows, and changing it the way a person can.
  const viewTab = (t: string, p?: PaneNode) => {
    const base = isChatTab(t)
      ? { id: t, kind: "chat", title: dockState().metas[chatKey(t)]?.title || "Ask chat" }
      : isWebTab(t)
        ? { id: t, kind: "web", title: webTitle(webTabs.get(t)), url: webTabs.get(t)?.url ?? "" }
      : isStartTab(t)
        ? { id: t, kind: "new", title: "New tab" }
        : byIdRef.current.get(t)
          ? { id: t, kind: byIdRef.current.get(t)!.kind, title: display(byIdRef.current.get(t)!) }
          : null;
    if (!base || !p) return base;
    const g = groupOf(p, t);
    return { ...base, ...(isPinned(p, t) ? { pinned: true } : {}), ...(p.icons?.[t] ? { icon: p.icons[t] } : {}), ...(g ? { group: g.id } : {}) };
  };
  useEffect(() => {
    if (!list) return;
    const ps = phone ? [] : panes(layout.root);
    const boxes = new Map(rects(layout.root).panes.map((r) => [r.id, r]));
    const r2 = (v: number) => Math.round(v * 1000) / 1000;
    reportView(
      "/notes",
      ps.map((p, i) => {
        const b = boxes.get(p.id);
        return {
          n: i + 1,
          focused: layout.focus === p.id,
          front: p.active ? viewTab(p.active, p) : null,
          tabs: p.tabs.map((t) => viewTab(t, p)).filter(Boolean),
          groups: (p.groups ?? []).map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: !!g.collapsed, tabs: g.tabs })),
          ...(b ? { box: { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) } } : {}),
          ...(p.zoom ? { zoom: p.zoom } : {}),
        };
      }),
    );
  }, [layout, list, phone]); // eslint-disable-line react-hooks/exhaustive-deps
  // What a command does; set further down, once everything it calls exists.
  const viewRun = useRef<(c: ViewCommand) => Promise<void> | void>(() => {});
  useEffect(() => {
    setViewHandler((c) => viewRun.current(c));
    return () => setViewHandler(null);
  }, []);

  // Dragging a tab: to reorder it, to another pane's tabs or middle, or to a pane's edge to split it.
  const [tabDrag, setTabDrag] = useState<TabDragView | null>(null);
  const dragEnded = useRef(0);
  /** A chat's tab goes back to the side panel (which opens for it). */
  const chatToSide = (pane: string, tid: string) => {
    const chat = dockState().chats.find((c) => c.key === chatKey(tid));
    if (!chat) return;
    dock.remove(chat.key);
    closeTabIn(pane, tid);
    chatToPanel(chat);
  };
  /** Follows the pointer with a tab (one of a pane's, or a chat's from the side panel) until it's dropped. */
  const runTabDrag = (pane: string | null, note: string, label: string, e: { clientX: number; clientY: number }, apply: (drop: TabDrop | PanelDrop) => void) => {
    const sx = e.clientX;
    const sy = e.clientY;
    let on = false;
    let hit: Pick<TabDragView, "drop" | "zone" | "line" | "tint" | "into"> = { drop: null, zone: null, line: null };
    const move = (ev: PointerEvent) => {
      if (!on) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        on = true;
        document.body.classList.add("note-tab-dragging");
      }
      hit = hitTabDrop(layoutRef.current, pane, note, ev.clientX, ev.clientY);
      setTabDrag({ pane: pane ?? "", note, label, x: ev.clientX, y: ev.clientY, tint: undefined, into: undefined, ...hit });
    };
    const end = (ok: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("note-tab-dragging");
      setTabDrag(null);
      if (!on) return;
      dragEnded.current = performance.now();
      const drop = hit.drop;
      if (ok && drop) apply(drop);
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
  const startTabDrag = (pane: string, note: string, e: React.PointerEvent<HTMLElement>) => {
    if (phone || e.button !== 0) return;
    const n = listRef.current?.find((x) => x.id === note);
    const label = n ? display(n) : isChatTab(note) ? dockState().metas[chatKey(note)]?.title || "New chat" : "Page";
    runTabDrag(pane, note, label, e, (drop) => {
      if (drop === "panel") return chatToSide(pane, note);
      void flushAll().then(() => setLayout((l) => moveTab(l, pane, note, drop) ?? l));
    });
  };
  /** A group dragged by its label: along the strip, or onto another pane's tabs or page. */
  const startGroupDrag = (pane: string, g: TabGroup, e: React.PointerEvent<HTMLElement>) => {
    if (phone || e.button !== 0) return;
    runTabDrag(pane, GROUP_DRAG + g.id, groupLabel(g), e, (drop) => {
      if (drop === "panel" || "side" in drop) return;
      void flushAll().then(() => setLayout((l) => moveGroup(l, pane, g.id, drop) ?? l));
    });
  };
  // The side panel's chats can come here: dragged onto a pane (its tabs, its middle, or an edge to split), or opened as a page.
  const fromPanel = useRef<{ dragIn(chat: DockedChat, meta: ChatMeta | undefined, e: { clientX: number; clientY: number }, taken: () => void): void; open(chat: DockedChat, meta: ChatMeta | undefined): void }>(null!);
  fromPanel.current = {
    dragIn: (chat, meta, e, taken) =>
      runTabDrag(null, chatTabId(chat.key), meta?.title || "New chat", e, (drop) => {
        if (drop === "panel") return;
        dock.add(chat, meta);
        taken();
        void flushAll().then(() => setLayout((l) => dropPage(l, chatTabId(chat.key), drop) ?? l));
      }),
    open: (chat, meta) => {
      dock.add(chat, meta);
      setLayout((l) => openIn(l, l.focus, chatTabId(chat.key), "new"));
    },
  };
  useEffect(() => {
    if (phone) return;
    registerNotebook({ dragIn: (...a) => fromPanel.current.dragIn(...a), open: (...a) => fromPanel.current.open(...a) });
    return () => registerNotebook(null);
  }, [phone]);

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
    const t = toast.loading("Adding the Notebook tutorial…");
    try {
      const r = await api.notesTutorial(false);
      if (!phone) setNotesPagesOpen(true);
      await reload();
      if (r.root) setOpen(r.root, true);
      if (r.start) navigate(`/notes?id=${encodeURIComponent(r.start)}`);
      toast.success("Added the Notebook tutorial", { id: t, description: "The Notes showcase folder, with its cards in Notes::Notes showcase." });
    } catch (e) {
      toast.error(`Couldn't add the tutorial: ${(e as Error).message}`, { id: t });
    }
  }, [reload, setOpen, phone]);
  const add = useCallback(
    async (parentId: string | null, kind: "page" | "canvas" | "file" | "web" | "kanban" = "page", title = "", unique = false) => {
      try {
        const n = await api.createNote({ title, parentId, kind, ...(unique ? { unique: true } : {}) });
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
  // A file on this computer that was renamed or moved has a new id (its id is where it is): its tab, its pin in the
  // strip and the folders unfolded inside it follow.
  const diskMoved = useCallback((from: string, to: string) => {
    if (from === to) return;
    const map = (x: string) => (x === from ? to : x.startsWith(from + "/") ? to + x.slice(from.length) : x);
    setLayout((l) => renameTab(l, from, to));
    setOpenSet((o) => {
      if (![...o].some((x) => map(x) !== x)) return o;
      const next = new Set([...o].map(map));
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);
  const rename = useMemo<RenameProps>(
    () => ({
      id: renaming,
      done: (rid, t) => {
        setRenaming(null);
        if (t === null) return;
        const title = t.trim();
        const old = listRef.current?.find((x) => x.id === rid);
        if (!old || title === old.title) return;
        // On disk the rename happens first (what's typed in the file is written before it).
        if (isFsId(rid)) {
          void flushAll()
            .then(() => api.updateNote(rid, { title }))
            .then((n) => (diskMoved(rid, n.id), reload()))
            .catch((e) => (toast.error((e as Error).message), void reload().catch(() => {})));
          return;
        }
        patchRow(rid, { title });
        void api.updateNote(rid, { title }).catch((e) => toast.error((e as Error).message));
      },
    }),
    [renaming, patchRow, flushAll, diskMoved, reload],
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

  // Ctrl/⌘+T: a New tab in the pane you're in; Ctrl/⌘+W closes its tab in front. The Ask panel takes them when you're in it.
  const tabKeysRef = useRef<(k: "new" | "close") => void>(() => {});
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const k = tabShortcut(e);
      if (!k || !activeRef.current || inAskPanel()) return;
      e.preventDefault();
      tabKeysRef.current(k);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Ctrl/⌘+Alt+N / C / F: a new page, canvas or file at the top level (never AltGr, which types characters).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const k = startShortcut(e);
      if (!k || e.defaultPrevented || !activeRef.current) return;
      e.preventDefault();
      if (k === "file") setNewFileIn(null);
      else void add(null, k);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [add]);

  const archive = async (n: NoteSummary) => {
    await flushAll();
    // A file on this computer goes to its folder's trash, once you've said yes.
    if (n.local) return void setTrashAsk({ items: [n], open: true });
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
  // Files moved on disk in this session, old id → where they are now, so Undo (which names them as they were) finds them.
  const diskAlias = useRef(new Map<string, string>()).current;
  const place = useCallback(
    async (items: Placement[]) => {
      // Files on this computer move on disk, into another folder there, and take the place they were dropped at
      // (the folder remembers the order; a disk has none).
      if (items.some((it) => isFsId(it.id) || isFsId(it.parentId))) {
        // Between the collection and a folder on this computer, either way: notes become files, files become notes.
        // Nothing is deleted: the notes wait in the Archive, the files in their folder's trash.
        if (!items.every((it) => isFsId(it.id) && isFsId(it.parentId))) {
          const toDisk = items.every((it) => !isFsId(it.id) && isFsId(it.parentId));
          const toNotes = items.every((it) => isFsId(it.id) && !isFsId(it.parentId));
          if (!toDisk && !toNotes) throw new Error("Move files from one place at a time: from the collection, or from a folder on this computer.");
          await flushAll();
          try {
            if (toDisk) {
              const r = await api.takeNotes(items.map((it) => it.id), items[0].parentId!);
              for (const m of r.moved) if (m.file) diskMoved(m.id, m.file);
              return { told: `Moved ${items.length === 1 ? "it" : `${items.length}`} to the folder as ${r.moved.filter((m) => m.file).length === 1 ? "a file" : "files"}. The notes are in the Archive.` };
            }
            const r = await api.bringFiles(items.map((it) => it.id), items[0].parentId, items[0].index);
            for (const m of r.moved) if (m.kind !== "folder") diskMoved(m.file, m.id);
            return { told: `Moved ${items.length === 1 ? "it" : `${items.length}`} to the Notebook. The files are in the folder's trash.` };
          } finally {
            await reload();
          }
        }
        await flushAll();
        try {
          const asked = items.map((it) => ({ id: diskAlias.get(it.id) ?? it.id, parentId: it.parentId!, index: it.index }));
          const todo = asked.filter((a) => fsParent(a.id) !== a.parentId || a.index !== undefined);
          const done = todo.length ? await api.placeFiles(todo) : [];
          for (const d of done) {
            if (d.id === d.from) continue;
            const asId = items[asked.findIndex((a) => a.id === d.from)].id;
            diskMoved(d.from, d.id);
            if (d.id === asId) diskAlias.delete(asId);
            else diskAlias.set(asId, d.id);
            diskAlias.set(d.from, d.id);
          }
        } finally {
          await reload();
        }
        return;
      }
      if (items.length === 1) return void (await api.moveNote(items[0].id, items[0].parentId, items[0].index), await reload());
      try {
        for (const it of items) await api.moveNote(it.id, null);
        const order = [...items].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
        for (const it of order) await api.moveNote(it.id, it.parentId, it.index);
      } finally {
        await reload();
      }
    },
    [reload, flushAll, diskMoved, diskAlias],
  );
  // Files on this computer leaving for their folder's trash: asked first. Then their tabs close (a pane left with
  // none shows the start page), and Undo puts them back.
  // (What was asked stays while the dialog fades out, so its words don't change under it.)
  const [trashAsk, setTrashAsk] = useState<{ items: NoteSummary[]; open: boolean } | null>(null);
  const trashNow = async (items: NoteSummary[]) => {
    await flushAll();
    const where = new Map<string, string>();
    try {
      for (const n of items) {
        const r = await api.setNoteArchived(n.id, true);
        if (r.trashed) where.set(n.id, r.trashed);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
    const gone = items.filter((n) => where.has(n.id));
    sel.clear();
    closeGone(gone.map((n) => n.id));
    await reload();
    if (!gone.length) return;
    if (phone && id && gone.some((n) => id === n.id || id.startsWith(`${n.id}/`))) navigate("/notes", { replace: true });
    toast(gone.length === 1 ? `Moved “${gone[0].local?.name ?? display(gone[0])}” to the trash` : `Moved ${gone.length} to the trash`, {
      description: gone.length === 1 ? where.get(gone[0].id) : undefined,
      action: { label: "Undo", onClick: () => void Promise.all(gone.map((n) => api.restoreFromTrash(n.id, where.get(n.id)!))).then(reload, (e) => (toast.error((e as Error).message), void reload())) },
    });
  };
  // Deleting for good (Archive keeps things): asked first, with how many pages inside go too. No Undo.
  const [deleteAsk, setDeleteAsk] = useState<{ items: NoteSummary[]; inside: number; open: boolean } | null>(null);
  const askDelete = (ids: string[]) => {
    const items = (list ?? []).filter((n) => ids.includes(n.id));
    if (!items.length) return;
    let inside = 0;
    const count = (pid: string) => (tree.get(pid) ?? []).forEach((k) => (inside++, count(k.id)));
    items.forEach((n) => count(n.id));
    setDeleteAsk({ items, inside, open: true });
  };
  const deleteNow = async (items: NoteSummary[]) => {
    await flushAll();
    const gone: string[] = [];
    try {
      for (const n of items) gone.push(...(await api.deleteNote(n.id)).ids);
    } catch (e) {
      toast.error((e as Error).message);
    }
    sel.clear();
    closeGone(gone);
    await reload();
    if (!gone.length) return;
    if (phone && id && gone.includes(id)) navigate("/notes", { replace: true });
    const done = items.filter((n) => gone.includes(n.id));
    toast(done.length === 1 ? `Deleted “${display(done[0])}”${gone.length > 1 ? ` and ${gone.length - 1} page${gone.length > 2 ? "s" : ""} inside` : ""}` : `Deleted ${done.length} pages${gone.length > done.length ? ` and ${gone.length - done.length} inside` : ""}`);
  };
  const archiveMany = async (ids: string[]) => {
    const disk = (list ?? []).filter((n) => ids.includes(n.id) && n.local);
    if (disk.length && disk.length === ids.length) return void setTrashAsk({ items: disk, open: true });
    await flushAll();
    const gone = new Set<string>();
    // Where each file on this computer went in its folder's trash, for Undo.
    const trashed = new Map<string, string>();
    try {
      for (const id of ids) {
        const r = await api.setNoteArchived(id, true);
        r.ids.forEach((x) => gone.add(x));
        if (r.trashed) trashed.set(id, r.trashed);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
    sel.clear();
    await reload();
    if (phone && id && gone.has(id)) navigate("/notes", { replace: true });
    toast(trashed.size ? `Moved ${ids.length} to the trash` : `Archived ${ids.length} ${ids.length === 1 ? "page" : "pages"}${gone.size > ids.length ? ` and ${gone.size - ids.length} inside` : ""}`, {
      action: { label: "Undo", onClick: async () => void (await Promise.all(ids.map((id) => (trashed.has(id) ? api.restoreFromTrash(id, trashed.get(id)!) : isFsId(id) ? null : api.setNoteArchived(id, false)))).catch((e) => toast.error((e as Error).message)), await reload()) },
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
    const ro = (list ?? []).some((n) => picked.has(n.id) && n.share?.readonly);
    const all = [...picked];
    const pages = (list ?? []).filter((n) => picked.has(n.id) && !isFolder(n));
    const anyShown = (list ?? []).some((n) => picked.has(n.id) && n.look?.showIcon);
    // Files on this computer: open them, or move them to the trash.
    if ((list ?? []).some((n) => picked.has(n.id) && n.local))
      return [
        { label: `Open ${pages.length} in tabs`, disabled: !pages.length, onSelect: () => (pages.forEach((p, i) => pick(p.id, i === 0 ? "new" : "background")), sel.clear()) },
        "sep",
        { label: `Move ${ids.length} to the trash`, danger: true, disabled: (list ?? []).some((n) => picked.has(n.id) && (!n.local || n.local.root)), onSelect: () => void archiveMany(ids) },
      ];
    return [
      { label: `Open ${pages.length} in tabs`, disabled: !pages.length, onSelect: () => (pages.forEach((p, i) => pick(p.id, i === 0 ? "new" : "background")), sel.clear()) },
      ...(ro ? [] : [anyShown ? { label: "Hide icons", onSelect: () => void iconMany(all, false) } : { label: "Show icons", onSelect: () => void iconMany(all, true) }]),
      all.every((x) => list?.find((n) => n.id === x)?.pinned)
        ? { label: `Unpin ${all.length}`, onSelect: () => void setPinned(all, false).then(sel.clear) }
        : { label: `Pin ${all.length} to the start page`, onSelect: () => void setPinned(all.filter((x) => !list?.find((n) => n.id === x)?.pinned), true).then(sel.clear) },
      ...(ro
        ? []
        : ([
            "sep",
            { label: "Move to the top level", disabled: ids.every((id) => !list?.find((x) => x.id === id)?.parentId), onSelect: () => void toTopMany(ids).then(sel.clear) },
            "sep",
            { label: `Archive ${ids.length} ${ids.length === 1 ? "page" : "pages"}`, danger: true, onSelect: () => void archiveMany(ids) },
            { label: `Delete ${ids.length} ${ids.length === 1 ? "page" : "pages"}…`, danger: true, onSelect: () => askDelete(ids) },
          ] as MenuEntry[])),
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
      if (ids.some(isFsId)) await reloadMarked().catch(() => {});
    } catch (e) {
      toast.error((e as Error).message);
      await reload();
    }
  };

  const closeFolder = async (n: NoteSummary) => {
    try {
      await flushAll();
      await api.closeFolder(n.local!.folder);
      await reload();
      toast(`Closed “${display(n)}”`, { description: "The folder and its files are still on this computer." });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  // The menu of a file or folder on this computer.
  const diskMenu = (n: NoteSummary): MenuEntry[] => {
    const local = n.local!;
    const path = diskPath(n, list ?? []);
    const dir = local.type === "dir";
    const make: MenuEntry[] = [
      { label: "New page", onSelect: () => void add(n.id) },
      { label: "New canvas", onSelect: () => void add(n.id, "canvas") },
      { label: "New kanban", onSelect: () => void add(n.id, "kanban") },
      { label: "New web file", onSelect: () => void add(n.id, "web") },
      { label: "New Markdown file", onSelect: () => void add(n.id, "file", "Untitled.md", true) },
      { label: "New file…", onSelect: () => setNewFileIn(n.id) },
      { label: "New folder", onSelect: () => void addFolder(n.id) },
    ];
    const copy: MenuEntry = { label: "Copy the path", disabled: !path, onSelect: () => copyPath(path) };
    // A folder Sync carries says so and can stop; one inside a carried folder travels with it; any other can start.
    const sync: MenuEntry[] = !dir || local.root?.missing || local.synced === "inside" ? [] : [local.synced === "root" ? { label: "Stop syncing…", onSelect: () => setSyncAsk({ kind: "off", id: n.id, name: display(n) }) } : { label: "Sync to your other devices…", onSelect: () => setSyncAsk({ kind: "on", id: n.id, name: display(n) }) }];
    // A folder whose files were put in an order by hand can go back to the order of their names.
    const byName: MenuEntry[] = dir && local.arranged ? [{ label: "Sort by name", onSelect: () => void api.sortFolder(n.id).then(reload, (e) => toast.error((e as Error).message)) }] : [];
    if (local.root) {
      const hidden = !!local.root.hidden;
      return [
        ...(local.root.missing ? [] : [...make, "sep" as const]),
        { label: "Rename in the Notebook", onSelect: () => setRenaming(n.id) },
        { label: hidden ? "Hide names that start with a dot" : "Show names that start with a dot", onSelect: () => void api.editFolder(local.folder, { hidden: !hidden }).then(reload, (e) => toast.error((e as Error).message)) },
        copy,
        ...byName,
        ...sync,
        "sep",
        { label: "Close the folder", onSelect: () => void closeFolder(n) },
      ];
    }
    const split: MenuEntry[] = phone
      ? []
      : [
          { label: "Open to the right", disabled: !sideLayout(n.id, "right"), onSelect: () => void openSide(n.id, "right") },
          { label: "Open below", disabled: !sideLayout(n.id, "bottom"), onSelect: () => void openSide(n.id, "bottom") },
        ];
    return [
      ...(dir ? make : [{ label: "Open", onSelect: () => pick(n.id) }, { label: "Open in new tab", onSelect: () => pick(n.id, "new") }, ...split]),
      "sep",
      { label: "Rename", onSelect: () => setRenaming(n.id) },
      ...(dir ? [] : [n.pinned ? { label: "Unpin", onSelect: () => void setPinned([n.id], false) } : { label: "Pin to the start page", onSelect: () => void setPinned([n.id], true) }]),
      copy,
      ...byName,
      ...sync,
      "sep",
      { label: "Move to the trash", danger: true, onSelect: () => void archive(n) },
    ];
  };
  // The same menu on ⋯ and on right-click.
  const menuItems = (n: NoteSummary): MenuEntry[] => {
    if (picked.size > 1 && picked.has(n.id)) return bulkItems();
    if (n.local) return diskMenu(n);
    // Shared with you as view only: open it, see who has it, pin it here; nothing that would change it.
    const shareItem: MenuEntry[] = share.available ? [{ label: "Share…", onSelect: () => setSharing(n.id) }] : [];
    if (n.share?.readonly)
      return [
        ...(isFolder(n) ? [] : [{ label: "Open", onSelect: () => pick(n.id) }, { label: "Open in new tab", onSelect: () => pick(n.id, "new") }]),
        ...shareItem,
        "sep",
        n.pinned ? { label: "Unpin", onSelect: () => void setPinned([n.id], false) } : { label: "Pin to the start page", onSelect: () => void setPinned([n.id], true) },
      ];
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
      ...(shareItem.length ? [...shareItem, "sep" as const] : []),
      { label: "New page inside", onSelect: () => void add(n.id) },
      { label: "New canvas inside", onSelect: () => void add(n.id, "canvas") },
      { label: "New file inside", onSelect: () => setNewFileIn(n.id) },
      { label: "New web file inside", onSelect: () => void add(n.id, "web") },
      { label: "New kanban inside", onSelect: () => void add(n.id, "kanban") },
      { label: "New folder inside", onSelect: () => void addFolder(n.id) },
      { label: "Add a PDF inside…", onSelect: () => pickPdf(n.id) },
      { label: "Rename", onSelect: () => setRenaming(n.id) },
      n.look?.showIcon ? { label: "Hide icon", onSelect: () => void setListIcon(n, false) } : { label: "Show icon", onSelect: () => void setListIcon(n, true) },
      n.pinned ? { label: "Unpin", onSelect: () => void setPinned([n.id], false) } : { label: "Pin to the start page", onSelect: () => void setPinned([n.id], true) },
      n.kind === "canvas" || n.kind === "pdf" || isFile(n) || isWeb(n) || isKanban(n)
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
      { label: "Delete…", danger: true, onSelect: () => askDelete([n.id]) },
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
  // Tab groups: the one whose card is open (a group just made opens its card, to be named).
  const [editingGroup, setEditingGroupNow] = useState<string | null>(null);
  // A card opened from a tab's menu isn't shut by that menu's own closing (focus going back), which can come late on a busy machine.
  const cardOpened = useRef(0);
  const setEditingGroup = (id: string | null) => {
    if (id) cardOpened.current = performance.now();
    setEditingGroupNow(id);
  };
  const groupActs = (pane: string): GroupActions => ({
    editing: editingGroup,
    setEditing: setEditingGroup,
    edit: (gid, patch) => setLayout((l) => editGroup(l, pane, gid, patch)),
    ungroup: (gid) => setLayout((l) => ungroup(l, pane, gid)),
    // Its chats and pages close one by one, so the last tab of all still leaves a New tab behind.
    close: (gid) => (findPane(layoutRef.current.root, pane)?.groups?.find((g) => g.id === gid)?.tabs ?? []).forEach((t) => closeTabIn(pane, t)),
    drag: (g, e) => startGroupDrag(pane, g, e),
    clickable: () => performance.now() - dragEnded.current > 250,
    settled: () => performance.now() - cardOpened.current > 450,
    target: tabDrag?.into ?? null,
    moving: tabDrag?.note.startsWith(GROUP_DRAG) ? tabDrag.note.slice(GROUP_DRAG.length) : null,
  });
  // A pinned tab's icon picker: which tab's is open ("pane\ntab").
  const [iconFor, setIconForNow] = useState<string | null>(null);
  const setIconFor = (v: string | null) => {
    if (v) cardOpened.current = performance.now();
    setIconForNow(v);
  };
  const iconActs = (pane: string): IconActions => ({
    editing: iconFor?.startsWith(pane + "\n") ? iconFor.slice(pane.length + 1) : null,
    setEditing: (t) => setIconFor(t ? `${pane}\n${t}` : null),
    set: (t, icon) => setLayout((l) => setTabIcon(l, pane, t, icon)),
    settled: () => performance.now() - cardOpened.current > 450,
  });
  const tabMenu = (pane: string, tid: string): MenuEntry[] => {
    const p = findPane(layout.root, pane);
    const others = (p?.tabs.length ?? 0) > 1;
    const pinned = isPinned(p, tid);
    const mine = groupOf(p, tid);
    return [
      { label: pinned ? "Unpin" : "Pin", onSelect: () => setLayout((l) => pinTab(l, pane, tid, !pinned)) },
      // After the menu has closed, or its closing would shut the picker.
      ...(pinned ? [{ label: p?.icons?.[tid] ? "Change icon…" : "Set an icon…", onSelect: () => void setTimeout(() => setIconFor(`${pane}\n${tid}`), 180) }] : []),
      {
        label: "Add to new group",
        onSelect: () => {
          const gid = newGroupId();
          setLayout((l) => groupTabs(l, pane, [tid], gid));
          // After the menu has closed, or its closing would shut the card.
          setTimeout(() => setEditingGroup(gid), 180);
        },
      },
      ...(p?.groups ?? []).filter((g) => g.id !== mine?.id).map((g) => ({ label: `Add to ${groupLabel(g)}`, dot: g.color, onSelect: () => setLayout((l) => groupTabs(l, pane, [tid], g.id)) })),
      ...(mine ? [{ label: "Remove from group", onSelect: () => setLayout((l) => ungroupTab(l, pane, tid)) }] : []),
      "sep",
      { label: "Split right", disabled: !sideLayout(tid, "right", pane), onSelect: () => void openSide(tid, "right", pane) },
      { label: "Split down", disabled: !sideLayout(tid, "bottom", pane), onSelect: () => void openSide(tid, "bottom", pane) },
      ...(isChatTab(tid) ? [{ label: "Move to the side panel", onSelect: () => chatToSide(pane, tid) }] : []),
      // A page or file (chats and web pages live in this window).
      ...(canOpenWindows() && !isChatTab(tid) && !isWebTab(tid) && !isStartTab(tid) ? [{ label: "Open in new window", onSelect: () => openNewWindow(`/notes?id=${encodeURIComponent(tid)}`) }] : []),
      ...(isWebTab(tid) && webTabs.get(tid)?.url ? [{ label: "Open in your browser", onSelect: () => void webBridge()?.outside(webTabs.get(tid)!.url) }] : []),
      "sep",
      { label: "Close", disabled: !multi && !others, onSelect: () => closeTabIn(pane, tid) },
      {
        label: "Close other tabs",
        disabled: !others,
        // Pinned tabs stay, like in a browser.
        onSelect: () => setLayout((l) => (findPane(l.root, pane)?.tabs ?? []).filter((t) => t !== tid && !isPinned(findPane(l.root, pane), t)).reduce((acc, t) => closeLayoutTab(acc, pane, t), activate(l, pane, tid))),
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
      else if (a === "new-web") void add(null, "web");
      else if (a === "new-kanban") void add(null, "kanban");
      else if (a === "new-folder") void addFolder(null);
      else if (a === "add-pdf") pickPdf(null);
      else if (a === "import-md") fileInput.current?.click();
      else if (a === "import-vault") folderInput.current?.click();
      else if (a === "open-folder") setFolderDialog(true);
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
  const invites = share.available && share.status?.signedIn ? (
    <ShareInvites
      invites={share.status.invites}
      waiting={share.status.spaces.filter((s) => s.status === "active" && s.waitingKey && !(s.rootId && listRef.current?.some((x) => x.id === s.rootId)))}
      onAccept={async (i) => {
        const r = await shareApi.accept(i.spaceId);
        await reload();
        share.refresh();
        const root = listRef.current?.find((x) => x.id === r.rootId);
        toast.success(`Added “${i.name?.trim() || "the shared folder"}” to your Notebook`);
        if (root && isFolder(root)) setOpen(root.id, true);
        else if (r.rootId) navigate(`/notes?id=${encodeURIComponent(r.rootId)}`);
      }}
      onDecline={async (i) => {
        await shareApi.decline(i.spaceId);
        share.refresh();
      }}
    />
  ) : null;
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
  // From another screen, a page picked in the sidebar opens and brings you to the Notebook.
  const pickFromAway = (pid: string, tab?: TabMode) => {
    pick(pid, tab);
    navigate(`/notes?id=${encodeURIComponent(pid)}`);
  };
  // The chats, in the same sidebar: the chat in front of the focused pane, and opening one the way a page opens.
  const notesView = useNotesView();
  const dockNow = useDock();
  const frontTab = findPane(layout.root, layout.focus)?.active ?? null;
  const frontChat = isChatTab(frontTab) ? chatKey(frontTab) : null;
  const frontConv = frontChat ? (dockNow.chats.find((c) => c.key === frontChat)?.conv ?? null) : null;
  // A chat tab coming to the front shows the chats; a page coming to the front shows the pages. Flipping it by hand
  // in between sticks until the front changes kind.
  const frontKind = frontTab === null ? null : frontChat ? "chats" : "pages";
  useEffect(() => {
    if (active && !phone && frontKind) setNotesView(frontKind);
  }, [frontKind]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A chat in a tab: the tab that has it comes forward, else the chat in front changes to it, else a new tab. */
  const openChat = (conv: string | null, how: "here" | "new" = "here", withProfile?: string) => {
    if (!active) navigate("/notes");
    const l = layoutRef.current;
    if (conv) {
      const key = dockState().chats.find((c) => c.conv === conv)?.key;
      const owner = key && panes(l.root).find((p) => p.tabs.includes(chatTabId(key)));
      if (key && owner) return setLayout((x) => focusLayout(activate(x, owner.id, chatTabId(key)), owner.id));
    }
    const front = findPane(l.root, l.focus)?.active;
    if (how === "here" && isChatTab(front)) {
      requestChat(chatKey(front), withProfile ? { with: withProfile } : { open: conv });
      return;
    }
    const key = Math.random().toString(36).slice(2, 9);
    dock.add({ key, conv });
    if (withProfile) requestChat(key, { with: withProfile });
    setLayout((x) => focusLayout(openIn(x, x.focus, chatTabId(key), "new"), x.focus));
  };
  const sidebarTree =
    inSidebar &&
    createPortal(
      <>
      {notesView === "chats" ? (
        <NotesChats active={frontConv} onOpen={(c) => openChat(c)} onNewWith={(p) => openChat(null, "here", p)} onOpenNew={(c) => openChat(c, "new")} />
      ) : (
      <div role="tree" aria-label="Pages">
        {invites}
        {list === null ? null : top.length === 0 ? (
          <p className="sb-pages-empty">No pages yet. Right-click Notebook to make one.</p>
        ) : (
          top.map((n) => <TreeRow key={n.id} n={n} depth={0} tree={tree} open={open} setOpen={setOpen} current={active ? current : null} onPick={active ? pick : pickFromAway} onAdd={(p) => void add(p)} onMenu={rowMenu} menuItems={menuItems} inSidebar dnd={dnd} rename={rename} sel={sel} />)
        )}
      </div>
      )}
      </>,
      slot!,
    );

  // + in a pane's top bar: a New tab (the start page) next to that pane's page.
  // The + opens a New tab of its own, outside the group the front tab is in, always the rightmost one.
  const newTab = (pane: string) => {
    const t = newStartTab();
    pickIn(pane, t, "new");
    setLayout((l) => tabToEnd(ungroupTab(l, pane, t), pane, t));
  };
  tabKeysRef.current = (k) => {
    const pane = layoutRef.current.focus;
    if (k === "new") return newTab(pane);
    const front = findPane(layoutRef.current.root, pane)?.active;
    if (front) closeTabIn(pane, front);
  };

  // `etude view`: each command does what the same click, drag or menu item does.
  viewRun.current = async (c) => {
    const ps = () => panes(layoutRef.current.root);
    const paneOf = (t: ViewTarget | undefined): string | undefined => {
      if (!t || "panel" in t) return undefined;
      if ("pane" in t) return ps()[t.pane - 1]?.id;
      if ("chat" in t) return (ps().find((p) => isChatTab(p.active)) ?? ps().find((p) => p.tabs.some(isChatTab)))?.id;
      return ps().find((p) => p.tabs.includes(t.note))?.id;
    };
    const must = (t: ViewTarget | undefined, what = "pane") => {
      const p = paneOf(t);
      if (!p) throw new Error(t && "pane" in t ? `there's no pane ${t.pane}` : t && "chat" in t ? "no pane has an Ask chat" : `that ${what} isn't open`);
      return p;
    };
    const tabPane = (tab: string) => must({ note: tab }, "tab");
    // A group by id or name, in any pane.
    const groupAt = (ref: string) => {
      const want = ref.trim().toLowerCase();
      for (const p of ps()) for (const g of p.groups ?? []) if (g.id === ref || g.name.trim().toLowerCase() === want || groupLabel(g).toLowerCase() === want) return { pane: p.id, g };
      throw new Error(`no tab group "${ref}"`);
    };
    const colour = (v: string | undefined): GroupColor | undefined => {
      if (v === undefined) return undefined;
      if (!isGroupColor(v)) throw new Error(`a group colour is one of ${GROUP_COLORS.join(", ")}, or #rrggbb`);
      return v;
    };
    switch (c.action) {
      case "open": {
        const beside = c.beside ? must(c.beside) : undefined;
        // As a tab at a chosen place in the strip: in front of `before`, or at the end (null).
        const at = c.where === "tab" && c.before !== undefined ? beside ?? layoutRef.current.focus : null;
        if (at && c.before && !findPane(layoutRef.current.root, at)?.tabs.includes(c.before)) throw new Error("the tab to open it in front of isn't in that pane");
        const place = (id: string) =>
          at &&
          setLayout((l) => (findPane(l.root, at)?.tabs.includes(id) && id !== c.before ? (moveTab(l, at, id, { pane: at, before: c.before ?? null }) ?? l) : l));
        if (!c.note) {
          const pane = beside ?? layoutRef.current.focus;
          if (at) {
            const t = newStartTab();
            pickIn(pane, t, "new");
            setLayout((l) => ungroupTab(l, pane, t));
            return void place(t);
          }
          if (c.where === "tab" || c.where === "replace") return newTab(pane);
          const t = newStartTab();
          if (!sideLayout(t, c.where, pane)) throw new Error(count(layoutRef.current.root) >= MAX_PANES ? "up to four panes side by side" : "it can't split there");
          return void setLayout(() => sideLayout(t, c.where as Side, pane)!);
        }
        if (!isChatTab(c.note) && !isStartTab(c.note) && !isWebTab(c.note) && !byIdRef.current.has(c.note)) await reload().catch(() => {});
        if (c.where === "tab" || c.where === "replace") {
          const pane = beside ?? layoutRef.current.focus;
          pickIn(pane, c.note, c.where === "tab" ? "new" : "replace");
          return void place(c.note);
        }
        if (!sideLayout(c.note, c.where, beside)) throw new Error(count(layoutRef.current.root) >= MAX_PANES ? "up to four panes side by side" : "it's already open there on its own");
        return openSide(c.note, c.where, beside);
      }
      case "close": {
        const pane = must(c.target, "tab");
        if ("note" in c.target) return closeTabIn(pane, c.target.note);
        for (const t of [...(findPane(layoutRef.current.root, pane)?.tabs ?? [])]) closeTabIn(pane, t);
        return;
      }
      case "close-others": {
        const pane = tabPane(c.tab);
        return void setLayout((l) => (findPane(l.root, pane)?.tabs ?? []).filter((t) => t !== c.tab && !isPinned(findPane(l.root, pane), t)).reduce((acc, t) => closeLayoutTab(acc, pane, t), activate(l, pane, c.tab)));
      }
      case "focus": {
        const pane = must(c.target, "tab");
        return void setLayout((l) => ("note" in c.target ? activate(l, pane, c.target.note) : focusLayout(l, pane)));
      }
      case "pin": {
        const pane = tabPane(c.tab);
        return void setLayout((l) => pinTab(l, pane, c.tab, c.on));
      }
      case "icon": {
        const pane = tabPane(c.tab);
        if (!isPinned(findPane(layoutRef.current.root, pane), c.tab)) throw new Error("only a pinned tab has an icon of its own: pin it first");
        return void setLayout((l) => setTabIcon(l, pane, c.tab, c.icon));
      }
      case "move": {
        const from = tabPane(c.tab);
        if ("panel" in c.to) {
          if (!isChatTab(c.tab)) throw new Error("only an Ask chat goes to the side panel");
          return chatToSide(from, c.tab);
        }
        const to = must(c.to);
        const drop: TabDrop = c.side ? { pane: to, side: c.side } : { pane: to, before: c.before ?? null };
        await flushAll();
        const next = moveTab(layoutRef.current, from, c.tab, drop);
        if (!next) throw new Error(c.side ? (count(layoutRef.current.root) >= MAX_PANES ? "up to four panes side by side" : "it can't split there") : "it can't go there");
        return void setLayout(() => next);
      }
      case "group": {
        if (!c.tabs.length) throw new Error("give the tabs to group");
        const pane = tabPane(c.tabs[0]);
        const p = findPane(layoutRef.current.root, pane);
        const away = c.tabs.filter((t) => !p?.tabs.includes(t));
        if (away.length) throw new Error(`a group lives in one pane; move ${away.join(", ")} there first`);
        if (c.group) {
          const at = groupAt(c.group);
          if (at.pane !== pane) throw new Error("that group is in another pane; move the tabs there first");
          return void setLayout((l) => groupTabs(l, pane, c.tabs, at.g.id));
        }
        const gid = newGroupId();
        return void setLayout((l) => groupTabs(l, pane, c.tabs, gid, { name: c.name, color: colour(c.color) }));
      }
      case "group-edit": {
        const at = groupAt(c.group);
        const patch = { ...(c.name !== undefined ? { name: c.name } : {}), ...(c.color !== undefined ? { color: colour(c.color)! } : {}), ...(c.collapsed !== undefined ? { collapsed: c.collapsed } : {}) };
        return void setLayout((l) => editGroup(l, at.pane, at.g.id, patch));
      }
      case "ungroup": {
        if (c.tab) {
          const pane = tabPane(c.tab);
          if (!groupOf(findPane(layoutRef.current.root, pane), c.tab)) throw new Error("that tab isn't in a group");
          return void setLayout((l) => ungroupTab(l, pane, c.tab!));
        }
        const at = groupAt(c.group ?? "");
        return void setLayout((l) => ungroup(l, at.pane, at.g.id));
      }
      case "group-close": {
        const at = groupAt(c.group);
        for (const t of at.g.tabs) closeTabIn(at.pane, t);
        return;
      }
      case "group-move": {
        const at = groupAt(c.group);
        const to = must(c.to);
        await flushAll();
        const next = moveGroup(layoutRef.current, at.pane, at.g.id, { pane: to, before: c.before ?? null });
        if (!next) throw new Error("the group can't go there");
        return void setLayout(() => next);
      }
      case "resize": {
        const pane = must(c.target);
        // The split right above the pane, by its path from the root; the pane's side of it gets the share.
        const walk = (n: LayoutNode, path: string): { path: string; first: boolean } | null => {
          if (n.k === "pane") return null;
          if (n.a.k === "pane" && n.a.id === pane) return { path, first: true };
          if (n.b.k === "pane" && n.b.id === pane) return { path, first: false };
          return walk(n.a, path + "a") ?? walk(n.b, path + "b");
        };
        const at = walk(layoutRef.current.root, "");
        if (!at) throw new Error("that pane is alone: there's nothing to resize it against");
        const size = Math.min(0.95, Math.max(0.05, c.size));
        return void setLayout((l) => ({ ...l, root: setRatio(l.root, at.path, at.first ? size : 1 - size) }));
      }
      case "zoom": {
        const pane = must(c.target);
        const z = c.zoom;
        return void setLayout((l) => setPaneZoom(l, pane, typeof z === "number" ? z : nextZoom(paneZoom(findPane(l.root, pane)), z === "in" ? 1 : z === "out" ? -1 : 0)));
      }
      default:
        throw new Error(`the Notebook doesn't know ${c.action}`);
    }
  };
  // Zoom just the focused pane (Ctrl/⌘ + − 0), apart from the rest of the window. The desktop app's View menu asks
  // through globalThis.etudePaneZoom and zooms the whole window when it answers false (another screen, a phone).
  const zoomPane = useCallback((pane: string, by: ZoomBy) => setLayout((l) => (findPane(l.root, pane) ? setPaneZoom(l, pane, nextZoom(paneZoom(findPane(l.root, pane)), by)) : l)), []);
  const zoomFocused = useRef<(by: ZoomBy, from: "key" | "menu") => boolean>(() => false);
  zoomFocused.current = (by, from) => {
    if (phone) return false;
    const p = findPane(layoutRef.current.root, layoutRef.current.focus);
    if (!p) return false;
    const kind = p.active ? byIdRef.current.get(p.active)?.kind : undefined;
    const own = ownZoom(p.id);
    if (own) return own(by), true;
    if (kind === "canvas") {
      // The whiteboard zooms itself on these keys; from the menu, they're pressed for it.
      if (from === "menu") {
        const mac = /Mac|iPhone|iPad/.test(navigator.platform);
        const code = by === 1 ? "Equal" : by === -1 ? "Minus" : "Digit0";
        const key = by === 1 ? "=" : by === -1 ? "-" : "0";
        document.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }));
      }
      return true;
    }
    zoomPane(p.id, by);
    return true;
  };
  useEffect(() => {
    let keyAt = 0;
    let menuAt = 0;
    const key = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      const by = zoomKey(e);
      if (by === null || e.defaultPrevented) return;
      if (performance.now() - menuAt < 400) return void e.preventDefault(); // the menu just did it
      // In the Ask side panel the keys are the window's.
      if ((e.target as HTMLElement | null)?.closest?.("[data-agent-panel]")) return;
      const p = findPane(layoutRef.current.root, layoutRef.current.focus);
      const canvas = !!p?.active && byIdRef.current.get(p.active)?.kind === "canvas";
      keyAt = performance.now();
      if (canvas) return; // the whiteboard takes them itself
      if (zoomFocused.current(by, "key")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    // A pinch on a trackpad (Ctrl + scroll to the page) zooms the pane under the fingers, smoothly: the size changes
    // on the pane at once and goes into the layout when the fingers rest. A whiteboard pinches itself.
    let pinch: { pane: string; el: HTMLElement; start: number; scale: number; own: boolean; timer: number; x: number; y: number } | null = null;
    const settle = () => {
      if (!pinch) return;
      const { pane, start, scale, own, x, y } = pinch;
      pinch = null;
      if (own) ownZoom(pane)?.({ scale, end: true, x, y });
      else setLayout((l) => setPaneZoom(l, pane, start * scale));
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.metaKey || phone) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("section[data-pane]");
      if (!el) return;
      const pane = el.dataset.pane!;
      const p = findPane(layoutRef.current.root, pane);
      if (!p || (p.active && byIdRef.current.get(p.active)?.kind === "canvas")) return;
      e.preventDefault();
      if (pinch && pinch.pane !== pane) settle();
      if (!pinch) {
        if (layoutRef.current.focus !== pane) focusPane(pane);
        pinch = { pane, el, start: paneZoom(p), scale: 1, own: !!ownZoom(pane), timer: 0, x: e.clientX, y: e.clientY };
      }
      const g = pinch;
      g.x = e.clientX;
      g.y = e.clientY;
      g.scale = Math.min(3 / g.start, Math.max(0.5 / g.start, g.scale * wheelFactor(e.deltaY, e.deltaMode)));
      if (g.own) ownZoom(pane)?.({ scale: g.scale, end: false, x: g.x, y: g.y });
      else if (!(p.active && isWebTab(p.active))) {
        // The size changes around the pointer: what's under it stays under it, as in a browser.
        const a = anchorAt(g.x, g.y);
        const z = g.start * g.scale;
        if (Math.abs(z - 1) < 0.005) g.el.removeAttribute("data-zoom");
        else g.el.setAttribute("data-zoom", "");
        g.el.style.setProperty("--pane-zoom", String(z));
        keepAnchor(a);
      }
      clearTimeout(g.timer);
      g.timer = window.setTimeout(settle, 160);
    };
    window.addEventListener("wheel", wheel, { passive: false, capture: true });
    // The menu's Zoom In/Out/Actual Size; a key press this page already took counts as done.
    const g = globalThis as { etudePaneZoom?: (by: ZoomBy) => boolean };
    g.etudePaneZoom = (by) => {
      if (document.activeElement?.closest?.("[data-agent-panel]")) return false;
      if (performance.now() - keyAt < 400) return !phone;
      const done = zoomFocused.current(by, "menu");
      if (done) menuAt = performance.now();
      return done;
    };
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", wheel, { capture: true });
      if (pinch) clearTimeout(pinch.timer), settle();
      delete g.etudePaneZoom;
    };
  }, [phone]);

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
    startList,
    tree,
    listRef,
    primed,
    bumps,
    flushers,
    patchRow,
    renameNote: (rid, title) => rename.done(rid, title),
    pick: pickIn,
    focus: focusPane,
    zoom: zoomPane,
    missing: (pane, nid) => (phone ? navigate("/notes", { replace: true }) : setLayout((l) => (count(l.root) === 1 && (findPane(l.root, pane)?.tabs.length ?? 0) <= 1 ? { ...l, root: { ...(l.root as PaneNode), tabs: [], active: null } } : closeLayoutTab(l, pane, nid)))),
    add,
    addFolder,
    setKind,
    setOpen,
    reload,
    importVault: () => folderInput.current?.click(),
    openFolder: diskOk ? () => setFolderDialog(true) : undefined,
    addTutorial: () => void addTutorial(),
    importMd: () => fileInput.current?.click(),
    pickPdf,
    newFile: () => setNewFileIn(null),
    setPinned,
    createFromStart,
  };

  const shownPanes = phone ? [{ k: "pane" as const, id: "phone", tabs: id ? [id] : [], active: id }] : panes(layout.root);
  const geo = multi ? rects(layout.root) : null;
  const existing = (t: string) => isStartTab(t) || isChatTab(t) || (isWebTab(t) && webTabs.has(t)) || !!list?.some((n) => n.id === t);
  const sharingNote = sharing ? list?.find((n) => n.id === sharing) : undefined;
  return (
    <ShareCtx.Provider value={shareCtx}>
    <div className="notes-shell">
      {pickers}
      {canWebTabs() && !phone && <WebLayer open={panes(layout.root).flatMap((p) => p.tabs).filter(isWebTab)} />}
      <ShareDialog noteId={sharing} noteTitle={sharingNote ? display(sharingNote) : ""} status={share.status} onClose={() => setSharing(null)} onChanged={shareChanged} />
      <OpenFolderDialog
        open={folderDialog}
        onClose={() => setFolderDialog(false)}
        onOpened={(fid, name, synced) => {
          setFolderDialog(false);
          if (!phone) setNotesPagesOpen(true);
          setOpen(`fs:${fid}`, true);
          void reload().catch(() => {});
          toast.success(`Opened “${name}”`, { description: synced ? "Its files are on their way from your other devices." : "Its files stay where they are on this computer." });
        }}
      />
      <AlertDialog open={!!deleteAsk?.open} onOpenChange={(o) => !o && setDeleteAsk((d) => d && { ...d, open: false })}>
        <AlertDialogContent data-delete-ask>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteAsk?.items.length === 1 ? `Delete “${display(deleteAsk.items[0])}”?` : `Delete ${deleteAsk?.items.length ?? 0} pages?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteAsk?.inside ? `${deleteAsk.inside === 1 ? "The page" : `The ${deleteAsk.inside} pages`} inside ${deleteAsk.items.length === 1 ? "it" : "them"} go${deleteAsk.inside === 1 ? "es" : ""} too. ` : ""}
              {deleteAsk?.items.some((n) => n.share) ? "Everyone it's shared with loses it as well. " : ""}
              This can't be undone. To put {deleteAsk?.items.length === 1 && !deleteAsk.inside ? "it" : "them"} away and keep {deleteAsk?.items.length === 1 && !deleteAsk.inside ? "it" : "them"}, use Archive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const items = deleteAsk?.items;
                setDeleteAsk((d) => d && { ...d, open: false });
                if (items) void deleteNow(items);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!trashAsk?.open} onOpenChange={(o) => !o && setTrashAsk((t) => t && { ...t, open: false })}>
        <AlertDialogContent data-trash-ask>
          <AlertDialogHeader>
            <AlertDialogTitle>{trashAsk?.items.length === 1 ? `Move “${trashAsk.items[0].local?.name ?? display(trashAsk.items[0])}” to the trash?` : `Move ${trashAsk?.items.length ?? 0} to the trash?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {trashAsk?.items.some((n) => n.local?.type === "dir") ? "A folder goes with everything in it. " : ""}
              {trashAsk?.items.length === 1 ? "It moves" : "They move"} to the folder's trash on this computer, and can be put back from there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const items = trashAsk?.items;
                setTrashAsk((t) => t && { ...t, open: false });
                if (items) void trashNow(items);
              }}
            >
              Move to the trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <FolderSyncDialog
        ask={syncAsk}
        onClose={() => setSyncAsk(null)}
        onDone={(what) => {
          const name = syncAsk?.name ?? "";
          setSyncAsk(null);
          void reload().catch(() => {});
          if (what === "on") toast.success(`Syncing “${name}”`, { description: "Its files are on their way to your other devices." });
          else toast(what === "ended" ? `“${name}” left Sync` : `Stopped syncing “${name}” here`, { description: "Its files are still on this computer." });
        }}
      />
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
              Notebook
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
                  <DropdownMenuItem onSelect={() => void addTutorial()}>Notebook tutorial</DropdownMenuItem>
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
            {invites}
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
            <button type="button" onClick={() => void add(null, "web")} className="note-row note-new">
              <Code2 className="size-3.5" /> New web file
            </button>
            <button type="button" onClick={() => void add(null, "kanban")} className="note-row note-new">
              <SquareKanban className="size-3.5" /> New kanban
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
                node={p}
                groupAct={groupActs(p.id)}
                iconAct={iconActs(p.id)}
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
                <NotePane pane={p.id} noteId={p.active} ctx={ctx} focused={multi && layout.focus === p.id} zoom={paneZoom(p)} strip={strip} plus={plus} />
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
            {tabDrag.line && <div className="note-drop-tabline" style={{ left: tabDrag.line.x, top: tabDrag.line.y, height: tabDrag.line.h, ...(tabDrag.tint ? { background: tabDrag.tint } : {}) }} />}
            <div className="note-tab-ghost" style={{ transform: `translate(${Math.min(tabDrag.x + 14, window.innerWidth - 214)}px, ${Math.min(tabDrag.y + 12, window.innerHeight - 40)}px)` }}>{tabDrag.label}</div>
          </>,
          document.body,
        )}
    </div>
    </ShareCtx.Provider>
  );
}
