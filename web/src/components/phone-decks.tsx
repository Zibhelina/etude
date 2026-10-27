// Decks on a phone. One level at a time instead of an indented tree: the top level here, a deck's
// subdecks on its own page. Today's work leads; every row is one tap to open and a press-and-hold
// for everything else (practice, move, rename), so there are no grips or ⋯ buttons on the row.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpLeft, ArrowUpToLine, CalendarClock, ChevronRight, Eye, FastForward, FolderInput, FolderPlus, Pencil, Play, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { api, relative, type DeckNode } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useLongPress } from "@/lib/phone";
import { childrenOf, clashes, leafOf, moveDeck, MoveDeckDialog, parentOf } from "@/components/move-deck";
import { ActionSheet, Mark, PhoneIconButton, PhoneTitle, Tally, type SheetAction } from "@/components/phone-shell";
import { NewDeckDialog, useImportPicker } from "@/pages/decks";

const enc = encodeURIComponent;
const work = (d: DeckNode) => d.new + d.learning + d.review;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function practiceUrl(d: DeckNode) {
  if (d.mode === "watch") return `/watch?deck=${enc(d.name)}`;
  return `/study?deck=${enc(d.name)}${work(d) ? "" : "&ahead=1"}`;
}

export function PhoneDecks() {
  const [decks, setDecks] = useState<DeckNode[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const reload = () => api.decks().then(setDecks).catch((e) => toast.error(e.message));
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const pickFile = useImportPicker(reload);

  const top = (decks ?? []).filter((d) => d.depth === 0);
  const studyTop = top.filter((d) => d.mode !== "watch");
  const totals = studyTop.reduce((a, d) => ({ n: a.n + d.new, l: a.l + d.learning, r: a.r + d.review, done: a.done + d.doneToday }), { n: 0, l: 0, r: 0, done: 0 });
  const due = totals.n + totals.l + totals.r;
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

  return (
    <div className="pb-4">
      <PhoneTitle
        kicker={today}
        title="Decks"
        actions={<PhoneIconButton label="New deck or import" onClick={() => setAdding(true)}><Plus /></PhoneIconButton>}
      />

      {decks && top.length > 0 && (
        <TodayCard due={due} n={totals.n} l={totals.l} r={totals.r} done={totals.done} />
      )}

      {decks && decks.length === 0 && (
        <div className="mx-5 mt-4 rounded-3xl border border-dashed px-6 py-12 text-center">
          <div className="score-serif text-2xl">An empty score</div>
          <p className="mx-auto mt-2 max-w-64 text-[14px] text-muted-foreground">Make a deck, or bring in a pack or an Anki file.</p>
          <div className="mt-6 flex flex-col gap-2">
            <button onClick={() => setCreating(true)} className="h-12 rounded-2xl bg-primary text-[15px] font-medium text-primary-foreground">New deck</button>
            <button onClick={pickFile} className="h-12 rounded-2xl border bg-card text-[15px]">Import a file</button>
          </div>
        </div>
      )}

      {!decks && <div className="mx-5 mt-2 h-36 animate-pulse rounded-3xl bg-muted/50" />}

      {top.length > 0 && <DeckList decks={decks ?? []} parent="" label="Your decks" onChanged={reload} />}

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
    </div>
  );
}

/**
 * Today's practice: the total as a large serif figure, then one "measure", a bar split by barlines into
 * new / learning / due in proportion, with the three counts under it. One button practises all of it.
 */
function TodayCard({ due, n, l, r, done }: { due: number; n: number; l: number; r: number; done: number }) {
  const parts = [
    { v: n, label: "new", cls: "text-new", bg: "bg-new", kind: "new" as const },
    { v: l, label: "learning", cls: "text-learn", bg: "bg-learn", kind: "learn" as const },
    { v: r, label: "due", cls: "text-review", bg: "bg-review", kind: "due" as const },
  ];
  return (
    <section className="score-rise mx-5 rounded-[1.75rem] border bg-card p-5" aria-label="Today">
      <div className="flex items-baseline justify-between">
        <span className="score-kicker">Today</span>
        {done > 0 && <span className="text-[12px] text-muted-foreground tabular">{plural(done, "review")} done</span>}
      </div>
      {due ? (
        <>
          <div className="mt-3 flex items-baseline gap-2.5">
            <span className="score-serif score-display text-[3.6rem] leading-[0.85] tabular">{due}</span>
            <span className="text-[16px] text-muted-foreground">to practice</span>
          </div>
          <div className="mt-5 flex h-2 gap-[3px]" aria-hidden>
            {parts.filter((p) => p.v).map((p) => (
              <span key={p.label} className={cn("h-full rounded-[2px] opacity-90 first:rounded-l-full last:rounded-r-full", p.bg)} style={{ flexGrow: Math.max(p.v, due * 0.04) }} />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {parts.map((p) => (
              <div key={p.label} className="flex flex-col">
                <span className={cn("inline-flex items-center gap-1.5 text-[1.3rem] leading-none font-medium tabular", p.v ? p.cls : "text-muted-foreground/50")}>
                  <Mark kind={p.kind} className="size-2.5" />{p.v}
                </span>
                <span className="mt-1.5 text-[12.5px] text-muted-foreground">{p.label}</span>
              </div>
            ))}
          </div>
          <button onClick={() => navigate("/study")} className="mt-6 flex h-[3.25rem] w-full items-center justify-center gap-2 rounded-full bg-primary text-[16px] font-medium text-primary-foreground transition-transform active:scale-[0.98]">
            <Play className="size-4 fill-current" />Practice everything
          </button>
        </>
      ) : (
        <div className="mt-2">
          <div className="score-serif score-display text-[1.9rem] leading-tight">All caught up.</div>
          <p className="mt-1 text-[14px] text-muted-foreground">Nothing due now. Hold a deck to practice ahead.</p>
        </div>
      )}
    </section>
  );
}

/**
 * The children of `parent`, one level. Rows open the deck; hold for the actions sheet.
 * Used here for the top level and by the deck page for subdecks.
 */
export function DeckList({ decks, parent, label, onChanged }: { decks: DeckNode[]; parent: string; label?: string; onChanged(): void }) {
  const [sheet, setSheet] = useState<DeckNode | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const kids = childrenOf(decks, parent).map((n) => decks.find((d) => d.name === n)!).filter(Boolean);
  if (!kids.length) return null;
  const place = (name: string, to: string, index: number | undefined) => moveDeck(decks, name, to, index, () => onChanged());

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
        { label: "Move to…", icon: FolderInput, onClick: () => setMoving(d.name) },
        ...(i > 0 ? [{ label: "Move up", icon: ArrowUp, onClick: () => place(d.name, parentOf(d.name), i - 1) }] : []),
        ...(i < sibs.length - 1 ? [{ label: "Move down", icon: ArrowDown, onClick: () => place(d.name, parentOf(d.name), i + 1) }] : []),
        ...(d.depth > 1 && !clashes(decks, d.name, gp) ? [{ label: "Out one level", icon: ArrowUpLeft, onClick: () => place(d.name, gp, childrenOf(decks, gp).indexOf(parentOf(d.name)) + 1) }] : []),
        ...(d.depth > 0 && !clashes(decks, d.name, "") ? [{ label: "Make it a deck of its own", icon: ArrowUpToLine, onClick: () => place(d.name, "", childrenOf(decks, "").indexOf(d.name.split("::")[0]) + 1) }] : []),
      ],
    ];
  };

  return (
    <section className="mt-8">
      {label && (
        <div className="flex items-baseline justify-between px-5 pb-2">
          <span className="score-kicker">{label}</span>
          <span className="text-[12px] text-muted-foreground">{plural(kids.length, "deck")}</span>
        </div>
      )}
      <div className="score-list">
        {kids.map((d) => <DeckRow key={d.id} d={d} decks={decks} onHold={() => setSheet(d)} />)}
      </div>
      <ActionSheet
        open={!!sheet}
        onClose={() => setSheet(null)}
        title={sheet ? leafOf(sheet.name) : ""}
        description={sheet ? summary(sheet) : ""}
        groups={sheet ? actions(sheet) : []}
      />
      <MoveDeckDialog deck={moving} decks={decks} onOpenChange={(o) => !o && setMoving(null)} onMoved={() => onChanged()} />
    </section>
  );
}

function summary(d: DeckNode) {
  if (d.mode === "watch") return `${plural(d.cards, "card")} · a tour`;
  const w = work(d);
  return `${plural(d.cards, "card")}${w ? ` · ${w} to practice` : d.nextDue ? ` · next ${relative(d.nextDue)}` : ""}`;
}

function DeckRow({ d, decks, onHold }: { d: DeckNode; decks: DeckNode[]; onHold(): void }) {
  const { handlers, held } = useLongPress(onHold);
  const subs = childrenOf(decks, d.name).length;
  const w = work(d);
  const watch = d.mode === "watch";
  const soon = d.deadline && new Date(d.deadline) > new Date();
  return (
    <div className="relative flex min-h-[4.5rem] select-none items-center [-webkit-touch-callout:none]" {...handlers}>
      <button
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-3 pr-2 pl-5 text-left"
        onClick={() => { if (!held()) navigate(`/deck?name=${enc(d.name)}`); }}
        aria-label={`${leafOf(d.name)}: ${summary(d)}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[16.5px] leading-snug break-words">{leafOf(d.name)}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            {watch ? (
              <span className="inline-flex items-center gap-1"><Eye className="size-3.5" />tour · {d.cards}</span>
            ) : w ? (
              <Tally n={d.new} l={d.learning} r={d.review} />
            ) : (
              <span>{d.cards ? (d.nextDue ? `next ${relative(d.nextDue)}` : "nothing due") : "empty"}</span>
            )}
            {subs > 0 && <span>{plural(subs, "subdeck")}</span>}
            {soon && <span className="inline-flex items-center gap-1 text-highlight"><CalendarClock className="size-3.5" />{relative(d.deadline!)}</span>}
          </span>
        </span>
      </button>
      {(w > 0 || (watch && d.cards > 0)) ? (
        <button
          onClick={() => { if (!held()) navigate(practiceUrl(d)); }}
          aria-label={`${watch ? "Watch" : "Practice"} ${leafOf(d.name)}`}
          className="mr-4 flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-foreground transition-transform active:scale-90"
        >
          {watch ? <Eye className="size-[18px]" /> : <Play className="size-4 translate-x-px fill-current" />}
        </button>
      ) : (
        <span className="mr-4 flex size-11 shrink-0 items-center justify-center"><ChevronRight className="size-4 text-muted-foreground" /></span>
      )}
    </div>
  );
}
