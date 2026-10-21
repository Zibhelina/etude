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
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Plus className="size-4" /><span className="hidden sm:inline">New deck</span><span className="sm:hidden">New</span></Button>
        </div>
      </div>

      {decks && decks.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          No decks yet. Import a pack or create a deck.
        </div>
      )}

      {visible.length > 0 && (
        <div className="overflow-hidden rounded-xl border bg-card/40">
          <div className="grid grid-cols-[1fr_repeat(3,1.75rem)_2.25rem] items-center gap-1 border-b px-3 py-2.5 text-[11px] font-medium sm:text-xs sm:grid-cols-[1fr_repeat(3,3.5rem)_6.5rem] sm:gap-2 sm:px-4 text-muted-foreground">
            <span>Deck</span>
            <span className="text-right">New</span>
            <span className="text-right"><span className="sm:hidden">Lrn</span><span className="hidden sm:inline">Learn</span></span>
            <span className="text-right">Due</span>
            <span />
          </div>
          {visible.map((d) => {
            const name = d.name.split("::").pop()!;
            const work = d.new + d.learning + d.review;
            return (
              <div
                key={d.id}
                className="group grid grid-cols-[1fr_repeat(3,1.75rem)_2.25rem] items-center gap-1 border-b px-3 py-2 last:border-b-0 hover:bg-accent/40 sm:grid-cols-[1fr_repeat(3,3.5rem)_6.5rem] sm:gap-2 sm:px-4 sm:py-2.5"
              >
                <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: d.depth * 14 }}>
                  <button
                    className={cn("flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground", !d.hasChildren && "invisible")}
                    onClick={() => toggle(d.name)}
                    aria-label={collapsed.has(d.name) ? "Expand" : "Collapse"}
                  >
                    <ChevronRight className={cn("size-4 transition-transform", !collapsed.has(d.name) && "rotate-90")} />
                  </button>
                  <button className="min-w-0 py-1 text-left text-[0.95rem] leading-snug hover:underline sm:truncate" onClick={() => navigate(`/deck?name=${encodeURIComponent(d.name)}`)}>
                    {name}
                    {d.depth === 0 && d.deadline && new Date(d.deadline) > new Date() && (
                      <span className="ml-2 inline-flex shrink-0 items-center gap-1 align-middle text-xs text-highlight"><CalendarClock className="size-3.5" />{relative(d.deadline)}</span>
                    )}
                  </button>
                </div>
                <span className={cn("tabular text-right text-sm", d.new ? "text-new" : "text-muted-foreground/40")}>{d.new}</span>
                <span className={cn("tabular text-right text-sm", d.learning ? "text-learn" : "text-muted-foreground/40")}>{d.learning}</span>
                <span className={cn("tabular text-right text-sm", d.review ? "text-review" : "text-muted-foreground/40")}>{d.review}</span>
                <div className="flex justify-end">
                  <Button size="sm" variant={work ? "default" : "ghost"} className="size-9 gap-1 justify-self-end px-0 sm:h-7 sm:w-auto sm:px-3" disabled={!work} onClick={() => navigate(`/study?deck=${encodeURIComponent(d.name)}`)} aria-label={`Study ${name}`}>
                    <Play className="size-3.5" /> <span className="hidden sm:inline">Study</span>
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
    input.accept = ".json,application/json";
    input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try {
          const r = await api.importPack(JSON.parse(await f.text()));
          toast.success(`Imported ${f.name}`, { description: `${r.items.created} new, ${r.items.updated} updated, ${r.items.unchanged} unchanged` });
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
