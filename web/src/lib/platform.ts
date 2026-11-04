// Where Etude is running, read from the Capacitor bridge when there is one (no Capacitor import).
// Store rules follow from it: the apps never sell anything inside. iOS shows purchased decks as a
// library only (no prices, no buy buttons, no links to buy); Android has no buy links either.
// The desktop app and the browser may link to purchase pages on etude.study.

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };

const cap = (): CapacitorGlobal | undefined => (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;

/** True inside the iOS or Android app. */
export function isNativeApp(): boolean {
  const c = cap();
  if (!c) return false;
  if (typeof c.isNativePlatform === "function") return !!c.isNativePlatform();
  const p = c.getPlatform?.();
  return p === "ios" || p === "android";
}

/** "ios", "android", or "web" (desktop app and browsers). */
export function nativePlatform(): "ios" | "android" | "web" {
  if (!isNativeApp()) return "web";
  const p = cap()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : "web";
}

export const isIOSApp = () => nativePlatform() === "ios";

/** Prices, buy buttons and links to checkout or billing pages. Off in the store apps. */
export const canShowPurchases = () => !isNativeApp();

// The Sync server's messages are written for the website ("needs an active subscription", "Buy this
// deck"). In the store apps they become plain account facts, with nothing about buying.
const STORE_SAFE: Record<string, string> = {
  sync_required: "Sync isn't active on this account. Your local data is untouched.",
  no_subscription: "Sync isn't active on this account.",
  already_subscribed: "Sync is already active on this account.",
  not_owned: "This deck isn't on your account.",
};

/** A server or sync error message as the app may show it: unchanged on desktop and the web, neutral in the store apps. */
export function storeSafeMessage(message: string, code?: string | null, native = isNativeApp()): string {
  if (!native) return message;
  if (code && STORE_SAFE[code]) return STORE_SAFE[code];
  if (!/subscri|\bbuy\b|purchas|checkout|billing|pric(e|ing)|US\$/i.test(message)) return message;
  if (/paused/i.test(message)) return "Sync is paused on this account. Your local data is untouched.";
  if (/sync/i.test(message)) return STORE_SAFE.sync_required;
  return "This isn't available on this account.";
}

/**
 * How the desktop app gets new versions: "self" downloads and installs on restart, "link" points to
 * the download, "system" comes with the system's updates (the AUR), "none" is a checkout (git).
 */
export type DesktopUpdateState = { mode: "self" | "link" | "system" | "none"; version: string; latest: string | null; ready: boolean; percent: number | null; checked: string | null; error?: string };
export type DesktopCommandState = { path: string | null; ours: boolean; canInstall: boolean; note: string; error?: string };

/** What the desktop app lets the page ask for (desktop/preload.cjs); undefined in browsers and the phone apps. */
export type DesktopBridge = {
  platform: string;
  pickFolder(): Promise<string | null>;
  showLogs(): Promise<void>;
  updates: { status(check?: boolean): Promise<DesktopUpdateState>; restart(): Promise<void>; onChange(callback: (s: DesktopUpdateState) => void): () => void };
  command: { status(): Promise<DesktopCommandState>; install(): Promise<DesktopCommandState> };
};
export const desktopApp = (): DesktopBridge | undefined => (globalThis as { etudeDesktop?: DesktopBridge }).etudeDesktop;
