// Where the collection lives, importing packs and exporting everything.
import { useState } from "react";
import { ArchiveRestore, CircleAlert, CircleCheck, Download, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import { etudeDownload } from "@/lib/local-url";
import { localCore, serverless } from "@/lib/native";
import { Block, CopyValue, Section } from "@/components/settings-ui";

type Counts = { created: number; updated: number; unchanged: number };
interface ImportReport {
  file: string;
  ok: boolean;
  items?: Counts;
  types?: Counts;
  decks?: number;
  presets?: number;
  tags?: number;
  error?: string;
}

export function DataSection({ dbPath, mediaDir }: { dbPath: string; mediaDir: string }) {
  const [reports, setReports] = useState<ImportReport[]>([]);
  const [busy, setBusy] = useState(false);

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      setBusy(true);
      const out: ImportReport[] = [];
      for (const f of files) {
        try {
          let pack: unknown;
          try {
            pack = JSON.parse(await f.text());
          } catch (e) {
            throw new Error(`not valid JSON: ${(e as Error).message}`);
          }
          const r = await api.importPack(pack);
          out.push({ file: f.name, ok: true, items: r.items, types: r.types, decks: r.decks, presets: r.presets, tags: r.tags });
        } catch (e) {
          out.push({ file: f.name, ok: false, error: (e as Error).message });
        }
        setReports([...out]);
      }
      setBusy(false);
    };
    input.click();
  };

  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <Section
      id="data"
      title="Data"
      description={
        serverless()
          ? "The collection lives in this browser, on this device: cards, review history and the media you add. Clearing this site's data in the browser deletes it, so keep a backup or turn on Sync."
          : "The collection lives in a SQLite file. Pasted images, audio, video, imported media and drawings are copied into Etude's own media folder next to it."
      }
    >
      {serverless() ? (
        <BrowserBackup />
      ) : (
        <Block>
          <div className="grid gap-4">
            <CopyValue label="Database" value={dbPath} />
            <CopyValue label="Media folder" value={mediaDir} />
            <p className="text-sm text-muted-foreground">Paste media files or local file paths into a card field to copy them here. Cards keep working when the originals are moved or deleted. Back up this folder together with the database.</p>
          </div>
        </Block>
      )}
      <Block
        title="Import packs"
        description="Add or update decks, types and items from pack files. Items are matched by id, so importing an edited pack again updates it and keeps review history."
        stackAside
        aside={
          <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={pick} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}Choose files
          </Button>
        }
      >
        {reports.length > 0 && (
          <ul className="flex flex-col gap-2">
            {reports.map((r, i) => (
              <li key={i} className="flex gap-3 rounded-lg border px-3.5 py-3 text-sm">
                {r.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
                <div className="min-w-0 flex-1">
                  <div className="break-all font-medium">{r.file}</div>
                  {r.ok && r.items ? (
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Items: <span className="tabular text-foreground/90">{r.items.created}</span> new, <span className="tabular text-foreground/90">{r.items.updated}</span> updated,{" "}
                      <span className="tabular text-foreground/90">{r.items.unchanged}</span> unchanged
                      {r.types && r.types.created + r.types.updated > 0 && (
                        <> · Types: {r.types.created} new, {r.types.updated} updated</>
                      )}
                      {!!r.decks && <> · {r.decks} {r.decks === 1 ? "deck" : "decks"}</>}
                      {!!r.presets && <> · {r.presets} {r.presets === 1 ? "preset" : "presets"}</>}
                    </div>
                  ) : (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-destructive">{r.error}</pre>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block
        title="Export"
        description={`One pack with every item, plus the decks, presets, custom card types and tag notes they use. Review history and scheduling are not in packs; ${serverless() ? "a backup keeps them" : "back up the database file to keep them"}.`}
        stackAside
        aside={
          <Button asChild variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8">
            <a href={api.exportUrl({})} download={`etude-${stamp}.pack.json`} onClick={etudeDownload}>
              <Download className="size-4" />Export pack
            </a>
          </Button>
        }
      />
    </Section>
  );
}

/** The browser edition's backup: the whole collection (database and media) as one zip, and back. */
function BrowserBackup() {
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const core = localCore();

  const download = async () => {
    if (!core) return;
    setBusy("backup");
    try {
      const zip = await core.call<Uint8Array>("_backup");
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      const d = new Date();
      a.download = `etude-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(`Couldn't make the backup: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const [pending, setPending] = useState<File | null>(null);
  const pickBackup = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.onchange = () => setPending(input.files?.[0] ?? null);
    input.click();
  };
  const restore = async (f: File) => {
    if (!core) return;
    setBusy("restore");
    try {
      await core.call("_restore", new Uint8Array(await f.arrayBuffer()));
      location.reload();
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error: /, ""));
      setBusy(null);
    }
  };

  return (
    <Block
      title="Backup"
      description="One file with the whole collection: cards, review history, settings and media. API keys stay out. Restore it here or in another browser."
      stackAside
      aside={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={download} disabled={!!busy}>
            {busy === "backup" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}Download backup
          </Button>
          <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={pickBackup} disabled={!!busy}>
            {busy === "restore" ? <Loader2 className="size-4 animate-spin" /> : <ArchiveRestore className="size-4" />}Restore
          </Button>
        </div>
      }
    >
      <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {pending?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything in this browser is replaced by the backup: cards, review history, settings and media. If Sync is on here, set it up again afterwards. This can't be undone, so download a backup of what's here first if you might want it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => pending && void restore(pending)}>Replace and restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Block>
  );
}
