// Inside the Android and iOS apps (Capacitor): the system back button, the status bar, the
// keyboard and deep links. In a plain browser none of this runs.
import { App } from "@capacitor/app";
import { Keyboard } from "@capacitor/keyboard";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { registerPlugin } from "@capacitor/core";
import { fieldInView } from "./field-in-view.ts";

const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
export const native = !!cap?.isNativePlatform?.();

// The store plugin for Etude Sync, handed to web/src/lib/storekit.ts: StoreKit 2 on iOS
// (ios/App/App/EtudeStorePlugin.swift), Play Billing on Android (EtudeStorePlugin.kt), same name and
// shape. Set when this module loads, before the web app starts.
if (native && ["ios", "android"].includes(cap?.getPlatform?.() ?? "")) (globalThis as { __etudeStoreKit?: unknown }).__etudeStoreKit = registerPlugin("EtudeStore");

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

  // Keep the focused field visible above the keyboard. While it's up, <html data-keyboard="open"> hides
  // the phone tab bar (index.css), which would otherwise ride up with the shrinking page onto the field.
  // The page only shrinks after the keyboard has opened, sometimes a beat after keyboardDidShow, so the
  // field is checked again on each resize while the keyboard is up, and as its results change the page.
  // A field the page places above the keyboard itself (data-above-keyboard: the study page's answer field)
  // is left where it is.
  const root = document.documentElement;
  let open = false;
  const reveal = () => {
    if (!open) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.closest("[data-above-keyboard]") && !fieldInView(el)) el.scrollIntoView({ block: "center", behavior: "auto" });
  };
  const soon = () => requestAnimationFrame(() => requestAnimationFrame(reveal));

  // On the iPhone the keyboard plugin shrinks the page only once the keyboard has finished coming up, and
  // a fifth of a second later still: half a second with a field along the bottom of the screen hidden under
  // the keyboard. Its height is known as it starts, though, so until the page shrinks, <html> carries
  // data-keyboard-lift and --keyboard-lift (the keyboard's height less what the page has shrunk by), and
  // the bars along the bottom ride up with the keyboard by that much (index.css). Android shrinks the page
  // as the keyboard comes up: nothing to make up for there.
  const ios = cap?.getPlatform?.() === "ios";
  let keyboard = 0;
  let full = window.innerHeight;
  let lifted = -1;
  const lift = () => {
    const by = open && ios ? Math.max(0, Math.round(keyboard - (full - window.innerHeight))) : 0;
    if (by === lifted) return;
    lifted = by;
    if (by > 0) {
      root.style.setProperty("--keyboard-lift", `${by}px`);
      root.dataset.keyboardLift = "";
    } else {
      // At once, with no animation back: the page has just shrunk by as much.
      root.style.removeProperty("--keyboard-lift");
      delete root.dataset.keyboardLift;
    }
    // KEYBOARD_LIFT_EVENT in web/src/lib/device.ts.
    window.dispatchEvent(new CustomEvent("etude:keyboard-lift", { detail: by }));
  };
  window.addEventListener("resize", () => {
    if (!open) full = window.innerHeight;
    lift();
  });

  Keyboard.addListener("keyboardWillShow", (info) => {
    open = true;
    root.dataset.keyboard = "open";
    keyboard = info?.keyboardHeight ?? 0;
    lift();
  }).catch(() => {});
  Keyboard.addListener("keyboardDidShow", () => {
    open = true;
    root.dataset.keyboard = "open";
    soon();
  }).catch(() => {});
  Keyboard.addListener("keyboardWillHide", () => {
    open = false;
    keyboard = 0;
    delete root.dataset.keyboard;
    lift();
  }).catch(() => {});
  (window.visualViewport ?? window).addEventListener("resize", soon);
  document.addEventListener("input", soon, true);
  // iOS only: the bar with Done above the keyboard. Android has no such call (it logs an error).
  if (cap?.getPlatform?.() === "ios") Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => {});

  SplashScreen.hide().catch(() => {});
}
