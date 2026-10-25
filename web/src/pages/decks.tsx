import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronRight, Play, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, relative, type DeckNode } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

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
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Decks</h1>
          <p className="mt-1 text-sm text-muted-foreground">{decks ? (due ? `${due} cards to study today` : "Nothing due right now") : " "}</p>
        </div>
        <div className="flex gap-2">
          <ImportButton onDone={reload} />
          <Button variant="outline" size="sm" className="h-10 gap-1.5 sm:h-8" onClick={() => setCreating(true)}><Plus className="size-4" /><span className="hidden sm:inline">New deck</span><span className="sm:hidden">New</span></Button>
        </div>
      </div>

      {decks && decks.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          No decks yet. Import a pack or create a deck.
        </div>
      )}

      {visible.length > 0 && (
        <div className="overflow-hidden rounded-xl border bg-card/40">
          <div className="hidden grid-cols-[1fr_repeat(3,3.5rem)_6.5rem] items-center gap-2 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
            <span>Deck</span>
            <span className="text-right">New</span>
            <span className="text-right">Learn</span>
            <span className="text-right">Due</span>
            <span />
          </div>
          {visible.map((d) => {
            const name = d.name.split("::").pop()!;
            const work = d.new + d.learning + d.review;
            const soon = d.depth === 0 && d.deadline && new Date(d.deadline) > new Date();
            const study = () => navigate(`/study?deck=${encodeURIComponent(d.name)}`);
            return (
              <div key={d.id} className="group flex items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-accent/40 sm:grid sm:grid-cols-[1fr_repeat(3,3.5rem)_6.5rem] sm:px-4 sm:py-2.5">
                <div className="flex min-w-0 flex-1 items-start gap-0.5 pr-2 [--indent:10px] sm:gap-1 sm:pr-0 sm:[--indent:14px]" style={{ paddingLeft: `calc(var(--indent) * ${d.depth})` }}>
                  <button
                    className={cn("flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:size-5", !d.hasChildren && "invisible")}
                    onClick={() => toggle(d.name)}
                    aria-label={collapsed.has(d.name) ? "Expand" : "Collapse"}
                  >
                    <ChevronRight className={cn("size-4 transition-transform", !collapsed.has(d.name) && "rotate-90")} />
                  </button>
                  <div className="min-w-0 flex-1 py-1 sm:py-0">
                    <button className="text-left text-[0.95rem] leading-snug hover:underline sm:truncate" onClick={() => navigate(`/deck?name=${encodeURIComponent(d.name)}`)}>
                      {name}
                      {soon && (
                        <span className="ml-2 inline-flex items-center gap-1 align-middle text-xs text-highlight"><CalendarClock className="size-3.5" />{relative(d.deadline!)}</span>
                      )}
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
                <span className={cn("hidden tabular text-right text-sm sm:block", d.new ? "text-new" : "text-muted-foreground/40")}>{d.new}</span>
                <span className={cn("hidden tabular text-right text-sm sm:block", d.learning ? "text-learn" : "text-muted-foreground/40")}>{d.learning}</span>
                <span className={cn("hidden tabular text-right text-sm sm:block", d.review ? "text-review" : "text-muted-foreground/40")}>{d.review}</span>
                <div className="flex shrink-0 justify-end">
                  <Button size="sm" variant={work ? "default" : "ghost"} className="size-11 gap-1 px-0 sm:h-7 sm:w-auto sm:px-3" disabled={!work} onClick={study} aria-label={`Study ${name}`}>
                    <Play className="size-4 sm:size-3.5" /> <span className="hidden sm:inline">Study</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <NewDeckDialog open={creating} onOpenChange={setCreating} onDone={reload} />
    </div>
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
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Deck name" />
        <DialogFooter>
          <Button onClick={create}>Create</Button>
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
    <Button variant="outline" size="sm" className="h-10 gap-1.5 sm:h-8" onClick={pick}><Upload className="size-4" />Import</Button>
  );
}
