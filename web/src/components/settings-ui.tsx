// Small layout pieces shared by the settings sections.
import { createContext, useContext, useEffect, useId, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** The page section (Account & Sync, Data, ...) a settings Section renders inside. A Section with the page
 *  section's own id is its main part and shows no label; the others get a small group label above their card. */
export const SettingsPageContext = createContext<string | null>(null);

/** Opens a Disclosure by id, e.g. when search lands on a field inside it. */
export const REVEAL_EVENT = "etude:settings-reveal";

export function GroupLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2.5 px-0.5 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">{children}</h3>;
}

/** The rounded panel rows sit in. */
export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("settings-card rounded-[14px] bg-card ring-1 ring-border ring-inset", className)}>{children}</div>;
}

/** A small line under a card, for context that doesn't need a row of its own. */
export function Note({ children }: { children: React.ReactNode }) {
  return <div className="mt-2.5 px-1 text-[13px] leading-relaxed text-pretty text-muted-foreground">{children}</div>;
}

export function Section({ id, title, description, children, className, bare }: { id?: string; title: string; description?: React.ReactNode; children: React.ReactNode; className?: string; bare?: boolean }) {
  const page = useContext(SettingsPageContext);
  const main = !page || page === id;
  return (
    <section id={id} data-settings-section={id} aria-label={title} className={cn("scroll-mt-24", className)}>
      {!main && <GroupLabel>{title}</GroupLabel>}
      {bare ? children : <Card>{children}</Card>}
      {description && <Note>{description}</Note>}
    </section>
  );
}

/** A labelled card inside a section that has several. */
export function Group({ title, children, note }: { title?: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div>
      {title && <GroupLabel>{title}</GroupLabel>}
      <Card>{children}</Card>
      {note && <Note>{note}</Note>}
    </div>
  );
}

/** Rarely needed settings, folded under one line. */
export function Disclosure({ id, title, open: forced, defaultOpen, children }: { id: string; title: string; open?: boolean; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  useEffect(() => {
    const h = (e: Event) => (e as CustomEvent<string>).detail === id && setOpen(true);
    window.addEventListener(REVEAL_EVENT, h);
    return () => window.removeEventListener(REVEAL_EVENT, h);
  }, [id]);
  const shown = open || !!forced;
  return (
    <div data-disclosure={id}>
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        className="-ml-1 inline-flex phone:h-10 items-center gap-1.5 rounded-md px-1 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground h-8"
      >
        <ChevronRight className={cn("size-4 transition-transform duration-200", shown && "rotate-90")} />
        {title}
      </button>
      {shown && <div className="mt-2 flex flex-col gap-7">{children}</div>}
    </div>
  );
}

/** One row inside a section card, separated from its neighbours by an inset hairline.
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
    <div data-settings-row className={cn("settings-block relative flex flex-col gap-4 px-4 py-[15px] first:rounded-t-[14px] last:rounded-b-[14px] sm:px-[18px]", className)}>
      {(title || aside) && (
        <div className={cn("flex gap-x-4 gap-y-3", stackAside ? "flex-col sm:flex-row sm:items-center" : "items-center")}>
          <div className="min-w-0 flex-1">
            {title && <div data-settings-title className="text-[14.5px] font-semibold text-foreground">{title}</div>}
            {description && <div className="mt-[3px] text-[13px] leading-[1.45] text-pretty text-muted-foreground">{description}</div>}
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({ label, hint, error, children, className, htmlFor, hideLabel }: { label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode; className?: string; htmlFor?: string; hideLabel?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className={cn("text-xs font-medium text-muted-foreground", hideLabel && "sr-only")}>{label}</label>
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
        className={cn("phone:h-10 h-9", mono && "font-mono text-[13px] md:text-[13px]")}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** A number input that lets the text be briefly invalid while typing; reports NaN for unparsable text. */
export function NumberField({ label, hint, error, value, onChange, suffix, step, className, min, max, hideLabel }: {
  label: string;
  hideLabel?: boolean;
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
    <Field label={label} hint={hint} error={error} className={className} htmlFor={id} hideLabel={hideLabel}>
      <div className={cn("relative", !hideLabel && "sm:max-w-48")}>
        <Input
          id={id}
          inputMode="decimal"
          value={text}
          step={step}
          min={min}
          max={max}
          aria-invalid={!!error}
          className={cn("tabular phone:h-10 h-9", suffix && "pr-14")}
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
        className="group flex min-h-10 w-full items-center gap-3 rounded-md bg-background/70 px-3.5 py-2.5 text-left font-mono text-[13px] text-foreground/85 ring-1 ring-border transition-colors hover:bg-accent"
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
  return <Switch {...props} className={cn("relative after:absolute after:-inset-3 after:content-['']", props.className)} />;
}
