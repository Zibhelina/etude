import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowUpToLine, BarChart3, CalendarClock, Check, ChevronDown, ChevronRight, Download, Eye, FastForward, FolderInput, Library, Pencil, Play, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/markdown";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { BulkBar, CheckBox, groupItems, ItemEditor, ItemRow, NewItemDialog, OrderSelect, SearchHints } from "@/components/item-editor";
import { DeckOptions, formatDeadline, type DeckFull } from "@/components/deck-options";
import { api, type DeckNode, type LearnerSummary, type Preset, type SearchRow, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Block, Breadcrumb, EmptyState, LinkRow, Page, Section } from "@/components/page";
import { TreeGuides } from "@/pages/decks";
import { childrenOf, clashes, leafOf, moveDeck, MoveDeckDialog, parentOf } from "@/components/move-deck";
import { usePhone } from "@/lib/phone";
import { DeckList } from "@/components/phone-decks";
import { Mark, PhoneTitle } from "@/components/phone-shell";
import { useDeckActions } from "@/components/deck-actions";

const enc = encodeURIComponent;

export function DeckPage({ name }: { name: string }) {
  const [deck, setDeck] = useState<DeckFull | null>(null);
  const [decks, setDecks] = useState<DeckNode[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get("tab") ?? "overview");
  const phone = usePhone();

  // Keep the open tab in the URL so reloads and links land on it.
  const switchTab = (t: string) => {
    setTab(t);
    const p = new URLSearchParams(location.search);
    if (t === "overview") p.delete("tab");
    else p.set("tab", t);
    if (t !== "cards") p.delete("item");
    history.replaceState(null, "", `/deck?${p}`);
  };

  const loadTags = () =>
    api
      .search(`deck:"${name}"`, { limit: 1000 })
      .then((r) => setTags([...new Set(r.rows.flatMap((x) => x.tags))].sort()))
      .catch(() => {});

  const reload = async () => {
    try {
      const [d, all, p] = await Promise.all([api.deck(name), api.decks(true), api.presets()]);
      setDeck(d);
      setDecks(all.filter((node) => node.archived === d.archived));
      setPresets(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    reload();
    // Only tags used inside this deck are useful for custom study.
    loadTags();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [name]);

  const node = decks.find((d) => d.name === deck?.name);
  const children = useMemo(() => (deck ? decks.filter((d) => d.name.startsWith(deck.name + "::")) : []), [decks, deck?.name]);

  if (error)
    return (
      <Page>
        <EmptyState title="Couldn't open this deck" action={<Button variant="outline" size="sm" onClick={() => navigate("/")}>Back to decks</Button>}>{error}</EmptyState>
      </Page>
    );
  if (!deck)
    return (
      <Page>
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-8 w-72 animate-pulse rounded bg-muted" />
        <div className="mt-8 h-24 animate-pulse rounded-xl bg-muted/60" />
      </Page>
    );

  const parts = deck.name.split("::");
  const work = node ? node.new + node.learning + node.review : 0;
  const back = parts.length > 1 ? parts.slice(0, -1).join("::") : "";
  const overviewText = (
    <>
          <TextSection
            title="Description"
            empty="No description. Add notes about what this deck covers, sources, or how to study it."
            value={deck.description}
            markdown
            onSave={async (description) => {
              await api.updateDeck(deck.name, { description });
              await reload();
            }}
          />
          <TextSection
            title="AI grading instructions"
            help={
              <>
                Sent to the AI grader for every card in this deck{children.length ? " and its subdecks" : ""}. They stack with parent-deck and tag instructions and each card's own rubric.
              </>
            }
            empty="Add instructions, for example: “Accept answers in ms or s if the conversion is right. Penalize missing units.”"
            value={deck.instructions}
            mono
            onSave={async (instructions) => {
              await api.updateDeck(deck.name, { instructions });
              await reload();
            }}
          />
    </>
  );
  const cardsTab = (
          <DeckCards
            deck={deck.name}
            hasChildren={children.length > 0}
            active={tab === "cards"}
            onChanged={() => {
              reload();
              loadTags();
            }}
          />
  );
  const optionsTab = <DeckOptions deck={deck} decks={decks} presets={presets} onChanged={reload} />;
  const manageTab = <DangerZone deck={deck} decks={decks} hasChildren={children.length > 0} onMoved={(to) => navigate(`/deck?name=${enc(to)}&tab=manage`, { replace: true })} />;

  if (phone)
    return (
      <div>
        <PhoneTitle
          back={{ label: deck.archived ? "Archive" : back ? leafOf(back) : "Decks", onClick: () => navigate(deck.archived ? "/archive" : back ? `/deck?name=${enc(back)}` : "/") }}
          kicker={parts.length > 2 ? parts.slice(0, -2).join(" › ") : undefined}
          title={leafOf(deck.name)}
          className="pb-3"
        />
        <div className="px-5">
          <Header deck={deck} node={node} work={work} tags={tags} phone onRenamed={(to) => navigate(`/deck?name=${enc(to)}`, { replace: true })} onAddCards={tab === "cards" ? undefined : () => switchTab("cards")} />
        </div>
        <Tabs value={tab} onValueChange={switchTab} className="mt-7">
          <div className="sticky top-[calc(3rem+env(safe-area-inset-top))] z-10 border-b bg-background/95 px-5 backdrop-blur">
            <TabsList variant="line" className="h-11 w-full justify-start gap-5 bg-transparent p-0">
              {(["overview", "cards", "options", "manage"] as const).map((t) => (
                <TabsTrigger key={t} value={t} className="h-11 flex-none rounded-none border-0 px-0 text-[15px] capitalize shadow-none after:!bottom-0 after:bg-highlight data-[state=active]:bg-transparent data-[state=active]:shadow-none">{t}</TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="overview" className="mt-0 flex flex-col gap-8 pb-4">
            {children.length > 0 && <DeckList decks={decks} parent={deck.name} label="Subdecks" onChanged={reload} />}
            <div className="flex flex-col gap-8 px-5">
              {overviewText}
            </div>
          </TabsContent>
          <TabsContent value="cards" className="mt-4 px-4">{cardsTab}</TabsContent>
          <TabsContent value="options" className="mt-6 px-4">{optionsTab}</TabsContent>
          <TabsContent value="manage" className="mt-6 px-4">{manageTab}</TabsContent>
        </Tabs>
      </div>
    );

  return (
    <Page>
      <Breadcrumb items={[{ label: deck.archived ? "Archive" : "Decks", onClick: () => navigate(deck.archived ? "/archive" : "/") }, ...parts.slice(0, -1).map((p, i) => ({ label: p, onClick: () => navigate(`/deck?name=${enc(parts.slice(0, i + 1).join("::"))}`) }))]} />
      <Header deck={deck} node={node} work={work} tags={tags} onRenamed={(to) => navigate(`/deck?name=${enc(to)}`, { replace: true })} onAddCards={tab === "cards" ? undefined : () => switchTab("cards")} />

      <Tabs value={tab} onValueChange={switchTab} className="mt-8">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
          <TabsTrigger value="cards" className="px-4">Cards</TabsTrigger>
          <TabsTrigger value="options" className="px-4">Options</TabsTrigger>
          <TabsTrigger value="manage" className="px-4">Manage</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 flex flex-col gap-8">
          {children.length > 0 && <Subdecks parent={deck.name} decks={children} />}
          {overviewText}
        </TabsContent>

        <TabsContent value="cards" className="mt-6">
          {cardsTab}
        </TabsContent>

        <TabsContent value="options" className="mt-6">
          {optionsTab}
        </TabsContent>

        <TabsContent value="manage" className="mt-6">
          {manageTab}
        </TabsContent>
      </Tabs>
    </Page>
  );
}

const CARDS_PAGE = 200;

/** Every card in the deck and its subdecks, with the same rows, filters and editor as Browse. */
function DeckCards({ deck, hasChildren, active, onChanged }: { deck: string; hasChildren: boolean; active: boolean; onChanged(): void }) {
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("relevance");
  const [limit, setLimit] = useState(CARDS_PAGE);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("item"));
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [decks, setDecks] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const scoped = query.trim() ? `deck:"${deck}" (${query.trim()})` : `deck:"${deck}"`;
  const run = useCallback(async () => {
    try {
      const r = await api.search(scoped, { limit, order });
      setRows(r.rows);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message.replace(/^search: /, ""));
    }
  }, [scoped, limit, order]);

  useEffect(() => {
    const t = setTimeout(run, 180);
    return () => clearTimeout(t);
  }, [run]);
  useEffect(() => setLimit(CARDS_PAGE), [query, order]);
  // A selection made under another search would act on cards that are no longer listed.
  useEffect(() => setChecked(new Set()), [query]);

  const reloadMeta = () => {
    api.decks().then((d) => setDecks(d.map((x) => x.name)));
    api.tags().then((t) => setTags(t.map((x) => x.tag)));
    api.types().then(setTypes);
  };
  useEffect(reloadMeta, []);

  const open = (id: string | null) => {
    setSelected(id);
    const p = new URLSearchParams(location.search);
    if (id) p.set("item", id);
    else p.delete("item");
    history.replaceState(null, "", `/deck?${p}`);
  };

  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !selected) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active, selected]);

  const changed = () => {
    run();
    reloadMeta();
    onChanged();
  };

  const items = useMemo(() => groupItems(rows), [rows]);
  const allChecked = items.length > 0 && items.every((r) => checked.has(r.itemId));
  const emptyDeck = total === 0 && !query.trim();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this deck"
              aria-label="Search this deck"
              className={cn("h-10 pl-9", query && "pr-10 font-mono text-[13px]")}
            />
            {query && (
              <button className="absolute top-1 right-1 flex size-8 items-center justify-center rounded text-muted-foreground hover:text-foreground" onClick={() => setQuery("")} aria-label="Clear search">
                <X className="size-4" />
              </button>
            )}
          </div>
          <Button variant="outline" className="h-10 gap-1.5 px-3" onClick={() => setCreating(true)} aria-label="Add a card"><Plus className="size-4" /><span className="hidden min-[420px]:inline">Add</span></Button>
        </div>
        {!emptyDeck && <SearchHints onPick={(h) => setQuery((q) => (q ? `${q} ${h}` : h))} />}
      </div>

      {!emptyDeck && (
        <Section>
          <div className="flex min-h-11 items-center gap-2.5 border-b px-3 text-xs text-muted-foreground sm:px-4">
            <CheckBox checked={allChecked} label="Select all" onClick={() => setChecked(allChecked ? new Set() : new Set(items.map((r) => r.itemId)))} />
            <span className="tabular min-w-0 truncate">
              {error ? <span className="text-destructive">{error}</span> : total == null ? "Loading…" : `${total} card${total === 1 ? "" : "s"}${total > rows.length ? `, showing ${rows.length}` : ""}`}
            </span>
            <div className="flex-1" />
            <OrderSelect value={order} onChange={setOrder} />
          </div>
          <BulkBar
            checked={checked}
            rows={rows}
            decks={decks}
            tags={tags}
            onClear={() => setChecked(new Set())}
            onDone={changed}
            onDeleted={(ids) => selected && ids.includes(selected) && open(null)}
          />
          {items.map((r) => (
            <ItemRow
              key={r.itemId}
              row={r}
              active={selected === r.itemId}
              checked={checked.has(r.itemId)}
              hideDeck={!hasChildren}
              className="min-h-14 py-3 last:border-b-0 sm:px-4"
              onOpen={() => open(r.itemId)}
              onToggle={() =>
                setChecked((prev) => {
                  const n = new Set(prev);
                  n.has(r.itemId) ? n.delete(r.itemId) : n.add(r.itemId);
                  return n;
                })
              }
            />
          ))}
          {total != null && !items.length && !error && (
            <EmptyState inset title="No matches" action={<Button variant="outline" size="sm" onClick={() => setQuery("")}>Clear search</Button>}>No cards in this deck match that search.</EmptyState>
          )}
          {total != null && total > rows.length && (
            <button className="flex h-12 w-full items-center justify-center border-t text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground" onClick={() => setLimit((l) => Math.min(l + CARDS_PAGE, 1000))}>
              Show {Math.min(CARDS_PAGE, total - rows.length)} more
            </button>
          )}
        </Section>
      )}

      {emptyDeck && (
        <EmptyState title="No cards in this deck yet" action={<Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus className="size-4" />Add a card</Button>}>
          Add one here, or import a pack from the Decks page.
        </EmptyState>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && open(null)}>
        <SheetContent side="right" showCloseButton={false} className="w-full gap-0 overflow-y-auto p-0 sm:max-w-none lg:w-[min(56rem,calc(100vw-8rem))]">
          <SheetTitle className="sr-only">Edit card</SheetTitle>
          <SheetDescription className="sr-only">Preview, edit and reschedule this card.</SheetDescription>
          {selected && (
            <div className="pb-[env(safe-area-inset-bottom)]">
              <ItemEditor
                key={selected}
                id={selected}
                closeAlways
                onBack={() => open(null)}
                decks={decks}
                tags={tags}
                onSaved={changed}
                onDeleted={() => {
                  open(null);
                  changed();
                }}
                onDuplicate={(newId) => {
                  open(newId);
                  changed();
                }}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <NewItemDialog open={creating} onOpenChange={setCreating} decks={decks} types={types} defaultDeck={deck} onCreated={(id) => { open(id); changed(); }} />
    </div>
  );
}

function Header({ deck, node, work, tags, onRenamed, onAddCards, phone }: { deck: DeckFull; node?: DeckNode; work: number; tags: string[]; onRenamed(to: string): void; onAddCards?(): void; phone?: boolean }) {
  // The deck list's ⋯ → Rename lands here with ?rename=1.
  const [editing, setEditing] = useState(() => new URLSearchParams(location.search).has("rename"));
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.has("rename")) { p.delete("rename"); history.replaceState(null, "", `/deck?${p}`); }
  }, []);
  const leaf = deck.name.split("::").at(-1)!;
  const parent = deck.name.split("::").slice(0, -1).join("::");
  const [text, setText] = useState(leaf);
  useEffect(() => setText(leaf), [leaf]);

  const rename = async () => {
    const t = text.trim();
    if (!t || t === leaf) return setEditing(false);
    // Typing "::" moves the deck; a bare name stays under the same parent.
    const to = t.includes("::") ? t : parent ? `${parent}::${t}` : t;
    try {
      const d = await api.updateDeck(deck.name, { name: to });
      toast.success(`Renamed to ${d.name.split("::").pop()}`);
      setEditing(false);
      onRenamed(d.name);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const deadline = deck.resolved.deadline && new Date(deck.resolved.deadline) > new Date() ? deck.resolved.deadline : null;

  return (
    <header>
      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename();
              if (e.key === "Escape") {
                setText(leaf);
                setEditing(false);
              }
            }}
            aria-label="Deck name"
            className="h-10 text-2xl font-semibold tracking-tight md:text-2xl"
          />
          <Button size="icon" className="size-10 shrink-0" onClick={rename} aria-label="Save name"><Check /></Button>
          <Button size="icon" variant="outline" className="size-10 shrink-0" onClick={() => { setText(leaf); setEditing(false); }} aria-label="Cancel"><X /></Button>
        </div>
      ) : phone ? null : (
        <div className="group flex items-start gap-1">
          <h1 className="min-w-0 py-0.5 text-2xl font-semibold tracking-tight break-words">{leaf}</h1>
          <Button variant="ghost" size="icon" className="-my-0.5 size-10 shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)} aria-label="Rename deck">
            <Pencil className="size-4" />
          </Button>
        </div>
      )}

      {phone && !editing && (
        <PhoneDeckStats deck={deck} node={node} onRename={() => setEditing(true)} />
      )}
      <div className={cn("mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between", phone && "mt-4")}>
        <div className={cn("grid grid-cols-4 items-end gap-x-4 sm:flex sm:gap-x-8", phone && "hidden")}>
          {deck.resolved.mode !== "watch" && (
            <>
              <Count label="New" value={node?.new ?? 0} cls="text-new" />
              <Count label="Learning" value={node?.learning ?? 0} cls="text-learn" />
              <Count label="Due" value={node?.review ?? 0} cls="text-review" />
            </>
          )}
          <div className={cn(deck.resolved.mode !== "watch" && "border-l pl-4 sm:pl-8")}>
            <div className="tabular text-3xl leading-none font-semibold">{node?.cards ?? 0}</div>
            <div className="mt-1.5 text-xs text-muted-foreground">Cards{node?.doneToday ? <span className="hidden sm:inline"> · {node.doneToday} done today</span> : ""}</div>
          </div>
        </div>
        <div className="flex gap-2">
          {deck.archived ? <span className="inline-flex items-center gap-2 py-2 text-sm text-muted-foreground"><Archive className="size-4" />Archived</span> : deck.resolved.mode === "watch" ? (
            <Button size="lg" className={cn("flex-1 gap-2 px-6 sm:flex-none", phone && "h-[3.25rem] rounded-full text-[16px] pointer-coarse:h-[3.25rem]")} disabled={!node?.cards} title="A tour: each card can show an example answer, and nothing is scheduled" onClick={() => navigate(`/watch?deck=${enc(deck.name)}`)}>
              <Eye className="size-4" />Watch
            </Button>
          ) : (
            <>
              <CustomStudy deck={deck.name} tags={tags} disabled={!node?.cards} phone={phone} adaptive={deck.resolved.adaptiveChallenge || deck.resolved.adaptivePace} />
              {work || !node?.cards ? (
                <Button size="lg" className={cn("flex-1 gap-2 px-6 sm:flex-none", phone && "h-[3.25rem] rounded-full text-[16px] pointer-coarse:h-[3.25rem]")} disabled={!work} onClick={() => navigate(`/study?deck=${enc(deck.name)}`)}>
                  <Play className="size-4" />Practice
                </Button>
              ) : (
                <Button size="lg" className={cn("flex-1 gap-2 px-6 sm:flex-none", phone && "h-[3.25rem] rounded-full text-[16px] pointer-coarse:h-[3.25rem]")} title="Nothing due right now: review early. FSRS counts an early review for less." onClick={() => navigate(`/study?deck=${enc(deck.name)}&ahead=1`)}>
                  <FastForward className="size-4" />Practice ahead
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {!deck.archived && deadline && <Countdown deadline={deadline} margin={deck.resolved.deadlineMargin} />}
      {!deck.archived && deck.resolved.mode !== "watch" && (deck.resolved.adaptiveChallenge || deck.resolved.adaptivePace) && <AdaptiveSummary deck={deck.name} hasNew={(node?.new ?? 0) > 0} />}
      {node && node.cards === 0 && onAddCards && (
        <Section className="mt-6">
          <Block title="No cards yet" description="Add cards in the Cards tab, or import a pack from the Decks page." aside={<Button size="sm" onClick={onAddCards}>Add cards</Button>} stackAside />
        </Section>
      )}
      {!deck.archived && !work && node && node.cards > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{node.nextDue ? `Nothing due now. Next card ${relativeShort(node.nextDue)}.` : "Nothing due now."} Custom study works any time.</p>
      )}
    </header>
  );
}

/** Phone: the deck's counts as one quiet line with shape marks, and the total plus a rename button. */
function PhoneDeckStats({ deck, node, onRename }: { deck: DeckFull; node?: DeckNode; onRename(): void }) {
  const watch = deck.resolved.mode === "watch";
  const parts = [
    { v: node?.new ?? 0, label: "new", cls: "text-new", kind: "new" as const },
    { v: node?.learning ?? 0, label: "learning", cls: "text-learn", kind: "learn" as const },
    { v: node?.review ?? 0, label: "due", cls: "text-review", kind: "due" as const },
  ];
  return (
    <div className="flex items-end justify-between gap-3">
      {watch ? (
        <div className="text-[15px] text-muted-foreground">A tour of {node?.cards ?? 0} cards. Nothing is scheduled.</div>
      ) : (
        <div className="flex gap-5 max-[359px]:gap-3.5">
          {parts.map((p) => (
            <div key={p.label}>
              <div className={cn("inline-flex items-center gap-1.5 text-[1.5rem] leading-none font-medium tabular max-[359px]:text-[1.3rem]", p.v ? p.cls : "text-muted-foreground/45")}><Mark kind={p.kind} className="size-2.5" />{p.v}</div>
              <div className="mt-1.5 text-[12.5px] text-muted-foreground">{p.label}</div>
            </div>
          ))}
          <div className="border-l pl-5 max-[359px]:pl-3.5">
            <div className="text-[1.5rem] leading-none font-medium tabular">{node?.cards ?? 0}</div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">cards</div>
          </div>
        </div>
      )}
      <button onClick={onRename} aria-label="Rename deck" className="-mr-2 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"><Pencil className="size-[18px]" /></button>
    </div>
  );
}

function relativeShort(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function Count({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div>
      <div className={cn("tabular text-3xl leading-none font-semibold", value ? cls : "text-muted-foreground/40")}>{value}</div>
      <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Countdown({ deadline, margin }: { deadline: string; margin: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(deadline).getTime() - now;
  const d = Math.floor(ms / 86400_000);
  const h = Math.floor((ms % 86400_000) / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const left = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return (
    <div className="mt-6 flex items-center gap-3 rounded-xl border border-highlight/25 bg-highlight/[0.06] px-4 py-3">
      <CalendarClock className="size-5 shrink-0 text-highlight" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="tabular font-medium text-highlight">{left}</span>
        <span className="text-muted-foreground"> until the deadline · <span className="whitespace-nowrap">{formatDeadline(deadline)}</span></span>
        <div className="text-xs text-muted-foreground">Exam mode is on: every card comes back at least once, no later than {margin}h before.</div>
      </div>
    </div>
  );
}

function CustomStudy({ deck, tags, disabled, phone, adaptive }: { deck: string; tags: string[]; disabled?: boolean; phone?: boolean; adaptive?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = (query: string) => navigate(`/study?deck=${enc(deck)}&q=${enc(query)}`);

  useEffect(() => {
    if (!open || !q.trim()) {
      setCount(null);
      setErr(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .search(`deck:"${deck}" (${q})`, { limit: 1 })
        .then((r) => {
          setCount(r.total);
          setErr(null);
        })
        .catch((e) => {
          setCount(null);
          setErr((e as Error).message.replace(/^search: /, ""));
        });
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  // Group tags by their first segment so long tag lists stay navigable.
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tags) {
      const head = t.split("::")[0];
      m.set(head, [...(m.get(head) ?? []), t]);
    }
    return [...m.entries()];
  }, [tags]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="lg" className={cn("flex-1 gap-1.5 px-4 sm:flex-none", phone && "h-[3.25rem] flex-none rounded-full px-5 text-[15px] pointer-coarse:h-[3.25rem]")} disabled={disabled}>{phone ? "Custom" : "Custom study"}<ChevronDown className="size-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 sm:w-64" collisionPadding={16}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Practice a slice of this deck</DropdownMenuLabel>
          <DropdownMenuItem className="h-10" onClick={() => go("is:due")}>Due reviews only</DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={() => go("is:new")}>New cards only</DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={() => go("rated:1:1")}>Failed today</DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={() => go("prop:lapses>=2")}>Frequently forgotten</DropdownMenuItem>
          {adaptive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="h-10" onClick={() => navigate(`/study?${new URLSearchParams({ deck, placement: String(Date.now()) })}`)}>
                Find my level
                <span className="ml-auto text-xs text-muted-foreground">placement</span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="h-10" disabled={!tags.length}>By tag</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
              {groups.map(([head, list], gi) => (
                <div key={head}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  {list.length > 1 && (
                    <DropdownMenuItem className="h-9 font-medium" onClick={() => go(`tag:${head}`)}>{head} <span className="ml-auto text-xs text-muted-foreground">all</span></DropdownMenuItem>
                  )}
                  {list.map((t) => (
                    <DropdownMenuItem key={t} className={cn("h-9 font-mono text-[12.5px]", list.length > 1 && "pl-5")} onClick={() => go(`tag:${t}`)}>{list.length > 1 ? t.slice(head.length + 2) || t : t}</DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="h-10" onClick={() => setOpen(true)}><Search />Any search…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom study</DialogTitle>
            <DialogDescription>Any search, limited to this deck.</DialogDescription>
          </DialogHeader>
          <div>
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && !err && go(q.trim())} placeholder="tag:exam::core is:due" className="h-10 font-mono text-[13px]" />
            <p className={cn("mt-1.5 min-h-4 text-xs", err ? "text-destructive" : "text-muted-foreground")}>
              {err ?? (count != null ? `${count} matching card${count === 1 ? "" : "s"}` : "is:due · is:new · tag:x · rated:1:1 · prop:lapses>=2 · type:numeric")}
            </p>
          </div>
          <DialogFooter>
            <Button className="h-10" disabled={!q.trim() || !!err || count === 0} onClick={() => go(q.trim())}><Play className="size-4" />Practice</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Subdecks({ parent, decks }: { parent: string; decks: DeckNode[] }) {
  const depth0 = parent.split("::").length;
  return (
    <Section title="Subdecks" aside={<span className="hidden tabular sm:inline">New · Learn · Due</span>}>
      {decks.map((d) => {
        const depth = d.name.split("::").length - depth0 - 1;
        return (
          <button
            key={d.id}
            onClick={() => navigate(`/deck?name=${enc(d.name)}`)}
            className="flex min-h-12 w-full items-stretch gap-2 border-b pr-3 pl-4 text-left transition-colors last:border-b-0 hover:bg-accent/40 sm:pr-4 sm:pl-5"
          >
            <TreeGuides depth={depth} />
            <span className="flex min-w-0 flex-1 items-center py-2.5 text-[0.95rem] leading-snug">{d.name.split("::").pop()}</span>
            <span className="tabular grid grid-cols-[repeat(3,2rem)] items-center text-right text-sm sm:grid-cols-[repeat(3,3.5rem)]" aria-label={`${d.new} new, ${d.learning} learning, ${d.review} due`}>
              <span className={d.new ? "text-new" : "text-muted-foreground/40"}>{d.new}</span>
              <span className={d.learning ? "text-learn" : "text-muted-foreground/40"}>{d.learning}</span>
              <span className={d.review ? "text-review" : "text-muted-foreground/40"}>{d.review}</span>
            </span>
            <ChevronRight className="my-auto size-4 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
    </Section>
  );
}

function TextSection({ title, help, empty, value, markdown, mono, onSave }: { title: string; help?: React.ReactNode; empty: string; value: string; markdown?: boolean; mono?: boolean; onSave(v: string): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [tab, setTab] = useState("write");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(text);
      setEditing(false);
      toast.success(`${title} saved`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      bare
      title={title}
      description={help}
      aside={
        !editing && (
          <Button variant="ghost" size="sm" className="-my-1.5 -mr-2 gap-1.5 text-muted-foreground" onClick={() => { setEditing(true); setTab("write"); }}>
            <Pencil className="size-3.5" />Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div className="rounded-xl border bg-card/40 p-3">
          {markdown ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="mb-3">
                <TabsTrigger value="write" className="px-3">Write</TabsTrigger>
                <TabsTrigger value="preview" className="px-3">Preview</TabsTrigger>
              </TabsList>
              <TabsContent value="write">
                <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} className="min-h-40" placeholder="Markdown and $math$ work here." />
              </TabsContent>
              <TabsContent value="preview">
                <div className="min-h-40 rounded-md border px-3 py-2 text-sm">{text.trim() ? <Markdown>{text}</Markdown> : <span className="text-muted-foreground">Nothing to preview.</span>}</div>
              </TabsContent>
            </Tabs>
          ) : (
            <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} className={cn("min-h-32", mono && "font-mono text-[13px]")} />
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" className="h-10" onClick={() => { setText(value); setEditing(false); }}>Cancel</Button>
            <Button className="h-10" disabled={busy || text === value} onClick={save}>Save</Button>
          </div>
        </div>
      ) : value.trim() ? (
        <div className={cn("rounded-xl border bg-card/40 px-4 py-3 text-sm", mono && "font-mono text-[13px] whitespace-pre-wrap")}>{markdown ? <Markdown>{value}</Markdown> : value}</div>
      ) : (
        <button className="w-full rounded-xl border border-dashed px-4 py-4 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground" onClick={() => setEditing(true)}>
          {empty}
        </button>
      )}
    </Section>
  );
}

function DangerZone({ deck, decks, hasChildren, onMoved }: { deck: DeckFull; decks: DeckNode[]; hasChildren: boolean; onMoved(to: string): void }) {
  const [moving, setMoving] = useState(false);
  const parent = parentOf(deck.name);
  const topClash = !!parent && clashes(decks, deck.name, "");
  const deckActions = useDeckActions(() => navigate(deck.archived ? "/archive" : "/"));
  return (
    <div className="flex flex-col gap-8">
      <Section title="Elsewhere">
        <LinkRow icon={Library} title="Browse cards" description="List, search and edit every card in this deck." onClick={() => navigate(`/browse?q=${enc(`deck:"${deck.name}"`)}`)} />
        <LinkRow icon={BarChart3} title="Statistics" description="Retention, forecast and weakest tags for this deck." onClick={() => navigate(`/stats?deck=${enc(deck.name)}`)} />
      </Section>
      <Section title="Place in the tree">
        <Block
          stackAside
          title="Move deck"
          description={parent ? <>Inside <span className="text-foreground">{leafOf(parent)}</span>. Subdecks, cards and history move with it.</> : "A top-level deck. Put it inside another deck; subdecks, cards and history move with it."}
          aside={
            <div className="flex flex-wrap gap-2">
              {parent && (
                <Button variant="outline" size="sm" className="gap-1.5" disabled={topClash} title={topClash ? `There's already a top-level ${leafOf(deck.name)}` : undefined} onClick={async () => {
                  const to = await moveDeck(decks, deck.name, "", childrenOf(decks, "").indexOf(deck.name.split("::")[0]) + 1, () => {});
                  if (to) onMoved(to);
                }}>
                  <ArrowUpToLine className="size-4" />Make it a deck of its own
                </Button>
              )}
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setMoving(true)}><FolderInput className="size-4" />Move to…</Button>
            </div>
          }
        />
      </Section>
      <MoveDeckDialog deck={moving ? deck.name : null} decks={decks} onOpenChange={setMoving} onMoved={onMoved} />
      <Section title="Export">
        <Block
          stackAside
          title="Export as a pack"
          description="A JSON pack with the items, subdecks, presets, tag notes and custom card types. Review history stays here."
          aside={
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <a href={api.exportUrl({ deck: deck.name })} download={`${deck.name.replace(/::/g, " - ").replace(/[/\\?%*:|"<>]/g, "")}.pack.json`}>
                <Download className="size-4" />Download
              </a>
            </Button>
          }
        />
      </Section>
      <Section title="Danger zone" tone="danger">
        <Block
          stackAside
          title={deck.archived ? "Move out of archive" : "Move to archive"}
          description={deck.archived ? "Returns this deck and its subdecks to the deck list and study." : "Hides this deck and its subdecks from the deck list and study. Cards keep their history."}
          aside={<Button variant="outline" size="sm" className="gap-1.5" disabled={deckActions.busy} onClick={() => deckActions.archive(deck.name, !deck.archived)}>{deck.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}{deck.archived ? "Restore" : "Archive"}</Button>}
        />
        <Block
          stackAside
          title="Delete deck"
          description={`Permanently removes the deck${hasChildren ? " and its subdecks" : ""}, including all cards and review history.`}
          aside={
            <Button variant="outline" size="sm" className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={deckActions.busy} onClick={() => deckActions.requestDelete(deck.name)}>
              <Trash2 className="size-4" />Delete
            </Button>
          }
        />
      </Section>
      {deckActions.deleteDialog}
    </div>
  );
}

/** Adaptive decks: per-skill levels, today's pace, and a placement offer before anything is learned. */
function AdaptiveSummary({ deck, hasNew }: { deck: string; hasNew: boolean }) {
  const [summary, setSummary] = useState<LearnerSummary | null>(null);
  useEffect(() => {
    api.skills(deck).then(setSummary, () => setSummary(null));
  }, [deck]);
  if (!summary?.adaptive) return null;
  const answered = summary.skills.some((s) => s.answers > 0);
  const placed = summary.skills.some((s) => s.placement);
  const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  return (
    <div className="mt-5 flex flex-col gap-3">
      {!answered && !placed && hasNew && (
        <Section>
          <Block
            title="Already know some of this?"
            description="Find your level in about ten minutes. Your answers count as real reviews, and earlier cards come up as quick checks. Or just start from the beginning."
            aside={<Button size="sm" onClick={() => navigate(`/study?${new URLSearchParams({ deck, placement: String(Date.now()) })}`)}>Find my level</Button>}
            stackAside
          />
        </Section>
      )}
      {(answered || placed) && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          {summary.skills.map((s) => (
            <span key={s.skill} title={s.answers ? `${s.answers} answers, ${pct(s.success)} right recently` : undefined}>
              <span className="text-foreground">{s.skill}</span> {s.level ? `${s.level.tag.split("::").pop()} · ${pct(s.level.progress)} stable` : pct(s.success)}
            </span>
          ))}
          {summary.known.items > 0 && (
            <span title={summary.known.assumed ? `${summary.known.assumed} of them from your placement, until you miss one` : undefined}>
              <span className="text-foreground">{summary.known.items}</span> known
            </span>
          )}
          {summary.pace && (
            <span title={summary.pace.reason}>
              <span className="text-foreground">{summary.pace.value}</span> new today
            </span>
          )}
        </div>
      )}
    </div>
  );
}
