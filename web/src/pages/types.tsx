import { useEffect, useState } from "react";
import { Copy, Download, MoreHorizontal, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeEditor, Kind } from "@/components/type-editor/editor";
import { ImportTypesDialog, NewTypeDialog } from "@/components/type-editor/dialogs";
import { download, exportShape, GRADER_LABEL } from "@/components/type-editor/starter";
import { api, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";

export function TypesPage({ id }: { id: string | null }) {
  if (id) return <TypeEditor key={id} id={id} />;
  return <TypeList />;
}

function TypeList() {
  const [types, setTypes] = useState<TypeSummary[] | null>(null);
  const [creating, setCreating] = useState<{ source?: string } | null>(null);
  const [importing, setImporting] = useState(false);

  const reload = () => api.types().then(setTypes).catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    reload();
  }, []);

  const exportType = async (t: TypeSummary) => {
    try {
      download(`${t.id}.type.json`, exportShape(await api.type(t.id)));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const builtins = (types ?? []).filter((t) => t.shipped);
  const custom = (types ?? []).filter((t) => !t.shipped);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Card types</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            A type is fields, an HTML/CSS/JS template and a grader. The built-in ones are written the same way, so any of them can be copied or changed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setImporting(true)}><Upload className="size-4" />Import</Button>
          <Button size="sm" className="h-9 gap-1.5" onClick={() => setCreating({})}><Plus className="size-4" />New type</Button>
        </div>
      </div>

      {!types && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}
        </div>
      )}

      {types && (
        <div className="flex flex-col gap-8">
          <Section title="Custom" count={custom.length}>
            {custom.length ? (
              custom.map((t) => <Row key={t.id} t={t} onExport={exportType} onDuplicate={() => setCreating({ source: t.id })} />)
            ) : (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <p className="max-w-sm text-sm text-muted-foreground">No custom types yet. Start from a blank template, or copy a built-in one and make it yours.</p>
                <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setCreating({})}><Plus className="size-4" />New type</Button>
              </div>
            )}
          </Section>
          <Section title="Built in" count={builtins.length}>
            {builtins.map((t) => <Row key={t.id} t={t} onExport={exportType} onDuplicate={() => setCreating({ source: t.id })} />)}
          </Section>
        </div>
      )}

      <NewTypeDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} types={types ?? []} initialSource={creating?.source} />
      <ImportTypesDialog open={importing} onOpenChange={setImporting} types={types ?? []} onDone={reload} />
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 flex items-baseline gap-2 px-1 text-sm font-medium text-muted-foreground">
        {title}<span className="tabular text-xs">{count}</span>
      </h2>
      <div className="overflow-hidden rounded-xl border bg-card/40">{children}</div>
    </section>
  );
}

function Row({ t, onExport, onDuplicate }: { t: TypeSummary; onExport(t: TypeSummary): void; onDuplicate(): void }) {
  return (
    <div className="group flex items-stretch border-b last:border-b-0 hover:bg-accent/40">
      <button className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left" onClick={() => navigate(`/types/${encodeURIComponent(t.id)}`)}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.95rem] font-medium">{t.name}</span>
          <code className="font-mono text-xs text-muted-foreground">{t.id}</code>
          {/* The section says built-in or custom; only an edited built-in needs a badge. */}
          {t.edited && <Kind summary={t} />}
        </div>
        {t.description && <p className="line-clamp-2 text-sm text-muted-foreground">{t.description}</p>}
        <div className="flex items-center gap-2 text-xs text-muted-foreground sm:hidden">
          <span>{GRADER_LABEL[t.grader] ?? t.grader}</span>
          <span>·</span>
          <span className="tabular">{t.items} item{t.items === 1 ? "" : "s"}</span>
        </div>
      </button>
      <div className="hidden w-24 shrink-0 flex-col items-start gap-0.5 pt-3.5 text-xs text-muted-foreground sm:flex">
        <span>{GRADER_LABEL[t.grader] ?? t.grader}</span>
        <span className="tabular">{t.items} item{t.items === 1 ? "" : "s"}</span>
      </div>
      <div className="flex shrink-0 items-start pr-2 pt-2 sm:pl-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10" aria-label={`Actions for ${t.name}`}><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onDuplicate}><Copy />Duplicate…</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport(t)}><Download />Export JSON</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
