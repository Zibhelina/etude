// The app's screens (Library, Browse, Stats, Agents…) as tabs among the Notebook's pages, on desktops. A screen tab
// keeps the route it shows (a deck's page, a search in Browse); going somewhere from inside it changes its route, so
// the tab is a little browser of its own. The window's address is the route of the tab in front of the focused pane.
import { useSyncExternalStore } from "react";
import { windowStore } from "@/lib/window-store";

export const SCREEN_PREFIX = "screen:";
export const isScreenTab = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith(SCREEN_PREFIX);

/** Routes that live in a tab on a desktop: every screen but an embed. */
export const isScreenPath = (path: string) => path !== "/notes" && path !== "/embed";

const KEY = "etude.screens";
function saved(): Record<string, string> {
  try {
    const j = JSON.parse(windowStore.get(KEY) ?? "{}");
    if (j && typeof j === "object") return Object.fromEntries(Object.entries(j).filter((e): e is [string, string] => typeof e[1] === "string" && isScreenTab(e[0])));
  } catch {}
  return {};
}

let routes: Record<string, string> = typeof localStorage === "undefined" ? {} : saved();
// Made but not yet in a layout (the layout catches up a render later): `keep` leaves these alone.
const young = new Set<string>();
const subs = new Set<() => void>();
function set(next: Record<string, string>) {
  routes = next;
  windowStore.set(KEY, JSON.stringify(routes));
  for (const f of subs) f();
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useScreenRoutes = () => useSyncExternalStore(subscribe, () => routes);

export const screenTabs = {
  has: (id: string) => id in routes,
  route: (id: string): string | null => routes[id] ?? null,
  create(route: string) {
    const id = SCREEN_PREFIX + Math.random().toString(36).slice(2, 9);
    young.add(id);
    set({ ...routes, [id]: route });
    return id;
  },
  go(id: string, route: string) {
    if (routes[id] !== route) set({ ...routes, [id]: route });
  },
  /** Forgets the screens whose tabs closed. */
  keep(ids: Set<string>) {
    for (const y of young) if (ids.has(y)) young.delete(y);
    const gone = (k: string) => !ids.has(k) && !young.has(k);
    if (!Object.keys(routes).some(gone)) return;
    set(Object.fromEntries(Object.entries(routes).filter(([k]) => !gone(k))));
  },
};

/** Which screen a route is: the part that decides what's drawn (a deck's Library and Browse are different screens). */
export const screenOf = (route: string) => {
  const p = new URL(route, "http://x").pathname;
  return p.startsWith("/types") ? "/types" : p;
};

const NAMES: Record<string, string> = {
  "/": "Library",
  "/archive": "Archive",
  "/browse": "Browse",
  "/stats": "Stats",
  "/settings": "Settings",
  "/market": "Market",
  "/types": "Card types",
  "/agents": "Agents",
  "/more": "More",
  "/study": "Study",
  "/watch": "Watch",
  "/course": "Course",
};

/** What a screen tab says: the screen's name, or the deck it's on. */
export function screenTitle(route: string | null): string {
  if (!route) return "Library";
  const u = new URL(route, "http://x");
  const deck = u.searchParams.get("name") ?? u.searchParams.get("deck");
  const last = deck ? deck.split("::").pop()! : null;
  if (u.pathname === "/deck" || u.pathname === "/home") return last || "Deck";
  if ((u.pathname === "/study" || u.pathname === "/watch") && last) return last;
  if (u.pathname === "/stats" && last) return `Stats · ${last}`;
  return NAMES[screenOf(route)] ?? "Etude";
}

// How a screen opens from the sidebar: in the tab in front (a plain click), in a new tab beside it, or in a pane to
// the side. The Notebook registers what that means while it's mounted.
export type ScreenOpen = "here" | "new" | "side";
let opener: ((route: string, how: ScreenOpen) => void) | null = null;
export const registerScreenOpener = (fn: typeof opener) => void (opener = fn);
/** Returns false when no Notebook is there to do it (a phone): then the caller just goes to the route. */
export function openScreen(route: string, how: ScreenOpen): boolean {
  if (!opener) return false;
  opener(route, how);
  return true;
}
