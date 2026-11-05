// A deck's picture (an illustration, one emoji, or nothing) and the Change icon picker.
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { artUrl, DECK_ART, EMOJI_SUGGESTIONS, parseDeckIcon } from "@/lib/deck-icons";
import { leafOf } from "@/components/move-deck";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** The icon at `size` px, or nothing when the deck has none. */
export function DeckIcon({ icon, size = 48, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  const v = parseDeckIcon(icon);
  if (!v) return null;
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center select-none", className)} style={{ width: size, height: size }}>
      {v.kind === "art" ? (
        <img src={v.src} alt="" draggable={false} className="size-full object-contain" />
      ) : (
        <span className="leading-none" style={{ fontSize: Math.round(size * 0.72) }}>{v.emoji}</span>
      )}
    </span>
  );
}

type Tab = "none" | "emoji" | "art";

export function ChangeIconDialog({ deck, icon, open, onOpenChange, onSaved }: { deck: string | null; icon: string | null; open: boolean; onOpenChange(o: boolean): void; onSaved(icon: string | null): void }) {
  const [tab, setTab] = useState<Tab>("art");
  const [pick, setPick] = useState<string | null>(icon);
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPick(icon);
    setQ("");
    setCustom("");
    setTab(icon?.startsWith("emoji:") ? "emoji" : icon ? "art" : "art");
  }, [open, icon]);

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return DECK_ART.map((g) => ({ ...g, icons: g.icons.filter((i) => !s || i.label.toLowerCase().includes(s) || i.id.includes(s) || g.name.toLowerCase().includes(s)) })).filter((g) => g.icons.length);
  }, [q]);

  const save = async () => {
    if (!deck) return;
    setBusy(true);
    try {
      const d = await api.updateDeck(deck, { icon: current });
      onSaved(d.icon ?? null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const customEmoji = custom.trim();
  const current = tab === "emoji" ? (pick?.startsWith("emoji:") ? pick : null) : tab === "art" ? (pick?.startsWith("art:") ? pick : null) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Change icon</DialogTitle>
          <DialogDescription>{deck ? `For ${leafOf(deck)}.` : ""} It shows next to the deck in the Library.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-muted">
            {current ? <DeckIcon icon={current} size={44} /> : <span className="text-xs text-muted-foreground">None</span>}
          </span>
          <div role="tablist" aria-label="Icon kind" className="flex rounded-full bg-muted p-1 text-sm">
            {([["none", "None"], ["emoji", "Emoji"], ["art", "Illustration"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("h-8 rounded-full px-3.5 transition-colors", tab === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === "none" && <p className="text-sm text-muted-foreground">The deck shows its name only.</p>}
        {tab === "emoji" && (
          <div className="min-h-0 overflow-y-auto">
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_SUGGESTIONS.map((e) => (
                <button key={e} aria-label={e} aria-pressed={pick === `emoji:${e}`} onClick={() => setPick(`emoji:${e}`)} className={cn("flex aspect-square items-center justify-center rounded-xl text-2xl hover:bg-accent", pick === `emoji:${e}` && "bg-accent ring-2 ring-foreground/70")}>
                  {e}
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or type or paste any emoji" aria-label="Custom emoji" className="h-10" />
              <Button variant="outline" className="h-10" disabled={!customEmoji} onClick={() => setPick(`emoji:${customEmoji}`)}>Use</Button>
            </div>
          </div>
        )}
        {tab === "art" && (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search illustrations" aria-label="Search illustrations" className="h-10 pl-9" />
            </div>
            <div className="min-h-0 overflow-y-auto pr-1">
              {groups.map((g) => (
                <div key={g.name} className="mb-3">
                  <div className="score-kicker mb-1.5 px-0.5">{g.name}</div>
                  <div className="grid grid-cols-5 gap-1 sm:grid-cols-7">
                    {g.icons.map((i) => (
                      <button key={i.id} title={i.label} aria-label={i.label} aria-pressed={pick === `art:${i.id}`} onClick={() => setPick(`art:${i.id}`)} className={cn("flex aspect-square items-center justify-center rounded-xl p-1 hover:bg-accent", pick === `art:${i.id}` && "bg-accent ring-2 ring-foreground/70")}>
                        <img src={artUrl(i.id)} alt="" className="size-full object-contain" draggable={false} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!groups.length && <p className="py-6 text-center text-sm text-muted-foreground">No illustration matches “{q}”.</p>}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy || (tab !== "none" && !current)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
