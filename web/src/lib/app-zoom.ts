// Global app zoom (Settings → Appearance): scales the whole app on this device.
// In the Electron desktop app this drives Chromium's native WebContents zoom factor (crisp text,
// popovers and web tabs scale together, kept in sync with View → Zoom the Whole App shortcuts).
// In a browser (or an older desktop build without the bridge) it falls back to CSS zoom on <html>.
import { useEffect, useState } from "react";
import { desktopApp } from "@/lib/platform";
import { isEmbed } from "@/lib/theme";
import { APP_ZOOM_MAX, APP_ZOOM_MIN, APP_ZOOM_PRESETS, APP_ZOOM_STEPS, clampAppZoom, stepAppZoom } from "@/lib/app-zoom-math";

export { APP_ZOOM_MAX, APP_ZOOM_MIN, APP_ZOOM_PRESETS, APP_ZOOM_STEPS, clampAppZoom, stepAppZoom };

const KEY = "etude.zoom";
const EVENT = "etude:zoom";

function readStored(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KEY);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampAppZoom(n) : null;
  } catch {
    return null;
  }
}

let current: number = readStored() ?? 1;

export const appZoom = () => current;

function applyToPage(z: number, notifyDesktop: boolean) {
  if (typeof document === "undefined" || isEmbed()) return;
  const bridge = desktopApp()?.zoom;
  if (bridge) {
    document.documentElement.style.zoom = "";
    if (notifyDesktop) void bridge.set(z).catch(() => {});
  } else {
    document.documentElement.style.zoom = z === 1 ? "" : String(z);
  }
}

export function setAppZoom(value: number, opts: { notifyDesktop?: boolean; persist?: boolean } = {}): number {
  const z = clampAppZoom(value);
  current = z;
  if (opts.persist !== false) {
    try {
      if (typeof localStorage !== "undefined") {
        if (z === 1) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, String(z));
      }
    } catch {}
  }
  applyToPage(z, opts.notifyDesktop !== false);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: z }));
  }
  return z;
}

let started = false;

/** Applies the saved device zoom at boot and stays synced with desktop zoom shortcuts and other windows. */
export function startAppZoom() {
  if (started || typeof window === "undefined" || isEmbed()) return;
  started = true;
  const stored = readStored();
  const bridge = desktopApp()?.zoom;
  if (bridge) {
    document.documentElement.style.zoom = "";
    if (stored !== null) {
      current = stored;
      void bridge.set(stored).catch(() => {});
    } else {
      void bridge.get().then((z) => {
        const clamped = clampAppZoom(z);
        if (clamped !== current) setAppZoom(clamped, { notifyDesktop: false });
      }).catch(() => {});
    }
    bridge.onChange((z) => {
      const clamped = clampAppZoom(z);
      if (clamped !== current) setAppZoom(clamped, { notifyDesktop: false });
    });
  } else if (stored !== null && stored !== 1) {
    current = stored;
    document.documentElement.style.zoom = String(stored);
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    const next = readStored() ?? 1;
    if (next !== current) setAppZoom(next, { persist: false, notifyDesktop: false });
  });
}

export function useAppZoom(): [number, (z: number) => void] {
  const [z, setZ] = useState(current);
  useEffect(() => {
    const h = () => setZ(current);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return [z, (next: number) => void setAppZoom(next)];
}
