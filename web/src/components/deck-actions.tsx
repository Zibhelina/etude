import { useState } from "react";
import { Archive, ArchiveRestore, MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { leafOf } from "@/components/move-deck";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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

export function DeckMenu({ name, archived, onArchive, onDelete, disabled, children, className }: {
  name: string;
  archived?: boolean;
  onArchive(): void;
  onDelete(): void;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" disabled={disabled} className={cn("size-10 text-muted-foreground hover:text-foreground sm:size-8", className)} aria-label={`More for ${leafOf(name)}`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
        {children && <DropdownMenuSeparator />}
        <DropdownMenuItem className="h-10 sm:h-9" onClick={onArchive}>
          {archived ? <ArchiveRestore /> : <Archive />}{archived ? "Move out of archive" : "Move to archive"}
        </DropdownMenuItem>
        <DropdownMenuItem className="h-10 sm:h-9" variant="destructive" onClick={onDelete}><Trash2 />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
