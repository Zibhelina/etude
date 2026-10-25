import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronRight, Play, Plus, Upload } from "lucide-react";
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
            const study = () => navigate(`/study?deck=${encodeURIComponent(d.name)}`);
            // A new top-level deck after a subtree gets a stronger rule, so groups read as groups.
            const groupStart = i > 0 && d.depth === 0;
            return (
              <div
                key={d.id}
                className={cn(
                  "group flex min-h-14 items-stretch gap-2 pr-3 pl-1.5 transition-colors hover:bg-accent/40 sm:grid sm:min-h-12 sm:grid-cols-[1fr_repeat(3,3.5rem)_6rem] sm:pr-5 sm:pl-3",
                  i > 0 && "border-t",
                  groupStart && "border-t-foreground/15",
                )}
              >
                <div className="flex min-w-0 flex-1 items-stretch">
                  <TreeGuides depth={d.depth} />
                  <div className="flex shrink-0 items-center">
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
                      {work ? (
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
                <Count value={d.new} cls="text-new" />
                <Count value={d.learning} cls="text-learn" />
                <Count value={d.review} cls="text-review" />
                <div className="flex shrink-0 items-center justify-end">
                  <Button
                    size="sm"
                    variant={work ? "secondary" : "ghost"}
                    className="size-10 gap-1.5 self-center rounded-full px-0 sm:h-8 sm:w-auto sm:rounded-md sm:px-3"
                    disabled={!work}
                    onClick={study}
                    aria-label={`Study ${name}`}
                  >
                    <Play className={cn("size-4 sm:size-3.5", work && "fill-current text-highlight sm:fill-none sm:text-current")} /> <span className="hidden sm:inline">Study</span>
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

/** One vertical guide per nesting level, so subdecks visibly hang from their parent. */
export function TreeGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} aria-hidden className="relative w-4 shrink-0 before:absolute before:inset-y-0 before:left-[19px] before:border-l before:border-foreground/12 sm:w-5 sm:before:left-[15px]" />
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
