// What the collection keeps until you decide: cards a type no longer makes, media nothing names.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api, type CleanupReport } from "@/lib/api";
import { navigate } from "@/lib/router";
import { Block, Section } from "@/components/settings-ui";

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Leftover cards to delete: every one, or one type's face. */
type CardTarget = { type?: string; face?: string; label?: string; cards: number; reviews: number };

export function CleanupSection() {
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ cards: CardTarget } | { media: true } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.cleanup().then(setReport, (e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const remove = async (what: NonNullable<typeof confirm>) => {
    setBusy(true);
    try {
      if ("cards" in what) {
        const r = await api.deleteLeftoverCards({ type: what.cards.type, face: what.cards.face });
        toast.success(`Deleted ${count(r.cards, "card")}`);
      } else {
        const r = await api.deleteUnusedMedia();
        toast.success(`Deleted ${count(r.files, "file")} (${size(r.bytes)})`);
      }
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const left = report?.leftover;
  const media = report?.media;
  const target = confirm && "cards" in confirm ? confirm.cards : null;
  const checking = !report && !error && <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking…</span>;
  const deleteButton = (label: string, n: number | undefined, onClick: () => void) => (
    <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" disabled={!n || busy} onClick={onClick}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{label}
    </Button>
  );

  return (
    <Section id="cleanup" title="Clean up" description="Things Etude keeps until you decide to delete them. Deleting can't be undone, so back up the database and media folder first if you're unsure.">
      <Block
        title="Leftover cards"
        description="Cards your card types no longer create, for example after removing a face from a type: the cards that face made for existing items stay. Saving a type never deletes cards, so review history isn't lost by accident. Until deleted they still come up in study unless suspended. View shows them in Browse."
        stackAside
        aside={left && deleteButton(left.faces.length > 1 ? "Delete all" : "Delete", left.cards, () => setConfirm({ cards: left }))}
      >
        {error && <p className="text-sm text-destructive">{error}</p>}
        {checking}
        {left && (left.cards ? (
          <ul className="flex flex-col divide-y rounded-lg border text-sm">
            {left.faces.map((f) => (
              <li key={`${f.type}/${f.face}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                  <span>{f.typeName}</span>
                  <span className="font-mono text-xs text-muted-foreground">{f.face}</span>
                  <span className="tabular text-muted-foreground">· {count(f.cards, "card")}{f.reviews ? `, ${count(f.reviews, "review")}` : ""}</span>
                </div>
                <div className="flex gap-1.5">
                  <Button variant="ghost" size="sm" className="h-8" onClick={() => navigate(`/browse?q=${encodeURIComponent(`is:leftover type:${f.type} face:${f.face}`)}`)}>View</Button>
                  {left.faces.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => setConfirm({ cards: { type: f.type, face: f.face, label: `${f.typeName}, ${f.face}`, cards: f.cards, reviews: f.reviews } })}>Delete</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">None.</p>)}
      </Block>
      <Block
        title="Unused media"
        description="Files in the media folder that no card, type, deck, tag, setting or past answer names. Files added in the last hour and names starting with _ (which templates may load themselves) are kept."
        stackAside
        aside={media && deleteButton("Delete", media.count, () => setConfirm({ media: true }))}
      >
        {checking}
        {media && (media.count ? (
          <details className="text-sm">
            <summary className="cursor-pointer tabular">{count(media.count, "file")} · {size(media.bytes)}</summary>
            <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {media.files.map((f) => (
                <li key={f.path} className="flex gap-3">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">{f.path}</span>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">{size(f.bytes)}</span>
                </li>
              ))}
              {media.count > media.files.length && <li className="text-xs text-muted-foreground">and {count(media.count - media.files.length, "more file")}</li>}
            </ul>
          </details>
        ) : <p className="text-sm text-muted-foreground">None.</p>)}
      </Block>

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target ? `Delete ${count(target.cards, "leftover card")}${target.label ? ` (${target.label})` : ""}?` : `Delete ${count(media?.count ?? 0, "unused file")}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target
                ? !target.reviews
                  ? target.cards === 1 ? "It has no review history." : "None of them has review history."
                  : target.cards === 1
                    ? `Its review history (${count(target.reviews, "review")}) is deleted with it.`
                    : `Their review history (${count(target.reviews, "review")}) is deleted with them.`
                : "They're removed from the media folder, and database backups don't include media."}{" "}
              This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => confirm && remove(confirm)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
