// Folders of the Types page: the folder menu and the move / name dialogs. Folders only organize the page.
import { useEffect, useState } from "react";
import { Check, Folder, FolderInput, FolderOpen, FolderPlus, Inbox, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export const leaf = (path: string) => path.split("::").pop()!;
export const parentOf = (path: string) => path.split("::").slice(0, -1).join("::");
export const within = (path: string, folder: string) => path === folder || path.startsWith(folder + "::");

export type MoveTarget = { kind: "type"; id: string; name: string; folder: string } | { kind: "folder"; path: string };
export type FolderDialog = { mode: "create"; parent: string } | { mode: "rename"; path: string };

export function FolderMenu(p: { name: string; onNewType(): void; onNewFolder(): void; onRename(): void; onMove(): void; onDelete(): void; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-8 shrink-0 text-muted-foreground", p.className)} aria-label={`Actions for folder ${p.name}`} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={p.onNewType}><Plus />New type here…</DropdownMenuItem>
        <DropdownMenuItem onClick={p.onNewFolder}><FolderPlus />New folder inside…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={p.onRename}><Pencil />Rename…</DropdownMenuItem>
        <DropdownMenuItem onClick={p.onMove}><FolderInput />Move to…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={p.onDelete}><Trash2 />Delete folder…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pick a folder for a type (or a parent for a folder), or make a new one on the spot. Works without dragging, so on phones too. */
export function MoveDialog({ target, folders, onOpenChange, onMoveType, onMoveFolder }: {
  target: MoveTarget | null;
  folders: string[];
  onOpenChange(o: boolean): void;
  onMoveType(id: string, folder: string): Promise<void>;
  onMoveFolder(path: string, parent: string): Promise<void>;
}) {
  const [pick, setPick] = useState("");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!target) return;
    setPick(target.kind === "type" ? target.folder : parentOf(target.path));
    setFresh("");
  }, [target]);
  if (!target) return null;

  const sorted = [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const options = target.kind === "folder" ? sorted.filter((f) => !within(f, target.path)) : sorted;
  const current = target.kind === "type" ? target.folder : parentOf(target.path);
  const freshName = fresh.replace(/::/g, " ").trim();
  const dest = freshName ? (pick ? `${pick}::${freshName}` : freshName) : pick;
  const title = target.kind === "type" ? `Move “${target.name}”` : `Move the folder “${leaf(target.path)}”`;

  const go = async () => {
    if (dest === current) return;
    if (target.kind === "type") await onMoveType(target.id, dest);
    else {
      if (freshName) await api.createTypeFolder(dest).catch(() => {});
      await onMoveFolder(target.path, dest);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Folders only organize the Types page. The type and its cards don't change.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-xl border bg-card/40 p-1.5" role="listbox" aria-label="Folders">
          {["", ...options].map((f) => {
            const chosen = pick === f;
            return (
              <button
                key={f || "(top)"}
                role="option"
                aria-selected={chosen}
                className={cn("flex min-h-10 shrink-0 items-center gap-2.5 rounded-lg pr-2.5 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring", chosen && "font-medium text-highlight")}
                style={{ paddingLeft: `${0.625 + 1 * (f ? f.split("::").length - 1 : 0)}rem` }}
                onClick={() => setPick(f)}
              >
                {f ? (chosen ? <FolderOpen className="size-4 shrink-0 text-highlight" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />) : <Inbox className={cn("size-4 shrink-0", chosen ? "text-highlight" : "text-muted-foreground")} />}
                <span className="min-w-0 flex-1 truncate">{f ? leaf(f) : target.kind === "type" ? "No folder" : "Top level"}</span>
                {f === current && <span className="shrink-0 text-xs font-normal text-muted-foreground">here now</span>}
                <Check className={cn("size-4 shrink-0 text-highlight", !chosen && "invisible")} />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">or make a new folder {pick ? <>inside <span className="text-foreground">{leaf(pick)}</span></> : "at the top level"}</span>
          <Input value={fresh} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="New folder name" className="h-10" />
        </div>
        <DialogFooter>
          <Button onClick={go} disabled={dest === current} className="h-10 gap-1.5 sm:h-9">
            <FolderInput className="size-4" />
            {freshName ? `Move to new “${freshName}”` : dest ? `Move to ${leaf(dest)}` : target.kind === "type" ? "Take out of folder" : "Move to top level"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FolderNameDialog({ state, folders, onOpenChange, onDone }: { state: FolderDialog | null; folders: string[]; onOpenChange(o: boolean): void; onDone(path: string, from?: string): Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!state) return;
    setBusy(false);
    setName(state.mode === "rename" ? leaf(state.path) : "");
  }, [state]);
  if (!state) return null;

  const parent = state.mode === "create" ? state.parent : parentOf(state.path);
  const clean = name.replace(/::/g, " ").trim();
  const path = parent ? `${parent}::${clean}` : clean;
  const same = state.mode === "rename" && path === state.path;
  const taken = folders.includes(path) && !same;
  const ok = !!clean && !taken && !busy && !same;

  const save = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      if (state.mode === "create") await api.createTypeFolder(path);
      else await api.renameTypeFolder(state.path, path);
      await onDone(path, state.mode === "rename" ? state.path : undefined);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{state.mode === "create" ? "New folder" : "Rename folder"}</DialogTitle>
          <DialogDescription>{state.mode === "create" ? (parent ? `Inside ${parent.split("::").join(" › ")}.` : "At the top level.") : "Everything inside stays inside."}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Networks" className={cn("h-10", taken && "border-destructive")} />
          {taken && <span className="text-xs text-destructive">There's already a folder called “{clean}” here.</span>}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={!ok} className="h-10 sm:h-9">{state.mode === "create" ? "Create folder" : "Rename"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
