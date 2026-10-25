// The card list rows, bulk actions and item editor shared by Browse and the deck page's Cards tab.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, Check, Copy, Dices, FolderInput, Loader2, MoreHorizontal, Pause, Play, RotateCcw, Save, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldEditor } from "@/components/field-editor";
import { CardPreview } from "@/components/card-preview";
import { Markdown } from "@/components/markdown";
import { api, humanInterval, relative, RATING_LABEL, STATE_NAMES, type CardType, type ItemDetail, type SearchRow, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

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

export function ItemRow({ row: r, active, checked, onOpen, onToggle, className, hideDeck }: { row: ItemRowData; active: boolean; checked: boolean; onOpen(): void; onToggle(): void; className?: string; hideDeck?: boolean }) {
  return (
    <div
      data-item-row
      onClick={onOpen}
      className={cn(
        "group flex cursor-pointer items-start gap-3 border-b px-3 py-3 transition-colors hover:bg-accent/40",
        (r.suspended || r.archived) && "opacity-55",
        className,
      )}
    >
      <CheckBox
        checked={checked}
        className="mt-0.5"
        label="Select"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("line-clamp-2 text-sm leading-snug", active && "font-medium text-highlight")} aria-current={active || undefined}>{r.title || <span className="text-muted-foreground">{r.itemId}</span>}</div>
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
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => bulk("delete")}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function SearchHints({ onPick }: { onPick(s: string): void }) {
  const hints = ["is:due", "is:new", "is:suspended", "prop:lapses>=2", "rated:1:1", "type:free"];
  return (
    <div className="flex flex-wrap gap-1.5">
      {hints.map((h) => (
        <button key={h} onClick={() => onPick(h)} className="h-7 rounded-md border px-2 font-mono text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground pointer-coarse:h-9 pointer-coarse:px-2.5">{h}</button>
      ))}
    </div>
  );
}

type Draft = { deck: string; fields: Record<string, unknown>; tags: string[]; source: string; notes: string };
const draftOf = (it: ItemDetail): Draft => ({ deck: it.deck, fields: it.fields, tags: it.tags, source: it.source, notes: it.notes });

/** `closeAlways` shows the back control at every size (for editors opened in a sheet); Browse only needs it on phones. */
export function ItemEditor({ id, decks, tags, onSaved, onDeleted, onDuplicate, onBack, closeAlways }: { id: string; decks: string[]; tags: string[]; onSaved(): void; onDeleted(): void; onDuplicate(id: string): void; onBack(): void; closeAlways?: boolean }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [type, setType] = useState<CardType | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState("edit");

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

  const save = useCallback(async () => {
    if (!item || !draft) return;
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
  }, [item, draft, onSaved]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, save]);

  const loadPreview = useCallback(async (seed: number, face: string) => {
    if (!item) return null;
    return api.previewItem(item.id, seed, face);
  }, [item?.id, version]);

  if (!item || !draft || !type) return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>;

  const archive = async () => {
    await api.bulkItems(item.archived ? "unarchive" : "archive", [item.id]);
    await load();
    onSaved();
  };
  const duplicate = async () => {
    const existing = new Set((await api.search(`id:${item.id}*`, { limit: 1000 })).rows.map((r) => r.itemId));
    let n = 2;
    while (existing.has(`${item.id}-${n}`)) n++;
    const newId = `${item.id}-${n}`;
    try {
      await api.saveItem(newId, { type: item.type, ...draft });
      toast.success(`Duplicated as ${newId}`);
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
  const allSuspended = item.cards.every((c) => c.suspended);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pt-4 sm:px-6 sm:pt-6 xl:px-10">
      <div className="flex items-start gap-2 sm:gap-3">
        <Button size="icon" variant="ghost" className={cn("-ml-2 size-9", !closeAlways && "md:hidden")} onClick={onBack} aria-label="Back to list"><ArrowLeft className="size-4" /></Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pt-1.5 md:pt-0">
          <Badge variant="outline" className="font-normal">{type.name}</Badge>
          {item.archived && <Badge variant="outline" className="font-normal text-muted-foreground">archived</Badge>}
          {allSuspended && <Badge variant="outline" className="font-normal text-muted-foreground">suspended</Badge>}
          <button className="truncate font-mono text-xs text-muted-foreground hover:text-foreground" title="Copy id" onClick={() => { navigator.clipboard.writeText(item.id); toast("Copied id"); }}>{item.id}</button>
        </div>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => navigate(`/study?card=${item.cards[0]?.id}&deck=${encodeURIComponent(item.deck)}`)}><Play className="size-4" />Study</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={duplicate}><Copy />Duplicate</DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate(`/types/${encodeURIComponent(item.type)}`)}><Dices />Edit card type</DropdownMenuItem>
            <DropdownMenuItem onClick={async () => { await api.bulkCards("reset", item.cards.map((c) => c.id)); load(); onSaved(); }}><RotateCcw />Forget scheduling</DropdownMenuItem>
            <DropdownMenuItem onClick={async () => { await api.bulkCards(allSuspended ? "unsuspend" : "suspend", item.cards.map((c) => c.id)); load(); onSaved(); }}>
              <Pause />{allSuspended ? "Unsuspend" : "Suspend"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={archive}>{item.archived ? <ArchiveRestore /> : <Archive />}{item.archived ? "Unarchive" : "Archive"}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={del}><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CardPreview
        src={`/frame/${encodeURIComponent(item.type)}?v=${encodeURIComponent(type.updated ?? "")}`}
        version={`${item.id}:${version}:${type.updated}`}
        load={loadPreview}
        faces={type.faces}
        generated={typeof item.fields.generator === "string"}
      />
      {dirty && <p className="-mt-3 text-xs text-muted-foreground">The preview shows the saved version. Save to see your edits.</p>}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="schedule">Scheduling</TabsTrigger>
          <TabsTrigger value="history">History <span className="ml-1 tabular text-muted-foreground">{item.reviews.length + item.attempts.length}</span></TabsTrigger>
        </TabsList>

        <TabsContent value="edit" className="mt-5 flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Deck</label>
              <DeckInput value={draft.deck} decks={decks} onChange={(deck) => setDraft({ ...draft, deck })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Source</label>
              <Input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="Where this comes from" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Tags</label>
            <TagInput value={draft.tags} known={tags} onChange={(t) => setDraft({ ...draft, tags: t })} />
          </div>
          <div className="border-t pt-5">
            <FieldEditor fields={type.fields} value={draft.fields} onChange={(fields) => setDraft({ ...draft, fields })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Notes</label>
            <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Private notes, not shown on the card" />
          </div>
        </TabsContent>

        <TabsContent value="schedule" className="mt-5">
          <div className="flex flex-col gap-3">
            {item.cards.map((c) => (
              <div key={c.id} className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-4">
                {item.cards.length > 1 && <div className="col-span-full text-xs font-medium text-muted-foreground">Face: {c.face}</div>}
                <Stat label="State" value={<span className={STATE_CLS[c.state]}>{c.suspended ? "suspended" : STATE_NAMES[c.state]}</span>} />
                <Stat label="Due" value={c.state === 0 ? "new" : relative(c.due)} />
                <Stat label="Recall now" value={c.retrievability == null ? "n/a" : `${Math.round(c.retrievability * 100)}%`} />
                <Stat label="Reviews" value={`${c.reps} (${c.lapses} lapses)`} />
                <Stat label="Stability" value={c.state === 0 ? "n/a" : `${Number(c.stability).toFixed(1)} days`} />
                <Stat label="Difficulty" value={c.state === 0 ? "n/a" : `${Number(c.difficulty).toFixed(1)} / 10`} />
                <Stat label="Last review" value={c.last_review ? relative(c.last_review) : "never"} />
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-5">
          <History item={item} />
        </TabsContent>
      </Tabs>

      <div className={cn("sticky bottom-0 -mx-4 mt-2 flex items-center gap-2 border-t bg-background px-4 py-3 transition-opacity sm:-mx-6 sm:px-6 xl:-mx-10 xl:px-10", dirty ? "opacity-100" : "pointer-events-none opacity-0")}>
        <span className="text-sm text-muted-foreground">Unsaved changes</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setDraft(draftOf(item))}>Discard</Button>
        <Button size="sm" className="gap-1.5" onClick={save} disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}Save <kbd className="hidden text-[10px] opacity-60 sm:inline">Ctrl S</kbd></Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular">{value}</div>
    </div>
  );
}

const fmtTs = (ts: string) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function History({ item }: { item: ItemDetail }) {
  const events = [
    ...item.reviews.map((r) => ({ kind: "review" as const, ts: r.ts, r })),
    ...item.attempts.map((a) => ({ kind: "attempt" as const, ts: a.ts, a })),
  ].sort((x, y) => y.ts.localeCompare(x.ts));
  if (!events.length) return <p className="text-sm text-muted-foreground">Not studied yet.</p>;
  return (
    <div className="flex flex-col gap-2 pb-4">
      {events.map((e, i) =>
        e.kind === "review" ? (
          <div key={i} className="flex items-center gap-3 px-1 text-sm">
            <span className="w-24 shrink-0 text-xs tabular text-muted-foreground sm:w-32">{fmtTs(e.ts)}</span>
            <span className={cn("font-medium", ["", "text-again", "text-hard", "text-good", "text-easy"][e.r.rating])}>{RATING_LABEL[e.r.rating as 1]}</span>
            {e.r.practice ? <span className="text-xs text-muted-foreground">practice</span> : <span className="text-xs text-muted-foreground">next in {humanInterval(e.r.due_after, new Date(e.ts))}</span>}
            {e.r.duration_ms != null && <span className="ml-auto text-xs tabular text-muted-foreground">{Math.round(e.r.duration_ms / 1000)}s</span>}
          </div>
        ) : (
          <div key={i} className="rounded-lg border p-3 text-sm">
            <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular">{fmtTs(e.ts)}</span>
              <span className={cn({ correct: "text-good", partial: "text-hard", incorrect: "text-again", ungraded: "" }[e.a.grade.verdict])}>
                {e.a.grade.verdict}{e.a.grade.score != null && e.a.grade.verdict === "partial" ? ` ${Math.round(e.a.grade.score * 100)}%` : ""}
              </span>
              {e.a.practice ? <span>· practice</span> : null}
              {e.a.grade.grader.model && <span className="truncate">· {e.a.grade.grader.model}</span>}
            </div>
            <AnswerView answer={e.a.answer} />
            {e.a.grade.feedback && <Markdown className="mt-2 border-t pt-2 text-[0.9rem] text-muted-foreground">{e.a.grade.feedback}</Markdown>}
          </div>
        ),
      )}
    </div>
  );
}

function AnswerView({ answer }: { answer: unknown }) {
  if (answer && typeof answer === "object" && typeof (answer as any).image === "string") {
    const img = (answer as any).image as string;
    return <img src={img.startsWith("media:") ? `/media/${img.slice(6)}` : img} alt="drawing" className="max-h-64 rounded border bg-white" />;
  }
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  return <pre className="whitespace-pre-wrap break-words font-mono text-[13px]">{text || <span className="text-muted-foreground">(empty)</span>}</pre>;
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
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    if (open) api.type(type).then(setDef);
  }, [type, open]);
  useEffect(() => {
    if (open && !deck && (defaultDeck || decks.length)) setDeck(defaultDeck || decks[0]);
  }, [open, decks]);
  const create = async () => {
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Add a card</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Type</label>
            <Select value={type} onValueChange={(v) => { setType(v); setFields({}); }}>
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
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Tags</label>
          <TagInput value={tags} known={[]} onChange={setTags} />
        </div>
        {def && <div className="border-t pt-4"><FieldEditor fields={def.fields} value={fields} onChange={setFields} /></div>}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">ID <span className="font-normal text-muted-foreground">(optional, keeps the card matched across imports)</span></label>
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="course.topic.slug" className="font-mono text-[13px]" />
        </div>
        <DialogFooter><Button onClick={create} className="gap-1.5"><Check className="size-4" />Add card</Button></DialogFooter>
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
