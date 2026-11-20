// Folders on this computer in the Notebook: the dialog that opens one, and the views for files that aren't text
// (a picture, sound, video, or a kind Etude has no view for). Markdown and code open in the file editor, PDFs in
// the PDF view; those live in pages/notes.tsx with the rest.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, File as FileIcon, FolderOpen } from "lucide-react";
import { api, isFsId, type Note, type NoteSummary, type SyncedFolder } from "@/lib/api";
import { useEtudeSrc } from "@/lib/local-url";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

type Desktop = { pickFolder?: () => Promise<string | null> };
const desktop = (): Desktop | undefined => (globalThis as { etudeDesktop?: Desktop }).etudeDesktop;

/** A size the way a file manager says it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Where a file of an open folder is on disk, from its row and the folder's own row. */
export function diskPath(n: { local?: NoteSummary["local"] } | null | undefined, all: NoteSummary[]): string | null {
  const local = n?.local;
  if (!local) return null;
  const root = local.root?.path ?? all.find((r) => r.local?.root && r.local.folder === local.folder)?.local?.root?.path;
  if (!root) return null;
  if (!local.path) return root;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${local.path.split("/").join(sep)}`;
}

/** The folder a file's id says it's in ("fs:abc/a/b.md" → "fs:abc/a"), or null for an open folder's own row. */
export function fsParent(id: string): string | null {
  if (!isFsId(id)) return null;
  const at = id.lastIndexOf("/");
  return at < 0 ? null : id.slice(0, at);
}
/** Every folder above a file, nearest last. */
export function fsAncestors(id: string): string[] {
  const out: string[] = [];
  for (let p = fsParent(id); p; p = fsParent(p)) out.unshift(p);
  return out;
}

export function copyPath(path: string | null) {
  if (!path) return;
  void navigator.clipboard.writeText(path).then(
    () => toast("Copied the path", { description: path }),
    () => toast.error("Couldn't copy the path"),
  );
}

/** Opens a folder on this computer in the Notebook: type its path, or pick it in the desktop app. */
export function OpenFolderDialog({ open, onClose, onOpened }: { open: boolean; onClose(): void; onOpened(id: string, name: string, synced?: boolean): void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Folders your other devices sync that have no place on this computer yet: each can be given one here.
  const [elsewhere, setElsewhere] = useState<SyncedFolder[]>([]);
  const [dest, setDest] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setPath("");
    setError(null);
    setElsewhere([]);
    setDest({});
    let live = true;
    void api.folderSync().then((s) => live && setElsewhere(s.elsewhere), () => {});
    return () => {
      live = false;
    };
  }, [open]);
  const place = async (f: SyncedFolder) => {
    const to = (dest[f.syncId] ?? `~/${f.name}`).trim();
    if (!to || busy) return;
    setBusy(true);
    setError(null);
    try {
      const l = await api.folderSyncLink(f.syncId, to);
      onOpened(l.id.slice(3).split("/")[0], l.name, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = desktop()?.pickFolder;
  const submit = async (p = path) => {
    const clean = p.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      const f = await api.openFolder(clean);
      onOpened(f.id, f.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="note-newfile sm:max-w-[30rem]" onOpenAutoFocus={(e) => (e.preventDefault(), (e.currentTarget as HTMLElement).querySelector("input")?.focus())}>
        <DialogTitle className="text-[17px]">Open a folder</DialogTitle>
        <DialogDescription className="text-[13px]">
          A folder on this computer, shown in the Notebook as it is. Its files stay where they are: Markdown opens in a live editor, and what you change is saved to the file.
        </DialogDescription>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex gap-2">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Notes" aria-label="Folder path" spellCheck={false} autoComplete="off" className="note-newfile-input min-w-0 flex-1" />
            {pick && (
              <button
                type="button"
                className="lib-raised inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] px-3 text-[14px] font-[600]"
                onClick={() =>
                  void pick().then((p) => {
                    if (!p) return;
                    setPath(p);
                    void submit(p);
                  })
                }
              >
                <FolderOpen className="size-4" /> Browse…
              </button>
            )}
          </div>
          <div className="min-h-[18px] text-[12.5px] text-[var(--danger)]" aria-live="polite">{error}</div>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="lib-raised inline-flex h-9 items-center rounded-[10px] px-4 text-[14px] font-[600]">Cancel</button>
            <button type="submit" disabled={!path.trim() || busy} className="lib-primary inline-flex h-9 items-center rounded-[10px] px-4 text-[14px] font-[600] disabled:opacity-50">Open</button>
          </div>
        </form>
        {elsewhere.length > 0 && (
          <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3" data-synced-elsewhere>
            <div className="text-[13px] font-[600]">Synced from your other devices</div>
            <div className="text-[12.5px] text-muted-foreground">Say where each goes on this computer. Its files come through Sync and stay in step.</div>
            {elsewhere.map((f) => (
              <form
                key={f.syncId}
                className="flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void place(f);
                }}
              >
                <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                  <span className="min-w-0 truncate font-[550]">{f.name}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">{f.files === 1 ? "1 file" : `${f.files} files`} · {fileSize(f.bytes)}</span>
                </div>
                <div className="flex gap-2">
                  <input value={dest[f.syncId] ?? `~/${f.name}`} onChange={(e) => setDest((d) => ({ ...d, [f.syncId]: e.target.value }))} aria-label={`Where ${f.name} goes`} spellCheck={false} autoComplete="off" className="note-newfile-input min-w-0 flex-1" />
                  <button type="submit" disabled={busy} className="lib-raised inline-flex h-10 shrink-0 items-center rounded-[10px] px-3 text-[14px] font-[600] disabled:opacity-50">Put it here</button>
                </div>
              </form>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Starting or stopping Sync for a folder on this computer: what will travel, and what stays. */
export function FolderSyncDialog({ ask, onClose, onDone }: { ask: { kind: "on" | "off"; id: string; name: string } | null; onClose(): void; onDone(what: "on" | "off" | "ended"): void }) {
  const [est, setEst] = useState<{ files: number; bytes: number; tooBig: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEst(null);
    setError(null);
    if (ask?.kind !== "on") return;
    let live = true;
    void api.folderSyncEstimate(ask.id).then((e) => live && setEst(e), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [ask]);
  const run = async (what: "on" | "off" | "ended") => {
    if (!ask || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (what === "on") await api.folderSyncOn(ask.id);
      else await api.folderSyncOff(ask.id, what === "ended");
      onDone(what);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const btn = "inline-flex h-9 items-center rounded-[10px] px-4 text-[14px] font-[600] disabled:opacity-50";
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="note-newfile sm:max-w-[30rem]" data-folder-sync={ask?.kind}>
        {ask?.kind === "on" ? (
          <>
            <DialogTitle className="text-[17px]">Sync “{ask.name}” to your other devices</DialogTitle>
            <DialogDescription className="text-[13px]">
              Every file in it travels as it is, encrypted, through Sync. On another computer, Notebook → Open a folder lists it, and you say where it goes there. This computer is the folder's home: when one file changes in two places, the version here keeps the name and the other is kept beside it.
            </DialogDescription>
            <div className="text-[13.5px]" data-folder-sync-size>
              {est ? (
                <>
                  {est.files === 1 ? "1 file" : `${est.files} files`}, {fileSize(est.bytes)}.{est.tooBig > 0 && ` ${est.tooBig === 1 ? "1 file is" : `${est.tooBig} files are`} over 100 MB and ${est.tooBig === 1 ? "stays" : "stay"} on this computer.`}
                </>
              ) : error ? null : (
                "Counting the files…"
              )}
            </div>
            <div className="min-h-[18px] text-[12.5px] text-[var(--danger)]" aria-live="polite">{error}</div>
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={`lib-raised ${btn}`}>Cancel</button>
              <button type="button" disabled={!est || busy} onClick={() => void run("on")} className={`lib-primary ${btn}`}>Sync this folder</button>
            </div>
          </>
        ) : ask ? (
          <>
            <DialogTitle className="text-[17px]">Stop syncing “{ask.name}”</DialogTitle>
            <DialogDescription className="text-[13px]">
              Its files stay where they are, on this computer and on your other devices. Stop it here and the others go on syncing it between them; end it for every device and it leaves Sync.
            </DialogDescription>
            <div className="min-h-[18px] text-[12.5px] text-[var(--danger)]" aria-live="polite">{error}</div>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onClose} className={`lib-raised ${btn}`}>Cancel</button>
              <button type="button" disabled={busy} onClick={() => void run("ended")} className={`lib-raised ${btn}`}>End for every device</button>
              <button type="button" disabled={busy} onClick={() => void run("off")} className={`lib-primary ${btn}`}>Stop on this computer</button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** A picture, a recording or a video from disk, shown as itself under the pane's top bar. */
export function LocalMediaView({ note, top }: { note: Note; top: React.ReactNode }) {
  // The file's time in the address makes a changed file load again instead of coming from the cache.
  const url = useEtudeSrc(note.src ? `${note.src}&v=${encodeURIComponent(note.updated)}` : null);
  const type = note.local?.type;
  const name = note.local?.name ?? note.title;
  return (
    <article className="note-page note-canvas-page local-file-page">
      {top}
      <div className="local-media" data-type={type}>
        {!url ? null : type === "image" ? (
          <img src={url} alt={name} draggable={false} />
        ) : type === "video" ? (
          <video src={url} controls preload="metadata" />
        ) : (
          <div className="local-audio">
            <span className="local-other-name">{name}</span>
            <audio src={url} controls preload="metadata" />
          </div>
        )}
      </div>
    </article>
  );
}

/** A file Etude has no view for (or text it can't edit): what it is, where it is, and a way to get it. */
export function LocalOtherView({ note, top, path }: { note: Note; top: React.ReactNode; path: string | null }) {
  const local = note.local;
  const name = local?.name ?? note.title;
  const why =
    local?.locked === "large"
      ? "This file is too big to edit here (5 MB at most)."
      : local?.locked === "encoding"
        ? "This file isn't UTF-8 text, so Etude leaves it as it is."
        : "Etude has no view for this kind of file.";
  return (
    <article className="note-page note-canvas-page local-file-page">
      {top}
      <div className="local-other">
        <FileIcon className="size-9 text-muted-foreground" aria-hidden />
        <h1 className="local-other-name">{name}</h1>
        <p className="text-[13.5px] text-muted-foreground">
          {why} {local ? fileSize(local.size) : ""}
        </p>
        {path && (
          <button type="button" className="local-other-path" title="Copy the path" onClick={() => copyPath(path)}>
            {path}
          </button>
        )}
        <a className="lib-raised mt-2 inline-flex h-9 items-center gap-2 rounded-[10px] px-4 text-[14px] font-[600]" href={api.noteExportUrl(note.id, "md")} download={name}>
          <Download className="size-4" /> Download
        </a>
      </div>
    </article>
  );
}
