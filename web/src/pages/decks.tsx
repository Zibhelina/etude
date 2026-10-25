import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronRight, Eye, FastForward, GripVertical, Play, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, relative, type DeckNode } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader, Section } from "@/components/page";

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

  // ------------------------------------------------------------ reordering
  // A deck moves among its siblings, carrying its subdecks. The grip drives it with pointer
  // events (mouse and touch alike) or the arrow keys.
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<{ name: string; dy: number; from: number; to: number; height: number; blocks: string[][] } | null>(null);
  const parentOf = (name: string) => name.split("::").slice(0, -1).join("::");
  /** Visible sibling groups of `name`: each sibling with its visible subtree, in list order. */
  const blocksFor = (name: string) => {
    const parent = parentOf(name), depth = name.split("::").length - 1;
    const out: string[][] = [];
    for (const d of visible) {
      if (d.depth === depth && parentOf(d.name) === parent) out.push([d.name]);
      else if (out.length && d.depth > depth && d.name.startsWith(out[out.length - 1][0] + "::")) out[out.length - 1].push(d.name);
    }
    return out;
  };
  const span = (block: string[]) => {
    const a = rows.current.get(block[0])!.getBoundingClientRect(), b = rows.current.get(block[block.length - 1])!.getBoundingClientRect();
    return { top: a.top, bottom: b.bottom };
  };
  const commit = async (name: string, blocks: string[][], from: number, to: number) => {
    if (from === to) return;
    const order = blocks.map((b) => b[0]);
    order.splice(to, 0, ...order.splice(from, 1));
    // Show the new order right away; the server's tree replaces it.
    setDecks((ds) => {
      if (!ds) return ds;
      const rank = new Map(order.map((n, i) => [n, i]));
      const top = (n: string) => { for (const o of order) if (n === o || n.startsWith(o + "::")) return o; return null; };
      const idx = new Map(ds.map((d, i) => [d.name, i]));
      return [...ds].sort((a, b) => {
        const ta = top(a.name), tb = top(b.name);
        return ta && tb && ta !== tb ? rank.get(ta)! - rank.get(tb)! : idx.get(a.name)! - idx.get(b.name)!;
      });
    });
    try {
      await api.reorderDecks(parentOf(name), order);
    } catch (e) {
      toast.error((e as Error).message);
    }
    reload();
  };
  const startDrag = (name: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const blocks = blocksFor(name);
    const from = blocks.findIndex((b) => b[0] === name);
    const spans = blocks.map(span);
    const height = spans[from].bottom - spans[from].top;
    const y0 = e.clientY;
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    let to = from, dy = 0;
    const move = (ev: PointerEvent) => {
      dy = ev.clientY - y0;
      // Clamp to the sibling group so the deck can't leave its parent.
      dy = Math.max(spans[0].top - spans[from].top, Math.min(spans[spans.length - 1].bottom - spans[from].bottom, dy));
      const mid = (spans[from].top + spans[from].bottom) / 2 + dy;
      to = 0;
      spans.forEach((s, i) => { if (i !== from && mid > (s.top + s.bottom) / 2) to++; });
      setDrag({ name, dy, from, to, height, blocks });
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      document.body.style.userSelect = "";
      setDrag(null);
      commit(name, blocks, from, to);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    setDrag({ name, dy: 0, from, to: from, height, blocks });
  };
  const keyMove = (name: string, e: React.KeyboardEvent) => {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const blocks = blocksFor(name);
    const from = blocks.findIndex((b) => b[0] === name);
    const to = from + step;
    if (to < 0 || to >= blocks.length) return;
    commit(name, blocks, from, to).then(() => requestAnimationFrame(() => rows.current.get(name)?.querySelector<HTMLElement>("[data-grip]")?.focus()));
  };
  /** Vertical offset for a row while a drag is in progress. */
  const offset = (name: string): { y: number; lifted: boolean } => {
    if (!drag) return { y: 0, lifted: false };
    const i = drag.blocks.findIndex((b) => b.includes(name));
    if (i < 0) return { y: 0, lifted: false };
    if (i === drag.from) return { y: drag.dy, lifted: true };
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return { y: -drag.height, lifted: false };
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return { y: drag.height, lifted: false };
    return { y: 0, lifted: false };
  };

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
          <div className="hidden grid-cols-[1fr_repeat(3,3.5rem)_6rem] items-center gap-2 border-b px-5 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
            <span>Deck</span>
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
            const o = offset(d.name);
            const siblings = drag ? 0 : visible.filter((x) => x.depth === d.depth && parentOf(x.name) === parentOf(d.name)).length;
            return (
              <div
                key={d.id}
                ref={(el) => { if (el) rows.current.set(d.name, el); else rows.current.delete(d.name); }}
                style={o.y ? { transform: `translateY(${o.y}px)` } : undefined}
                className={cn(
                  "group relative flex min-h-14 items-stretch gap-2 pr-3 pl-0.5 hover:bg-accent/40 sm:grid sm:min-h-12 sm:grid-cols-[1fr_repeat(3,3.5rem)_6rem] sm:pr-5 sm:pl-1",
                  i > 0 && "border-t",
                  groupStart && "border-t-foreground/15",
                  drag && !o.lifted && "transition-transform duration-150 ease-out",
                  !drag && "transition-colors",
                  o.lifted && "z-10 bg-card shadow-lg ring-1 ring-border",
                )}
              >
                <div className="flex min-w-0 flex-1 items-stretch">
                  <TreeGuides depth={d.depth} />
                  <div className="flex shrink-0 items-center">
                    <button
                      data-grip
                      className={cn(
                        "flex h-10 w-6 touch-none items-center justify-center rounded-md hover:!text-foreground sm:h-8 sm:w-5",
                        o.lifted ? "cursor-grabbing text-foreground" : "cursor-grab text-muted-foreground/50 group-hover:text-muted-foreground",
                        (drag ? !drag.blocks.some((b) => b[0] === d.name) : siblings < 2) && "invisible",
                      )}
                      onPointerDown={(e) => startDrag(d.name, e)}
                      onKeyDown={(e) => keyMove(d.name, e)}
                      aria-label={`Reorder ${name} (drag, or use the arrow keys)`}
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
                    <div className="mt-0.5 flex gap-3 text-xs tabular text-muted-foreground sm:hidden">
                      {watch ? (
                        <span>{d.cards} card{d.cards === 1 ? "" : "s"} to watch</span>
                      ) : work ? (
                        <>
                          {d.new > 0 && <span className="text-new">{d.new} new</span>}
                          {d.learning > 0 && <span className="text-learn">{d.learning} learning</span>}
                          {d.review > 0 && <span className="text-review">{d.review} due</span>}
                        </>
                      ) : (
                        <span>{d.cards ? "nothing due" : "empty"}</span>
                      )}
                    </div>
                  </div>
                </div>
                {watch ? (
                  <span className="hidden items-center justify-end text-xs text-muted-foreground sm:col-span-3 sm:flex">tour · {d.cards} card{d.cards === 1 ? "" : "s"}</span>
                ) : (
                  <>
                    <Count value={d.new} cls="text-new" />
                    <Count value={d.learning} cls="text-learn" />
                    <Count value={d.review} cls="text-review" />
                  </>
                )}
                <div className="flex shrink-0 items-center justify-end">
                  <Button
                    size="sm"
                    variant={work || (watch && d.cards) ? "secondary" : "ghost"}
                    className="size-10 gap-1.5 self-center rounded-full px-0 sm:h-8 sm:w-auto sm:rounded-md sm:px-3"
                    disabled={!d.cards}
                    onClick={study}
                    title={!watch && !work && d.cards ? "Nothing due: study ahead anyway" : undefined}
                    aria-label={`${watch ? "Watch" : work || !d.cards ? "Study" : "Study ahead"} ${name}`}
                  >
                    {watch ? (
                      <><Eye className="size-4 text-highlight sm:size-3.5 sm:text-current" /> <span className="hidden sm:inline">Watch</span></>
                    ) : (
                      work || !d.cards ? (
                      <><Play className={cn("size-4 sm:size-3.5", work && "fill-current text-highlight sm:fill-none sm:text-current")} /> <span className="hidden sm:inline">Study</span></>
                    ) : (
                      <><FastForward className="size-4 sm:size-3.5" /> <span className="hidden sm:inline">Ahead</span></>
                    )
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </Section>
      )}
      <NewDeckDialog open={creating} onOpenChange={setCreating} onDone={reload} />
    </Page>
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
