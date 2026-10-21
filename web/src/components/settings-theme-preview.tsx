// Theme previews: a miniature of the app drawn in any theme's variables (for the gallery),
// and a sample card with controls for the editor.
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CardFrame, type CardResult } from "@/components/card-frame";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Inline styles that make every theme token resolve to this theme's values inside the element. */
export function themeStyle(t: Theme): React.CSSProperties {
  return { ...(t.vars as React.CSSProperties), colorScheme: t.scheme };
}

/** The app in miniature: sidebar, a card, rating colors. Drawn with the theme's own variables. */
export function ThemeMiniature({ theme, className }: { theme: Theme; className?: string }) {
  return (
    <div style={themeStyle(theme)} className={cn("flex aspect-[16/10] overflow-hidden rounded-[calc(var(--radius)-2px)] border bg-background font-sans text-foreground", className)} aria-hidden="true">
      <div className="flex w-[22%] flex-col gap-1.5 border-r border-sidebar-border bg-sidebar p-2">
        <div className="mb-1 h-1.5 w-3/5 rounded-full bg-highlight" />
        <div className="h-1.5 w-full rounded-full bg-sidebar-accent" />
        <div className="h-1.5 w-4/5 rounded-full bg-muted-foreground/35" />
        <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/35" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 p-2.5">
        <div className="rounded-[calc(var(--radius)-4px)] border bg-card px-2.5 py-2">
          <div className="text-[15px] leading-none font-semibold text-card-foreground">Aa</div>
          <div className="mt-1.5 h-1 w-4/5 rounded-full bg-muted-foreground/45" />
          <div className="mt-1 h-1 w-3/5 rounded-full bg-muted-foreground/30" />
        </div>
        <div className="grid grid-cols-4 gap-1">
          {(["again", "hard", "good", "easy"] as const).map((r) => (
            <div key={r} className="h-2 rounded-full" style={{ background: `var(--${r})` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The theme's accent and status colors, each ringed so it reads on any surface. */
export function ThemeSwatches({ theme, className }: { theme: Theme; className?: string }) {
  const keys = ["--highlight", "--again", "--hard", "--good", "--easy"];
  return (
    <div className={cn("flex gap-1", className)} aria-hidden="true">
      {keys.map((k) => (
        <span key={k} className="size-2.5 rounded-full ring-1 ring-foreground/15" style={{ background: theme.vars[k] }} />
      ))}
    </div>
  );
}

const SAMPLE_VIEW = {
  prompt: "Which planet is closest to the Sun?",
  multiple: false,
  options: [
    { id: "o0", text: "Venus" },
    { id: "o1", text: "Mercury" },
    { id: "o2", text: "Mars" },
  ],
};
const SAMPLE_RESULT: CardResult = {
  grade: { score: 0, verdict: "incorrect", suggested: 1, grader: { kind: "script" } },
  key: { correct: ["o1"], why: { o1: "About 58 million km out, on average." }, explanation: "Venus is closer to *Earth*, not to the Sun." },
  answer: ["o0"],
};

const RATINGS = [
  { label: "Again", cls: "text-again border-again/30 hover:bg-again/10" },
  { label: "Hard", cls: "text-hard border-hard/30 hover:bg-hard/10" },
  { label: "Good", cls: "text-good border-good/30 hover:bg-good/10" },
  { label: "Easy", cls: "text-easy border-easy/30 hover:bg-easy/10" },
];

/** What the editor shows beside the variables: a real card in a frame and the common controls. */
export function ThemeSample() {
  const view = useMemo(() => SAMPLE_VIEW, []);
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-card px-4 py-4 text-card-foreground sm:px-5">
        <CardFrame frameKey="theme-sample" src="/frame/mcq" view={view} mode="result" answer={SAMPLE_RESULT.answer} result={SAMPLE_RESULT} minHeight={180} autoFocus={false} />
        <div className="mt-4 grid grid-cols-4 gap-1.5">
          {RATINGS.map((r) => (
            <button key={r.label} type="button" tabIndex={-1} className={cn("h-10 rounded-md border text-sm font-medium transition-colors", r.cls)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" tabIndex={-1}>Primary</Button>
        <Button size="sm" variant="outline" tabIndex={-1}>Outline</Button>
        <Button size="sm" variant="ghost" tabIndex={-1}>Ghost</Button>
        <Button size="sm" variant="destructive" tabIndex={-1}>Delete</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="border-new/40 text-new">12 new</Badge>
        <Badge variant="outline" className="border-learn/40 text-learn">3 learning</Badge>
        <Badge variant="outline" className="border-review/40 text-review">41 due</Badge>
        <span className="text-highlight">accent</span>
        <span className="text-success">success</span>
        <span className="text-warning">warning</span>
        <span className="text-danger">danger</span>
      </div>
      <Input tabIndex={-1} placeholder="An input" className="h-10 md:h-9" />
      <div className="flex gap-1.5" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-8 flex-1 rounded" style={{ background: `var(--chart-${i})` }} />
        ))}
      </div>
    </div>
  );
}
