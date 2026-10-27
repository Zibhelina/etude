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
