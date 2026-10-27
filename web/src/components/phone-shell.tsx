// The phone shell ("Score", see docs/mobile-design.md): a four-tab bar with the ε in the middle,
// the big serif page title that folds into a slim bar on scroll, and the bottom action sheet.
// Nothing here renders at md (768 px) and up.
import { useEffect, useRef, useState } from "react";
import { BarChart3, Layers, Library, MoreHorizontal } from "lucide-react";
import { Logo } from "@/components/logo";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/", label: "Decks", icon: Layers, match: (p: string) => p === "/" || p === "/deck" },
  { to: "/browse", label: "Browse", icon: Library, match: (p: string) => p === "/browse" },
  null, // the ε
  { to: "/stats", label: "Stats", icon: BarChart3, match: (p: string) => p === "/stats" },
  { to: "/more", label: "More", icon: MoreHorizontal, match: (p: string) => p === "/more" || p.startsWith("/types") || p === "/market" || p === "/settings" },
];

export function PhoneTabBar({ path, updateDot, onAsk }: { path: string; updateDot: boolean; onAsk(): void }) {
  return (
    <nav aria-label="Main" className="score-tabbar fixed inset-x-0 bottom-0 z-20 md:hidden">
      <div className="mx-auto grid h-16 max-w-md grid-cols-5 items-stretch px-2">
        {TABS.map((t, i) =>
          t ? (
            <button
              key={t.to}
              onClick={() => navigate(t.to)}
              aria-current={t.match(path) ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center justify-center gap-[3px] text-[11px] tracking-wide text-muted-foreground transition-colors active:scale-95",
                t.match(path) && "text-foreground",
              )}
            >
              <span className="relative">
                <t.icon className={cn("size-[21px]", t.match(path) && "text-highlight")} strokeWidth={t.match(path) ? 2.1 : 1.7} />
                {t.to === "/more" && updateDot && <span data-update-dot aria-label="Update available" className="absolute -top-0.5 -right-1 size-2 rounded-full bg-highlight ring-2 ring-background" />}
              </span>
              <span className={cn(t.match(path) && "font-medium")}>{t.label}</span>
            </button>
          ) : (
            <button key={i} onClick={onAsk} aria-label="Ask Etude" data-agent-launcher className="group relative flex flex-col items-center justify-center gap-[3px] text-[11px] tracking-wide text-muted-foreground">
              {/* Same slot as the other icons, so the labels share a baseline; the disc rises out of the bar. */}
              <span className="relative size-[21px]">
                <span className="score-ask absolute top-1/2 left-1/2 flex size-[3.25rem] -translate-x-1/2 -translate-y-[84%] items-center justify-center rounded-full border bg-card transition-transform group-active:scale-95">
                  <Logo className="size-7" />
                </span>
              </span>
              <span>Ask</span>
            </button>
          ),
        )}
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
