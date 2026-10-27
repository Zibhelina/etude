// Layout pieces every page uses, so headers, sections, rows, fields and empty states look the same everywhere.
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The page column: one width, one padding. `wide` is for dashboards (Stats). */
export function Page({ wide, className, children }: { wide?: boolean; className?: string; children: React.ReactNode }) {
  return <div className={cn("mx-auto w-full px-4 pt-6 pb-10 max-md:pt-[calc(1.25rem+env(safe-area-inset-top))] sm:px-8 sm:pt-10 sm:pb-12", wide ? "max-w-5xl" : "max-w-4xl", className)}>{children}</div>;
}

/** Page titles on a phone are set in Computer Modern, large ("Score", docs/mobile-design.md). */
export const PHONE_H1 = "max-md:score-serif max-md:score-display max-md:text-[2.25rem] max-md:leading-[1.08] max-md:font-normal max-md:tracking-normal";

/** Negative margins that let a bar inside <Page> run edge to edge. */
export const PAGE_BLEED = "-mx-4 px-4 sm:-mx-8 sm:px-8";

export type Crumb = { label: string; onClick(): void };

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("-ml-1.5 mb-1 flex min-w-0 flex-wrap items-center text-sm text-muted-foreground", className)}>
      {items.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center">
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-60" />}
          <button className="min-h-9 truncate rounded-md px-1.5 transition-colors hover:text-foreground" onClick={c.onClick}>{c.label}</button>
        </span>
      ))}
    </nav>
  );
}

/** Title, one line of context and the page's actions. Actions drop below the title when the row is too narrow. */
export function PageHeader({ title, description, actions, crumbs, titleAside, className }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  crumbs?: Crumb[];
  titleAside?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 sm:mb-8", className)}>
      {crumbs && crumbs.length > 0 && <Breadcrumb items={crumbs} />}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex min-w-0 items-start gap-1">
            <h1 className={cn("min-w-0 text-2xl font-semibold tracking-tight break-words", PHONE_H1)}>{title}</h1>
            {titleAside}
          </div>
          {description && <div className="mt-1 text-sm text-pretty text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** A titled group: the heading sits above one bordered card. `bare` drops the card for content that brings its own. */
export function Section({ id, title, description, aside, tone, bare, divided, clip = true, className, bodyClassName, children }: {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  tone?: "danger";
  bare?: boolean;
  /** Hairlines between direct children (for children without their own borders). */
  divided?: boolean;
  /** Clip children to the rounded corners; off for content with overflowing tooltips. */
  clip?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={cn("scroll-mt-20", className)}>
      {(title || aside) && (
        <div className="mb-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-1 px-1">
          <div className="min-w-0">
            {title && <h2 className={cn("text-base font-semibold tracking-tight", tone === "danger" && "text-destructive")}>{title}</h2>}
            {description && <div className="mt-0.5 text-[13px] leading-relaxed text-pretty text-muted-foreground">{description}</div>}
          </div>
          {aside && <div className="min-w-0 text-xs text-muted-foreground">{aside}</div>}
        </div>
      )}
      {bare ? (
        children
      ) : (
        <div className={cn("rounded-xl border bg-card/40", clip && "overflow-hidden", divided && "divide-y", tone === "danger" && "border-destructive/30", bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/**
 * One block inside a section card, separated from its neighbours by a hairline.
 * A switch in `aside` stays beside the title; a wider control (stackAside) drops below it on phones.
 */
export function Block({ title, description, aside, stackAside, children, className }: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  stackAside?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 border-b px-4 py-4 last:border-b-0 sm:px-5", className)}>
      {(title || aside) && (
        <div className={cn("flex gap-x-4 gap-y-3", stackAside ? "flex-col sm:flex-row sm:items-center" : "items-center")}>
          <div className="min-w-0 flex-1">
            {title && <div className="text-sm font-semibold">{title}</div>}
            {description && <div className="mt-0.5 text-[13px] leading-relaxed text-pretty text-muted-foreground">{description}</div>}
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** A tappable row inside a section card: icon, title, description, trailing chevron. */
export function LinkRow({ icon: Icon, title, description, onClick }: { icon?: React.ComponentType<{ className?: string }>; title: React.ReactNode; description?: React.ReactNode; onClick(): void }) {
  return (
    <button onClick={onClick} className="flex min-h-14 w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/40 sm:px-5">
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="text-[13px] text-muted-foreground">{description}</div>}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Label above a control, hint or error below it. */
export function Field({ label, hint, error, children, className, htmlFor }: { label: React.ReactNode; hint?: React.ReactNode; error?: string; children: React.ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Nothing here yet: what it is, why it's empty, and the one action that fixes it. `inset` sits inside a section card. */
export function EmptyState({ title, children, action, inset, className }: { title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; inset?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-6 text-center", inset ? "py-10" : "rounded-xl border border-dashed py-12", className)}>
      {title && <p className="text-sm font-medium">{title}</p>}
      {children && <div className="max-w-sm text-[13px] leading-relaxed text-pretty text-muted-foreground">{children}</div>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * The unsaved-changes bar. It sticks above the phone tab bar (bottom-0 on desktop) and fades out when clean.
 * `overTabBar={false}` for bars inside a sheet or a pane that already ends above the tab bar.
 */
export function SaveBar({ visible, message, children, overTabBar = true, safeArea, className }: {
  visible: boolean;
  message: React.ReactNode;
  children: React.ReactNode;
  overTabBar?: boolean;
  /** Pad for the home indicator (full-height sheets). */
  safeArea?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "sticky z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-background/95 py-3 backdrop-blur transition-opacity",
        overTabBar ? "bottom-[var(--tabbar-h)] md:bottom-0" : "bottom-0",
        safeArea && "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-32 text-sm">{message}</div>
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}
