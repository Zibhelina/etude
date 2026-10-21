// Edits a type's field schema: add, remove, reorder, and each field's kind, flags and default.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, EyeOff, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FieldSpec } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FIELD_NAME } from "./starter";

const KINDS: { value: FieldSpec["kind"]; label: string; hint: string }[] = [
  { value: "markdown", label: "Markdown", hint: "Rich text with math and code" },
  { value: "text", label: "Text", hint: "One line of plain text" },
  { value: "number", label: "Number", hint: "" },
  { value: "boolean", label: "Boolean", hint: "" },
  { value: "list", label: "List", hint: "A list of strings" },
  { value: "json", label: "JSON", hint: "Any structured value" },
  { value: "code", label: "Code", hint: "Monospace text" },
];

const EDITORS = [
  { value: "none", label: "Default editor" },
  { value: "choices", label: "Choices: [{ text, correct, why }]" },
  { value: "pairs", label: "Pairs: [[left, right]]" },
  { value: "parts", label: "Parts: [{ label, answer, unit, tolerance }]" },
];

export function FieldsSchema({
  fields,
  onChange,
  onRename,
  itemCount,
}: {
  fields: FieldSpec[];
  onChange(f: FieldSpec[]): void;
  /** Lets the editor carry sample values over when a field is renamed. */
  onRename?(from: string, to: string): void;
  itemCount: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const names = fields.map((f) => f.name);
  const set = (i: number, f: FieldSpec) => onChange(fields.map((x, k) => (k === i ? f : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const next = fields.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (open === i) setOpen(j);
    else if (open === j) setOpen(i);
  };
  const add = () => {
    let n = fields.length + 1;
    while (names.includes(`field${n}`)) n++;
    onChange([...fields, { name: `field${n}`, kind: "markdown" }]);
    setOpen(fields.length);
  };

  return (
    <div className="flex flex-col gap-3">
      {itemCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Items store their fields by name. Renaming or removing a field here doesn't change the {itemCount} existing item{itemCount === 1 ? "" : "s"}.
        </p>
      )}
      {!fields.length && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No fields yet. A type needs at least one field to hold content.</div>}
      <div className="flex flex-col gap-2">
        {fields.map((f, i) => {
          const badName = !FIELD_NAME.test(f.name);
          const dup = names.indexOf(f.name) !== i;
          const expanded = open === i;
          return (
            <div key={i} className={cn("rounded-lg border bg-card/30", (badName || dup) && "border-destructive/60")}>
              <div className="flex flex-wrap items-center gap-2 p-2 sm:flex-nowrap">
                <button
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setOpen(expanded ? null : i)}
                  aria-label={expanded ? "Collapse field" : "Expand field"}
                  aria-expanded={expanded}
                >
                  <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
                </button>
                <Input
                  value={f.name}
                  onChange={(e) => {
                    const name = e.target.value.replace(/\s+/g, "_");
                    onRename?.(f.name, name);
                    set(i, { ...f, name });
                  }}
                  className="h-9 min-w-0 flex-1 basis-32 font-mono text-[13px]"
                  aria-label="Field name"
                  spellCheck={false}
                />
                <Select value={f.kind} onValueChange={(v) => set(i, { ...f, kind: v as FieldSpec["kind"], default: undefined })}>
                  <SelectTrigger className="h-9 w-[7.5rem] shrink-0" aria-label="Kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {KINDS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="icon" className="size-9" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp className="size-4" /></Button>
                  <Button variant="ghost" size="icon" className="size-9" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label="Move down"><ArrowDown className="size-4" /></Button>
                  <Button variant="ghost" size="icon" className="size-9" onClick={() => { onChange(fields.filter((_, k) => k !== i)); setOpen(null); }} aria-label="Remove field"><Trash2 className="size-4" /></Button>
                </div>
              </div>
              {!expanded && (f.required || f.private || f.label) && (
                <div className="-mt-1 flex flex-wrap gap-x-3 gap-y-1 px-[3.25rem] pb-2 text-xs text-muted-foreground">
                  {f.label && <span>“{f.label}”</span>}
                  {f.required && <span>required</span>}
                  {f.private && <span className="flex items-center gap-1"><EyeOff className="size-3" />hidden until answered</span>}
                </div>
              )}
              {(badName || dup) && (
                <p className="px-3 pb-2 text-xs text-destructive">{dup ? `"${f.name}" is used twice.` : "Use letters, digits and _, starting with a letter or _."}</p>
              )}
              {expanded && <FieldDetails field={f} onChange={(nf) => set(i, nf)} />}
            </div>
          );
        })}
      </div>
      <Button variant="outline" size="sm" className="h-9 self-start gap-1.5" onClick={add}><Plus className="size-4" />Add field</Button>
    </div>
  );
}

function FieldDetails({ field: f, onChange }: { field: FieldSpec; onChange(f: FieldSpec): void }) {
  const kind = KINDS.find((k) => k.value === f.kind);
  return (
    <div className="flex flex-col gap-4 border-t px-3 py-4 sm:px-4">
      {kind?.hint && <p className="-mt-1 text-xs text-muted-foreground">{kind.hint}.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Labeled label="Label" hint="Shown in editors instead of the name.">
          <Input value={f.label ?? ""} onChange={(e) => onChange({ ...f, label: e.target.value || undefined })} placeholder={f.name} />
        </Labeled>
        <Labeled label="Editor" hint="A structured form for common JSON shapes.">
          <Select value={f.editor ?? "none"} onValueChange={(v) => onChange({ ...f, editor: v === "none" ? undefined : (v as FieldSpec["editor"]) })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EDITORS.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Labeled>
      </div>
      <Labeled label="Description" hint="Help text shown under the field in editors.">
        <Input value={f.description ?? ""} onChange={(e) => onChange({ ...f, description: e.target.value || undefined })} />
      </Labeled>
      <Labeled label="Default" hint="Used when an item leaves the field empty.">
        <DefaultInput field={f} onChange={(d) => onChange({ ...f, default: d })} />
      </Labeled>
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-8">
        <label className="flex min-h-9 items-center gap-2.5 text-sm">
          <Switch checked={!!f.required} onCheckedChange={(v) => onChange({ ...f, required: v || undefined })} />
          Required
        </label>
        <label className="flex min-h-9 items-center gap-2.5 text-sm">
          <Switch checked={!!f.private} onCheckedChange={(v) => onChange({ ...f, private: v || undefined })} />
          <span>Hidden until answered <span className="text-muted-foreground">(private)</span></span>
        </label>
      </div>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function DefaultInput({ field: f, onChange }: { field: FieldSpec; onChange(v: unknown): void }) {
  const [text, setText] = useState(() => toText(f));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(toText(f));
    setError(null);
  }, [f.kind]);

  if (f.kind === "boolean")
    return (
      <Select value={f.default === undefined ? "unset" : String(f.default)} onValueChange={(v) => onChange(v === "unset" ? undefined : v === "true")}>
        <SelectTrigger className="w-full sm:w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="unset">No default</SelectItem>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  const structured = f.kind === "list" || f.kind === "json";
  return (
    <div className="flex flex-col gap-1">
      <Input
        value={text}
        className={cn((structured || f.kind === "number") && "font-mono text-[13px]")}
        placeholder={structured ? (f.kind === "list" ? '["a", "b"]' : "JSON value") : "No default"}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (!t.trim()) {
            setError(null);
            return onChange(undefined);
          }
          if (f.kind === "number") {
            const n = Number(t);
            if (Number.isFinite(n)) {
              setError(null);
              onChange(n);
            } else setError("Not a number");
          } else if (structured) {
            try {
              const v = JSON.parse(t);
              if (f.kind === "list" && !Array.isArray(v)) throw new Error("A list default must be an array");
              setError(null);
              onChange(v);
            } catch (err) {
              setError((err as Error).message);
            }
          } else onChange(t);
        }}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function toText(f: FieldSpec): string {
  if (f.default === undefined) return "";
  if (f.kind === "list" || f.kind === "json") return JSON.stringify(f.default);
  return String(f.default);
}
