import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpLeft, ArrowUpToLine, CalendarClock, ChevronRight, Eye, FastForward, FolderInput, GripVertical, MoreHorizontal, Pencil, Play, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, relative, type DeckNode } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader, Section } from "@/components/page";
import { UpdateBar } from "@/components/update-bar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { childrenOf, clashes, leafOf, moveDeck, MoveDeckDialog, parentOf } from "@/components/move-deck";

/** Where a dragged deck would land: between rows (`line`) or inside a deck (`into`). */
type Drop = { kind: "line" | "into"; parent: string; index: number | undefined; y: number; depth: number };

export function DecksPage() {
  const [decks, setDecks] = useState<DeckNode[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("etude.collapsed") ?? "[]")));
  const [creating, setCreating] = useState(false);

  const reload = () => api.decks().then(setDecks).catch((e) => toast.error(e.message));
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const toggle = (name: string) => {
    const next = new Set(collapsed);
    next.has(name) ? next.delete(name) : next.add(name);
    setCollapsed(next);
    localStorage.setItem("etude.collapsed", JSON.stringify([...next]));
  };

  const visible = useMemo(() => {
    if (!decks) return [];
    const hasChildren = new Set(decks.filter((d) => d.depth > 0).map((d) => d.name.split("::").slice(0, -1).join("::")));
    return decks
      .filter((d) => {
        const parts = d.name.split("::");
        for (let i = 1; i < parts.length; i++) if (collapsed.has(parts.slice(0, i).join("::"))) return false;
        return true;
      })
      .map((d) => ({ ...d, hasChildren: hasChildren.has(d.name) }));
  }, [decks, collapsed]);

  const due = (decks ?? []).filter((d) => d.depth === 0).reduce((a, d) => a + d.new + d.learning + d.review, 0);

  // ------------------------------------------------------------ moving
  // Drag a deck by its grip anywhere in the tree: onto a deck to put it inside, or between rows to
  // place it there (which can take it out to the top level). The rows don't reshuffle while you
  // drag; a line or a highlight shows where it will land. Arrow keys reorder among siblings,
  // Alt+← takes it out one level, Alt+→ puts it inside the deck above.
  const rows = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const expandTimer = useRef<{ name: string; t: number } | null>(null);
  const [drag, setDrag] = useState<{ name: string; x: number; y: number; drop: Drop | null } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  const after = (focus?: string) => {
    reload().then(() => focus && requestAnimationFrame(() => rows.current.get(focus)?.querySelector<HTMLElement>("[data-grip]")?.focus()));
  };
  const place = async (name: string, parent: string, index: number | undefined, focus = false) => {
    // Opening the new parent so the moved deck stays in sight.
    if (parent && collapsed.has(parent)) toggle(parent);
    await moveDeck(decks ?? [], name, parent, index, (n) => after(focus ? n : undefined));
  };

  /** Where a drop at (x, y) would put `name`, or null for "nowhere new". */
  const dropAt = (name: string, y: number): Drop | null => {
    const all = decks ?? [];
    const others = visible.filter((d) => !(d.name === name || d.name.startsWith(name + "::")));
    if (!others.length) return null;
    const indexAmong = (parent: string, before: string | null) => {
      const sibs = childrenOf(all, parent).filter((n) => n !== name);
      return before === null ? sibs.length : Math.max(0, sibs.indexOf(before));
    };
    const box = (n: string) => rows.current.get(n)!.getBoundingClientRect();
    const last = others[others.length - 1];
    if (y > box(last.name).bottom) return { kind: "line", parent: "", index: indexAmong("", null), y: box(last.name).bottom, depth: 0 };
    for (let i = 0; i < others.length; i++) {
      const d = others[i], r = box(d.name);
      if (y < r.top && i > 0) continue;
      if (y > r.bottom) continue;
      const h = r.bottom - r.top, edge = Math.min(14, h * 0.28);
      if (y < r.top + edge) return { kind: "line", parent: parentOf(d.name), index: indexAmong(parentOf(d.name), d.name), y: r.top, depth: d.depth };
      if (y > r.bottom - edge) {
        // Below an open deck with children: first inside it. Otherwise right after it.
        const next = others[i + 1];
        if (next && next.depth > d.depth) return { kind: "line", parent: d.name, index: 0, y: r.bottom, depth: d.depth + 1 };
        const sibs = childrenOf(all, parentOf(d.name)).filter((n) => n !== name);
        return { kind: "line", parent: parentOf(d.name), index: sibs.indexOf(d.name) + 1, y: r.bottom, depth: d.depth };
      }
      return { kind: "into", parent: d.name, index: undefined, y: r.top, depth: d.depth + 1 };
    }
    return null;
  };
  const isNoop = (name: string, drop: Drop) => {
    if (drop.parent !== parentOf(name)) return false;
    return drop.kind === "into" || drop.index === childrenOf(decks ?? [], drop.parent).indexOf(name);
  };
  const blocked = (name: string, drop: Drop) => drop.parent !== parentOf(name) && clashes(decks ?? [], name, drop.parent);

  const startDrag = (name: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY;
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    let drop: Drop | null = null, lastY = y0, lastX = e.clientX;
    const update = (y: number, x = lastX) => {
      lastY = y;
      lastX = x;
      drop = dropAt(name, y);
      // Hovering on a closed deck opens it after a moment, so you can drop deeper.
      if (drop?.kind === "into" && collapsed.has(drop.parent)) {
        if (expandTimer.current?.name !== drop.parent) expandTimer.current = { name: drop.parent, t: performance.now() };
        else if (performance.now() - expandTimer.current.t > 650) { toggle(drop.parent); expandTimer.current = null; }
      } else expandTimer.current = null;
      setDrag({ name, x, y, drop });
    };
    const move = (ev: PointerEvent) => update(ev.clientY, ev.clientX);
    // Near the top or bottom edge the page scrolls, so a deck can travel the whole list.
    const auto = setInterval(() => {
      const edge = 72, h = innerHeight;
      const v = lastY < edge ? -Math.ceil((edge - lastY) / 4) : lastY > h - edge ? Math.ceil((lastY - (h - edge)) / 4) : 0;
      if (v) { scrollBy(0, v); update(lastY); }
    }, 16);
    const end = () => {
      clearInterval(auto);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      document.body.style.userSelect = "";
      expandTimer.current = null;
      setDrag(null);
      if (drop && !isNoop(name, drop) && !blocked(name, drop)) place(name, drop.parent, drop.index);
      else if (drop && blocked(name, drop)) toast.error(`${drop.parent ? leafOf(drop.parent) : "The top level"} already has a deck called ${leafOf(name)}`);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    setDrag({ name, x: e.clientX, y: y0, drop: null });
  };
  const keyMove = (name: string, e: React.KeyboardEvent) => {
    const all = decks ?? [];
    const parent = parentOf(name);
    const sibs = childrenOf(all, parent);
    const i = sibs.indexOf(name);
    if (e.altKey && e.key === "ArrowLeft" && parent) {
      e.preventDefault();
      const gp = parentOf(parent);
      place(name, gp, childrenOf(all, gp).indexOf(parent) + 1, true);
    } else if (e.altKey && e.key === "ArrowRight" && i > 0) {
      e.preventDefault();
      place(name, sibs[i - 1], undefined, true);
    } else if (!e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = i + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= sibs.length) return;
      place(name, parent, to, true);
    }
  };
  const dragged = (n: string) => !!drag && (n === drag.name || n.startsWith(drag.name + "::"));
  const listTop = () => listRef.current?.getBoundingClientRect().top ?? 0;

  return (
    <Page>
      <PageHeader
        title="Decks"
        description={decks ? (due ? `${due} cards to study today` : "Nothing due right now") : "\u00a0"}
        actions={
          <>
            <ImportButton onDone={reload} />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus className="size-4" />New deck</Button>
          </>
        }
      />

      {decks && decks.length === 0 && (
        <EmptyState title="No decks yet" action={<Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus className="size-4" />New deck</Button>}>
          Import a pack or create a deck to start.
        </EmptyState>
      )}

      {visible.length > 0 && (
        <Section>
          <div ref={listRef} className="relative">
          <div className="hidden grid-cols-[1fr_4rem_repeat(3,3.5rem)_8.5rem] items-center gap-2 border-b px-5 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
            <span>Deck</span>
            <span className="text-right">Cards</span>
            <span className="text-right">New</span>
            <span className="text-right">Learn</span>
            <span className="text-right">Due</span>
            <span />
          </div>
          {visible.map((d, i) => {
            const name = d.name.split("::").pop()!;
            const work = d.new + d.learning + d.review;
            const soon = d.depth === 0 && d.deadline && new Date(d.deadline) > new Date();
            const watch = d.mode === "watch";
            const study = () => navigate(`/${watch ? "watch" : "study"}?deck=${encodeURIComponent(d.name)}${!watch && !work ? "&ahead=1" : ""}`);
            // A new top-level deck after a subtree gets a stronger rule, so groups read as groups.
            const groupStart = i > 0 && d.depth === 0;
            const lifted = dragged(d.name);
            const target = drag?.drop?.kind === "into" && drag.drop.parent === d.name && !isNoop(drag.name, drag.drop);
            const targetBlocked = target && blocked(drag!.name, drag!.drop!);
            return (
              <div
                key={d.id}
                ref={(el) => { if (el) rows.current.set(d.name, el); else rows.current.delete(d.name); }}
                className={cn(
                  "group relative flex min-h-14 items-stretch gap-2 pr-3 pl-0.5 hover:bg-accent/40 sm:grid sm:min-h-12 sm:grid-cols-[1fr_4rem_repeat(3,3.5rem)_8.5rem] sm:pr-5 sm:pl-1",
                  i > 0 && "border-t",
                  groupStart && "border-t-foreground/15",
                  !drag && "transition-colors",
                  lifted && "opacity-35",
                  target && !targetBlocked && "bg-highlight/10 ring-1 ring-highlight/60 ring-inset",
                  targetBlocked && "bg-destructive/10 ring-1 ring-destructive/50 ring-inset",
                )}
              >
                <div className="flex min-w-0 flex-1 items-stretch">
                  <TreeGuides depth={d.depth} />
                  <div className="flex shrink-0 items-center">
                    <button
                      data-grip
                      className={cn(
                        "flex h-10 w-6 touch-none items-center justify-center rounded-md hover:!text-foreground sm:h-8 sm:w-5",
                        drag?.name === d.name ? "cursor-grabbing text-foreground" : "cursor-grab text-muted-foreground/50 group-hover:text-muted-foreground",
                        (visible.length < 2 || (drag && drag.name !== d.name)) && "invisible",
                      )}
                      onPointerDown={(e) => startDrag(d.name, e)}
                      onKeyDown={(e) => keyMove(d.name, e)}
                      aria-label={`Move ${name}: drag it onto a deck or between rows. Arrow keys reorder, Alt+arrows change level.`}
                      title="Drag onto a deck to put it inside, or between rows to place it"
                    >
                      <GripVertical className="size-4" />
                    </button>
                    <button
                      className={cn("flex size-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground sm:size-8", !d.hasChildren && "invisible")}
                      onClick={() => toggle(d.name)}
                      aria-label={collapsed.has(d.name) ? `Expand ${name}` : `Collapse ${name}`}
                      aria-expanded={!collapsed.has(d.name)}
                    >
                      <ChevronRight className={cn("size-4 transition-transform", !collapsed.has(d.name) && "rotate-90")} />
                    </button>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-center py-2">
                    <button
                      className={cn("text-left text-[0.95rem] leading-snug hover:underline sm:truncate", d.depth === 0 ? "font-medium" : "text-foreground/90")}
                      onClick={() => navigate(`/deck?name=${encodeURIComponent(d.name)}`)}
                    >
                      {name}
                      {soon && <span className="ml-2 inline-flex items-center gap-1 align-middle text-xs font-normal text-highlight"><CalendarClock className="size-3.5" />{relative(d.deadline!)}</span>}
                    </button>
                    {/* Phone: counts on one line under the name instead of three narrow columns. */}
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular text-muted-foreground sm:hidden [&>span]:whitespace-nowrap">
                      {watch ? (
                        <span>{d.cards} card{d.cards === 1 ? "" : "s"} to watch</span>
                      ) : work ? (
                        <>
                          <span>{d.cards} card{d.cards === 1 ? "" : "s"}</span>
                          {d.new > 0 && <span className="text-new">{d.new} new</span>}
                          {d.learning > 0 && <span className="text-learn">{d.learning} learning</span>}
                          {d.review > 0 && <span className="text-review">{d.review} due</span>}
                        </>
                      ) : (
                        <span>{d.cards ? `${d.cards} card${d.cards === 1 ? "" : "s"} · nothing due` : "empty"}</span>
                      )}
                    </div>
                  </div>
                </div>
                <span className="hidden items-center justify-end tabular text-sm text-muted-foreground sm:flex" title={`${d.cards} card${d.cards === 1 ? "" : "s"} in this deck`}>{d.cards}</span>
                {watch ? (
                  <span className="hidden items-center justify-end text-xs text-muted-foreground sm:col-span-3 sm:flex">tour</span>
                ) : (
                  <>
                    <Count value={d.new} cls="text-new" />
                    <Count value={d.learning} cls="text-learn" />
                    <Count value={d.review} cls="text-review" />
                  </>
                )}
                <div className="flex shrink-0 items-center justify-end gap-0.5">
                  <RowMenu
                    name={d.name}
                    onMove={() => setMoving(d.name)}
                    onTop={d.depth > 0 && !clashes(decks ?? [], d.name, "") ? () => place(d.name, "", childrenOf(decks ?? [], "").indexOf(d.name.split("::")[0]) + 1) : undefined}
                    onUp={d.depth > 1 && !clashes(decks ?? [], d.name, parentOf(parentOf(d.name))) ? () => { const gp = parentOf(parentOf(d.name)); place(d.name, gp, childrenOf(decks ?? [], gp).indexOf(parentOf(d.name)) + 1); } : undefined}
                  />
                  <Button
                    size="sm"
                    variant={work || (watch && d.cards) ? "secondary" : "ghost"}
                    className="size-10 gap-1.5 self-center rounded-full px-0 sm:h-8 sm:w-auto sm:rounded-md sm:px-3"
                    disabled={!d.cards}
                    onClick={study}
                    title={!watch && !work && d.cards ? "Nothing due: practice ahead anyway" : undefined}
                    aria-label={`${watch ? "Watch" : work || !d.cards ? "Practice" : "Practice ahead"} ${name}`}
                  >
                    {watch ? (
                      <><Eye className="size-4 text-highlight sm:size-3.5 sm:text-current" /> <span className="hidden sm:inline">Watch</span></>
                    ) : (
                      work || !d.cards ? (
                      <><Play className={cn("size-4 sm:size-3.5", work && "fill-current text-highlight sm:fill-none sm:text-current")} /> <span className="hidden sm:inline">Practice</span></>
                    ) : (
                      <><FastForward className="size-4 sm:size-3.5" /> <span className="hidden sm:inline">Ahead</span></>
                    )
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
          {drag?.drop && !isNoop(drag.name, drag.drop) && (
            drag.drop.kind === "line" ? (
              <div
                aria-hidden
                className={cn("pointer-events-none absolute right-3 z-20 h-0.5 -translate-y-1/2 rounded-full", blocked(drag.name, drag.drop) ? "bg-destructive" : "bg-highlight")}
                style={{ top: drag.drop.y - listTop(), left: `calc(${0.25 + drag.drop.depth * 1.25}rem + 1.5rem)` }}
              >
                <span className={cn("absolute -top-[3px] -left-1.5 size-2 rounded-full border-2 bg-background", blocked(drag.name, drag.drop) ? "border-destructive" : "border-highlight")} />
              </div>
            ) : null
          )}
          </div>
        </Section>
      )}
      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 flex h-9 max-w-64 -translate-x-[17px] -translate-y-1/2 cursor-grabbing items-center gap-1.5 rounded-lg border bg-card pr-3 pl-2 text-sm font-medium shadow-xl ring-1 ring-highlight/40"
          style={{ left: drag.x, top: drag.y }}
        >
          <GripVertical className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{leafOf(drag.name)}</span>
        </div>
      )}
      {drag?.drop && !isNoop(drag.name, drag.drop) && (
        <div aria-live="polite" className={cn("pointer-events-none fixed bottom-[calc(var(--tabbar-h,0px)+1rem)] left-1/2 z-50 -translate-x-1/2 rounded-full border bg-card px-3.5 py-1.5 text-xs shadow-lg", blocked(drag.name, drag.drop) && "border-destructive/50 text-destructive")}>
          {blocked(drag.name, drag.drop)
            ? `${drag.drop.parent ? leafOf(drag.drop.parent) : "The top level"} already has a ${leafOf(drag.name)}`
            : drag.drop.parent === parentOf(drag.name)
              ? "Reorder"
              : drag.drop.parent
                ? <>Into <span className="font-medium">{leafOf(drag.drop.parent)}</span></>
                : "Out to the top level"}
        </div>
      )}
      <MoveDeckDialog deck={moving} decks={decks ?? []} onOpenChange={(o) => !o && setMoving(null)} onMoved={(n) => after(n)} />
      <UpdateBar />
      <NewDeckDialog open={creating} onOpenChange={setCreating} onDone={reload} />
    </Page>
  );
}

/** The ⋯ on a deck row: move it somewhere, or take it out a level. */
function RowMenu({ name, onMove, onTop, onUp }: { name: string; onMove(): void; onTop?: () => void; onUp?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-10 text-muted-foreground hover:text-foreground sm:size-8 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 sm:data-[state=open]:opacity-100" aria-label={`More for ${leafOf(name)}`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem className="h-10 sm:h-9" onClick={onMove}><FolderInput />Move to…</DropdownMenuItem>
        {onUp && <DropdownMenuItem className="h-10 sm:h-9" onClick={onUp}><ArrowUpLeft />Move up a level</DropdownMenuItem>}
        {onTop && <DropdownMenuItem className="h-10 sm:h-9" onClick={onTop}><ArrowUpToLine />Make it a deck of its own</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-10 sm:h-9" onClick={() => navigate(`/deck?name=${encodeURIComponent(name)}&rename=1`)}><Pencil />Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Desktop count column; muted when zero. */
function Count({ value, cls }: { value: number; cls: string }) {
  return <span className={cn("hidden items-center justify-end tabular text-sm sm:flex", value ? cls : "text-muted-foreground/40")}>{value}</span>;
}

/** Indentation for one nesting level per depth. */
export function TreeGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} aria-hidden className="w-4 shrink-0 sm:w-5" />
      ))}
    </>
  );
}

function NewDeckDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange(o: boolean): void; onDone(): void }) {
  const [name, setName] = useState("");
  const create = async () => {
    if (!name.trim()) return;
    try {
      await api.createDeck(name.trim());
      onOpenChange(false);
      setName("");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New deck</DialogTitle>
          <DialogDescription>Use :: for subdecks, like Course::Week 1.</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Deck name" aria-label="Deck name" />
        <DialogFooter>
          <Button onClick={create} disabled={!name.trim()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportButton({ onDone }: { onDone(): void }) {
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.apkg,.colpkg,application/json";
    input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try {
          if (/\.(apkg|colpkg)$/i.test(f.name)) {
            const r = await api.importAnki(f);
            const media = r.media.files ? ` · ${r.media.files} media` : "";
            const skipped = r.skipped.length ? ` · ${r.skipped.length} skipped` : "";
            toast.success(`Imported ${f.name}`, { description: `${r.items.created} new, ${r.items.updated} updated, ${r.items.unchanged} unchanged · ${r.cards} cards · ${r.reviews} reviews${media}${skipped}` });
          } else {
            const r = await api.importPack(JSON.parse(await f.text()));
            toast.success(`Imported ${f.name}`, { description: `${r.items.created} new, ${r.items.updated} updated, ${r.items.unchanged} unchanged` });
          }
        } catch (e) {
          toast.error(`Couldn't import ${f.name}`, { description: (e as Error).message.slice(0, 400) });
        }
      }
      onDone();
    };
    input.click();
  };
  return (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={pick}><Upload className="size-4" />Import</Button>
  );
}
