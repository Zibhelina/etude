// Edits an item's fields from its type's schema. Common JSON shapes get real forms;
// anything else falls back to a JSON editor, so every type stays editable.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, EyeOff, MoreVertical, Plus, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CodeEditor } from "@/components/code-editor";
import { AnyCodeEditor, LiveMarkdown } from "@/components/live-editor";
import type { FieldSpec } from "@/lib/api";
import { cn } from "@/lib/utils";
import { MediaPasteProvider } from "@/components/media-paste";
import { MediaTextInput, useMediaInput } from "@/components/media-input";

type Fields = Record<string, unknown>;

/** A code field's language: fixed (`"python"`), or read from another field (`"field:language"`). */
function codeLanguage(spec: FieldSpec, fields: Fields, specs: FieldSpec[]): string {
  const l = spec.language ?? "js";
  if (!l.startsWith("field:")) return l;
  const name = l.slice(6);
  const v = fields[name] ?? specs.find((f) => f.name === name)?.default;
  return typeof v === "string" ? v : "";
}

export function FieldEditor({ fields: specs, value, onChange, onMediaPendingChange }: { fields: FieldSpec[]; value: Fields; onChange(v: Fields): void; onMediaPendingChange?(pending: boolean): void }) {
  const latest = useRef(value);
  latest.current = value;
  const set = (name: string, v: unknown) => {
    const next = { ...latest.current };
    if (v === undefined || v === "") delete next[name];
    else next[name] = v;
    latest.current = next;
    onChange(next);
  };
  const generator = typeof value.generator === "string";
  return (
    <MediaPasteProvider onPendingChange={onMediaPendingChange}><div className="flex flex-col gap-5">
      {specs.map((f) => (
        <FieldRow key={f.name} spec={f}>
          <FieldInput spec={f} value={value[f.name]} language={f.kind === "code" ? codeLanguage(f, value, specs) : undefined} onChange={(v) => set(f.name, v)} />
        </FieldRow>
      ))}
      <FieldRow spec={{ name: "generator", kind: "code", label: "Generator", description: "Optional. The body of a function that receives rng and returns field overrides, so each review shows a new variant." }}>
        {generator || value.generator !== undefined ? (
          <div className="flex flex-col gap-2">
            <CodeEditor lang="js" value={String(value.generator ?? "")} onChange={(v) => set("generator", v)} minHeight={140} />
            <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => set("generator", undefined)}>Remove generator</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="self-start gap-1.5" onClick={() => set("generator", "// rng.int(a, b), rng.pick([...]), rng.float(a, b, digits)\nreturn {};\n")}>
            <Plus className="size-4" /> Add generator
          </Button>
        )}
      </FieldRow>
    </div></MediaPasteProvider>
  );
}

function FieldRow({ spec, children }: { spec: FieldSpec; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <label className="text-sm font-medium">{spec.label ?? spec.name}</label>
        {spec.required && <span className="text-xs text-muted-foreground">required</span>}
        {spec.private && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Hidden from the card until it's graded">
            <EyeOff className="size-3" /> hidden until answered
          </span>
        )}
      </div>
      {spec.description && <p className="-mt-1 text-xs text-muted-foreground">{spec.description}</p>}
      {children}
    </div>
  );
}

function FieldInput({ spec, value, onChange, language }: { spec: FieldSpec; value: unknown; onChange(v: unknown): void; language?: string }) {
  if (spec.editor === "choices") return <ChoicesEditor value={(value as any[]) ?? []} onChange={onChange} />;
  if (spec.editor === "pairs") return <PairsEditor value={(value as any[]) ?? []} onChange={onChange} />;
  if (spec.editor === "parts") return <PartsEditor value={value as any[] | undefined} onChange={onChange} />;
  switch (spec.kind) {
    case "markdown":
      return <LiveMarkdown value={String(value ?? "")} onChange={(v) => onChange(v)} placeholder={spec.default !== undefined ? String(spec.default) : "Markdown, $math$ and ```code``` render as you type"} />;
    case "code":
      return <AnyCodeEditor language={language ?? "js"} value={String(value ?? "")} onChange={onChange} minLines={4} />;
    case "html":
      return <AutoTextarea value={String(value ?? "")} onChange={(v) => onChange(v)} mono placeholder="HTML" mediaFormat="html" />;
    case "text":
      return <MediaTextInput value={String(value ?? "")} placeholder={spec.default !== undefined ? `default: ${spec.default}` : ""} onChange={onChange} />;
    case "number":
      return <NumberInput value={value as number | undefined} placeholder={spec.default !== undefined ? `default: ${spec.default}` : ""} onChange={onChange} />;
    case "boolean":
      return (
        <div className="flex items-center gap-2">
          <Switch checked={value === undefined ? !!spec.default : !!value} onCheckedChange={(v) => onChange(v)} />
          {value === undefined && <span className="text-xs text-muted-foreground">default</span>}
        </div>
      );
    case "list":
      return <ListEditor value={(value as string[]) ?? []} onChange={(v) => onChange(v.length ? v : undefined)} />;
    default:
      return <JsonInput value={value} onChange={onChange} />;
  }
}

export function AutoTextarea({ value, onChange, mono, placeholder, className, mediaFormat }: { value: string; onChange(v: string): void; mono?: boolean; placeholder?: string; className?: string; mediaFormat?: "html" }) {
  const media = useMediaInput(value, onChange, mediaFormat);
  return (
    <Textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => media.change(e.target.value)}
      onPaste={media.paste}
      className={cn("field-sizing-content min-h-16 resize-y", mono && "font-mono text-[13px]", className)}
    />
  );
}

function NumberInput({ value, onChange, placeholder, className }: { value: number | undefined; onChange(v: number | undefined): void; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(value === undefined ? "" : String(value));
  }, [value]);
  return (
    <Input
      className={cn("font-mono", className)}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        if (t === "") onChange(undefined);
        else if (Number.isFinite(Number(t))) onChange(Number(t));
      }}
    />
  );
}

function JsonInput({ value, onChange }: { value: unknown; onChange(v: unknown): void }) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <CodeEditor
        lang="json"
        value={text}
        lineNumbers={false}
        minHeight={60}
        onChange={(t) => {
          setText(t);
          if (!t.trim()) {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(t));
            setError(null);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function Rows<T>({ items, onChange, render, empty, add }: { items: T[]; onChange(v: T[]): void; render(item: T, set: (v: T) => void, i: number): React.ReactNode; empty: T; add: string }) {
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, k) => k !== i));
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => (
        <div key={i} className="group flex items-start gap-1.5">
          <div className="min-w-0 flex-1">{render(it, (v) => onChange(items.map((x, k) => (k === i ? v : x))), i)}</div>
          {/* Desktop: inline icons. Phone: one menu button, so rows stay one line tall. */}
          <div className="hidden shrink-0 gap-0.5 pt-1 opacity-40 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 sm:flex">
            <Button variant="ghost" size="icon" className="size-7" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp className="size-3.5" /></Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down"><ArrowDown className="size-3.5" /></Button>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => remove(i)} aria-label="Remove"><Trash2 className="size-3.5" /></Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground sm:hidden" aria-label="Row actions"><MoreVertical className="size-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp />Move up</DropdownMenuItem>
              <DropdownMenuItem disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown />Move down</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => remove(i)}><Trash2 />Remove</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
      <Button variant="outline" size="sm" className="h-10 self-start gap-1.5 sm:h-8" onClick={() => onChange([...items, structuredClone(empty)])}>
        <Plus className="size-4" /> {add}
      </Button>
    </div>
  );
}

function ListEditor({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  return <Rows items={value} onChange={onChange} empty="" add="Add" render={(v, set, i) => <Input value={v} onChange={(e) => set(e.target.value)} placeholder={`#${i + 1}`} />} />;
}

function ChoicesEditor({ value, onChange }: { value: { text: string; correct?: boolean; why?: string }[]; onChange(v: unknown): void }) {
  return (
    <Rows
      items={value}
      onChange={onChange}
      empty={{ text: "" }}
      add="Add option"
      render={(o, set) => (
        <div className={cn("flex flex-col gap-1.5 rounded-md border p-2", o.correct && "border-good/50 bg-good/5")}>
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => set({ ...o, correct: !o.correct || undefined })}
              className={cn("mt-1.5 flex size-5 shrink-0 items-center justify-center rounded border", o.correct ? "border-good bg-good text-background" : "border-input")}
              title={o.correct ? "Correct" : "Mark as correct"}
            >
              {o.correct && <Check className="size-3.5" />}
            </button>
            <LiveMarkdown className="min-w-0 flex-1 border-0 shadow-none focus-within:shadow-none" minLines={1} value={o.text} onChange={(t) => set({ ...o, text: t })} placeholder="Option text (markdown and $math$)" />
          </div>
          <Input className="h-8 border-dashed text-sm" value={o.why ?? ""} onChange={(e) => set({ ...o, why: e.target.value || undefined })} placeholder="Why (shown after answering, optional)" />
        </div>
      )}
    />
  );
}

function PairsEditor({ value, onChange }: { value: [string, string][]; onChange(v: unknown): void }) {
  return (
    <Rows
      items={value}
      onChange={onChange}
      empty={["", ""] as [string, string]}
      add="Add pair"
      render={(p, set) => (
        <div className="grid gap-1.5 rounded-md border p-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:border-0 sm:p-0">
          <LiveMarkdown minLines={1} value={p[0]} onChange={(v) => set([v, p[1]])} placeholder="Left" />
          <LiveMarkdown minLines={1} value={p[1]} onChange={(v) => set([p[0], v])} placeholder="Right" />
        </div>
      )}
    />
  );
}

function PartsEditor({ value, onChange }: { value: { label: string; answer: number; unit?: string; tolerance?: number }[] | undefined; onChange(v: unknown): void }) {
  if (!value?.length)
    return (
      <Button variant="outline" size="sm" className="self-start gap-1.5" onClick={() => onChange([{ label: "", answer: 0 }])}>
        <Plus className="size-4" /> Make it multi-part
      </Button>
    );
  return (
    <Rows
      items={value}
      onChange={(v) => onChange(v.length ? v : undefined)}
      empty={{ label: "", answer: 0 }}
      add="Add part"
      render={(p, set) => (
        <div className="grid grid-cols-3 gap-1.5 rounded-md border p-1.5 sm:grid-cols-[1fr_7rem_5rem_5rem] sm:gap-2 sm:border-0 sm:p-0">
          <Input className="col-span-3 sm:col-span-1" value={p.label} onChange={(e) => set({ ...p, label: e.target.value })} placeholder="Label, e.g. Area" />
          <NumberInput value={p.answer} onChange={(v) => set({ ...p, answer: v ?? 0 })} placeholder="Answer" />
          <Input value={p.unit ?? ""} onChange={(e) => set({ ...p, unit: e.target.value || undefined })} placeholder="Unit" />
          <NumberInput value={p.tolerance} onChange={(v) => set({ ...p, tolerance: v })} placeholder="Tolerance" />
        </div>
      )}
    />
  );
}
