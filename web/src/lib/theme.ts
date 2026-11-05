// Applies themes to the app: a <style id="etude-theme"> with the theme's variables, the `dark` class
// for shadcn's dark: variants, the browser's color-scheme and theme-color, and a localStorage copy
// that index.html applies before the first paint.
import { useEffect, useState } from "react";
import { BUILTIN_THEMES, DEFAULT_THEME, resolveTheme, themeCss, type Scheme, type Theme } from "../../../src/core/themes.ts";
import { api } from "@/lib/api";
import { appPath } from "@/lib/router";

export { BUILTIN_THEMES, DEFAULT_THEME, resolveTheme, themeCss };
export type { Scheme, Theme };

export const THEME_EVENT = "etude:theme";
const CACHE_KEY = "etude.theme";

let current: Theme = BUILTIN_THEMES[0];
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const prefersDark = () => !!darkQuery?.matches;
/** While the theme editor is open, background syncs leave its live draft alone. */
let previewing = false;

export const currentTheme = () => current;
export const isEmbed = () => appPath() === "/embed";

/** Any CSS color as #rrggbb (or #rrggbbaa when translucent), through a 1px canvas. */
export function toHex(color: string): string | null {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#010203";
  const before = ctx.fillStyle;
  ctx.fillStyle = color;
  // An unparsable value leaves fillStyle as it was.
  if (ctx.fillStyle === before && color.trim().toLowerCase() !== "#010203") return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a < 255 ? h(a) : ""}`;
}

function setMeta(name: string, content: string) {
  // index.html ships one theme-color per device scheme; once a theme is known, one plain tag is enough.
  const all = document.querySelectorAll<HTMLMetaElement>(`meta[name="${name}"]`);
  all.forEach((x, i) => (i ? x.remove() : x.removeAttribute("media")));
  let m = all[0] ?? null;
  if (!m) {
    m = document.createElement("meta");
    m.name = name;
    document.head.appendChild(m);
  }
  m.content = content;
}

/** Puts a theme on the page. `persist: false` is for live previews that may be thrown away. A theme that
 * follows the device (System) paints its light or dark half and repaints when the device switches. */
export function applyTheme(t: Theme, opts: { persist?: boolean } = {}) {
  if (isEmbed()) return;
  let style = document.getElementById("etude-theme") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "etude-theme";
    document.head.appendChild(style);
  }
  const shown = resolveTheme(t, prefersDark());
  const css = themeCss(shown);
  if (style.textContent !== css) style.textContent = css;
  const root = document.documentElement;
  root.classList.toggle("dark", shown.scheme === "dark");
  root.dataset.theme = shown.id;
  const bgOf = (x: Theme) => (toHex(x.vars["--background"] ?? "") ?? (x.scheme === "light" ? "#fafafa" : "#0f0f0f")).slice(0, 7);
  setMeta("color-scheme", shown.scheme);
  setMeta("theme-color", bgOf(shown));
  current = t;
  if (opts.persist !== false) {
    try {
      // theme-boot.js paints this before the first frame; a System theme keeps both halves so it can pick.
      const half = (x: Theme) => ({ id: x.id, scheme: x.scheme, css: themeCss(x), bg: bgOf(x) });
      const cache = t.pair
        ? { ...half(shown), pair: { light: half(resolveTheme(t, false)), dark: half(resolveTheme(t, true)) } }
        : half(t);
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Private mode or full storage: the theme still applies, it just won't skip the flash next time.
    }
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: shown }));
}

// The device switched between light and dark: a System theme follows it.
darkQuery?.addEventListener("change", () => {
  if (current.pair && !previewing) applyTheme(current, { persist: false });
});

export function setPreviewing(on: boolean) {
  previewing = on;
}

/** The selected theme as the server has it, falling back to Midnight. */
export async function loadTheme(): Promise<Theme> {
  const s = await api.settings();
  const list: Theme[] = [...BUILTIN_THEMES, ...((s.themes as Theme[]) ?? [])];
  return list.find((t) => t.id === s.theme) ?? BUILTIN_THEMES[0];
}

/** Re-reads the selected theme and applies it if it changed (after the assistant ran `theme set`). */
export async function refreshTheme() {
  if (isEmbed() || previewing) return;
  try {
    const t = await loadTheme();
    if (themeCss(t) !== themeCss(current)) applyTheme(t);
  } catch {}
}

/** Applies the saved theme now and again whenever the tab comes back (another device or the CLI may have changed it). */
export function startThemeSync() {
  if (isEmbed()) return;
  // The page may be showing a cached theme that `current` doesn't know about, so the first sync always applies.
  let first = true;
  const sync = async () => {
    try {
      const t = await loadTheme();
      if (!previewing && (first || themeCss(t) !== themeCss(current))) applyTheme(t);
      first = false;
    } catch {
      // Offline or a token problem: keep whatever is showing.
    }
  };
  sync();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
}

/** The page's color scheme: the theme's, or the host's inside an embed. */
export function pageScheme(): Scheme {
  const cs = getComputedStyle(document.documentElement).colorScheme;
  if (/light/.test(cs) && !/dark/.test(cs)) return "light";
  if (/dark/.test(cs)) return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Re-renders with the current scheme whenever the theme changes. */
export function useScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(() => pageScheme());
  useEffect(() => {
    const h = () => setScheme(pageScheme());
    window.addEventListener(THEME_EVENT, h);
    return () => window.removeEventListener(THEME_EVENT, h);
  }, []);
  return scheme;
}
