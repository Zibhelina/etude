// The pieces first-run setup is built from. Each question sits right on the page in one 520 px column (no card),
// the main button stays in one spot at the bottom, and a step morphs into the next: the old content fades out, the
// new one rises a line at a time and the column's height eases between the two.
import { Children, cloneElement, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Where a step puts its main button: the fixed strip at the bottom. */
export const FootSlot = createContext<HTMLElement | null>(null);
/** Call right before changing what the column shows, so the change morphs. `back` plays it in reverse. */
export const MorphCtx = createContext<(back?: boolean) => void>(() => {});
export const useMorph = () => useContext(MorphCtx);
/** A step that has its own pages (Etude Sync's email, code, plan) can take Back for itself; return true when it did. */
export const BackCtx = createContext<{ current: (() => boolean) | null }>({ current: null });

/** The main button and the quiet one under it. Without a quiet one the space stays, so the main button never moves. */
export function Foot({ children, ghost }: { children?: ReactNode; ghost?: ReactNode }) {
  const el = useContext(FootSlot);
  if (!el) return null;
  return createPortal(
    <>
      {children}
      {ghost ?? <div aria-hidden className="h-[42px]" />}
    </>,
    el,
  );
}

export function Primary({ children, onClick, disabled, busy, form }: { children: ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; form?: string }) {
  return (
    <button
      type={form ? "submit" : "button"}
      form={form}
      onClick={onClick}
      disabled={disabled || busy}
      data-ob-primary
      className="ob-pri flex h-[50px] w-full shrink-0 items-center justify-center gap-2.5 rounded-[13px] px-6 text-[15.5px] font-semibold"
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
      {!busy && <kbd className="ob-kbd hidden rounded-[5px] px-[7px] py-0.5 text-[12px] font-medium md:inline pointer-coarse:hidden">Enter</kbd>}
    </button>
  );
}

export function Ghost({ children, onClick, href }: { children: ReactNode; onClick?: () => void; href?: string }) {
  const cls = "mt-0.5 flex h-10 shrink-0 items-center justify-center rounded-full px-3.5 text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground";
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
      </a>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** Eyebrow, the serif question and its lead: three lines of the column, so each rises on its own. */
export function Title({ eyebrow, children, lead }: { eyebrow?: ReactNode; children: ReactNode; lead?: ReactNode }) {
  return (
    <>
      {eyebrow && <div className="text-[11.5px] font-bold tracking-[0.13em] text-muted-foreground uppercase">{eyebrow}</div>}
      <h1 className={cn("ob-serif text-[28px] leading-[1.18] font-normal tracking-[-0.005em] text-balance md:text-[34px]", eyebrow && "mt-2.5")}>{children}</h1>
      {lead && <p className="mt-2.5 text-[14px] leading-normal text-pretty text-muted-foreground md:text-[15px]">{lead}</p>}
    </>
  );
}

export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mt-3.5 rounded-xl bg-muted px-[13px] py-2.5 text-[12.5px] leading-[1.45] text-muted-foreground md:text-[12.8px] [&_b]:font-semibold [&_b]:text-foreground", className)}>{children}</div>;
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex gap-2 rounded-xl px-3 py-2.5 text-[13px] leading-[1.45] text-destructive shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--destructive)_45%,transparent)]">
      <CircleAlert className="mt-px size-4 shrink-0" />
      <p className="min-w-0 break-words">{children}</p>
    </div>
  );
}

export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="mt-3.5 flex flex-col gap-2.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5 text-[13.6px] leading-[1.45] text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
          <span className="grid size-[21px] shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground">{i + 1}</span>
          <div className="min-w-0">{it}</div>
        </li>
      ))}
    </ol>
  );
}

type OptionProps = {
  icon: React.ComponentType<{ className?: string }>;
  title: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  kind?: "radio" | "check";
  disabled?: boolean;
  children?: ReactNode;
  /** Set by Options: the number key that picks it. */
  k?: number;
};

/** One answer: a tile with a pressed edge. Radio and check tiles show their number key on a desktop. */
export function Option({ icon: Icon, title, hint, selected, onClick, kind, disabled, children, k }: OptionProps) {
  return (
    <div className={cn("ob-tile rounded-[14px]", selected && "is-on", disabled && "opacity-45")}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        role={kind === "check" ? "checkbox" : kind === "radio" ? "radio" : undefined}
        aria-checked={kind ? !!selected : undefined}
        data-ob-opt={kind ? "" : undefined}
        className="flex w-full items-center gap-[13px] rounded-[14px] px-3 py-[11px] text-left disabled:cursor-not-allowed md:px-[15px] md:py-[13px]"
      >
        <span className="ob-tile-ic grid size-9 shrink-0 place-items-center rounded-[10px]">
          <Icon className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{title}</span>
          {hint && <span className="mt-0.5 block text-[12.5px] leading-[1.4] text-pretty text-muted-foreground md:text-[13px]">{hint}</span>}
        </span>
        {kind && k !== undefined && (
          <span className="ob-tile-k hidden h-[22px] min-w-[22px] shrink-0 place-items-center rounded-md px-1 text-[11.5px] font-semibold md:grid pointer-coarse:hidden">
            {kind === "check" && selected ? <Check className="size-3" strokeWidth={3} /> : k}
          </span>
        )}
      </button>
      {children}
    </div>
  );
}

export function Options({ children, className, role }: { children: ReactNode; className?: string; role?: string }) {
  let k = 0;
  return (
    <div role={role} className={cn("mt-4 flex flex-col gap-2 md:mt-[22px] md:gap-2.5", className)}>
      {Children.map(children, (c) => (isValidElement(c) && (c.props as OptionProps).kind ? cloneElement(c as ReactElement<OptionProps>, { k: ++k }) : c))}
    </div>
  );
}

/** A text field in setup's style: taller, a 1.5 px border that turns green when focused. */
export const fieldClass = "h-[46px] rounded-xl border-[1.5px] bg-card px-3.5 text-[15px] shadow-none focus-visible:border-primary focus-visible:ring-0 md:text-[15px]";
