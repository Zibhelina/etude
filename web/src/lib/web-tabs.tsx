// Web pages in Notebook tabs, in the desktop app only (desktop/web.ts, like Obsidian's web viewer). A web tab's id is
// "www:" + a key; its address, title and icon live here, so the tab keeps its id while the page moves around.
// The pages themselves are <webview>s in one layer over the Notebook, each placed over its tab's box: a webview
// that's moved in the page reloads, so they never move, and a page left in a background tab keeps where it was.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Globe, Loader2, RotateCw, X } from "lucide-react";
import { desktopApp } from "@/lib/platform";
import { THEME_EVENT, currentTheme } from "@/lib/theme";
import { SEARCH_ENGINES, addressOf, type SearchEngine } from "@/lib/web-address";
export { SEARCH_ENGINES, type SearchEngine };
import { cn } from "@/lib/utils";
import { windowStore } from "@/lib/window-store";

export const WEB_PREFIX = "www:";
/** Where a new web tab starts. */
export const WEB_HOME = "https://www.google.com/";
export const isWebTab = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith(WEB_PREFIX);

/** What the desktop app's bridge offers for web tabs (desktop/preload.cjs); absent in browsers and the phone apps. */
export type WebBridge = {
  partition: string;
  takeLinks(on: boolean): Promise<void>;
  /** Whether pages show their light or dark look ("system": what the computer says). */
  scheme(s: "light" | "dark" | "system"): Promise<void>;
  onOpen(cb: (d: { url: string; guest: number | null; background?: boolean }) => void): () => void;
  onKey(cb: (d: { key: string; code: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; guest: number }) => void): () => void;
  outside(url: string): Promise<void>;
};
export const webBridge = (): WebBridge | undefined => (desktopApp() as { web?: WebBridge } | undefined)?.web;
/** Web tabs exist only where there's a real browser to put in them: the desktop app. */
export const canWebTabs = () => !!webBridge();

// ---------------------------------------------------------------- settings (this computer's)

const LINKS_KEY = "etude.web.links";
const SEARCH_KEY = "etude.web.search";
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const settingSubs = new Set<() => void>();
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
  settingSubs.forEach((f) => f());
};
/** Links clicked in Etude open in a web tab beside where you clicked (else in the system's browser). On by default. */
export const linksInTabs = () => read(LINKS_KEY) !== "off";
export const setLinksInTabs = (on: boolean) => write(LINKS_KEY, on ? "on" : "off");
export const searchEngine = (): SearchEngine => {
  const v = read(SEARCH_KEY);
  return v && v in SEARCH_ENGINES ? (v as SearchEngine) : "duckduckgo";
};
export const setSearchEngine = (e: SearchEngine) => write(SEARCH_KEY, e);
export function useWebSettings() {
  return useSyncExternalStore(
    (f) => (settingSubs.add(f), () => void settingSubs.delete(f)),
    () => `${linksInTabs()}|${searchEngine()}`,
  );
}

/** What was typed in the address bar as an address: itself when it is one, else a search with the chosen engine. */
export const toAddress = (input: string) => addressOf(input, SEARCH_ENGINES[searchEngine()].url);

// ---------------------------------------------------------------- the tabs

export type WebMeta = { url: string; title: string; icon: string | null; loading?: boolean; back?: boolean; forward?: boolean };
/** Tabs opened from a New tab or Ctrl+K in this session: they start in the address bar, like a browser's new tab. */
const fresh = new Set<string>();
const TABS_KEY = "etude.web.tabs";
let tabs: Record<string, WebMeta> = (() => {
  try {
    const j = JSON.parse(windowStore.get(TABS_KEY) ?? "{}");
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
})();
const subs = new Set<() => void>();
let saving: ReturnType<typeof setTimeout> | null = null;
function changed() {
  subs.forEach((f) => f());
  if (saving) clearTimeout(saving);
  saving = setTimeout(() => {
    const keep = Object.fromEntries(Object.entries(tabs).map(([k, m]) => [k, { url: m.url, title: m.title, icon: m.icon }]));
    try {
      windowStore.set(TABS_KEY, JSON.stringify(keep));
    } catch {}
  }, 300);
}
export const webTabs = {
  get: (id: string): WebMeta | undefined => tabs[id],
  has: (id: string) => id in tabs,
  /** A new web tab's id (an empty address is a blank tab waiting for one). */
  create(url: string, opts: { typing?: boolean } = {}): string {
    const id = WEB_PREFIX + Math.random().toString(36).slice(2, 10);
    if (opts.typing ?? url === WEB_HOME) fresh.add(id);
    tabs = { ...tabs, [id]: { url, title: "", icon: null } };
    changed();
    return id;
  },
  set(id: string, patch: Partial<WebMeta>) {
    const m = tabs[id];
    if (!m || Object.entries(patch).every(([k, v]) => m[k as keyof WebMeta] === v)) return;
    tabs = { ...tabs, [id]: { ...m, ...patch } };
    changed();
  },
  /** Forgets the tabs that aren't open anymore. */
  keep(open: Set<string>) {
    const gone = Object.keys(tabs).filter((k) => !open.has(k));
    if (!gone.length) return;
    tabs = Object.fromEntries(Object.entries(tabs).filter(([k]) => open.has(k)));
    changed();
  },
  /** The open tab showing this address, if any. */
  find: (url: string, among: string[]) => among.find((id) => isWebTab(id) && sameAddress(tabs[id]?.url, url)),
};
const sameAddress = (a: string | undefined, b: string) => !!a && a.replace(/\/$/, "") === b.replace(/\/$/, "");
export const useWebTabs = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => tabs);
export const useWebTab = (id: string) => useWebTabs()[id];

/** A web tab's name in its tab: the page's title, else its site. */
export function webTitle(m: WebMeta | undefined): string {
  if (!m?.url) return "New web tab";
  if (m.title.trim()) return m.title.trim();
  try {
    return new URL(m.url).hostname.replace(/^www\./, "");
  } catch {
    return m.url;
  }
}

export function WebTabIcon({ meta, size = 15 }: { meta: WebMeta | undefined; size?: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (meta?.loading) return <Loader2 className="size-3.5 animate-spin" />;
  if (meta?.icon && broken !== meta.icon) return <img src={meta.icon} width={size} height={size} alt="" className="web-tab-favicon" onError={() => setBroken(meta.icon)} />;
  return <Globe className="size-3.5" />;
}

/** Pages follow Etude's theme: dark when it's dark, light when it's light, the computer's when it follows the computer. */
export function useWebScheme() {
  useEffect(() => {
    const bridge = webBridge();
    if (!bridge) return;
    const send = () => void bridge.scheme(currentTheme()?.pair ? "system" : document.documentElement.classList.contains("dark") ? "dark" : "light");
    send();
    window.addEventListener(THEME_EVENT, send);
    return () => window.removeEventListener(THEME_EVENT, send);
  }, []);
}

// ---------------------------------------------------------------- the pages (webviews)

type Webview = HTMLElement & {
  src: string;
  setZoomFactor(factor: number): void;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  isLoading(): boolean;
  focus(): void;
};
const views = new Map<string, Webview>();
const ready = new Set<string>();
/** Each web tab's zoom, from its pane; put back on every page it loads. */
const zooms = new Map<string, number>();
/** Each open web tab's box in its pane, and what tells the pane it was clicked. */
const slots = new Map<string, { el: HTMLElement; focus(): void }>();
const bars = new Map<string, () => void>();

export const webTabOfGuest = (guest: number) => [...views].find(([id, v]) => ready.has(id) && v.getWebContentsId() === guest)?.[0];
export const focusAddress = (id: string) => bars.get(id)?.();
export const webviewOf = (id: string) => views.get(id);

export function webGo(id: string, input: string) {
  const url = toAddress(input);
  if (!url) return false;
  webTabs.set(id, { url, title: webTabs.get(id)?.url ? (webTabs.get(id)?.title ?? "") : "" });
  const v = views.get(id);
  if (v && ready.has(id)) void v.loadURL(url).catch(() => {});
  else if (v) v.src = url;
  return true;
}

/**
 * The layer the pages live in, over the Notebook. `open` is every web tab in its panes; a page whose tab isn't in
 * front (or whose Notebook isn't on screen) stays loaded and hidden.
 */
export function WebLayer({ open }: { open: string[] }) {
  useWebScheme();
  const layer = useRef<HTMLDivElement>(null);
  // The pages go in once the layer is in the page (a ref isn't set yet when its children's effects run).
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const all = useWebTabs();
  const ids = open.filter((id) => all[id]?.url);
  // Presses outside the pages (a tab dragged over one, a split's edge pulled across one) shouldn't be caught by a page.
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const on = () => el.classList.add("is-passing");
    const off = () => el.classList.remove("is-passing");
    const evs: [string, () => void][] = [["pointerdown", on], ["dragstart", on], ["pointerup", off], ["pointercancel", off], ["dragend", off], ["drop", off]];
    for (const [e, f] of evs) document.addEventListener(e, f, true);
    return () => evs.forEach(([e, f]) => document.removeEventListener(e, f, true));
  }, []);
  // Every frame, each page sits over its tab's box (clipped to its pane), or hides.
  useEffect(() => {
    let raf = 0;
    const place = () => {
      for (const [id, v] of views) {
        const s = slots.get(id);
        const r = s?.el.isConnected ? s.el.getBoundingClientRect() : null;
        const pane = s?.el.closest("[data-pane]")?.getBoundingClientRect();
        const x = r ? Math.max(r.left, pane?.left ?? r.left) : 0;
        const y = r ? Math.max(r.top, pane?.top ?? r.top, 0) : 0;
        const w = r ? Math.min(r.right, pane?.right ?? r.right) - x : 0;
        const h = r ? Math.min(r.bottom, pane?.bottom ?? r.bottom, innerHeight) - y : 0;
        const shown = w > 1 && h > 1;
        const want = shown ? `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}` : "hidden";
        if (v.dataset.box === want) continue;
        v.dataset.box = want;
        if (shown) Object.assign(v.style, { visibility: "visible", left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, width: `${Math.round(w)}px`, height: `${Math.round(h)}px` });
        else Object.assign(v.style, { visibility: "hidden", width: "0px", height: "0px" });
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={(el) => ((layer.current = el), setHost(el))} className="web-layer">
      {host && ids.map((id) => <WebFrame key={id} id={id} host={host} />)}
    </div>
  );
}

function WebFrame({ id, host }: { id: string; host: HTMLDivElement }) {
  useLayoutEffect(() => {
    const bridge = webBridge();
    const first = webTabs.get(id)?.url;
    if (!bridge || !host || !first) return;
    const v = document.createElement("webview") as Webview;
    v.setAttribute("partition", bridge.partition);
    v.setAttribute("allowpopups", "");
    v.className = "web-page";
    v.dataset.webTab = id;
    v.style.visibility = "hidden";
    v.src = first;
    const sync = () => {
      if (!ready.has(id)) return;
      webTabs.set(id, { url: v.getURL() || webTabs.get(id)?.url || "", back: v.canGoBack(), forward: v.canGoForward() });
    };
    const on: [string, (e: Event & Record<string, unknown>) => void][] = [
      ["dom-ready", () => (ready.add(id), v.setZoomFactor(zooms.get(id) ?? 1), sync())],
      ["did-start-loading", () => webTabs.set(id, { loading: true })],
      ["did-stop-loading", () => (webTabs.set(id, { loading: false }), sync())],
      ["did-navigate", (e) => (webTabs.set(id, { url: String(e.url), icon: null }), sync())],
      ["did-navigate-in-page", (e) => e.isMainFrame !== false && (webTabs.set(id, { url: String(e.url) }), sync())],
      ["page-title-updated", (e) => webTabs.set(id, { title: String(e.title ?? "") })],
      ["page-favicon-updated", (e) => webTabs.set(id, { icon: (e.favicons as string[] | undefined)?.find((f) => /^https?:|^data:image\//.test(f)) ?? null })],
      ["did-fail-load", (e) => e.isMainFrame && Number(e.errorCode) !== -3 && webTabs.set(id, { loading: false })],
      ["focus", () => slots.get(id)?.focus()],
    ];
    for (const [ev, f] of on) v.addEventListener(ev, f as EventListener);
    host.appendChild(v);
    views.set(id, v);
    return () => {
      for (const [ev, f] of on) v.removeEventListener(ev, f as EventListener);
      views.delete(id);
      ready.delete(id);
      v.remove();
    };
  }, [id, host]);
  return null;
}

/** A web tab in its pane: the bar (back, forward, reload, the address, open in the browser) and the box the page sits over. */
export function WebPage({ id, top, zoom = 1, onFocus }: { id: string; top: React.ReactNode; zoom?: number; onFocus(): void }) {
  const meta = useWebTab(id);
  // The pane's zoom is the page's own (Chromium's), so the page lays itself out at that size.
  useEffect(() => {
    zooms.set(id, zoom);
    if (ready.has(id)) views.get(id)?.setZoomFactor(zoom);
  }, [id, zoom]);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const focusPane = useRef(onFocus);
  focusPane.current = onFocus;
  useLayoutEffect(() => {
    slots.set(id, { el: box.current!, focus: () => focusPane.current() });
    bars.set(id, () => {
      input.current?.focus();
      input.current?.select();
    });
    return () => {
      if (slots.get(id)?.el === box.current) slots.delete(id);
      bars.delete(id);
    };
  }, [id]);
  // A new tab (or a blank one) starts in its address bar.
  useEffect(() => {
    if (!webTabs.get(id)?.url || fresh.delete(id)) requestAnimationFrame(() => input.current?.focus());
  }, [id]);
  const v = () => (ready.has(id) ? views.get(id) : undefined);
  const go = () => {
    if (typed == null) return;
    if (webGo(id, typed)) {
      setTyped(null);
      input.current?.blur();
      requestAnimationFrame(() => views.get(id)?.focus());
    }
  };
  const shownUrl = typed ?? meta?.url ?? "";
  return (
    <div className="note-canvas-page note-web-page">
      {top}
      <div className="note-web-bar">
        <button type="button" className="note-web-btn" aria-label="Back" title="Back" disabled={!meta?.back} onClick={() => v()?.goBack()}>
          <ArrowLeft className="size-4" />
        </button>
        <button type="button" className="note-web-btn" aria-label="Forward" title="Forward" disabled={!meta?.forward} onClick={() => v()?.goForward()}>
          <ArrowRight className="size-4" />
        </button>
        <button type="button" className="note-web-btn" aria-label={meta?.loading ? "Stop" : "Reload"} title={meta?.loading ? "Stop" : "Reload"} disabled={!meta?.url} onClick={() => (meta?.loading ? v()?.stop() : v()?.reload())}>
          {meta?.loading ? <X className="size-4" /> : <RotateCw className="size-3.5" />}
        </button>
        <input
          ref={input}
          className="note-web-address"
          value={shownUrl}
          spellCheck={false}
          placeholder="Search or type a web address"
          aria-label="Address"
          onChange={(e) => setTyped(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.preventDefault(), go());
            else if (e.key === "Escape") (setTyped(null), e.currentTarget.blur());
          }}
        />
        <button type="button" className="note-web-btn" aria-label="Open in your browser" title="Open in your browser" disabled={!meta?.url} onClick={() => meta?.url && void webBridge()?.outside(meta.url)}>
          <ArrowUpRight className="size-4" />
        </button>
      </div>
      <div ref={box} className={cn("note-web-box", !meta?.url && "is-blank")} onPointerDown={() => onFocus()}>
        {!meta?.url && <p className="note-web-hint">Type an address, or words to search with {SEARCH_ENGINES[searchEngine()].name}.</p>}
      </div>
    </div>
  );
}
