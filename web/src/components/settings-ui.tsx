// Small layout pieces shared by the settings sections.
import { useEffect, useId, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function Section({ id, title, description, children, className }: { id?: string; title: string; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("scroll-mt-24", className)}>
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</div>}
      </div>
      <div className="rounded-xl border bg-card/40">{children}</div>
    </section>
  );
}

/** One block inside a section card, separated from its neighbours by a hairline.
 *  A switch in `aside` stays beside the title; a wider control (stackAside) drops below it on phones. */
export function Block({ title, description, aside, stackAside, children, className }: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  stackAside?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 border-b px-4 py-5 last:border-b-0 sm:px-5", className)}>
      {(title || aside) && (
        <div className={cn("flex gap-x-4 gap-y-3", stackAside ? "flex-col sm:flex-row sm:items-start" : "items-start")}>
          <div className="min-w-0 flex-1">
            {title && <div className="text-sm font-medium text-foreground/95">{title}</div>}
            {description && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</div>}
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({ label, hint, error, children, className, htmlFor }: { label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, hint, error, value, onChange, placeholder, mono, className, list }: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  list?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} className={className} htmlFor={id}>
      <Input
        id={id}
        value={value}
        list={list}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!!error}
        className={cn("h-10 md:h-9", mono && "font-mono text-[13px] md:text-[13px]")}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** A number input that lets the text be briefly invalid while typing; reports NaN for unparsable text. */
export function NumberField({ label, hint, error, value, onChange, suffix, step, className, min, max }: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  value: number | undefined;
  onChange(v: number): void;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value == null || Number.isNaN(value) ? "" : String(value));
  useEffect(() => {
    if (value != null && !Number.isNaN(value) && Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Field label={label} hint={hint} error={error} className={className} htmlFor={id}>
      <div className="relative sm:max-w-48">
        <Input
          id={id}
          inputMode="decimal"
          value={text}
          step={step}
          min={min}
          max={max}
          aria-invalid={!!error}
          className={cn("tabular h-10 md:h-9", suffix && "pr-14")}
          onChange={(e) => {
            setText(e.target.value);
            const t = e.target.value.trim();
            onChange(t === "" ? NaN : Number(t));
          }}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </Field>
  );
}

export function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy", { description: "The browser blocked clipboard access." });
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <button
        onClick={copy}
        className="group flex min-h-10 w-full items-center gap-3 rounded-md bg-black/40 px-3.5 py-2.5 text-left font-mono text-[13px] text-foreground/85 transition-colors hover:bg-black/60"
        title="Copy"
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {value.split("/").map((part, i) => (
            <span key={i}>
              {i > 0 && "/"}
              {i > 0 && <wbr />}
              {part}
            </span>
          ))}
        </span>
        {copied ? <Check className="size-4 shrink-0 text-success" /> : <Copy className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
      </button>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border bg-secondary/60 px-1.5 text-xs text-foreground/90">{children}</kbd>;
}

/** The shared switch with a hit area big enough for a finger. */
export function BigSwitch(props: React.ComponentProps<typeof Switch>) {
  return <Switch {...props} className={cn("relative mt-0.5 after:absolute after:-inset-3 after:content-['']", props.className)} />;
}
