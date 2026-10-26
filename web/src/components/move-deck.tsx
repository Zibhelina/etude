// Moving decks around the tree: a picker dialog (works on phones, no dragging needed) and the
// shared move call that offers an Undo.
import { useEffect, useState } from "react";
import { ArrowUpToLine, Check, FolderInput, Layers } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type DeckNode } from "@/lib/api";
import { cn } from "@/lib/utils";

export const parentOf = (name: string) => name.split("::").slice(0, -1).join("::");
export const leafOf = (name: string) => name.split("::").at(-1)!;
const inside = (name: string, root: string) => name === root || name.startsWith(root + "::");

/** Children of `parent` in list order, by full name. */
export function childrenOf(decks: DeckNode[], parent: string) {
  const depth = parent ? parent.split("::").length : 0;
  return decks.filter((d) => d.depth === depth && parentOf(d.name) === parent).map((d) => d.name);
}

/** True when `parent` already holds another deck called like `name`. */
export function clashes(decks: DeckNode[], name: string, parent: string) {
  const leaf = leafOf(name).toLowerCase();
  return childrenOf(decks, parent).some((n) => n !== name && leafOf(n).toLowerCase() === leaf);
}

/**
 * Moves `name` (with its subdecks) under `parent` at `index` and shows a toast with Undo.
 * Returns the deck's new full name, or null when the move failed.
 */
export async function moveDeck(decks: DeckNode[], name: string, parent: string, index: number | undefined, after: (newName: string) => void) {
  const from = parentOf(name);
  const fromIndex = childrenOf(decks, from).indexOf(name);
  try {
    const d = await api.moveDeck(name, parent, index);
    after(d.name);
    if (from !== parent) {
      toast.success(parent ? `Moved ${leafOf(name)} into ${leafOf(parent)}` : `${leafOf(name)} is a deck of its own now`, {
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              const back = await api.moveDeck(d.name, from, fromIndex < 0 ? undefined : fromIndex);
              after(back.name);
            } catch (e) {
              toast.error((e as Error).message);
            }
          },
        },
      });
    }
    return d.name;
  } catch (e) {
    toast.error((e as Error).message);
    after(name);
    return null;
  }
}

/** Pick a new parent for a deck, or make a new one on the spot. */
export function MoveDeckDialog({ deck, decks, onOpenChange, onMoved }: {
  deck: string | null;
  decks: DeckNode[];
  onOpenChange(o: boolean): void;
  onMoved(newName: string): void;
}) {
  const [pick, setPick] = useState("");
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!deck) return;
    setPick(parentOf(deck));
    setFresh("");
    setBusy(false);
  }, [deck]);
  if (!deck) return null;

  const current = parentOf(deck);
  const options = decks.filter((d) => !inside(d.name, deck));
  const freshName = fresh.replace(/::/g, " ").trim();
  const dest = freshName ? (pick ? `${pick}::${freshName}` : freshName) : pick;
  const taken = !freshName && dest !== current && clashes(decks, deck, dest);
  const exists = freshName && decks.some((d) => d.name.toLowerCase() === dest.toLowerCase());

  const go = async () => {
    if (dest === current || taken || busy) return;
    setBusy(true);
    if (freshName && !exists) {
      try {
        await api.createDeck(dest);
      } catch (e) {
        toast.error((e as Error).message);
        return setBusy(false);
      }
    }
    const moved = await moveDeck(decks, deck, dest, undefined, () => {});
    setBusy(false);
    if (moved) {
      onOpenChange(false);
      onMoved(moved);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Move “{leafOf(deck)}”</DialogTitle>
          <DialogDescription>Its subdecks, cards and history come along. Pick where it goes.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-xl border bg-card/40 p-1.5" role="listbox" aria-label="Decks">
          {[null, ...options].map((d) => {
            const f = d?.name ?? "";
            const chosen = pick === f;
            const blocked = f !== current && clashes(decks, deck, f);
            return (
              <button
                key={f || "(top)"}
                ref={f === current ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                role="option"
                aria-selected={chosen}
                className={cn(
                  "flex min-h-10 shrink-0 items-center gap-2.5 rounded-lg pr-2.5 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
                  chosen && "bg-accent font-medium",
                  blocked && "text-muted-foreground",
                )}
                style={{ paddingLeft: `${0.625 + (d ? d.depth : 0)}rem` }}
                onClick={() => setPick(f)}
              >
                {d ? <Layers className={cn("size-4 shrink-0", chosen ? "text-highlight" : "text-muted-foreground")} /> : <ArrowUpToLine className={cn("size-4 shrink-0", chosen ? "text-highlight" : "text-muted-foreground")} />}
                <span className="min-w-0 flex-1 truncate">{d ? leafOf(f) : "Top level (a deck of its own)"}</span>
                {f === current && <span className="shrink-0 text-xs font-normal text-muted-foreground">here now</span>}
                {blocked && <span className="shrink-0 text-xs font-normal text-muted-foreground">has a {leafOf(deck)}</span>}
                <Check className={cn("size-4 shrink-0 text-highlight", !chosen && "invisible")} />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">or put it in a new deck {pick ? <>inside <span className="text-foreground">{leafOf(pick)}</span></> : "at the top level"}</span>
          <Input value={fresh} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="New deck name" className="h-10" aria-label="New deck name" />
        </div>
        {taken && <p className="text-[13px] text-destructive">{pick ? leafOf(pick) : "The top level"} already has a deck called {leafOf(deck)}. Rename one of them first.</p>}
        <DialogFooter>
          <Button onClick={go} disabled={dest === current || taken || busy} className="h-10 gap-1.5 sm:h-9">
            <FolderInput className="size-4" />
            {freshName ? `Move into new “${freshName}”` : dest ? `Move into ${leafOf(dest)}` : "Make it a deck of its own"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
