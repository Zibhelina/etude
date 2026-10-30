import { useState } from "react";
import { Archive, ArchiveRestore, MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { leafOf } from "@/components/move-deck";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";

export function useDeckActions(onChanged: () => void) {
  const [deleting, setDeleting] = useState<{ name: string; items: number; cards: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const archive = async (name: string, archived: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setDeckArchived(name, archived);
      toast.success(`${archived ? "Archived" : "Restored"} ${leafOf(name)}`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string, items = false) => {
    await api.deleteDeck(name, items);
    setDeleting(null);
    toast.success(`Deleted ${leafOf(name)}`);
    onChanged();
  };

  const requestDelete = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const usage = await api.deckUsage(name);
      if (usage.items) setDeleting({ name, ...usage });
      else await remove(name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await remove(deleting.name, true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteDialog = (
    <AlertDialog open={!!deleting} onOpenChange={(open) => !open && !busy && setDeleting(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {deleting ? leafOf(deleting.name) : "deck"}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deck and its subdecks contain {deleting?.cards ?? 0} card{deleting?.cards === 1 ? "" : "s"} that will be permanently deleted with it, along with their review history. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => { e.preventDefault(); void confirmDelete(); }}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { archive, requestDelete, deleteDialog, busy };
}

/** One entry in a deck's menu; `"-"` is a separator. */
export type DeckMenuEntry = "-" | { icon: React.ReactNode; label: string; onSelect(): void; destructive?: boolean };

function deckEntries(archived: boolean | undefined, onArchive: () => void, onDelete: () => void, extra: DeckMenuEntry[] = []): DeckMenuEntry[] {
  return [
    ...extra,
    ...(extra.length ? ["-" as const] : []),
    { icon: archived ? <ArchiveRestore /> : <Archive />, label: archived ? "Move out of archive" : "Move to archive", onSelect: onArchive },
    { icon: <Trash2 />, label: "Delete", onSelect: onDelete, destructive: true },
  ];
}

type DeckMenuProps = {
  name: string;
  archived?: boolean;
  onArchive(): void;
  onDelete(): void;
  disabled?: boolean;
  /** Entries above Archive/Delete (move, rename…). */
  extra?: DeckMenuEntry[];
};

/** The ⋯ button on a deck row. */
export function DeckMenu({ name, archived, onArchive, onDelete, disabled, extra, className }: DeckMenuProps & { className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" disabled={disabled} className={cn("size-10 text-muted-foreground hover:text-foreground sm:size-8", className)} aria-label={`More for ${leafOf(name)}`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {deckEntries(archived, onArchive, onDelete, extra).map((e, i) => e === "-"
          ? <DropdownMenuSeparator key={i} />
          : <DropdownMenuItem key={i} className="h-10 sm:h-9" variant={e.destructive ? "destructive" : "default"} onClick={e.onSelect}>{e.icon}{e.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same menu as the ⋯ button, opened by right-clicking anywhere on the row. */
export function DeckContextMenu({ archived, onArchive, onDelete, disabled, extra, children }: DeckMenuProps & { children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {deckEntries(archived, onArchive, onDelete, extra).map((e, i) => e === "-"
          ? <ContextMenuSeparator key={i} />
          : <ContextMenuItem key={i} className="h-9" variant={e.destructive ? "destructive" : "default"} onSelect={e.onSelect}>{e.icon}{e.label}</ContextMenuItem>)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
