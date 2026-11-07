// The card list rows, bulk actions and item editor shared by Browse and the deck page's Cards tab.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronLeft, Copy, Dices, FolderInput, Loader2, MoreHorizontal, Pause, Play, RotateCcw, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldEditor } from "@/components/field-editor";
import { ItemAiEdit } from "@/components/item-ai-edit";
import { ItemPreview } from "@/components/item-preview";
import { HistoryPanel, MemoryPanel } from "@/components/item-memory";
import { api, humanInterval, relative, STATE_NAMES, type CardType, type ItemDetail, type SearchRow, type TypeSummary } from "@/lib/api";
import { useFunMode } from "@/lib/fun";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useLongPress, usePhone } from "@/lib/phone";

export const STATE_CLS = ["text-new", "text-learn", "text-review", "text-learn"];

export type ItemRowData = SearchRow & { faces: number };

/** One row per item: an item with two faces has two cards but is listed once. */
export function groupItems(rows: SearchRow[]): ItemRowData[] {
  const seen = new Map<string, ItemRowData>();
  for (const r of rows) {
    const e = seen.get(r.itemId);
    if (e) e.faces++;
    else seen.set(r.itemId, { ...r, faces: 1 });
  }
  return [...seen.values()];
}

export const ORDERS = [
  ["relevance", "Best match"],
  ["added", "Order added"],
  ["deck", "Deck"],
  ["due", "Due"],
  ["lapses", "Most lapses"],
  ["difficulty", "Hardest"],
  ["updated", "Recently edited"],
] as const;

export function OrderSelect({ value, onChange, className }: { value: string; onChange(v: string): void; className?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={cn("h-7 w-auto gap-1 border-0 px-2 text-xs shadow-none", className)}><SelectValue /></SelectTrigger>
      <SelectContent>
        {ORDERS.map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function CheckBox({ checked, onClick, label, className }: { checked: boolean; onClick(e: React.MouseEvent): void; label: string; className?: string }) {
  return (
    <button
      className={cn("relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground/30 after:absolute after:-inset-3 after:content-['']", checked && "border-foreground bg-foreground text-background", className)}
      onClick={onClick}
      aria-label={label}
    >
      {checked && <Check className="size-3" />}
    </button>
  );
}

export function ItemRow({ row: r, active, checked, onOpen, onToggle, className, hideDeck, selecting }: { row: ItemRowData; active: boolean; checked: boolean; onOpen(): void; onToggle(): void; className?: string; hideDeck?: boolean; selecting?: boolean }) {
  // Phones: no checkbox column until you press and hold a row; then taps select.
  const phone = usePhone();
  const { handlers, held } = useLongPress(onToggle);
  const showBox = !phone || selecting;
  return (
    <div
      data-item-row
      onClick={() => {
        if (held()) return;
        if (phone && selecting) onToggle();
        else onOpen();
      }}
      {...(phone ? handlers : {})}
      className={cn(
        "group flex cursor-pointer items-start gap-3 border-b px-3 py-3 transition-colors hover:bg-accent/40 phone:min-h-[4.25rem] phone:select-none phone:py-3.5 phone:[-webkit-touch-callout:none]",
        phone && checked && "bg-highlight/[0.07]",
        (r.suspended || r.archived) && "opacity-55",
        className,
      )}
    >
      {showBox && (
        <CheckBox
          checked={checked}
          className="mt-0.5"
          label="Select"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn("line-clamp-2 text-sm leading-snug phone:text-[15px]", active && "font-medium text-highlight")} aria-current={active || undefined}>{r.title || <span className="text-muted-foreground">{r.itemId}</span>}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {!hideDeck && <><span className="truncate">{r.deck.split("::").slice(-1)[0]}</span><span>·</span></>}
          <span className="shrink-0">{r.type}</span>
          {r.generated && <Dices className="size-3 shrink-0" />}
          {r.faces > 1 && <span className="shrink-0">· {r.faces} cards</span>}
          <div className="flex-1" />
          <span className={cn("shrink-0", STATE_CLS[r.state])}>{r.suspended ? "suspended" : STATE_NAMES[r.state].toLowerCase()}</span>
          {r.state !== 0 && <span className="tabular shrink-0">{new Date(r.due) <= new Date() ? "due" : humanInterval(r.due)}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Selection-driven bulk actions over a set of items. `rows` are the card rows behind them
 * (card-level actions like suspend apply to every face). Renders the toolbar and its dialogs.
 */
export function BulkBar({ checked, rows, decks, tags, onClear, onDone, onDeleted, className }: { checked: Set<string>; rows: SearchRow[]; decks: string[]; tags: string[]; onClear(): void; onDone(): void; onDeleted?(ids: string[]): void; className?: string }) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = [...checked];
  const bulk = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      await api.bulkItems(action, ids, extra);
      toast.success(`${ids.length} item${ids.length === 1 ? "" : "s"} updated`);
      if (action === "delete") onDeleted?.(ids);
      onClear();
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const bulkCards = async (action: string) => {
    const cardIds = rows.filter((r) => checked.has(r.itemId)).map((r) => r.cardId);
    try {
      await api.bulkCards(action, cardIds);
      toast.success(`${cardIds.length} card${cardIds.length === 1 ? "" : "s"} updated`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      {checked.size > 0 && (
        <div className={cn("flex flex-wrap items-center gap-1 border-b bg-accent/40 px-3 py-2 text-xs", className)}>
          <span className="mr-1 font-medium">{checked.size} selected</span>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setMoveOpen(true)}><FolderInput className="size-3.5" />Move</Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setTagOpen(true)}><Tag className="size-3.5" />Tags</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="h-7 px-2" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => bulkCards("suspend")}><Pause />Suspend</DropdownMenuItem>
              <DropdownMenuItem onClick={() => bulkCards("unsuspend")}><Play />Unsuspend</DropdownMenuItem>
              <DropdownMenuItem onClick={() => bulkCards("reset")}><RotateCcw />Forget scheduling</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => bulk("archive")}><Archive />Archive</DropdownMenuItem>
              <DropdownMenuItem onClick={() => bulk("unarchive")}><ArchiveRestore />Unarchive</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 />Delete…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClear} aria-label="Clear selection"><X className="size-4" /></Button>
        </div>
      )}
      <MoveDialog open={moveOpen} onOpenChange={setMoveOpen} decks={decks} onMove={(d) => bulk("move", { deck: d })} />
      <TagDialog open={tagOpen} onOpenChange={setTagOpen} tags={tags} onApply={(add, remove) => bulk("tag", { add, remove })} />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {checked.size} item{checked.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>This removes them with all their review history. Archiving hides them and keeps the history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => bulk("delete")}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const HINT_LABEL: Record<string, string> = { "is:due": "Due", "is:new": "New", "is:suspended": "Suspended", "prop:lapses>=2": "Often missed", "rated:1:1": "Missed today", "type:free": "Free answer" };

export function SearchHints({ onPick }: { onPick(s: string): void }) {
  const hints = ["is:due", "is:new", "is:suspended", "prop:lapses>=2", "rated:1:1", "type:free"];
  // Phones: plain words in one swipeable row; the query syntax still goes into the search box.
  if (usePhone())
    return (
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5 [scrollbar-width:none]">
        {hints.map((h) => (
          <button key={h} onClick={() => onPick(h)} className="h-9 shrink-0 rounded-full border bg-card px-3.5 text-[13px] text-muted-foreground active:bg-accent active:text-foreground">{HINT_LABEL[h]}</button>
        ))}
      </div>
    );
  return (
    <div className="flex flex-wrap gap-1.5">
      {hints.map((h) => (
        <button key={h} onClick={() => onPick(h)} className="h-7 rounded-md border px-2 font-mono text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground pointer-coarse:h-9 pointer-coarse:px-2.5">{h}</button>
      ))}
    </div>
  );
}

/** What stops an image occlusion item from saving, in words; null when it's fine. Unlabeled boxes are allowed (they self-grade). */
function occlusionProblem(def: CardType | null, fields: Record<string, unknown>): string | null {
  const f = def?.fields.find((x) => x.editor === "occlusion");
  if (!f) return null;
  if (!fields.image) return "Add an image first: drop it, paste it or choose a file.";
  if (!Array.isArray(fields[f.name]) || !(fields[f.name] as unknown[]).length) return "Draw at least one box over the image.";
  return null;
}

type Draft = { deck: string; fields: Record<string, unknown>; tags: string[]; source: string; notes: string };
const draftOf = (it: ItemDetail): Draft => ({ deck: it.deck, fields: it.fields, tags: it.tags, source: it.source, notes: it.notes });

/** "Countries › Africa": the top deck and the leaf, with the full path on hover. */
export function DeckCrumb({ deck, leafOnly, className }: { deck: string; leafOnly?: boolean; className?: string }) {
  const parts = deck.split("::");
  const top = parts[0], leaf = parts.length > 1 ? parts[parts.length - 1] : null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium text-muted-foreground", className)} title={parts.join(" › ")}>
      {leafOnly && leaf ? <b className="truncate font-semibold text-foreground">{leaf}</b> : (
        <>
          <b className="shrink-0 truncate font-semibold text-foreground max-w-[60%]">{top}</b>
          {leaf && <><span className="text-muted-foreground/60">{parts.length > 2 ? "› … ›" : "›"}</span><span className="truncate">{leaf}</span></>}
        </>
      )}
    </span>
  );
}

const TABS = [["edit", "Edit"], ["memory", "Memory"], ["history", "History"]] as const;
type Tab = (typeof TABS)[number][0];

/**
 * The item inspector: header, a live preview that flips, and Edit / Memory / History.
 * `closeAlways` shows the back control at every size (for editors opened in a sheet); Browse only needs it on phones.
 * `gutter` keeps the save bar's buttons clear of the corner Minimi / Ask bubble.
 * `closeX` puts a close button after the actions (for a drawer beside a table) instead of a back arrow;
 * it also lets the inspector fill a wide drawer instead of stopping at 760px.
 */
export function ItemEditor({ id, decks, tags, onSaved, onDeleted, onDuplicate, onBack, closeAlways, closeX, gutter, onDirtyChange }: { id: string; decks: string[]; tags: string[]; onSaved(): void; onDeleted(): void; onDuplicate(id: string): void; onBack(): void; closeAlways?: boolean; closeX?: boolean; gutter?: boolean; onDirtyChange?(dirty: boolean): void }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [type, setType] = useState<CardType | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaPending, setMediaPending] = useState(false);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("edit");
  const [flipped, setFlipped] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "forget">(null);
  const phone = usePhone();
  const fun = useFunMode();

  const load = useCallback(async () => {
    try {
      const it = await api.item(id);
      setItem(it);
      setDraft(draftOf(it));
      setType(await api.type(it.type));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const dirty = !!item && !!draft && JSON.stringify(draftOf(item)) !== JSON.stringify(draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty]);

  const save = useCallback(async () => {
    if (!item || !draft || mediaPending) return;
    const problem = occlusionProblem(type, draft.fields);
    if (problem) return void toast.error(problem);
    setSaving(true);
    try {
      const r = await api.saveItem(item.id, { type: item.type, ...draft, archived: item.archived });
      setItem(r.item);
      setDraft(draftOf(r.item));
      setVersion((v) => v + 1);
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error("Couldn't save", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [item, draft, onSaved, mediaPending, type]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) save();
        return;
      }
      // Space flips the preview, unless you're typing or a dialog is open.
      const t = e.target as HTMLElement | null;
      if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey && !t?.closest("input, textarea, select, button, [contenteditable=true], [role=dialog], [role=menu], .cm-editor")) {
        e.preventDefault();
        setFlipped((f) => !f);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, save]);

  if (!item || !draft || !type) return <div className="flex h-full min-h-60 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>;

  const allSuspended = item.cards.every((c) => c.suspended);
  const archive = async () => {
    await api.bulkItems(item.archived ? "unarchive" : "archive", [item.id]);
    await load();
    onSaved();
    toast(item.archived ? "Unarchived" : "Archived. It's hidden from study and keeps its history", {
      action: { label: "Undo", onClick: async () => { await api.bulkItems(item.archived ? "archive" : "unarchive", [item.id]); load(); onSaved(); } },
    });
  };
  const suspend = async () => {
    const ids = item.cards.map((c) => c.id);
    await api.bulkCards(allSuspended ? "unsuspend" : "suspend", ids);
    await load();
    onSaved();
    toast(allSuspended ? "Unsuspended" : "Suspended. It won't come up until you unsuspend it", {
      action: { label: "Undo", onClick: async () => { await api.bulkCards(allSuspended ? "suspend" : "unsuspend", ids); load(); onSaved(); } },
    });
  };
  const forget = async () => {
    await api.bulkCards("reset", item.cards.map((c) => c.id));
    await load();
    onSaved();
    toast("Starts over as a new card");
  };
  const duplicate = async () => {
    const existing = new Set((await api.search(`id:${item.id}*`, { limit: 1000 })).rows.map((r) => r.itemId));
    let n = 2;
    while (existing.has(`${item.id}-${n}`)) n++;
    const newId = `${item.id}-${n}`;
    try {
      await api.saveItem(newId, { type: item.type, ...draft });
      toast.success("Duplicated. You're editing the copy");
      onDuplicate(newId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const del = async () => {
    await api.bulkItems("delete", [item.id]);
    toast.success("Deleted");
    onDeleted();
  };
  const practice = () => navigate(`/study?card=${item.cards[0]?.id}&deck=${encodeURIComponent(item.deck)}`);
  const count = item.reviews.length + item.attempts.length;

  const actions = (
    <>
      <Button variant="secondary" className="h-9 gap-2 rounded-[10px] px-3.5 font-semibold" onClick={practice}><Play className="size-3 fill-current text-muted-foreground" />Practice</Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-9 text-muted-foreground" aria-label="More"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={mediaPending} onClick={duplicate}><Copy />Duplicate</DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(`/types/${encodeURIComponent(item.type)}`)}><Dices />Edit card type</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(item.id); toast("Copied id"); }}><Copy />Copy id</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setConfirm("forget")}><RotateCcw />Start over</DropdownMenuItem>
          <DropdownMenuItem onClick={suspend}><Pause />{allSuspended ? "Unsuspend" : "Suspend"}</DropdownMenuItem>
          <DropdownMenuItem onClick={archive}>{item.archived ? <ArchiveRestore /> : <Archive />}{item.archived ? "Unarchive" : "Archive"}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirm("delete")}><Trash2 />Delete…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const badges = (
    <>
      {item.archived && <span className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1.2px_var(--border)]">archived</span>}
      {allSuspended && <span className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1.2px_var(--border)]">suspended</span>}
    </>
  );
  const back = closeAlways || phone;

  return (
    <div className="@container/insp min-h-full w-full">
    <div className={cn("@container mx-auto flex min-h-full w-full flex-col px-[34px] pt-[22px] @max-[44rem]/insp:px-6 @max-[44rem]/insp:pt-[18px] phone:px-5! phone:pt-[calc(0.5rem+env(safe-area-inset-top))]!", closeX ? "max-w-[1100px]" : "max-w-[760px]", phone && !closeAlways && "browse-slide")}>
      {phone && !closeAlways ? (
        <>
          <div className="-mx-2 mb-1 flex h-12 items-center gap-1">
            <button className="flex items-center gap-0.5 py-1.5 pr-2 pl-0.5 text-base font-semibold" onClick={onBack} aria-label="Back to list"><ChevronLeft className="size-6" />Browse</button>
            <div className="flex-1" />
            {actions}
          </div>
          <div className="mb-3 flex items-center gap-2"><DeckCrumb deck={item.deck} />{badges}</div>
        </>
      ) : (
        <div className="mb-3.5 flex min-h-10 items-center gap-2">
          {back && <Button size="icon" variant="ghost" className="-ml-2 size-9" onClick={onBack} aria-label="Back to list"><ArrowLeft className="size-4" /></Button>}
          <DeckCrumb deck={item.deck} className="flex-1 @max-[36rem]:hidden" />
          <DeckCrumb deck={item.deck} leafOnly className="hidden flex-1 @max-[36rem]:flex" />
          {badges}
          {actions}
          {closeX && <Button size="icon" variant="ghost" className="-mr-2 size-9 text-muted-foreground" onClick={onBack} aria-label="Close" title="Close · Esc"><X className="size-5" /></Button>}
        </div>
      )}

      <ItemPreview item={item} type={type} fields={draft.fields} dirty={dirty} version={version} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />

      <div role="tablist" className="mt-[22px] mb-[18px] flex w-max max-w-full gap-1 rounded-[11px] bg-secondary p-[3px] max-md:grid max-md:w-auto max-md:grid-cols-3">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("inline-flex items-center justify-center gap-1.5 rounded-[9px] px-3.5 py-[7px] text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground", tab === k && "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),inset_0_0_0_1px_var(--border)] dark:bg-[color-mix(in_oklab,var(--foreground)_14%,var(--card))] dark:shadow-none")}>
            {label}{k === "history" && count > 0 && <small className="text-xs tabular text-muted-foreground/70">{count}</small>}
          </button>
        ))}
      </div>

      {tab === "edit" && (
        <div className="flex flex-col gap-4 pb-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[14.5px] font-semibold">Content</h3>
            <ItemAiEdit key={item.id} id={item.id} fields={draft.fields} specs={type.fields} onApply={(fields) => setDraft((current) => current && { ...current, fields })} />
          </div>
          <div className="browse-fields">
            <FieldEditor key={item.id} fields={type.fields} value={draft.fields} onChange={(fields) => setDraft((current) => current && { ...current, fields })} onMediaPendingChange={setMediaPending} />
          </div>
          <div className="mt-1 grid gap-3.5 @xl:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label className="browse-label">Deck</label>
              <DeckInput value={draft.deck} decks={decks} onChange={(deck) => setDraft({ ...draft, deck })} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label className="browse-label">Tags</label>
              <TagInput value={draft.tags} known={tags} onChange={(t) => setDraft({ ...draft, tags: t })} />
            </div>
          </div>
          <div className="grid gap-3.5 @xl:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label className="browse-label">Notes <span className="font-medium text-muted-foreground/70">only you see these</span></label>
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="A hint, a mnemonic" className="h-11 rounded-[11px]" />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label className="browse-label">Source</label>
              <Input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="Where this comes from" className="h-11 rounded-[11px]" />
            </div>
          </div>
          <div className="text-[13px] text-muted-foreground">
            Card type: <button className="font-semibold text-foreground underline-offset-2 hover:underline" onClick={() => navigate(`/types/${encodeURIComponent(item.type)}`)}>{type.name}</button>
            {" · "}added {relative(item.created)}
            {" · "}<button className="font-mono text-xs hover:text-foreground" title="Copy id" onClick={() => { navigator.clipboard.writeText(item.id); toast("Copied id"); }}>{item.id}</button>
          </div>
        </div>
      )}
      {tab === "memory" && <MemoryPanel item={item} onPractice={practice} onForget={() => setConfirm("forget")} onSuspend={suspend} />}
      {tab === "history" && <HistoryPanel item={item} />}

      <div
        data-savebar
        className={cn(
          "browse-savebar sticky bottom-0 z-[3] -mx-[34px] mt-auto flex items-center gap-2.5 px-[34px] pt-3.5 pb-[18px] transition-[opacity,transform] duration-200 @max-[44rem]/insp:-mx-6 @max-[44rem]/insp:px-6 phone:-mx-5! phone:px-5!",
          gutter && (fun ? "desktop:pr-[112px]!" : "desktop:pr-[84px]!"),
          dirty || mediaPending ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        <span className="text-[13.5px] font-medium text-muted-foreground">{mediaPending ? "Copying media…" : "Unsaved changes"}</span>
        <div className="flex-1" />
        <Button variant="outline" className="h-10 rounded-[11px] px-4" disabled={mediaPending} onClick={() => setDraft(draftOf(item))}>Discard</Button>
        <Button className="h-10 gap-1.5 rounded-[11px] px-[18px] font-semibold" onClick={save} disabled={saving || mediaPending}>{saving && <Loader2 className="size-4 animate-spin" />}Save <kbd className="hidden text-[10px] opacity-70 sm:inline">{navigator.platform.startsWith("Mac") ? "⌘S" : "Ctrl S"}</kbd></Button>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? "Delete this card?" : "Start over?"}</AlertDialogTitle>
            <AlertDialogDescription>{confirm === "delete" ? "This removes it with all its review history. Archiving hides it and keeps the history." : "It comes back as a new card. Its past reviews stay in History."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm === "delete" ? "destructive" : "default"} onClick={() => (confirm === "delete" ? del() : forget())}>{confirm === "delete" ? "Delete" : "Start over"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
}

export function DeckInput({ value, decks, onChange }: { value: string; decks: string[]; onChange(v: string): void }) {
  const id = useMemo(() => `decks-${Math.random().toString(36).slice(2)}`, []);
  return (
    <>
      <Input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Deck::Subdeck" />
      <datalist id={id}>{decks.map((d) => <option key={d} value={d} />)}</datalist>
    </>
  );
}

export function TagInput({ value, known, onChange }: { value: string[]; known: string[]; onChange(v: string[]): void }) {
  const [text, setText] = useState("");
  const id = useMemo(() => `tags-${Math.random().toString(36).slice(2)}`, []);
  const add = (t: string) => {
    const tag = t.trim().replace(/\s+/g, "-");
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setText("");
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1.5 focus-within:border-ring">
      {value.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
          {t}
          <button onClick={() => onChange(value.filter((x) => x !== t))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${t}`}><X className="size-3" /></button>
        </span>
      ))}
      <input
        list={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === " ") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text && add(text)}
        className="min-w-24 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground"
        placeholder={value.length ? "" : "Add tags, use :: for subtags"}
      />
      <datalist id={id}>{known.map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}

export function NewItemDialog({ open, onOpenChange, decks, types, onCreated, defaultDeck }: { open: boolean; onOpenChange(o: boolean): void; decks: string[]; types: TypeSummary[]; onCreated(id: string): void; defaultDeck?: string }) {
  const [type, setType] = useState("basic");
  const [deck, setDeck] = useState("");
  const [id, setId] = useState("");
  const [def, setDef] = useState<CardType | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [mediaPending, setMediaPending] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    if (open) api.type(type).then(setDef);
  }, [type, open]);
  useEffect(() => {
    if (open && !deck && (defaultDeck || decks.length)) setDeck(defaultDeck || decks[0]);
  }, [open, decks]);
  const occlusion = !!def?.fields.some((f) => f.editor === "occlusion");
  const create = async () => {
    if (mediaPending) return;
    const problem = occlusionProblem(def, fields);
    if (problem) return toast.error(problem);
    const slug = deck.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card";
    const itemId = id.trim() || `${slug}.${Date.now().toString(36)}`;
    try {
      await api.saveItem(itemId, { type, deck, fields, tags });
      onOpenChange(false);
      setFields({});
      setId("");
      onCreated(itemId);
      toast.success("Card added");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[90dvh] overflow-y-auto", occlusion ? "sm:max-w-[min(72rem,calc(100vw-2rem))]" : "sm:max-w-2xl")}>
        <DialogHeader><DialogTitle>Add a card</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Type</label>
            <Select value={type} disabled={mediaPending} onValueChange={(v) => { setType(v); setFields({}); }}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Deck</label>
            <DeckInput value={deck} decks={decks} onChange={setDeck} />
          </div>
        </div>
        {def?.description && <p className="-mt-1 text-xs text-muted-foreground">{def.description}</p>}
        {/* An image occlusion note starts on the image: tags come after the boxes. */}
        {!occlusion && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Tags</label>
            <TagInput value={tags} known={[]} onChange={setTags} />
          </div>
        )}
        {def && def.id === type && <div className="border-t pt-4"><FieldEditor key={type} fields={def.fields} value={fields} onChange={setFields} onMediaPendingChange={setMediaPending} /></div>}
        {occlusion && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Tags</label>
            <TagInput value={tags} known={[]} onChange={setTags} />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">ID <span className="font-normal text-muted-foreground">(optional, keeps the card matched across imports)</span></label>
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="course.topic.slug" className="font-mono text-[13px]" />
        </div>
        <DialogFooter className={cn(occlusion && "sticky -bottom-6 -mx-6 -mb-6 border-t bg-background px-6 py-3")}>
          {occlusion && <span className="mr-auto self-center text-xs text-muted-foreground">{Array.isArray(fields.boxes) && fields.boxes.length ? "Each box or group becomes a card" : "Draw boxes over the image first"}</span>}
          <Button disabled={mediaPending} onClick={create} className="gap-1.5"><Check className="size-4" />Add card</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveDialog({ open, onOpenChange, decks, onMove }: { open: boolean; onOpenChange(o: boolean): void; decks: string[]; onMove(d: string): void }) {
  const [deck, setDeck] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Move to deck</DialogTitle></DialogHeader>
        <DeckInput value={deck} decks={decks} onChange={setDeck} />
        <DialogFooter><Button disabled={!deck.trim()} onClick={() => { onMove(deck.trim()); onOpenChange(false); }}>Move</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TagDialog({ open, onOpenChange, tags, onApply }: { open: boolean; onOpenChange(o: boolean): void; tags: string[]; onApply(add: string[], remove: string[]): void }) {
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit tags</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-1.5"><label className="text-sm font-medium">Add</label><TagInput value={add} known={tags} onChange={setAdd} /></div>
        <div className="flex flex-col gap-1.5"><label className="text-sm font-medium">Remove</label><TagInput value={remove} known={tags} onChange={setRemove} /></div>
        <DialogFooter><Button onClick={() => { onApply(add, remove); onOpenChange(false); setAdd([]); setRemove([]); }}>Apply</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
