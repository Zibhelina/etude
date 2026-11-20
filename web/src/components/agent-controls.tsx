// The controls in Ask's message box: the pickers an agent or model offers (model, reasoning effort, speed), the
// ring that shows how full the context window is and opens the chat's details, and the row a reply's thinking
// folds into. Nothing here is on screen until asked for, except the pills and the ring.
import { useMemo, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronRight, Pencil, RotateCw, Settings2, Shield, ShieldOff, ShieldQuestion, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { permissionStore, type ChatControl, type ContextUse, type Permission } from "@/lib/agent";
import { cn } from "@/lib/utils";

/** The pills in the message box share one shape. */
export const PILL = "achat-pill outline-ring focus-visible:outline-2";

/** "OpenRouter · anthropic/claude-opus-5.5" → the provider and the model's own name. */
function split(name: string): { group: string; label: string } {
  const i = name.indexOf(" · ");
  return i < 0 ? { group: "", label: name } : { group: name.slice(0, i), label: name.slice(i + 3) };
}
/** What fits in a pill: the model's own name, without its vendor folder. */
const short = (name: string) => split(name).label.split("/").pop() || name;

/** The search row of a long picker, with a button that asks for the list again (new models show up without a restart). */
export function PickerSearch({ placeholder, onReload }: { placeholder: string; onReload?: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="relative">
      <CommandInput placeholder={placeholder} className={onReload ? "pr-8" : undefined} />
      {onReload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Reload the list"
              data-picker-reload
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onReload();
                } catch (e) {
                  toast.error("Couldn't reload the list", { description: (e as Error).message });
                } finally {
                  setBusy(false);
                }
              }}
              className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors outline-ring hover:bg-accent hover:text-foreground focus-visible:outline-2 disabled:opacity-60"
            >
              <RotateCw className={cn("size-3.5", busy && "animate-spin")} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Reload the list</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** One picker as a pill: its current value, and a menu of the rest (searchable and grouped when it's long). */
export function ControlPicker({ control, onPick, disabled, label, onReload }: { control: ChatControl; onPick(value: string): void; disabled?: boolean; label?: string; /** Asks the agent for its choices again (the model list). */ onReload?: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const current = control.options.find((o) => o.value === control.currentValue);
  const groups = useMemo(() => {
    const by = new Map<string, { value: string; label: string; description?: string }[]>();
    for (const o of control.options) {
      const s = split(o.name);
      by.set(s.group, [...(by.get(s.group) ?? []), { value: o.value, label: s.label, description: o.description }]);
    }
    // The group in use comes first.
    const mine = current ? split(current.name).group : "";
    return [...by.entries()].sort((a, b) => Number(b[0] === mine) - Number(a[0] === mine));
  }, [control.options, current]);
  const long = control.options.length > 8;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={`${control.name}: ${current ? short(current.name) : control.currentValue}`} data-agent-control={control.id} className={PILL}>
          <span className="truncate">{label ?? (current ? short(current.name) : control.currentValue || control.name)}</span>
          <ChevronDown className="achat-pill-chev" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={10} className={cn("overflow-hidden rounded-[14px] p-0", long ? "w-[min(21rem,calc(100vw-1.5rem))]" : "w-52")} data-agent-control-list={control.id}>
        <Command filter={(v, s) => (v.toLowerCase().includes(s.toLowerCase()) ? 1 : 0)}>
          {(long || onReload) && <PickerSearch placeholder={`Search ${control.name.toLowerCase()}…`} onReload={onReload} />}
          <CommandList className="max-h-80">
            <CommandEmpty>Nothing by that name.</CommandEmpty>
            {groups.map(([group, rows], gi) => (
              <CommandGroup key={group || gi} heading={group || (gi === 0 ? control.name : undefined)}>
                {rows.map((o) => {
                  const on = o.value === control.currentValue;
                  return (
                    <CommandItem
                      key={o.value}
                      value={`${group} ${o.label} ${o.value}`}
                      onSelect={() => {
                        setOpen(false);
                        if (!on) onPick(o.value);
                      }}
                    >
                      <span className={cn("min-w-0 flex-1 truncate", on && "font-semibold text-highlight")}>{o.label}</span>
                      {on && <Check className="size-3.5 text-highlight" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const PERMISSIONS: { value: Permission; name: string; says: string; Icon: typeof Shield }[] = [
  { value: "ask", name: "Ask for everything", says: "Every change waits for your yes.", Icon: ShieldQuestion },
  { value: "dangerous", name: "Only dangerous", says: "Asks before deletes, commands and sensitive files.", Icon: Shield },
  { value: "allow", name: "Allow everything", says: "Nothing is asked.", Icon: ShieldOff },
];

/** How much Ask asks before it acts, as a shield in the message box. One pick for every chat; it can change mid-reply. */
export function PermissionPicker({ external }: { /** The name of the external agent the chat is with, which decides for itself what needs a yes. */ external?: string }) {
  const [open, setOpen] = useState(false);
  const value = useSyncExternalStore(permissionStore.subscribe, permissionStore.get);
  const current = PERMISSIONS.find((p) => p.value === value) ?? PERMISSIONS[1];
  const hint = `Permissions: ${current.name.toLowerCase()}`;
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && permissionStore.refresh())}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" aria-label={hint} data-agent-permission-pick={value} className={cn("achat-ring outline-ring focus-visible:outline-2", value === "allow" ? "text-warning" : "text-muted-foreground")}>
              <current.Icon className="size-[17px]" strokeWidth={2} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="top" sideOffset={10} className="w-[min(18.5rem,calc(100vw-1.5rem))] rounded-[16px] p-2" data-agent-permission-list>
        <div role="radiogroup" aria-label="Permissions" className="flex flex-col">
          {PERMISSIONS.map((p) => {
            const on = p.value === value;
            return (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={on}
                data-permission={p.value}
                onClick={() => {
                  setOpen(false);
                  if (!on) permissionStore.set(p.value).catch((e) => toast.error("Couldn't change permissions", { description: (e as Error).message }));
                }}
                className="flex items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors outline-ring hover:bg-accent focus-visible:outline-2"
              >
                <p.Icon className={cn("mt-0.5 size-4 shrink-0", on ? "text-highlight" : "text-muted-foreground")} strokeWidth={2} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[13px] font-medium", on && "font-semibold text-highlight")}>{p.name}</span>
                  <span className="block text-[12px] leading-snug text-muted-foreground">{p.says}</span>
                </span>
                {on && <Check className="mt-0.5 size-3.5 shrink-0 text-highlight" />}
              </button>
            );
          })}
        </div>
        {external && <p className="px-2.5 pt-1.5 pb-1 text-[11.5px] leading-snug text-muted-foreground">{external} decides what needs a yes (file edits, risky commands). This sets which of those reach you.</p>}
      </PopoverContent>
    </Popover>
  );
}

export interface SessionFacts {
  title: string;
  started: string | null;
  /** Time the replies took, added up. */
  workedMs: number;
  turns: number;
  tools: number;
  /** The model the last reply came from, as the provider named it. */
  served: string;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function span(ms: number): string {
  const m = Math.round(ms / 60000);
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function since(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days < 1 && d.getDate() === new Date().getDate() ? `${clock(iso)} · ${span(Date.now() - d.getTime())} ago` : d.toLocaleDateString([], { month: "short", day: "numeric" }) + `, ${clock(iso)}`;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[13px]">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums">{children}</span>
    </div>
  );
}

/** How full the context window is, as a ring; a click opens the chat's details. */
export function ContextRing({ usage, facts, extra, onPick, onRename, onDelete, onSettings, busy }: {
  usage: ContextUse | null;
  facts: SessionFacts;
  /** Pickers that have no pill of their own (the speed). */
  extra: ChatControl[];
  onPick(id: string, value: string): void;
  onRename?(title: string): void;
  onDelete?(): void;
  onSettings(): void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const frac = usage?.size ? Math.min(1, usage.used / usage.size) : null;
  const pct = frac == null ? null : Math.round(frac * 100);
  // Green while there's room, amber when it's filling, red near the end.
  const tone = frac == null ? "var(--muted-foreground)" : frac >= 0.9 ? "var(--danger, #d44c47)" : frac >= 0.7 ? "var(--nc-orange)" : "var(--highlight)";
  const R = 8;
  const C = 2 * Math.PI * R;
  const hint = usage ? (pct != null ? `${pct}% of the context window` : `${tokens(usage.used)} tokens in context`) : "This chat";
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), setNaming(null))}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" aria-label={hint} data-agent-ring className="achat-ring outline-ring focus-visible:outline-2">
              <svg viewBox="0 0 22 22" className="size-[22px] -rotate-90">
                <circle cx="11" cy="11" r={R} fill="none" strokeWidth="2.6" className="stroke-[color-mix(in_oklab,var(--muted-foreground)_28%,transparent)]" />
                {frac != null && <circle cx="11" cy="11" r={R} fill="none" strokeWidth="2.6" strokeLinecap="round" stroke={tone} strokeDasharray={`${Math.max(0.02, frac) * C} ${C}`} />}
              </svg>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="top" sideOffset={10} className="w-[min(19rem,calc(100vw-1.5rem))] rounded-[16px] p-3.5" data-agent-session>
        <h4 className="achat-h">Context</h4>
        {usage ? (
          <>
            <Row k={usage.size ? `${tokens(usage.used)} of ${tokens(usage.size)} tokens` : "In the window"}>{pct != null ? `${pct}%` : `${tokens(usage.used)} tokens`}</Row>
            {frac != null && (
              <div className="mt-1.5 mb-1 h-2 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--muted-foreground)_22%,transparent)]">
                <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, frac * 100)}%`, background: tone }} />
              </div>
            )}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Shows after the first reply.</p>
        )}

        <h4 className="achat-h mt-4">Session</h4>
        {facts.started ? (
          <>
            <Row k="Started">{since(facts.started)}</Row>
            <Row k="Working time">{facts.workedMs ? span(facts.workedMs) : "–"}</Row>
            <Row k="Replies · tool calls">{facts.turns} · {facts.tools}</Row>
            {facts.served && <Row k="Answered by">{facts.served}</Row>}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Nothing sent yet.</p>
        )}

        {extra.map((c) => (
          <div key={c.id} className="mt-4">
            <h4 className="achat-h">{c.name}</h4>
            <div className="achat-seg" role="radiogroup" aria-label={c.name}>
              {c.options.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={o.value === c.currentValue} disabled={busy} onClick={() => o.value !== c.currentValue && onPick(c.id, o.value)} className={cn(o.value === c.currentValue && "is-on")}>
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="mt-3.5 -mx-1.5 flex flex-col">
          {naming != null ? (
            <input
              autoFocus
              value={naming}
              aria-label="Chat name"
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (onRename?.(naming), setNaming(null));
                if (e.key === "Escape") (e.stopPropagation(), setNaming(null));
              }}
              onBlur={() => (onRename?.(naming), setNaming(null))}
              className="mx-1.5 mb-1 h-8 rounded-[10px] bg-[color-mix(in_oklab,var(--muted-foreground)_14%,transparent)] px-2.5 text-[13px] outline-none"
            />
          ) : (
            <button type="button" disabled={!onRename || busy} onClick={() => setNaming(facts.title)} className="achat-act">
              <Pencil /> Rename chat
            </button>
          )}
          <button type="button" disabled={!onDelete || busy} onClick={() => (setOpen(false), onDelete?.())} className="achat-act">
            <Trash2 /> Delete chat
          </button>
          <button type="button" onClick={() => (setOpen(false), onSettings())} className="achat-act">
            <Settings2 /> AI settings
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** What the model thought before a step: one quiet word until asked for, then its text under it. */
export function ThoughtRow({ text, ms, live }: { text: string; ms: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round(ms / 1000));
  return (
    <div data-agent-thought className="achat-thought-row">
      <button type="button" aria-expanded={open} title={live ? undefined : `Thought for ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}`} onClick={() => setOpen((o) => !o)} className={cn("achat-thought-toggle outline-ring focus-visible:outline-2", live && "animate-pulse")}>
        {live ? "Thinking" : "Thought"}
        <ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
      </button>
      {open && <div className="achat-thought">{text.trim()}</div>}
    </div>
  );
}
