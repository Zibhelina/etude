import { useEffect, useMemo, useState } from "react";
import { Archive, BarChart3, CalendarClock, Check, ChevronDown, ChevronRight, Download, Library, Pencil, Play, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Markdown } from "@/components/markdown";
import { DeckOptions, formatDeadline, type DeckFull } from "@/components/deck-options";
import { api, type DeckNode, type Preset } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const enc = encodeURIComponent;

export function DeckPage({ name }: { name: string }) {
  const [deck, setDeck] = useState<DeckFull | null>(null);
  const [decks, setDecks] = useState<DeckNode[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [d, all, p] = await Promise.all([api.deck(name), api.decks(), api.presets()]);
      setDeck(d);
      setDecks(all);
      setPresets(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    reload();
    // Only tags used inside this deck are useful for custom study.
    api
      .search(`deck:"${name}"`, { limit: 1000 })
      .then((r) => setTags([...new Set(r.rows.flatMap((x) => x.tags))].sort()))
      .catch(() => {});
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [name]);

  const node = decks.find((d) => d.name === deck?.name);
  const children = useMemo(() => (deck ? decks.filter((d) => d.name.startsWith(deck.name + "::")) : []), [decks, deck?.name]);

  if (error)
    return (
      <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8">
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="text-muted-foreground">{error}</p>
          <Button variant="outline" className="mt-4 h-10" onClick={() => navigate("/")}>Back to decks</Button>
        </div>
      </div>
    );
  if (!deck)
    return (
      <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8">
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-8 w-72 animate-pulse rounded bg-muted" />
        <div className="mt-8 h-24 animate-pulse rounded-xl bg-muted/60" />
      </div>
    );

  const parts = deck.name.split("::");
  const work = node ? node.new + node.learning + node.review : 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-10">
      <Breadcrumb parts={parts} />
      <Header deck={deck} node={node} work={work} tags={tags} onRenamed={(to) => navigate(`/deck?name=${enc(to)}`, { replace: true })} />

      <Tabs defaultValue="overview" className="mt-8">
        <TabsList className="h-11 w-full sm:w-auto">
          <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
          <TabsTrigger value="options" className="px-4">Options</TabsTrigger>
          <TabsTrigger value="manage" className="px-4">Manage</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 flex flex-col gap-8">
          {children.length > 0 && <Subdecks parent={deck.name} decks={children} />}
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
        </TabsContent>

        <TabsContent value="options" className="mt-6">
          <DeckOptions deck={deck} decks={decks} presets={presets} onChanged={reload} />
        </TabsContent>

        <TabsContent value="manage" className="mt-6">
          <DangerZone deck={deck} hasChildren={children.length > 0} cards={node?.cards ?? 0} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Breadcrumb({ parts }: { parts: string[] }) {
  return (
    <nav aria-label="Breadcrumb" className="-ml-1 mb-2 flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <button className="rounded px-1 py-1 hover:text-foreground" onClick={() => navigate("/")}>Decks</button>
      {parts.slice(0, -1).map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3.5 shrink-0" />
          <button className="truncate rounded px-1 py-1 hover:text-foreground" onClick={() => navigate(`/deck?name=${enc(parts.slice(0, i + 1).join("::"))}`)}>{p}</button>
        </span>
      ))}
    </nav>
  );
}

function Header({ deck, node, work, tags, onRenamed }: { deck: DeckFull; node?: DeckNode; work: number; tags: string[]; onRenamed(to: string): void }) {
  const [editing, setEditing] = useState(false);
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
            className="h-11 text-xl font-semibold md:text-xl"
          />
          <Button size="icon" className="size-11" onClick={rename} aria-label="Save name"><Check /></Button>
          <Button size="icon" variant="ghost" className="size-11" onClick={() => { setText(leaf); setEditing(false); }} aria-label="Cancel"><X /></Button>
        </div>
      ) : (
        <div className="group flex items-start gap-1">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words sm:text-[1.75rem]">{leaf}</h1>
          <Button variant="ghost" size="icon" className="size-10 shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)} aria-label="Rename deck">
            <Pencil className="size-4" />
          </Button>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <Count label="New" value={node?.new ?? 0} cls="text-new" />
          <Count label="Learning" value={node?.learning ?? 0} cls="text-learn" />
          <Count label="Due" value={node?.review ?? 0} cls="text-review" />
          <div className="text-sm text-muted-foreground min-[420px]:border-l min-[420px]:pl-8">
            <div className="tabular text-3xl leading-none font-semibold text-foreground">{node?.cards ?? 0}</div>
            <div className="mt-1.5 text-xs">cards{node?.doneToday ? ` · ${node.doneToday} done today` : ""}</div>
          </div>
        </div>
        <div className="flex gap-2">
          <CustomStudy deck={deck.name} tags={tags} disabled={!node?.cards} />
          <Button size="lg" className="h-11 flex-1 gap-2 px-6 sm:flex-none" disabled={!work} title={work ? undefined : "Nothing due right now"} onClick={() => navigate(`/study?deck=${enc(deck.name)}`)}>
            <Play className="size-4" />Study
          </Button>
        </div>
      </div>

      {deadline && <Countdown deadline={deadline} margin={deck.resolved.deadlineMargin} />}
      {node && node.cards === 0 && (
        <div className="mt-6 flex flex-col gap-3 rounded-xl border bg-card/60 px-4 py-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">No cards yet</div>
            <div className="text-muted-foreground">Add cards in Browse, or import a pack from the Decks page.</div>
          </div>
          <Button className="h-10" onClick={() => navigate(`/browse?q=${enc(`deck:"${deck.name}"`)}`)}>Add cards</Button>
        </div>
      )}
      {!work && node && node.cards > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{node.nextDue ? `Nothing due now. Next card ${relativeShort(node.nextDue)}.` : "Nothing due now."} Custom study works any time.</p>
      )}
    </header>
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

function CustomStudy({ deck, tags, disabled }: { deck: string; tags: string[]; disabled?: boolean }) {
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
          <Button variant="outline" size="lg" className="h-11 gap-1.5 px-4" disabled={disabled}>Custom study<ChevronDown className="size-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Study a slice of this deck</DropdownMenuLabel>
          <DropdownMenuItem className="h-10" onClick={() => go("is:due")}>Due reviews only</DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={() => go("is:new")}>New cards only</DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={() => go("rated:1:1")}>Failed today</DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={() => go("prop:lapses>=2")}>Frequently forgotten</DropdownMenuItem>
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
            <Button className="h-10" disabled={!q.trim() || !!err || count === 0} onClick={() => go(q.trim())}><Play className="size-4" />Study</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Subdecks({ parent, decks }: { parent: string; decks: DeckNode[] }) {
  const depth0 = parent.split("::").length;
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-medium">Subdecks</h2>
      <div className="overflow-hidden rounded-xl border bg-card/40">
        <div className="hidden grid-cols-[1fr_repeat(3,3.5rem)] items-center gap-2 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
          <span>Deck</span>
          <span className="text-right">New</span>
          <span className="text-right">Learn</span>
          <span className="text-right">Due</span>
        </div>
        {decks.map((d) => {
          const depth = d.name.split("::").length - depth0 - 1;
          return (
            <button
              key={d.id}
              onClick={() => navigate(`/deck?name=${enc(d.name)}`)}
              className="grid min-h-12 w-full grid-cols-[1fr_auto] items-center gap-2 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-accent/40 sm:grid-cols-[1fr_repeat(3,3.5rem)]"
            >
              <span className="min-w-0 text-[0.95rem] leading-snug sm:truncate" style={{ paddingLeft: depth * 18 }}>{d.name.split("::").pop()}</span>
              <span className="tabular grid grid-cols-[repeat(3,2rem)] text-right text-sm sm:hidden" aria-label={`${d.new} new, ${d.learning} learning, ${d.review} due`}>
                <span className={d.new ? "text-new" : "text-muted-foreground/50"}>{d.new}</span>
                <span className={d.learning ? "text-learn" : "text-muted-foreground/50"}>{d.learning}</span>
                <span className={d.review ? "text-review" : "text-muted-foreground/50"}>{d.review}</span>
              </span>
              <span className={cn("tabular hidden text-right text-sm sm:block", d.new ? "text-new" : "text-muted-foreground/40")}>{d.new}</span>
              <span className={cn("tabular hidden text-right text-sm sm:block", d.learning ? "text-learn" : "text-muted-foreground/40")}>{d.learning}</span>
              <span className={cn("tabular hidden text-right text-sm sm:block", d.review ? "text-review" : "text-muted-foreground/40")}>{d.review}</span>
            </button>
          );
        })}
      </div>
    </section>
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
    <section>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0 pt-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {help && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{help}</p>}
        </div>
        {!editing && (
          <Button variant="ghost" size="sm" className="h-10 shrink-0 gap-1.5 px-3 text-muted-foreground" onClick={() => { setEditing(true); setTab("write"); }}>
            <Pencil className="size-3.5" />Edit
          </Button>
        )}
      </div>
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
        <button className="w-full rounded-xl border border-dashed border-input px-4 py-4 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground" onClick={() => setEditing(true)}>
          {empty}
        </button>
      )}
    </section>
  );
}

function DangerZone({ deck, hasChildren, cards }: { deck: DeckFull; hasChildren: boolean; cards: number }) {
  const [confirm, setConfirm] = useState<null | "archive" | "delete">(null);
  const leaf = deck.name.split("::").at(-1);
  const act = async () => {
    try {
      if (confirm === "archive") {
        await api.updateDeck(deck.name, { archived: true });
        toast.success(`Archived ${leaf}`);
      } else {
        await api.deleteDeck(deck.name);
        toast.success(`Deleted ${leaf}`);
      }
      navigate("/");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 px-1 text-sm font-medium">Elsewhere</h2>
        <div className="divide-y overflow-hidden rounded-xl border bg-card/40">
          <LinkRow icon={Library} title="Browse cards" desc="List, search and edit every card in this deck." onClick={() => navigate(`/browse?q=${enc(`deck:"${deck.name}"`)}`)} />
          <LinkRow icon={BarChart3} title="Statistics" desc="Retention, forecast and weakest tags for this deck." onClick={() => navigate(`/stats?deck=${enc(deck.name)}`)} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 px-1 text-sm font-medium">Export</h2>
        <div className="flex flex-col gap-3 rounded-xl border bg-card/40 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Export as a pack</div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">A JSON pack with the items, subdecks, presets, tag notes and custom card types. Review history stays here.</p>
          </div>
          <Button variant="outline" className="h-10 gap-1.5" asChild>
            <a href={api.exportUrl({ deck: deck.name })} download={`${deck.name.replace(/::/g, " - ").replace(/[/\\?%*:|"<>]/g, "")}.pack.json`}>
              <Download className="size-4" />Download
            </a>
          </Button>
        </div>
      </section>
      <section>
        <h2 className="mb-2 px-1 text-sm font-medium text-destructive">Danger zone</h2>
        <div className="divide-y overflow-hidden rounded-xl border border-destructive/30">
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Archive deck</div>
              <p className="mt-0.5 text-[13px] text-muted-foreground">Hides it from the deck list. Cards keep their history; nothing is deleted.</p>
            </div>
            <Button variant="outline" className="h-10 gap-1.5" onClick={() => setConfirm("archive")}><Archive className="size-4" />Archive</Button>
          </div>
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Delete deck</div>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {cards ? `Only empty decks can be deleted. This one holds ${cards} card${cards === 1 ? "" : "s"}; move or archive them first.` : `Removes the deck${hasChildren ? " and its empty subdecks" : ""}.`}
              </p>
            </div>
            <Button variant="outline" className="h-10 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={cards > 0} onClick={() => setConfirm("delete")}>
              <Trash2 className="size-4" />Delete
            </Button>
          </div>
        </div>
      </section>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "archive" ? `Archive ${leaf}?` : `Delete ${leaf}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "archive" ? "It disappears from the deck list and study. Its cards and history stay in the database." : "This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={confirm === "delete" ? "bg-destructive text-white hover:bg-destructive/90" : undefined} onClick={act}>
              {confirm === "archive" ? "Archive" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LinkRow({ icon: Icon, title, desc, onClick }: { icon: typeof Library; title: string; desc: string; onClick(): void }) {
  return (
    <button onClick={onClick} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 sm:px-5">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[13px] text-muted-foreground">{desc}</div>
      </div>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
}
