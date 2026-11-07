"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Tooltip as TooltipPrimitive } from "radix-ui"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

// Focus only opens a tooltip when the person moved there with Tab. Radix opens on any focus, so focus coming back
// on its own (Esc closing Ctrl+K or a menu, returning to the window, a click that leaves the button focused) used
// to pop tooltips up with nobody asking.
let lastTab = 0
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => { if (e.key === "Tab") lastTab = performance.now() }, true)
}
const tabbedHere = () => performance.now() - lastTab < 600

/**
 * `disabled`: the tooltip has nothing to say right now (a rail label while the sidebar is open). It stays mounted so
 * the trigger isn't remounted, but it can't open. Leaving the content out instead isn't enough: Radix still marks
 * the tooltip open on hover and never closes it (the content that would track the pointer out isn't there), so all
 * the rows you'd passed over popped up together the moment the content came back.
 */
function Tooltip({
  disabled,
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & { disabled?: boolean }) {
  const [inner, setInner] = React.useState(defaultOpen ?? false)
  const controlled = openProp !== undefined
  React.useEffect(() => {
    if (disabled) setInner(false)
  }, [disabled])
  const open = disabled ? false : controlled ? openProp : inner
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={open}
      onOpenChange={(o) => {
        if (o && disabled) return
        if (!controlled) setInner(o)
        onOpenChange?.(o)
      }}
      {...props}
    />
  )
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(e) => {
        onFocus?.(e)
        // preventDefault skips Radix's own open-on-focus.
        if (!tabbedHere()) e.preventDefault()
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
