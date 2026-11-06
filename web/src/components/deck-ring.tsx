// The badge for a deck without an icon: three rings, one per kind of work today (new, learning, due), each filled by
// its share. Done for today is a full green ring with a check; an empty deck is a dashed ring.
import type { DeckNode } from "@/lib/api";
import { cn } from "@/lib/utils";

const RINGS = [
  { key: "new", color: "var(--new)", r: 20 },
  { key: "learning", color: "var(--learn)", r: 14.5 },
  { key: "review", color: "var(--review)", r: 9 },
] as const;

export function DeckRing({ d, size = 46, className }: { d: Pick<DeckNode, "new" | "learning" | "review" | "cards" | "mode">; size?: number; className?: string }) {
  const total = d.new + d.learning + d.review;
  const label = d.mode === "watch" ? "Tour" : !d.cards ? "Empty" : total ? `${d.new} new, ${d.learning} learning, ${d.review} due` : "Done for today";
  let body: React.ReactNode;
  if (!d.cards || d.mode === "watch") {
    body = <circle cx="23" cy="23" r="20" fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.55} strokeWidth="2" strokeDasharray={d.mode === "watch" && d.cards ? undefined : "3 4"} />;
  } else if (!total) {
    body = (
      <>
        <circle cx="23" cy="23" r="20" fill="var(--review)" fillOpacity={0.14} stroke="var(--review)" strokeWidth="4" />
        <path d="M16 23.5l4.6 4.3 9.2-9.2" fill="none" stroke="var(--review)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else {
    body = RINGS.map(({ key, color, r }) => {
      const v = d[key];
      const circ = 2 * Math.PI * r;
      return (
        <g key={key}>
          <circle cx="23" cy="23" r={r} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth="4" />
          {v > 0 && <circle cx="23" cy="23" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${Math.max(v / total, 0.07) * circ} ${circ}`} transform="rotate(-90 23 23)" />}
        </g>
      );
    });
  }
  return (
    <svg viewBox="0 0 46 46" width={size} height={size} role="img" aria-label={label} className={cn("shrink-0", className)}>
      {body}
    </svg>
  );
}
