import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, Download, Folder, FolderInput, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeEditor, Kind } from "@/components/type-editor/editor";
import { ImportTypesDialog, NewTypeDialog } from "@/components/type-editor/dialogs";
import { download, exportShape, GRADER_LABEL } from "@/components/type-editor/starter";
import { api, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

export function TypesPage({ id }: { id: string | null }) {
  if (id) return <TypeEditor key={id} id={id} />;
  return <TypeList />;
}

const COLLAPSED_KEY = "etude.typeFolders.collapsed";
const DRAG_TYPE = "application/x-etude-type";
const DRAG_FOLDER = "application/x-etude-folder";

const leaf = (path: string) => path.split("::").pop()!;
const parentOf = (path: string) => path.split("::").slice(0, -1).join("::");
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + "::");
const byName = (a: TypeSummary, b: TypeSummary) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

function ancestors(path: string): string[] {
  const parts = path.split("::");
  return parts.map((_, i) => parts.slice(0, i + 1).join("::"));
}

type MoveTarget = { kind: "type"; id: string; name: string; folder: string } | { kind: "folder"; path: string };
type FolderDialog = { mode: "create"; parent: string } | { mode: "rename"; path: string };

function TypeList() {
  const [types, setTypes] = useState<TypeSummary[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [creating, setCreating] = useState<{ source?: string; folder?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]")));
  const [moving, setMoving] = useState<MoveTarget | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);

  const reload = () =>
    Promise.all([api.types(), api.typeFolders()])
      .then(([t, f]) => {
        setTypes(t);
        setFolders(f);
      })
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    reload();
  }, []);

  const saveCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    saveCollapsed(next);
  };
  /** Opens a folder and everything above it, so whatever just moved there is visible. */
  const reveal = (path: string) => {
    if (!path) return;
    const next = new Set(collapsed);
    for (const p of ancestors(path)) next.delete(p);
    saveCollapsed(next);
  };

  const exportType = async (t: TypeSummary) => {
    try {
      download(`${t.id}.type.json`, exportShape(await api.type(t.id)));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const moveType = async (id: string, folder: string) => {
    try {
      await api.moveType(id, folder);
      reveal(folder);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const moveFolder = async (path: string, parent: string) => {
    const to = parent ? `${parent}::${leaf(path)}` : leaf(path);
    if (to === path) return;
    if (within(parent, path)) return void toast.error("A folder can't move inside itself");
    if (folders.includes(to)) return void toast.error(`There's already a folder called “${leaf(path)}” there`);
    try {
      await api.renameTypeFolder(path, to);
      reveal(parent);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const q = query.trim().toLowerCase();
  const matches = (t: TypeSummary) => !q || t.name.toLowerCase().includes(q) || t.id.includes(q) || t.description.toLowerCase().includes(q);

  // Custom types, plus any built-in someone filed in a folder.
  const all = types ?? [];
  const filed = all.filter((t) => !t.shipped || t.folder);
  const builtins = all.filter((t) => t.shipped && !t.folder && matches(t)).sort(byName);
  const shown = filed.filter(matches);
  const sig = shown.map((t) => t.id + "@" + t.folder).join();

  const rows = useMemo(() => buildRows(folders, shown, q ? new Set() : collapsed, !!q), [folders, sig, collapsed, q]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of filed) if (t.folder) for (const p of ancestors(t.folder)) m.set(p, (m.get(p) ?? 0) + 1);
    return m;
  }, [filed.map((t) => t.id + "@" + t.folder).join()]);

  // ------------------------------------------------------------ drag and drop
  const dragProps = (data: { type?: string; folder?: string }): DragProps => ({
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      if (data.type) e.dataTransfer.setData(DRAG_TYPE, data.type);
      if (data.folder) e.dataTransfer.setData(DRAG_FOLDER, data.folder);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => setDropAt(null),
  });
  const dropProps = (folder: string): DropProps => ({
    onDragOver: (e) => {
      if (![...e.dataTransfer.types].some((t) => t === DRAG_TYPE || t === DRAG_FOLDER)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (dropAt !== folder) setDropAt(folder);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt((d) => (d === folder ? null : d));
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDropAt(null);
      const type = e.dataTransfer.getData(DRAG_TYPE);
      const path = e.dataTransfer.getData(DRAG_FOLDER);
      if (type) {
        const t = all.find((x) => x.id === type);
        if (t && t.folder !== folder) moveType(type, folder);
      } else if (path) moveFolder(path, folder);
    },
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Card types</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            A type is fields, an HTML/CSS/JS template and a grader. The built-in ones are written the same way, so any of them can be copied or changed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setImporting(true)}><Upload className="size-4" />Import</Button>
          <Button size="sm" className="h-9 gap-1.5" onClick={() => setCreating({})}><Plus className="size-4" />New type</Button>
        </div>
      </div>

      {!types && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}
        </div>
      )}

      {types && (
        <div className="flex flex-col gap-8">
          {all.length > 8 && (
            <div className="relative -mb-3">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a type" aria-label="Find a type" className="h-10 pr-10 pl-9" />
              {query && (
                <button className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" onClick={() => setQuery("")} aria-label="Clear search">
                  <X className="size-4" />
                </button>
              )}
            </div>
          )}

          <section>
            <div className="mb-2 flex min-h-8 items-center justify-between gap-2 px-1" {...dropProps("")}>
              <h2 className={cn("flex items-baseline gap-2 text-sm font-medium text-muted-foreground transition-colors", dropAt === "" && "text-highlight")}>
                Custom<span className="tabular text-xs">{filed.length}</span>
              </h2>
              <Button variant="ghost" size="sm" className="-mr-2 h-8 gap-1.5 text-muted-foreground" onClick={() => setFolderDialog({ mode: "create", parent: "" })}>
                <FolderPlus className="size-4" />New folder
              </Button>
            </div>
            <div className={cn("overflow-hidden rounded-xl border bg-card/40 transition-colors", dropAt === "" && "border-highlight/60")} {...dropProps("")}>
              {rows.length ? (
                rows.map((r, i) =>
                  r.kind === "loose" ? (
                    <div key="loose" className="border-b border-t-foreground/15 bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground [&:not(:first-child)]:border-t" {...dropProps("")}>
                      Not in a folder
                    </div>
                  ) : r.kind === "folder" ? (
                    <FolderRow
                      key={`f:${r.path}`}
                      path={r.path}
                      depth={r.depth}
                      count={counts.get(r.path) ?? 0}
                      open={q ? true : !collapsed.has(r.path)}
                      dropping={dropAt === r.path}
                      groupStart={i > 0 && r.depth === 0}
                      onToggle={() => toggle(r.path)}
                      onNewType={() => setCreating({ folder: r.path })}
                      onNewFolder={() => setFolderDialog({ mode: "create", parent: r.path })}
                      onRename={() => setFolderDialog({ mode: "rename", path: r.path })}
                      onMove={() => setMoving({ kind: "folder", path: r.path })}
                      onDelete={() => setDeleting(r.path)}
                      drag={dragProps({ folder: r.path })}
                      drop={dropProps(r.path)}
                    />
                  ) : (
                    <Row
                      key={r.t.id}
                      t={r.t}
                      depth={r.depth}
                      onExport={exportType}
                      onDuplicate={() => setCreating({ source: r.t.id, folder: r.t.folder || undefined })}
                      onMove={() => setMoving({ kind: "type", id: r.t.id, name: r.t.name, folder: r.t.folder })}
                      drag={dragProps({ type: r.t.id })}
                      drop={dropProps(r.t.folder)}
                    />
                  ),
                )
              ) : q ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">No custom type matches “{query.trim()}”.</p>
              ) : (
                <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                  <p className="max-w-sm text-sm text-muted-foreground">No custom types yet. Start from a blank template, or copy a built-in one and make it yours.</p>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setCreating({})}><Plus className="size-4" />New type</Button>
                </div>
              )}
            </div>
            {rows.length > 3 && folders.length === 0 && !q && (
              <p className="mt-2 px-1 text-xs text-pretty text-muted-foreground">
                Group types with <span className="text-foreground/80">New folder</span>, then drag types onto a folder or use <span className="text-foreground/80">Move to folder</span> in a type's menu.
              </p>
            )}
          </section>

          {(builtins.length > 0 || !q) && (
            <section>
              <h2 className="mb-2 flex items-baseline gap-2 px-1 text-sm font-medium text-muted-foreground">
                Built in<span className="tabular text-xs">{builtins.length}</span>
              </h2>
              <div className="overflow-hidden rounded-xl border bg-card/40">
                {builtins.map((t) => (
                  <Row
                    key={t.id}
                    t={t}
                    depth={0}
                    onExport={exportType}
                    onDuplicate={() => setCreating({ source: t.id })}
                    onMove={() => setMoving({ kind: "type", id: t.id, name: t.name, folder: "" })}
                    drag={dragProps({ type: t.id })}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <NewTypeDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} types={all} initialSource={creating?.source} folder={creating?.folder} />
      <ImportTypesDialog open={importing} onOpenChange={setImporting} types={all} onDone={reload} />
      <MoveDialog target={moving} folders={folders} onOpenChange={(o) => !o && setMoving(null)} onMoveType={moveType} onMoveFolder={moveFolder} />
      <FolderNameDialog
        state={folderDialog}
        folders={folders}
        onOpenChange={(o) => !o && setFolderDialog(null)}
        onDone={async (path) => {
          reveal(parentOf(path));
          await reload();
        }}
      />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the folder “{deleting && leaf(deleting)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && (counts.get(deleting) ?? 0) > 0
                ? `No type is deleted: the ${counts.get(deleting)} type${counts.get(deleting) === 1 ? "" : "s"} inside move to ${parentOf(deleting) ? `“${leaf(parentOf(deleting))}”` : "the top level"}. Folders inside it go too.`
                : "It's empty, so nothing else changes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await api.deleteTypeFolder(deleting!);
                  await reload();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type TreeRow = { kind: "folder"; path: string; depth: number } | { kind: "type"; t: TypeSummary; depth: number } | { kind: "loose" };

/** Folders first, then the types directly inside, depth-first, like a file browser. */
function buildRows(folders: string[], types: TypeSummary[], collapsed: Set<string>, searching: boolean): TreeRow[] {
  const all = new Set(folders);
  for (const t of types) if (t.folder) for (const p of ancestors(t.folder)) all.add(p);
  // While searching, only folders that lead to a match are worth showing.
  const keep = searching ? new Set(types.flatMap((t) => (t.folder ? ancestors(t.folder) : []))) : all;
  const children = (parent: string) =>
    [...all].filter((p) => parentOf(p) === parent && keep.has(p)).sort((a, b) => leaf(a).localeCompare(leaf(b), undefined, { sensitivity: "base" }));
  const out: TreeRow[] = [];
  const walk = (parent: string, depth: number) => {
    for (const f of children(parent)) {
      out.push({ kind: "folder", path: f, depth });
      if (!collapsed.has(f)) walk(f, depth + 1);
    }
    const here = types.filter((x) => x.folder === parent).sort(byName);
    // Top-level types after the folders get a label, so they don't read as the last folder's contents.
    if (!parent && here.length && out.length) out.push({ kind: "loose" });
    for (const t of here) out.push({ kind: "type", t, depth });
  };
  walk("", 0);
  return out;
}

type DragProps = { draggable: boolean; onDragStart(e: React.DragEvent): void; onDragEnd(): void };
type DropProps = { onDragOver(e: React.DragEvent): void; onDragLeave(e: React.DragEvent): void; onDrop(e: React.DragEvent): void };

/** One step of indentation per level, the same width as a folder's chevron. */
function Indent({ depth }: { depth: number }) {
  return <>{Array.from({ length: depth }, (_, i) => <span key={i} aria-hidden className="w-4 shrink-0 sm:w-7" />)}</>;
}

function FolderRow(p: {
  path: string;
  depth: number;
  count: number;
  open: boolean;
  dropping: boolean;
  /** A top-level folder after another group: a stronger rule above it. */
  groupStart?: boolean;
  onToggle(): void;
  onNewType(): void;
  onNewFolder(): void;
  onRename(): void;
  onMove(): void;
  onDelete(): void;
  drag: DragProps;
  drop: DropProps;
}) {
  const name = leaf(p.path);
  const Icon = p.open ? FolderOpen : Folder;
  return (
    <div
      data-folder={p.path}
      className={cn("group flex min-h-12 items-stretch border-b pl-2 transition-colors last:border-b-0 hover:bg-accent/40",
        p.groupStart && "border-t border-t-foreground/15 -mt-px", p.dropping && "bg-highlight/10 shadow-[inset_0_0_0_1px_var(--highlight)]")}
      {...p.drag}
      {...p.drop}
    >
      <Indent depth={p.depth} />
      <button className="flex min-w-0 flex-1 items-center gap-1.5 py-2 pr-2 text-left" onClick={p.onToggle} aria-expanded={p.open} aria-label={`${p.open ? "Collapse" : "Expand"} ${name}`}>
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground sm:size-7">
          <ChevronRight className={cn("size-4 transition-transform", p.open && "rotate-90")} />
        </span>
        <Icon className={cn("size-4 shrink-0", p.dropping ? "text-highlight" : "text-muted-foreground")} />
        <span className="ml-1 truncate text-[0.95rem] font-semibold">{name}</span>
        <span className="tabular shrink-0 text-xs text-muted-foreground">{p.count}</span>
      </button>
      <div className="flex shrink-0 items-center pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10" aria-label={`Actions for folder ${name}`}><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={p.onNewType}><Plus />New type here…</DropdownMenuItem>
            <DropdownMenuItem onClick={p.onNewFolder}><FolderPlus />New folder inside…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={p.onRename}><Pencil />Rename…</DropdownMenuItem>
            <DropdownMenuItem onClick={p.onMove}><FolderInput />Move to…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={p.onDelete}><Trash2 />Delete folder…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function Row({ t, depth, onExport, onDuplicate, onMove, drag, drop }: {
  t: TypeSummary;
  depth: number;
  onExport(t: TypeSummary): void;
  onDuplicate(): void;
  onMove(): void;
  drag?: DragProps;
  drop?: DropProps;
}) {
  return (
    <div data-type={t.id} className="group flex items-stretch border-b last:border-b-0 hover:bg-accent/40" {...drag} {...drop}>
      {/* Inside a folder the name lines up with the folder's name, past its chevron and icon. */}
      {depth > 0 && (
        <>
          <span aria-hidden className="w-2 shrink-0" />
          <Indent depth={depth} />
          <span aria-hidden className="w-5 shrink-0 sm:w-8" />
        </>
      )}
      <button className={cn("flex min-w-0 flex-1 flex-col gap-1 py-3 pr-4 text-left", depth > 0 ? "pl-0" : "pl-4")} onClick={() => navigate(`/types/${encodeURIComponent(t.id)}`)}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.95rem] font-medium">{t.name}</span>
          <code className="font-mono text-xs text-muted-foreground">{t.id}</code>
          {/* The section says built-in or custom; an edited built-in, or one filed in a folder, says what it is. */}
          {(t.edited || (t.shipped && t.folder)) && <Kind summary={t} />}
        </div>
        {t.description && <p className="line-clamp-2 text-sm text-muted-foreground">{t.description}</p>}
        <div className="flex items-center gap-2 text-xs text-muted-foreground sm:hidden">
          <span>{GRADER_LABEL[t.grader] ?? t.grader}</span>
          <span>·</span>
          <span className="tabular">{t.items} item{t.items === 1 ? "" : "s"}</span>
        </div>
      </button>
      <div className="hidden w-24 shrink-0 flex-col items-start gap-0.5 pt-3.5 text-xs text-muted-foreground sm:flex">
        <span>{GRADER_LABEL[t.grader] ?? t.grader}</span>
        <span className="tabular">{t.items} item{t.items === 1 ? "" : "s"}</span>
      </div>
      <div className="flex shrink-0 items-start pr-2 pt-2 sm:pl-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10" aria-label={`Actions for ${t.name}`}><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onMove}><FolderInput />Move to folder…</DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}><Copy />Duplicate…</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport(t)}><Download />Export JSON</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Pick a folder for a type (or a parent for a folder), or make a new one on the spot. Works without dragging, so on phones too. */
function MoveDialog({ target, folders, onOpenChange, onMoveType, onMoveFolder }: {
  target: MoveTarget | null;
  folders: string[];
  onOpenChange(o: boolean): void;
  onMoveType(id: string, folder: string): Promise<void>;
  onMoveFolder(path: string, parent: string): Promise<void>;
}) {
  const [pick, setPick] = useState("");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!target) return;
    setPick(target.kind === "type" ? target.folder : parentOf(target.path));
    setFresh("");
  }, [target]);
  if (!target) return null;

  const options = target.kind === "folder" ? folders.filter((f) => !within(f, target.path)) : folders;
  const current = target.kind === "type" ? target.folder : parentOf(target.path);
  const freshName = fresh.replace(/::/g, " ").trim();
  const dest = freshName ? (pick ? `${pick}::${freshName}` : freshName) : pick;
  const title = target.kind === "type" ? `Move “${target.name}”` : `Move the folder “${leaf(target.path)}”`;

  const go = async () => {
    if (dest === current) return;
    if (target.kind === "type") await onMoveType(target.id, dest);
    else {
      if (freshName) await api.createTypeFolder(dest).catch(() => {});
      await onMoveFolder(target.path, dest);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Folders only organize this page. The type and its cards don't change.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col overflow-y-auto rounded-lg border p-1" role="listbox" aria-label="Folders">
          {["", ...options].map((f) => (
            <button
              key={f || "(top)"}
              role="option"
              aria-selected={pick === f}
              className={cn("flex min-h-10 shrink-0 items-center gap-2 rounded-md pr-2 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring", pick === f && "bg-accent font-medium text-foreground")}
              style={{ paddingLeft: `${0.5 + 1.1 * (f ? f.split("::").length - 1 : 0)}rem` }}
              onClick={() => setPick(f)}
            >
              <Folder className="size-4 shrink-0 opacity-70" />
              <span className="truncate">{f ? leaf(f) : target.kind === "type" ? "No folder" : "Top level"}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {f === current && "now here"}
                {pick === f && <Check className="size-4 text-highlight" />}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Or a new folder {pick ? <>inside “{leaf(pick)}”</> : "at the top level"}</span>
          <Input value={fresh} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="Folder name" className="h-10" />
        </div>
        <DialogFooter>
          <Button onClick={go} disabled={dest === current} className="h-10 gap-1.5 sm:h-9"><FolderInput className="size-4" />{freshName ? "Create and move" : "Move"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderNameDialog({ state, folders, onOpenChange, onDone }: { state: FolderDialog | null; folders: string[]; onOpenChange(o: boolean): void; onDone(path: string): Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!state) return;
    setBusy(false);
    setName(state.mode === "rename" ? leaf(state.path) : "");
  }, [state]);
  if (!state) return null;

  const parent = state.mode === "create" ? state.parent : parentOf(state.path);
  const clean = name.replace(/::/g, " ").trim();
  const path = parent ? `${parent}::${clean}` : clean;
  const same = state.mode === "rename" && path === state.path;
  const taken = folders.includes(path) && !same;
  const ok = !!clean && !taken && !busy && !same;

  const save = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      if (state.mode === "create") await api.createTypeFolder(path);
      else await api.renameTypeFolder(state.path, path);
      await onDone(path);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state.mode === "create" ? (parent ? `New folder in “${leaf(parent)}”` : "New folder") : "Rename folder"}</DialogTitle>
          <DialogDescription>{state.mode === "create" ? "Drag types onto it, or use Move to folder in a type's menu." : "Everything inside stays inside."}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Networks" className={cn("h-10", taken && "border-destructive")} />
          {taken && <span className="text-xs text-destructive">There's already a folder called “{clean}” here.</span>}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={!ok} className="h-10 sm:h-9">{state.mode === "create" ? "Create folder" : "Rename"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
