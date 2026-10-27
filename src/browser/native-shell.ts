// Inside the Android and iOS apps (Capacitor): the system back button, the status bar, the
// keyboard and deep links. In a plain browser none of this runs.
import { App } from "@capacitor/app";
import { Keyboard } from "@capacitor/keyboard";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
export const native = !!cap?.isNativePlatform?.();

/** etude://study?deck=X and https://etude.study/app/study?deck=X both open /study?deck=X. */
export function routeOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let path: string;
  if (u.protocol === "etude:") path = "/" + [u.host, u.pathname.replace(/^\/+/, "")].filter(Boolean).join("/");
  else if (u.protocol === "https:" && u.host === "etude.study" && (u.pathname === "/app" || u.pathname.startsWith("/app/"))) path = u.pathname.slice(4) || "/";
  else return null;
  // Only the app's own screens; anything else lands on Decks.
  const known = /^\/(|decks?|study|watch|browse|stats|types|market|settings|more)(\/.*)?$/;
  return (known.test(path) ? path : "/") + u.search;
}

function go(path: string) {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** The theme the page picked (its --background), for the status bar icons. */
function syncStatusBar() {
  const dark = document.documentElement.classList.contains("dark");
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
}

export async function startNativeShell() {
  if (!native) return;
  document.documentElement.dataset.native = cap?.getPlatform?.() ?? "app";
  StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
  syncStatusBar();
  new MutationObserver(syncStatusBar).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  // Android back: close an open dialog or sheet first (they listen for Escape), then go back in
  // the app's history, and leave the app from the first screen.
  App.addListener("backButton", ({ canGoBack }) => {
    // Dialogs, popovers and menus (Radix), the phone action sheets, the Market lightbox and the Ask
    // Etude sheet all close on Escape; the event goes from the focused element up to window.
    const layer = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-agent-panel]');
    if (layer) {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return;
    }
    if (canGoBack && history.length > 1 && location.pathname !== "/") history.back();
    else if (location.pathname !== "/") go("/");
    else App.exitApp();
  });

  App.addListener("appUrlOpen", ({ url }) => {
    const path = routeOf(url);
    if (path) go(path);
  });
  const launch = await App.getLaunchUrl().catch(() => undefined);
  if (launch?.url) {
    const path = routeOf(launch.url);
    if (path) go(path);
  }

  // Keep the focused field visible above the keyboard.
  Keyboard.addListener("keyboardDidShow", () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }).catch(() => {});
  Keyboard.setAccessoryBarVisible?.({ isVisible: true }).catch(() => {});

  SplashScreen.hide().catch(() => {});
}
