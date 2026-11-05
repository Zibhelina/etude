// The Library on a phone. One level at a time instead of an indented tree: the top level here, a deck's
// subdecks on its own page. Today's session leads; every row is one tap to open and a press-and-hold
// for everything else. Edit shows the handles to reorder and each deck's ⋯ menu.
import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpLeft, ArrowUpToLine, BarChart3, ChevronRight, Eye, FastForward, FolderInput, FolderPlus, GripVertical, Pencil, Play, Plus, Search, Smile, Trash2, Upload, X } from "lucide-react";
import { relative, type DeckNode } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useLongPress } from "@/lib/phone";
import { childrenOf, clashes, leafOf, moveDeck, MoveDeckDialog, parentOf } from "@/components/move-deck";
import { ActionSheet, PhoneIconButton, PhoneTitle, type SheetAction } from "@/components/phone-shell";
import { DeckCounts, NewDeckDialog, todayKicker, useImportPicker, useLibrary } from "@/pages/decks";
import { DeckMenu, type DeckMenuEntry, useDeckActions } from "@/components/deck-actions";
import { ArchiveLink, useArchiveCount } from "@/components/archive-link";
import { ChangeIconDialog, DeckIcon } from "@/components/deck-icon";
import { DonePanel, SessionCard, StreakCelebration, useMilestone } from "@/components/library-session";

const enc = encodeURIComponent;
const work = (d: DeckNode) => d.new + d.learning + d.review;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export function practiceUrl(d: DeckNode) {
  if (d.mode === "watch") return `/watch?deck=${enc(d.name)}`;
  return `/study?deck=${enc(d.name)}${work(d) ? "" : "&ahead=1"}`;
}

export function PhoneDecks() {
  const { decks, stats, reload } = useLibrary();
  const archivedCount = useArchiveCount();
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const pickFile = useImportPicker(reload);

  const all = decks ?? [];
  const names = new Set(all.map((d) => d.name));
  const top = all.filter((d) => !names.has(parentOf(d.name)));
  const due = top.filter((d) => d.mode !== "watch").reduce((a, d) => a + work(d), 0);
  const cards = top.reduce((a, d) => a + d.cards, 0);
  const allDone = !!decks && decks.length > 0 && due === 0 && cards > 0;
  const milestone = useMilestone(stats, allDone);
  const q = query?.trim().toLowerCase() ?? "";
  const found = q ? all.filter((d) => leafOf(d.name).toLowerCase().includes(q)) : [];

  return (
    <div className="pb-4">
      <PhoneTitle
        kicker={todayKicker()}
        title="Library"
        className="lib-phone-title pb-4"
        actions={
          <>
            {all.length > 0 && <PhoneIconButton label="Find a deck" onClick={() => setQuery(query === null ? "" : null)}>{query === null ? <Search /> : <X />}</PhoneIconButton>}
            <PhoneIconButton label="New deck or import" onClick={() => setAdding(true)}><Plus /></PhoneIconButton>
          </>
        }
      />

      {query !== null && (
        <div className="mx-5 mb-4">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a deck"
            aria-label="Find a deck"
            className="h-11 w-full rounded-xl border bg-card px-4 text-[16px] outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {!q && decks && top.length > 0 && (
        <div className="mx-5">{allDone ? <DonePanel decks={all} stats={stats} phone /> : due > 0 ? <SessionCard decks={all} stats={stats} phone /> : null}</div>
      )}

      {decks && decks.length === 0 && (
        <div className="mx-5 mt-4 rounded-3xl border border-dashed px-6 py-12 text-center">
          <div className="lib-title text-2xl font-semibold">Nothing here yet.</div>
          <p className="mx-auto mt-2 max-w-64 text-[14px] text-muted-foreground">Make a deck, or bring in a pack or an Anki file.</p>
          <div className="mt-6 flex flex-col gap-2">
            <button onClick={() => setCreating(true)} className="lib-primary h-12 rounded-xl text-[15px] font-semibold">New deck</button>
            <button onClick={pickFile} className="h-12 rounded-xl border bg-card text-[15px]">Import a file</button>
          </div>
        </div>
      )}

      {!decks && <div className="mx-5 mt-2 h-44 animate-pulse rounded-2xl bg-muted/50" />}

      {q ? (
        <section className="mt-2">
          {found.length ? found.map((d) => <DeckRow key={d.id} d={d} decks={all} crumb onHold={() => navigate(`/deck?name=${enc(d.name)}`)} />) : <p className="px-5 py-8 text-center text-[14px] text-muted-foreground">No deck matches “{query}”.</p>}
        </section>
      ) : (
        top.length > 0 && <DeckList decks={all} parent="" label="Decks" aside={`${top.length} · ${plural(cards, "card")}`} onChanged={reload} />
      )}
      {!q && decks && decks.length > 0 && (
        <div className="mx-5 mt-5"><ArchiveLink count={archivedCount} /></div>
      )}

      <ActionSheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Add"
        groups={[[
          { label: "New deck", icon: FolderPlus, onClick: () => setCreating(true) },
          { label: "Import a file", icon: Upload, hint: ".json · .apkg", onClick: pickFile },
        ]]}
      />
      <NewDeckDialog open={creating} onOpenChange={setCreating} onDone={reload} />
      {milestone.show && stats && <StreakCelebration stats={stats} onClose={milestone.close} />}
    </div>
  );
}

/**
 * The children of `parent`, one level. Rows open the deck; hold for the actions sheet. Edit shows a
 * handle to drag them into a new order and each deck's ⋯ menu.
 * Used here for the top level and by the deck page for subdecks.
 */
export function DeckList({ decks, parent, label, aside, onChanged }: { decks: DeckNode[]; parent: string; label?: string; aside?: string; onChanged(): void }) {
  const [sheet, setSheet] = useState<DeckNode | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<DeckNode | null>(null);
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<{ name: string; dy: number; to: number } | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const deckActions = useDeckActions(onChanged);
  const names = new Set(decks.map((d) => d.name));
  const kids = parent ? decks.filter((d) => parentOf(d.name) === parent) : decks.filter((d) => !names.has(parentOf(d.name)));
  useEffect(() => { if (!kids.length) setEditing(false); }, [kids.length]);
  if (!kids.length) return null;
  const place = (name: string, to: string, index: number | undefined) => moveDeck(decks, name, to, index, () => onChanged());

  const extra = (d: DeckNode): DeckMenuEntry[] => [
    { icon: <Pencil />, label: "Rename", onSelect: () => navigate(`/deck?name=${enc(d.name)}&rename=1`) },
    { icon: <Smile />, label: "Change icon…", onSelect: () => setIconFor(d) },
    { icon: <FolderInput />, label: "Move to…", onSelect: () => setMoving(d.name) },
  ];
  const actions = (d: DeckNode): SheetAction[][] => {
    const sibs = childrenOf(decks, parentOf(d.name));
    const i = sibs.indexOf(d.name);
    const w = work(d);
    const watch = d.mode === "watch";
    const first: SheetAction[] = watch
      ? [{ label: "Watch the tour", icon: Eye, onClick: () => navigate(practiceUrl(d)), disabled: !d.cards }]
      : [
          w ? { label: "Practice", icon: Play, hint: `${w}`, onClick: () => navigate(practiceUrl(d)) } : null,
          { label: "Practice ahead", icon: FastForward, onClick: () => navigate(`/study?deck=${enc(d.name)}&ahead=1`), disabled: !d.cards },
        ].filter(Boolean) as SheetAction[];
    const gp = parentOf(parentOf(d.name));
    return [
      first,
      [
        { label: "Rename", icon: Pencil, onClick: () => navigate(`/deck?name=${enc(d.name)}&rename=1`) },
        { label: "Change icon", icon: Smile, onClick: () => setIconFor(d) },
        { label: "Stats", icon: BarChart3, onClick: () => navigate(`/stats?deck=${enc(d.name)}`) },
        { label: "Move to…", icon: FolderInput, onClick: () => setMoving(d.name) },
        ...(i > 0 ? [{ label: "Move up", icon: ArrowUp, onClick: () => place(d.name, parentOf(d.name), i - 1) }] : []),
        ...(i < sibs.length - 1 ? [{ label: "Move down", icon: ArrowDown, onClick: () => place(d.name, parentOf(d.name), i + 1) }] : []),
        ...(d.depth > 1 && !clashes(decks, d.name, gp) ? [{ label: "Out one level", icon: ArrowUpLeft, onClick: () => place(d.name, gp, childrenOf(decks, gp).indexOf(parentOf(d.name)) + 1) }] : []),
        ...(d.depth > 0 && !clashes(decks, d.name, "") ? [{ label: "Make it a deck of its own", icon: ArrowUpToLine, onClick: () => place(d.name, "", childrenOf(decks, "").indexOf(d.name.split("::")[0]) + 1) }] : []),
      ],
      [
        d.archived
          ? { label: "Restore", icon: ArchiveRestore, onClick: () => { void deckActions.archive(d.name, false); }, disabled: deckActions.busy }
          : { label: "Archive", icon: Archive, onClick: () => { void deckActions.archive(d.name, true); }, disabled: deckActions.busy },
        { label: "Delete…", icon: Trash2, tone: "danger", onClick: () => { void deckActions.requestDelete(d.name); }, disabled: deckActions.busy },
      ],
    ];
  };

  // Edit: drag a row by its handle; the others make room, and letting go puts it there (with Undo).
  const startDrag = (name: string, e: React.PointerEvent) => {
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const from = kids.findIndex((d) => d.name === name);
    const mids = kids.map((d) => { const r = rows.current.get(d.name)!.getBoundingClientRect(); return r.top + r.height / 2; });
    const h = rows.current.get(name)!.getBoundingClientRect().height;
    let to = from;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      const y = mids[from] + dy;
      to = mids.filter((m, i) => i !== from && m < y).length;
      setDrag({ name, dy, to });
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      setDrag(null);
      if (to !== from) place(name, parent, to);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    setDrag({ name, dy: 0, to: from });
    void h;
  };
  const shift = (i: number) => {
    if (!drag) return 0;
    const from = kids.findIndex((d) => d.name === drag.name);
    const h = rows.current.get(drag.name)?.getBoundingClientRect().height ?? 64;
    if (i === from) return drag.dy;
    if (from < drag.to && i > from && i <= drag.to) return -h;
    if (from > drag.to && i < from && i >= drag.to) return h;
    return 0;
  };
  const anyIcon = kids.some((d) => d.icon);

  return (
    <section className="mt-8">
      {label && (
        <div className="flex items-baseline justify-between gap-3 px-5 pb-1">
          <span className="score-kicker font-semibold">{label}</span>
          <span className="flex items-baseline gap-3">
            {aside && <span className="text-[13px] text-muted-foreground tabular">{aside}</span>}
            <button onClick={() => setEditing(!editing)} className="-my-2 h-9 px-1 text-[15px] font-semibold text-primary" aria-pressed={editing}>{editing ? "Done" : "Edit"}</button>
          </span>
        </div>
      )}
      <div className={cn("px-3", editing && "lib-coarse")}>
        {kids.map((d, i) => (
          <div
            key={d.id}
            ref={(el) => { if (el) rows.current.set(d.name, el); else rows.current.delete(d.name); }}
            className={cn("relative", drag && drag.name === d.name ? "z-10" : drag && "transition-transform duration-150")}
            style={drag ? { transform: `translateY(${shift(i)}px)` } : undefined}
          >
            <DeckRow
              d={d}
              decks={decks}
              first={i === 0}
              iconGap={anyIcon}
              lifted={drag?.name === d.name}
              editing={editing}
              onHold={() => { swallowNextClick(); setSheet(d); }}
              grip={editing && kids.length > 1 ? (
                <button
                  className="flex h-12 w-9 shrink-0 touch-none items-center justify-center text-muted-foreground"
                  onPointerDown={(e) => startDrag(d.name, e)}
                  aria-label={`Move ${leafOf(d.name)}: drag up or down`}
                >
                  <GripVertical className="size-5" />
                </button>
              ) : null}
              menu={editing ? <DeckMenu name={d.name} archived={d.archived} disabled={deckActions.busy} onArchive={() => deckActions.archive(d.name, !d.archived)} onDelete={() => deckActions.requestDelete(d.name)} extra={extra(d)} /> : null}
            />
          </div>
        ))}
      </div>
      <ActionSheet
        open={!!sheet}
        onClose={() => setSheet(null)}
        title={sheet ? leafOf(sheet.name) : ""}
        description={sheet ? summary(sheet) : ""}
        groups={sheet ? actions(sheet) : []}
      />
      <MoveDeckDialog deck={moving} decks={decks} onOpenChange={(o) => !o && setMoving(null)} onMoved={() => onChanged()} />
      <ChangeIconDialog deck={iconFor?.name ?? null} icon={iconFor?.icon ?? null} open={!!iconFor} onOpenChange={(o) => !o && setIconFor(null)} onSaved={() => onChanged()} />
      {deckActions.deleteDialog}
    </section>
  );
}

/** The finger that held a row lifts over the sheet that just opened; that lift isn't a tap on it. */
function swallowNextClick() {
  const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 700);
}

function summary(d: DeckNode) {
  if (d.mode === "watch") return `${plural(d.cards, "card")} · a tour`;
  const w = work(d);
  return `${plural(d.cards, "card")}${w ? ` · ${w} to practice` : d.nextDue ? ` · next ${relative(d.nextDue)}` : ""}`;
}

function DeckRow({ d, decks, onHold, menu, grip, first, iconGap, lifted, editing, crumb }: {
  d: DeckNode;
  decks: DeckNode[];
  onHold(): void;
  menu?: React.ReactNode;
  grip?: React.ReactNode;
  first?: boolean;
  iconGap?: boolean;
  lifted?: boolean;
  editing?: boolean;
  /** Search results: show the deck it sits in. */
  crumb?: boolean;
}) {
  const { handlers, held } = useLongPress(onHold);
  const subs = childrenOf(decks, d.name).length;
  const w = work(d);
  const watch = d.mode === "watch";
  const soon = d.deadline && new Date(d.deadline) > new Date();
  const icon = d.icon && (d.depth === 0 || crumb);
  return (
    <div
      className={cn("relative flex min-h-[4.5rem] items-center gap-3.5 rounded-xl px-2 select-none [-webkit-touch-callout:none] active:bg-accent/60", lifted && "bg-card shadow-lg ring-1 ring-border", crumb && "mx-3")}
      {...(editing ? {} : handlers)}
    >
      {!first && !lifted && <span aria-hidden className="absolute top-0 right-2 h-px bg-border" style={{ left: icon || iconGap ? (grip ? 104 : 66) : grip ? 48 : 10 }} />}
      {grip}
      <button
        className="flex min-w-0 flex-1 items-center gap-3.5 self-stretch py-3 text-left"
        onClick={() => { if (!held() && !editing) navigate(`/deck?name=${enc(d.name)}`); }}
        aria-label={`${leafOf(d.name)}: ${summary(d)}`}
      >
        {icon ? <DeckIcon icon={d.icon} size={44} className="lib-art" /> : iconGap && d.depth === 0 ? <span className="w-11 shrink-0" /> : null}
        <span className="min-w-0 flex-1">
          {crumb && parentOf(d.name) && <span className="block truncate text-[12.5px] text-muted-foreground">{parentOf(d.name).split("::").join(" › ")}</span>}
          <span className={cn("block truncate text-[16px] leading-snug", d.depth === 0 ? "font-semibold" : "font-medium")}>{leafOf(d.name)}</span>
          <span className="mt-1 flex items-center gap-3">
            <DeckCounts d={d} note={subs ? plural(subs, "subdeck") : d.depth > 0 ? undefined : undefined} className="text-[13px]" />
            {soon && <span className="shrink-0 text-[12.5px] text-highlight">{relative(d.deadline!)}</span>}
          </span>
        </span>
      </button>
      {menu ? (
        <div className="shrink-0" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>{menu}</div>
      ) : d.cards > 0 && !d.archived ? (
        <button
          onClick={() => { if (!held()) navigate(practiceUrl(d)); }}
          aria-label={`${watch ? "Watch" : w ? "Practice" : "Practice ahead"} ${leafOf(d.name)}`}
          className={cn("lib-play flex size-[42px] shrink-0 items-center justify-center rounded-full transition-transform active:scale-90", !w && !watch && "dim")}
        >
          {watch ? <Eye className="size-[18px]" /> : w ? <Play className="size-4 translate-x-px fill-current" /> : <FastForward className="size-4" />}
        </button>
      ) : (
        <span className="flex size-[42px] shrink-0 items-center justify-center"><ChevronRight className="size-4 text-muted-foreground" /></span>
      )}
    </div>
  );
}
