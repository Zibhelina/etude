// A small control in the bottom-right corner of Decks: a check mark when Etude is current, a one-click update from GitHub when it isn't.
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, relative, type UpdateStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

type Phase = "idle" | "checking" | "updating" | "restarting";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UpdateBar() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [open, setOpen] = useState(false);
  const alive = useRef(true);

  const check = async (force = false) => {
    setPhase("checking");
    try {
      setSt(await api.updateStatus(true, force));
    } catch (e) {
      if (force) toast.error("Couldn't check for updates", { description: (e as Error).message });
    } finally {
      if (alive.current) setPhase("idle");
    }
  };

  useEffect(() => {
    alive.current = true;
    // The server throttles automatic checks, so opening Decks often doesn't hammer GitHub.
    check();
    return () => {
      alive.current = false;
    };
  }, []);

  const update = async () => {
    setPhase("updating");
    try {
      const r = await api.applyUpdate();
      if (r.result === "current") {
        toast.success("Already up to date");
        setOpen(false);
        await check();
        return;
      }
      if (!r.restarting) {
        toast.success(`Updated to ${r.to}`, { description: "Restart Etude to run the new version." });
        setOpen(false);
        await check();
        return;
      }
      setPhase("restarting");
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
      setPhase("idle");
    } catch (e) {
      const err = e as Error;
      toast.error("Update failed", { description: err.message.slice(0, 400) });
      setPhase("idle");
      check();
    }
  };

  if (!st) return null;
  const busy = phase === "updating" || phase === "restarting";
  const behind = st.kind === "git" ? st.behind : st.latest ? 1 : 0;
  const version = st.kind === "git" ? `${st.version} (${st.commit})` : st.version;

  return (
    <footer className={cn("fixed right-3 bottom-[calc(var(--tabbar-h)+0.5rem)] z-10 h-8 items-center gap-x-1.5 rounded-full border bg-card px-1 text-xs text-muted-foreground shadow-sm md:right-4 md:bottom-4 md:flex", behind || busy ? "flex" : "hidden")}>
      {busy ? (
        <span className="flex items-center gap-1.5 px-2 text-foreground">
          <Loader2 className="size-3 animate-spin" />
          {phase === "updating" ? "Updating…" : "Restarting…"}
        </span>
      ) : behind ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button title={`Etude ${version}`} className="flex h-6 items-center gap-1 rounded-full px-2 font-medium text-highlight transition-colors hover:text-foreground">
              <ArrowDownToLine className="size-3" />
              {st.kind === "git" ? `${st.behind} update${st.behind === 1 ? "" : "s"}` : `${st.latest} is out`}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" sideOffset={8} className="w-[22rem] max-w-[calc(100vw-2rem)] p-0 shadow-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
            {st.kind === "git" ? (
              <>
                <div className="border-b px-4 py-3">
                  <div className="text-sm font-medium">
                    {st.behind} new commit{st.behind === 1 ? "" : "s"} on {st.upstream}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">You're on {version}. Pulls {st.behind === 1 ? "it" : "them"}, rebuilds the app and restarts it. Your decks aren't touched.</div>
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
                  {st.blocked ? (
                    <span className="text-xs text-muted-foreground">{st.blocked}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{st.canRestart ? "Takes about a minute." : "Restart Etude afterwards."}</span>
                  )}
                  <Button size="sm" className="shrink-0" disabled={!!st.blocked} onClick={update}>
                    Update
                  </Button>
                </div>
              </>
            ) : (
              <div className="px-4 py-3 text-sm">
                <div className="font-medium">Etude {st.latest} is out</div>
                <div className="mt-1 text-xs text-muted-foreground">This copy wasn't installed from git, so it can't update itself. Download the new version from GitHub.</div>
                <Button size="sm" className="mt-3" asChild>
                  <a href={st.url} target="_blank" rel="noreferrer">Open releases</a>
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <button
          onClick={() => check(true)}
          disabled={phase === "checking"}
          aria-label="Check for updates"
          title={`Etude ${version}${st.checkError ? ` · couldn't check: ${st.checkError}` : ` · up to date${st.checked ? `, checked ${relative(st.checked)}` : ""}`} · click to check again`}
          className="flex size-6 items-center justify-center rounded-full transition-colors hover:text-foreground"
        >
          {phase === "checking" ? <Loader2 className="size-3 animate-spin" /> : st.checkError ? <RefreshCw className="size-3" /> : <Check className="size-3" />}
        </button>
      )}
    </footer>
  );
}
