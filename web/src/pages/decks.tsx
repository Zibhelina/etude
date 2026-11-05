import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpLeft, ArrowUpToLine, BarChart3, CalendarClock, ChevronRight, FastForward, FolderInput, GripVertical, Pencil, Play, Plus, Search, SlidersHorizontal, Smile, Upload, X, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, relative, type DeckNode, type Stats } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { EmptyState, Page } from "@/components/page";
import { childrenOf, clashes, leafOf, moveDeck, MoveDeckDialog, parentOf } from "@/components/move-deck";
import { usePhone } from "@/lib/phone";
import { PhoneDecks } from "@/components/phone-decks";
import { DeckContextMenu, type DeckMenuEntry, useDeckActions } from "@/components/deck-actions";
import { Mark } from "@/components/phone-shell";
import { ChangeIconDialog, DeckIcon } from "@/components/deck-icon";
import { DonePanel, SessionCard, StreakCelebration, useMilestone } from "@/components/library-session";
import { ArchivePage } from "@/pages/archive";
import { ArchiveLink, useArchiveCount } from "@/components/archive-link";

/** Where a dragged deck would land: between rows (`line`) or inside a deck (`into`). */
type Drop = { kind: "line" | "into"; parent: string; index: number | undefined; y: number; depth: number };

const enc = encodeURIComponent;
const work = (d: DeckNode) => d.new + d.learning + d.review;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const ROW_INDENT = 20;

function ancestorsOf(name: string) {
  const parts = name.split("::");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("::"));
}

export function DecksPage({ archived = false }: { archived?: boolean }) {
  const phone = usePhone();
  if (archived) return <ArchivePage />;
  return phone ? <PhoneDecks /> : <DesktopDecks />;
}

/** The decks and today's numbers, reloaded when the window comes back into focus. */
export function useLibrary() {
  const [decks, setDecks] = useState<DeckNode[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const reload = () =>
    Promise.all([
      api.decks().then((all) => setDecks(all.filter((d) => !d.archived))),
      api.stats({}, 14).then(setStats).catch(() => {}),
    ]).catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return { decks, stats, reload };
}

/** The date over the title, like "Thursday, Nov 5". */
export const todayKicker = () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

/** New, learning and due as marks with numbers, then a quiet note (subdecks, cards, or nothing due). */
export function DeckCounts({ d, note, className }: { d: DeckNode; note?: string; className?: string }) {
  const watch = d.mode === "watch";
  const items = watch
    ? []
    : [
        { v: d.new, kind: "new" as const, cls: "text-new", label: "new" },
        { v: d.learning, kind: "learn" as const, cls: "text-learn", label: "learning" },
        { v: d.review, kind: "due" as const, cls: "text-review", label: "due" },
      ].filter((i) => i.v);
  const lead = watch ? `tour · ${plural(d.cards, "card")}` : !items.length ? (d.cards ? "Nothing due" : "Empty") : null;
  return (
    <span className={cn("flex min-w-0 items-center gap-x-3 overflow-hidden text-[13px] whitespace-nowrap text-muted-foreground tabular", className)}>
      {items.map((i) => (
        <span key={i.kind} className={cn("inline-flex items-center gap-1 font-semibold", i.cls)} aria-label={`${i.v} ${i.label}`}>
          <Mark kind={i.kind} />
          {i.v.toLocaleString()}
        </span>
      ))}
      {lead && <span>{lead}</span>}
      {note && <span className="inline-flex min-w-0 items-center gap-3 truncate"><span aria-hidden className="text-muted-foreground/50">·</span>{note}</span>}
    </span>
  );
}

function DesktopDecks() {
  const archived = useArchiveCount();
  const { decks, stats, reload } = useLibrary();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("etude.collapsed") ?? "[]")));
  const [creating, setCreating] = useState(false);
  const [iconFor, setIconFor] = useState<DeckNode | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const deckActions = useDeckActions(reload);

  const toggle = (name: string) => {
    const next = new Set(collapsed);
    next.has(name) ? next.delete(name) : next.add(name);
    setCollapsed(next);
    localStorage.setItem("etude.collapsed", JSON.stringify([...next]));
  };

  const withDepth = useMemo(() => {
    if (!decks) return [];
    const names = new Set(decks.map((d) => d.name));
    return decks.map((d) => ({ ...d, displayDepth: ancestorsOf(d.name).filter((n) => names.has(n)).length }));
  }, [decks]);

  const q = query?.trim().toLowerCase() ?? "";
  const visible = useMemo(() => {
    const names = new Set(withDepth.map((d) => d.name));
    const kids = new Map<string, number>();
    for (const d of withDepth) {
      const parent = ancestorsOf(d.name).findLast((n) => names.has(n));
      if (parent) kids.set(parent, (kids.get(parent) ?? 0) + 1);
    }
    // A search shows the matching decks with the decks they sit in, whatever is folded.
    const keep = q ? new Set(withDepth.filter((d) => leafOf(d.name).toLowerCase().includes(q)).flatMap((d) => [d.name, ...ancestorsOf(d.name)])) : null;
    return withDepth
      .filter((d) => (keep ? keep.has(d.name) : !ancestorsOf(d.name).some((n) => names.has(n) && collapsed.has(n))))
      .map((d) => ({ ...d, kids: kids.get(d.name) ?? 0, hasChildren: (kids.get(d.name) ?? 0) > 0 }));
  }, [withDepth, collapsed, q]);

  const top = withDepth.filter((d) => d.displayDepth === 0);
  const due = top.filter((d) => d.mode !== "watch").reduce((a, d) => a + work(d), 0);
  const totalCards = top.reduce((a, d) => a + d.cards, 0);
  const allDone = !!decks && decks.length > 0 && due === 0 && totalCards > 0;
  const milestone = useMilestone(stats, allDone);

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
  const all = decks ?? [];

  const after = (focus?: string) => {
    reload().then(() => focus && requestAnimationFrame(() => rows.current.get(focus)?.querySelector<HTMLElement>("[data-grip]")?.focus()));
  };
  const place = async (name: string, parent: string, index: number | undefined, focus = false) => {
    // Opening the new parent so the moved deck stays in sight.
    if (parent && collapsed.has(parent)) toggle(parent);
    await moveDeck(all, name, parent, index, (n) => after(focus ? n : undefined));
  };

  /** Where a drop at y would put `name`, or null for "nowhere new". */
  const dropAt = (name: string, y: number): Drop | null => {
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
    return drop.kind === "into" || drop.index === childrenOf(all, drop.parent).indexOf(name);
  };
  const blocked = (name: string, drop: Drop) => drop.parent !== parentOf(name) && clashes(all, name, drop.parent);

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

  // Tree elbows: a trunk hangs from each open deck's chevron, and every subdeck joins it with a rounded elbow
  // that ends at its own chevron (or at its name when it has no subdecks). One SVG path over the list.
  const [elbows, setElbows] = useState("");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const base = list.getBoundingClientRect();
      const R = 7;
      let path = "";
      const at = (name: string) => rows.current.get(name);
      for (const d of visible) {
        if (!d.hasChildren || (!q && collapsed.has(d.name))) continue;
        const chev = at(d.name)?.querySelector<SVGElement>("button[aria-expanded] svg")?.getBoundingClientRect();
        if (!chev) continue;
        const kids = visible.filter((k) => k.name.lastIndexOf("::") === d.name.length && k.name.startsWith(d.name + "::"));
        if (!kids.length) continue;
        const x = Math.round(chev.left + chev.width / 2 - base.left) + 0.5;
        const top = chev.bottom - base.top + 2;
        let lastMid = top;
        for (const k of kids) {
          const row = at(k.name);
          if (!row) continue;
          const r = row.getBoundingClientRect();
          // Subdecks join at their chevron; leaves at the middle of their name, not between name and counts.
          const own = k.hasChildren ? row.querySelector<SVGElement>("button[aria-expanded] svg")?.getBoundingClientRect() : null;
          const nm = row.querySelector<HTMLElement>("[data-deck-name]")?.getBoundingClientRect();
          const target = own ?? nm ?? r;
          const mid = Math.round(target.top + target.height / 2 - base.top) + 0.5;
          const end = (own ? own.left - 1 : (nm?.left ?? r.left) - 6) - base.left;
          path += `M${x} ${mid - R}Q${x} ${mid} ${x + R} ${mid}H${Math.round(end)}`;
          lastMid = mid;
        }
        if (lastMid - R > top) path += `M${x} ${top}V${lastMid - R}`;
      }
      setElbows(path);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [visible, collapsed, q]);
  const anyIcon = top.some((d) => d.icon);

  const menuFor = (d: DeckNode): DeckMenuEntry[] => [
    { icon: <Pencil />, label: "Rename", onSelect: () => navigate(`/deck?name=${enc(d.name)}&rename=1`) },
    { icon: <Smile />, label: "Change icon…", onSelect: () => setIconFor(d) },
    { icon: <SlidersHorizontal />, label: "Options", onSelect: () => navigate(`/deck?name=${enc(d.name)}&tab=options`) },
    { icon: <BarChart3 />, label: "Stats", onSelect: () => navigate(`/stats?deck=${enc(d.name)}`) },
    { icon: <FolderInput />, label: "Move to…", onSelect: () => setMoving(d.name) },
    ...(d.depth > 1 && !clashes(all, d.name, parentOf(parentOf(d.name)))
      ? [{ icon: <ArrowUpLeft />, label: "Move up a level", onSelect: () => { const gp = parentOf(parentOf(d.name)); place(d.name, gp, childrenOf(all, gp).indexOf(parentOf(d.name)) + 1); } }]
      : []),
    ...(d.depth > 0 && !clashes(all, d.name, "") ? [{ icon: <ArrowUpToLine />, label: "Make it a deck of its own", onSelect: () => place(d.name, "", childrenOf(all, "").indexOf(d.name.split("::")[0]) + 1) }] : []),
  ];

  return (
    <Page className="max-w-[52rem]">
      <LibraryHeader onImport={reload} onNew={() => setCreating(true)} query={query} setQuery={setQuery} hasDecks={!!decks?.length} />

      {decks && decks.length === 0 && (
        <EmptyState title="No decks yet" action={<><ImportButton onDone={reload} /><Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus className="size-4" />New deck</Button></>}>
          Import a pack or create a deck to start.
        </EmptyState>
      )}
      {!decks && <div className="h-56 animate-pulse rounded-2xl bg-muted/60" />}

      {decks && decks.length > 0 && !q && <div className="@container">{allDone ? <DonePanel decks={decks} stats={stats} /> : due > 0 ? <SessionCard decks={decks} stats={stats} /> : null}</div>}

      {visible.length > 0 && (
        <section className="mt-10" aria-label="Decks">
          <div className="mb-2 flex items-baseline justify-between px-1">
            <span className="score-kicker font-semibold">Decks</span>
            <span className="text-[13px] text-muted-foreground tabular">{plural(top.length, "deck")} · {plural(totalCards, "card")}</span>
          </div>
          <div ref={listRef} className="relative">
            {!drag && elbows && (
              <svg aria-hidden className="lib-elbows pointer-events-none absolute inset-0 z-[1] size-full overflow-visible"><path d={elbows} fill="none" strokeWidth="1.5" strokeLinecap="round" /></svg>
            )}
            {visible.map((d) => {
              const name = leafOf(d.name);
              const w = work(d);
              const soon = d.displayDepth === 0 && d.deadline && new Date(d.deadline) > new Date();
              const watch = d.mode === "watch";
              const sub = d.displayDepth > 0;
              const lifted = dragged(d.name);
              const target = drag?.drop?.kind === "into" && drag.drop.parent === d.name && !isNoop(drag.name, drag.drop);
              const targetBlocked = target && blocked(drag!.name, drag!.drop!);
              const open = d.hasChildren && (q ? true : !collapsed.has(d.name));
              const study = () => navigate(watch ? `/watch?deck=${enc(d.name)}` : `/study?deck=${enc(d.name)}${w ? "" : "&ahead=1"}`);
              const note = d.kids ? plural(d.kids, "subdeck") : sub ? plural(d.cards, "card") : undefined;
              const menu = { name: d.name, archived: false, disabled: deckActions.busy, onArchive: () => deckActions.archive(d.name, true), onDelete: () => deckActions.requestDelete(d.name), extra: menuFor(d) };
              return (
                <DeckContextMenu key={d.id} {...menu}>
                  <div
                    ref={(el) => { if (el) rows.current.set(d.name, el); else rows.current.delete(d.name); }}
                    data-deck={d.name}
                    className={cn(
                      "lib-row group relative flex cursor-pointer items-center gap-3 rounded-xl py-2 pr-2.5 select-none",
                      sub ? "min-h-[3.4rem]" : "min-h-[4.25rem]",
                      !drag && "transition-colors",
                      lifted && "opacity-35",
                      target && !targetBlocked && "bg-primary/10 ring-[1.5px] ring-primary ring-inset",
                      targetBlocked && "bg-destructive/10 ring-1 ring-destructive/50 ring-inset",
                    )}
                    style={{ paddingLeft: 2 + d.displayDepth * (anyIcon ? ROW_INDENT : 14) }}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest("button,[role=menuitem]")) navigate(`/deck?name=${enc(d.name)}`); }}
                  >
                    <button
                      data-grip
                      className={cn(
                        "lib-grip -mr-2 flex h-10 w-[22px] shrink-0 touch-none items-center justify-center rounded-md hover:!text-foreground",
                        drag?.name === d.name ? "cursor-grabbing text-foreground" : "cursor-grab text-muted-foreground/60",
                        (visible.length < 2 || (drag && drag.name !== d.name)) && "invisible",
                      )}
                      onPointerDown={(e) => startDrag(d.name, e)}
                      onKeyDown={(e) => keyMove(d.name, e)}
                      aria-label={`Move ${name}: drag it onto a deck or between rows. Arrow keys reorder, Alt+arrows change level.`}
                      title="Drag onto a deck to put it inside, or between rows to place it"
                    >
                      <GripVertical className="size-4" />
                    </button>
                    {(
                      <button
                        className={cn("-mr-0.5 flex h-[30px] w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground", !d.hasChildren && "invisible")}
                        onClick={() => toggle(d.name)}
                        aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
                        aria-expanded={open}
                      >
                        <ChevronRight className={cn("size-4 transition-transform duration-200", open && "rotate-90")} />
                      </button>
                    )}
                    {!sub && d.icon && <DeckIcon icon={d.icon} size={46} className="lib-art" />}
                    <div className="min-w-0 flex-1">
                      <button
                        data-deck-name
                        className={cn("block max-w-full truncate text-left hover:underline", sub ? "text-[15px] font-medium" : "text-[15.5px] font-semibold")}
                        onClick={() => navigate(`/deck?name=${enc(d.name)}`)}
                      >
                        {q || d.displayDepth === 0 ? (d.displayDepth === 0 ? d.name : name) : name}
                      </button>
                      <div className="mt-[3px] flex items-center gap-3">
                        <DeckCounts d={d} note={note} />
                        {soon && <span className="inline-flex shrink-0 items-center gap-1 text-xs text-highlight"><CalendarClock className="size-3.5" />{relative(d.deadline!)}</span>}
                      </div>
                    </div>
                    <button
                      className={cn("lib-play flex size-[38px] shrink-0 items-center justify-center rounded-full transition-[transform,background-color,color] active:scale-90 disabled:opacity-40", !w && !(watch && d.cards) && "dim")}
                      disabled={!d.cards}
                      onClick={study}
                      title={!watch && !w && d.cards ? "Nothing due: practice ahead anyway" : undefined}
                      aria-label={`${watch ? "Watch" : w || !d.cards ? "Practice" : "Practice ahead"} ${name}`}
                    >
                      {watch ? <Eye className="size-4" /> : w || !d.cards ? <Play className="size-3.5 translate-x-px fill-current" /> : <FastForward className="size-4" />}
                    </button>
                  </div>
                </DeckContextMenu>
              );
            })}
            {drag?.drop && !isNoop(drag.name, drag.drop) && drag.drop.kind === "line" && (
              <div
                aria-hidden
                className={cn("pointer-events-none absolute right-3 z-20 h-0.5 -translate-y-1/2 rounded-full", blocked(drag.name, drag.drop) ? "bg-destructive" : "bg-primary")}
                style={{ top: drag.drop.y - listTop(), left: 2 + drag.drop.depth * (anyIcon ? ROW_INDENT : 14) + 24 }}
              >
                <span className={cn("absolute -top-[3px] -left-1.5 size-2 rounded-full border-2 bg-background", blocked(drag.name, drag.drop) ? "border-destructive" : "border-primary")} />
              </div>
            )}
          </div>
          {q && visible.length === 0 && <p className="px-1 py-8 text-center text-sm text-muted-foreground">No deck matches “{query}”.</p>}
          <ArchiveLink count={archived} className="mt-6" />
        </section>
      )}
      {q && decks && visible.length === 0 && <p className="mt-10 text-center text-sm text-muted-foreground">No deck matches “{query}”.</p>}
      {deckActions.deleteDialog}
      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 flex h-9 max-w-64 -translate-x-[17px] -translate-y-1/2 cursor-grabbing items-center gap-1.5 rounded-lg border bg-card pr-3 pl-2 text-sm font-medium shadow-xl"
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
      <MoveDeckDialog deck={moving} decks={all} onOpenChange={(o) => !o && setMoving(null)} onMoved={(n) => after(n)} />
      <NewDeckDialog open={creating} onOpenChange={setCreating} onDone={reload} />
      <ChangeIconDialog deck={iconFor?.name ?? null} icon={iconFor?.icon ?? null} open={!!iconFor} onOpenChange={(o) => !o && setIconFor(null)} onSaved={() => reload()} />
      {milestone.show && stats && <StreakCelebration stats={stats} onClose={milestone.close} />}
    </Page>
  );
}

/** Date, title, and the page's actions: search the decks, import, new deck. */
function LibraryHeader({ onImport, onNew, query, setQuery, hasDecks }: { onImport(): void; onNew(): void; query: string | null; setQuery(q: string | null): void; hasDecks: boolean }) {
  const pick = useImportPicker(onImport);
  return (
    <header className="mb-7 flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1">
        <div className="score-kicker font-semibold">{todayKicker()}</div>
        <h1 className="lib-title mt-1.5 text-[2rem] leading-[1.1] font-semibold">Library</h1>
      </div>
      <div className="flex items-center gap-2">
        {query !== null ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
              placeholder="Find a deck"
              aria-label="Find a deck"
              className="h-10 w-52 rounded-xl pr-8 pl-8"
            />
            <button className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground" onClick={() => setQuery(null)} aria-label="Close search"><X className="size-4" /></button>
          </div>
        ) : (
          hasDecks && <button className="flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setQuery("")} aria-label="Find a deck" title="Find a deck"><Search className="size-[18px]" /></button>
        )}
        <button onClick={pick} className="lib-quiet inline-flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold"><Upload className="size-4" />Import</button>
        <button onClick={onNew} className="lib-quiet inline-flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold"><Plus className="size-4" />New deck</button>
      </div>
    </header>
  );
}

export function NewDeckDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange(o: boolean): void; onDone(): void }) {
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
          <DialogDescription>Use :: for subdecks, like Course::Week 1. You can pick an icon for it from its menu afterwards.</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Deck name" aria-label="Deck name" />
        <DialogFooter>
          <Button onClick={create} disabled={!name.trim()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportButton({ onDone, phone }: { onDone(): void; phone?: boolean }) {
  const pick = useImportPicker(onDone);
  if (phone)
    return (
      <button onClick={pick} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border bg-card text-[15px] active:bg-accent"><Upload className="size-4" />Import a file</button>
    );
  return (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={pick}><Upload className="size-4" />Import</Button>
  );
}

/** Opens a file picker and imports every pack or Anki file chosen, with a toast per file. */
export function useImportPicker(onDone: () => void) {
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
            const assets = r.assets?.created + r.assets?.updated ? ` · ${r.assets.created + r.assets.updated} asset files` : "";
            toast.success(`Imported ${f.name}`, { description: `${r.items.created} new, ${r.items.updated} updated, ${r.items.unchanged} unchanged${assets}` });
          }
        } catch (e) {
          toast.error(`Couldn't import ${f.name}`, { description: (e as Error).message.slice(0, 400) });
        }
      }
      onDone();
    };
    input.click();
  };
  return pick;
}
