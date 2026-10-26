// Updates. When this install is behind GitHub, a button sits at the bottom of the sidebar (a dot on Settings in the
// phone tab bar); when it's current nothing shows. Settings → About has the status and "Check for updates".
// The CLI is `etude update [--check]`.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDownToLine, Check, CircleArrowUp, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, relative, type UpdateStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

type Phase = "idle" | "checking" | "updating" | "restarting";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const versionOf = (st: UpdateStatus) => (st.kind === "git" ? `${st.version} (${st.commit})` : st.version);
const behindOf = (st: UpdateStatus) => (st.kind === "git" ? st.behind : st.latest ? 1 : 0);

// One status for the whole app, so the sidebar, the tab bar and Settings agree and GitHub is asked once.
let state: { st: UpdateStatus | null; phase: Phase } = { st: null, phase: "idle" };
const listeners = new Set<() => void>();
const set = (patch: Partial<typeof state>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
let started = false;

async function check(force = false) {
  set({ phase: "checking" });
  try {
    set({ st: await api.updateStatus(true, force) });
  } catch (e) {
    if (force) toast.error("Couldn't check for updates", { description: (e as Error).message });
  } finally {
    if (state.phase === "checking") set({ phase: "idle" });
  }
}

async function update(onDone?: () => void) {
  set({ phase: "updating" });
  try {
    const r = await api.applyUpdate();
    if (r.result === "current") {
      toast.success("Already up to date");
      onDone?.();
      set({ phase: "idle" });
      await check();
      return;
    }
    if (!r.restarting) {
      toast.success(`Updated to ${r.to}`, { description: "Restart Etude to run the new version." });
      onDone?.();
      set({ phase: "idle" });
      await check();
      return;
    }
    set({ phase: "restarting" });
    // Wait for the server to come back on the new commit, then load the new app.
    for (let i = 0; i < 120; i++) {
      await sleep(i < 10 ? 300 : 1000);
      try {
        const now = await api.updateStatus();
        if (now.kind === "git" && now.commit === r.to) {
          location.reload();
          return;
        }
      } catch {}
    }
    toast.error("Etude hasn't come back yet", { description: "The update finished; reload the page in a moment." });
    set({ phase: "idle" });
  } catch (e) {
    toast.error("Update failed", { description: (e as Error).message.slice(0, 400) });
    set({ phase: "idle" });
    check();
  }
}

export function useUpdater() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    // The server throttles automatic checks, so this doesn't hammer GitHub.
    if (!started) {
      started = true;
      check();
    }
  }, []);
  const busy = s.phase === "updating" || s.phase === "restarting";
  return { ...s, busy, behind: s.st ? behindOf(s.st) : 0, check, update };
}

function UpdateDetails({ st, onUpdate }: { st: UpdateStatus; onUpdate(): void }) {
  const version = versionOf(st);
  if (st.kind !== "git")
    return (
      <div className="px-4 py-3 text-sm">
        <div className="font-medium">Etude {st.latest} is out</div>
        <div className="mt-1 text-xs text-muted-foreground">This copy wasn't installed from git, so it can't update itself. Download the new version from GitHub.</div>
        <Button size="sm" className="mt-3" asChild>
          <a href={st.url} target="_blank" rel="noreferrer">
            Open releases
          </a>
        </Button>
      </div>
    );
  return (
    <>
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">
          {st.behind} new commit{st.behind === 1 ? "" : "s"} on {st.upstream}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          You're on {version}. Pulls {st.behind === 1 ? "it" : "them"}, rebuilds the app and restarts it. Your decks aren't touched.
        </div>
      </div>
      <ul className="max-h-56 overflow-y-auto px-4 py-2 text-xs">
        {st.incoming.map((c) => (
          <li key={c.sha} className="flex gap-2 py-1">
            <span className="shrink-0 font-mono text-muted-foreground">{c.sha}</span>
            <span className="min-w-0 flex-1">{c.subject}</span>
          </li>
        ))}
        {st.behind > st.incoming.length && <li className="py-1 text-muted-foreground">and {st.behind - st.incoming.length} more</li>}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
        <span className="text-xs text-muted-foreground">{st.blocked ?? (st.canRestart ? "Takes about a minute." : "Restart Etude afterwards.")}</span>
        <Button size="sm" className="shrink-0" disabled={!!st.blocked} onClick={onUpdate}>
          Update
        </Button>
      </div>
    </>
  );
}

/** Accent-tinted surface for the sidebar button: theme tokens only, no gradient. */
const TINT = "border border-sidebar-border bg-sidebar-accent/60 text-foreground";

/** Bottom of the sidebar, only while this install is behind. Collapsed: an icon with an accent dot. */
export function SidebarUpdate({ collapsed }: { collapsed: boolean }) {
  const { st, busy, behind, phase } = useUpdater();
  const [open, setOpen] = useState(false);
  if (!st || (!behind && !busy)) return null;
  const count = st.kind === "git" ? String(st.behind) : null;
  const label = busy ? (phase === "updating" ? "Updating…" : "Restarting…") : st.kind === "git" ? "Update Etude" : `Etude ${st.latest} is out`;
  const aria = busy ? label : st.kind === "git" ? `Update available: ${st.behind} new commit${st.behind === 1 ? "" : "s"}` : label;
  const button = (
    <button
      type="button"
      data-update-button
      aria-label={aria}
      disabled={busy}
      className={cn(
        "relative flex h-9 w-full shrink-0 items-center rounded-lg text-[13px] font-medium transition-colors outline-ring hover:bg-sidebar-accent focus-visible:outline-2 disabled:opacity-90",
        TINT,
        collapsed ? "justify-center px-0" : "gap-2.5 px-2",
      )}
    >
      {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-highlight" /> : <CircleArrowUp className="size-4 shrink-0 text-highlight" />}
      {collapsed ? (
        !busy && <span className="absolute top-1 right-1 size-2 rounded-full bg-highlight ring-2 ring-sidebar" aria-hidden />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {/* The count lives in the tooltip/popover: "3 new" read as new cards next to the New column. */}
        </>
      )}
    </button>
  );
  if (busy)
    return collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    ) : (
      button
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{button}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">
            {label}
            {count && <span className="opacity-60"> · {count} new</span>}
          </TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{button}</PopoverTrigger>
      )}
      <PopoverContent side="right" align="end" sideOffset={10} className="w-[22rem] max-w-[calc(100vw-2rem)] p-0 shadow-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
        <UpdateDetails st={st} onUpdate={() => update(() => setOpen(false))} />
      </PopoverContent>
    </Popover>
  );
}

/** True while there's an update to install or one is running; the phone tab bar puts a dot on Settings. */
export function useUpdateDot() {
  const { behind, busy } = useUpdater();
  return behind > 0 || busy;
}

/** Settings → About: whether Etude is current, and "Check for updates" / "Review update". */
export function UpdateSettingsRow() {
  const { st, phase, busy, behind } = useUpdater();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-update-settings>
      <span className="flex min-w-0 items-center gap-1.5">
        {!st ? (
          <span className="text-muted-foreground">Checking…</span>
        ) : busy ? (
          <>
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            {phase === "updating" ? "Updating…" : "Restarting…"}
          </>
        ) : behind ? (
          <>
            <span className="size-1.5 rounded-full bg-highlight" aria-hidden />
            {st.kind === "git" ? (st.behind === 1 ? "1 update available" : `${st.behind} updates available`) : `Etude ${st.latest} is out`}
          </>
        ) : st.checkError ? (
          <span className="text-muted-foreground">Couldn't check: {st.checkError}</span>
        ) : (
          <>
            <Check className="size-3.5 text-muted-foreground" />
            Up to date
            {st.checked && <span className="text-muted-foreground">· checked {relative(st.checked)}</span>}
          </>
        )}
      </span>
      <div className="flex-1" />
      {st && behind > 0 && !busy ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline">
              <ArrowDownToLine />
              {st.kind === "git" && st.behind > 1 ? "Review updates" : "Review update"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0 shadow-lg">
            <UpdateDetails st={st} onUpdate={() => update(() => setOpen(false))} />
          </PopoverContent>
        </Popover>
      ) : (
        <Button size="sm" variant="outline" disabled={phase !== "idle"} onClick={() => check(true)}>
          {phase === "checking" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Check for updates
        </Button>
      )}
    </div>
  );
}
