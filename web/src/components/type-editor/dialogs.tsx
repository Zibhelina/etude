// New type (blank or copied from another) and import dialogs.
import { useEffect, useState } from "react";
import { Check, FileJson, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, type CardType, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { BLANK_SAMPLE, blankType, exportShape, slugify, stashPending, TYPE_ID, typesFromJson } from "./starter";

export function NewTypeDialog({
  open,
  onOpenChange,
  types,
  from,
  initialSource,
  folder,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  types: TypeSummary[];
  /** Duplicate this draft (from the editor) instead of offering a choice. */
  from?: { def: CardType; sample: Record<string, unknown> };
  /** Preselect "copy" with this type id (from the list's row menu). */
  initialSource?: string;
  /** File the new type in this Types-page folder when it's saved. */
  folder?: string;
}) {
  const [mode, setMode] = useState<"blank" | "copy">("blank");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setIdTouched(false);
    if (from) {
      setMode("copy");
      setName(`${from.def.name} copy`);
      setId(freeId(`${from.def.id}-copy`, types));
    } else if (initialSource) {
      const t = types.find((x) => x.id === initialSource);
      setMode("copy");
      setSource(initialSource);
      setName(t ? `${t.name} copy` : "");
      setId(freeId(`${initialSource}-copy`, types));
    } else {
      setMode("blank");
      setSource(types[0]?.id ?? "");
      setName("");
      setId("");
    }
  }, [open]);

  const taken = types.some((t) => t.id === id);
  const validId = TYPE_ID.test(id);
  const canCreate = !!name.trim() && validId && !taken && (mode === "blank" || !!from || !!source) && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      let def: CardType;
      let sample: Record<string, unknown> | undefined;
      let fromId: string | undefined;
      if (mode === "blank") {
        def = blankType(id, name.trim());
        sample = { ...BLANK_SAMPLE };
      } else if (from) {
        def = { ...exportShape(from.def), id, name: name.trim() };
        sample = from.sample;
        fromId = from.def.id;
      } else {
        const src = await api.type(source);
        def = { ...exportShape(src), id, name: name.trim() };
        fromId = source;
      }
      stashPending({ def, sample, from: fromId, ...(folder ? { folder } : {}) });
      onOpenChange(false);
      navigate(`/types/${encodeURIComponent(id)}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{from ? `Duplicate ${from.def.name}` : folder ? `New card type in “${folder.split("::").pop()}”` : "New card type"}</DialogTitle>
          <DialogDescription>
            {from ? "Makes an independent copy, including unsaved edits. Nothing is created until you save it." : "Nothing is created until you save it in the editor."}
          </DialogDescription>
        </DialogHeader>
        {!from && (
          <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as "blank" | "copy")} className="w-full">
            <ToggleGroupItem value="blank" className="h-10 flex-1">Start blank</ToggleGroupItem>
            <ToggleGroupItem value="copy" className="h-10 flex-1">Copy a type</ToggleGroupItem>
          </ToggleGroup>
        )}
        {!from && mode === "blank" && (
          <p className="-mt-1 text-xs text-muted-foreground">A minimal working type: a prompt, a typed answer checked by script, and an explanation. Change anything from there.</p>
        )}
        {!from && mode === "copy" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Copy from</span>
            <Select
              value={source}
              onValueChange={(v) => {
                setSource(v);
                const t = types.find((x) => x.id === v);
                if (t && !name.trim()) setName(`${t.name} copy`);
                if (!idTouched) setId(freeId(`${v}-copy`, types));
              }}
            >
              <SelectTrigger className="h-10 w-full"><SelectValue placeholder="Pick a type" /></SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name} <span className="font-mono text-xs text-muted-foreground">{t.id}</span></SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!idTouched) setId(slugify(e.target.value));
            }}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="True or false"
            className="h-10"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Id</span>
          <Input
            value={id}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64));
            }}
            onKeyDown={(e) => e.key === "Enter" && create()}
            className={cn("h-10 font-mono text-[13px]", id && (!validId || taken) && "border-destructive")}
            spellCheck={false}
            placeholder="true-false"
          />
          <span className={cn("text-xs", id && (!validId || taken) ? "text-destructive" : "text-muted-foreground")}>
            {taken ? `"${id}" is already a type.` : id && !validId ? "Lowercase letters, digits and dashes, starting with a letter or digit." : "Items refer to the type by this id. It can't change after saving."}
          </span>
        </div>
        <DialogFooter>
          <Button onClick={create} disabled={!canCreate} className="h-10 gap-1.5 sm:h-9">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Open in editor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function freeId(base: string, types: TypeSummary[]): string {
  const b = slugify(base) || "type";
  if (!types.some((t) => t.id === b)) return b;
  let n = 2;
  while (types.some((t) => t.id === `${b}-${n}`)) n++;
  return `${b}-${n}`;
}

type Candidate = { def: CardType; exists: TypeSummary | undefined; take: boolean };

export function ImportTypesDialog({ open, onOpenChange, types, onDone }: { open: boolean; onOpenChange(o: boolean): void; types: TypeSummary[]; onDone(): void }) {
  const [file, setFile] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setCandidates([]);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const read = async (f: File) => {
    setFile(f.name);
    setError(null);
    try {
      const found = typesFromJson(JSON.parse(await f.text()));
      if (!found.length) {
        setCandidates([]);
        setError("No card types in this file. Expected a type, a list of types, or a pack with a \"types\" list.");
        return;
      }
      setCandidates(found.map((def) => {
        const exists = types.find((t) => t.id === def.id);
        return { def, exists, take: !exists };
      }));
    } catch (e) {
      setCandidates([]);
      setError(`Couldn't read ${f.name}: ${(e as Error).message}`);
    }
  };

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => input.files?.[0] && read(input.files[0]);
    input.click();
  };

  const run = async () => {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const c of candidates.filter((c) => c.take)) {
      try {
        await api.saveType(c.def);
        ok++;
      } catch (e) {
        failed.push(`${c.def.id}: ${(e as Error).message.replace(/^invalid type:\s*/, "")}`);
      }
    }
    setBusy(false);
    if (ok) toast.success(`Imported ${ok} type${ok === 1 ? "" : "s"}`);
    onDone();
    if (failed.length) setError(failed.join("\n"));
    else onOpenChange(false);
  };

  const chosen = candidates.filter((c) => c.take).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import card types</DialogTitle>
          <DialogDescription>A type JSON file (as exported here), a list of types, or a pack. Only the types are imported; use Decks › Import for a whole pack.</DialogDescription>
        </DialogHeader>
        <button
          onClick={pick}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) read(f);
          }}
          className={cn("flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:border-ring hover:text-foreground", drag && "border-highlight text-foreground")}
        >
          {file ? <FileJson className="size-5" /> : <Upload className="size-5" />}
          {file ? <span className="font-mono text-xs">{file}</span> : <span>Choose or drop a .json file</span>}
        </button>
        {candidates.length > 0 && (
          <div className="flex flex-col divide-y rounded-lg border">
            {candidates.map((c, i) => (
              <label key={c.def.id + i} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--highlight)]"
                  checked={c.take}
                  onChange={(e) => setCandidates(candidates.map((x, k) => (k === i ? { ...x, take: e.target.checked } : x)))}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{c.def.name || c.def.id}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{c.def.id}</div>
                </div>
                <span className={cn("shrink-0 text-xs", c.exists ? "text-warning" : "text-muted-foreground")}>
                  {c.exists ? (c.exists.shipped ? "replaces built-in" : "replaces existing") : "new"}
                </span>
              </label>
            ))}
          </div>
        )}
        {error && <pre className="whitespace-pre-wrap break-words rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 font-mono text-[12px] text-destructive">{error}</pre>}
        <DialogFooter>
          <Button onClick={run} disabled={!chosen || busy} className="h-10 gap-1.5 sm:h-9">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Import {chosen ? `${chosen} type${chosen === 1 ? "" : "s"}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
