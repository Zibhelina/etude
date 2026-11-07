// New type (described to Ask Etude, copied from another, or blank) and import dialogs.
import { useEffect, useState } from "react";
import { Check, Code2, Copy, FileJson, Loader2, Plus, Upload, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { askEtude } from "@/components/agent-panel";
import { faceSrc, minimiFaceId } from "@/lib/minimi-face";
import { useFunMode } from "@/lib/fun";
import { api, type CardType, type TypeSummary } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { BLANK_SAMPLE, blankType, exportShape, slugify, stashPending, TYPE_ID, typesFromJson } from "./starter";
import { TypeThumb } from "./type-card";

export type Start = "describe" | "copy" | "blank";

export function NewTypeDialog({
  open,
  onOpenChange,
  types,
  from,
  initialSource,
  folder,
  start,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  types: TypeSummary[];
  /** Duplicate this draft (from the editor) instead of offering a choice. */
  from?: { def: CardType; sample: Record<string, unknown> };
  /** Preselect "copy" with this type id (from a type's menu). */
  initialSource?: string;
  /** File the new type in this Types-page folder when it's saved. */
  folder?: string;
  /** Which way to start when the dialog opens. */
  start?: Start;
}) {
  const fun = useFunMode();
  const [mode, setMode] = useState<Start>("describe");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [describe, setDescribe] = useState("");
  const shipped = types.filter((t) => t.shipped).sort((a, b) => a.name.localeCompare(b.name));

  const pickSource = (v: string, force = false) => {
    setSource(v);
    const t = types.find((x) => x.id === v);
    if (t && (force || !nameTouched)) setName(`${t.name} copy`);
    if (force || !idTouched) setId(freeId(`${v}-copy`, types));
  };

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setIdTouched(false);
    setNameTouched(false);
    setDescribe("");
    if (from) {
      setMode("copy");
      setName(`${from.def.name} copy`);
      setId(freeId(`${from.def.id}-copy`, types));
    } else if (initialSource) {
      setMode("copy");
      pickSource(initialSource, true);
    } else {
      setMode(start ?? "describe");
      if (start === "copy") pickSource(shipped.find((t) => t.id === "typed")?.id ?? shipped[0]?.id ?? "", true);
      else {
        setSource("");
        setName("");
        setId("");
      }
    }
  }, [open]);

  const choose = (m: Start) => {
    setMode(m);
    if (m === "copy" && !source) pickSource(shipped.find((t) => t.id === "typed")?.id ?? shipped[0]?.id ?? "", true);
    if (m === "blank" && !nameTouched) {
      setName("");
      if (!idTouched) setId("");
    }
  };

  const taken = types.some((t) => t.id === id);
  const validId = TYPE_ID.test(id);
  const canCreate =
    mode === "describe" ? describe.trim().length > 3 && !busy : !!name.trim() && validId && !taken && (mode === "blank" || !!from || !!source) && !busy;
  const sourceName = types.find((t) => t.id === source)?.name ?? source;

  const create = async () => {
    if (!canCreate) return;
    if (mode === "describe") {
      onOpenChange(false);
      askEtude(`Make a new card type${folder ? ` in the Types folder "${folder}"` : ""}: ${describe.trim()}`);
      return;
    }
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
      navigate(`/types/${encodeURIComponent(id)}?edit=1`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  const who = fun ? "Minimi" : "Etude";
  const starts: { k: Start; icon: React.ReactNode; title: string; sub: string }[] = [
    {
      k: "describe",
      icon: fun ? <img src={faceSrc(minimiFaceId())} alt="" className="size-full object-cover" /> : <span className="score-serif text-[1.35rem] leading-none">ε</span>,
      title: "Describe it",
      sub: `Say what you want to practice. ${who} writes it, you check it.`,
    },
    { k: "copy", icon: <Copy className="size-5" />, title: "Copy a type", sub: "Start from one that's close and change it." },
    { k: "blank", icon: <Code2 className="size-5" />, title: "Blank", sub: "Fields, HTML, CSS and a grader, from zero." },
  ];

  const nameAndId = (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Name</span>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
            if (!idTouched) setId(slugify(e.target.value));
          }}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="True or false"
          className="h-10"
        />
      </label>
      <label className="flex flex-col gap-1.5">
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
      </label>
      <span className={cn("-mt-1 text-xs sm:col-span-2", id && (!validId || taken) ? "text-destructive" : "text-muted-foreground")}>
        {taken ? `"${id}" is already a type.` : id && !validId ? "Lowercase letters, digits and dashes, starting with a letter or digit." : "Items refer to the type by this id. It can't change after saving."}
      </span>
    </div>
  );

  if (from)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Duplicate {from.def.name}</DialogTitle>
            <DialogDescription>Makes an independent copy, including unsaved edits. Nothing is created until you save it.</DialogDescription>
          </DialogHeader>
          {nameAndId}
          <DialogFooter>
            <Button onClick={create} disabled={!canCreate} className="h-10 gap-1.5 sm:h-9">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Open in editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] gap-5 overflow-y-auto p-5 sm:max-w-2xl sm:p-7" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="score-serif text-[1.65rem] font-normal">{folder ? `New card type in “${folder.split("::").pop()}”` : "New card type"}</DialogTitle>
          <DialogDescription>How do you want to start?</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Start from">
          {starts.map((o) => (
            <button
              key={o.k}
              role="radio"
              aria-checked={mode === o.k}
              data-start={o.k}
              onClick={() => choose(o.k)}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors hover:bg-accent/50 max-sm:grid max-sm:grid-cols-[2.5rem_1fr] max-sm:gap-x-3",
                mode === o.k ? "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-border",
              )}
            >
              <span className={cn("flex size-11 items-center justify-center overflow-hidden rounded-xl bg-muted max-sm:row-span-2", o.k === "describe" && fun && "rounded-full bg-transparent", mode === o.k ? "text-foreground" : "text-muted-foreground")}>{o.icon}</span>
              <b className="text-[15px] font-semibold">{o.title}</b>
              <span className="text-[13px] leading-snug text-muted-foreground">{o.sub}</span>
            </button>
          ))}
        </div>

        {mode === "describe" && (
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              value={describe}
              onChange={(e) => setDescribe(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && create()}
              placeholder="e.g. Show me a guitar chord diagram and I strum the strings in order. Check the fingering, not the sound."
              className="min-h-28 text-[15px]"
            />
            <p className="text-[13px] text-muted-foreground">{who} writes the fields, the HTML and a grader in Ask Etude, then you open it in the editor with a live preview. Nothing is saved until you press Save.</p>
          </div>
        )}
        {mode === "copy" && (
          <div className="flex flex-col gap-3">
            <div className="grid max-h-[15.5rem] auto-rows-max grid-cols-2 gap-2 overflow-y-auto p-0.5 sm:grid-cols-3" role="listbox" aria-label="Built-in types">
              {shipped.map((t) => (
                <button key={t.id} role="option" aria-selected={source === t.id} data-pick={t.id} onClick={() => pickSource(t.id)} className={cn("overflow-hidden rounded-xl border text-left transition-colors hover:bg-accent/40", source === t.id ? "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-border")}>
                  <TypeThumb t={t} className="h-[4.75rem]" base={620} />
                  <span className={cn("block truncate px-3 py-2 text-[13.5px] font-medium", source === t.id && "text-highlight")}>{t.name}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">or copy any type</span>
              <Select value={source} onValueChange={(v) => pickSource(v)}>
                <SelectTrigger className="h-10 w-full"><SelectValue placeholder="Pick a type" /></SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name} <span className="font-mono text-xs text-muted-foreground">{t.id}</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {nameAndId}
          </div>
        )}
        {mode === "blank" && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted-foreground">A minimal working type: a prompt, a typed answer checked by script, and an explanation. Change anything from there.</p>
            {nameAndId}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-[13px] text-muted-foreground">{mode === "copy" ? "Copies its fields, code and grader" : ""}</span>
          <Button variant="outline" className="types-raised h-10 px-4 text-[15px]" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={!canCreate} className="h-10 gap-1.5 px-4 text-[15px]">
            {busy ? <Loader2 className="size-4 animate-spin" /> : mode === "describe" ? <WandSparkles className="size-4" /> : mode === "copy" ? <Copy className="size-4" /> : <Plus className="size-4" />}
            {mode === "describe" ? "Write it" : mode === "copy" ? `Copy ${sourceName}` : "Create"}
          </Button>
        </div>
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
