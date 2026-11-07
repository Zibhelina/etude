// A tiny history-based router: the app has a handful of screens and no nested routing.
// The app can live under a path prefix (the web edition is served at etude.study/app/): screens
// are always named without it ("/study?deck=X"), and the prefix is added and removed here.
import { useSyncExternalStore } from "react";

/** The path prefix the app is served under, "" at the root. Set at build time (VITE_APP_BASE=/app). */
export const BASE = String(import.meta.env.VITE_APP_BASE ?? "").replace(/\/+$/, "");

/** The current screen's path, without the prefix. */
export function appPath(pathname = location.pathname): string {
  if (!BASE) return pathname;
  if (pathname === BASE) return "/";
  return pathname.startsWith(BASE + "/") ? pathname.slice(BASE.length) : pathname;
}

/** A screen's path ("/study?deck=X") as a URL path the browser can show. */
export const withBase = (to: string) => (BASE && to.startsWith("/") ? BASE + to : to);

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

/** Called after every navigation; the app swaps it to scroll only once the old screen has faded out. */
export const navScroll = { top: (_to: string) => window.scrollTo(0, 0) };

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === appPath() + location.search) return;
  if (opts.replace) history.replaceState(null, "", withBase(to));
  else history.pushState(null, "", withBase(to));
  notify();
  navScroll.top(to);
}

export function useLocation() {
  const href = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => appPath() + location.search,
  );
  const url = new URL(href, location.origin);
  return { path: url.pathname, params: url.searchParams };
}
