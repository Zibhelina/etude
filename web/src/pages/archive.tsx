// The Archive: decks put away, as boxes. Each box says how much of it is probably still remembered; clicking one
// opens a drawer (a sheet on phones) with its forgetting curve and Restore. Select several to restore or delete them at once.
import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, ArrowDownUp, Check, ChevronLeft, MoreHorizontal, SearchCode, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, type ArchivedDeck } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { usePhone } from "@/lib/phone";
import { Page } from "@/components/page";
import { leafOf, parentOf } from "@/components/move-deck";
import { DeckIcon } from "@/components/deck-icon";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

const enc = encodeURIComponent;
const n = (x: number) => x.toLocaleString();
const cardsTxt = (x: number) => `${n(x)} card${x === 1 ? "" : "s"}`;
const pct = (r: number) => `${Math.round(r * 100)}%`;
const DAY = 86400_000;
const DRAWER_W = 400;

function ago(iso: string | null) {
  if (!iso) return "never studied";
  const d = Math.round((Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 14 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} weeks ago` : d < 365 ? `${Math.round(d / 30)} months ago` : d < 548 ? "a year ago" : `${Math.round(d / 365)} years ago`;
}
function wait(days: number) {
  return days < 14 ? `${Math.max(1, Math.round(days))} days` : days < 60 ? `${Math.round(days / 7)} weeks` : days < 365 ? `${Math.round(days / 30)} months` : `${Math.round(days / 36.5) / 10} years`;
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(iso).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });

type Sort = "recent" | "oldest" | "name" | "size" | "weak";
const SORTS: [Sort, string][] = [["recent", "Studied most recently"], ["oldest", "Away the longest"], ["name", "Name"], ["size", "Most cards"], ["weak", "Least remembered"]];

export function ArchivePage() {
  const phone = usePhone();
  const [list, setList] = useState<ArchivedDeck[] | null>(null);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem("etude.archiveSort") as Sort) || "recent");
  const [open, setOpen] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ArchivedDeck[] | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  const reload = () => api.archive().then(setList).catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => localStorage.setItem("etude.archiveSort", sort), [sort]);

  const sorted = useMemo(() => {
    const at = (d: ArchivedDeck) => (d.lastReview ? new Date(d.lastReview).getTime() : 0);
    const f: Record<Sort, (a: ArchivedDeck, b: ArchivedDeck) => number> = {
      recent: (a, b) => at(b) - at(a),
      oldest: (a, b) => at(a) - at(b),
      name: (a, b) => leafOf(a.name).localeCompare(leafOf(b.name)),
      size: (a, b) => b.cards - a.cards,
      weak: (a, b) => (a.recall ?? 2) - (b.recall ?? 2),
    };
    return [...(list ?? [])].sort(f[sort]);
  }, [list, sort]);
  const total = (list ?? []).reduce((a, d) => a + d.cards, 0);

  /** Fades the rows out, then does the change, then offers Undo. */
  const restore = async (ds: ArchivedDeck[]) => {
    if (busy || !ds.length) return;
    setBusy(true);
    setLeaving(new Set(ds.map((d) => d.name)));
    await new Promise((r) => setTimeout(r, 220));
    try {
      for (const d of ds) await api.setDeckArchived(d.name, false);
      const due = ds.reduce((a, d) => a + d.due, 0);
      toast.success(ds.length === 1 ? `Restored ${leafOf(ds[0].name)}` : `Restored ${ds.length} decks`, {
        description: due ? `${n(due)} card${due === 1 ? "" : "s"} due now.` : undefined,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              for (const d of ds) await api.setDeckArchived(d.name, true);
              reload();
            } catch (e) {
              toast.error((e as Error).message);
            }
          },
        },
      });
      setSel(new Set());
      setSelecting(false);
      setOpen(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await reload();
      setLeaving(new Set());
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      for (const d of deleting) await api.deleteDeck(d.name, true);
      toast.success(deleting.length === 1 ? `Deleted ${leafOf(deleting[0].name)}` : `Deleted ${deleting.length} decks`);
      setSel(new Set());
      setSelecting(false);
      setOpen(null);
      setDeleting(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const chosen = sorted.filter((d) => sel.has(d.name));
  const toggleSel = (name: string) => {
    const next = new Set(sel);
    next.has(name) ? next.delete(name) : next.add(name);
    setSel(next);
  };
  const openDeck = list?.find((d) => d.name === open) ?? null;

  // Esc closes the drawer (or stops selecting).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest?.("input,textarea,[role=dialog],[role=menu]")) return;
      if (open) setOpen(null);
      else if (selecting) { setSelecting(false); setSel(new Set()); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selecting]);
  const drawer = !phone && !!openDeck;

  return (
    <div className="transition-[padding] duration-200" style={{ paddingRight: drawer ? DRAWER_W : 0 }}>
    <Page className={cn("max-w-[60rem]", selecting && "pb-28")}>
      <header className="mb-6">
        <button onClick={() => navigate("/")} className="-ml-1.5 mb-1 inline-flex h-9 items-center gap-1 rounded-md px-1.5 text-[15px] text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" />Library</button>
        <h1 className="lib-title text-[2rem] leading-[1.1] font-semibold">Archive</h1>
        {list && list.length > 0 && (
          <p className="mt-2 max-w-[36rem] text-[15px] leading-relaxed text-pretty text-muted-foreground">
            {list.length === 1 ? "1 deck" : `${list.length} decks`} put away, {cardsTxt(total)} in all. Nothing here comes up in study, and every card keeps its history.
          </p>
        )}
      </header>

      {list && list.length > 0 && (
        <div className="mb-3 flex items-center justify-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="lib-quiet inline-flex h-10 items-center gap-2 rounded-xl px-3 text-[14.5px] font-semibold" aria-label="Sort">
                <ArrowDownUp className="size-4" />
                {!phone && SORTS.find(([k]) => k === sort)![1]}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                {SORTS.map(([k, label]) => <DropdownMenuRadioItem key={k} value={k} className="h-9">{label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <button className="lib-quiet inline-flex h-10 items-center rounded-xl px-3.5 text-[14.5px] font-semibold" onClick={() => { setSelecting(!selecting); setSel(new Set()); }}>
            {selecting ? "Done" : "Select"}
          </button>
        </div>
      )}

      {!list && <div className="h-48 animate-pulse rounded-2xl bg-muted/60" />}
      {list && list.length === 0 && <ArchiveEmpty />}

      {sorted.length > 0 && (
        <div role="list" aria-label="Archived decks" className={cn("grid auto-rows-fr", phone ? "grid-cols-2 gap-2.5" : "grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3.5")}>
          {sorted.map((d) => (
            <Tile
              key={d.name}
              d={d}
              phone={phone}
              open={open === d.name}
              selecting={selecting}
              checked={sel.has(d.name)}
              leaving={leaving.has(d.name)}
              onOpen={() => (selecting ? toggleSel(d.name) : setOpen(open === d.name ? null : d.name))}
              onRestore={() => restore([d])}
              onDelete={() => setDeleting([d])}
            />
          ))}
        </div>
      )}
      {list && list.length > 0 && <p className="mt-8 text-center text-[13.5px] text-muted-foreground/80">Archiving never deletes anything. Cards only leave Etude when you choose Delete for good.</p>}

      {selecting && (
        <div className="fixed inset-x-0 bottom-[calc(var(--tabbar-h,0px)+1rem)] z-40 flex justify-center px-4">
          <div className="lib-panel flex w-full max-w-[34rem] items-center gap-2 rounded-2xl p-2 pl-4" role="toolbar" aria-label="Selected decks">
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{chosen.length ? `${chosen.length} selected · ${cardsTxt(chosen.reduce((a, d) => a + d.cards, 0))}` : "Tap decks to select"}</span>
            <button className="lib-primary inline-flex h-10 items-center gap-2 rounded-xl px-4 text-[14.5px] font-semibold disabled:opacity-50" disabled={!chosen.length || busy} onClick={() => restore(chosen)}><ArchiveRestore className="size-4" />Restore</button>
            <button className="inline-flex h-10 items-center gap-2 rounded-xl px-3 text-[14.5px] font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-40" disabled={!chosen.length || busy} onClick={() => setDeleting(chosen)} aria-label="Delete for good"><Trash2 className="size-4" />{!phone && "Delete"}</button>
            <button className="flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent" onClick={() => { setSelecting(false); setSel(new Set()); }} aria-label="Stop selecting"><X className="size-4" /></button>
          </div>
        </div>
      )}

      {phone && (
        <Sheet open={!!openDeck} onOpenChange={(o) => !o && setOpen(null)}>
          <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto rounded-t-3xl px-5 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {openDeck && (
              <>
                <div className="flex items-center gap-3.5 pr-8">
                  <DeckIcon icon={openDeck.icon} size={52} className="lib-art" />
                  <div className="min-w-0">
                    <SheetTitle className="lib-title text-[1.45rem] leading-tight font-semibold">{leafOf(openDeck.name)}</SheetTitle>
                    <SheetDescription className="text-[14px]">{parentOf(openDeck.name) ? `in ${leafOf(parentOf(openDeck.name))} · ` : ""}{cardsTxt(openDeck.cards)}</SheetDescription>
                  </div>
                </div>
                <div className="mt-4"><Body d={openDeck} busy={busy} onRestore={() => restore([openDeck])} onDelete={() => setDeleting([openDeck])} /></div>
              </>
            )}
          </SheetContent>
        </Sheet>
      )}

      {!phone && openDeck && (
        <aside className="archive-drawer fixed inset-y-0 z-30 overflow-y-auto bg-background px-6 pt-6 pb-36" style={{ width: DRAWER_W, right: "var(--agent-offset, 0px)" }} aria-label={leafOf(openDeck.name)}>
          <div className="mb-4 flex items-center gap-3.5">
            <DeckIcon icon={openDeck.icon} size={60} className="lib-art" />
            <div className="min-w-0 flex-1">
              {parentOf(openDeck.name) && <div className="truncate text-[13.5px] text-muted-foreground">{leafOf(parentOf(openDeck.name))} ›</div>}
              <h2 className="lib-title text-[1.5rem] leading-tight font-semibold">{leafOf(openDeck.name)}</h2>
              <div className="mt-0.5 text-[14px] text-muted-foreground">{cardsTxt(openDeck.cards)}{openDeck.subdecks.length ? ` · ${openDeck.subdecks.length} subdeck${openDeck.subdecks.length === 1 ? "" : "s"}` : ""}</div>
            </div>
            <button className="flex size-9 shrink-0 items-center justify-center self-start rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(null)} aria-label="Close" title="Close · Esc"><X className="size-4" /></button>
          </div>
          <Body d={openDeck} busy={busy} onRestore={() => restore([openDeck])} onDelete={() => setDeleting([openDeck])} />
        </aside>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && !busy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.length === 1 ? leafOf(deleting[0].name) : `${deleting?.length ?? 0} decks`} for good?</AlertDialogTitle>
            <AlertDialogDescription>
              {cardsTxt((deleting ?? []).reduce((a, d) => a + d.cards, 0))} and their review history will be deleted, with every subdeck. This can’t be undone. Restore keeps everything instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => { e.preventDefault(); void remove(); }}>Delete {cardsTxt((deleting ?? []).reduce((a, d) => a + d.cards, 0))}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
    </div>
  );
}

function ArchiveEmpty() {
  return (
    <section className="flex flex-col items-center px-6 py-16 text-center">
      <div className="relative mb-6 h-16 w-24" aria-hidden>
        <span className="absolute inset-x-3 top-0 h-12 rotate-[-6deg] rounded-lg border bg-card" />
        <span className="absolute inset-x-1 top-2 h-12 rotate-[4deg] rounded-lg border bg-card" />
        <span className="absolute inset-x-0 top-4 flex h-12 items-center justify-center rounded-lg border bg-card text-muted-foreground"><ArchiveRestore className="size-6" /></span>
      </div>
      <h2 className="lib-title text-[1.5rem] font-semibold">Nothing put away.</h2>
      <p className="mt-2 max-w-[24rem] text-[15px] leading-relaxed text-pretty text-muted-foreground">Done with a deck for now? Archive it from its menu in the Library. It waits here with all its history.</p>
    </section>
  );
}

/** One box: the deck's picture, name, size, when it was last studied and how much is still known. */
function Tile({ d, phone, open, selecting, checked, leaving, onOpen, onRestore, onDelete }: {
  d: ArchivedDeck; phone: boolean; open: boolean; selecting: boolean; checked: boolean; leaving: boolean;
  onOpen(): void; onRestore(): void; onDelete(): void;
}) {
  const parent = parentOf(d.name);
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-archived={d.name}
      aria-label={leafOf(d.name)}
      aria-pressed={selecting ? checked : undefined}
      className={cn(
        "archive-tile lib-panel relative flex min-w-0 cursor-pointer flex-col rounded-2xl select-none",
        phone ? "p-3 pb-3.5" : "p-3.5 pb-4",
        open && "on",
        checked && "chk",
        leaving && "lib-out",
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button,[role=menuitem]")) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen();
      }}
    >
      {(d.icon || !phone) && (
        <div className="mb-2.5 flex min-h-9 items-start">
          {d.icon && <DeckIcon icon={d.icon} size={phone ? 46 : 56} className="lib-art archive-art" />}
          <span className="flex-1" />
          {selecting ? (
            <button
              className={cn("flex size-6 shrink-0 items-center justify-center rounded-md border-2", checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}
              onClick={onOpen}
              aria-label={`Select ${leafOf(d.name)}`}
              aria-pressed={checked}
            >
              {checked && <Check className="size-3.5" strokeWidth={3} />}
            </button>
          ) : (
            !phone && <span className="-mt-1 -mr-1.5"><RowMenu d={d} onRestore={onRestore} onDelete={onDelete} /></span>
          )}
        </div>
      )}
      {phone && !d.icon && selecting && <span className={cn("absolute top-3 right-3 flex size-6 items-center justify-center rounded-md border-2", checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>{checked && <Check className="size-3.5" strokeWidth={3} />}</span>}
      {parent && <div className="truncate text-[13px] text-muted-foreground">{leafOf(parent)} ›</div>}
      <div className={cn("truncate font-semibold", phone ? "text-[15px]" : "text-[16px]", phone && !d.icon && selecting && "pr-8")}>{leafOf(d.name)}</div>
      <div className="mt-0.5 truncate text-[13.5px] text-muted-foreground">{cardsTxt(d.cards)}</div>
      {d.lastReview && <div className="truncate text-[13.5px] text-muted-foreground">studied {ago(d.lastReview)}</div>}
      <div className="mt-auto pt-3" title="Predicted recall if you were quizzed on every card today">
        {d.recall != null ? (
          <>
            <span className="lib-track h-1 rounded-full">
              <span className="block h-full rounded-full bg-muted-foreground/60" style={{ width: `${d.recall * 100}%` }} />
            </span>
            <div className="mt-1.5 text-[13px] text-muted-foreground"><b className="font-bold text-foreground tabular">{pct(d.recall)}</b> still known</div>
          </>
        ) : (
          <>
            <span className="lib-track h-1 rounded-full" />
            <div className="mt-1.5 text-[13px] text-muted-foreground">Never studied</div>
          </>
        )}
      </div>
    </div>
  );
}

function RowMenu({ d, onRestore, onDelete }: { d: ArchivedDeck; onRestore(): void; onDelete(): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`More for ${leafOf(d.name)}`}><MoreHorizontal className="size-4" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem className="h-9" onClick={onRestore}><ArchiveRestore />Restore</DropdownMenuItem>
        <DropdownMenuItem className="h-9" onClick={() => navigate(`/deck?name=${enc(d.name)}`)}><SearchCode />Open the deck</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-9" variant="destructive" onClick={onDelete}><Trash2 />Delete for good…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The drawer and the phone sheet: the forgetting curve, the facts, the subdecks, then Restore. */
function Body({ d, busy, onRestore, onDelete }: { d: ArchivedDeck; busy: boolean; onRestore(): void; onDelete(): void }) {
  return (
    <div className="min-w-0">
      {d.curve.length > 1 && (
        <div className="rounded-2xl bg-muted px-4 pt-3.5 pb-3">
          <Curve d={d} />
          {d.recall != null && d.lastReview && (
            <p className="mt-2 text-[14px] leading-relaxed text-pretty text-muted-foreground">
              You studied it until {fmtDate(d.lastReview)}. Since then memory has faded the way it always does: you’d get about <b className="font-semibold text-foreground">{pct(d.recall)}</b> right today.{d.due ? ` The ${n(d.due)} card${d.due === 1 ? "" : "s"} that dropped below your target would be due.` : ""}
            </p>
          )}
        </div>
      )}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Fact label="Last studied" value={d.lastReview ? fmtDate(d.lastReview) : "Never"} />
        <Fact label="Cards" value={n(d.cards)} />
        <Fact label="Due if restored" value={`${n(d.due)} card${d.due === 1 ? "" : "s"}`} />
      </div>
      {d.subdecks.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {d.subdecks.map((s) => (
            <span key={s.name} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-card px-3 text-[14px] shadow-[0_0_0_1px_var(--border)]">{leafOf(s.name)}<i className="text-muted-foreground not-italic tabular">{n(s.cards)}</i></span>
          ))}
        </div>
      )}
      <div className="mt-6 flex gap-2.5">
        <button className="lib-primary inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-[15.5px] font-semibold disabled:opacity-50" disabled={busy} onClick={onRestore}><ArchiveRestore className="size-4" />Restore</button>
        <button className="lib-quiet inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-[15.5px] font-semibold" onClick={() => navigate(`/deck?name=${enc(d.name)}&tab=cards`)}><SearchCode className="size-4" />See its cards</button>
      </div>
      <div className="mt-3 flex justify-center">
        <button className="inline-flex h-9 items-center rounded-lg px-2 text-[14.5px] font-medium text-destructive hover:underline" onClick={onDelete}>Delete for good…</button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-[15.5px] font-semibold tabular">{value}</div>
    </div>
  );
}

/** Predicted recall from the last review to some weeks ahead: solid up to today, dashed after. */
function Curve({ d }: { d: ArchivedDeck }) {
  const W = 340, H = 170, pl = 40, pr = 12, pt = 14, pb = 26;
  const c = d.curve;
  const x0 = c[0].days, x1 = c[c.length - 1].days;
  const lo = Math.max(0, Math.min(0.5, Math.floor(Math.min(...c.map((p) => p.recall)) * 4) / 4));
  const X = (days: number) => pl + ((days - x0) / Math.max(1e-6, x1 - x0)) * (W - pl - pr);
  const Y = (r: number) => pt + ((1 - r) / (1 - lo)) * (H - pt - pb);
  const path = (pts: typeof c) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.days).toFixed(1)},${Y(p.recall).toFixed(1)}`).join("");
  const past = c.filter((p) => p.days <= 0);
  const now = d.recall ?? c.find((p) => p.days >= 0)!.recall;
  const future = [{ days: 0, recall: now }, ...c.filter((p) => p.days > 0)];
  // When it reaches 75% (or how low it gets by the end of the chart).
  const target = now > 0.75 ? future.find((p) => p.recall <= 0.75) : null;
  const end = c[c.length - 1];
  const note = target ? `75% in ${wait(target.days)}` : `${pct(end.recall)} in ${wait(end.days)}`;
  const ticks = [1, (1 + lo) / 2, lo];
  return (
    <figure className="min-w-0">
      <figcaption className="score-kicker mb-2 font-semibold">What you still know</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={`Predicted recall: ${pct(now)} today, ${note}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pl} x2={W - pr} y1={Y(t)} y2={Y(t)} stroke="var(--border)" />
            <text x={pl - 8} y={Y(t) + 4} textAnchor="end" fontSize="12" fill="var(--muted-foreground)">{pct(t)}</text>
          </g>
        ))}
        <line x1={X(0)} x2={X(0)} y1={Y(now) + 6} y2={H - pb} stroke="var(--muted-foreground)" strokeOpacity="0.5" strokeDasharray="2 3" />
        <text x={X(0)} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--muted-foreground)">today</text>
        {past.length > 0 && <path d={path([...past, { days: 0, recall: now }])} fill="none" stroke="var(--foreground)" strokeWidth="2" strokeLinecap="round" />}
        <path d={path(future)} fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.8" strokeWidth="1.8" strokeDasharray="4 4" />
        <circle cx={X(0)} cy={Y(now)} r="5" fill="var(--card)" stroke="var(--foreground)" strokeWidth="2" />
        <text x={X(0) + 9} y={Y(now) < pt + 22 ? Y(now) + 20 : Y(now) - 9} fontSize="13.5" fontWeight="700" fill="var(--foreground)">{pct(now)}</text>
        <text x={W - pr} y={Math.min(H - pb - 6, Y(end.recall) + 18)} textAnchor="end" fontSize="12.5" fill="var(--muted-foreground)">{note}</text>
      </svg>
    </figure>
  );
}
