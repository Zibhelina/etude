// The way into the Archive under the deck list: the full width of the list, a dotted outline, and how many
// decks wait there.
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
  return (
    <button
      type="button"
      onClick={() => navigate("/archive")}
      data-archive-link
      className={cn(
        "group flex min-h-12 w-full items-center gap-2.5 rounded-xl border-2 border-dotted border-muted-foreground/35 px-4 text-left text-[14px] text-muted-foreground transition-colors outline-ring hover:border-muted-foreground/60 hover:bg-muted/50 hover:text-foreground focus-visible:outline-2",
        className,
      )}
    >
      <Archive className="size-4 shrink-0" />
      <span className="flex-1 font-medium">Archive</span>
      {count != null && <span className="tabular text-[13px] text-muted-foreground/80">{count === 0 ? "empty" : `${count} deck${count === 1 ? "" : "s"}`}</span>}
      <ChevronRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
