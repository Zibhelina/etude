// The phone shell ("Score", see docs/mobile-design.md): a floating tab capsule with the ε beside it,
// the big serif page title that folds into a slim bar on scroll, and the bottom action sheet.
// Nothing here renders at md (768 px) and up.
import { useEffect, useRef, useState } from "react";
import { BarChart3, Layers, Library, MoreHorizontal } from "lucide-react";
import { Logo } from "@/components/logo";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/", label: "Decks", icon: Layers, match: (p: string) => p === "/" || p === "/deck" || p === "/archive" },
  { to: "/browse", label: "Browse", icon: Library, match: (p: string) => p === "/browse" },
  { to: "/stats", label: "Stats", icon: BarChart3, match: (p: string) => p === "/stats" },
  { to: "/more", label: "More", icon: MoreHorizontal, match: (p: string) => p === "/more" || p.startsWith("/types") || p === "/market" || p === "/settings" },
];

/**
 * "Ilha": a floating capsule with the four tabs as icons, where only the active one opens up and shows
 * its name, and the ε in its own disc beside it. The list scrolls under both, behind a short fade.
 */
export function PhoneTabBar({ path, updateDot, onAsk }: { path: string; updateDot: boolean; onAsk(): void }) {
  return (
    <nav aria-label="Main" className="score-island pointer-events-none fixed inset-x-0 bottom-0 z-20 md:hidden">
      <div className="pointer-events-auto mx-auto flex max-w-md items-center gap-2 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] min-[360px]:gap-2.5 min-[360px]:px-3.5">
        <div className="score-capsule flex h-[3.375rem] min-w-0 flex-1 items-center justify-between rounded-full border px-[5px]">
          {TABS.map((t) => {
            const on = t.match(path);
            return (
              <button
                key={t.to}
                onClick={() => navigate(t.to)}
                aria-current={on ? "page" : undefined}
                aria-label={t.label}
                className={cn(
                  // The pill grows out of the icon: padding, the label's width and the fill all ease together,
                  // so the old tab folds while the new one opens. An inactive tab's box is exactly its icon, so
                  // space-between keeps the visible gaps equal; the ::before keeps a 45 px touch target.
                  "relative flex h-11 shrink-0 items-center justify-center rounded-full text-[13px] text-muted-foreground transition-[background-color,color,padding,margin] duration-300 ease-[cubic-bezier(0.22,0.9,0.3,1)] before:absolute before:-inset-x-3 before:inset-y-0 before:content-[''] active:scale-95 motion-reduce:transition-none",
                  on ? "bg-accent px-3.5 font-medium text-foreground" : "bg-transparent px-0 first:ml-3.5 last:mr-3.5",
                )}
              >
                <span className="relative">
                  <t.icon className={cn("size-[21px] transition-colors duration-300", on && "text-highlight")} strokeWidth={on ? 2.1 : 1.7} />
                  {t.to === "/more" && updateDot && <span data-update-dot aria-label="Update available" className="absolute -top-0.5 -right-1 size-2 rounded-full bg-highlight ring-2 ring-card" />}
                </span>
                <span aria-hidden={!on} className={cn("grid transition-[grid-template-columns,opacity,margin] duration-300 ease-[cubic-bezier(0.22,0.9,0.3,1)] motion-reduce:transition-none", on ? "ml-1.5 grid-cols-[1fr] opacity-100" : "ml-0 grid-cols-[0fr] opacity-0")}>
                  <span className="overflow-hidden whitespace-nowrap">{t.label}</span>
                </span>
              </button>
            );
          })}
        </div>
        <button onClick={onAsk} aria-label="Ask Etude" data-agent-launcher className="score-capsule flex size-[3.375rem] shrink-0 items-center justify-center rounded-full border transition-transform active:scale-95">
          <Logo className="size-[26px]" />
        </button>
      </div>
    </nav>
  );
}

/**
 * The phone page title: large serif, left-aligned, with an optional line under it. Once it scrolls under
 * the top edge a slim bar fades in with the same title, so you always know where you are.
 * `back` puts a chevron in that bar and above the title.
 */
export function PhoneTitle({ title, kicker, sub, back, actions, className }: {
  title: React.ReactNode;
  kicker?: React.ReactNode;
  sub?: React.ReactNode;
  back?: { label: string; onClick(): void };
  actions?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setFolded(!e.isIntersecting), { rootMargin: "-56px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <div aria-hidden={!folded} className={cn("score-fold fixed inset-x-0 top-0 z-20 flex h-[calc(3rem+env(safe-area-inset-top))] items-end transition-opacity duration-200 md:hidden", folded ? "opacity-100" : "pointer-events-none opacity-0")}>
        <div className="flex h-12 w-full items-center gap-1 px-2">
          {back ? (
            <button onClick={back.onClick} className="flex h-10 min-w-10 items-center justify-center rounded-full text-muted-foreground" aria-label={`Back to ${back.label}`}><ChevronLeftIcon /></button>
          ) : <span className="w-3" />}
          <div className="score-serif min-w-0 flex-1 truncate text-[1.15rem]">{title}</div>
          {actions && <div className="flex shrink-0 items-center">{actions}</div>}
        </div>
      </div>
      <header className={cn("px-5 pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5", className)}>
        <div className="flex h-10 items-center justify-between gap-2">
          {back ? (
            <button onClick={back.onClick} className="-ml-2 flex h-10 min-w-0 items-center gap-0.5 rounded-full pr-2 text-sm text-muted-foreground active:text-foreground">
              <ChevronLeftIcon />
              <span className="truncate">{back.label}</span>
            </button>
          ) : kicker ? (
            <span className="score-kicker">{kicker}</span>
          ) : <span />}
          {actions && <div className="-mr-2 flex shrink-0 items-center">{actions}</div>}
        </div>
        <div ref={ref}>
          {back && kicker && <div className="score-kicker mt-2">{kicker}</div>}
          <h1 className="score-serif score-display mt-1 text-[2.25rem] leading-[1.05] break-words">{title}</h1>
          {sub && <div className="mt-2 text-[15px] text-muted-foreground">{sub}</div>}
        </div>
      </header>
    </>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m14.5 6-6 6 6 6" /></svg>
  );
}

/** A round 40 px icon button for phone headers. */
export function PhoneIconButton({ label, onClick, children, className }: { label: string; onClick(): void; children: React.ReactNode; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} className={cn("flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-accent active:text-foreground [&_svg]:size-5", className)}>
      {children}
    </button>
  );
}

export type SheetAction = { label: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; onClick(): void; tone?: "danger"; hint?: React.ReactNode; disabled?: boolean };

/**
 * The bottom action sheet: a title, a short line, and full-width rows. Tapping the backdrop or swiping it down closes it.
 * Rows are grouped; each group is its own rounded block.
 */
export function ActionSheet({ open, onClose, title, description, groups }: { open: boolean; onClose(): void; title?: React.ReactNode; description?: React.ReactNode; groups: SheetAction[][] }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setDrag(0);
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Actions"}>
      <div className="score-scrim absolute inset-0" onClick={onClose} />
      <div
        className="score-sheet absolute inset-x-0 bottom-0 rounded-t-[1.75rem] border-t bg-card px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        style={{ transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? "none" : undefined }}
        onPointerDown={(e) => { if ((e.target as HTMLElement).closest("[data-grab]")) start.current = e.clientY; }}
        onPointerMove={(e) => { if (start.current != null) setDrag(Math.max(0, e.clientY - start.current)); }}
        onPointerUp={() => { if (drag > 80) onClose(); start.current = null; setDrag(0); }}
        onPointerCancel={() => { start.current = null; setDrag(0); }}
      >
        <div data-grab className="flex touch-none justify-center pt-2.5 pb-3"><span className="h-1 w-9 rounded-full bg-foreground/20" /></div>
        {(title || description) && (
          <div data-grab className="touch-none px-4 pb-4">
            {title && <div className="score-serif truncate text-[1.5rem] leading-tight">{title}</div>}
            {description && <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>}
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {groups.filter((g) => g.length).map((g, gi) => (
            <div key={gi} className="overflow-hidden rounded-2xl border bg-background/70">
              {g.map((a, i) => (
                <button
                  key={i}
                  disabled={a.disabled}
                  onClick={() => { onClose(); a.onClick(); }}
                  className={cn("relative flex min-h-[3.25rem] w-full items-center gap-3.5 px-4 text-left text-[15px] transition-colors active:bg-accent disabled:opacity-40", i > 0 && "before:absolute before:right-0 before:left-[3.15rem] before:top-0 before:h-px before:bg-border", a.tone === "danger" && "text-destructive")}
                >
                  {a.icon && <a.icon className={cn("size-[18px] shrink-0", a.tone === "danger" ? "text-destructive" : "text-muted-foreground")} />}
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  {a.hint && <span className="shrink-0 text-[13px] text-muted-foreground tabular">{a.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Three counts with their meaning in the shape, so they read without colour too:
 * new = an open ring, learning = a half-filled ring, due = a filled dot. Zeros drop out.
 */
export function Tally({ n, l, r, className, size = "sm" }: { n: number; l: number; r: number; className?: string; size?: "sm" | "lg" }) {
  const items = [
    { v: n, cls: "score-ink-new", mark: "new", label: "new" },
    { v: l, cls: "score-ink-learn", mark: "learn", label: "learning" },
    { v: r, cls: "score-ink-review", mark: "due", label: "due" },
  ];
  return (
    <span className={cn("inline-flex items-center tabular", size === "lg" ? "gap-4 text-[15px]" : "gap-2.5 text-[13px]", className)} aria-label={items.map((i) => `${i.v} ${i.label}`).join(", ")}>
      {items.filter((i) => i.v).map((i) => (
        <span key={i.mark} className={cn("inline-flex items-center gap-1", i.cls)}>
          <Mark kind={i.mark as "new" | "learn" | "due"} />
          {i.v}
        </span>
      ))}
    </span>
  );
}

export function Mark({ kind, className }: { kind: "new" | "learn" | "due"; className?: string }) {
  return (
    <svg viewBox="0 0 10 10" className={cn("size-2 shrink-0", className)} aria-hidden>
      {kind === "new" && <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      {kind === "learn" && (<><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M5 1.4 A3.6 3.6 0 0 1 5 8.6 Z" fill="currentColor" /></>)}
      {kind === "due" && <circle cx="5" cy="5" r="4.4" fill="currentColor" />}
    </svg>
  );
}
