import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, FolderInput, FolderOpen, FolderPlus, MoreHorizontal, Plus, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeEditor } from "@/components/type-editor/editor";
import { TypeDetail } from "@/components/type-editor/detail";
import { ImportTypesDialog, NewTypeDialog, type Start } from "@/components/type-editor/dialogs";
import { FolderMenu, FolderNameDialog, MoveDialog, leaf, parentOf, within, type FolderDialog, type MoveTarget } from "@/components/type-editor/folders";
import { TypeThumb } from "@/components/type-editor/type-card";
import { ACTS, actOf } from "@/components/type-editor/acts";
import { download, exportShape, GRADER_LABEL, readPending } from "@/components/type-editor/starter";
import { faceSrc, minimiFaceId } from "@/lib/minimi-face";
import { api, type TypeSummary } from "@/lib/api";
import { useFunMode } from "@/lib/fun";
import { navigate, useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useHScroll } from "@/lib/hscroll";

/** `/types` is the gallery, `/types/<id>` a type's page, `/types/<id>?edit=1` its editor. */
export function TypesPage({ id }: { id: string | null }) {
  const { params } = useLocation();
  if (!id) return <TypeLibrary />;
  return <TypeRoute key={id} id={id} edit={!!params.get("edit")} />;
}

function TypeRoute({ id, edit }: { id: string; edit: boolean }) {
  // A new type that was never saved only exists in the editor; so does the "no such type" message.
  const [missing, setMissing] = useState(false);
  if (edit || missing || readPending(id)) return <TypeEditor id={id} />;
  return <TypeDetail id={id} onMissing={() => setMissing(true)} />;
}

// The gallery: every type as a live card, grouped by what you do on it (or by the folders you made).

const GROUP_KEY = "etude.types.group";
const DRAG_TYPE = "application/x-etude-type";
const DRAG_FOLDER = "application/x-etude-folder";
const BUILT_IN = "@built";
const NO_FOLDER = "@none";

type Chip = "all" | "built" | "yours";
type Grouping = "act" | "folder";
type Group = { key: string; title: string; sub?: string; folder?: string; types: TypeSummary[] };
type DragProps = { draggable: boolean; onDragStart(e: React.DragEvent): void; onDragEnd(): void };
type DropProps = { onDragOver(e: React.DragEvent): void; onDragLeave(e: React.DragEvent): void; onDrop(e: React.DragEvent): void };

const fmtN = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s") => `${fmtN(n)} ${n === 1 ? one : many}`;
const byUse = (a: TypeSummary, b: TypeSummary) => b.items - a.items || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
// Yours first, then the built-ins: the ones you made are what you came for.
const yoursFirst = (a: TypeSummary, b: TypeSummary) => Number(a.shipped && !a.edited) - Number(b.shipped && !b.edited) || byUse(a, b);
const ancestors = (path: string) => path.split("::").map((_, i, parts) => parts.slice(0, i + 1).join("::"));
const isDrill = (t: TypeSummary) => t.scheduler === "drill" || (!t.showVerdict && actOf(t) === "games");
/** What's worth saying about how a type is checked: drills, and graders other than a script. */
const howLabel = (t: TypeSummary) => (isDrill(t) ? "Drill" : t.grader !== "script" ? (GRADER_LABEL[t.grader] ?? t.grader) : "");

function TypeLibrary() {
  const { params } = useLocation();
  const fun = useFunMode();
  const [types, setTypes] = useState<TypeSummary[] | null>(null);
  const [stored, setStored] = useState<string[]>([]);
  const [creating, setCreating] = useState<{ source?: string; folder?: string; start?: Start } | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  const [grouping, setGroupingState] = useState<Grouping>(() => (params.get("folder") != null || localStorage.getItem(GROUP_KEY) === "folder" ? "folder" : "act"));
  const [moving, setMoving] = useState<MoveTarget | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const setGrouping = (g: Grouping) => {
    setGroupingState(g);
    localStorage.setItem(GROUP_KEY, g);
  };

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

  // "/" finds a type.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      e.preventDefault();
      setSearching(true);
      requestAnimationFrame(() => search.current?.focus());
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const all = types ?? [];
  const folders = useMemo(() => {
    const s = new Set(stored);
    for (const t of all) if (t.folder) for (const p of ancestors(t.folder)) s.add(p);
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [stored, types]);
  const deepCount = (folder: string) => all.filter((t) => t.folder && within(t.folder, folder)).length;
  const builtCount = all.filter((t) => t.shipped).length;
  const yours = all.filter((t) => !t.shipped);

  // A link to a folder (the editor used to send you back to one) opens that folder's group.
  const linked = params.get("folder");
  useEffect(() => {
    if (!types || !linked) return;
    requestAnimationFrame(() => document.querySelector(`[data-group="${CSS.escape(linked)}"]`)?.scrollIntoView({ block: "start" }));
  }, [!!types, linked]);

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
      toast.success(`Moved ${t?.name ?? id} to ${folder ? leaf(folder) : "no folder"}`);
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
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // ------------------------------------------------------------ drag and drop (folder view)
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

  // ------------------------------------------------------------ what shows
  const q = query.trim().toLowerCase();
  const shown = all
    .filter((t) => (chip === "built" ? t.shipped : chip === "yours" ? !t.shipped : true))
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.includes(q) || t.description.toLowerCase().includes(q) || t.folder.toLowerCase().includes(q));

  const groups: Group[] = useMemo(() => {
    if (grouping === "act")
      return ACTS.map((a) => ({ key: a.id, title: a.title, sub: a.sub, types: shown.filter((t) => actOf(t) === a.id).sort(yoursFirst) })).filter((g) => g.types.length);
    const by = new Map<string, TypeSummary[]>();
    for (const t of shown) {
      const k = t.folder || (t.shipped ? BUILT_IN : NO_FOLDER);
      by.set(k, [...(by.get(k) ?? []), t]);
    }
    // Empty folders still show, so there's somewhere to drop.
    if (chip !== "built" && !q) for (const f of folders) if (!by.has(f)) by.set(f, []);
    const order = (k: string) => (k === BUILT_IN ? 2 : k === NO_FOLDER ? 1 : 0);
    return [...by.keys()]
      .sort((a, b) => order(a) - order(b) || a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map((k) => ({
        key: k,
        title: k === BUILT_IN ? "Built in" : k === NO_FOLDER ? "Not in a folder" : k.split("::").join(" › "),
        sub: k === BUILT_IN ? "Ship with Etude. Copy one to start your own" : undefined,
        folder: k === BUILT_IN ? undefined : k === NO_FOLDER ? "" : k,
        types: by.get(k)!.sort(byUse),
      }));
  }, [types, grouping, chip, q, folders.join("\n")]);

  const tileProps = (t: TypeSummary) => ({
    t,
    drag: grouping === "folder" && !q ? drag({ type: t.id }) : undefined,
    onMove: () => setMoving({ kind: "type", id: t.id, name: t.name, folder: t.folder }),
    onDuplicate: () => setCreating({ source: t.id, folder: t.folder || undefined }),
    onExport: () => exportType(t),
  });
  const folderActions = (path: string) => ({
    onNewType: () => setCreating({ folder: path }),
    onNewFolder: () => setFolderDialog({ mode: "create", parent: path }),
    onRename: () => setFolderDialog({ mode: "rename", path }),
    onMove: () => setMoving({ kind: "folder", path }),
    onDelete: () => setDeleting(path),
  });

  const yoursEmpty = chip === "yours" && !yours.length && !q;
  const newType = (start?: Start) => setCreating({ start });

  return (
    <div className="types-page mx-auto w-full max-w-[62rem] px-4 pt-5 pb-14 max-md:pt-[calc(1rem+env(safe-area-inset-top))] sm:px-8 sm:pt-12">
      <button className="-ml-1.5 mb-2 flex min-h-9 items-center gap-1 rounded-md px-1.5 text-[15px] text-muted-foreground transition-colors hover:text-foreground md:hidden" onClick={() => navigate("/more")}>
        <ChevronLeft className="size-4" />More
      </button>
      <header>
        <h1 className="score-serif score-display text-[2.25rem] leading-[1.1] sm:text-[2.5rem]">Card types</h1>
        <p className="mt-2 max-w-[38rem] text-[15.5px] leading-snug text-pretty text-muted-foreground max-sm:hidden">What a card shows, what you do on it, and how it's checked. Open one to see how it's made.</p>
        <div className="mt-5 flex gap-2.5 max-sm:mt-4">
          <Button variant="outline" className="types-raised h-11 gap-2 px-4 text-[15px]" onClick={() => setImporting(true)}><Upload className="size-4" />Import</Button>
          <Button className="h-11 gap-2 px-5 text-[15px] max-sm:flex-1" onClick={() => newType()}><Plus className="size-4" strokeWidth={2.4} />New type</Button>
        </div>
      </header>

      {/* search, filters and grouping */}
      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <label className={cn("types-search relative flex h-11 items-center rounded-full border bg-background", searching || query ? "w-full sm:w-64" : "w-11 sm:w-64")}>
          <Search className="pointer-events-none absolute left-3.5 size-4 text-muted-foreground" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearching(true)}
            onBlur={() => !query && setSearching(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search types"
            aria-label="Search types"
            className="h-full w-full min-w-0 rounded-full bg-transparent pr-10 pl-10 text-[15px] outline-none placeholder:text-muted-foreground max-sm:placeholder:text-transparent max-sm:focus:placeholder:text-muted-foreground"
          />
          {query ? (
            <button className="absolute right-1.5 flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" onClick={() => setQuery("")} aria-label="Clear search"><X className="size-4" /></button>
          ) : (
            <kbd className="pointer-events-none absolute right-3 hidden rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted-foreground/70 shadow-[inset_0_0_0_1px_var(--border)] pointer-fine:sm:block">/</kbd>
          )}
        </label>
        <div className="flex gap-2 max-sm:min-w-0 max-sm:flex-1 max-sm:overflow-x-auto" role="group" aria-label="Show">
          {([["all", "All", all.length], ["built", "Built in", builtCount], ["yours", "Yours", yours.length]] as const).map(([k, label, n]) => (
            <button key={k} onClick={() => setChip(k)} aria-pressed={chip === k} className={cn("types-chip h-11 shrink-0 rounded-full border px-4 text-[15px] transition-colors", chip === k ? "border-transparent bg-muted font-semibold text-foreground" : "text-foreground/80 hover:bg-accent/50")}>
              {label} <span className={cn("tabular", chip === k ? "text-foreground/70" : "text-muted-foreground")}>{n}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground lg:ml-auto max-lg:w-full">
          {!yoursEmpty && (
            <>
              <span className="max-sm:hidden">Group by</span>
              <div className="flex rounded-lg bg-muted p-1" role="radiogroup" aria-label="Group by">
                {([["act", "What you do"], ["folder", "Folder"]] as const).map(([k, label]) => (
                  <button key={k} role="radio" aria-checked={grouping === k} onClick={() => setGrouping(k)} className={cn("h-8 rounded-md px-3 text-[14px] transition-colors", grouping === k ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
                    {label}
                  </button>
                ))}
              </div>
              {grouping === "folder" && (
                <Button variant="ghost" size="icon" className="size-10 text-muted-foreground" onClick={() => setFolderDialog({ mode: "create", parent: "" })} aria-label="New folder" title="New folder"><FolderPlus className="size-[1.1rem]" /></Button>
              )}
            </>
          )}
        </div>
      </div>

      {fun && types && !yoursEmpty && <MinimiLine types={all} onDescribe={() => newType("describe")} />}

      {!types && (
        <div className="mt-10 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-80 rounded-2xl" />)}
        </div>
      )}

      {types && yoursEmpty && <YoursEmpty fun={fun} onStart={newType} />}

      {types && !yoursEmpty && !shown.length && (
        <p className="mt-10 rounded-2xl border border-dashed px-6 py-10 text-center text-[15px] text-muted-foreground">
          Nothing called <b className="text-foreground">“{query.trim()}”</b>. Try part of a name, or <button className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => newType("describe")}>describe a new type</button>.
        </p>
      )}

      {types && !yoursEmpty && shown.length > 0 && q && (
        <GroupSection title={plural(shown.length, "match", "matches")} phoneGrid>
          {shown.sort(byUse).map((t) => <Tile key={t.id} {...tileProps(t)} />)}
        </GroupSection>
      )}

      {types && !yoursEmpty && shown.length > 0 && !q &&
        groups.map((g) => {
          const open = expanded.has(g.key);
          const droppable = grouping === "folder" && g.folder !== undefined;
          return (
            <GroupSection
              key={g.key}
              id={g.key}
              title={g.title}
              count={g.types.length}
              sub={g.sub}
              open={open}
              onToggle={g.types.length > 1 ? () => setExpanded((s) => (s.has(g.key) ? (s.delete(g.key), new Set(s)) : new Set(s).add(g.key))) : undefined}
              menu={droppable && g.folder ? <FolderMenu name={leaf(g.folder)} {...folderActions(g.folder)} className="size-8" /> : undefined}
              drop={droppable ? drop(g.folder!) : undefined}
              dropping={droppable && dropAt === g.folder}
              dragHandle={droppable && g.folder ? drag({ folder: g.folder }) : undefined}
            >
              {g.types.length ? (
                g.types.map((t) => <Tile key={t.id} {...tileProps(t)} />)
              ) : (
                <div className="col-span-full flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-8 text-center max-sm:mx-4">
                  <FolderOpen className="size-5 text-muted-foreground/70" />
                  <p className="max-w-xs text-sm text-pretty text-muted-foreground">Nothing here yet. Drag a type onto this folder, or use Move to folder in a type's menu.</p>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setCreating({ folder: g.folder })}><Plus className="size-4" />New type here</Button>
                </div>
              )}
            </GroupSection>
          );
        })}

      <NewTypeDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} types={all} initialSource={creating?.source} folder={creating?.folder} start={creating?.start} />
      <ImportTypesDialog open={importing} onOpenChange={setImporting} types={all} onDone={reload} />
      <MoveDialog target={moving} folders={folders} onOpenChange={(o) => !o && setMoving(null)} onMoveType={moveType} onMoveFolder={moveFolder} />
      <FolderNameDialog state={folderDialog} folders={folders} onOpenChange={(o) => !o && setFolderDialog(null)} onDone={async () => { await reload(); }} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the folder “{deleting && leaf(deleting)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deepCount(deleting) > 0
                ? `No type is deleted. The ${plural(deepCount(deleting), "type")} inside move to ${parentOf(deleting) ? `“${leaf(parentOf(deleting))}”` : "no folder"}, and the folders inside it go too.`
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

// ------------------------------------------------------------------ pieces

/** Fun mode: Minimi sums up what you've made and offers to write the next one. */
function MinimiLine({ types, onDescribe }: { types: TypeSummary[]; onDescribe(): void }) {
  const mine = types.filter((t) => !t.shipped);
  // "Mostly piano and networks": the two folders holding most of your types.
  const counts = new Map<string, number>();
  for (const t of mine) if (t.folder) counts.set(t.folder.split("::")[0], (counts.get(t.folder.split("::")[0]) ?? 0) + 1);
  // Only worth saying when those folders hold most of what you made.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const covered = ranked.reduce((n, [, c]) => n + c, 0);
  const top = covered * 2 >= mine.length && covered >= 3 ? ranked.map(([f]) => (/^[A-Z][a-z]+$/.test(f) ? f.toLowerCase() : f)) : [];
  const mostly = top.length === 2 ? ` Mostly ${top[0]} and ${top[1]}.` : top.length === 1 ? ` Mostly ${top[0]}.` : "";
  return (
    <div className="mt-6 flex items-start gap-3">
      <img src={faceSrc(minimiFaceId())} alt="Minimi" className="size-12 shrink-0 rounded-full object-cover" />
      <p className="types-bubble relative max-w-[40rem] rounded-2xl bg-muted px-4 py-2.5 text-[15.5px] leading-snug">
        {mine.length ? (
          <>You've made <b>{mine.length}</b>.{mostly} Describe the next one and I'll write the first draft. </>
        ) : (
          <>These {types.length} come with Etude. Open any of them to see how it's made, or tell me what you practice and I'll write a new one. </>
        )}
        <button className="inline-flex items-center gap-0.5 font-semibold whitespace-nowrap underline-offset-4 hover:underline" onClick={onDescribe}>Describe one<ChevronRight className="size-3.5" strokeWidth={2.6} /></button>
      </p>
    </div>
  );
}

function YoursEmpty({ fun, onStart }: { fun: boolean; onStart(s: Start): void }) {
  const starts: [Start, React.ReactNode, string, string][] = [
    ["describe", fun ? <img src={faceSrc(minimiFaceId())} alt="" className="size-full object-cover" /> : <span className="score-serif text-[1.35rem] leading-none">ε</span>, "Describe it", `Say what you want to practice. ${fun ? "Minimi" : "Etude"} writes it, you check it.`],
    ["copy", <Copy className="size-5" />, "Copy a type", "Start from one that's close and change it."],
    ["blank", <Plus className="size-5" />, "Blank", "Fields, HTML, CSS and a grader, from zero."],
  ];
  return (
    <section className="mt-8 rounded-2xl border bg-card p-5 sm:p-6">
      <h2 className="types-kicker">Yours</h2>
      <p className="mt-2.5 text-[15px]">You haven't made a type yet.</p>
      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        {starts.map(([k, icon, title, sub]) => (
          <button key={k} onClick={() => onStart(k)} className="flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors hover:bg-accent/50">
            <span className={cn("flex size-11 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground", k === "describe" && fun && "rounded-full bg-transparent")}>{icon}</span>
            <b className="text-[15px] font-semibold">{title}</b>
            <span className="text-[13px] leading-snug text-muted-foreground">{sub}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * A titled group of tiles. On a phone it's one swipeable row, with "See all" turning it into a list;
 * wider, a grid. `phoneGrid` keeps two columns on the phone (search results).
 */
function GroupSection(p: {
  id?: string;
  title: string;
  count?: number;
  sub?: string;
  open?: boolean;
  onToggle?(): void;
  menu?: React.ReactNode;
  drop?: DropProps;
  dropping?: boolean;
  dragHandle?: DragProps;
  phoneGrid?: boolean;
  children: React.ReactNode;
}) {
  // On a phone a closed group is one sideways row; the shared scroller gives it the edge fade and ← →.
  const row = useRef<HTMLDivElement>(null);
  const sideways = !p.phoneGrid && !p.open;
  const hs = useHScroll(row, { dep: sideways });
  return (
    <section data-group={p.id} className={cn("mt-9 scroll-mt-6 rounded-2xl transition-shadow", p.dropping && "shadow-[0_0_0_2px_var(--ring)]")} {...p.drop}>
      <div className="mb-3 flex min-h-8 items-center gap-2.5" {...p.dragHandle}>
        <h2 className="types-kicker">{p.title}</h2>
        {p.count !== undefined && <span className="text-[13.5px] text-muted-foreground/80">{p.count}{p.sub ? <span className="max-sm:hidden"> · {p.sub}</span> : null}</span>}
        {p.menu}
        <span className="flex-1" />
        {p.onToggle && (
          <button className="text-[15px] text-muted-foreground transition-colors hover:text-foreground sm:hidden" onClick={p.onToggle}>{p.open ? "Less" : "See all"}</button>
        )}
      </div>
      <div
        ref={row}
        {...(sideways ? hs.rowProps : {})}
        className={cn(
          "grid gap-4 sm:[grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]",
          p.phoneGrid
            ? "types-grid2 max-sm:grid-cols-2 max-sm:gap-2.5"
            : p.open
              ? "types-list max-sm:gap-0"
              : "types-row max-sm:-mx-4 max-sm:flex max-sm:snap-x max-sm:snap-mandatory max-sm:gap-3 max-sm:overflow-x-auto max-sm:scroll-px-4 max-sm:px-4 max-sm:pb-1",
        )}
      >
        {p.children}
      </div>
    </section>
  );
}

function Tile({ t, drag, onMove, onDuplicate, onExport }: { t: TypeSummary; drag?: DragProps; onMove(): void; onDuplicate(): void; onExport(): void }) {
  const how = howLabel(t);
  const go = () => navigate(`/types/${encodeURIComponent(t.id)}`);
  return (
    <div data-type={t.id} className="types-tile group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card max-sm:w-[15rem] max-sm:shrink-0 max-sm:snap-start" {...drag}>
      <button className="flex min-w-0 flex-1 flex-col text-left outline-none" onClick={go} aria-label={`${t.name}, open`}>
        <TypeThumb t={t} className="types-thumb h-[11.75rem] max-sm:h-[11rem]" />
        <div className="types-tile-body flex flex-1 flex-col px-4 pt-3 pb-3.5">
          <div className="flex min-w-0 items-center gap-2 pr-7">
            <span className="truncate text-[16px] font-semibold">{t.name}</span>
            {t.edited ? <span className="types-badge">Yours</span> : t.shipped && <span className="types-badge">Built in</span>}
          </div>
          <p className="types-desc mt-1 line-clamp-2 text-[14.5px] leading-snug text-muted-foreground">{t.description}</p>
          <div className="mt-auto flex items-center gap-1.5 pt-2.5 text-[13.5px] text-muted-foreground">
            {t.items ? <b className="tabular font-medium text-foreground/80">{plural(t.items, "item")}</b> : <span>not used yet</span>}
            {how && <><span aria-hidden>·</span><span>{how}</span></>}
          </div>
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="types-tile-menu absolute right-2 bottom-2 size-8 text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${t.name}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onMove}><FolderInput />Move to folder…</DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}><Copy />Duplicate…</DropdownMenuItem>
          <DropdownMenuItem onClick={onExport}><Download />Export JSON</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

