// Which device Etude is on, decided once when the app starts and never by the window's width.
// A phone gets the phone shell (tab island, phone headers, list screens, bottom sheets); everything else,
// the desktop app and desktop browsers at any window width and the iPad, gets the desktop shell.
// Content inside a screen (cards, grids, wrapping rows) still adapts to the room it has, by width.
//
// For testing, `?device=phone` or `?device=desktop` in the URL picks one and remembers it on this
// browser (localStorage `etude.device`); `?device=auto` forgets it. CSS reads `html[data-device]`
// through the `phone:` and `desktop:` variants in index.css.
import { useEffect, useState } from "react";
import { desktopApp, isNativeApp } from "@/lib/platform";

export type Device = "phone" | "desktop";

const KEY = "etude.device";
/** Below this, the shorter side of the screen is a phone's (the smallest iPad mini is 744 wide). */
const PHONE_SCREEN = 600;

function stored(): Device | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "phone" || v === "desktop" ? v : null;
  } catch {
    return null;
  }
}

/** Reads `?device=` once: phone/desktop is remembered, auto clears it. The parameter stays out of later links. */
function fromUrl(): Device | null {
  if (typeof location === "undefined") return null;
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  const v = url.searchParams.get("device");
  if (v === null) return null;
  try {
    if (v === "phone" || v === "desktop") localStorage.setItem(KEY, v);
    else if (v === "auto") localStorage.removeItem(KEY);
  } catch {
    /* private mode: the choice lasts this page only */
  }
  url.searchParams.delete("device");
  try {
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* sandboxed frames */
  }
  return v === "phone" || v === "desktop" ? v : null;
}

/** What the hardware says: a phone-sized screen, in the phone app or a touch browser. */
export function detectDevice(): Device {
  if (typeof window === "undefined" || typeof screen === "undefined") return "desktop";
  // The desktop app is a desktop, whatever the screen (a small touch laptop included).
  if (desktopApp()) return "desktop";
  const short = Math.min(screen.width || 0, screen.height || 0);
  if (!short) return "desktop";
  const small = short < PHONE_SCREEN;
  if (isNativeApp()) return small ? "phone" : "desktop";
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse && small ? "phone" : "desktop";
}

function decide(): Device {
  const url = fromUrl();
  if (url) return url;
  return stored() ?? detectDevice();
}

/** The device for this session. */
export const device: Device = decide();
export const isPhone = () => device === "phone";

/** Puts the device on <html> so CSS can follow it. Called before the first render. */
export function applyDevice() {
  if (typeof document !== "undefined") document.documentElement.dataset.device = device;
}

/** The device for this session; constant, so it never swaps layouts while you use the app. */
export const useDevice = (): Device => device;

/** True on a phone, at any width; false on the desktop app, desktop browsers and the iPad, at any width. */
export const usePhone = (): boolean => device === "phone";

/**
 * Content that adapts to room, not to the device: true while the window is narrower than `px`
 * (a card's padding, a chart's density). The shell never uses this.
 */
export function useNarrow(px = 768) {
  const q = `(max-width: ${px - 1}px)`;
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [q]);
  return on;
}

/**
 * Dialogs are a bottom sheet on a phone and a centred box on a desktop, whatever the width. Their callers
 * style the centred box with `sm:` (from when the switch was a breakpoint): on a desktop those apply at
 * every width, on a phone they're dropped so the sheet stays a sheet in landscape too.
 */
export function dialogClasses(className?: string): string | undefined {
  if (!className) return className;
  const phone = isPhone();
  return className
    .split(/\s+/)
    .flatMap((t) => (t.startsWith("sm:") ? (phone ? [] : [t.slice(3)]) : [t]))
    .join(" ");
}
