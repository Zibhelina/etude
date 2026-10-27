import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, Download, Folder, FolderInput, FolderOpen, FolderPlus, Inbox, MoreHorizontal, Package, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
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
import { navigate, useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import { PHONE_H1 } from "@/components/page";

export function TypesPage({ id }: { id: string | null }) {
  if (id) return <TypeEditor key={id} id={id} />;
  return <TypeLibrary />;
}

// The page is a small file browser: the left rail (desktop) is the folder tree, the main column shows
// one place at a time (everything at the top level, a folder, or the built-ins), and search goes flat.

const COLLAPSED_KEY = "etude.typeFolders.collapsed";
const DRAG_TYPE = "application/x-etude-type";
const DRAG_FOLDER = "application/x-etude-folder";
/** The `folder` URL value for the built-in types, which aren't a real folder. */
const BUILT_IN = "@builtin";

const leaf = (path: string) => path.split("::").pop()!;
const parentOf = (path: string) => path.split("::").slice(0, -1).join("::");
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + "::");
const byName = (a: TypeSummary, b: TypeSummary) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const byLeaf = (a: string, b: string) => leaf(a).localeCompare(leaf(b), undefined, { sensitivity: "base" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ancestors(path: string): string[] {
  const parts = path.split("::");
  return parts.map((_, i) => parts.slice(0, i + 1).join("::"));
}

const open = (folder: string) => navigate(folder ? `/types?folder=${encodeURIComponent(folder)}` : "/types");

type MoveTarget = { kind: "type"; id: string; name: string; folder: string } | { kind: "folder"; path: string };
type FolderDialog = { mode: "create"; parent: string } | { mode: "rename"; path: string };
type DragProps = { draggable: boolean; onDragStart(e: React.DragEvent): void; onDragEnd(): void };
type DropProps = { onDragOver(e: React.DragEvent): void; onDragLeave(e: React.DragEvent): void; onDrop(e: React.DragEvent): void };

function TypeLibrary() {
  const { params } = useLocation();
  const here = params.get("folder") ?? "";
  const [types, setTypes] = useState<TypeSummary[] | null>(null);
  const [stored, setStored] = useState<string[]>([]);
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
        setStored(f);
      })
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    reload();
  }, []);

  const all = types ?? [];
  const custom = all.filter((t) => !t.shipped || t.folder);
  const builtins = all.filter((t) => t.shipped && !t.folder).sort(byName);
  const folders = useMemo(() => {
    const s = new Set(stored);
    for (const t of all) if (t.folder) for (const p of ancestors(t.folder)) s.add(p);
    return [...s];
  }, [stored, types]);
  const childFolders = (parent: string) => folders.filter((f) => parentOf(f) === parent).sort(byLeaf);
  const typesIn = (folder: string) => custom.filter((t) => t.folder === folder).sort(byName);
  const deepCount = (folder: string) => custom.filter((t) => t.folder && within(t.folder, folder)).length;

  // A folder that was renamed or deleted elsewhere: fall back to the top level.
  useEffect(() => {
    if (types && here && here !== BUILT_IN && !folders.includes(here)) open("");
  }, [types, here, folders.join()]);

  const saveCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    saveCollapsed(next);
  };
  // The current folder is always visible in the rail.
  useEffect(() => {
    if (!here || here === BUILT_IN) return;
    const hidden = ancestors(parentOf(here) || "").filter((p) => p && collapsed.has(p));
    if (parentOf(here) && hidden.length) {
      const next = new Set(collapsed);
      hidden.forEach((p) => next.delete(p));
      saveCollapsed(next);
    }
  }, [here]);

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
      await reload();
      const t = all.find((x) => x.id === id);
      toast.success(`Moved ${t?.name ?? id} to ${folder ? leaf(folder) : "the top level"}`, folder && folder !== here ? { action: { label: "Open", onClick: () => open(folder) } } : undefined);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const moveFolder = async (path: string, parent: string) => {
    const to = parent ? `${parent}::${leaf(path)}` : leaf(path);
    if (to === path) return;
    if (within(parent, path)) return void toast.error("A folder can't go inside itself");
    if (folders.includes(to)) return void toast.error(`There's already a folder called “${leaf(path)}” there`);
    try {
      await api.renameTypeFolder(path, to);
      if (within(here, path)) open(to + here.slice(path.length));
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // ------------------------------------------------------------ drag and drop
  const drag = (data: { type?: string; folder?: string }): DragProps => ({
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      if (data.type) e.dataTransfer.setData(DRAG_TYPE, data.type);
      if (data.folder) e.dataTransfer.setData(DRAG_FOLDER, data.folder);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => setDropAt(null),
  });
  const drop = (folder: string): DropProps => ({
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
      } else if (path && path !== folder) moveFolder(path, folder);
    },
  });

  const folderActions = (path: string) => ({
    onNewType: () => setCreating({ folder: path }),
    onNewFolder: () => setFolderDialog({ mode: "create", parent: path }),
    onRename: () => setFolderDialog({ mode: "rename", path }),
    onMove: () => setMoving({ kind: "folder", path }),
    onDelete: () => setDeleting(path),
  });
  const rowProps = (t: TypeSummary) => ({
    t,
    onExport: exportType,
    onDuplicate: () => setCreating({ source: t.id, folder: t.folder || (here !== BUILT_IN ? here : "") || undefined }),
    onMove: () => setMoving({ kind: "type", id: t.id, name: t.name, folder: t.folder }),
    drag: drag({ type: t.id }),
  });

  // ------------------------------------------------------------ what the main column shows
  const q = query.trim().toLowerCase();
  const matches = (t: TypeSummary) => t.name.toLowerCase().includes(q) || t.id.includes(q) || t.description.toLowerCase().includes(q);
  const results = q ? all.filter(matches).sort(byName) : [];
  const inBuiltIn = here === BUILT_IN;
  const subfolders = inBuiltIn ? [] : childFolders(here);
  const listed = inBuiltIn ? builtins : typesIn(here);
  const crumbs = here && !inBuiltIn ? ancestors(here) : [];
  const title = inBuiltIn ? "Built in" : here ? leaf(here) : "Card types";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
      {/* header */}
      <header className="mb-6 sm:mb-8">
        {here && (
          <nav aria-label="Folder" className="-ml-1.5 mb-1 flex min-w-0 flex-wrap items-center text-sm text-muted-foreground">
            <Crumb label="Card types" onClick={() => open("")} drop={drop("")} active={dropAt === ""} />
            {crumbs.slice(0, -1).map((c) => (
              <span key={c} className="flex min-w-0 items-center">
                <ChevronRight className="size-3.5 shrink-0 opacity-50" />
                <Crumb label={leaf(c)} onClick={() => open(c)} drop={drop(c)} active={dropAt === c} />
              </span>
            ))}
            <ChevronRight className="size-3.5 shrink-0 opacity-50" />
          </nav>
        )}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-4">
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex min-w-0 items-center gap-1">
              <h1 className={cn("min-w-0 truncate text-2xl font-semibold tracking-tight", PHONE_H1)}>{title}</h1>
              {here && !inBuiltIn && <FolderMenu name={leaf(here)} {...folderActions(here)} className="size-9" />}
            </div>
            <p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
              {inBuiltIn
                ? "These ship with Etude. Open one to see how it's made, or duplicate it to start your own."
                : here
                  ? [plural(listed.length, "type"), subfolders.length ? plural(subfolders.length, "folder") : ""].filter(Boolean).join(" · ")
                  : "Fields, an HTML/CSS/JS template and a grader. Built\u2011in types are written the same way, so any of them can be copied or changed."}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setImporting(true)}><Upload className="size-4" />Import</Button>
            <Button size="sm" className="h-9 gap-1.5" onClick={() => setCreating(here && !inBuiltIn ? { folder: here } : {})}><Plus className="size-4" />New type</Button>
          </div>
        </div>
      </header>

      {!types && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      )}

      {types && (
        <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
          {/* the folder rail */}
          <aside className="hidden lg:block">
            <div className="sticky top-6 flex flex-col gap-0.5 text-sm">
              <RailItem icon={Inbox} label="Not in a folder" count={typesIn("").length} active={!here && !q} onClick={() => { setQuery(""); open(""); }} drop={drop("")} dropping={dropAt === ""} />
              <div className="mt-5 mb-1 flex items-center justify-between pr-1 pl-[1.625rem]">
                <span className="text-xs font-medium text-muted-foreground">Folders</span>
                <button className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" onClick={() => setFolderDialog({ mode: "create", parent: here && !inBuiltIn ? here : "" })} aria-label="New folder" title="New folder">
                  <FolderPlus className="size-4" />
                </button>
              </div>
              {folders.length ? (
                <RailTree parent="" depth={0} childFolders={childFolders} count={(f) => typesIn(f).length} here={q ? null : here} collapsed={collapsed} toggle={toggle} drag={drag} drop={drop} dropAt={dropAt} onOpen={(f) => { setQuery(""); open(f); }} />
              ) : (
                <p className="py-1 pr-2.5 pl-[1.625rem] text-[13px] leading-relaxed text-pretty text-muted-foreground/80">No folders yet. Make one, then drag types onto it.</p>
              )}
              <div className="my-3 h-px bg-border" />
              <RailItem icon={Package} label="Built in" count={builtins.length} active={inBuiltIn && !q} onClick={() => { setQuery(""); open(BUILT_IN); }} />
            </div>
          </aside>

          <main className="min-w-0">
            <div className="mb-6 flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} placeholder="Search types" aria-label="Find a type" className="h-10 pr-10 pl-9" />
                {query && (
                  <button className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" onClick={() => setQuery("")} aria-label="Clear search">
                    <X className="size-4" />
                  </button>
                )}
              </div>
              {!inBuiltIn && (
                <Button variant="outline" className="h-10 gap-1.5 lg:hidden" onClick={() => setFolderDialog({ mode: "create", parent: here })} aria-label="New folder">
                  <FolderPlus className="size-4" /><span className="hidden sm:inline">New folder</span>
                </Button>
              )}
            </div>

            {q ? (
              <Group label={`${plural(results.length, "match")}`}>
                {results.length ? (
                  <List>{results.map((t) => <TypeRow key={t.id} {...rowProps(t)} showPlace />)}</List>
                ) : (
                  <Empty>Nothing called “{query.trim()}”. Try part of a name or an id.</Empty>
                )}
              </Group>
            ) : (
              <div className="flex flex-col gap-8">
                {subfolders.length > 0 && (
                  <div className="lg:hidden">
                    <Group label="Folders">
                      <List>
                        {subfolders.map((f) => (
                          <FolderCard
                            key={f}
                            path={f}
                            count={typesIn(f).length}
                            folders={childFolders(f).length}
                            dropping={dropAt === f}
                            drag={drag({ folder: f })}
                            drop={drop(f)}
                            {...folderActions(f)}
                          />
                        ))}
                      </List>
                    </Group>
                  </div>
                )}

                <Group label={inBuiltIn ? undefined : here ? (subfolders.length ? "Types" : undefined) : "Not in a folder"}>
                  {listed.length ? (
                    <List drop={inBuiltIn ? undefined : drop(here)} dropping={!inBuiltIn && dropAt === here}>
                      {listed.map((t) => <TypeRow key={t.id} {...rowProps(t)} />)}
                    </List>
                  ) : here ? (
                    <div {...drop(here)} className={cn("flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center transition-colors", dropAt === here && "border-highlight/70 bg-highlight/5")}>
                      <FolderOpen className="size-6 text-muted-foreground/70" />
                      <p className="max-w-xs text-sm text-pretty text-muted-foreground">Nothing here yet. Drag types onto this folder, use Move to folder in a type's menu, or start a new one here.</p>
                      <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setCreating({ folder: here })}><Plus className="size-4" />New type here</Button>
                    </div>
                  ) : custom.length ? (
                    <div {...drop("")} className={cn("rounded-xl border border-dashed px-6 py-6 text-center text-sm text-muted-foreground transition-colors", dropAt === "" && "border-highlight/70 bg-highlight/5")}>
                      Every custom type is in a folder.
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
                      <p className="max-w-sm text-sm text-muted-foreground">No custom types yet. Start from a blank template, or copy a built-in one and make it yours.</p>
                      <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setCreating({})}><Plus className="size-4" />New type</Button>
                    </div>
                  )}
                </Group>
                {!here && (
                  <div className="lg:hidden">
                    <List><BuiltInCard count={builtins.length} /></List>
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      )}

      <NewTypeDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} types={all} initialSource={creating?.source} folder={creating?.folder} />
      <ImportTypesDialog open={importing} onOpenChange={setImporting} types={all} onDone={reload} />
      <MoveDialog target={moving} folders={folders} onOpenChange={(o) => !o && setMoving(null)} onMoveType={moveType} onMoveFolder={moveFolder} />
      <FolderNameDialog
        state={folderDialog}
        folders={folders}
        onOpenChange={(o) => !o && setFolderDialog(null)}
        onDone={async (path, from) => {
          if (from && within(here, from)) open(path + here.slice(from.length));
          await reload();
        }}
      />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the folder “{deleting && leaf(deleting)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deepCount(deleting) > 0
                ? `No type is deleted. The ${plural(deepCount(deleting), "type")} inside move to ${parentOf(deleting) ? `“${leaf(parentOf(deleting))}”` : "the top level"}, and the folders inside it go too.`
                : "It's empty, so nothing else changes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const d = deleting!;
                try {
                  await api.deleteTypeFolder(d);
                  if (within(here, d)) open(parentOf(d));
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

// ------------------------------------------------------------------ pieces

function Crumb({ label, onClick, drop, active }: { label: string; onClick(): void; drop: DropProps; active: boolean }) {
  return (
    <button className={cn("min-h-8 max-w-48 truncate rounded-md px-1.5 transition-colors hover:text-foreground", active && "bg-highlight/10 text-highlight")} onClick={onClick} {...drop}>
      {label}
    </button>
  );
}

function Group({ label, aside, children }: { label?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      {label && (
        <div className="mb-2.5 flex items-baseline justify-between px-0.5 text-xs font-medium text-muted-foreground">
          <span>{label}</span>
          {aside !== undefined && <span className="tabular">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

function List({ children, drop, dropping }: { children: React.ReactNode; drop?: DropProps; dropping?: boolean }) {
  return <div className={cn("divide-y overflow-hidden rounded-xl border bg-card/40 transition-colors", dropping && "border-highlight/70")} {...drop}>{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function RailItem({ icon: Icon, label, count, active, onClick, drop, dropping }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  active: boolean;
  onClick(): void;
  drop?: DropProps;
  dropping?: boolean;
}) {
  return (
    <button
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg pr-2.5 pl-[1.625rem] text-left transition-colors hover:bg-accent/60",
        active ? "bg-accent font-medium text-foreground" : "text-foreground/80",
        dropping && "bg-highlight/10 text-highlight",
      )}
      onClick={onClick}
      {...drop}
    >
      <Icon className={cn("size-4 shrink-0", active ? "text-foreground/80" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular w-6 text-right text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

function RailTree(p: {
  parent: string;
  depth: number;
  childFolders(parent: string): string[];
  count(folder: string): number;
  here: string | null;
  collapsed: Set<string>;
  toggle(path: string): void;
  drag(d: { folder: string }): DragProps;
  drop(folder: string): DropProps;
  dropAt: string | null;
  onOpen(folder: string): void;
}) {
  return (
    <>
      {p.childFolders(p.parent).map((f) => {
        const kids = p.childFolders(f).length > 0;
        const expanded = kids && !p.collapsed.has(f);
        const active = p.here === f;
        return (
          <div key={f}>
            <div
              data-rail={f}
              className={cn(
                "group flex h-9 items-center rounded-lg pr-2.5 transition-colors hover:bg-accent/60",
                active ? "bg-accent font-medium text-foreground" : "text-foreground/80",
                p.dropAt === f && "bg-highlight/10 text-highlight",
              )}
              style={{ paddingLeft: `${0.125 + p.depth * 1.25}rem` }}
              {...p.drag({ folder: f })}
              {...p.drop(f)}
            >
              <button
                className={cn("flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground", !kids && "invisible")}
                onClick={() => p.toggle(f)}
                aria-label={expanded ? `Collapse ${leaf(f)}` : `Expand ${leaf(f)}`}
                aria-expanded={expanded}
                tabIndex={kids ? 0 : -1}
              >
                <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
              </button>
              <button className="flex h-full min-w-0 flex-1 items-center gap-2 text-left" onClick={() => p.onOpen(f)}>
                {p.dropAt === f ? <FolderOpen className="size-4 shrink-0 text-highlight" /> : active ? <FolderOpen className="size-4 shrink-0 text-foreground/80" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{leaf(f)}</span>
                <span className="tabular w-6 text-right text-xs text-muted-foreground">{p.count(f)}</span>
              </button>
            </div>
            {expanded && <RailTree {...p} parent={f} depth={p.depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

function FolderMenu(p: { name: string; onNewType(): void; onNewFolder(): void; onRename(): void; onMove(): void; onDelete(): void; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-8 shrink-0 text-muted-foreground", p.className)} aria-label={`Actions for folder ${p.name}`} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={p.onNewType}><Plus />New type here…</DropdownMenuItem>
        <DropdownMenuItem onClick={p.onNewFolder}><FolderPlus />New folder inside…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={p.onRename}><Pencil />Rename…</DropdownMenuItem>
        <DropdownMenuItem onClick={p.onMove}><FolderInput />Move to…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={p.onDelete}><Trash2 />Delete folder…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderCard(p: {
  path: string;
  count: number;
  folders: number;
  dropping: boolean;
  drag: DragProps;
  drop: DropProps;
  onNewType(): void;
  onNewFolder(): void;
  onRename(): void;
  onMove(): void;
  onDelete(): void;
}) {
  const name = leaf(p.path);
  return (
    <div
      data-folder={p.path}
      role="button"
      tabIndex={0}
      onClick={() => open(p.path)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(p.path))}
      className={cn(
        "group flex min-h-14 cursor-pointer items-center gap-3 py-2 pr-1.5 pl-4 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40",
        p.dropping && "bg-highlight/10",
      )}
      {...p.drag}
      {...p.drop}
    >
      {p.dropping ? <FolderOpen className="size-5 shrink-0 text-highlight" /> : <Folder className="size-5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.95rem] font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">{p.count || p.folders ? [p.count ? plural(p.count, "type") : "", p.folders ? plural(p.folders, "folder") : ""].filter(Boolean).join(" · ") : "Empty"}</div>
      </div>
      <FolderMenu name={name} {...p} className="size-9" />
    </div>
  );
}

function BuiltInCard({ count }: { count: number }) {
  return (
    <button className="flex min-h-14 w-full items-center gap-3 py-2 pr-2.5 pl-4 text-left transition-colors hover:bg-accent/40" onClick={() => open(BUILT_IN)}>
      <Package className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.95rem] font-medium">Built in</span>
        <span className="block truncate text-xs text-muted-foreground">{plural(count, "type")} that ship with Etude</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function TypeRow({ t, onExport, onDuplicate, onMove, drag, showPlace }: {
  t: TypeSummary;
  onExport(t: TypeSummary): void;
  onDuplicate(): void;
  onMove(): void;
  drag?: DragProps;
  /** In search results: say which folder the type lives in. */
  showPlace?: boolean;
}) {
  const place = t.folder ? t.folder.split("::").join(" › ") : t.shipped ? "Built in" : "Not in a folder";
  // Most types are script-graded; only say so when it's something else.
  const grader = t.grader !== "script" ? GRADER_LABEL[t.grader] ?? t.grader : null;
  return (
    <div data-type={t.id} className="group flex min-h-16 items-center gap-3 pr-1.5 pl-4 transition-colors hover:bg-accent/40" {...drag}>
      <button className="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 text-left" onClick={() => navigate(`/types/${encodeURIComponent(t.id)}`)}>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[0.95rem] font-medium">{t.name}</span>
          <code className="hidden shrink-0 font-mono text-xs text-muted-foreground/70 sm:inline">{t.id}</code>
          {t.edited && <Kind summary={t} />}
        </div>
        {t.description && <p className="line-clamp-2 max-w-[68ch] text-[13px] leading-snug text-muted-foreground sm:line-clamp-1">{t.description.replace(/\.$/, "")}</p>}
        {showPlace && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground/80">
            {t.folder ? <Folder className="size-3 shrink-0" /> : t.shipped ? <Package className="size-3 shrink-0" /> : <Inbox className="size-3 shrink-0" />}
            <span className="truncate">{place}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
          <code className="font-mono">{t.id}</code>
          <span aria-hidden>·</span>
          <span className="tabular">{plural(t.items, "item")}</span>
          {grader && <><span aria-hidden>·</span><span>{grader}</span></>}
        </div>
      </button>
      <div className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex">
        {grader && <span className="rounded-md border px-1.5 py-0.5 text-[11px]">{grader}</span>}
        <span className="tabular w-8 text-right" title={plural(t.items, "item")}>{t.items}</span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 sm:data-[state=open]:opacity-100" aria-label={`Actions for ${t.name}`}><MoreHorizontal className="size-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onMove}><FolderInput />Move to folder…</DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}><Copy />Duplicate…</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport(t)}><Download />Export JSON</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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

  const sorted = [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const options = target.kind === "folder" ? sorted.filter((f) => !within(f, target.path)) : sorted;
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
          <DialogDescription>Folders only organize the Types page. The type and its cards don't change.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-xl border bg-card/40 p-1.5" role="listbox" aria-label="Folders">
          {["", ...options].map((f) => {
            const chosen = pick === f;
            return (
              <button
                key={f || "(top)"}
                role="option"
                aria-selected={chosen}
                className={cn("flex min-h-10 shrink-0 items-center gap-2.5 rounded-lg pr-2.5 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring", chosen && "bg-accent font-medium")}
                style={{ paddingLeft: `${0.625 + 1 * (f ? f.split("::").length - 1 : 0)}rem` }}
                onClick={() => setPick(f)}
              >
                {f ? (chosen ? <FolderOpen className="size-4 shrink-0 text-highlight" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />) : <Inbox className={cn("size-4 shrink-0", chosen ? "text-highlight" : "text-muted-foreground")} />}
                <span className="min-w-0 flex-1 truncate">{f ? leaf(f) : target.kind === "type" ? "No folder" : "Top level"}</span>
                {f === current && <span className="shrink-0 text-xs font-normal text-muted-foreground">here now</span>}
                <Check className={cn("size-4 shrink-0 text-highlight", !chosen && "invisible")} />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">or make a new folder {pick ? <>inside <span className="text-foreground">{leaf(pick)}</span></> : "at the top level"}</span>
          <Input value={fresh} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="New folder name" className="h-10" />
        </div>
        <DialogFooter>
          <Button onClick={go} disabled={dest === current} className="h-10 gap-1.5 sm:h-9">
            <FolderInput className="size-4" />
            {freshName ? `Move to new “${freshName}”` : dest ? `Move to ${leaf(dest)}` : target.kind === "type" ? "Take out of folder" : "Move to top level"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderNameDialog({ state, folders, onOpenChange, onDone }: { state: FolderDialog | null; folders: string[]; onOpenChange(o: boolean): void; onDone(path: string, from?: string): Promise<void> }) {
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
      await onDone(path, state.mode === "rename" ? state.path : undefined);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{state.mode === "create" ? "New folder" : "Rename folder"}</DialogTitle>
          <DialogDescription>{state.mode === "create" ? (parent ? `Inside ${parent.split("::").join(" › ")}.` : "At the top level.") : "Everything inside stays inside."}</DialogDescription>
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
