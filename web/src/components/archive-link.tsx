// The way into the Archive, at the bottom of the Library: a hairline across the list, then one plain row, so it reads
// as the end of the Library and not another deck.
import { useEffect, useState } from "react";
import { Archive, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

/** How many decks are in the Archive, for the link under the list. */
export function useArchiveCount() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    const load = () => api.archive().then((a) => setN(a.length)).catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  return n;
}

export function ArchiveLink({ count, className }: { count: number | null; className?: string }) {
  const n = count == null ? "" : count === 0 ? "empty" : `${count} deck${count === 1 ? "" : "s"}`;
  return (
    <div className={cn("border-t border-border/70 pt-2", className)}>
      <button type="button" onClick={() => navigate("/archive")} data-archive-link className="group -mx-2.5 flex h-11 w-[calc(100%+1.25rem)] items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-muted-foreground transition-colors outline-ring hover:bg-accent/60 hover:text-foreground focus-visible:outline-2">
        <Archive className="size-4 shrink-0" />
        <span className="flex-1">Archive</span>
        {n && <span className="tabular text-[13px] text-muted-foreground/70">{n}</span>}
        <ChevronRight className="size-4 shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}
